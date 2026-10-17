import { and, asc, eq, isNull, notInArray, sql, type SQL } from "drizzle-orm";
import { type Db, heartbeatRuns, resourceWaitEpisodes } from "@paperclipai/db";
import {
  RESOURCE_WAIT_LANE_BY_KIND,
  RESOURCE_WAIT_NOTICE_POLICY,
  readResourceWaitContext,
  type ResourceWaitContext,
  type ResourceWaitReason,
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
 * (`shared`) and waits from its own `contextSnapshot.resourceWait`; when the
 * episode ends, the oldest joined wait for another resource takes the issue's
 * wait over with an episode of its own (`adoptEpisode`, episode-end.ts).
 *
 * Environment, device, account and current-run ids have no foreign keys:
 * readers tolerate ids that no longer resolve.
 */

const LIVE_RUN_STATUSES = ["scheduled_retry", "queued", "running"] as const;

function isLimitReason(reason: string | null | undefined): boolean {
  return reason === "usage_limit" || reason === "credit_balance";
}

/**
 * A reused episode whose reason changed to one a person must act on gets its
 * own immediate notice (spec 8): another limit is still the same limit.
 */
export function needsNewImmediateNotice(previousReason: string, reason: string): boolean {
  if (previousReason === reason) return false;
  if (RESOURCE_WAIT_NOTICE_POLICY[reason as ResourceWaitReason] !== "immediate") return false;
  return !(isLimitReason(previousReason) && isLimitReason(reason));
}

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
 * The episode a lane run waits in: the open episode whose current run it is
 * (a run that took over a chain's wait), else the one its
 * `contextSnapshot.resourceWait` names, else the last one it was the current
 * run of.
 */
export async function episodeForRun(
  db: Db,
  run: Pick<HeartbeatRunRow, "id" | "companyId" | "contextSnapshot">,
): Promise<ResourceWaitEpisodeRow | null> {
  const [owned] = await db
    .select()
    .from(resourceWaitEpisodes)
    .where(and(eq(resourceWaitEpisodes.currentRunId, run.id), eq(resourceWaitEpisodes.companyId, run.companyId)))
    .orderBy(sql`${resourceWaitEpisodes.resolvedAt} is null desc`, sql`${resourceWaitEpisodes.createdAt} desc`)
    .limit(1);
  if (owned && !owned.resolvedAt) return owned;
  const context = readResourceWaitContext(run.contextSnapshot?.resourceWait);
  if (context) {
    const [row] = await db
      .select()
      .from(resourceWaitEpisodes)
      .where(and(eq(resourceWaitEpisodes.id, context.episodeId), eq(resourceWaitEpisodes.companyId, run.companyId)));
    if (row) return row;
  }
  return owned ?? null;
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
  /**
   * The episode's current run before this call. A reuse (or takeover) makes
   * the deferring run current inside the locked transaction, so a deferral
   * that ends up without a successor can give the episode back.
   */
  previousCurrentRunId?: string | null;
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
 * over at 0 when the reason changes; a new reason a person must act on
 * clears `notified_at`, so its own notice goes out (and is retried). With
 * `run`, an episode whose current run is another agent's live run is joined
 * unchanged (`shared`), unless `run` executed as the issue's assignee; a
 * reuse or takeover makes `run` the current run under the row lock, so a
 * concurrent hand-over or abandonment that read the old current run fails.
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
        return { episode: open, created: false, superseded, reasonChanged: false, shared: true, previousCurrentRunId: open.currentRunId };
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
            ...(input.run ? { currentRunId: input.run.id } : {}),
            ...(needsNewImmediateNotice(open.reason, wait.reason) ? { notifiedAt: null } : {}),
            updatedAt: now,
          })
          .where(eq(resourceWaitEpisodes.id, open.id))
          .returning();
        return {
          episode: episode!,
          created: false,
          superseded,
          reasonChanged: !sameReason,
          shared: false,
          previousCurrentRunId: open.currentRunId,
        };
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
        return { episode: episode!, created: true, superseded, reasonChanged: false, shared: false, previousCurrentRunId: null };
      }
      // A concurrent deferral of the same chain opened one first: reuse or supersede it.
    }
    throw new Error("Could not open a resource wait episode for this chain");
  });
}

/** The episode's current run is still the one the caller observed. */
function currentRunIs(runId: string | null): SQL {
  return runId ? eq(resourceWaitEpisodes.currentRunId, runId) : isNull(resourceWaitEpisodes.currentRunId);
}

/**
 * Ends an open episode. Returns the resolved row only for the call that
 * resolved it, so the caller's notice and activity run once. With
 * `currentRunId`, only while that run is still the episode's current run (a
 * wait another run took over in the meantime is left alone).
 */
