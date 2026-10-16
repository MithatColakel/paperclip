import { and, asc, eq, isNull, notInArray, sql, type SQL } from "drizzle-orm";
import { type Db, heartbeatRuns, resourceWaitEpisodes } from "@paperclipai/db";
import {
  RESOURCE_WAIT_LANE_BY_KIND,
  readResourceWaitContext,
  type ResourceWaitContext,
  type ResourceWaitResolution,
} from "@paperclipai/shared";
import type { HeartbeatRunRow, ResourceWaitDb, ResourceWaitEpisodeRow, ResourceWaitTarget } from "./types.js";

/**
 * Fork: wait episodes (`resource_wait_episodes`, spec 3.6). A chain (an issue,
 * or an agent for runs without an issue) has at most one open episode. A
 * deferral for the same `(kind, resource_key)` reuses it, so its `since` and
 * notice times carry over every replacement run; a deferral for another
 * resource closes it as `superseded` and opens a new one.
 *
 * Two agents can wait on one issue at once (the assignee, and an agent a
 * comment mentioned). The episode belongs to its current run: a deferral of
 * another agent's run never takes it from a live waiting run, unless that
 * deferral ran as the issue's assignee. The other run joins it unchanged
 * (`shared`) and waits from its own `contextSnapshot.resourceWait`.
 *
 * Environment, device, account and current-run ids have no foreign keys:
 * readers tolerate ids that no longer resolve.
 */

const LIVE_RUN_STATUSES = ["scheduled_retry", "queued", "running"] as const;

/** `environment:<id>`, `account:<id>` (`account:none` while unassigned) or `device:<id>`. */
export function resourceKeyOf(wait: Pick<ResourceWaitTarget | ResourceWaitContext, "kind" | "environmentId" | "accountId" | "deviceId">): string {
  switch (wait.kind) {
    case "environment":
      return `environment:${wait.environmentId ?? "none"}`;
    case "ai_account":
      return `account:${wait.accountId ?? "none"}`;
    case "device_slots":
      return `device:${wait.deviceId ?? "none"}`;
  }
}

export interface EpisodeChain {
  companyId: string;
  issueId: string | null;
  agentId: string;
}

/** The chain a run belongs to: its issue, or its agent when it has none. */
export function chainOfRun(run: Pick<HeartbeatRunRow, "companyId" | "agentId" | "contextSnapshot">): EpisodeChain {
  const issueId = run.contextSnapshot?.issueId;
  return {
    companyId: run.companyId,
    issueId: typeof issueId === "string" && issueId.length > 0 ? issueId : null,
    agentId: run.agentId,
  };
}

function chainCondition(chain: EpisodeChain): SQL {
  return and(
    eq(resourceWaitEpisodes.companyId, chain.companyId),
    chain.issueId
      ? eq(resourceWaitEpisodes.issueId, chain.issueId)
      : and(isNull(resourceWaitEpisodes.issueId), eq(resourceWaitEpisodes.agentId, chain.agentId)),
  )!;
}

export async function openEpisodeForChain(db: Db, chain: EpisodeChain): Promise<ResourceWaitEpisodeRow | null> {
  const [row] = await db
    .select()
    .from(resourceWaitEpisodes)
    .where(and(chainCondition(chain), isNull(resourceWaitEpisodes.resolvedAt)));
  return row ?? null;
}

export async function getEpisode(db: Db, episodeId: string): Promise<ResourceWaitEpisodeRow | null> {
  const [row] = await db.select().from(resourceWaitEpisodes).where(eq(resourceWaitEpisodes.id, episodeId));
  return row ?? null;
}

/**
 * The episode a lane run waits in: the one its `contextSnapshot.resourceWait`
 * names, else the episode whose current run it is.
 */
export async function episodeForRun(
  db: Db,
  run: Pick<HeartbeatRunRow, "id" | "companyId" | "contextSnapshot">,
): Promise<ResourceWaitEpisodeRow | null> {
  const context = readResourceWaitContext(run.contextSnapshot?.resourceWait);
  if (context) {
    const [row] = await db
      .select()
      .from(resourceWaitEpisodes)
      .where(and(eq(resourceWaitEpisodes.id, context.episodeId), eq(resourceWaitEpisodes.companyId, run.companyId)));
    if (row) return row;
  }
  const [current] = await db
    .select()
    .from(resourceWaitEpisodes)
    .where(and(eq(resourceWaitEpisodes.currentRunId, run.id), eq(resourceWaitEpisodes.companyId, run.companyId)))
    .orderBy(sql`${resourceWaitEpisodes.resolvedAt} is null desc`, sql`${resourceWaitEpisodes.createdAt} desc`)
    .limit(1);
  return current ?? null;
}

