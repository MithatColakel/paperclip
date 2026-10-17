import { and, eq, isNull } from "drizzle-orm";
import { type Db, aiAccountAgentBindings, aiAccounts, environmentAvailability, resourceWaitEpisodes } from "@paperclipai/db";
import { readResourceWaitContext, type EnvironmentTargetWaitReason } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import {
  environmentAvailabilityService,
  isFreshlyUnavailable,
  normalizeAvailabilityReason,
  type MarkUnavailableInput,
} from "../environment-availability.js";
import { deviceForEnvironment } from "../execution-devices.js";
import { classifyEnvironmentError } from "./classify.js";
import { readWakeEpochs } from "./epochs.js";
import { resolveEpisode } from "./episodes.js";
import { formatWaitDuration, type ResourceWaitNotifier } from "./notify.js";
import {
  ConfigurationRefusal,
  environmentWaitDeferral,
  type HeartbeatRunRow,
  type ResourceWaitDeferral,
  type ResourceWaitDeps,
  type ResourceWaitEpisodeRow,
  type WakeEpochSnapshot,
} from "./types.js";
import { wakeResourceWaits } from "./wake.js";

/**
 * Fork: the run-path entry points of environment waits (spec 7.2).
 *
 * - `preflightEnvironment` (hook H2): a retired environment refuses the run; a
 *   registry row that is `unavailable` and was checked within 10 minutes makes
 *   it wait. Ownership is never checked here: the driver's lease admission
 *   decides whether a device serves the company.
 * - `toDeferral` (hook H4): classifies a lease error; a target-scope wait
 *   also records the outage in the registry, an admission-scope wait never
 *   does.
 * - `noteAcquired`: a lease succeeded; an `unavailable → available` transition
 *   wakes the target-scope waits on that environment only, so one company's
 *   run never wakes another company's admission waits.
 * - `noteRunPassed`: the step that ended a run's wait succeeded (credentials
 *   for account and slot waits, the lease for every wait), so the episode is
 *   resolved and "Resumed" logged only now. A run released to test an
 *   estimated or repeated limit (the probe) ends its limit wait only when it
 *   succeeds (`succeeded`, from the account's success hook), so a failed
 *   probe keeps the episode, its start and its notice (spec 4.6 step 5).
 */

export interface RunEnvironmentRef {
  id: string;
  name: string;
  driver: string;
  config: Record<string, unknown> | null | undefined;
}

export type PreflightResult =
  | { action: "continue"; epochs: WakeEpochSnapshot | null }
  | { action: "wait"; deferral: ResourceWaitDeferral }
  | { action: "refuse"; refusal: ConfigurationRefusal };

export interface PreflightRuntime {
  db: Db;
  deps: Pick<ResourceWaitDeps, "appendRunEvent">;
  notifier: ResourceWaitNotifier;
  clock: () => Date;
  random: () => number;
  environmentWaitsEnabled: boolean;
  onEpisodeEnded: (episode: ResourceWaitEpisodeRow) => Promise<void>;
}

/** Only a driver plugin's own (sanitized) text may reach a banner; Local and SSH rows never carry one. */
function driverMessageOf(environment: RunEnvironmentRef, message: string | null | undefined): string | null {
  return environment.driver !== "ssh" && environment.driver !== "local" && message ? message : null;
}

