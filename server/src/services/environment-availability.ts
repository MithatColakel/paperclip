import { and, asc, eq, inArray, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { type Db, environmentAvailability, environments, resourceWaitEpisodes } from "@paperclipai/db";
import {
  AI_ACCOUNT_CREDENTIAL_TYPES,
  ENVIRONMENT_ADMISSION_WAIT_REASONS,
  ENVIRONMENT_TARGET_WAIT_REASONS,
  type AiAccountCredentialType,
  type EnvironmentAvailabilitySource,
  type EnvironmentAvailabilityState,
  type EnvironmentAvailabilitySummary,
} from "@paperclipai/shared";
import { sanitizeEnvironmentText } from "@paperclipai/plugin-sdk";

/**
 * Fork: the environment availability registry (`environment_availability`).
 *
 * One row per execution environment records whether its target (the device,
 * or the connection to it) is up. A missing row means available. Rows hold
 * target-level states only: a driver's refusal of one run (admission) is a
 * per-run wait and never lands here.
 *
 * Staleness rules:
 * - an `unavailable` row is trusted only while `checked_at` is within
 *   `trustMs` (the backoff ceiling); an older row leads to a real attempt;
 * - `next_check_at IS NULL` means the row is due for a check;
 * - when the last wait on an environment ends, its row is deleted, unless the
 *   target was retired.
 *
 * Every write bumps `wake_epoch`, so a deferral that read the epoch before its
 * attempt can tell that a report, check or wake raced with it. Epochs come
 * from the database clock and only ever grow, also across a delete and a
 * re-insert of the same row.
 *
 * Label and message lengths are not enforced by the database; every writer
 * here cleans and clips them.
 *
 * Input-only: the database handle (or an open transaction) is passed in.
 */

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** A database handle or an open transaction. */
export type AvailabilityDb = Db | Tx;
export type EnvironmentAvailabilityRow = typeof environmentAvailability.$inferSelect;

export const ENVIRONMENT_AVAILABILITY_LIMITS = {
  labelMaxLength: 80,
  messageMaxLength: 300,
  targetKeyMaxLength: 300,
  /** An `unavailable` row is trusted this long after its last check. */
  trustMs: 10 * 60 * 1000,
  backoffBaseMs: 30 * 1000,
  backoffMaxMs: 10 * 60 * 1000,
  /** ±20 % around the backoff. */
  backoffJitter: 0.2,
  retryAfterMaxAheadMs: 7 * 24 * 60 * 60 * 1000,
} as const;

/** The reasons a registry row can carry: the target-scope wait reasons plus `other`. */
export const ENVIRONMENT_AVAILABILITY_REASONS = [...ENVIRONMENT_TARGET_WAIT_REASONS, "other"] as const;
const REASON_SET: ReadonlySet<string> = new Set(ENVIRONMENT_AVAILABILITY_REASONS);
/** A driver's refusal of one run (`other` aside, which a target may also report). */
const ADMISSION_ONLY_REASON_SET: ReadonlySet<string> = new Set(
  ENVIRONMENT_ADMISSION_WAIT_REASONS.filter((reason) => reason !== "other"),
);
const TARGET_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** A target reason, or `other` for anything the registry does not know. */
export function normalizeAvailabilityReason(value: unknown): string {
  return typeof value === "string" && REASON_SET.has(value) ? value : "other";
}

/**
 * An admission reason (not_allowed, not_serving, stopped, busy, throttled,
 * restarting, plugin_upgrade_pending): one run's wait, never an outage of the
 * target, so the registry never records it (spec 6.3). Written as `other`, it
 * would hold every company's runs on the environment.
 */
export function isAdmissionOnlyReason(value: unknown): boolean {
  return typeof value === "string" && ADMISSION_ONLY_REASON_SET.has(value);
}

/** Plain text, at most 80 characters, or null. */
export function clipAvailabilityLabel(value: unknown): string | null {
  return sanitizeEnvironmentText(value, ENVIRONMENT_AVAILABILITY_LIMITS.labelMaxLength) ?? null;
}

/** Plain text, at most 300 characters, or null. */
export function clipAvailabilityMessage(value: unknown): string | null {
  return sanitizeEnvironmentText(value, ENVIRONMENT_AVAILABILITY_LIMITS.messageMaxLength) ?? null;
}

function clipTargetKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  return key.length > 0 && key.length <= ENVIRONMENT_AVAILABILITY_LIMITS.targetKeyMaxLength && TARGET_KEY_PATTERN.test(key)
    ? key
    : null;
}

