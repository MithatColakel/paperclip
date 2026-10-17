import { and, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { environments, heartbeatRuns, plugins, resourceWaitEpisodes } from "@paperclipai/db";
import {
  RESOURCE_WAIT_RETRY_REASONS,
  type ResourceWaitKind,
  type ResourceWaitReason,
  type ResourceWaitScope,
} from "@paperclipai/shared";
import { environmentAvailabilityService } from "../environment-availability.js";
import { environmentsForDevice } from "../execution-devices.js";
import type { ResourceWaitDb } from "./types.js";

/**
 * Fork: resume triggers (spec 7.5). A wake makes matching waiting runs due
 * now (or now plus a per-run jitter) by moving `scheduled_retry_at`; the hold
 * then re-checks them, so a wake never starts work by itself. A row due
 * earlier keeps its time, but its `updated_at` still moves, so a hold that
 * read it before the wake loses its compare-and-set and the row stays due.
 *
 * A waiting run matches through the open episode it is the current run of,
 * or through its own `contextSnapshot.resourceWait` (a second agent waiting
 * on the same issue, or a run whose episode ended). Matching episodes also
 * drop their admission backoff (`next_check_at`) first, so a driver's wake
 * gets the episode's wait one real attempt at once; a joined wait for the
 * same resource keeps its own backoff and follows once that attempt ends the
 * wait.
 *
 * Environment and device wakes also bump the environments' wake epochs, so a
 * deferral racing the wake (its successor not inserted yet) still notices it
 * (spec 7.3 step 5). Account and binding wakes rely on the waker's own write
 * to `ai_accounts` or the binding row, which moves `updated_at`.
 *
 * Every given filter field must match. A filter without a selector
 * (environments, devices, accounts, agents, runs, a plugin or kinds) wakes
 * nothing.
 */

export interface ResourceWaitWakeFilter {
  environmentIds?: readonly string[];
  /** The device's waits: episodes on the device and on its environments. */
  deviceIds?: readonly string[];
  accountIds?: readonly string[];
  agentIds?: readonly string[];
  runIds?: readonly string[];
  /** Waits on environments of the plugin's sandbox providers (a plugin enabled or loaded). */
  pluginId?: string;
  companyId?: string;
  kinds?: readonly ResourceWaitKind[];
  scopes?: readonly ResourceWaitScope[];
  reasons?: readonly ResourceWaitReason[];
}

export interface ResourceWaitWakeOptions {
  now?: Date;
  /** Spread the woken runs over 0..jitterMs, by run id (staggered resumes after a limit). */
  jitterMs?: number;
}

export interface ResourceWaitWakeResult {
  runIds: string[];
  agentIds: string[];
  companyIds: string[];
}

const EMPTY_RESULT: ResourceWaitWakeResult = { runIds: [], agentIds: [], companyIds: [] };

/**
 * `updated_at` for a write that a hold's compare-and-set must notice: never
 * equal to the value it replaces, even within one clock tick.
 */
export function touchedAt(now: Date) {
  return sql`greatest(${now.toISOString()}::timestamptz, ${heartbeatRuns.updatedAt} + interval '1 microsecond')`;
}

function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

/** A field of a lane run's `contextSnapshot.resourceWait`, as text. */
function contextField(field: string): SQL {
  return sql`(${heartbeatRuns.contextSnapshot} -> 'resourceWait' ->> ${field})`;
}

function textIn(expression: SQL, values: readonly string[]): SQL {
  return sql`${expression} in (${sql.join(values.map((value) => sql`${value}`), sql`, `)})`;
}

/** The active sandbox environments of the sandbox providers a plugin declares. */
export async function environmentIdsForPlugin(db: ResourceWaitDb, pluginId: string): Promise<string[]> {
  const [plugin] = await db.select({ manifest: plugins.manifestJson }).from(plugins).where(eq(plugins.id, pluginId));
  const providers = unique((plugin?.manifest?.environmentDrivers ?? [])
    .filter((driver) => driver?.kind === "sandbox_provider" && typeof driver.driverKey === "string")
    .map((driver) => driver.driverKey));
  if (providers.length === 0) return [];
  const rows = await db
    .select({ id: environments.id })
    .from(environments)
    .where(and(
      eq(environments.driver, "sandbox"),
      sql`${environments.config} ->> 'provider' in (${sql.join(providers.map((provider) => sql`${provider}`), sql`, `)})`,
    ));
  return rows.map((row) => row.id);
}

export async function wakeResourceWaits(
  db: ResourceWaitDb,
  filter: ResourceWaitWakeFilter,
  options: ResourceWaitWakeOptions = {},
): Promise<ResourceWaitWakeResult> {
  const hasSelector = Boolean(
    filter.environmentIds?.length || filter.deviceIds?.length || filter.accountIds?.length ||
    filter.agentIds?.length || filter.runIds?.length || filter.pluginId || filter.kinds?.length,
  );
  if (!hasSelector) return EMPTY_RESULT;
  const now = options.now ?? new Date();
  // Episodes match on their own fields; runs that own no episode on their context's.
  const conditions: SQL[] = [isNull(resourceWaitEpisodes.resolvedAt)];
  const contextConditions: SQL[] = [sql`${contextField("episodeId")} is not null`];
  const epochEnvironmentIds = new Set<string>();

  if (filter.environmentIds) {
    const ids = unique(filter.environmentIds);
    if (ids.length === 0) return EMPTY_RESULT;
    conditions.push(inArray(resourceWaitEpisodes.environmentId, ids));
    contextConditions.push(textIn(contextField("environmentId"), ids));
    for (const id of ids) epochEnvironmentIds.add(id);
  }
  if (filter.deviceIds) {
    const deviceIds = unique(filter.deviceIds);
    if (deviceIds.length === 0) return EMPTY_RESULT;
    const deviceEnvironmentIds: string[] = [];
    for (const deviceId of deviceIds) {
      for (const { environment } of await environmentsForDevice(db, deviceId)) deviceEnvironmentIds.push(environment.id);
    }
    for (const id of deviceEnvironmentIds) epochEnvironmentIds.add(id);
    const environmentIds = unique(deviceEnvironmentIds);
    conditions.push(or(
      inArray(resourceWaitEpisodes.deviceId, deviceIds),
      environmentIds.length > 0 ? inArray(resourceWaitEpisodes.environmentId, environmentIds) : undefined,
    )!);
    contextConditions.push(or(
      textIn(contextField("deviceId"), deviceIds),
      environmentIds.length > 0 ? textIn(contextField("environmentId"), environmentIds) : undefined,
    )!);
  }
  if (filter.pluginId) {
    const pluginEnvironmentIds = await environmentIdsForPlugin(db, filter.pluginId);
    if (pluginEnvironmentIds.length === 0) return EMPTY_RESULT;
    conditions.push(inArray(resourceWaitEpisodes.environmentId, pluginEnvironmentIds));
    contextConditions.push(textIn(contextField("environmentId"), pluginEnvironmentIds));
    for (const id of pluginEnvironmentIds) epochEnvironmentIds.add(id);
  }
  if (filter.accountIds) {
    const ids = unique(filter.accountIds);
    if (ids.length === 0) return EMPTY_RESULT;
    conditions.push(inArray(resourceWaitEpisodes.accountId, ids));
    contextConditions.push(textIn(contextField("accountId"), ids));
  }
  if (filter.agentIds) {
    const ids = unique(filter.agentIds);
    if (ids.length === 0) return EMPTY_RESULT;
    conditions.push(inArray(resourceWaitEpisodes.agentId, ids));
    contextConditions.push(inArray(heartbeatRuns.agentId, ids));
  }
  if (filter.runIds) {
    const ids = unique(filter.runIds);
    if (ids.length === 0) return EMPTY_RESULT;
    conditions.push(inArray(resourceWaitEpisodes.currentRunId, ids));
    contextConditions.push(inArray(heartbeatRuns.id, ids));
  }
  if (filter.companyId) {
    conditions.push(eq(resourceWaitEpisodes.companyId, filter.companyId));
    contextConditions.push(eq(heartbeatRuns.companyId, filter.companyId));
  }
  if (filter.kinds?.length) {
    conditions.push(inArray(resourceWaitEpisodes.kind, unique(filter.kinds)));
    contextConditions.push(textIn(contextField("kind"), unique(filter.kinds)));
  }
  if (filter.scopes?.length) {
    conditions.push(inArray(resourceWaitEpisodes.scope, unique(filter.scopes)));
    contextConditions.push(textIn(contextField("scope"), unique(filter.scopes)));
  }
  if (filter.reasons?.length) {
    conditions.push(inArray(resourceWaitEpisodes.reason, unique(filter.reasons)));
    contextConditions.push(textIn(contextField("reason"), unique(filter.reasons)));
  }

  // The epoch moves first: a deferral that inserts its successor after the
  // update below still sees that a wake happened.
  if (epochEnvironmentIds.size > 0) {
    await environmentAvailabilityService(db).bumpEpoch([...epochEnvironmentIds], { now });
  }
  // Then the backoff goes, before the runs move: a hold that sees a run this
  // wake made due also sees its episode due.
  await db
    .update(resourceWaitEpisodes)
    .set({ nextCheckAt: null, updatedAt: now })
    .where(and(...conditions, isNotNull(resourceWaitEpisodes.nextCheckAt)));

  const jitterMs = Math.max(0, Math.floor(options.jitterMs ?? 0));
  const dueAt = jitterMs > 0
    ? sql`${now.toISOString()}::timestamptz + make_interval(secs => ${jitterMs / 1000}::double precision * ((hashtext(${heartbeatRuns.id}::text)::bigint & 1023)::double precision / 1023.0))`
    : sql`${now.toISOString()}::timestamptz`;
  // A row that is due already keeps its time, but `updated_at` still moves:
  // a hold that read it before this wake then loses its compare-and-set.
  const rows = await db
    .update(heartbeatRuns)
    .set({ scheduledRetryAt: sql`least(${heartbeatRuns.scheduledRetryAt}, ${dueAt})`, updatedAt: touchedAt(now) })
    .where(and(
      eq(heartbeatRuns.status, "scheduled_retry"),
      inArray(heartbeatRuns.scheduledRetryReason, [...RESOURCE_WAIT_RETRY_REASONS]),
      or(
        inArray(
          heartbeatRuns.id,
          db.select({ id: sql<string>`${resourceWaitEpisodes.currentRunId}` }).from(resourceWaitEpisodes).where(and(...conditions)),
        ),
        and(...contextConditions),
      ),
    ))
    .returning({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, companyId: heartbeatRuns.companyId });
  return {
    runIds: rows.map((row) => row.id),
    agentIds: unique(rows.map((row) => row.agentId)),
    companyIds: unique(rows.map((row) => row.companyId)),
  };
}
