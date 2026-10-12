import { and, eq, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, issues } from "@paperclipai/db";

export const ISSUE_BLOCKERS_RESOLVED_WAKE_REASON = "issue_blockers_resolved";

// A wake counts as "already delivered or in flight for the current ready state"
// for these statuses. The level-triggered state key uses this full set so that
// one wake for a ready state suppresses further wakes for the SAME state. This
// bounds reconciliation: after one wake, later passes find the completed row.
const IDEMPOTENT_DEPENDENCY_WAKE_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "claimed",
  "completed",
] as const;

// A wake counts as "still in flight" for these statuses. The `completed` status
// is not in this set on purpose. Dependency readiness is level-triggered, so a
// historical completed per-edge wake must never suppress a new wake for the
// current ready state. The dedup uses this set only for the legacy per-edge key
// and for old no-cycle state keys that are still queued after a deploy.
const IN_FLIGHT_DEPENDENCY_WAKE_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "claimed",
] as const;

const IDEMPOTENT_DEPENDENCY_WAKE_STATUS_SET = new Set<string>(IDEMPOTENT_DEPENDENCY_WAKE_STATUSES);
const IN_FLIGHT_DEPENDENCY_WAKE_STATUS_SET = new Set<string>(IN_FLIGHT_DEPENDENCY_WAKE_STATUSES);

export type IssueBlockersResolvedWakeCycleInput = Date | string | null | undefined;

export type IssueBlockersResolvedReadyStateInput = {
  dependentIssueId: string;
  blockerIssueIds: string[];
  blockedTransitionAt?: IssueBlockersResolvedWakeCycleInput;
};

/**
 * Canonical blocked-cycle stamp for the dependency-ready state key.
 * `blockedTransitionAt` is UTC ISO-8601, or `none` when the dependent has no
 * recorded transition into `blocked`.
 */
export function formatIssueBlockersResolvedWakeCycle(
  blockedTransitionAt: IssueBlockersResolvedWakeCycleInput,
): string {
  if (blockedTransitionAt == null || blockedTransitionAt === "") return "none";
  const parsed = blockedTransitionAt instanceof Date
    ? blockedTransitionAt
    : new Date(blockedTransitionAt);
  if (Number.isNaN(parsed.getTime())) return "none";
  return parsed.toISOString();
}

function uniqueSortedBlockerIssueIds(blockerIssueIds: string[]): string[] {
  return [...new Set(blockerIssueIds.filter(Boolean))].sort();
}

