import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import {
  type Db,
  aiAccounts,
  environmentAvailability,
  environments,
  heartbeatRuns,
  resourceWaitEpisodes,
} from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import {
  ENVIRONMENT_AVAILABILITY_LIMITS,
  environmentAvailabilityService,
  type EnvironmentAvailabilityRow,
} from "../environment-availability.js";
import { probeEnvironment } from "../environment-probe.js";
import { environmentService } from "../environments.js";
import { devicesForEnvironmentIds, pruneRunSlots } from "../execution-devices.js";
import type { PluginWorkerManager } from "../plugin-worker-manager.js";
import { isBuiltinSandboxProvider } from "../sandbox-provider-runtime.js";
import { classifySshFailure, isSshConfigurationFailure } from "./classify.js";
import { handOverOrAbandon } from "./episodes.js";
import type { ResourceWaitNotifier } from "./notify.js";
import { checkTargetAvailability } from "./plugin-check.js";
import { RESOURCE_WAIT_TIMINGS, type ResourceWaitEpisodeRow } from "./types.js";
import { wakeResourceWaits } from "./wake.js";

/**
 * Fork: `sweepResourceWaits` (spec 7.4), a scheduler job of its own, guarded
 * by `pg_try_advisory_xact_lock(hashtext('resource-wait-sweep'))` so one
 * server process runs a pass at a time. Each pass:
 *
 * 1. checks up to 5 due unavailable environments that have waits, in
 *    parallel across devices and one at a time per device, 15 s each: SSH
 *    through `probeEnvironment` in a waiting run's company, plugin sandboxes
 *    through `environmentCheckAvailability` only. A target that answers
 *    becomes available and its target-scope waits wake; one still down backs
 *    off. A row whose backoff would carry its next check past the 10-minute
 *    trust window is checked a minute before it goes stale instead, unless
 *    the target asked for a later retry. When nothing can tell (no check
 *    method, a timeout), the row is left to go stale, and the oldest wait on
 *    it makes one real attempt (see the hold);
 * 2. clears probe claims whose run ended, or did not start within 15 min;
 * 3. prunes run slots of runs that ended over 24 h ago;
 * 4. abandons episodes whose current run ended 10 min ago without a newer
 *    lane run (another run of the chain that waits for the same resource
 *    takes the episode over instead);
 * 5. deletes registry rows without waits (retired rows stay; fresh rows stay
 *    until they would be stale anyway);
 * 6. sends due notices (spec 8).
 *
 * With the kill switch set it only wakes every environment wait once per
 * pass, so each makes a real attempt under the old rules.
 */

export const RESOURCE_WAIT_SWEEP_LOCK_KEY = "resource-wait-sweep";

export interface SweepRuntime {
  db: Db;
  pluginWorkerManager?: PluginWorkerManager | null;
  notifier: ResourceWaitNotifier;
  clock: () => Date;
  random: () => number;
  environmentWaitsEnabled: boolean;
  onEpisodeEnded: (episode: ResourceWaitEpisodeRow) => Promise<void>;
}

export type EnvironmentCheckState = "available" | "unavailable" | "unknown";

export interface EnvironmentCheckResult {
  environmentId: string;
  state: EnvironmentCheckState;
  /** The registry reason after a failed check. */
  reason: string | null;
  /** How the check went: `probe`, `plugin:<detail>`, `local`, `timeout`, … */
  detail: string;
  /** The registry row moved from unavailable to available. */
  becameAvailable: boolean;
  /** Target-scope waits woken by the transition. */
  woken: number;
}

export interface SweepPassResult {
  skipped: boolean;
  checks: EnvironmentCheckResult[];
  probesCleared: number;
  slotsPruned: number;
  episodesAbandoned: number;
  registryRowsDeleted: number;
  notices: { immediate: number; long: number };
  killSwitchWoken: number;
}

type EnvironmentRow = typeof environments.$inferSelect;

class SweepCheckTimeout extends Error {}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SweepCheckTimeout("availability check timed out")), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function createSweep(runtime: SweepRuntime) {
  const { db } = runtime;
  const availability = environmentAvailabilityService(db);

  /**
   * Nothing could tell whether the target is back: check again when the row
   * goes stale (its oldest wait then makes a real attempt), or in a minute
   * once it is. The epoch and `checked_at` stay as they are.
   */
  async function deferCheck(row: EnvironmentAvailabilityRow | null, environmentId: string, now: Date): Promise<void> {
    const staleAt = (row?.checkedAt ?? now).getTime() + ENVIRONMENT_AVAILABILITY_LIMITS.trustMs;
    const next = new Date(staleAt > now.getTime() ? staleAt : now.getTime() + RESOURCE_WAIT_TIMINGS.recheckMs);
    await db
      .update(environmentAvailability)
      .set({ nextCheckAt: next, updatedAt: now })
      .where(and(eq(environmentAvailability.environmentId, environmentId), eq(environmentAvailability.state, "unavailable")));
  }