export function createPreflight(runtime: PreflightRuntime) {
  const { db, notifier } = runtime;
  const availability = environmentAvailabilityService(db);

  /**
   * A waiting run turned out to need configuration instead (a retired or
   * refusing environment, a routing override, a persisted run whose account
   * is gone): its episode ends as `refused`.
   */
  async function noteRunRefused(run: Pick<HeartbeatRunRow, "id" | "companyId">): Promise<{ episodeId: string | null }> {
    const [episode] = await db
      .select()
      .from(resourceWaitEpisodes)
      .where(and(
        eq(resourceWaitEpisodes.currentRunId, run.id),
        eq(resourceWaitEpisodes.companyId, run.companyId),
        isNull(resourceWaitEpisodes.resolvedAt),
      ));
    if (!episode) return { episodeId: null };
    const ended = await resolveEpisode(db, episode.id, "refused", runtime.clock(), { currentRunId: run.id });
    if (ended) await runtime.onEpisodeEnded(ended).catch(() => undefined);
    return { episodeId: episode.id };
  }

  async function deviceRef(environment: RunEnvironmentRef) {
    const device = await deviceForEnvironment(db, environment, { create: false }).catch(() => null);
    return device ? { id: device.id, name: device.name } : null;
  }

  /**
   * Records a target outage from this run's own lease error. Returns the new
   * wake epoch when nothing else moved it since the attempt read `epochs`, so
   * the deferral's lost-wake guard does not count this write; null when
   * another write raced the attempt (the guard then still sees it).
   */
  async function recordOwnOutage(
    environmentId: string,
    input: MarkUnavailableInput,
    epochs: WakeEpochSnapshot | null,
  ): Promise<number | null> {
    return db.transaction(async (tx) => {
      // Lock the row, so no report, check or wake lands between this read and the write.
      const [current] = await tx
        .select({ wakeEpoch: environmentAvailability.wakeEpoch })
        .from(environmentAvailability)
        .where(eq(environmentAvailability.environmentId, environmentId))
        .for("update");
      const result = await environmentAvailabilityService(tx).markUnavailable(environmentId, input);
      if (!result || !epochs || epochs.environmentId !== environmentId) return null;
      if ((current ? Number(current.wakeEpoch) : 0) !== epochs.environmentEpoch) return null;
      // Without a row there was nothing to lock: only a write that created the row itself counts as its own.
      if (!current && result.previousState !== null) return null;
      return result.wakeEpoch;
    });
  }

  async function preflightEnvironment(input: {
    run: Pick<HeartbeatRunRow, "id" | "companyId" | "agentId">;
    agent?: { name: string | null } | null;
    environment: RunEnvironmentRef | null;
    /** Persisted native input, forced Kubernetes or managed-sandbox-only execution. */
    skip?: boolean;
    wasIssueAssignee?: boolean | null;
  }): Promise<PreflightResult> {
    const environment = input.environment;
    // The epochs are read before the registry, so a report that lands after
    // this read still wakes the successor (spec 7.3 step 5).
    const epochs = await readWakeEpochs(db, { environmentId: environment?.id ?? null, agentId: input.run.agentId });
    if (!environment || input.skip || !runtime.environmentWaitsEnabled) return { action: "continue", epochs };
    const now = runtime.clock();
    const row = await availability.get(environment.id);
    if (!row) return { action: "continue", epochs };
    if (row.state === "retired") {
      const device = await deviceRef(environment);
      const deviceName = device?.name ?? row.label ?? environment.name;
      const agentName = input.agent?.name?.trim() || "the agent";
      await noteRunRefused(input.run);
      return {
        action: "refuse",
        refusal: new ConfigurationRefusal({
          reason: "environment_refused",
          message: `${deviceName} was removed; move ${agentName} to another device.`,
          companyId: input.run.companyId,
          agentId: input.run.agentId,
          environmentId: environment.id,
          deviceId: device?.id ?? null,
          deviceName: device?.name ?? null,
          environmentName: environment.name,
        }),
      };
    }
    if (!isFreshlyUnavailable(row, now)) return { action: "continue", epochs };
    const device = await deviceRef(environment);
    return {
      action: "wait",
      deferral: environmentWaitDeferral({
        reason: normalizeAvailabilityReason(row.reason) as EnvironmentTargetWaitReason | "other",
        scope: "target",
        environment: { id: environment.id, name: environment.name },
        device,
        message: driverMessageOf(environment, row.message),
        resumeAt: row.retryAfter,
        epochs,
        wasIssueAssignee: input.wasIssueAssignee,
      }),
    };
  }

  /**
   * Hook H4: `throw (await toDeferral(error, ctx)) ?? error`, after mapping a
   * `ConfigurationRefusal` to heartbeat's `ConfigurationIncompleteFailure`.
   * Null when the error is neither a wait nor a refusal (or the kill switch is
   * set).
   */
  async function toDeferral(
    error: unknown,
    ctx: {
      run: Pick<HeartbeatRunRow, "id" | "companyId" | "agentId">;
      agent?: { name: string | null } | null;
      environment: RunEnvironmentRef | null;
      epochs?: WakeEpochSnapshot | null;
      wasIssueAssignee?: boolean | null;
    },
  ): Promise<ResourceWaitDeferral | ConfigurationRefusal | null> {
    const environment = ctx.environment;
    if (!environment) return null;
    const now = runtime.clock();
    const classification = classifyEnvironmentError(error, {
      now,
      enabled: runtime.environmentWaitsEnabled,
      random: runtime.random,
    });
    if (!classification) return null;
    const device = await deviceRef(environment);
    const deviceName = classification.targetLabel ?? device?.name ?? environment.name;
    if (classification.action === "refuse") {
      const agentName = ctx.agent?.name?.trim() || "the agent";
      await noteRunRefused(ctx.run);
      return new ConfigurationRefusal({
        reason: "environment_refused",
        message: classification.message ?? `${deviceName} refused this run. Move ${agentName} to another device, or ask its owner to check it.`,
        companyId: ctx.run.companyId,
        agentId: ctx.run.agentId,
        environmentId: environment.id,
        deviceId: device?.id ?? null,
        deviceName: classification.targetLabel ?? device?.name ?? null,
        environmentName: environment.name,
      });
    }
    const message = classification.source === "envelope" ? driverMessageOf(environment, classification.message) : null;
    let epochs = ctx.epochs ?? null;
    // Only a target-scope outage is recorded: an admission refusal (including
    // an admission `other`) concerns this run only.
    if (classification.scope === "target") {
      const ownEpoch = await recordOwnOutage(environment.id, {
        reason: classification.reason,
        source: "lease_error",
        label: classification.targetLabel ?? device?.name ?? null,
        message,
        ...(classification.targetKey ? { targetKey: classification.targetKey } : {}),
        retryAfter: classification.retryAfter,
        now,
        random: runtime.random,
      }, epochs).catch((writeError) => {
        logger.warn({ err: writeError, environmentId: environment.id }, "failed to record an environment outage");
        return null;
      });
      if (ownEpoch !== null && epochs) epochs = { ...epochs, environmentEpoch: ownEpoch };
    }
    return environmentWaitDeferral({
      reason: classification.reason,
      scope: classification.scope,
      environment: { id: environment.id, name: environment.name },
      device,
      message,
      retryAfter: classification.scope === "admission" ? classification.retryAfter : null,
      resumeAt: classification.scope === "target" ? classification.retryAfter : null,
      epochs,
      wasIssueAssignee: ctx.wasIssueAssignee,
      cause: error,
    });
  }

  /** A lease succeeded: end a recorded outage and wake the environment's target-scope waits. */
  async function noteAcquired(environmentId: string): Promise<{ changed: boolean; woken: number }> {
    const now = runtime.clock();
    const { changed } = await availability.markAvailable(environmentId, { source: "lease_error", now });
    if (!changed) return { changed, woken: 0 };
    const woken = await wakeResourceWaits(db, { environmentIds: [environmentId], scopes: ["target"] }, { now });
    return { changed, woken: woken.runIds.length };
  }

  /**
   * A limit wait whose run is the probe of an estimated or repeated limit:
   * the run holds the probe claim, or the account still counts strikes and
   * the agent still runs on it. Only the run's success ends it.
   */
  async function isLimitProbe(episode: ResourceWaitEpisodeRow, run: Pick<HeartbeatRunRow, "id" | "agentId">): Promise<boolean> {
    if (episode.kind !== "ai_account" || !episode.accountId) return false;
    if (episode.reason !== "usage_limit" && episode.reason !== "credit_balance") return false;
    const [account] = await db
      .select({ limitStrikes: aiAccounts.limitStrikes, limitProbeRunId: aiAccounts.limitProbeRunId })
      .from(aiAccounts)
      .where(eq(aiAccounts.id, episode.accountId));
    if (!account) return false;
    if (account.limitProbeRunId === run.id) return true;
    if (account.limitStrikes <= 0) return false;
    // Rebound since: this run never touches the limited account.
    const [binding] = await db
      .select({ mode: aiAccountAgentBindings.mode, accountId: aiAccountAgentBindings.accountId })
      .from(aiAccountAgentBindings)
      .where(eq(aiAccountAgentBindings.agentId, run.agentId));
    return binding?.mode === "pool_account" && binding.accountId === episode.accountId;
  }

  /**
   * The run passed the step that ends its wait: `credentials` ends account and
   * slot waits, `lease` ends every wait but a limit probe's, and `succeeded`
   * (the account's success hook, H14) ends any. Resolves the episode the run
   * is the current run of, writes "Resumed", logs `resource_wait.resolved`
   * and sends the resolved notice when the wait had been notified.
   */
  async function noteRunPassed(input: {
    run: Pick<HeartbeatRunRow, "id" | "companyId" | "agentId" | "contextSnapshot"> & Partial<HeartbeatRunRow>;
    step: "credentials" | "lease" | "succeeded";
  }): Promise<{ resolved: boolean; episodeId: string | null }> {
    const { run } = input;
    // Only a lane run can be an episode's current run. A finished run's context
    // may have been rewritten since it started, so `succeeded` looks it up anyway.
    if (input.step !== "succeeded" && !readResourceWaitContext(run.contextSnapshot?.resourceWait)) return { resolved: false, episodeId: null };
    const [episode] = await db
      .select()
      .from(resourceWaitEpisodes)
      .where(and(
        eq(resourceWaitEpisodes.currentRunId, run.id),
        eq(resourceWaitEpisodes.companyId, run.companyId),
        isNull(resourceWaitEpisodes.resolvedAt),
      ));
    if (!episode) return { resolved: false, episodeId: null };
    if (input.step === "credentials" && episode.kind === "environment") return { resolved: false, episodeId: episode.id };
    if (input.step !== "succeeded" && await isLimitProbe(episode, run)) return { resolved: false, episodeId: episode.id };
    const now = runtime.clock();
    // Only while this run still holds the episode: a wait another run took over goes on.
    const resolved = await resolveEpisode(db, episode.id, "resolved", now, { currentRunId: run.id });
    if (!resolved) return { resolved: false, episodeId: episode.id };
    const waited = formatWaitDuration(now.getTime() - resolved.since.getTime());
    const fullRun = run as HeartbeatRunRow;
    await runtime.deps.appendRunEvent(fullRun, {
      eventType: "lifecycle",
      stream: "system",
      level: "info",
      message: `Resumed after waiting ${waited}.`,
      payload: { resourceWait: { episodeId: resolved.id, kind: resolved.kind, reason: resolved.reason, resolution: "resolved" } },
    }).catch(() => undefined);
    await notifier.logResolved(resolved, run.id).catch((error) => {
      logger.warn({ err: error, episodeId: resolved.id }, "failed to log resource_wait.resolved");
    });
    await notifier.notifyResolved(resolved, now).catch((error) => {
      logger.warn({ err: error, episodeId: resolved.id }, "resource wait resolved notice failed");
    });
    await runtime.onEpisodeEnded(resolved).catch(() => undefined);
    return { resolved: true, episodeId: resolved.id };
  }

  return { preflightEnvironment, toDeferral, noteAcquired, noteRunPassed, noteRunRefused };
}

export type ResourceWaitPreflight = ReturnType<typeof createPreflight>;
