import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { type Db, environments, heartbeatRuns, resourceWaitEpisodes, resourceWaitNotices } from "@paperclipai/db";
import {
  isEnvironmentAvailableToCompany,
  isResourceWaitRetryReason,
  readResourceWaitContext,
  type ResourceStillUnavailableErrorDetails,
  type ScheduledRetryResourceWait,
} from "@paperclipai/shared";
import { conflict, tooManyRequests, type HttpError } from "../../errors.js";
import { environmentsForDevice } from "../execution-devices.js";
import { chainOfRun, resourceKeyOf } from "./episodes.js";
import type { ResourceWaitHold, RunWait } from "./hold.js";
import type { EnvironmentCheckResult, ResourceWaitSweep } from "./sweep.js";
import { RESOURCE_WAIT_TIMINGS, type HeartbeatRunRow } from "./types.js";
import { touchedAt, wakeResourceWaits } from "./wake.js";

/**
 * Fork: "Check now" (spec 7.5 and 12).
 *
 * - `checkRunNow`: retry-now on a waiting task (hook H15) or a comment on it.
 *   Target-scope environment waits get a forced availability check;
 *   admission-scope waits get one real attempt from "Check now" (a comment
 *   only re-evaluates: it never shortens the driver's backoff); account and
 *   slot waits are re-evaluated from the database. When the run may proceed
 *   it is made due now and the caller promotes it; otherwise the answer is
 *   `still_unavailable` with the fresh wait (heartbeat answers 409
 *   `resource_still_unavailable`). Once per minute per issue (429).
 * - `checkEnvironmentsNow`: the device page's "Check now": forced checks of
 *   the environments the company may use, in its context, then a wake of the
 *   company's waits on them. Once per minute per device.
 */

export type CheckNowSource = "retry_now" | "comment";

export type CheckRunNowResult =
  | { outcome: "not_waiting"; runId: string }
  | { outcome: "rate_limited"; runId: string; retryAfterMs: number }
  | { outcome: "proceed"; runId: string; checkedAt: string; check: EnvironmentCheckResult | null }
  | {
    outcome: "still_unavailable";
    runId: string;
    checkedAt: string;
    check: EnvironmentCheckResult | null;
    details: ResourceStillUnavailableErrorDetails;
  };

/**
 * Takes the once-per-window slot for `key` (an issue, a run or a device) in
 * the company. A sliding window over one `resource_wait_notices` row per key.
 */
export async function acquireCheckNowSlot(
  db: Db,
  input: { companyId: string; key: string; now?: Date; windowMs?: number },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const windowMs = input.windowMs ?? RESOURCE_WAIT_TIMINGS.checkNowWindowMs;
  const rows = await db
    .insert(resourceWaitNotices)
    .values({ companyId: input.companyId, noticeKey: `check-now:${input.key}`, createdAt: now })
    .onConflictDoUpdate({
      target: [resourceWaitNotices.companyId, resourceWaitNotices.noticeKey],
      set: { createdAt: now },
      setWhere: sql`${resourceWaitNotices.createdAt} <= ${new Date(now.getTime() - windowMs).toISOString()}::timestamptz`,
    })
    .returning({ noticeKey: resourceWaitNotices.noticeKey });
  return rows.length > 0;
}

/** The 409 heartbeat (and the retry-now route) answers when the resource is still down. */
export function resourceStillUnavailableError(details: ResourceStillUnavailableErrorDetails): HttpError {
  return conflict("The resource this task waits for is still unavailable.", details);
}

/** The 429 for a second "Check now" within the window. */
export function checkNowRateLimitedError(retryAfterMs: number = RESOURCE_WAIT_TIMINGS.checkNowWindowMs): HttpError {
  return tooManyRequests("Check now was used less than a minute ago.", { code: "check_now_rate_limited", retryAfterMs });
}

/**
 * `IssueScheduledRetry.resourceWait` for lane runs: the run's written-once
 * context plus its episode's start and immediate-notice times. Runs that are
 * not lane runs, or whose context is unreadable, are left out. A run that
 * joined another agent's episode for another resource gets no start or notice
 * time from it.
 */
