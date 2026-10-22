import { and, asc, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import {
  type Db,
  agents,
  aiAccountAgentBindings,
  aiAccountHosts,
  aiAccounts,
  environments,
  heartbeatRuns,
  resourceWaitEpisodes,
} from "@paperclipai/db";
import {
  RESOURCE_WAIT_LANE_BY_KIND,
  RESOURCE_WAIT_RETRY_REASONS,
  readResourceWaitContext,
  type DeploymentMode,
  type ResourceWaitContext,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { environmentAvailabilityService, isFreshlyUnavailable } from "../environment-availability.js";
import { executionRetryAttemptCount } from "../execution-recovery-attempt.js";
import { capOf, deviceForEnvironment, runningPoolAccountsOnDevice, wouldExceedDeviceCap } from "../execution-devices.js";
import { evaluateAccountPlan } from "./account-plan.js";
import { jittered, resourceWaitJitterMs, waitDelayMs, type EpisodeEndedHandler } from "./deferral.js";
import { chainOfRun, handOverOrAbandon, resourceKeyOf } from "./episodes.js";
import { readRunEnvironmentPolicy, resolveRunEnvironment, type RunEnvironmentPolicy, type RunEnvironmentRow } from "./run-environment.js";
import { touchedAt } from "./wake.js";
import {
  RESOURCE_WAIT_TIMINGS,
  type AgentRow,
  type HeartbeatRunRow,
  type ResourceWaitDeps,
  type ResourceWaitEpisodeRow,
  type ResourceWaitTarget,
} from "./types.js";

/**
 * Fork: holding and re-checking waiting runs (spec 7.4, hook H11). heartbeat
 * calls `holdDueWaits` first inside `promoteDueScheduledRetries`. For every
 * due lane run it:
 *
 * 1. runs the issue gate at most every 5 minutes; a row the gate would
 *    suppress is left due, so run-dispatch cancels it and releases the lock in
 *    the same tick, and its episode is abandoned (or handed to another run of
 *    the chain that waits for the same resource);
 * 2. decides `canProceed` from the database only (environment registry, plan
 *    rows 1–9, the device's running set);
 * 3. leaves a proceeding row due, or re-arms a held one with a compare-and-set
 *    on `scheduled_retry_at` and `updated_at`, so a concurrent wake (which
 *    moves at least one of them) always wins. Bookkeeping goes into the
 *    episode; no run event is written.
 *
 * What a run waits for is its episode when it is that episode's current run.
 * Any other lane run (a second agent waiting on the same issue, or a run whose
 * episode ended) waits from its own `contextSnapshot.resourceWait` and is
 * held the same way; only an episode's current run writes its bookkeeping.
 *
 * Admission waits make one real attempt each time their backoff passes (the
 * episode's `next_check_at`, every 5 min doubling to 60 min), or at once after
 * a wake. A joined admission wait for the episode's own resource keeps its
 * own backoff from its lane attempts as well, so it never attempts while the
 * owner's attempt is in flight; it follows at once when the owner's attempt
 * ended the wait. A target-scope wait whose registry row went stale makes one
 * real attempt per environment: the oldest waiter's, whose result refreshes
 * the row; the others re-check every 60 s.
 *
 * Forced-Kubernetes and managed-sandbox-only instances choose the run's
 * environment themselves (`resolveRunEnvironment` does not model them): there
 * the environment the wait recorded stands.
 *
 * Probe rule: when an account's estimated (or repeated) limit has passed,
 * only the limit waiter whose episode started first proceeds, after claiming
 * `ai_accounts.limit_probe_run_id`; the other limit waiters re-check every
 * 60 s. Slots: per device and pass, waiters ordered by the start of their wait
 * proceed when their account already runs there, and a new account only while
 * a slot is free (an older waiter that is not due yet is woken to take it).
 *
 * No hold reaches further than the gate interval, so the gate sees a closed
 * or reassigned issue within five minutes.
 */

export interface HoldRuntime {
  db: Db;
  deps: Pick<ResourceWaitDeps, "evaluateScheduledRetryGate">;
  clock: () => Date;
  random: () => number;
  environmentWaitsEnabled: boolean;
  deploymentMode?: DeploymentMode;
  onEpisodeEnded: EpisodeEndedHandler;
}

export interface HoldPassResult {
  examined: number;
  proceeding: number;
  held: number;
  gateSuppressed: number;
  probesClaimed: number;
  /** Re-arms that lost the compare-and-set to a concurrent wake (the row stays due). */
  rearmLost: number;
  /** Older slot waiters that were not due yet and were woken to take a free slot. */
  slotWakes: number;
}

export type ProceedDecision =
  | { proceed: true; reason: string }
  | { proceed: false; holdUntil: Date; reason: string };

/** What a lane run waits for. */
export interface RunWait {
  /**
   * The run's episode when it is the episode's current run; otherwise a view
   * built from the run's own `contextSnapshot.resourceWait` (with the
   * bookkeeping of the episode it names, read-only, when that episode is
   * open and waits for the same resource).
   */
  view: ResourceWaitEpisodeRow;
  /** The run is the episode's current run: the hold may write the episode's bookkeeping. */
  owned: boolean;
}

/**
 * `scheduled_retry_at` and `updated_at` as exact database text, for the
 * compare-and-set. A wake moves at least one of them (spec 7.4).
 */
const exactScheduledRetryAt = sql<string>`to_char(${heartbeatRuns.scheduledRetryAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
const exactUpdatedAt = sql<string>`to_char(${heartbeatRuns.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;

const LIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const LIMIT_REASONS = ["usage_limit", "credit_balance"] as const;

interface DueRow {
  run: HeartbeatRunRow;
  observed: string;
  observedUpdatedAt: string;
  /** `created_at` as exact text: with `observed` and the id, the page cursor. */
  observedCreatedAt: string;
}

const exactCreatedAt = sql<string>`to_char(${heartbeatRuns.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;

function proceed(reason: string): ProceedDecision {
  return { proceed: true, reason };
}

function hold(holdUntil: Date, reason: string): ProceedDecision {
  return { proceed: false, holdUntil, reason };
}

function isLimitReason(reason: string | null | undefined): boolean {
  return reason === "usage_limit" || reason === "credit_balance";
}

/** The wait a lane run's context describes (the driver's `retryAfter` is not kept there). */
function targetOfContext(context: ResourceWaitContext): ResourceWaitTarget {
  return {
    kind: context.kind,
    reason: context.reason,
    scope: context.scope,
    environmentId: context.environmentId,
    environmentName: context.environmentName,
    deviceId: context.deviceId,
    deviceName: context.deviceName,
    accountId: context.accountId,
    accountLabel: context.accountLabel,
    resumeAt: context.resumeAt ? new Date(context.resumeAt) : null,
    resumeAtSource: context.resumeAtSource,
    message: context.message,
    retryAfter: null,
  };
}

/**
 * When a joined admission wait for the episode's own resource makes its next
 * real attempt: once its own backoff has passed (its creation plus the
 * deferral's doubling over its own lane attempts) and never before the
 * episode's next attempt. A cleared episode backoff (the owner's attempt is in
 * flight) does not make it due; an episode its owner's attempt resolved does,
 * at once. Null means due.
 */
function coWaiterAdmissionDueAt(
  run: HeartbeatRunRow,
  context: ResourceWaitContext,
  named: ResourceWaitEpisodeRow,
  random: () => number,
): Date | null {
  if (named.resolution === "resolved") return null;
  const lane = RESOURCE_WAIT_LANE_BY_KIND[context.kind];
  const ownDelayMs = waitDelayMs({
    wait: targetOfContext(context),
    episode: { checks: Math.max(0, executionRetryAttemptCount(run, lane) - 1) },
    runId: run.id,
    now: run.createdAt,
    random,
  });
  const borrowed = named.resolvedAt ? null : named.nextCheckAt;
  return new Date(Math.max(run.createdAt.getTime() + ownDelayMs, borrowed?.getTime() ?? 0));
}

/**
 * The wait a run's own context describes, as an episode-shaped view. The
 * episode the context names lends its start, and while it is open and waits
 * for the same resource, its backoff (an admission wait also keeps its own).
 */
function viewFromContext(
  run: HeartbeatRunRow,
  context: ResourceWaitContext,
  named: ResourceWaitEpisodeRow | null,
  random: () => number,
): ResourceWaitEpisodeRow {
  const resourceKey = resourceKeyOf(context);
  const same = named && named.companyId === run.companyId && named.kind === context.kind && named.resourceKey === resourceKey
    ? named
    : null;
  const open = same && !same.resolvedAt ? same : null;
  const admission = context.kind === "environment" && context.scope === "admission";
  return {
    id: context.episodeId,
    companyId: run.companyId,
    agentId: run.agentId,
    issueId: chainOfRun(run).issueId,
    kind: context.kind,
    reason: context.reason,
    scope: context.scope,
    resourceKey,
    environmentId: context.environmentId,
    deviceId: context.deviceId,
    accountId: context.accountId,
    since: open?.since ?? run.createdAt,
    currentRunId: open?.currentRunId ?? null,
    resumeAt: context.resumeAt ? new Date(context.resumeAt) : null,
    resumeAtSource: context.resumeAtSource,
    nextCheckAt: admission && same ? coWaiterAdmissionDueAt(run, context, same, random) : open?.nextCheckAt ?? null,
    checks: open?.checks ?? 0,
    gateCheckedAt: null,
    notifiedAt: null,
    longNotifiedAt: null,
    resolvedNotifiedAt: null,
    resolvedAt: null,
    resolution: null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

/**
 * Claims the probe of an account for a run. Succeeds when no probe is claimed,
 * when this run holds it already, or when the claiming run is no longer
 * queued, running or waiting. Leaves `updated_at` alone: a claim is not a
 * state change anybody waits for.
 */
export async function claimAccountProbe(db: Db, accountId: string, runId: string): Promise<boolean> {
  const rows = await db
    .update(aiAccounts)
    .set({ limitProbeRunId: runId })
    .where(and(
      eq(aiAccounts.id, accountId),
      or(
        isNull(aiAccounts.limitProbeRunId),
        eq(aiAccounts.limitProbeRunId, runId),
        sql`not exists (
          select 1 from ${heartbeatRuns}
          where ${heartbeatRuns.id} = ${aiAccounts.limitProbeRunId}
            and ${heartbeatRuns.status} in (${sql.join(LIVE_RUN_STATUSES.map((status) => sql`${status}`), sql`, `)})
        )`,
      ),
    ))
    .returning({ id: aiAccounts.id });
  return rows.length > 0;
}

export function createHold(runtime: HoldRuntime) {
  const { db, deps } = runtime;
  const availability = environmentAvailabilityService(db);

  function capHold(next: Date, now: Date): Date {
    const latest = now.getTime() + RESOURCE_WAIT_TIMINGS.gateIntervalMs;
    const earliest = now.getTime() + 1_000;
    return new Date(Math.min(Math.max(next.getTime(), earliest), latest));
  }

  function recheck(now: Date): Date {
    return new Date(now.getTime() + jittered(RESOURCE_WAIT_TIMINGS.recheckMs, runtime.random));
  }

  async function makeDueNow(runId: string, now: Date): Promise<number> {
    const rows = await db
      .update(heartbeatRuns)
      .set({ scheduledRetryAt: sql`least(${heartbeatRuns.scheduledRetryAt}, ${now.toISOString()}::timestamptz)`, updatedAt: touchedAt(now) })
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "scheduled_retry")))
      .returning({ id: heartbeatRuns.id });
    return rows.length;
  }

  async function bindingOf(agentId: string) {
    const [binding] = await db
      .select({ mode: aiAccountAgentBindings.mode, accountId: aiAccountAgentBindings.accountId })
      .from(aiAccountAgentBindings)
      .where(eq(aiAccountAgentBindings.agentId, agentId));
    return binding ?? null;
  }

  async function runEnvironment(run: HeartbeatRunRow, agent: AgentRow, policy: RunEnvironmentPolicy) {
    const projectId = typeof run.contextSnapshot?.projectId === "string" ? run.contextSnapshot.projectId : null;
    // The run's retained policy, as executeRun's "run" source: a low-trust boundary stays with the run.
    return resolveRunEnvironment(db, {
      companyId: run.companyId, agent, issueId: chainOfRun(run).issueId, projectId,
      executionPolicy: run.contextSnapshot?.executionPolicy,
    }, policy);
  }

  /**
   * The environment the waiting run would use now. Where the instance forces
   * Kubernetes or managed sandboxes, executeRun picks it and nothing here
   * models that choice: the environment the wait recorded stands (null only
   * when the wait recorded none or it is gone).
   */
  async function environmentNow(
    run: HeartbeatRunRow,
    agent: AgentRow,
    view: ResourceWaitEpisodeRow,
    policy: RunEnvironmentPolicy,
  ): Promise<RunEnvironmentRow | null> {
    if (!policy.unmodelled) return (await runEnvironment(run, agent, policy))?.environment ?? null;
    if (!view.environmentId) return null;
    const [recorded] = await db.select().from(environments).where(eq(environments.id, view.environmentId));
    return recorded ?? null;
  }

  /**
   * The oldest target-scope wait on an environment whose run still waits, or
   * started an attempt within the gate interval. While its row is stale it
   * alone makes the real attempt that refreshes the row.
   */
  async function staleRowLeader(environmentId: string, now: Date) {
    const inFlightSince = new Date(now.getTime() - RESOURCE_WAIT_TIMINGS.gateIntervalMs).toISOString();
    const [leader] = await db
      .select({ runId: heartbeatRuns.id, status: heartbeatRuns.status, scheduledRetryAt: heartbeatRuns.scheduledRetryAt })
      .from(resourceWaitEpisodes)
      .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, resourceWaitEpisodes.currentRunId))
      .where(and(
        isNull(resourceWaitEpisodes.resolvedAt),
        eq(resourceWaitEpisodes.kind, "environment"),
        eq(resourceWaitEpisodes.scope, "target"),
        eq(resourceWaitEpisodes.environmentId, environmentId),
        or(
          eq(heartbeatRuns.status, "scheduled_retry"),
          sql`(${heartbeatRuns.status} in ('queued', 'running')
            and coalesce(${heartbeatRuns.startedAt}, ${heartbeatRuns.updatedAt}) >= ${inFlightSince}::timestamptz)`,
        ),
      ))
      .orderBy(asc(resourceWaitEpisodes.since), asc(resourceWaitEpisodes.id))
      .limit(1);
    return leader ?? null;
  }

  /**
   * Environment waits. A changed or retired environment proceeds (the next
   * attempt re-plans or refuses). Admission scope: one real attempt once the
   * backoff in the episode has passed, or at once after a wake cleared it.
   * Target scope: the registry decides; a cleared row proceeds; a stale row
   * waits for a target's `retryAfter` and otherwise lets one waiter per
   * environment attempt.
   */
  async function canProceedEnvironment(
    run: HeartbeatRunRow,
    agent: AgentRow,
    view: ResourceWaitEpisodeRow,
    policy: RunEnvironmentPolicy,
    now: Date,
  ): Promise<ProceedDecision> {
    const environment = await environmentNow(run, agent, view, policy);
    if (!environment || environment.id !== view.environmentId) return proceed("environment_changed");
    const row = await availability.get(environment.id);
    if (row?.state === "retired") return proceed("environment_retired");
    if (view.scope !== "target") {
      if (view.nextCheckAt && view.nextCheckAt.getTime() > now.getTime()) return hold(view.nextCheckAt, "admission_backoff");
      return proceed("admission_attempt");
    }
    if (!row || row.state !== "unavailable") return proceed("environment_available");
    if (!isFreshlyUnavailable(row, now)) {
      // The target said when to come back: nothing to learn before that.
      if (row.retryAfter && row.retryAfter.getTime() > now.getTime()) return hold(row.retryAfter, "registry_retry_after");
      const leader = await staleRowLeader(environment.id, now);
      if (!leader || leader.runId === run.id) return proceed("registry_stale");
      // The leader's attempt refreshes the row; wake it if it is still held.
      if (leader.status === "scheduled_retry" && leader.scheduledRetryAt && leader.scheduledRetryAt.getTime() > now.getTime()) {
        await makeDueNow(leader.runId, now);
      }
      return hold(recheck(now), "registry_stale_waiting");
    }
    // Re-check just after the registry's next check, so the sweep's check
    // lands first, and never before the target's own retry time.
    const next = Math.max(
      now.getTime() + RESOURCE_WAIT_TIMINGS.minHoldMs,
      (row.nextCheckAt ?? now).getTime() + RESOURCE_WAIT_TIMINGS.sweepGraceMs,
      row.retryAfter?.getTime() ?? 0,
    );
    return hold(new Date(next), "environment_unavailable");
  }

  /**
   * Account waits: a changed binding proceeds; otherwise plan rows 1–9 are
   * re-evaluated. A wait whose failing row changed proceeds too, so the next
   * attempt defers again with the current reason (and its notice). A limit
   * holds until its reset plus `jitter(runId)`; after an estimated or repeated
   * limit, only the probe winner among the limit's waiters proceeds. A wait
   * for another reason (row 9 was not what it waited for) proceeds once its
   * own row passes.
   */
  async function canProceedAccount(
    run: HeartbeatRunRow,
    agent: AgentRow,
    view: ResourceWaitEpisodeRow,
    policy: RunEnvironmentPolicy,
    now: Date,
  ): Promise<ProceedDecision & { probeClaimed?: boolean }> {
    const binding = await bindingOf(agent.id);
    if (!binding || binding.mode !== "pool_account" || binding.accountId !== view.accountId) return proceed("binding_changed");
    const plan = await evaluateAccountPlan(db, {
      companyId: run.companyId,
      accountId: view.accountId,
      environment: await environmentNow(run, agent, view, policy),
      now,
      deploymentMode: runtime.deploymentMode,
    });
    if (plan.reason === null) {
      const account = plan.account!;
      // The run-scoped sign-in check keeps its own deadline; the account is unchanged.
      if (view.reason === "auth_unconfirmed" && view.resumeAt && view.resumeAt.getTime() > now.getTime()) {
        return hold(view.resumeAt, "auth_unconfirmed");
      }
      // Spec 7.4: the probe rule applies to the waits on the limit (row 9) only.
      const probeApplies = isLimitReason(view.reason)
        && account.exhaustedUntil !== null
        && (account.limitSource === "estimated" || account.limitStrikes > 0);
      if (!probeApplies) return proceed("account_available");
      const [first] = await db
        .select({ episodeId: resourceWaitEpisodes.id })
        .from(resourceWaitEpisodes)
        .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, resourceWaitEpisodes.currentRunId))
        .where(and(
          eq(resourceWaitEpisodes.accountId, account.id),
          eq(resourceWaitEpisodes.kind, "ai_account"),
          inArray(resourceWaitEpisodes.reason, [...LIMIT_REASONS]),
          isNull(resourceWaitEpisodes.resolvedAt),
          eq(heartbeatRuns.status, "scheduled_retry"),
        ))
        .orderBy(asc(resourceWaitEpisodes.since), asc(resourceWaitEpisodes.id))
        .limit(1);
      if (first && first.episodeId !== view.id) return hold(recheck(now), "probe_waiting");
      if (!(await claimAccountProbe(db, account.id, run.id))) return hold(recheck(now), "probe_claimed_elsewhere");
      return { ...proceed("probe_claimed"), probeClaimed: true };
    }
    if (plan.reason !== view.reason && !(isLimitReason(plan.reason) && isLimitReason(view.reason))) return proceed("reason_changed");
    if (isLimitReason(plan.reason) && plan.account?.exhaustedUntil) {
      return hold(new Date(plan.account.exhaustedUntil.getTime() + resourceWaitJitterMs(run.id)), "limit_not_reset");
    }
    return hold(recheck(now), "account_unavailable");
  }

  /**
   * Re-arms a held row unless a wake moved `scheduled_retry_at` or
   * `updated_at` since it was read. `nextCheckAt` is the episode's
   * bookkeeping; undefined leaves it (an admission wait keeps its uncapped
   * next attempt there).
   */
  async function rearm(row: DueRow, episodeId: string | null, next: Date, now: Date, nextCheckAt: Date | undefined): Promise<boolean> {
    const updated = await db
      .update(heartbeatRuns)
      .set({ scheduledRetryAt: next, updatedAt: touchedAt(now) })
      .where(and(
        eq(heartbeatRuns.id, row.run.id),
        eq(heartbeatRuns.status, "scheduled_retry"),
        sql`${exactScheduledRetryAt} = ${row.observed}`,
        sql`${exactUpdatedAt} = ${row.observedUpdatedAt}`,
      ))
      .returning({ id: heartbeatRuns.id });
    if (updated.length === 0) return false;
    if (episodeId && nextCheckAt !== undefined) {
      await db.update(resourceWaitEpisodes).set({ nextCheckAt, updatedAt: now }).where(eq(resourceWaitEpisodes.id, episodeId));
    }
    return true;
  }

  /**
   * What each lane run waits for: the open episode it is the current run of,
   * else its own context (with the episode the context names, if any). A run
   * with neither is left out and proceeds to a real attempt.
   */
  async function loadWaits(runs: readonly HeartbeatRunRow[]): Promise<Map<string, RunWait>> {
    const byRun = new Map<string, RunWait>();
    if (runs.length === 0) return byRun;
    const owned = await db
      .select()
      .from(resourceWaitEpisodes)
      .where(and(isNull(resourceWaitEpisodes.resolvedAt), inArray(resourceWaitEpisodes.currentRunId, runs.map((run) => run.id))));
    const contexts = new Map<string, ResourceWaitContext>();
    for (const run of runs) {
      const episode = owned.find((row) => row.currentRunId === run.id && row.companyId === run.companyId);
      if (episode) {
        byRun.set(run.id, { view: episode, owned: true });
        continue;
      }
      const context = readResourceWaitContext(run.contextSnapshot?.resourceWait);
      if (context) contexts.set(run.id, context);
    }
    if (contexts.size === 0) return byRun;
    const named = await db
      .select()
      .from(resourceWaitEpisodes)
      .where(inArray(resourceWaitEpisodes.id, [...new Set([...contexts.values()].map((context) => context.episodeId))]));
    for (const run of runs) {
      const context = contexts.get(run.id);
      if (!context) continue;
      const episode = named.find((row) => row.id === context.episodeId) ?? null;
      byRun.set(run.id, { view: viewFromContext(run, context, episode, runtime.random), owned: false });
    }
    return byRun;
  }

  async function waitOf(run: HeartbeatRunRow): Promise<RunWait | null> {
    return (await loadWaits([run])).get(run.id) ?? null;
  }

  /**
   * One `canProceed` decision for a due lane run that is not a slot wait
   * (slot waits are decided per device in `holdDueWaits`). Exposed for
   * "Check now".
   */
  async function decide(
    run: HeartbeatRunRow,
    wait: RunWait | null,
    now: Date,
    policy?: RunEnvironmentPolicy,
  ): Promise<ProceedDecision & { probeClaimed?: boolean }> {
    if (!wait) return proceed("no_wait");
    const view = wait.view;
    if (!runtime.environmentWaitsEnabled && view.kind === "environment") return proceed("environment_waits_off");
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, run.agentId), eq(agents.companyId, run.companyId)));
    if (!agent) return proceed("agent_missing");
    const resolvedPolicy = policy ?? await readRunEnvironmentPolicy(db);
    if (view.kind === "environment") return canProceedEnvironment(run, agent, view, resolvedPolicy, now);
    if (view.kind === "ai_account") return canProceedAccount(run, agent, view, resolvedPolicy, now);
    return decideSlots(run, agent, view, resolvedPolicy, now);
  }

  /** A single slot decision (Check now): the run's account runs there already, or a slot is free. */
  async function decideSlots(
    run: HeartbeatRunRow,
    agent: AgentRow,
    view: ResourceWaitEpisodeRow,
    policy: RunEnvironmentPolicy,
    now: Date,
  ): Promise<ProceedDecision> {
    const binding = await bindingOf(agent.id);
    if (!binding || binding.mode !== "pool_account" || !binding.accountId || binding.accountId !== view.accountId) {
      return proceed("binding_changed");
    }
    if (!view.deviceId) return proceed("device_unknown");
    const environment = await environmentNow(run, agent, view, policy);
    if (environment) {
      const device = await deviceForEnvironment(db, environment, { create: false }).catch(() => null);
      if (device?.id !== view.deviceId) return proceed("device_changed");
    }
    const [device] = await db.select().from(aiAccountHosts).where(eq(aiAccountHosts.id, view.deviceId));
    if (!device) return proceed("device_missing");
    const running = await runningPoolAccountsOnDevice(db, device.id);
    if (!wouldExceedDeviceCap({ cap: capOf(device), inUse: running, accountId: binding.accountId })) return proceed("slot_free");
    return hold(recheck(now), "slots_full");
  }

  /** Every run waiting for a slot on the device, first waiter first. */
  async function slotWaitersOn(deviceId: string): Promise<Array<{ run: HeartbeatRunRow; view: ResourceWaitEpisodeRow }>> {
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.status, "scheduled_retry"),
        eq(heartbeatRuns.scheduledRetryReason, RESOURCE_WAIT_LANE_BY_KIND.device_slots),
        or(
          inArray(
            heartbeatRuns.id,
            db.select({ id: sql<string>`${resourceWaitEpisodes.currentRunId}` })
              .from(resourceWaitEpisodes)
              .where(and(
                isNull(resourceWaitEpisodes.resolvedAt),
                eq(resourceWaitEpisodes.kind, "device_slots"),
                eq(resourceWaitEpisodes.deviceId, deviceId),
              )),
          ),
          sql`${heartbeatRuns.contextSnapshot} -> 'resourceWait' ->> 'deviceId' = ${deviceId}`,
        ),
      ));
    const waits = await loadWaits(runs);
    return runs
      .map((run) => ({ run, view: waits.get(run.id)?.view ?? null }))
      .filter((entry): entry is { run: HeartbeatRunRow; view: ResourceWaitEpisodeRow } =>
        entry.view !== null && entry.view.kind === "device_slots" && entry.view.deviceId === deviceId)
      .sort((a, b) =>
        a.view.since.getTime() - b.view.since.getTime()
        || a.view.id.localeCompare(b.view.id)
        || a.run.createdAt.getTime() - b.run.createdAt.getTime()
        || a.run.id.localeCompare(b.run.id));
  }

  /**
   * First-in-first-out slot admission for one device in this pass. Returns a
   * decision for each due waiter; older waiters that are not due but win a
   * slot are made due now.
   */
  async function admitSlots(
    deviceId: string,
    due: Array<{ row: DueRow; wait: RunWait }>,
    policy: RunEnvironmentPolicy,
    now: Date,
  ): Promise<{ decisions: Map<string, ProceedDecision>; woken: number }> {
    const decisions = new Map<string, ProceedDecision>();
    const dueByRun = new Map(due.map((entry) => [entry.row.run.id, entry]));
    const [device] = await db.select().from(aiAccountHosts).where(eq(aiAccountHosts.id, deviceId));
    if (!device) {
      for (const entry of due) decisions.set(entry.row.run.id, proceed("device_missing"));
      return { decisions, woken: 0 };
    }
    // A due waiter whose agent moved to another device re-plans instead of queueing here.
    for (const entry of due) {
      const [agent] = await db.select().from(agents).where(eq(agents.id, entry.row.run.agentId));
      if (!agent) {
        decisions.set(entry.row.run.id, proceed("agent_missing"));
        continue;
      }
      const resolved = await runEnvironment(entry.row.run, agent, policy);
      if (!resolved) continue;
      const resolvedDevice = await deviceForEnvironment(db, resolved.environment, { create: false }).catch(() => null);
      if (resolvedDevice?.id !== deviceId) decisions.set(entry.row.run.id, proceed("device_changed"));
    }
    const running = await runningPoolAccountsOnDevice(db, deviceId);
    let free = capOf(device) - running.size;
    const admitted = new Set<string>();
    const toWake: string[] = [];
    for (const waiter of await slotWaitersOn(deviceId)) {
      const isDue = dueByRun.has(waiter.run.id);
      if (isDue && decisions.has(waiter.run.id)) continue;
      const binding = await bindingOf(waiter.run.agentId);
      const accountId = binding?.mode === "pool_account" ? binding.accountId : null;
      if (!accountId || accountId !== waiter.view.accountId) {
        // Rebound or switched to the device login: the next attempt re-plans.
        if (isDue) decisions.set(waiter.run.id, proceed("binding_changed"));
        continue;
      }
      let admit = false;
      if (running.has(accountId) || admitted.has(accountId)) {
        admit = true;
      } else if (free > 0) {
        admit = true;
        free -= 1;
        admitted.add(accountId);
      }
      if (isDue) decisions.set(waiter.run.id, admit ? proceed("slot_free") : hold(recheck(now), "slots_full"));
      else if (admit) toWake.push(waiter.run.id);
    }
    for (const entry of due) {
      if (!decisions.has(entry.row.run.id)) decisions.set(entry.row.run.id, proceed("not_queued_on_device"));
    }
    let woken = 0;
    for (const runId of toWake) woken += await makeDueNow(runId, now);
    return { decisions, woken };
  }

  /**
   * The gate suppressed an episode's current run: the episode goes to
   * another run of the chain that waits for the same resource, or is
   * abandoned. The chain's other waiting runs that the gate suppresses too
   * (the task was closed or blocked) are made due, so run-dispatch cancels
   * them in this tick as well, however far out their own next check is.
   */
  async function endSuppressed(run: HeartbeatRunRow, episode: ResourceWaitEpisodeRow, now: Date): Promise<void> {
    const issueId = chainOfRun(run).issueId;
    const others = issueId
      ? await db
        .select({ id: heartbeatRuns.id, scheduledRetryReason: heartbeatRuns.scheduledRetryReason, scheduledRetryAt: heartbeatRuns.scheduledRetryAt })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, run.companyId),
          eq(heartbeatRuns.status, "scheduled_retry"),
          inArray(heartbeatRuns.scheduledRetryReason, [...RESOURCE_WAIT_RETRY_REASONS]),
          ne(heartbeatRuns.id, run.id),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
        ))
      : [];
    const ending = [run.id];
    for (const other of others) {
      const gate = await deps.evaluateScheduledRetryGate({
        runId: other.id,
        companyId: run.companyId,
        retryReasonOverride: other.scheduledRetryReason ?? "",
        now,
      });
      if (gate.allowed) continue;
      ending.push(other.id);
      if (!other.scheduledRetryAt || other.scheduledRetryAt.getTime() > now.getTime()) await makeDueNow(other.id, now);
    }
    const { abandoned } = await handOverOrAbandon(db, episode, ending, now);
    if (abandoned) await runtime.onEpisodeEnded(abandoned, { endingRunIds: ending, now }).catch(() => undefined);
  }

  /**
   * One page of due lane rows, oldest due first, after `cursor` (the last row
   * of the previous page, compared as exact database text).
   */
  async function dueLanePage(now: Date, cutoff: Date | null | undefined, pageSize: number, cursor: DueRow | null): Promise<DueRow[]> {
    return db
      .select({ run: heartbeatRuns, observed: exactScheduledRetryAt, observedUpdatedAt: exactUpdatedAt, observedCreatedAt: exactCreatedAt })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.status, "scheduled_retry"),
        inArray(heartbeatRuns.scheduledRetryReason, [...RESOURCE_WAIT_RETRY_REASONS]),
        lte(heartbeatRuns.scheduledRetryAt, now),
        cutoff ? gte(heartbeatRuns.createdAt, cutoff) : undefined,
        cursor
          ? sql`(${heartbeatRuns.scheduledRetryAt}, ${heartbeatRuns.createdAt}, ${heartbeatRuns.id}) > (
              (${cursor.observed}::timestamp at time zone 'UTC'),
              (${cursor.observedCreatedAt}::timestamp at time zone 'UTC'),
              ${cursor.run.id}::uuid
            )`
          : undefined,
      ))
      .orderBy(asc(heartbeatRuns.scheduledRetryAt), asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
      .limit(pageSize);
  }

  /**
   * Every due lane row is examined, a page (`limit`, 200) at a time.
   * run-dispatch then promotes the oldest due rows of any lane, and a held row
   * leaves the due set: a row left past the first page would otherwise be
   * promoted without a check (a herd behind a stale registry row).
   */
  async function holdDueWaits(input: { now?: Date; limit?: number; cutoff?: Date | null } = {}): Promise<HoldPassResult> {
    const now = input.now ?? runtime.clock();
    const result: HoldPassResult = { examined: 0, proceeding: 0, held: 0, gateSuppressed: 0, probesClaimed: 0, rearmLost: 0, slotWakes: 0 };
    const pageSize = Math.max(1, input.limit ?? RESOURCE_WAIT_TIMINGS.holdBatchLimit);
    let page = await dueLanePage(now, input.cutoff, pageSize, null);
    if (page.length === 0) return result;
    const policy = await readRunEnvironmentPolicy(db);
    const slotWaiters = new Map<string, Array<{ row: DueRow; wait: RunWait }>>();

    const apply = async (row: DueRow, wait: RunWait | null, decision: ProceedDecision) => {
      const episodeId = wait?.owned ? wait.view.id : null;
      if (decision.proceed) {
        result.proceeding += 1;
        if (episodeId) await db.update(resourceWaitEpisodes).set({ nextCheckAt: null, updatedAt: now }).where(eq(resourceWaitEpisodes.id, episodeId));
        return;
      }
      const next = capHold(decision.holdUntil, now);
      // An admission wait's next real attempt stays as the deferral set it.
      const admission = wait?.view.kind === "environment" && wait.view.scope === "admission";
      if (await rearm(row, episodeId, next, now, admission ? undefined : next)) result.held += 1;
      else {
        result.rearmLost += 1;
        result.proceeding += 1;
      }
    };

    for (;;) {
      result.examined += page.length;
      const waits = await loadWaits(page.map((row) => row.run));
      for (const row of page) {
        const wait = waits.get(row.run.id) ?? null;
        try {
          if (wait && (runtime.environmentWaitsEnabled || wait.view.kind !== "environment")) {
            // A run that does not own its episode keeps no gate time: its gate runs at each check.
            const gateDue = !wait.owned
              || !wait.view.gateCheckedAt
              || now.getTime() - wait.view.gateCheckedAt.getTime() >= RESOURCE_WAIT_TIMINGS.gateIntervalMs;
            if (gateDue) {
              const gate = await deps.evaluateScheduledRetryGate({
                runId: row.run.id,
                companyId: row.run.companyId,
                retryReasonOverride: row.run.scheduledRetryReason ?? "",
                now,
              });
              if (!gate.allowed) {
                // Left due: run-dispatch cancels it and releases the lock in this tick.
                result.gateSuppressed += 1;
                if (wait.owned) await endSuppressed(row.run, wait.view, now);
                continue;
              }
              if (wait.owned) {
                await db.update(resourceWaitEpisodes).set({ gateCheckedAt: now, updatedAt: now }).where(eq(resourceWaitEpisodes.id, wait.view.id));
              }
            }
            if (wait.view.kind === "device_slots" && wait.view.deviceId) {
              const list = slotWaiters.get(wait.view.deviceId) ?? [];
              list.push({ row, wait });
              slotWaiters.set(wait.view.deviceId, list);
              continue;
            }
          }
          const decision = await decide(row.run, wait, now, policy);
          if (decision.probeClaimed) result.probesClaimed += 1;
          await apply(row, wait, decision);
        } catch (error) {
          // A failed check never strands a run: it proceeds to a real attempt.
          logger.warn({ err: error, runId: row.run.id }, "resource wait hold check failed; letting the run proceed");
          result.proceeding += 1;
        }
      }
      if (page.length < pageSize) break;
      page = await dueLanePage(now, input.cutoff, pageSize, page[page.length - 1]!);
      if (page.length === 0) break;
    }

    // Slots are admitted once per device for the whole pass, first in first out.
    for (const [deviceId, due] of slotWaiters) {
      try {
        const { decisions, woken } = await admitSlots(deviceId, due, policy, now);
        result.slotWakes += woken;
        for (const entry of due) await apply(entry.row, entry.wait, decisions.get(entry.row.run.id) ?? proceed("slot_free"));
      } catch (error) {
        logger.warn({ err: error, deviceId }, "resource wait slot admission failed; letting the waiters proceed");
        result.proceeding += due.length;
      }
    }
    return result;
  }

  return { holdDueWaits, decide, waitOf };
}

export type ResourceWaitHold = ReturnType<typeof createHold>;