export async function resolveEpisode(
  db: Db,
  episodeId: string,
  resolution: ResourceWaitResolution,
  now: Date,
  guard: { currentRunId?: string | null } = {},
): Promise<ResourceWaitEpisodeRow | null> {
  const [row] = await db
    .update(resourceWaitEpisodes)
    .set({ resolvedAt: now, resolution, updatedAt: now })
    .where(and(
      eq(resourceWaitEpisodes.id, episodeId),
      isNull(resourceWaitEpisodes.resolvedAt),
      guard.currentRunId !== undefined ? currentRunIs(guard.currentRunId) : undefined,
    ))
    .returning();
  return row ?? null;
}

/**
 * Makes `runId` the current run of an episode that is still open;
 * `nextCheckAt` records an admission wait's next attempt. False when the
 * episode ended in the meantime.
 */
export async function setEpisodeCurrentRun(
  db: Db,
  episodeId: string,
  runId: string,
  now: Date,
  bookkeeping: { nextCheckAt?: Date | null } = {},
): Promise<boolean> {
  const rows = await db
    .update(resourceWaitEpisodes)
    .set({
      currentRunId: runId,
      ...(bookkeeping.nextCheckAt !== undefined ? { nextCheckAt: bookkeeping.nextCheckAt } : {}),
      updatedAt: now,
    })
    .where(and(eq(resourceWaitEpisodes.id, episodeId), isNull(resourceWaitEpisodes.resolvedAt)))
    .returning({ id: resourceWaitEpisodes.id });
  return rows.length > 0;
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
 * (the ended run, and runs the gate suppresses with it). Both writes require
 * the episode to still be open with the current run the caller observed: a
 * deferral that took the episode over in the meantime keeps it, and nothing
 * happens. Returns the abandoned row, for the caller's cleanup, only for the
 * call that abandoned it.
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
        currentRunIs(episode.currentRunId),
      ))
      .returning({ id: resourceWaitEpisodes.id });
    return { handedOverTo: moved.length > 0 ? heir.id : null, abandoned: null };
  }
  return {
    handedOverTo: null,
    abandoned: await resolveEpisode(db, episode.id, "abandoned", now, { currentRunId: episode.currentRunId }),
  };
}

/**
 * Opens an episode for a waiting run that has none of its own (it joined
 * another agent's wait on the issue, and that wait ended): the run's own
 * resource, with the run as current run, only while the chain has no open
 * episode. Null when the chain has one.
 */
export async function adoptEpisode(
  db: Db,
  input: {
    run: Pick<HeartbeatRunRow, "id" | "companyId" | "agentId" | "contextSnapshot">;
    context: ResourceWaitContext;
    since: Date;
    checks: number;
    nextCheckAt: Date | null;
    now: Date;
  },
): Promise<ResourceWaitEpisodeRow | null> {
  const { context, now } = input;
  const chain = chainOfRun(input.run);
  const iso = (date: Date | null) => (date ? date.toISOString() : null);
  const inserted = await db.execute<{ id: string }>(sql`
    insert into ${resourceWaitEpisodes} (
      company_id, agent_id, issue_id, kind, reason, scope, resource_key,
      environment_id, device_id, account_id, since, current_run_id, resume_at, resume_at_source,
      next_check_at, checks, created_at, updated_at
    ) values (
      ${chain.companyId}::uuid, ${chain.agentId}::uuid, ${chain.issueId}::uuid, ${context.kind}, ${context.reason}, ${context.scope}, ${resourceKeyOf(context)},
      ${context.environmentId}::uuid, ${context.deviceId}::uuid, ${context.accountId}::uuid, ${input.since.toISOString()}::timestamptz,
      ${input.run.id}::uuid, ${context.resumeAt}::timestamptz, ${context.resumeAtSource},
      ${iso(input.nextCheckAt)}::timestamptz, ${Math.max(0, Math.floor(input.checks))}, ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz
    )
    on conflict (company_id, (coalesce(issue_id::text, 'agent:' || agent_id::text))) where resolved_at is null do nothing
    returning id
  `);
  const id = inserted[0]?.id;
  if (!id) return null;
  const [episode] = await db.select().from(resourceWaitEpisodes).where(eq(resourceWaitEpisodes.id, id));
  return episode ?? null;
}

/**
 * A wait that has to give the episode back after `openEpisode` made its run
 * current (the deferral got no successor or never happened): the previous
 * current run (and its agent) gets it again while the episode still points
 * at `runId`.
 */
export async function restoreEpisodeCurrentRun(
  db: Db,
  episodeId: string,
  runId: string,
  previousCurrentRunId: string,
  now: Date,
): Promise<boolean> {
  const [previous] = await db
    .select({ agentId: heartbeatRuns.agentId, companyId: heartbeatRuns.companyId })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, previousCurrentRunId));
  const rows = await db
    .update(resourceWaitEpisodes)
    .set({ currentRunId: previousCurrentRunId, ...(previous ? { agentId: previous.agentId } : {}), updatedAt: now })
    .where(and(
      eq(resourceWaitEpisodes.id, episodeId),
      isNull(resourceWaitEpisodes.resolvedAt),
      currentRunIs(runId),
      ...(previous ? [eq(resourceWaitEpisodes.companyId, previous.companyId)] : []),
    ))
    .returning({ id: resourceWaitEpisodes.id });
  return rows.length > 0;
}