export async function readScheduledRetryResourceWaits(
  db: Db,
  runs: ReadonlyArray<Pick<HeartbeatRunRow, "id" | "companyId" | "scheduledRetryReason" | "contextSnapshot">>,
): Promise<Map<string, ScheduledRetryResourceWait>> {
  const result = new Map<string, ScheduledRetryResourceWait>();
  const contexts = runs
    .filter((run) => isResourceWaitRetryReason(run.scheduledRetryReason))
    .map((run) => ({ run, context: readResourceWaitContext(run.contextSnapshot?.resourceWait) }))
    .filter((entry): entry is { run: (typeof runs)[number]; context: NonNullable<typeof entry.context> } => entry.context !== null);
  if (contexts.length === 0) return result;
  const episodes = await db
    .select({
      id: resourceWaitEpisodes.id,
      companyId: resourceWaitEpisodes.companyId,
      kind: resourceWaitEpisodes.kind,
      resourceKey: resourceWaitEpisodes.resourceKey,
      since: resourceWaitEpisodes.since,
      notifiedAt: resourceWaitEpisodes.notifiedAt,
    })
    .from(resourceWaitEpisodes)
    .where(inArray(resourceWaitEpisodes.id, [...new Set(contexts.map((entry) => entry.context.episodeId))]));
  const byId = new Map(episodes.map((episode) => [episode.id, episode]));
  for (const { run, context } of contexts) {
    const episode = byId.get(context.episodeId);
    const owned = episode && episode.companyId === run.companyId
      && episode.kind === context.kind && episode.resourceKey === resourceKeyOf(context)
      ? episode
      : null;
    result.set(run.id, {
      ...context,
      since: owned ? owned.since.toISOString() : null,
      notifiedAt: owned?.notifiedAt ? owned.notifiedAt.toISOString() : null,
    });
  }
  return result;
}

/**
 * For issue monitors (hook H13): the `scheduled_retry_at` of each issue's
 * execution run while that run waits in a resource-wait lane.
 */
export async function resourceWaitHoldsForIssues(
  db: Db,
  input: { companyId: string; issueIds: readonly string[] },
): Promise<Map<string, Date>> {
  const holds = new Map<string, Date>();
  if (input.issueIds.length === 0) return holds;
  const rows = await db
    .select({ issueId: resourceWaitEpisodes.issueId, scheduledRetryAt: heartbeatRuns.scheduledRetryAt })
    .from(resourceWaitEpisodes)
    .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, resourceWaitEpisodes.currentRunId))
    .where(and(
      eq(resourceWaitEpisodes.companyId, input.companyId),
      inArray(resourceWaitEpisodes.issueId, [...new Set(input.issueIds)]),
      isNull(resourceWaitEpisodes.resolvedAt),
      eq(heartbeatRuns.status, "scheduled_retry"),
    ));
  for (const row of rows) {
    if (row.issueId && row.scheduledRetryAt) holds.set(row.issueId, row.scheduledRetryAt);
  }
  return holds;
}