/**
 * Credential types in canonical order without duplicates. Null stays null
 * (any type); an empty list stays empty (no pool credential at all).
 */
export function normalizeCredentialTypes(value: unknown): AiAccountCredentialType[] | null {
  if (!Array.isArray(value)) return null;
  return AI_ACCOUNT_CREDENTIAL_TYPES.filter((type) => value.includes(type));
}

function sameCredentialTypes(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean {
  if (a == null || b == null) return a == null && b == null;
  return a.length === b.length && a.every((type, index) => type === b[index]);
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function clampRetryAfter(value: Date | string | null | undefined, now: Date): Date | null {
  const date = toDate(value);
  if (!date) return null;
  const latest = now.getTime() + ENVIRONMENT_AVAILABILITY_LIMITS.retryAfterMaxAheadMs;
  return date.getTime() > latest ? new Date(latest) : date;
}

/** `min(30 s × 2^failures, 10 min)`, then ±20 % jitter. */
export function availabilityBackoffMs(failures: number, random: () => number = Math.random): number {
  const { backoffBaseMs, backoffMaxMs, backoffJitter } = ENVIRONMENT_AVAILABILITY_LIMITS;
  const exponent = Math.min(Math.max(0, Math.floor(Number.isFinite(failures) ? failures : 0)), 20);
  const base = Math.min(backoffBaseMs * 2 ** exponent, backoffMaxMs);
  const jitter = 1 + (Math.min(Math.max(random(), 0), 1) * 2 - 1) * backoffJitter;
  return Math.round(base * jitter);
}

/** When to check again after `failures` failed checks; never earlier than `retryAfter`. */
export function nextAvailabilityCheckAt(input: {
  failures: number;
  now: Date;
  retryAfter?: Date | null;
  random?: () => number;
}): Date {
  const at = input.now.getTime() + availabilityBackoffMs(input.failures, input.random);
  return new Date(Math.max(at, input.retryAfter?.getTime() ?? 0));
}

/** The row was checked within the trust window (10 min). */
export function isAvailabilityFresh(
  row: Pick<EnvironmentAvailabilityRow, "checkedAt"> | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!row?.checkedAt) return false;
  return now.getTime() - row.checkedAt.getTime() <= ENVIRONMENT_AVAILABILITY_LIMITS.trustMs;
}

/** The work items' name for `isAvailabilityFresh`. */
export const isFresh = isAvailabilityFresh;

/** An `unavailable` row that preflight may trust: checked within the last 10 min. */
export function isFreshlyUnavailable(
  row: Pick<EnvironmentAvailabilityRow, "state" | "checkedAt"> | null | undefined,
  now: Date = new Date(),
): boolean {
  return row?.state === "unavailable" && isAvailabilityFresh(row, now);
}

/** `next_check_at IS NULL` counts as due. */
export function isAvailabilityCheckDue(
  row: Pick<EnvironmentAvailabilityRow, "nextCheckAt"> | null | undefined,
  now: Date = new Date(),
): boolean {
  return !row?.nextCheckAt || row.nextCheckAt.getTime() <= now.getTime();
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/**
 * The API shape of a row. A missing row is available. `acceptedCredentialTypes`
 * overrides the row's own list (the device's target state is the source of
 * truth for sandbox targets).
 */
export function summarizeEnvironmentAvailability(
  row: EnvironmentAvailabilityRow | null | undefined,
  acceptedCredentialTypes?: AiAccountCredentialType[] | null,
): EnvironmentAvailabilitySummary {
  return {
    state: row?.state ?? "available",
    reason: row?.reason ?? null,
    label: row?.label ?? null,
    message: row?.message ?? null,
    unavailableSince: iso(row?.unavailableSince),
    retryAfter: iso(row?.retryAfter),
    checkedAt: iso(row?.checkedAt),
    acceptedCredentialTypes: acceptedCredentialTypes !== undefined
      ? acceptedCredentialTypes
      : normalizeCredentialTypes(row?.acceptedCredentialTypes ?? null),
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** A target's state as a plugin report (or a device's stored report) gives it. */
export interface TargetAvailabilityState {
  state: EnvironmentAvailabilityState;
  reason?: string | null;
  label?: string | null;
  message?: string | null;
  retryAfter?: Date | string | null;
  /** The device's target key, `target:<pluginId>:<provider>:<targetKey>`. */
  targetKey?: string | null;
  /** The resolved list; null accepts any type. */
  acceptedCredentialTypes?: AiAccountCredentialType[] | null;
}

export interface MarkUnavailableInput {
  /**
   * A target reason (offline, paused, maintenance, updating, unreachable,
   * other). An admission reason writes nothing; any other string is `other`.
   */
  reason: string;
  source: EnvironmentAvailabilitySource;
  label?: string | null;
  message?: string | null;
  /** The device's target key, or the driver's own target key from an envelope; informational. */
  targetKey?: string | null;
  retryAfter?: Date | string | null;
  /** Kept as stored when omitted. */
  acceptedCredentialTypes?: AiAccountCredentialType[] | null;
  now?: Date;
  random?: () => number;
}

/** What one write did to one environment's row. */
export interface AvailabilityWriteResult {
  environmentId: string;
  /** The state before the write; null when there was no row (which counts as available). */
  previousState: EnvironmentAvailabilityState | null;
  state: EnvironmentAvailabilityState;
  /** The state changed. A missing row counts as available. */
  changed: boolean;
  /** `unavailable` or `retired` before, `available` now. */
  becameAvailable: boolean;
  becameUnavailable: boolean;
  becameRetired: boolean;
  /** The stored credential types changed. */
  acceptedCredentialTypesChanged: boolean;
  wakeEpoch: number;
  row: EnvironmentAvailabilityRow;
}

type RowValues = Omit<typeof environmentAvailability.$inferInsert, "environmentId" | "wakeEpoch" | "updatedAt">;

/**
 * A new row's epoch: the database clock in microseconds (exact in a JS number
 * until the year 2255), so a re-created row starts above the deleted one.
 */
const FRESH_EPOCH = sql<number>`(extract(epoch from clock_timestamp()) * 1000000)::bigint`;
/** An existing row's next epoch: strictly larger, and never behind the clock. */
const NEXT_EPOCH = sql<number>`greatest(${environmentAvailability.wakeEpoch} + 1, (extract(epoch from clock_timestamp()) * 1000000)::bigint)`;

function transact<T>(db: AvailabilityDb, run: (tx: Tx) => Promise<T>): Promise<T> {
  return "rollback" in db ? (db as Tx).transaction(run) : (db as Db).transaction(run);
}

function effectiveState(row: EnvironmentAvailabilityRow | null | undefined): EnvironmentAvailabilityState {
  return row?.state ?? "available";
}

function writeResult(
  environmentId: string,
  previous: EnvironmentAvailabilityRow | null,
  row: EnvironmentAvailabilityRow,
): AvailabilityWriteResult {
  const before = effectiveState(previous);
  return {
    environmentId,
    previousState: previous?.state ?? null,
    state: row.state,
    changed: before !== row.state,
    becameAvailable: before !== "available" && row.state === "available",
    becameUnavailable: before !== "unavailable" && row.state === "unavailable",
    becameRetired: before !== "retired" && row.state === "retired",
    acceptedCredentialTypesChanged: !sameCredentialTypes(
      normalizeCredentialTypes(previous?.acceptedCredentialTypes ?? null),
      normalizeCredentialTypes(row.acceptedCredentialTypes ?? null),
    ),
    wakeEpoch: Number(row.wakeEpoch),
    row,
  };
}

function unavailableValues(
  previous: EnvironmentAvailabilityRow | null,
  input: MarkUnavailableInput & { countFailure: boolean },
  now: Date,
): RowValues {
  const wasUnavailable = previous?.state === "unavailable";
  const failures = wasUnavailable ? (previous!.checkFailures ?? 0) + (input.countFailure ? 1 : 0) : 0;
  const retryAfter = clampRetryAfter(input.retryAfter, now);
  return {
    state: "unavailable",
    reason: normalizeAvailabilityReason(input.reason),
    label: input.label !== undefined ? clipAvailabilityLabel(input.label) : previous?.label ?? null,
    message: clipAvailabilityMessage(input.message),
    targetKey: input.targetKey !== undefined ? clipTargetKey(input.targetKey) : previous?.targetKey ?? null,
    acceptedCredentialTypes: input.acceptedCredentialTypes !== undefined
      ? normalizeCredentialTypes(input.acceptedCredentialTypes)
      : normalizeCredentialTypes(previous?.acceptedCredentialTypes ?? null),
    unavailableSince: wasUnavailable ? previous!.unavailableSince ?? now : now,
    retryAfter,
    checkedAt: now,
    nextCheckAt: nextAvailabilityCheckAt({ failures, now, retryAfter, random: input.random }),
    checkFailures: failures,
    source: input.source,
  };
}

export function environmentAvailabilityService(db: AvailabilityDb) {
  async function get(environmentId: string): Promise<EnvironmentAvailabilityRow | null> {
    const [row] = await db.select().from(environmentAvailability).where(eq(environmentAvailability.environmentId, environmentId));
    return row ?? null;
  }

  async function getMany(environmentIds: readonly string[]): Promise<Map<string, EnvironmentAvailabilityRow>> {
    const ids = [...new Set(environmentIds)];
    if (ids.length === 0) return new Map();
    const rows = await db.select().from(environmentAvailability).where(inArray(environmentAvailability.environmentId, ids));
    return new Map(rows.map((row) => [row.environmentId, row]));
  }

  /** Current wake epochs; 0 for an environment without a row. Read before an attempt, compare after. */
  async function readWakeEpochs(environmentIds: readonly string[]): Promise<Map<string, number>> {
    const ids = [...new Set(environmentIds)];
    const epochs = new Map(ids.map((id) => [id, 0]));
    if (ids.length === 0) return epochs;
    const rows = await db
      .select({ environmentId: environmentAvailability.environmentId, wakeEpoch: environmentAvailability.wakeEpoch })
      .from(environmentAvailability)
      .where(inArray(environmentAvailability.environmentId, ids));
    for (const row of rows) epochs.set(row.environmentId, Number(row.wakeEpoch));
    return epochs;
  }

  async function readWakeEpoch(environmentId: string): Promise<number> {
    return (await readWakeEpochs([environmentId])).get(environmentId) ?? 0;
  }

  /**
   * Locks the existing rows, lets `compute` derive each environment's new
   * values from its previous row (null skips it), and upserts them with a
   * bumped epoch, all in one transaction. An environment that no longer
   * exists is skipped (waits may still name a deleted one).
   */
  async function writeRows(
    environmentIds: readonly string[],
    compute: (previous: EnvironmentAvailabilityRow | null, environmentId: string) => RowValues | null,
    now: Date,
  ): Promise<AvailabilityWriteResult[]> {
    const ids = [...new Set(environmentIds)];
    if (ids.length === 0) return [];
    return transact(db, async (tx) => {
      const existing = await tx
        .select()
        .from(environmentAvailability)
        .where(inArray(environmentAvailability.environmentId, ids))
        .orderBy(asc(environmentAvailability.environmentId))
        .for("update");
      const previousById = new Map(existing.map((row) => [row.environmentId, row]));
      const known = await existingEnvironmentIds(tx, ids.filter((id) => !previousById.has(id)));
      const results: AvailabilityWriteResult[] = [];
      for (const environmentId of ids) {
        if (!previousById.has(environmentId) && !known.has(environmentId)) continue;
        const previous = previousById.get(environmentId) ?? null;
        const values = compute(previous, environmentId);
        if (!values) continue;
        const [row] = await tx
          .insert(environmentAvailability)
          .values({ ...values, environmentId, wakeEpoch: FRESH_EPOCH, updatedAt: now })
          .onConflictDoUpdate({
            target: environmentAvailability.environmentId,
            set: { ...values, wakeEpoch: NEXT_EPOCH, updatedAt: now },
          })
          .returning();
        results.push(writeResult(environmentId, previous, row!));
      }
      return results;
    });
  }

  /**
   * A target-scope outage observed for one environment (a classified lease
   * error, a failed probe or check, or a report). Keeps `unavailable_since`
   * while the row stays unavailable, and counts a failure when the row was
   * already unavailable. A retired row is left alone (null), and so is any row
   * for an admission reason (`isAdmissionOnlyReason`).
   */
  async function markUnavailable(environmentId: string, input: MarkUnavailableInput): Promise<AvailabilityWriteResult | null> {
    if (isAdmissionOnlyReason(input.reason)) return null;
    const now = input.now ?? new Date();
    const [result] = await writeRows(
      [environmentId],
      (previous) => (previous?.state === "retired" ? null : unavailableValues(previous, { ...input, countFailure: true }, now)),
      now,
    );
    return result ?? null;
  }

  /**
   * A sweep check or an SSH probe still finds the target down; backs off
   * further. An admission reason writes nothing (null), as in `markUnavailable`.
   */
  async function recordCheckFailure(
    environmentId: string,
    input: Omit<MarkUnavailableInput, "reason" | "source"> & { reason?: string | null; source?: "check" | "probe" },
  ): Promise<AvailabilityWriteResult | null> {
    if (isAdmissionOnlyReason(input.reason)) return null;
    const now = input.now ?? new Date();
    const [result] = await writeRows(
      [environmentId],
      (previous) => {
        if (previous?.state === "retired") return null;
        const reason = input.reason ?? (previous?.state === "unavailable" ? previous.reason : null) ?? "other";
        return unavailableValues(previous, { ...input, reason, source: input.source ?? "check", countFailure: true }, now);
      },
      now,
    );
    return result ?? null;
  }

  /**
   * The target answered (a lease or a check succeeded). Writes only an
   * `unavailable → available` transition; a missing, available or retired row
   * is left alone and `changed` is false.
   */
  async function markAvailable(
    environmentId: string,
    input: { source: EnvironmentAvailabilitySource; now?: Date },
  ): Promise<{ changed: boolean; result: AvailabilityWriteResult | null }> {
    const now = input.now ?? new Date();
    const [result] = await writeRows(
      [environmentId],
      (previous) => previous?.state !== "unavailable" ? null : {
        state: "available",
        reason: null,
        label: previous.label,
        message: null,
        targetKey: previous.targetKey,
        acceptedCredentialTypes: normalizeCredentialTypes(previous.acceptedCredentialTypes),
        unavailableSince: null,
        retryAfter: null,
        checkedAt: now,
        nextCheckAt: null,
        checkFailures: 0,
        source: input.source,
      },
      now,
    );
    return { changed: Boolean(result?.becameAvailable), result: result ?? null };
  }

  /** The target was removed: its environments refuse new runs until a report brings it back. */
  async function markRetired(
    environmentIds: readonly string[],
    input: { label?: string | null; message?: string | null; targetKey?: string | null; source?: EnvironmentAvailabilitySource; now?: Date } = {},
  ): Promise<AvailabilityWriteResult[]> {
    const now = input.now ?? new Date();
    return writeRows(environmentIds, (previous) => ({
      state: "retired",
      reason: null,
      label: input.label !== undefined ? clipAvailabilityLabel(input.label) : previous?.label ?? null,
      message: clipAvailabilityMessage(input.message),
      targetKey: input.targetKey !== undefined ? clipTargetKey(input.targetKey) : previous?.targetKey ?? null,
      acceptedCredentialTypes: normalizeCredentialTypes(previous?.acceptedCredentialTypes ?? null),
      unavailableSince: null,
      retryAfter: null,
      checkedAt: now,
      nextCheckAt: null,
      checkFailures: 0,
      source: input.source ?? "plugin_report",
    }), now);
  }

  /**
   * Writes a target's reported state onto each of its environments. Unlike
   * the run-path writers, a report may bring a retired environment back.
   * `checkedAt` is the time of the report (defaults to now); seeding from an
   * older stored report passes that report's time, so preflight never trusts
   * it beyond the usual window. An admission reason writes nothing.
   */
  async function applyTargetState(
    environmentIds: readonly string[],
    target: TargetAvailabilityState,
    input: { source?: EnvironmentAvailabilitySource; now?: Date; checkedAt?: Date | null; random?: () => number } = {},
  ): Promise<AvailabilityWriteResult[]> {
    if (target.state === "unavailable" && isAdmissionOnlyReason(target.reason)) return [];
    const now = input.now ?? new Date();
    const checkedAt = input.checkedAt ?? now;
    const source = input.source ?? "plugin_report";
    const label = clipAvailabilityLabel(target.label);
    const targetKey = target.targetKey !== undefined ? clipTargetKey(target.targetKey) : undefined;
    const acceptedCredentialTypes = target.acceptedCredentialTypes !== undefined
      ? normalizeCredentialTypes(target.acceptedCredentialTypes)
      : undefined;
    return writeRows(environmentIds, (previous) => {
      const kept = {
        label: label ?? previous?.label ?? null,
        targetKey: targetKey !== undefined ? targetKey : previous?.targetKey ?? null,
        acceptedCredentialTypes: acceptedCredentialTypes !== undefined
          ? acceptedCredentialTypes
          : normalizeCredentialTypes(previous?.acceptedCredentialTypes ?? null),
      };
      if (target.state === "unavailable") {
        // A report is fresh evidence, not a failed check: the failure count stays.
        const values = unavailableValues(previous?.state === "retired" ? null : previous, {
          reason: target.reason ?? "other",
          source,
          message: target.message ?? null,
          retryAfter: target.retryAfter ?? null,
          random: input.random,
          countFailure: false,
        }, now);
        return { ...values, ...kept, checkedAt };
      }
      return {
        state: target.state,
        reason: null,
        ...kept,
        message: target.state === "retired" ? clipAvailabilityMessage(target.message) : null,
        unavailableSince: null,
        retryAfter: null,
        checkedAt,
        nextCheckAt: null,
        checkFailures: 0,
        source,
      };
    }, now);
  }

  /**
   * Seeds a new environment's row from its device's stored target state, with
   * the report's own time as `checked_at`. Without a stored state nothing is
   * written (a missing row means available).
   */
  async function seedFromTarget(
    environmentId: string,
    target: (TargetAvailabilityState & { reportedAt: Date | string | null }) | null,
    input: { now?: Date } = {},
  ): Promise<AvailabilityWriteResult | null> {
    if (!target) return null;
    const reportedAt = toDate(target.reportedAt);
    const [result] = await applyTargetState([environmentId], target, {
      source: "plugin_report",
      now: input.now,
      checkedAt: reportedAt,
    });
    return result ?? null;
  }

  /**
   * Makes unavailable rows due for a check now. A deferral against an
   * unavailable row does this. Pass `bumpEpoch: false` when the caller's own
   * wake-epoch comparison must not see this write.
   */
  async function setDueNow(
    environmentIds: readonly string[],
    input: { now?: Date; bumpEpoch?: boolean } = {},
  ): Promise<number> {
    const ids = [...new Set(environmentIds)];
    if (ids.length === 0) return 0;
    const now = input.now ?? new Date();
    const rows = await db
      .update(environmentAvailability)
      .set({
        nextCheckAt: now,
        updatedAt: now,
        ...(input.bumpEpoch === false ? {} : { wakeEpoch: NEXT_EPOCH }),
      })
      .where(and(inArray(environmentAvailability.environmentId, ids), eq(environmentAvailability.state, "unavailable")))
      .returning({ environmentId: environmentAvailability.environmentId });
    return rows.length;
  }

  /**
   * A wake for these environments. Existing rows get a new epoch. An
   * environment without a row gets an `available` row (the same meaning as no
   * row), so a deferral that read epoch 0 still sees the wake.
   */
  async function bumpEpoch(
    environmentIds: readonly string[],
    input: { source?: EnvironmentAvailabilitySource; now?: Date } = {},
  ): Promise<Map<string, number>> {
    const epochs = new Map<string, number>();
    const ids = [...await existingEnvironmentIds(db, [...new Set(environmentIds)])];
    if (ids.length === 0) return epochs;
    const now = input.now ?? new Date();
    const rows = await db
      .insert(environmentAvailability)
      .values(ids.map((environmentId) => ({
        environmentId,
        state: "available" as const,
        source: input.source ?? "check",
        wakeEpoch: FRESH_EPOCH,
        updatedAt: now,
      })))
      .onConflictDoUpdate({
        target: environmentAvailability.environmentId,
        set: { wakeEpoch: NEXT_EPOCH, updatedAt: now },
      })
      .returning({ environmentId: environmentAvailability.environmentId, wakeEpoch: environmentAvailability.wakeEpoch });
    for (const row of rows) epochs.set(row.environmentId, Number(row.wakeEpoch));
    return epochs;
  }

  /**
   * Unavailable rows due for a check, oldest due first (`NULL` first).
   * `force` ignores `next_check_at`; `withWaitsOnly` keeps rows that an open
   * environment wait references.
   */
  async function dueChecks(input: {
    now?: Date;
    limit?: number;
    force?: boolean;
    environmentIds?: readonly string[];
    withWaitsOnly?: boolean;
  } = {}): Promise<EnvironmentAvailabilityRow[]> {
    const now = input.now ?? new Date();
    const conditions: SQL[] = [eq(environmentAvailability.state, "unavailable")];
    if (!input.force) {
      conditions.push(or(isNull(environmentAvailability.nextCheckAt), lte(environmentAvailability.nextCheckAt, now))!);
    }
    if (input.environmentIds) {
      const ids = [...new Set(input.environmentIds)];
      if (ids.length === 0) return [];
      conditions.push(inArray(environmentAvailability.environmentId, ids));
    }
    if (input.withWaitsOnly) conditions.push(openEnvironmentWaitExists());
    return db
      .select()
      .from(environmentAvailability)
      .where(and(...conditions))
      .orderBy(sql`${environmentAvailability.nextCheckAt} asc nulls first`, asc(environmentAvailability.updatedAt))
      .limit(Math.max(1, input.limit ?? 50));
  }

  /** Deletes the row once no open environment wait references it; retired rows stay. */
  async function deleteIfNoWaits(environmentId: string): Promise<boolean> {
    const rows = await db
      .delete(environmentAvailability)
      .where(and(
        eq(environmentAvailability.environmentId, environmentId),
        ne(environmentAvailability.state, "retired"),
        sql`not ${openEnvironmentWaitExists()}`,
      ))
      .returning({ environmentId: environmentAvailability.environmentId });
    return rows.length > 0;
  }

  /**
   * The sweep's cleanup: deletes rows that no open environment wait
   * references and that were last written more than `minAgeMs` ago. Retired
   * rows stay.
   */
  async function deleteRowsWithoutWaits(input: { now?: Date; minAgeMs?: number } = {}): Promise<string[]> {
    const now = input.now ?? new Date();
    const cutoff = new Date(now.getTime() - Math.max(0, input.minAgeMs ?? 0));
    const rows = await db
      .delete(environmentAvailability)
      .where(and(
        ne(environmentAvailability.state, "retired"),
        lte(environmentAvailability.updatedAt, cutoff),
        sql`not ${openEnvironmentWaitExists()}`,
      ))
      .returning({ environmentId: environmentAvailability.environmentId });
    return rows.map((row) => row.environmentId);
  }

  return {
    get,
    getMany,
    isFresh: isAvailabilityFresh,
    isFreshlyUnavailable,
    readWakeEpoch,
    readWakeEpochs,
    markUnavailable,
    recordCheckFailure,
    markAvailable,
    markRetired,
    applyTargetState,
    seedFromTarget,
    setDueNow,
    bumpEpoch,
    dueChecks,
    deleteIfNoWaits,
    deleteRowsWithoutWaits,
  };
}

export type EnvironmentAvailabilityService = ReturnType<typeof environmentAvailabilityService>;

async function existingEnvironmentIds(db: AvailabilityDb, environmentIds: readonly string[]): Promise<Set<string>> {
  if (environmentIds.length === 0) return new Set();
  const rows = await db.select({ id: environments.id }).from(environments).where(inArray(environments.id, [...environmentIds]));
  return new Set(rows.map((row) => row.id));
}

/** An open environment wait on the row's environment. */
function openEnvironmentWaitExists(): SQL {
  return sql`exists (
    select 1 from ${resourceWaitEpisodes}
    where ${resourceWaitEpisodes.environmentId} = ${environmentAvailability.environmentId}
      and ${resourceWaitEpisodes.kind} = 'environment'
      and ${resourceWaitEpisodes.resolvedAt} is null
  )`;
}