function hashBlockerReadyStateDigest(sortedBlockerIssueIds: string[], cycle: string | null): string {
  const payload = cycle == null
    ? sortedBlockerIssueIds.join(",")
    : `${sortedBlockerIssueIds.join(",")}\n${cycle}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

function buildStateKey(dependentIssueId: string, digest: string, blockerCount: number): string {
  return [
    ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
    "state",
    dependentIssueId,
    String(blockerCount),
    digest,
  ].join(":");
}

/**
 * Legacy per-edge idempotency key. One key encodes a single resolved blocker
 * edge `issue_blockers_resolved:{dependentIssueId}:{resolvedBlockerIssueId}`.
 * The dedup keeps this format only to read wake rows written before the
 * level-triggered state key existed.
 */
export function buildIssueBlockersResolvedWakeIdempotencyKey(input: {
  dependentIssueId: string;
  resolvedBlockerIssueId: string;
}) {
  return [
    ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
    input.dependentIssueId,
    input.resolvedBlockerIssueId,
  ].join(":");
}

/**
 * Pre-cycle level-triggered key. Rows written before the ready state included
 * `blockedTransitionAt` hashed only the sorted blocker ids. Lookup still reads
 * this format so an in-flight deploy-overlap wake can suppress a duplicate.
 */
export function buildIssueBlockersResolvedWakeStateKeyWithoutCycle(input: {
  dependentIssueId: string;
  blockerIssueIds: string[];
}) {
  const sortedBlockerIssueIds = uniqueSortedBlockerIssueIds(input.blockerIssueIds);
  return buildStateKey(
    input.dependentIssueId,
    hashBlockerReadyStateDigest(sortedBlockerIssueIds, null),
    sortedBlockerIssueIds.length,
  );
}

/**
 * Level-triggered idempotency key. One key encodes the full set of blockers that
 * defines the current dependency-ready state plus the dependent's current
 * blocked cycle (`blockedTransitionAt`, or `none`). Two wakes for the same ready
 * state share the key. A wake from an earlier blocked cycle has a different
 * cycle stamp, so it produces a different key and never suppresses the current
 * wake. All three emit paths (route-time, finalize-time, periodic backstop) use
 * this key so they share one idempotency rule.
 */
export function buildIssueBlockersResolvedWakeStateKey(input: IssueBlockersResolvedReadyStateInput) {
  const sortedBlockerIssueIds = uniqueSortedBlockerIssueIds(input.blockerIssueIds);
  const cycle = formatIssueBlockersResolvedWakeCycle(input.blockedTransitionAt);
  return buildStateKey(
    input.dependentIssueId,
    hashBlockerReadyStateDigest(sortedBlockerIssueIds, cycle),
    sortedBlockerIssueIds.length,
  );
}

/**
 * One-shot key for the backstop wake of a dependent that is already `todo` or
 * `in_progress` when its blockers resolve. Such a dependent has no blocked
 * cycle, so the key encodes the full blocker set plus the latest blocker
 * terminal transition (`resolvedAt`, or `none`) instead. The backstop sends at
 * most one wake per key whatever that wake's outcome, so a skipped or failed
 * wake can never turn into a retry storm. Reopening and closing a blocker moves
 * `resolvedAt` and produces a new key.
 */
export function buildIssueBlockersResolvedResolutionWakeKey(input: {
  dependentIssueId: string;
  blockerIssueIds: string[];
  resolvedAt: IssueBlockersResolvedWakeCycleInput;
}) {
  const sortedBlockerIssueIds = uniqueSortedBlockerIssueIds(input.blockerIssueIds);
  const resolution = `resolved:${formatIssueBlockersResolvedWakeCycle(input.resolvedAt)}`;
  return [
    ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
    "resolution",
    input.dependentIssueId,
    String(sortedBlockerIssueIds.length),
    hashBlockerReadyStateDigest(sortedBlockerIssueIds, resolution),
  ].join(":");
}

/**
 * Latest terminal transition across the given blockers: `completedAt` for a
 * `done` blocker and `cancelledAt` for a `cancelled` one. Returns `null` when no
 * blocker is terminal or none recorded a transition time.
 */
export async function findLatestIssueBlockerTerminalTransitionAt(
  db: Db,
  input: { companyId: string; blockerIssueIds: string[] },
): Promise<Date | null> {
  const blockerTerminalStateRows =
    input.blockerIssueIds.length > 0
      ? await db
          .select({
            status: issues.status,
            completedAt: issues.completedAt,
            cancelledAt: issues.cancelledAt,
          })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, input.companyId),
              inArray(issues.id, [...new Set(input.blockerIssueIds)]),
            ),
          )
      : [];
  return blockerTerminalStateRows.reduce<Date | null>(
    (latest, row) => {
      const transitionedAt = row.status === "done"
        ? row.completedAt
        : row.status === "cancelled"
          ? row.cancelledAt
          : null;
      return transitionedAt && (!latest || transitionedAt > latest) ? transitionedAt : latest;
    },
    null,
  );
}

function parseWakeCycleDate(blockedTransitionAt: IssueBlockersResolvedWakeCycleInput): Date | null {
  if (blockedTransitionAt == null || blockedTransitionAt === "") return null;
  const parsed = blockedTransitionAt instanceof Date
    ? blockedTransitionAt
    : new Date(blockedTransitionAt);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function wakeCoversIssueBlockersResolvedReadyState(
  wake: {
    status: string;
    idempotencyKey: string | null;
    requestedAt: Date;
  },
  keys: {
    cycleKey: string;
    oldStateKey: string;
    legacyKeys: Set<string>;
    blockedTransitionAt: Date | null;
    latestBlockerTerminalTransitionAt: Date | null;
  },
): boolean {
  const idempotencyKey = wake.idempotencyKey;
  if (!idempotencyKey) return false;

  // A completed state-key wake only covers the blocker resolution it was
  // requested for. A blocker that is reopened and closed again after the wake
  // starts a new resolution, so the dependent must be woken again. Unrelated
  // blocker edits do not move the terminal transition and never re-wake.
  const requestedAfterLatestBlockerTransition =
    !keys.latestBlockerTerminalTransitionAt ||
    wake.requestedAt.getTime() >=
      keys.latestBlockerTerminalTransitionAt.getTime();

  if (idempotencyKey === keys.cycleKey) {
    if (!IDEMPOTENT_DEPENDENCY_WAKE_STATUS_SET.has(wake.status)) return false;
    return wake.status !== "completed" || requestedAfterLatestBlockerTransition;
  }

  if (idempotencyKey === keys.oldStateKey) {
    if (IN_FLIGHT_DEPENDENCY_WAKE_STATUS_SET.has(wake.status)) return true;
    if (wake.status !== "completed") return false;
    if (!requestedAfterLatestBlockerTransition) return false;
    if (!keys.blockedTransitionAt) return true;
    return wake.requestedAt.getTime() >= keys.blockedTransitionAt.getTime();
  }

  if (keys.legacyKeys.has(idempotencyKey)) {
    return IN_FLIGHT_DEPENDENCY_WAKE_STATUS_SET.has(wake.status);
  }

  return false;
}

/**
 * Find a wake that already covers the current dependency-ready state of the
 * dependent issue. The check is level-triggered and cycle-aware:
 *
 * - The cycle-aware state key matches an in-flight wake, or a `completed` wake
 *   requested after the latest blocker terminal transition. This suppresses a
 *   duplicate for the SAME ready state, including the current blocked cycle,
 *   and lets a later blocker reopen/close cycle create a new wake without
 *   treating unrelated blocker edits as a new cycle.
 * - The old no-cycle state key matches in-flight statuses (deploy overlap),
 *   or a `completed` wake whose `requestedAt` is at or after both the current
 *   `blockedTransitionAt` (same cycle) and the latest blocker terminal
 *   transition. A completed old-key wake from a previous cycle does not
 *   suppress.
 * - Each legacy per-edge key matches only a wake that is still in flight.
 *
 * Returns the first matching wake or `null`.
 */
export async function findExistingIssueBlockersResolvedWakeForReadyState(
  db: Db,
  input: {
    companyId: string;
    dependentIssueId: string;
    blockerIssueIds: string[];
    blockedTransitionAt?: IssueBlockersResolvedWakeCycleInput;
  },
) {
  const cycleKey = buildIssueBlockersResolvedWakeStateKey(input);
  const oldStateKey = buildIssueBlockersResolvedWakeStateKeyWithoutCycle(input);
  const latestBlockerTerminalTransitionAt =
    await findLatestIssueBlockerTerminalTransitionAt(db, input);
  const legacyKeyList = [
    ...new Set(
      input.blockerIssueIds
        .filter(Boolean)
        .map((resolvedBlockerIssueId) =>
          buildIssueBlockersResolvedWakeIdempotencyKey({
            dependentIssueId: input.dependentIssueId,
            resolvedBlockerIssueId,
          }),
        ),
    ),
  ];
  const lookupKeys = [...new Set([cycleKey, oldStateKey, ...legacyKeyList])];
  const blockedTransitionAt = parseWakeCycleDate(input.blockedTransitionAt);

  const rows = await db
    .select({
      id: agentWakeupRequests.id,
      status: agentWakeupRequests.status,
      idempotencyKey: agentWakeupRequests.idempotencyKey,
      requestedAt: agentWakeupRequests.requestedAt,
    })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        inArray(agentWakeupRequests.idempotencyKey, lookupKeys),
      ),
    );

  const covering = rows.find((row) =>
    wakeCoversIssueBlockersResolvedReadyState(row, {
      cycleKey,
      oldStateKey,
      legacyKeys: new Set(legacyKeyList),
      blockedTransitionAt,
      latestBlockerTerminalTransitionAt,
    }),
  );
  return covering ?? null;
}