  async function wakeTarget(environmentId: string, now: Date): Promise<number> {
    return (await wakeResourceWaits(db, { environmentIds: [environmentId], scopes: ["target"] }, { now })).runIds.length;
  }

  /**
   * One availability check of an environment, in a company's context (SSH
   * secrets and plugin calls are company-scoped). Writes the registry and
   * wakes target-scope waits when the target came back. Never writes ssh
   * stderr, a host or a port into the registry.
   */
  async function checkEnvironment(
    environment: EnvironmentRow,
    input: { companyId: string | null; now?: Date; timeoutMs?: number; deviceName?: string | null },
  ): Promise<EnvironmentCheckResult> {
    const now = input.now ?? runtime.clock();
    const timeoutMs = input.timeoutMs ?? RESOURCE_WAIT_TIMINGS.checkTimeoutMs;
    const row = await availability.get(environment.id);
    const base = { environmentId: environment.id, reason: null, becameAvailable: false, woken: 0 };
    const available = async (detail: string, source: "check" | "probe"): Promise<EnvironmentCheckResult> => {
      const { changed } = await availability.markAvailable(environment.id, { source, now });
      return { ...base, state: "available", detail, becameAvailable: changed, woken: changed ? await wakeTarget(environment.id, now) : 0 };
    };
    const unknown = async (detail: string): Promise<EnvironmentCheckResult> => {
      await deferCheck(row, environment.id, now);
      return { ...base, state: "unknown", detail };
    };

    if (environment.driver === "local") return available("local", "check");

    if (environment.driver === "ssh") {
      if (!input.companyId) return unknown("no_company");
      const shared = await environmentService(db).getById(environment.id);
      if (!shared) return unknown("missing");
      let probe: Awaited<ReturnType<typeof probeEnvironment>>;
      try {
        probe = await withTimeout(probeEnvironment(db, shared, { companyId: input.companyId }), timeoutMs);
      } catch (error) {
        return unknown(error instanceof SweepCheckTimeout ? "timeout" : "probe_error");
      }
      if (probe.ok) return available("probe", "probe");
      const details = (probe.details ?? {}) as Record<string, unknown>;
      const stderr = typeof details.error === "string" ? details.error : "";
      const failure = classifySshFailure({ code: details.code, stderr });
      if (failure?.scope === "target") {
        await availability.recordCheckFailure(environment.id, {
          reason: failure.reason,
          source: "probe",
          label: input.deviceName ?? row?.label ?? null,
          message: null,
          now,
          random: runtime.random,
        });
        return { ...base, state: "unavailable", reason: failure.reason, detail: "probe" };
      }
      // The host answered: it refused the login, or the remote command itself failed.
      const answered = typeof details.code === "number" && (details.code !== 255 || isSshConfigurationFailure(stderr));
      if (!failure && answered) return available("probe_answered", "probe");
      // A busy sshd, a killed probe, an unknown ssh error or a local failure tells nothing about the host.
      return unknown(failure ? "throttled" : "probe_inconclusive");
    }

    if (environment.driver === "sandbox") {
      const provider = typeof environment.config?.provider === "string" ? environment.config.provider : null;
      if (!provider || isBuiltinSandboxProvider(provider) || !input.companyId) return unknown("unsupported");
      const check = await checkTargetAvailability({
        db,
        pluginWorkerManager: runtime.pluginWorkerManager,
        environment,
        companyId: input.companyId,
        timeoutMs: Math.min(timeoutMs, RESOURCE_WAIT_TIMINGS.pluginCheckTimeoutMs),
        now,
      });
      if (check.availability.state === "available") return available(`plugin:${check.detail}`, "check");
      if (check.availability.state === "unavailable") {
        const envelope = check.availability.unavailable;
        await availability.recordCheckFailure(environment.id, {
          reason: envelope.reason,
          source: "check",
          label: envelope.targetLabel ?? input.deviceName ?? row?.label ?? null,
          message: envelope.message ?? null,
          retryAfter: envelope.retryAfter ?? null,
          now,
          random: runtime.random,
        });
        return { ...base, state: "unavailable", reason: envelope.reason, detail: `plugin:${check.detail}` };
      }
      return unknown(`plugin:${check.detail}`);
    }
    return unknown("unsupported_driver");
  }

