import { and, eq, sql } from "drizzle-orm";
import { type Db, agents, deviceLoginLimits, heartbeatRuns } from "@paperclipai/db";
import { POOL_RUN_AUTH_ENV_KEYS, type AiAccountLimitSource } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { isCreditBalanceFailure } from "./ai-account-hosts.js";
import { deviceForEnvironment, type DeviceEnvironmentRef } from "./execution-devices.js";
import {
  HEARTBEAT_AI_ACCOUNT_LIMITS,
  endedWithoutAccountFailure,
  readRunEnd,
  readRunFailureFacts,
  typedLimitUntil,
  type RunAccountBinding,
  type RunFailureProvenance,
} from "./heartbeat-ai-accounts.js";
import {
  RESOURCE_WAIT_TIMINGS,
  claimDeviceLoginProbe,
  claimResourceWaitNotice,
  deviceLoginProbeApplies,
  deviceLoginWaitDeferral,
  deviceLoginWaitReason,
  readDeviceLoginLimit,
  releaseResourceWaitNotice,
  resourceWaitJitterMs,
  type ResourceWaits,
} from "./resource-waits/index.js";

/**
 * Fork: usage limits of a device's own Claude login (doc/connections/AI-CONNECTIONS.md,
 * "Device login limits").
 *
 * A Claude agent without a pool account (no binding row, or `device_login`)
 * runs on the login of the user its environment runs as: a Mac's own Claude
 * account, or an SSH user's. Before this, a limit on such a login only made
 * the one task that hit it resume at the reset (the upstream provider-quota
 * monitor), every other task on that device still started and failed, and the
 * task showed no wait. Now the environment's login is treated like a pool
 * account: the limit is recorded per environment, every device-login run there
 * waits in the `device_login_wait` lane until the reset, one waiting run goes
 * first as a probe, and a served run clears the limit and wakes the rest.
 * Nothing moves a task to another account or device.
 */

type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;
type AgentRow = typeof agents.$inferSelect;

/** `contextSnapshot.deviceLogin`: the run uses its environment's own login. */
export const DEVICE_LOGIN_ATTRIBUTION_KEY = "deviceLogin";

export interface DeviceLoginAttribution {
  environmentId: string;
  environmentName: string | null;
  deviceId: string | null;
  deviceName: string | null;
}

const DEVICE_LOGIN_ADAPTER_TYPE = "claude_local";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** The run's own device-login attribution, written when its credentials were planned. */
export function readDeviceLoginAttribution(contextSnapshot: unknown): DeviceLoginAttribution | null {
  const raw = asRecord(asRecord(contextSnapshot)[DEVICE_LOGIN_ATTRIBUTION_KEY]);
  const environmentId = nonEmptyString(raw.environmentId);
  if (!environmentId) return null;
  return {
    environmentId,
    environmentName: nonEmptyString(raw.environmentName),
    deviceId: nonEmptyString(raw.deviceId),
    deviceName: nonEmptyString(raw.deviceName),
  };
}

/** Whether the resolved run env carries its own Claude credential (then the device login is not used). */
export function hasClaudeCredentialEnv(env: unknown): boolean {
  const record = asRecord(env);
  return POOL_RUN_AUTH_ENV_KEYS.some((key) => {
    const value = record[key];
    return typeof value === "string" ? value.trim().length > 0 : value !== undefined && value !== null;
  });
}

export interface PlanDeviceLoginInput {
  run: Pick<HeartbeatRunRow, "id" | "companyId" | "agentId" | "contextSnapshot">;
  agent: Pick<AgentRow, "id" | "companyId" | "name" | "adapterType">;
  binding: Pick<RunAccountBinding, "source"> | null | undefined;
  environment: DeviceEnvironmentRef | null | undefined;
  /** The resolved adapter config's env (an env credential is not the device login). */
  resolvedEnv: unknown;
  /** An upstream `aiConnection` serves the run. */
  managedAiConnection: boolean;
  /** A resumed persisted native run keeps its own execution contract and never waits here. */
  persisted: boolean;
  /** The run's live context; the attribution is written into it. */
  context: Record<string, unknown>;
  now?: Date;
}

export interface CreateHeartbeatDeviceLoginOptions {
  db: Db;
  resourceWaits: Pick<ResourceWaits, "scheduleResourceWait" | "wakeResourceWaits" | "noteRunPassed" | "readWakeEpochs">;
  now?: () => Date;
}

