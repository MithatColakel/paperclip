import { and, eq, gt, sql } from "drizzle-orm";
import { type Db, heartbeatRuns, resourceWaitEpisodes } from "@paperclipai/db";
import {
  RESOURCE_WAIT_ERROR_CODE_BY_KIND,
  RESOURCE_WAIT_LANE_BY_KIND,
  RESOURCE_WAIT_RECOVERY_KIND,
  RESOURCE_WAIT_WAKE_REASONS,
  buildResourceWaitContext,
  type ResourceWaitContext,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { isNonAssigneeWorkspaceBusyRetry } from "../../modules/run-dispatch/index.js";
import { environmentAvailabilityService, type EnvironmentAvailabilityRow } from "../environment-availability.js";
import { executionFailureRetryCount, executionRetryAttemptCount } from "../execution-recovery-attempt.js";
import { wakeEpochsMoved } from "./epochs.js";
import { touchedAt } from "./wake.js";
import {
  chainOfRun,
  handOverOrAbandon,
  openEpisode,
  restoreEpisodeCurrentRun,
  sameResource,
  setEpisodeCurrentRun,
  type OpenEpisodeResult,
} from "./episodes.js";
import { resourceWaitReasonLabel, type ResourceWaitNotifier } from "./notify.js";
import {
  RESOURCE_WAIT_TIMINGS,
  type AgentRow,
  type HeartbeatRunRow,
  type ResourceWaitDeferral,
  type ResourceWaitDeps,
  type ResourceWaitEpisodeRow,
  type ResourceWaitTarget,
  type WakeEpochSnapshot,
} from "./types.js";

/**
 * Fork: the deferral finalizer (spec 7.3, hook H5) and the successor
 * scheduler it shares with mid-run account waits (spec 4.6).
 *
 * A deferred run is cancelled as an expected cancellation with no provider
 * work, so it stays out of reconciliation, Sentry, the daily run cap and the
 * failure budget. Its successor is a `scheduled_retry` run in the wait's lane
 * that holds the issue lock; `holdDueWaits` keeps it waiting until the
 * resource is back.
 */

/** Saved on lane successors; `historicalFailureCount` keeps the failures from before the wait. */
export const FAILURE_RETRIES_BEFORE_RESOURCE_WAIT_KEY = "failureRetriesBeforeResourceWait";

export interface DeferralRuntime {
  db: Db;
  deps: ResourceWaitDeps;
  notifier: ResourceWaitNotifier;
  clock: () => Date;
  random: () => number;
  /** Ends bookkeeping of a closed episode (registry cleanup, the chain's other waits). */
  onEpisodeEnded: EpisodeEndedHandler;
}

/**
 * Runs after an episode ended: registry cleanup, and the chain's other
 * waiting runs that named it. `endingRunIds` are runs that end with it (the
 * caller already handled them); `now` is the caller's clock (a hold pass).
 */
export type EpisodeEndedHandler = (
  episode: ResourceWaitEpisodeRow,
  options?: { endingRunIds?: readonly string[]; now?: Date },
) => Promise<void>;

/** A per-run spread of 0..maxMs, stable for one run id (`jitter(runId)`). */
export function resourceWaitJitterMs(runId: string, maxMs: number = RESOURCE_WAIT_TIMINGS.limitJitterMaxMs): number {
  let hash = 2166136261;
  for (let index = 0; index < runId.length; index += 1) {
    hash ^= runId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.floor(((hash >>> 0) / 0xffffffff) * Math.max(0, maxMs));
}

/** `base` ±`jitter` (fraction). */
export function jittered(baseMs: number, random: () => number, jitter: number = RESOURCE_WAIT_TIMINGS.recheckJitter): number {
  const fraction = Math.min(Math.max(random(), 0), 1) * 2 - 1;
  return Math.round(baseMs * (1 + fraction * jitter));
}

function doubling(baseMs: number, maxMs: number, attempts: number): number {
  return Math.min(baseMs * 2 ** Math.min(Math.max(0, attempts), 20), maxMs);
}

interface WaitDelayInput {
  wait: ResourceWaitTarget;
  episode: Pick<ResourceWaitEpisodeRow, "checks">;
  runId: string;
  now: Date;
  random: () => number;
}

/**
 * The wait before a new successor's next real attempt or check (spec 7.1),
 * uncapped. Admission backoffs double with `episode.checks` (consecutive
 * deferrals for the same reason): every 5 min doubling to 60 min for
 * not_allowed, not_serving, stopped and plugin_upgrade_pending, 60 s doubling
 * to 10 min for `other`, or the driver's `retryAfter`.
 */
export function waitDelayMs(input: WaitDelayInput): number {
  const { wait, now } = input;
  const timings = RESOURCE_WAIT_TIMINGS;
  const untilRetryAfter = wait.retryAfter ? wait.retryAfter.getTime() - now.getTime() : null;
  let delay: number;
  if (wait.kind === "environment" && wait.scope === "target") {
    // The registry decides; the sweep checks the row right away (it is due now).
    delay = timings.minHoldMs;
  } else if (wait.kind === "environment") {
    switch (wait.reason) {
      case "busy":
        delay = untilRetryAfter ?? timings.busyMs;
        break;
      case "throttled":
        delay = untilRetryAfter ?? Math.round(timings.throttledMinMs + (timings.throttledMaxMs - timings.throttledMinMs) * input.random());
        break;
      case "restarting":
        delay = untilRetryAfter ?? timings.restartingMs;
        break;
      case "other":
        delay = untilRetryAfter ?? doubling(timings.admissionOtherBaseMs, timings.admissionOtherMaxMs, input.episode.checks);
        break;
      default:
        // not_allowed, not_serving, stopped, plugin_upgrade_pending: a plugin wake usually ends these first.
        delay = untilRetryAfter ?? doubling(timings.admissionSlowBaseMs, timings.admissionSlowMaxMs, input.episode.checks);
    }
  } else if (wait.kind === "ai_account" && (wait.reason === "usage_limit" || wait.reason === "credit_balance")) {
    delay = wait.resumeAt ? wait.resumeAt.getTime() - now.getTime() : jittered(timings.recheckMs, input.random);
  } else if (wait.kind === "ai_account" && wait.reason === "auth_unconfirmed") {
    delay = timings.authUnconfirmedMs;
  } else {
    delay = jittered(timings.recheckMs, input.random);
  }
  return Math.max(1_000, delay);
}

/**
 * How long a new successor waits before its first hold check: `waitDelayMs`
 * capped at the issue-gate interval, so the gate still sees a closed or
 * reassigned issue within five minutes. An admission wait's uncapped next
 * attempt is kept in its episode (`next_check_at`) and the hold honours it.
 */
export function firstHoldMs(input: WaitDelayInput): number {
  return Math.min(waitDelayMs(input), RESOURCE_WAIT_TIMINGS.gateIntervalMs);
}

/** An environment wait the driver refused for this run only: it backs off in real attempts. */
export function isAdmissionWait(wait: Pick<ResourceWaitTarget, "kind" | "scope">): boolean {
  return wait.kind === "environment" && wait.scope === "admission";
}

/**
 * Fills derived fields: an `auth_unconfirmed` wait is run-scoped and ends 10
 * minutes after the deferral (the account itself is unchanged, so only the
 * episode's `resume_at` records the deadline).
 */
export function normalizeWait(wait: ResourceWaitTarget, now: Date): ResourceWaitTarget {
  if (wait.kind === "ai_account" && wait.reason === "auth_unconfirmed" && !wait.resumeAt) {
    return { ...wait, resumeAt: new Date(now.getTime() + RESOURCE_WAIT_TIMINGS.authUnconfirmedMs), resumeAtSource: "check" };
  }
  return wait;
}

/** The successor's `contextSnapshot.resourceWait`, written once. */
export function resourceWaitContextFor(episode: Pick<ResourceWaitEpisodeRow, "id">, wait: ResourceWaitTarget): ResourceWaitContext {
  return buildResourceWaitContext({
    episodeId: episode.id,
    kind: wait.kind,
    reason: wait.reason,
    scope: wait.scope,
    environmentId: wait.environmentId,
    environmentName: wait.environmentName,
    deviceId: wait.deviceId,
    deviceName: wait.deviceName,
    accountId: wait.accountId,
    accountLabel: wait.accountLabel,
    resumeAt: wait.resumeAt ? wait.resumeAt.toISOString() : null,
    resumeAtSource: wait.resumeAtSource,
    message: wait.message,
  });
}

/** The plain-text summary of a wait, for the cancelled run's `error` and its events. */
export function describeWaitShort(wait: ResourceWaitTarget): string {
  const device = wait.deviceName ?? wait.environmentName ?? "the device";
  switch (wait.kind) {
    case "environment":
      return `Waiting for device ${device} (${resourceWaitReasonLabel(wait.reason)})`;
    case "ai_account":
      return wait.accountLabel
        ? `Waiting for Claude account ${wait.accountLabel} (${resourceWaitReasonLabel(wait.reason)})`
        : `Waiting for a Claude account (${resourceWaitReasonLabel(wait.reason)})`;
    case "device_slots":
      return `Waiting for an account slot on ${device}`;
  }
}

function waitingEventMessage(wait: ResourceWaitTarget): string {
  switch (wait.kind) {
    case "environment":
      return `${describeWaitShort(wait)}. This task starts automatically when it is available.`;
    case "ai_account":
      return `${describeWaitShort(wait)}. This task starts automatically when the account is available; Paperclip never moves it to another account.`;
    case "device_slots":
      return `${describeWaitShort(wait)}. This task starts automatically when one is free.`;
  }
}

export interface ScheduleResourceWaitInput {
  /** The deferred (cancelled) run, or a run that ended on a limit. */
  run: HeartbeatRunRow;
  wait: ResourceWaitTarget;
  /** Epochs read before the attempt (lost-wake guard). */
  epochs?: WakeEpochSnapshot | null;
  agent?: AgentRow | null;
  /** The episode the caller already opened or reused. */
  episode?: OpenEpisodeResult;
  /**
   * The run executed as the issue's assignee. Defaults to the authority its
   * admission recorded (`deferredWhileAssignee`). A non-assignee's wait never
   * takes the chain's episode from another agent's live waiting run.
   */
  wasIssueAssignee?: boolean | null;
  /** Release the issue lock when no successor could be scheduled (default true). */
  releaseIfUnscheduled?: boolean;
  now?: Date;
}

export interface ScheduleResourceWaitResult {
  outcome: "scheduled" | "not_scheduled";
  episodeId: string;
  successorRunId: string | null;
  /** The lost-wake guard (or an earlier wake) made the successor due now. */
  dueNow: boolean;
  /** The successor joined another agent's episode; it waits from its own context. */
  shared: boolean;
  context: ResourceWaitContext;
  reason?: string;
}

/**
 * Whether the deferred run executed as the issue's assignee, from the
 * authority the locked admission gate recorded (a non-assignee comment wake,
 * or a non-assignee wait it continues), never from the issue's mutable
 * assignee observed later, as heartbeat's subscription wait does too.
 */
export function deferredWhileAssignee(run: Pick<HeartbeatRunRow, "runnerProfileJson" | "scheduledRetryReason" | "contextSnapshot">): boolean {
  if (run.runnerProfileJson?.aiConnectionNonAssigneeCommentWake === true) return false;
  return !isNonAssigneeWorkspaceBusyRetry(run.scheduledRetryReason, run.contextSnapshot ?? {});
}

export function createDeferral(runtime: DeferralRuntime) {
  const { db, deps, notifier } = runtime;
  const availability = environmentAvailabilityService(db);

  async function isLiveRun(runId: string): Promise<boolean> {
    const [row] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    return Boolean(row && ["scheduled_retry", "queued", "running"].includes(row.status));
  }

  /**
   * The deferring run got no successor: the episode it opened, reused or
   * took over goes back to the live run it was taken from, else to another
   * run of the chain that waits for the same resource, else it is abandoned.
   * An episode another live run kept (a joined wait) is left alone.
   */
  async function releaseEpisode(opened: OpenEpisodeResult, runId: string, now: Date): Promise<void> {
    const episode = opened.episode;
    if (episode.currentRunId && episode.currentRunId !== runId) {
      if (await isLiveRun(episode.currentRunId)) return;
    }
    const previous = opened.previousCurrentRunId;
    if (episode.currentRunId === runId && previous && previous !== runId && await isLiveRun(previous)) {
      await restoreEpisodeCurrentRun(db, episode.id, runId, previous, now);
      return;
    }
    const { abandoned } = await handOverOrAbandon(db, episode, [runId], now);
    if (abandoned) await runtime.onEpisodeEnded(abandoned);
  }

  /**
   * Records on the run itself whether it ran as the issue's assignee, unless
   * its context already says so. heartbeat's gate before scheduling (H7) reads
   * the run's row, its lock recheck and the successor (which copies the
   * context) read the object passed on: a non-assignee's wait that started
   * after the run ended (a limit) is then neither "reassigned" nor holding a
   * lock it never had.
   */
  async function recordAuthority(run: HeartbeatRunRow, wasIssueAssignee: boolean): Promise<HeartbeatRunRow> {
    const recorded = run.contextSnapshot?.resourceWaitDeferredWhileAssignee !== false;
    if (!chainOfRun(run).issueId || recorded === wasIssueAssignee) return run;
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || jsonb_build_object('resourceWaitDeferredWhileAssignee', ${wasIssueAssignee}::boolean)`,
      })
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId)));
    return { ...run, contextSnapshot: { ...(run.contextSnapshot ?? {}), resourceWaitDeferredWhileAssignee: wasIssueAssignee } };
  }

  /**
   * Steps 3–8 of spec 7.3 for a run that already ended: open or reuse the
   * chain's episode, schedule the lane successor with `contextSnapshot.resourceWait`,
   * guard against a lost wake, write the waiting event, log
   * `resource_wait.started` on a new episode and send an immediate notice.
   * Without a successor it releases the issue lock (unless told not to) and
   * abandons the episode.
   *
   * When another agent's live run waits in the chain's episode (`shared`),
   * the successor joins it: it never becomes the episode's current run,
   * writes no bookkeeping and sends no notice; the hold decides it from its
   * own context.
   */
  async function scheduleResourceWait(input: ScheduleResourceWaitInput): Promise<ScheduleResourceWaitResult> {
    const now = input.now ?? runtime.clock();
    const wait = normalizeWait(input.wait, now);
    const wasIssueAssignee = input.wasIssueAssignee ?? deferredWhileAssignee(input.run);
    const run = await recordAuthority(input.run, wasIssueAssignee);
    const opened = input.episode ?? await openEpisode(db, {
      chain: chainOfRun(run),
      wait,
      now,
      run: { id: run.id, agentId: run.agentId, wasIssueAssignee },
    });
    const episode = opened.episode;
    let shared = opened.shared;
    if (opened.superseded) await runtime.onEpisodeEnded(opened.superseded).catch(() => undefined);
    const context = resourceWaitContextFor(episode, wait);
    const lane = RESOURCE_WAIT_LANE_BY_KIND[wait.kind];
    // A run that joined another agent's episode for another resource owns no
    // bookkeeping: its backoff counts its own deferrals in the lane, and an
    // admission backoff lives in its due time (a wake still makes it due). It
    // ran outside assignee-ship, so it holds no issue lock while it waits.
    const rider = shared && !sameResource(episode, wait);
    const checks = rider ? executionRetryAttemptCount(run, lane) : episode.checks;
    const delayMs = waitDelayMs({ wait, episode: { checks }, runId: run.id, now, random: runtime.random });
    const firstHoldDelayMs = rider && isAdmissionWait(wait) ? delayMs : Math.min(delayMs, RESOURCE_WAIT_TIMINGS.gateIntervalMs);

    let registry: EnvironmentAvailabilityRow | null = null;
    if (wait.kind === "environment" && wait.environmentId) {
      registry = await availability.get(wait.environmentId);
      // A new waiter on an unavailable row gets a prompt check. This runs
      // between the two epoch reads, so it must not move the epoch itself.
      if (registry?.state === "unavailable") {
        await availability.setDueNow([wait.environmentId], { now, bumpEpoch: false });
      }
    }

    const agent = input.agent ?? await deps.getAgent(run.agentId).catch(() => null);
    let successor: HeartbeatRunRow | null = null;
    let reason: string | undefined;
    if (agent) {
      try {
        const result = await deps.scheduleBoundedRetryForRun(run, agent, {
          now,
          retryReason: lane,
          wakeReason: RESOURCE_WAIT_WAKE_REASONS[lane],
          // Always admit: a wait is bounded by its resource, not by attempts.
          maxAttempts: executionRetryAttemptCount(run, lane) + 1,
          // The first hold check: capped by the gate interval, except a rider's admission backoff.
          delayMs: firstHoldDelayMs,
          contextPatch: {
            resourceWait: context,
            [FAILURE_RETRIES_BEFORE_RESOURCE_WAIT_KEY]: executionFailureRetryCount(run),
          },
        });
        if (result.outcome === "scheduled") successor = result.run;
        else reason = result.outcome === "not_scheduled" ? result.reason : "retry_exhausted";
      } catch (error) {
        logger.error({ err: error, runId: run.id }, "failed to schedule the resource-wait successor");
        reason = "schedule_failed";
      }
    } else {
      reason = "agent_not_found";
    }

    if (!successor) {
      await deps.appendRunEvent(run, {
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        message: `${describeWaitShort(wait)}, but no waiting run could be scheduled; releasing the task for other runs.`,
        payload: { resourceWait: context, retryScheduled: false, reason: reason ?? null },
      }).catch(() => undefined);
      if (input.releaseIfUnscheduled !== false) {
        await deps.releaseIssueExecutionAndPromote(run).catch((error) => {
          logger.error({ err: error, runId: run.id }, "failed to release issue execution after a resource-wait deferral");
        });
      }
      await releaseEpisode(opened, run.id, now).catch(() => undefined);
      return { outcome: "not_scheduled", episodeId: episode.id, successorRunId: null, dueNow: false, shared, context, reason };
    }

    // An admission wait's next real attempt may lie beyond the first hold
    // (which the gate interval caps): the episode keeps it for the hold.
    let admission = !shared && isAdmissionWait(wait);
    if (!shared) {
      const owns = await setEpisodeCurrentRun(db, episode.id, successor.id, now, admission
        ? { nextCheckAt: new Date(now.getTime() + delayMs) }
        : {});
      // The episode ended meanwhile (another deferral superseded it): the
      // successor waits from its own context, like a joined wait.
      if (!owns) {
        shared = true;
        admission = false;
      }
    }
    // Step 5: a report, check or wake between the attempt and the successor
    // insert would otherwise be lost; the successor becomes due now.
    let dueNow = Boolean(successor.scheduledRetryAt && successor.scheduledRetryAt.getTime() <= now.getTime());
    if (!dueNow && input.epochs && await wakeEpochsMoved(db, input.epochs)) {
      const rows = await db
        .update(heartbeatRuns)
        .set({ scheduledRetryAt: now, updatedAt: touchedAt(now) })
        .where(and(eq(heartbeatRuns.id, successor.id), eq(heartbeatRuns.status, "scheduled_retry"), gt(heartbeatRuns.scheduledRetryAt, now)))
        .returning({ id: heartbeatRuns.id });
      dueNow = rows.length > 0;
      // The wake also ends an admission wait's backoff: one real attempt now.
      if (dueNow && admission) {
        await db.update(resourceWaitEpisodes).set({ nextCheckAt: null, updatedAt: now })
          .where(and(eq(resourceWaitEpisodes.id, episode.id), eq(resourceWaitEpisodes.currentRunId, successor.id)));
      }
    }

    await deps.appendRunEvent(run, {
      eventType: "lifecycle",
      stream: "system",
      level: "info",
      message: waitingEventMessage(wait),
      payload: { resourceWait: context, retryRunId: successor.id, retryScheduled: true },
    }).catch(() => undefined);

    if (!shared) {
      if (opened.created) await notifier.logStarted(episode, run.id, now).catch((error) => {
        logger.warn({ err: error, episodeId: episode.id }, "failed to log resource_wait.started");
      });
      const current = { ...episode, currentRunId: successor.id };
      await notifier.notifyImmediate(current, now).catch((error) => {
        logger.warn({ err: error, episodeId: episode.id }, "resource wait immediate notice failed; the sweep retries it");
      });
    }
    return { outcome: "scheduled", episodeId: episode.id, successorRunId: successor.id, dueNow, shared, context };
  }

  /**
   * Hook H5 (spec 7.3): finalize a run that threw a `ResourceWaitDeferral`.
   * A run that already left `running` is left to the path that moved it.
   */
  async function finalizeDeferral(
    run: HeartbeatRunRow,
    deferral: ResourceWaitDeferral,
    opts: { wasIssueAssignee?: boolean } = {},
  ): Promise<ScheduleResourceWaitResult | { outcome: "skipped"; episodeId: string | null }> {
    const now = runtime.clock();
    const wait = normalizeWait(deferral.wait, now);
    const [live] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    if (live?.status !== "running") {
      logger.info({ runId: run.id, status: live?.status ?? null }, "skipping resource-wait deferral because the run already left running state");
      return { outcome: "skipped", episodeId: null };
    }
    const wasIssueAssignee = opts.wasIssueAssignee ?? deferral.wasIssueAssignee ?? deferredWhileAssignee(run);
    const opened = await openEpisode(db, {
      chain: chainOfRun(run),
      wait,
      now,
      run: { id: run.id, agentId: run.agentId, wasIssueAssignee },
    });
    const context = resourceWaitContextFor(opened.episode, wait);
    const summary = describeWaitShort(wait);

    // Step 1: an expected cancellation with no provider work.
    const cancelWrite = await deps.setRunStatusIfRunning(run.id, "cancelled", {
      error: summary,
      errorCode: RESOURCE_WAIT_ERROR_CODE_BY_KIND[wait.kind],
      finishedAt: now,
      resultJson: {
        executionRecovery: { kind: RESOURCE_WAIT_RECOVERY_KIND, providerWorkStarted: false },
        resourceWait: context,
        cancellation: {
          source: "control_plane",
          expected: true,
          initiator: { type: "system" },
          reason: summary,
          recordedAt: now.toISOString(),
        },
      },
      contextSnapshot: {
        ...(run.contextSnapshot ?? {}),
        resourceWaitDeferredWhileAssignee: wasIssueAssignee,
      },
    });
    if (!cancelWrite.updated) {
      logger.info({ runId: run.id }, "skipping resource-wait deferral because the run left running state before it was cancelled");
      const previous = opened.previousCurrentRunId;
      if (opened.superseded) await runtime.onEpisodeEnded(opened.superseded).catch(() => undefined);
      if (opened.created) await releaseEpisode(opened, run.id, now).catch(() => undefined);
      else if (!opened.shared && previous && previous !== run.id) {
        // The reuse made this run current: the run it took the episode from keeps it.
        await restoreEpisodeCurrentRun(db, opened.episode.id, run.id, previous, now).catch(() => undefined);
      }
      return { outcome: "skipped", episodeId: opened.episode.id };
    }
    // Step 2.
    await deps.setWakeupStatus(run.wakeupRequestId, "cancelled", { finishedAt: now, error: summary }).catch(() => undefined);
    const cancelledRun = cancelWrite.run ?? await deps.getRun(run.id).catch(() => null) ?? { ...run, status: "cancelled" };
    let result: ScheduleResourceWaitResult;
    try {
      // Steps 3–8.
      result = await scheduleResourceWait({ run: cancelledRun, wait, epochs: deferral.epochs, episode: opened, wasIssueAssignee, now });
    } finally {
      // Step 9: the agent stays idle.
      await deps.finalizeAgentStatus(run.agentId, "cancelled", null, {
        wasFirstHeartbeat: run.contextSnapshot?.timerClaimWasFirstHeartbeat === true ? true : undefined,
      }).catch(() => undefined);
    }
    return result;
  }

  return { finalizeDeferral, scheduleResourceWait };
}

export type ResourceWaitDeferralService = ReturnType<typeof createDeferral>;