  /** The company of the oldest open wait on each environment (the check runs in a waiting run's context). */
  async function waitingCompanies(environmentIds: readonly string[]): Promise<Map<string, string>> {
    if (environmentIds.length === 0) return new Map();
    const rows = await db
      .select({ environmentId: resourceWaitEpisodes.environmentId, companyId: resourceWaitEpisodes.companyId })
      .from(resourceWaitEpisodes)
      .where(and(
        inArray(resourceWaitEpisodes.environmentId, [...environmentIds]),
        eq(resourceWaitEpisodes.kind, "environment"),
        isNull(resourceWaitEpisodes.resolvedAt),
      ))
      .orderBy(asc(resourceWaitEpisodes.since));
    const companies = new Map<string, string>();
    for (const row of rows) {
      if (row.environmentId && !companies.has(row.environmentId)) companies.set(row.environmentId, row.companyId);
    }
    return companies;
  }

  /**
   * Checks environments in parallel across devices and one after another on
   * the same device (parallel SSH connections to one host look like a burst).
   */
  async function checkEnvironments(
    environmentRows: EnvironmentRow[],
    companyOf: (environmentId: string) => string | null,
    now: Date,
  ): Promise<EnvironmentCheckResult[]> {
    const devices = await devicesForEnvironmentIds(db, environmentRows.map((row) => row.id), { create: false });
    const groups = new Map<string, EnvironmentRow[]>();
    for (const environment of environmentRows) {
      const key = devices.get(environment.id)?.id ?? `environment:${environment.id}`;
      const list = groups.get(key) ?? [];
      list.push(environment);
      groups.set(key, list);
    }
    const results = await Promise.all([...groups.values()].map(async (group) => {
      const out: EnvironmentCheckResult[] = [];
      for (const environment of group) {
        try {
          out.push(await checkEnvironment(environment, {
            companyId: companyOf(environment.id),
            now,
            deviceName: devices.get(environment.id)?.name ?? null,
          }));
        } catch (error) {
          logger.warn({ err: error, environmentId: environment.id }, "resource wait availability check failed");
          out.push({ environmentId: environment.id, state: "unknown", reason: null, detail: "error", becameAvailable: false, woken: 0 });
        }
      }
      return out;
    }));
    return results.flat();
  }

  async function clearStaleProbes(now: Date): Promise<number> {
    const startedBy = new Date(now.getTime() - RESOURCE_WAIT_TIMINGS.probeStartTimeoutMs).toISOString();
    const rows = await db
      .update(aiAccounts)
      .set({ limitProbeRunId: null })
      .where(and(
        isNotNull(aiAccounts.limitProbeRunId),
        sql`not exists (
          select 1 from ${heartbeatRuns}
          where ${heartbeatRuns.id} = ${aiAccounts.limitProbeRunId}
            and (
              ${heartbeatRuns.status} = 'running'
              or (${heartbeatRuns.status} in ('queued', 'scheduled_retry') and ${heartbeatRuns.updatedAt} >= ${startedBy}::timestamptz)
            )
        )`,
      ))
      .returning({ id: aiAccounts.id });
    return rows.length;
  }

  async function abandonEndedEpisodes(now: Date): Promise<number> {
    const before = new Date(now.getTime() - RESOURCE_WAIT_TIMINGS.abandonGraceMs).toISOString();
    const stale = await db
      .select({ episode: resourceWaitEpisodes })
      .from(resourceWaitEpisodes)
      .leftJoin(heartbeatRuns, eq(heartbeatRuns.id, resourceWaitEpisodes.currentRunId))
      .where(and(
        isNull(resourceWaitEpisodes.resolvedAt),
        sql`(
          (${resourceWaitEpisodes.currentRunId} is null and ${resourceWaitEpisodes.updatedAt} < ${before}::timestamptz)
          or (${resourceWaitEpisodes.currentRunId} is not null and ${heartbeatRuns.id} is null)
          or (${heartbeatRuns.status} not in ('queued', 'running', 'scheduled_retry')
              and coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.updatedAt}) < ${before}::timestamptz)
        )`,
      ))
      .limit(100);
    let abandoned = 0;
    for (const { episode } of stale) {
      const { abandoned: ended } = await handOverOrAbandon(db, episode, episode.currentRunId ? [episode.currentRunId] : [], now);
      if (!ended) continue;
      abandoned += 1;
      await runtime.onEpisodeEnded(ended).catch(() => undefined);
    }
    return abandoned;
  }