export interface DeviceLoginLimitOutcome {
  handled: boolean;
  reason: string;
  environmentId: string | null;
  until: Date | null;
  successorRunId: string | null;
}

export function createHeartbeatDeviceLogin(options: CreateHeartbeatDeviceLoginOptions) {
  const { db, resourceWaits } = options;
  const clock = options.now ?? (() => new Date());

  async function writeAttribution(runId: string, context: Record<string, unknown>, attribution: DeviceLoginAttribution | null) {
    if (attribution) {
      context[DEVICE_LOGIN_ATTRIBUTION_KEY] = attribution;
      await db.update(heartbeatRuns)
        .set({ contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || ${JSON.stringify({ [DEVICE_LOGIN_ATTRIBUTION_KEY]: attribution })}::jsonb` })
        .where(eq(heartbeatRuns.id, runId));
      return;
    }
    if (context[DEVICE_LOGIN_ATTRIBUTION_KEY] === undefined) return;
    // A run that retries a device-login run keeps no attribution it does not use.
    delete context[DEVICE_LOGIN_ATTRIBUTION_KEY];
    await db.update(heartbeatRuns)
      .set({ contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) - ${DEVICE_LOGIN_ATTRIBUTION_KEY}::text` })
      .where(eq(heartbeatRuns.id, runId));
  }

  /**
   * For a run that is starting, after its config is resolved. A run that uses
   * its environment's own Claude login (a `claude_local` agent without a pool
   * account, an upstream connection or a Claude credential in its env, on a
   * known environment) gets the `deviceLogin` attribution. While that login's
   * limit is in force, or another run holds its probe, the run waits instead:
   * this throws a `ResourceWaitDeferral` (kind `device_login`). Returns the
   * attribution, or null when the run does not use a device login.
   */
  async function planDeviceLogin(input: PlanDeviceLoginInput): Promise<DeviceLoginAttribution | null> {
    const { run, agent, environment } = input;
    const eligible = agent.adapterType === DEVICE_LOGIN_ADAPTER_TYPE
      && (input.binding?.source === "device_login" || input.binding?.source === "none")
      && !input.managedAiConnection
      && !input.persisted
      && Boolean(environment?.id)
      && !hasClaudeCredentialEnv(input.resolvedEnv);
    if (!eligible || !environment) {
      await writeAttribution(run.id, input.context, null);
      return null;
    }
    const now = input.now ?? clock();
    // The lost-wake guard: the epochs are read before the row they guard.
    const epochs = await resourceWaits.readWakeEpochs({ environmentId: environment.id, agentId: agent.id });
    const device = await deviceForEnvironment(db, environment, { create: false }).catch(() => null);
    const attribution: DeviceLoginAttribution = {
      environmentId: environment.id,
      environmentName: environment.name ?? null,
      deviceId: device?.id ?? null,
      deviceName: device?.name ?? null,
    };
    const limit = await readDeviceLoginLimit(db, { companyId: agent.companyId, environmentId: environment.id });
    if (limit?.exhaustedUntil) {
      const named = {
        environment: { id: environment.id, name: environment.name ?? null },
        device: device ? { id: device.id, name: device.name } : null,
        epochs,
      };
      if (limit.exhaustedUntil.getTime() > now.getTime()) {
        throw deviceLoginWaitDeferral({
          ...named,
          reason: deviceLoginWaitReason(limit),
          resumeAt: new Date(limit.exhaustedUntil.getTime() + resourceWaitJitterMs(run.id)),
          resumeAtSource: limit.limitSource ?? "estimated",
        });
      }
      // The reset has passed but no run was served since: one run tests the login.
      if (deviceLoginProbeApplies(limit) && !(await claimDeviceLoginProbe(db, environment.id, run.id))) {
        throw deviceLoginWaitDeferral({ ...named, reason: deviceLoginWaitReason(limit) });
      }
    }
    await writeAttribution(run.id, input.context, attribution);
    return attribution;
  }

  async function logLimitActivity(input: {
    run: HeartbeatRunRow;
    agent: AgentRow;
    attribution: DeviceLoginAttribution;
    onceKey: string;
    details: Record<string, unknown>;
    now: Date;
  }): Promise<void> {
    const { run } = input;
    if (!(await claimResourceWaitNotice(db, run.companyId, input.onceKey, input.now))) return;
    try {
      await logActivity(db, {
        companyId: run.companyId,
        actorType: "system",
        actorId: "heartbeat",
        action: "device_login.limit_reached",
        entityType: "environment",
        entityId: input.attribution.environmentId,
        agentId: input.agent.id,
        runId: run.id,
        details: input.details,
      });
    } catch (error) {
      await releaseResourceWaitNotice(db, run.companyId, input.onceKey).catch(() => undefined);
      logger.warn({ err: error, runId: run.id }, "failed to log a device login limit");
    }
  }

  /**
   * A device-login run ended on a usage limit or an exhausted credit balance.
   * Only a terminal-sourced `provider_quota` records it; a transcript-only
   * match stays a transient failure of that run. The reset follows the pool
   * account rules: a typed provider reset clamped to 7 d + 1 h (credit: 24 h),
   * else 24 h for credit or 1 h × 2^strikes up to 12 h; a provider value
   * replaces an estimate, and between two of the same kind the later one
   * stays. A hit while the limit is in force counts no new strike.
   * `device_login.limit_reached` is logged once per limit episode in the run's
   * company, and a `device_login_wait` successor waits for the reset plus
   * `jitter(runId)`.
   */
  async function handleDeviceLoginLimit(input: {
    run: HeartbeatRunRow;
    agent: AgentRow;
    provenance?: RunFailureProvenance | null;
    now?: Date;
  }): Promise<DeviceLoginLimitOutcome> {
    const { run, agent } = input;
    const attribution = readDeviceLoginAttribution(run.contextSnapshot);
    const none = (reason: string): DeviceLoginLimitOutcome => ({
      handled: false, reason, environmentId: attribution?.environmentId ?? null, until: null, successorRunId: null,
    });
    if (!attribution) return none("not_device_login_run");
    const facts = await readRunFailureFacts(db, run.id, input.provenance);
    if (!facts || facts.family !== "provider_quota") return none("not_a_limit");
    if (facts.source !== "terminal") return none("transcript_only");
    const now = input.now ?? clock();
    const nowText = now.toISOString();
    const creditBalance = isCreditBalanceFailure(facts.terminalText);
    const typed = typedLimitUntil({ now, typedReset: facts.typedReset, creditBalance });
    const limits = HEARTBEAT_AI_ACCOUNT_LIMITS;
    const t = deviceLoginLimits;

    const active = sql`(${t.exhaustedUntil} is not null and ${t.exhaustedUntil} > ${nowText}::timestamptz)`;
    const counted = sql`(${active} and ${t.limitStrikes} > 0)`;
    const exponent = sql`least(greatest(case when ${counted} then ${t.limitStrikes} - 1 else ${t.limitStrikes} end, 0), 20)`;
    const newUntil = typed
      ? sql`${typed.until.toISOString()}::timestamptz`
      : creditBalance
        ? sql`${nowText}::timestamptz + make_interval(secs => ${limits.creditBalanceMs / 1000}::double precision)`
        : sql`${nowText}::timestamptz + make_interval(secs => least(${limits.estimateMaxMs / 1000}::double precision, ${limits.estimateBaseMs / 1000}::double precision * power(2::double precision, (${exponent})::double precision)))`;
    const source: AiAccountLimitSource = typed?.source ?? "estimated";
    const storedProvider = sql`(${active} and ${t.limitSource} = 'provider')`;
    const limitReason = creditBalance ? "credit_balance" as const : "provider_quota" as const;

    // The first limit inserts the row; the update below then applies the rules to it.
    await db.insert(deviceLoginLimits)
      .values({ environmentId: attribution.environmentId, companyId: run.companyId, deviceId: attribution.deviceId })
      .onConflictDoNothing({ target: deviceLoginLimits.environmentId });
    const [updated] = await db
      .update(deviceLoginLimits)
      .set({
        exhaustedUntil: source === "provider"
          ? sql`case when ${storedProvider} then greatest(${t.exhaustedUntil}, ${newUntil}) else ${newUntil} end`
          : sql`case when not ${active} then ${newUntil} when ${storedProvider} then ${t.exhaustedUntil} else greatest(${t.exhaustedUntil}, ${newUntil}) end`,
        limitSource: source === "provider"
          ? "provider"
          : sql`case when ${storedProvider} then 'provider' else 'estimated' end`,
        limitStrikes: sql`case when ${counted} then ${t.limitStrikes} else ${t.limitStrikes} + 1 end`,
        limitEpisodeStartedAt: sql`case when ${t.limitStrikes} > 0 and ${t.limitEpisodeStartedAt} is not null then ${t.limitEpisodeStartedAt} else ${nowText}::timestamptz end`,
        limitProbeRunId: null,
        limitReason,
        limitRunId: run.id,
        lastLimitedAt: now,
        deviceId: attribution.deviceId ?? sql`${t.deviceId}`,
        updatedAt: now,
      })
      .where(and(eq(t.environmentId, attribution.environmentId), eq(t.companyId, run.companyId)))
      .returning();
    if (!updated?.exhaustedUntil) return none("environment_missing");

    await logLimitActivity({
      run,
      agent,
      attribution,
      onceKey: `activity:device_login.limit_reached:${attribution.environmentId}:${(updated.limitEpisodeStartedAt ?? now).toISOString()}`,
      now,
      details: {
        environment: attribution.environmentName,
        device: attribution.deviceName,
        reason: limitReason,
        exhaustedUntil: updated.exhaustedUntil.toISOString(),
        limitSource: updated.limitSource,
        strikes: updated.limitStrikes,
      },
    });

    const deferral = deviceLoginWaitDeferral({
      reason: deviceLoginWaitReason(updated),
      environment: { id: attribution.environmentId, name: attribution.environmentName },
      device: attribution.deviceId ? { id: attribution.deviceId, name: attribution.deviceName } : null,
      resumeAt: new Date(updated.exhaustedUntil.getTime() + resourceWaitJitterMs(run.id)),
      resumeAtSource: updated.limitSource ?? "estimated",
    });
    // The caller's normal finalization releases the issue lock when nothing was scheduled.
    const scheduled = await resourceWaits.scheduleResourceWait({
      run,
      wait: deferral.wait,
      agent,
      releaseIfUnscheduled: false,
      now,
    });
    return {
      handled: scheduled.outcome === "scheduled",
      reason: scheduled.outcome === "scheduled" ? deviceLoginWaitReason(updated) : scheduled.reason ?? "not_scheduled",
      environmentId: attribution.environmentId,
      until: updated.exhaustedUntil,
      successorRunId: scheduled.successorRunId,
    };
  }

  /**
   * A device-login run ended without a limit or a sign-in failure after the
   * provider served it: the environment's strikes, limit episode and probe
   * claim are cleared, a reset that has passed is forgotten (a typed reset
   * still ahead stays), and the login's waiting runs are woken, staggered by
   * up to 120 s. Any other end changes nothing.
   */
  async function noteDeviceLoginRunSucceeded(input: { run: HeartbeatRunRow; now?: Date }): Promise<{ cleared: boolean; woken: number }> {
    const { run } = input;
    const attribution = readDeviceLoginAttribution(run.contextSnapshot);
    if (!attribution) return { cleared: false, woken: 0 };
    const stored = await readRunEnd(db, run.id);
    if (!stored || !endedWithoutAccountFailure(stored.end)) return { cleared: false, woken: 0 };
    const now = input.now ?? clock();
    const nowText = now.toISOString();
    const t = deviceLoginLimits;
    const passed = sql`(${t.exhaustedUntil} is not null and ${t.exhaustedUntil} <= ${nowText}::timestamptz)`;
    const cleared = await db
      .update(deviceLoginLimits)
      .set({
        limitStrikes: 0,
        limitEpisodeStartedAt: null,
        limitProbeRunId: null,
        exhaustedUntil: sql`case when ${passed} then null else ${t.exhaustedUntil} end`,
        limitSource: sql`case when ${passed} then null else ${t.limitSource} end`,
        limitReason: sql`case when ${passed} then null else ${t.limitReason} end`,
        updatedAt: now,
      })
      .where(and(
        eq(t.environmentId, attribution.environmentId),
        eq(t.companyId, run.companyId),
        sql`(${t.limitStrikes} > 0 or ${t.limitEpisodeStartedAt} is not null or ${t.limitProbeRunId} is not null or ${passed})`,
      ))
      .returning({ environmentId: t.environmentId });
    if (cleared.length === 0) return { cleared: false, woken: 0 };
    const woken = await resourceWaits.wakeResourceWaits(
      { environmentIds: [attribution.environmentId], kinds: ["device_login"], companyId: run.companyId },
      { now, jitterMs: RESOURCE_WAIT_TIMINGS.limitJitterMaxMs },
    );
    return { cleared: true, woken: woken.runIds.length };
  }

  return { planDeviceLogin, handleDeviceLoginLimit, noteDeviceLoginRunSucceeded };
}

export type HeartbeatDeviceLogin = ReturnType<typeof createHeartbeatDeviceLogin>;
