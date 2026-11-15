import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { deviceLoginLimits, heartbeatRuns, resourceWaitEpisodes } from "@paperclipai/db";
import type { DeviceLoginWaitReason, ResourceWaitResumeAtSource } from "@paperclipai/shared";
import {
  ResourceWaitDeferral,
  type ResourceWaitDb,
  type WakeEpochSnapshot,
} from "./types.js";

/**
 * Fork: the usage limit of a device's own Claude login (`device_login_limits`,
 * one row per environment). An agent without a pool account runs on the login
 * of the user its environment runs as; once that login reports a limit, its
 * runs on that environment wait in the `device_login_wait` lane for the reset,
 * as a pool account's runs do. Nothing moves a task to another account.
 */

export type DeviceLoginLimitRow = typeof deviceLoginLimits.$inferSelect;

const LIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const LIMIT_REASONS = ["usage_limit", "credit_balance"] as const;

interface NamedRef {
  id: string;
  name: string | null;
}

export async function readDeviceLoginLimit(
  db: ResourceWaitDb,
  input: { companyId: string; environmentId: string },
): Promise<DeviceLoginLimitRow | null> {
  const [row] = await db
    .select()
    .from(deviceLoginLimits)
    .where(and(eq(deviceLoginLimits.environmentId, input.environmentId), eq(deviceLoginLimits.companyId, input.companyId)));
  return row ?? null;
}

/** The wait reason of a recorded limit. */
export function deviceLoginWaitReason(row: Pick<DeviceLoginLimitRow, "limitReason">): DeviceLoginWaitReason {
  return row.limitReason === "credit_balance" ? "credit_balance" : "usage_limit";
}

/**
 * The probe rule (as for pool accounts, spec 7.4): once a limit has passed
 * but no run has been served since, one run at a time tests the login.
 */
export function deviceLoginProbeApplies(row: Pick<DeviceLoginLimitRow, "exhaustedUntil" | "limitSource" | "limitStrikes">): boolean {
  return row.exhaustedUntil !== null && (row.limitSource === "estimated" || row.limitStrikes > 0);
}

/**
 * Claims the login's probe for a run. Succeeds when no probe is claimed, when
 * this run holds it already, or when the claiming run is no longer queued,
 * running or waiting. Leaves `updated_at` alone: a claim is not a state change
 * anybody waits for.
 */
export async function claimDeviceLoginProbe(db: ResourceWaitDb, environmentId: string, runId: string): Promise<boolean> {
  const rows = await db
    .update(deviceLoginLimits)
    .set({ limitProbeRunId: runId })
    .where(and(
      eq(deviceLoginLimits.environmentId, environmentId),
      or(
        isNull(deviceLoginLimits.limitProbeRunId),
        eq(deviceLoginLimits.limitProbeRunId, runId),
        sql`not exists (
          select 1 from ${heartbeatRuns}
          where ${heartbeatRuns.id} = ${deviceLoginLimits.limitProbeRunId}
            and ${heartbeatRuns.status} in (${sql.join(LIVE_RUN_STATUSES.map((status) => sql`${status}`), sql`, `)})
        )`,
      ),
    ))
    .returning({ environmentId: deviceLoginLimits.environmentId });
  return rows.length > 0;
}

/** Whether another live run holds the login's probe. */
export async function deviceLoginProbeHeldElsewhere(
  db: ResourceWaitDb,
  row: Pick<DeviceLoginLimitRow, "limitProbeRunId">,
  runId: string | null,
): Promise<boolean> {
  if (!row.limitProbeRunId || row.limitProbeRunId === runId) return false;
  const [holder] = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, row.limitProbeRunId), inArray(heartbeatRuns.status, [...LIVE_RUN_STATUSES])));
  return Boolean(holder);
}

/** The episode of the oldest run that still waits on this login's limit, if any. */
export async function oldestDeviceLoginWaiter(
  db: ResourceWaitDb,
  input: { companyId: string; environmentId: string },
): Promise<string | null> {
  const [first] = await db
    .select({ episodeId: resourceWaitEpisodes.id })
    .from(resourceWaitEpisodes)
    .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, resourceWaitEpisodes.currentRunId))
    .where(and(
      eq(resourceWaitEpisodes.companyId, input.companyId),
      eq(resourceWaitEpisodes.environmentId, input.environmentId),
      eq(resourceWaitEpisodes.kind, "device_login"),
      inArray(resourceWaitEpisodes.reason, [...LIMIT_REASONS]),
      isNull(resourceWaitEpisodes.resolvedAt),
      eq(heartbeatRuns.status, "scheduled_retry"),
    ))
    .orderBy(asc(resourceWaitEpisodes.since), asc(resourceWaitEpisodes.id))
    .limit(1);
  return first?.episodeId ?? null;
}

/** A wait for the device login's reset (the run's environment is its key). */
export function deviceLoginWaitDeferral(input: {
  reason: DeviceLoginWaitReason;
  environment: NamedRef;
  device?: NamedRef | null;
  resumeAt?: Date | null;
  resumeAtSource?: ResourceWaitResumeAtSource | null;
  epochs?: WakeEpochSnapshot | null;
  wasIssueAssignee?: boolean | null;
}): ResourceWaitDeferral {
  return new ResourceWaitDeferral({
    kind: "device_login",
    reason: input.reason,
    scope: "account",
    environmentId: input.environment.id,
    environmentName: input.environment.name,
    deviceId: input.device?.id ?? null,
    deviceName: input.device?.name ?? null,
    accountId: null,
    accountLabel: null,
    resumeAt: input.resumeAt ?? null,
    resumeAtSource: input.resumeAt ? input.resumeAtSource ?? "estimated" : null,
    message: null,
    retryAfter: null,
  }, { epochs: input.epochs, wasIssueAssignee: input.wasIssueAssignee });
}