export function createCheckNow(runtime: {
  db: Db;
  clock: () => Date;
  hold: ResourceWaitHold;
  sweep: ResourceWaitSweep;
}) {
  const { db } = runtime;

  /** Due now; an episode the run owns drops its backoff, so the next hold agrees. */
  async function makeDue(runId: string, wait: RunWait | null, now: Date): Promise<void> {
    await db
      .update(heartbeatRuns)
      .set({ scheduledRetryAt: sql`least(${heartbeatRuns.scheduledRetryAt}, ${now.toISOString()}::timestamptz)`, updatedAt: touchedAt(now) })
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "scheduled_retry")));
    if (wait?.owned) {
      await db.update(resourceWaitEpisodes).set({ nextCheckAt: null, updatedAt: now })
        .where(and(eq(resourceWaitEpisodes.id, wait.view.id), eq(resourceWaitEpisodes.currentRunId, runId)));
    }
  }

  async function checkRunNow(input: { runId: string; companyId?: string; source?: CheckNowSource; now?: Date }): Promise<CheckRunNowResult> {
    const now = input.now ?? runtime.clock();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId));
    if (!run || (input.companyId && run.companyId !== input.companyId)
      || run.status !== "scheduled_retry" || !isResourceWaitRetryReason(run.scheduledRetryReason)) {
      return { outcome: "not_waiting", runId: input.runId };
    }
    const { issueId } = chainOfRun(run);
    const slot = await acquireCheckNowSlot(db, { companyId: run.companyId, key: issueId ? `issue:${issueId}` : `run:${run.id}`, now });
    if (!slot) return { outcome: "rate_limited", runId: run.id, retryAfterMs: RESOURCE_WAIT_TIMINGS.checkNowWindowMs };

    // The hold's own view of the wait: the run's episode, or its own context.
    const wait = await runtime.hold.waitOf(run);
    const view = wait?.view ?? null;
    const checkedAt = now.toISOString();
    let check: EnvironmentCheckResult | null = null;
    if (view && view.kind === "environment" && view.scope === "target" && view.environmentId) {
      const [environment] = await db.select().from(environments).where(eq(environments.id, view.environmentId));
      if (environment) {
        check = await runtime.sweep.checkEnvironment(environment, { companyId: run.companyId, now });
        // Nothing could tell: the attempt itself is the check.
        if (check.state === "unknown") {
          await makeDue(run.id, wait, now);
          return { outcome: "proceed", runId: run.id, checkedAt, check };
        }
      }
    }
    // "Check now" spends one real attempt on a driver's refusal; a comment
    // only re-evaluates, so it never shortens the backoff.
    const attemptNow = input.source !== "comment" && view?.kind === "environment" && view.scope === "admission";
    const decision = attemptNow
      ? { proceed: true as const, reason: "check_now_attempt" }
      : await runtime.hold.decide(run, wait, now);
    if (decision.proceed) {
      await makeDue(run.id, wait, now);
      return { outcome: "proceed", runId: run.id, checkedAt, check };
    }
    const fresh = await readScheduledRetryResourceWaits(db, [run]);
    return {
      outcome: "still_unavailable",
      runId: run.id,
      checkedAt,
      check,
      details: { code: "resource_still_unavailable", resourceWait: fresh.get(run.id) ?? null, checkedAt },
    };
  }

  /**
   * Forced checks of a company's environments (the device page), then a wake
   * of that company's environment waits on them. The caller passes only
   * environments available to the company and enforces visibility; the
   * once-per-minute device slot is `acquireCheckNowSlot(db, { companyId, key: "device:<id>" })`.
   */
  async function checkEnvironmentsNow(input: { companyId: string; environmentIds: readonly string[]; now?: Date }) {
    const now = input.now ?? runtime.clock();
    const ids = [...new Set(input.environmentIds)];
    const rows = ids.length > 0 ? await db.select().from(environments).where(inArray(environments.id, ids)) : [];
    const checks = await runtime.sweep.checkEnvironments(rows, () => input.companyId, now);
    const woken = rows.length > 0
      ? await wakeResourceWaits(db, { environmentIds: rows.map((row) => row.id), companyId: input.companyId }, { now })
      : { runIds: [], agentIds: [], companyIds: [] };
    return {
      checkedAt: now.toISOString(),
      checks,
      woken: woken.runIds.length + checks.reduce((sum, check) => sum + check.woken, 0),
      wokenAgentIds: woken.agentIds,
    };
  }

  /**
   * "Check now" on a device page: the device's environments that the company
   * may use, checked in its context, then its waits on them woken.
   */
  async function checkDeviceNow(input: { companyId: string; deviceId: string; now?: Date }) {
    const environmentIds = (await environmentsForDevice(db, input.deviceId))
      .filter(({ environment }) => isEnvironmentAvailableToCompany(environment, input.companyId))
      .map(({ environment }) => environment.id);
    return checkEnvironmentsNow({ companyId: input.companyId, environmentIds, now: input.now });
  }

  return { checkRunNow, checkEnvironmentsNow, checkDeviceNow };
}

export type ResourceWaitCheckNow = ReturnType<typeof createCheckNow>;