export interface OpenEpisodeResult {
  episode: ResourceWaitEpisodeRow;
  /** A new episode: this is the first deferral of its wait. */
  created: boolean;
  /** The chain's previous open episode, closed as `superseded`. */
  superseded: ResourceWaitEpisodeRow | null;
  /** Reused with a different reason than before. */
  reasonChanged: boolean;
  /**
   * Another agent's live run waits in the chain's episode: this deferral
   * joined it unchanged (same resource or not). Its successor never becomes
   * the episode's current run, writes no bookkeeping and sends no notice.
   */
  shared: boolean;
}

/** The run that defers, so an episode is never taken from another agent's live waiting run. */
export interface EpisodeDeferringRun {
  id: string;
  agentId: string;
  /** It ran as the issue's assignee: its wait may take the episode over. */
  wasIssueAssignee: boolean;
}

/** Whether the episode's resource is the one `wait` names. */
export function sameResource(
  episode: Pick<ResourceWaitEpisodeRow, "kind" | "resourceKey">,
  wait: Pick<ResourceWaitTarget | ResourceWaitContext, "kind" | "environmentId" | "accountId" | "deviceId">,
): boolean {
  return episode.kind === wait.kind && episode.resourceKey === resourceKeyOf(wait);
}

async function mayTakeOver(tx: ResourceWaitDb, open: ResourceWaitEpisodeRow, run: EpisodeDeferringRun): Promise<boolean> {
  if (!open.currentRunId || open.currentRunId === run.id || run.wasIssueAssignee) return true;
  const [current] = await tx
    .select({ agentId: heartbeatRuns.agentId, status: heartbeatRuns.status })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, open.currentRunId));
  if (!current || !(LIVE_RUN_STATUSES as readonly string[]).includes(current.status)) return true;
  return current.agentId === run.agentId;
}

/**
 * Opens, reuses or supersedes the chain's episode for a deferral (spec 7.3
 * step 3), in one transaction. On reuse `checks` counts consecutive
 * deferrals with the same reason (it drives admission backoff) and starts
 * over at 0 when the reason changes. With `run`, an episode whose current
 * run is another agent's live run is joined unchanged (`shared`), unless
 * `run` executed as the issue's assignee.
 */
export async function openEpisode(
  db: Db,
  input: { chain: EpisodeChain; wait: ResourceWaitTarget; now: Date; run?: EpisodeDeferringRun },
): Promise<OpenEpisodeResult> {
  const { chain, wait, now } = input;
  const resourceKey = resourceKeyOf(wait);
  return db.transaction(async (tx) => {
    let superseded: ResourceWaitEpisodeRow | null = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const [open] = await tx
        .select()
        .from(resourceWaitEpisodes)
        .where(and(chainCondition(chain), isNull(resourceWaitEpisodes.resolvedAt)))
        .for("update");
      if (open && input.run && !(await mayTakeOver(tx, open, input.run))) {
        return { episode: open, created: false, superseded, reasonChanged: false, shared: true };
      }
      if (open && open.kind === wait.kind && open.resourceKey === resourceKey) {
        const sameReason = open.reason === wait.reason;
        const [episode] = await tx
          .update(resourceWaitEpisodes)
          .set({
            agentId: chain.agentId,
            reason: wait.reason,
            scope: wait.scope,
            environmentId: wait.environmentId,
            deviceId: wait.deviceId,
            accountId: wait.accountId,
            resumeAt: wait.resumeAt,
            resumeAtSource: wait.resumeAtSource,
            checks: sameReason ? sql`${resourceWaitEpisodes.checks} + 1` : 0,
            nextCheckAt: null,
            updatedAt: now,
          })
          .where(eq(resourceWaitEpisodes.id, open.id))
          .returning();
        return { episode: episode!, created: false, superseded, reasonChanged: !sameReason, shared: false };
      }
      if (open) {
        const [closed] = await tx
          .update(resourceWaitEpisodes)
          .set({ resolvedAt: now, resolution: "superseded", updatedAt: now })
          .where(and(eq(resourceWaitEpisodes.id, open.id), isNull(resourceWaitEpisodes.resolvedAt)))
          .returning();
        superseded = closed ?? superseded;
      }
      const inserted = await tx.execute<{ id: string }>(sql`
        insert into ${resourceWaitEpisodes} (
          company_id, agent_id, issue_id, kind, reason, scope, resource_key,
          environment_id, device_id, account_id, since, resume_at, resume_at_source,
          checks, created_at, updated_at
        ) values (
          ${chain.companyId}::uuid, ${chain.agentId}::uuid, ${chain.issueId}::uuid, ${wait.kind}, ${wait.reason}, ${wait.scope}, ${resourceKey},
          ${wait.environmentId}::uuid, ${wait.deviceId}::uuid, ${wait.accountId}::uuid, ${now.toISOString()}::timestamptz,
          ${wait.resumeAt ? wait.resumeAt.toISOString() : null}::timestamptz, ${wait.resumeAtSource},
          0, ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz
        )
        on conflict (company_id, (coalesce(issue_id::text, 'agent:' || agent_id::text))) where resolved_at is null do nothing
        returning id
      `);
      const id = inserted[0]?.id;
      if (id) {
        const [episode] = await tx.select().from(resourceWaitEpisodes).where(eq(resourceWaitEpisodes.id, id));
        return { episode: episode!, created: true, superseded, reasonChanged: false, shared: false };
      }
      // A concurrent deferral of the same chain opened one first: reuse or supersede it.
    }
    throw new Error("Could not open a resource wait episode for this chain");
  });
}

