import { and, asc, eq, gt, inArray, notInArray, sql } from "drizzle-orm";
import { type Db, heartbeatRuns, resourceWaitEpisodes } from "@paperclipai/db";
import { RESOURCE_WAIT_RETRY_REASONS, readResourceWaitContext, type ResourceWaitContext } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { environmentAvailabilityService } from "../environment-availability.js";
import { executionRetryAttemptCount } from "../execution-recovery-attempt.js";
import type { EpisodeEndedHandler } from "./deferral.js";
import { adoptEpisode, sameResource } from "./episodes.js";
import type { ResourceWaitNotifier } from "./notify.js";
import { RESOURCE_WAIT_TIMINGS, type HeartbeatRunRow, type ResourceWaitDeps, type ResourceWaitEpisodeRow } from "./types.js";
import { touchedAt } from "./wake.js";

/**
 * Fork: what follows when a wait episode ends (resolved, abandoned,
 * superseded or refused).
 *
 * - The environment's registry row goes when that was its last wait (retired
 *   rows stay).
 * - The issue's other waiting runs that own no episode (an agent a comment
 *   mentioned waits next to the assignee's wait) are settled at once instead
 *   of at their own next check, which an admission backoff can put an hour
 *   out:
 *   - one the issue gate now suppresses (the task was closed, blocked or
 *     reassigned) is made due, so run-dispatch cancels it;
 *   - one waiting for the same resource follows at once when the episode
 *     resolved (the resource is back);
 *   - the oldest one waiting for another resource takes the issue's wait over
 *     with an episode of its own (it had none, so nobody heard of it): its
 *     start is logged and its immediate notice goes out. The others stay with
 *     it, as they stayed with the episode that ended.
 */

const SETTLE_LIMIT = 50;

export interface EpisodeEndRuntime {
  db: Db;
  deps: Pick<ResourceWaitDeps, "evaluateScheduledRetryGate">;
  notifier: ResourceWaitNotifier;
  clock: () => Date;
}

export function createEpisodeEnd(runtime: EpisodeEndRuntime): EpisodeEndedHandler {
  const { db, deps, notifier } = runtime;
  const availability = environmentAvailabilityService(db);

  /** Due now, unless it is due already (a hold pass may hold its observed row). */
  async function makeDue(runId: string, now: Date): Promise<void> {
    await db
      .update(heartbeatRuns)
      .set({ scheduledRetryAt: now, updatedAt: touchedAt(now) })
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "scheduled_retry"), gt(heartbeatRuns.scheduledRetryAt, now)));
  }

  /** An adopted wait's gate runs on its owner's cadence again (a joined admission wait may be held an hour). */
  async function capDue(runId: string, now: Date): Promise<void> {
    const latest = new Date(now.getTime() + RESOURCE_WAIT_TIMINGS.gateIntervalMs);
    await db
      .update(heartbeatRuns)
      .set({ scheduledRetryAt: latest, updatedAt: touchedAt(now) })
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "scheduled_retry"), gt(heartbeatRuns.scheduledRetryAt, latest)));
  }

  /** The waiter takes the issue's wait over, unless the issue has another open wait already. */
  async function adopt(episode: ResourceWaitEpisodeRow, waiter: HeartbeatRunRow, context: ResourceWaitContext, now: Date): Promise<void> {
    const admission = context.kind === "environment" && context.scope === "admission";
    const adopted = await adoptEpisode(db, {
      run: waiter,
      context,
      since: waiter.createdAt,
      checks: executionRetryAttemptCount(waiter, waiter.scheduledRetryReason ?? "") - 1,
      // A joined admission wait's due time is its own backoff: the episode keeps it now.
      nextCheckAt: admission ? waiter.scheduledRetryAt : null,
      now,
    });
    if (!adopted) return;
    await capDue(waiter.id, now);
    logger.info({ episodeId: adopted.id, endedEpisodeId: episode.id, runId: waiter.id }, "a joined resource wait took over the issue's wait");
    await notifier.logStarted(adopted, waiter.id, now).catch((error) => {
      logger.warn({ err: error, episodeId: adopted.id }, "failed to log resource_wait.started");
    });
    await notifier.notifyImmediate(adopted, now).catch((error) => {
      logger.warn({ err: error, episodeId: adopted.id }, "resource wait immediate notice failed; the sweep retries it");
    });
  }

  async function settleWaiters(episode: ResourceWaitEpisodeRow, issueId: string, endingRunIds: readonly string[], now: Date): Promise<void> {
    const exclude = [...new Set([...(episode.currentRunId ? [episode.currentRunId] : []), ...endingRunIds])];
    const waiters = await db
      .select()
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, episode.companyId),
        eq(heartbeatRuns.status, "scheduled_retry"),
        inArray(heartbeatRuns.scheduledRetryReason, [...RESOURCE_WAIT_RETRY_REASONS]),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
        exclude.length > 0 ? notInArray(heartbeatRuns.id, exclude) : undefined,
        // A run that owns an open episode keeps its own cadence.
        sql`not exists (
          select 1 from ${resourceWaitEpisodes}
          where ${resourceWaitEpisodes.currentRunId} = ${heartbeatRuns.id} and ${resourceWaitEpisodes.resolvedAt} is null
        )`,
      ))
      .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
      .limit(SETTLE_LIMIT);
    let adoptionTried = false;
    for (const waiter of waiters) {
      const context = readResourceWaitContext(waiter.contextSnapshot?.resourceWait);
      if (!context) continue;
      try {
        const gate = await deps.evaluateScheduledRetryGate({
          runId: waiter.id,
          companyId: waiter.companyId,
          retryReasonOverride: waiter.scheduledRetryReason ?? "",
          now,
        });
        if (!gate.allowed) {
          await makeDue(waiter.id, now);
          continue;
        }
        if (sameResource(episode, context)) {
          if (episode.resolution === "resolved") await makeDue(waiter.id, now);
          continue;
        }
        // One wait per issue: only the oldest waiter for another resource tries.
        if (!adoptionTried) {
          adoptionTried = true;
          await adopt(episode, waiter, context, now);
        }
      } catch (error) {
        logger.warn({ err: error, runId: waiter.id, episodeId: episode.id }, "failed to settle a waiting run after its episode ended");
      }
    }
  }

  return async function onEpisodeEnded(episode, options = {}) {
    if (episode.kind === "environment" && episode.environmentId) {
      await availability.deleteIfNoWaits(episode.environmentId).catch((error) => {
        logger.warn({ err: error, environmentId: episode.environmentId }, "failed to clean up an environment availability row");
      });
    }
    // Runs without an issue never share a chain with another agent.
    if (!episode.issueId) return;
    await settleWaiters(episode, episode.issueId, options.endingRunIds ?? [], options.now ?? runtime.clock()).catch((error) => {
      logger.warn({ err: error, episodeId: episode.id }, "failed to settle the waits of an ended episode");
    });
  };
}