  /**
   * Unavailable rows with environment waits whose next scheduled check would
   * land after they go stale (a backoff past the trust window): checked a
   * minute before they would go stale. A target that asked for a later retry
   * is left alone, and so is a row whose last check told nothing (`deferCheck`
   * puts its next check exactly at the moment it goes stale).
   */
  async function rowsAboutToGoStale(now: Date, limit: number, exclude: readonly string[]): Promise<EnvironmentAvailabilityRow[]> {
    if (limit <= 0) return [];
    const { trustMs } = ENVIRONMENT_AVAILABILITY_LIMITS;
    return db
      .select()
      .from(environmentAvailability)
      .where(and(
        eq(environmentAvailability.state, "unavailable"),
        gt(environmentAvailability.checkedAt, new Date(now.getTime() - trustMs)),
        lte(environmentAvailability.checkedAt, new Date(now.getTime() - (trustMs - RESOURCE_WAIT_TIMINGS.staleRefreshLeadMs))),
        sql`${environmentAvailability.nextCheckAt} > ${environmentAvailability.checkedAt} + make_interval(secs => ${trustMs / 1000}::double precision)`,
        or(isNull(environmentAvailability.retryAfter), lte(environmentAvailability.retryAfter, now)),
        exclude.length > 0 ? notInArray(environmentAvailability.environmentId, [...exclude]) : undefined,
        sql`exists (
          select 1 from ${resourceWaitEpisodes}
          where ${resourceWaitEpisodes.environmentId} = ${environmentAvailability.environmentId}
            and ${resourceWaitEpisodes.kind} = 'environment'
            and ${resourceWaitEpisodes.resolvedAt} is null
        )`,
      ))
      .orderBy(asc(environmentAvailability.checkedAt))
      .limit(limit);
  }

  async function step<T>(name: string, fallback: T, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      logger.warn({ err: error, step: name }, "resource wait sweep step failed");
      return fallback;
    }
  }

  async function runPass(input: { now: Date; force: boolean }): Promise<SweepPassResult> {
    const { now } = input;
    const result: SweepPassResult = {
      skipped: false,
      checks: [],
      probesCleared: 0,
      slotsPruned: 0,
      episodesAbandoned: 0,
      registryRowsDeleted: 0,
      notices: { immediate: 0, long: 0 },
      killSwitchWoken: 0,
    };
    if (!runtime.environmentWaitsEnabled) {
      result.killSwitchWoken = await step("kill_switch_wake", 0, async () =>
        (await wakeResourceWaits(db, { kinds: ["environment"] }, { now })).runIds.length);
    } else {
      result.checks = await step("checks", [] as EnvironmentCheckResult[], async () => {
        const due = await availability.dueChecks({
          now,
          limit: RESOURCE_WAIT_TIMINGS.sweepChecksPerPass,
          force: input.force,
          withWaitsOnly: true,
        });
        // `force` already ignores next_check_at.
        const refresh = input.force
          ? []
          : await rowsAboutToGoStale(now, RESOURCE_WAIT_TIMINGS.sweepChecksPerPass - due.length, due.map((row) => row.environmentId));
        const ids = [...due, ...refresh].map((row) => row.environmentId);
        if (ids.length === 0) return [];
        const rows = await db.select().from(environments).where(inArray(environments.id, ids));
        const companies = await waitingCompanies(rows.map((row) => row.id));
        return checkEnvironments(rows, (id) => companies.get(id) ?? null, now);
      });
    }
    result.probesCleared = await step("probes", 0, () => clearStaleProbes(now));
    result.slotsPruned = await step("slots", 0, () => pruneRunSlots(db, { now }));
    result.episodesAbandoned = await step("episodes", 0, () => abandonEndedEpisodes(now));
    result.registryRowsDeleted = await step("registry", 0, async () =>
      (await availability.deleteRowsWithoutWaits({ now, minAgeMs: ENVIRONMENT_AVAILABILITY_LIMITS.trustMs })).length);
    result.notices = await step("notices", { immediate: 0, long: 0 }, () => runtime.notifier.runNotifyPass({ now }));
    return result;
  }

  /**
   * One sweep pass. Skipped (`skipped: true`) while another process runs one.
   * `force` checks environments whose next check is not due yet.
   */
  async function sweepResourceWaits(input: { now?: Date; force?: boolean } = {}): Promise<SweepPassResult> {
    const now = input.now ?? runtime.clock();
    // The transaction only holds the advisory lock; the pass itself uses the
    // pool, so no row lock is held across plugin calls and probes.
    return db.transaction(async (tx) => {
      const [lock] = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtext(${RESOURCE_WAIT_SWEEP_LOCK_KEY})) as locked`,
      );
      if (!lock?.locked) {
        return {
          skipped: true,
          checks: [],
          probesCleared: 0,
          slotsPruned: 0,
          episodesAbandoned: 0,
          registryRowsDeleted: 0,
          notices: { immediate: 0, long: 0 },
          killSwitchWoken: 0,
        };
      }
      return runPass({ now, force: input.force === true });
    });
  }

  return { sweepResourceWaits, checkEnvironment, checkEnvironments };
}

export type ResourceWaitSweep = ReturnType<typeof createSweep>;