/**
 * Ends an open episode. Returns the resolved row only for the call that
 * resolved it, so the caller's notice and activity run once.
 */
export async function resolveEpisode(
  db: Db,
  episodeId: string,
  resolution: ResourceWaitResolution,
  now: Date,
): Promise<ResourceWaitEpisodeRow | null> {
  const [row] = await db
    .update(resourceWaitEpisodes)
    .set({ resolvedAt: now, resolution, updatedAt: now })
    .where(and(eq(resourceWaitEpisodes.id, episodeId), isNull(resourceWaitEpisodes.resolvedAt)))
    .returning();
  return row ?? null;
}

/** Makes `runId` the episode's current run; `nextCheckAt` records an admission wait's next attempt. */
export async function setEpisodeCurrentRun(
  db: Db,
  episodeId: string,
  runId: string,
  now: Date,
  bookkeeping: { nextCheckAt?: Date | null } = {},
): Promise<void> {
  await db
    .update(resourceWaitEpisodes)
    .set({
      currentRunId: runId,
      ...(bookkeeping.nextCheckAt !== undefined ? { nextCheckAt: bookkeeping.nextCheckAt } : {}),
      updatedAt: now,
    })
    .where(eq(resourceWaitEpisodes.id, episodeId));
}

/**
 * The oldest other run of the episode's chain that still waits, in the
 * episode's lane, for the episode's own resource (`contextSnapshot.resourceWait`
 * names the episode). Null when there is none.
 */
export async function coWaiterOf(
  db: ResourceWaitDb,
  episode: ResourceWaitEpisodeRow,
  excludeRunIds: readonly string[] = [],
): Promise<{ id: string; agentId: string } | null> {
  const rows = await db
    .select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, contextSnapshot: heartbeatRuns.contextSnapshot })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, episode.companyId),
      eq(heartbeatRuns.status, "scheduled_retry"),
      eq(heartbeatRuns.scheduledRetryReason, RESOURCE_WAIT_LANE_BY_KIND[episode.kind]),
      sql`${heartbeatRuns.contextSnapshot} -> 'resourceWait' ->> 'episodeId' = ${episode.id}`,
      excludeRunIds.length > 0 ? notInArray(heartbeatRuns.id, [...excludeRunIds]) : undefined,
    ))
    .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id));
  for (const row of rows) {
    const context = readResourceWaitContext(row.contextSnapshot?.resourceWait);
    if (context && sameResource(episode, context)) return { id: row.id, agentId: row.agentId };
  }
  return null;
}

/**
 * The episode's current run ended or was suppressed: another run of the
 * chain that waits for the same resource takes the episode over (its `since`
 * and notice state carry on, and its gate runs at its next check);
 * otherwise the episode is abandoned. `excludeRunIds` are runs that end too
 * (the ended run, and runs the gate suppresses with it). Returns the
 * abandoned row, for the caller's cleanup, only for the call that abandoned it.
 */
export async function handOverOrAbandon(
  db: Db,
  episode: ResourceWaitEpisodeRow,
  excludeRunIds: readonly string[],
  now: Date,
): Promise<{ handedOverTo: string | null; abandoned: ResourceWaitEpisodeRow | null }> {
  const heir = await coWaiterOf(db, episode, excludeRunIds);
  if (heir) {
    const moved = await db
      .update(resourceWaitEpisodes)
      .set({ currentRunId: heir.id, agentId: heir.agentId, gateCheckedAt: null, updatedAt: now })
      .where(and(
        eq(resourceWaitEpisodes.id, episode.id),
        isNull(resourceWaitEpisodes.resolvedAt),
        episode.currentRunId ? eq(resourceWaitEpisodes.currentRunId, episode.currentRunId) : isNull(resourceWaitEpisodes.currentRunId),
      ))
      .returning({ id: resourceWaitEpisodes.id });
    if (moved.length > 0) return { handedOverTo: heir.id, abandoned: null };
  }
  return { handedOverTo: null, abandoned: await resolveEpisode(db, episode.id, "abandoned", now) };
}
