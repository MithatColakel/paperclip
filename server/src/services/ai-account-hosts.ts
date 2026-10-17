import { and, asc, eq, inArray, isNull, ne, notInArray, sql } from "drizzle-orm";
import {
  type Db,
  agents,
  aiAccountHostEnvironments,
  aiAccountHosts,
  aiAccountProjects,
  aiAccounts,
  authUsers,
  companies,
  costEvents,
  environments,
  heartbeatRuns,
  projects,
} from "@paperclipai/db";
import {
  AI_ACCOUNT_HOST_CREATABLE_KINDS,
  MAX_AI_ACCOUNTS_PER_HOST,
  type AiAccountHostEnvironmentSummary,
  type AiAccountHostKind,
  type AiAccountHostSummary,
  type AiAccountHostsResponse,
  type AiAccountOrigin,
  type AiAccountOwnerRef,
  type AiAccountProjectSummary,
  type AiAccountSummary,
  type AiAccountUsage,
  type AiAccountUsageWindow,
  type CreateAiAccountHost,
  type DeviceAccountLimitErrorDetails,
  type UpdateAiAccountHost,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { isUniqueViolation } from "./ai-account-credentials.js";
import { maskEmail, recheckDeviceLimits } from "./ai-account-pool.js";
import {
  acquireBindingsLock,
  boundAccountsByDevice,
  candidateDevicesForAgents,
  capOf,
  devicesForEnvironmentIds,
  type DeviceDb,
} from "./execution-devices.js";
import { effectiveAccountOwner } from "./resource-waits/account-plan.js";
import { wakeResourceWaits, type ResourceWaitWakeFilter } from "./resource-waits/wake.js";

/**
 * Fork: the legacy host routes' service, now instance-admin administration of
 * execution devices (see doc/plans/2026-10-14-host-ai-account-pools.md and
 * spec 6, 12 and 15.5). A host row is an execution device. Its accounts are
 * user-owned pool accounts, which the account-pool service manages and binds
 * per agent; this service only lists the ones first added to a host. It never
 * chooses an account for a run: Paperclip never moves a task to another
 * account.
 *
 * Instance-level by design: a machine serves every company's runs. Routes
 * restrict every call to instance admins, and log a device change only in the
 * companies whose agents use the device.
 */

type AccountRow = typeof aiAccounts.$inferSelect;
type HostRow = typeof aiAccountHosts.$inferSelect;

/** Which environment drivers an explicit mapping may put on each device kind (spec 6.1). */
const DRIVERS_FOR_KIND: Record<AiAccountHostKind, readonly string[]> = {
  server: ["local"],
  ssh_host: ["ssh"],
  // A computer reached over SSH that an environment driver plugin may also manage.
  mac: ["ssh", "sandbox"],
  // A device an environment driver plugin reported: only its sandbox environments attach to it.
  external: ["sandbox"],
};

/** An API key whose credit ran out; it does not reset with the usage windows. */
export function isCreditBalanceFailure(text: string | null | undefined): boolean {
  return Boolean(text && /credit\s+balance\s+is\s+too\s+low/i.test(text));
}

/** A legacy host account as instance admins see it: with its effective owner and origin. */
export interface AiAccountHostAccountView extends AiAccountSummary {
  /** Null for a legacy account without an owner. */
  owner: AiAccountOwnerRef | null;
  origin: AiAccountOrigin;
}

export interface AiAccountHostsView extends AiAccountHostsResponse {
  hosts: Array<AiAccountHostSummary & { accounts: AiAccountHostAccountView[] }>;
}

function iso(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

/**
 * Runs that used a pool account: legacy host-pool runs and pool runs. Both
 * record the account in `contextSnapshot.aiConnection.accountId`.
 */
const POOL_ATTRIBUTED = sql`${heartbeatRuns.contextSnapshot} -> 'aiConnection' ->> 'mode' in ('host_pool', 'pool_account')`;

const EMPTY_USAGE_WINDOW: AiAccountUsageWindow = { runs: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costCents: 0 };
const EMPTY_USAGE: AiAccountUsage = { lastFiveHours: EMPTY_USAGE_WINDOW, lastSevenDays: EMPTY_USAGE_WINDOW, thisMonth: EMPTY_USAGE_WINDOW };

function summarizeAccount(
  row: AccountRow,
  runningRuns: number,
  reservedFor: AiAccountProjectSummary[],
  usage: AiAccountUsage,
  owner: AiAccountOwnerRef | null,
): AiAccountHostAccountView {
  return {
    id: row.id,
    hostId: row.hostId,
    provider: "anthropic",
    credentialType: row.credentialType,
    label: row.label,
    // Only the owner sees the hint unmasked (`/api/me/ai-accounts`); instance admins see it masked.
    emailHint: maskEmail(row.emailHint),
    plan: row.plan,
    poolEnabled: row.poolEnabled,
    status: row.status,
    statusMessage: row.statusMessage,
    credentialHint: row.credentialHint,
    exhaustedUntil: iso(row.exhaustedUntil),
    limitReason: row.limitReason,
    lastLimitedAt: iso(row.lastLimitedAt),
    usage,
    runningRuns,
    projects: reservedFor,
    lastSelectedAt: iso(row.lastSelectedAt),
    lastUsedAt: iso(row.lastUsedAt),
    createdAt: row.createdAt.toISOString(),
    owner,
    origin: row.origin,
  };
}

export function aiAccountHostService(db: Db) {
  /** Running runs per account, legacy host-pool and pool runs alike. */
  async function runningCounts(): Promise<Map<string, number>> {
    const accountId = sql<string>`${heartbeatRuns.contextSnapshot} -> 'aiConnection' ->> 'accountId'`;
    const rows = await db
      .select({ accountId, count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.status, "running"), POOL_ATTRIBUTED))
      .groupBy(accountId);
    return new Map(rows.filter((row) => row.accountId).map((row) => [row.accountId, Number(row.count)]));
  }

  async function reservationsFor(accountIds: string[]) {
    const map = new Map<string, Set<string>>();
    if (accountIds.length === 0) return map;
    const rows = await db.select().from(aiAccountProjects).where(inArray(aiAccountProjects.accountId, accountIds));
    for (const row of rows) {
      const set = map.get(row.accountId) ?? new Set<string>();
      set.add(row.projectId);
      map.set(row.accountId, set);
    }
    return map;
  }

  async function projectSummaries(projectIds?: string[]): Promise<AiAccountProjectSummary[]> {
    if (projectIds && projectIds.length === 0) return [];
    const rows = await db
      .select({ id: projects.id, name: projects.name, companyId: companies.id, companyName: companies.name, issuePrefix: companies.issuePrefix })
      .from(projects)
      .innerJoin(companies, eq(companies.id, projects.companyId))
      .where(projectIds ? inArray(projects.id, projectIds) : and(isNull(projects.archivedAt), sql`${companies.status} <> 'archived'`))
      .orderBy(asc(companies.name), asc(projects.name));
    return rows.map((row) => ({ ...row, issuePrefix: row.issuePrefix ?? "" }));
  }

  /** Paperclip's own use of each account, from the cost events of its legacy host-pool and pool runs. */
  async function usageByAccount(now = new Date()): Promise<Map<string, AiAccountUsage>> {
    const fiveHoursAgo = new Date(now.getTime() - 5 * 60 * 60 * 1000).toISOString();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const since = sevenDaysAgo < monthStart ? sevenDaysAgo : monthStart;
    const accountId = sql<string>`${heartbeatRuns.contextSnapshot} -> 'aiConnection' ->> 'accountId'`;
    const windowSums = (from: string) => ({
      runs: sql<number>`count(distinct ${costEvents.heartbeatRunId}) filter (where ${costEvents.occurredAt} >= ${from}::timestamptz)::int`,
      inputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}) filter (where ${costEvents.occurredAt} >= ${from}::timestamptz), 0)::bigint`,
      cachedInputTokens: sql<number>`coalesce(sum(${costEvents.cachedInputTokens}) filter (where ${costEvents.occurredAt} >= ${from}::timestamptz), 0)::bigint`,
      outputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}) filter (where ${costEvents.occurredAt} >= ${from}::timestamptz), 0)::bigint`,
      costCents: sql<number>`coalesce(sum(${costEvents.costCents}) filter (where ${costEvents.occurredAt} >= ${from}::timestamptz), 0)::bigint`,
    });
    const five = windowSums(fiveHoursAgo);
    const seven = windowSums(sevenDaysAgo);
    const month = windowSums(monthStart);
    const rows = await db
      .select({
        accountId,
        f_runs: five.runs, f_in: five.inputTokens, f_cached: five.cachedInputTokens, f_out: five.outputTokens, f_cost: five.costCents,
        s_runs: seven.runs, s_in: seven.inputTokens, s_cached: seven.cachedInputTokens, s_out: seven.outputTokens, s_cost: seven.costCents,
        m_runs: month.runs, m_in: month.inputTokens, m_cached: month.cachedInputTokens, m_out: month.outputTokens, m_cost: month.costCents,
      })
      .from(costEvents)
      .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, costEvents.heartbeatRunId))
      .where(and(sql`${costEvents.occurredAt} >= ${since}::timestamptz`, POOL_ATTRIBUTED))
      .groupBy(accountId);
    const window = (runs: unknown, input: unknown, cached: unknown, output: unknown, cost: unknown): AiAccountUsageWindow => ({
      runs: Number(runs ?? 0),
      inputTokens: Number(input ?? 0),
      cachedInputTokens: Number(cached ?? 0),
      outputTokens: Number(output ?? 0),
      costCents: Number(cost ?? 0),
    });
    return new Map(rows.filter((row) => row.accountId).map((row) => [row.accountId, {
      lastFiveHours: window(row.f_runs, row.f_in, row.f_cached, row.f_out, row.f_cost),
      lastSevenDays: window(row.s_runs, row.s_in, row.s_cached, row.s_out, row.s_cost),
      thisMonth: window(row.m_runs, row.m_in, row.m_cached, row.m_out, row.m_cost),
    }]));
  }

  /** Each account's effective owner, with the user's name and e-mail (instance admins see them in full). */
  async function ownersOf(accounts: readonly AccountRow[]): Promise<Map<string, AiAccountOwnerRef | null>> {
    const ownerIds = [...new Set(accounts.map((account) => effectiveAccountOwner(account)).filter((id): id is string => Boolean(id)))];
    const users = new Map<string, { name: string | null; email: string | null }>(ownerIds.length > 0
      ? (await db.select({ id: authUsers.id, name: authUsers.name, email: authUsers.email }).from(authUsers)
        .where(inArray(authUsers.id, ownerIds))).map((row) => [row.id, row])
      : []);
    return new Map(accounts.map((account) => {
      const ownerId = effectiveAccountOwner(account);
      const user = ownerId ? users.get(ownerId) : undefined;
      return [account.id, ownerId ? { userId: ownerId, name: user?.name || null, email: user?.email || null } : null];
    }));
  }

  function environmentSummary(row: Pick<typeof environments.$inferSelect, "id" | "name" | "driver" | "companyId">): AiAccountHostEnvironmentSummary {
    return { id: row.id, name: row.name, driver: row.driver, companyId: row.companyId ?? null };
  }

  async function getHost(hostId: string): Promise<HostRow> {
    const [host] = await db.select().from(aiAccountHosts).where(eq(aiAccountHosts.id, hostId));
    if (!host) throw notFound("Device not found");
    return host;
  }

  async function list(): Promise<AiAccountHostsView> {
    const hosts = await db.select().from(aiAccountHosts).orderBy(asc(aiAccountHosts.createdAt));
    const accounts = await db.select().from(aiAccounts).orderBy(asc(aiAccounts.createdAt));
    const mappings = await db
      .select({ hostId: aiAccountHostEnvironments.hostId, environment: environments })
      .from(aiAccountHostEnvironments)
      .innerJoin(environments, eq(environments.id, aiAccountHostEnvironments.environmentId))
      .orderBy(asc(environments.name));
    const mappedIds = mappings.map((row) => row.environment.id);
    const unmapped = await db
      .select()
      .from(environments)
      .where(and(
        eq(environments.status, "active"),
        mappedIds.length > 0 ? notInArray(environments.id, mappedIds) : sql`true`,
      ))
      .orderBy(asc(environments.name));
    const running = await runningCounts();
    const usage = await usageByAccount();
    const owners = await ownersOf(accounts);
    const reservations = await reservationsFor(accounts.map((row) => row.id));
    const allProjects = await projectSummaries();
    const reservedIds = [...new Set([...reservations.values()].flatMap((set) => [...set]))];
    const projectById = new Map((await projectSummaries(reservedIds)).map((project) => [project.id, project]));
    const reservedSummaries = (accountId: string) =>
      [...(reservations.get(accountId) ?? [])].map((id) => projectById.get(id)).filter((project): project is AiAccountProjectSummary => Boolean(project));
    return {
      hosts: hosts.map((host) => ({
        id: host.id,
        name: host.name,
        kind: host.kind,
        maxAccounts: host.maxAccounts,
        overflowToOtherAccounts: host.overflowToOtherAccounts,
        environments: mappings.filter((row) => row.hostId === host.id).map((row) => environmentSummary(row.environment)),
        accounts: accounts.filter((row) => row.hostId === host.id).map((row) => summarizeAccount(
          row,
          running.get(row.id) ?? 0,
          reservedSummaries(row.id),
          usage.get(row.id) ?? EMPTY_USAGE,
          owners.get(row.id) ?? null,
        )),
        createdAt: host.createdAt.toISOString(),
      })),
      unmappedEnvironments: unmapped.map(environmentSummary),
      projects: allProjects,
      maxAccountsPerHost: MAX_AI_ACCOUNTS_PER_HOST,
    };
  }

  /**
   * The companies whose agents use these devices, where a device change is
   * logged (spec 12): companies of non-terminated agents whose candidate
   * environments run on one of them, and of the bound agents that count
   * toward their caps. Nothing is created on the way.
   */
  async function companiesUsingDevices(deviceIds: readonly string[]): Promise<string[]> {
    const wanted = new Set(deviceIds);
    if (wanted.size === 0) return [];
    const rows = await db
      .select({ id: agents.id, companyId: agents.companyId, adapterType: agents.adapterType, defaultEnvironmentId: agents.defaultEnvironmentId })
      .from(agents)
      .where(ne(agents.status, "terminated"));
    const placements = await candidateDevicesForAgents(db, rows, { create: false });
    const companyIds = new Set<string>();
    for (const row of rows) {
      if ((placements.get(row.id) ?? []).some((candidate) => candidate.device !== null && wanted.has(candidate.device.id))) {
        companyIds.add(row.companyId);
      }
    }
    for (const entry of (await boundAccountsByDevice(db, { deviceIds: [...wanted], create: false })).values()) {
      for (const binding of entry.bindings) companyIds.add(binding.companyId);
    }
    return [...companyIds].sort();
  }

  /** 409 `device_account_limit`. Instance admins see every account, so all labels are named. */
  async function deviceLimitConflict(executor: DeviceDb, device: HostRow, accountIds: ReadonlySet<string>, limit: number, message: string) {
    const ids = [...accountIds];
    const labels = ids.length > 0
      ? (await executor.select({ label: aiAccounts.label }).from(aiAccounts).where(inArray(aiAccounts.id, ids)))
        .map((row) => row.label)
        .sort((a, b) => a.localeCompare(b))
      : [];
    const details: DeviceAccountLimitErrorDetails = {
      code: "device_account_limit",
      deviceId: device.id,
      deviceName: device.name,
      limit,
      inUse: ids.length,
      accounts: labels,
      otherCompaniesAccounts: 0,
    };
    return conflict(message, details);
  }

  /**
   * After a committed device change: re-check the caps it touched (`null`:
   * every device), which flags or clears `over_limit_at` with its notice, and
   * wake the waits it may release. Both are best effort; the change stands.
   */
  async function afterDeviceChange(change: { deviceIds: readonly string[] | null; environmentIds?: readonly string[] }) {
    try {
      await recheckDeviceLimits(db, { deviceIds: change.deviceIds });
    } catch (error) {
      logger.warn({ err: error, deviceIds: change.deviceIds }, "failed to re-check device account limits after a device change");
    }
    const filters: ResourceWaitWakeFilter[] = [
      ...(change.deviceIds && change.deviceIds.length > 0 ? [{ deviceIds: change.deviceIds }] : []),
      ...(change.environmentIds && change.environmentIds.length > 0 ? [{ environmentIds: change.environmentIds }] : []),
    ];
    for (const filter of filters) {
      try {
        await wakeResourceWaits(db, filter);
      } catch (error) {
        logger.warn({ err: error, filter }, "failed to wake resource waits after a device change");
      }
    }
  }

  async function createHost(input: CreateAiAccountHost, actorUserId: string | null) {
    // A plugin device comes only from its plugin's target report, which also gives it its key.
    if (!(AI_ACCOUNT_HOST_CREATABLE_KINDS as readonly string[]).includes(input.kind)) {
      throw unprocessable("Plugin devices come only from their environment driver plugin's reports");
    }
    try {
      const [host] = await db.insert(aiAccountHosts).values({
        name: input.name,
        kind: input.kind,
        maxAccounts: input.maxAccounts ?? MAX_AI_ACCOUNTS_PER_HOST,
        overflowToOtherAccounts: input.overflowToOtherAccounts ?? true,
        createdByUserId: actorUserId,
      }).returning();
      return host!;
    } catch (error) {
      if (isUniqueViolation(error, "ai_account_hosts_name_uq")) throw conflict("A device with this name already exists");
      throw error;
    }
  }

  /**
   * Renames a device or changes its account limit (spec 6.2). Lowering the
   * limit below the distinct accounts bound to agents that can run there is
   * refused with 409, under the bindings lock so no binding can slip in
   * meanwhile. `overflowToOtherAccounts` is stored for an older image only.
   */
  async function updateHost(hostId: string, input: UpdateAiAccountHost): Promise<HostRow> {
    const { host, updated } = await db.transaction(async (tx) => {
      await acquireBindingsLock(tx);
      const [host] = await tx.select().from(aiAccountHosts).where(eq(aiAccountHosts.id, hostId)).for("update");
      if (!host) throw notFound("Device not found");
      if (input.maxAccounts !== undefined && input.maxAccounts < capOf(host)) {
        const bound = (await boundAccountsByDevice(tx, { deviceIds: [hostId], create: false })).get(hostId)?.accountIds ?? new Set<string>();
        if (bound.size > input.maxAccounts) {
          throw await deviceLimitConflict(tx, host, bound, input.maxAccounts,
            `Agents that can run on ${host.name} use ${bound.size} Claude accounts, more than ${input.maxAccounts}. ` +
            "Move some of those agents to another device or give them other accounts before lowering the limit.");
        }
      }
      try {
        const [updated] = await tx.update(aiAccountHosts).set({ ...input, updatedAt: new Date() }).where(eq(aiAccountHosts.id, hostId)).returning();
        return { host, updated: updated! };
      } catch (error) {
        if (isUniqueViolation(error, "ai_account_hosts_name_uq")) throw conflict("A device with this name already exists");
        throw error;
      }
    });
    if (capOf(updated) !== capOf(host)) await afterDeviceChange({ deviceIds: [hostId] });
    return updated;
  }

  /**
   * Removes a device. Its explicit mappings go with it and its environments
   * return to the device Paperclip finds for them, so every cap is re-checked
   * afterwards; a device that ends over its cap is flagged with a notice.
   */
  async function deleteHost(hostId: string) {
    const host = await getHost(hostId);
    const mapped = (await db.select({ environmentId: aiAccountHostEnvironments.environmentId }).from(aiAccountHostEnvironments)
      .where(eq(aiAccountHostEnvironments.hostId, hostId))).map((row) => row.environmentId);
    await db.delete(aiAccountHosts).where(eq(aiAccountHosts.id, hostId));
    await afterDeviceChange({ deviceIds: null, environmentIds: mapped });
    return host;
  }

  /**
   * Replaces the device's explicit environment mappings (spec 5.6). An
   * environment listed here moves off any other device, and one left out
   * returns to the device Paperclip finds for it. In one transaction under the
   * bindings lock, an edit that would put more distinct bound accounts on any
   * device than its cap is refused with 409 `device_account_limit` and
   * nothing is written. A device already over its cap keeps its accounts but
   * takes no new one.
   */
  async function setEnvironments(hostId: string, environmentIds: string[]) {
    const unique = [...new Set(environmentIds)];
    const result = await db.transaction(async (tx) => {
      await acquireBindingsLock(tx);
      const [host] = await tx.select().from(aiAccountHosts).where(eq(aiAccountHosts.id, hostId)).for("update");
      if (!host) throw notFound("Device not found");
      const rows = unique.length > 0 ? await tx.select().from(environments).where(inArray(environments.id, unique)) : [];
      if (rows.length !== unique.length) throw unprocessable("An environment was not found");
      const allowed = DRIVERS_FOR_KIND[host.kind];
      const wrong = rows.find((row) => !allowed.includes(row.driver));
      if (wrong) {
        throw unprocessable(`${host.name} takes ${allowed.join(" and ")} environments only, not "${wrong.name}" (${wrong.driver})`);
      }
      const current = (await tx.select({ environmentId: aiAccountHostEnvironments.environmentId }).from(aiAccountHostEnvironments)
        .where(eq(aiAccountHostEnvironments.hostId, hostId))).map((row) => row.environmentId);
      const touched = [...new Set([...current, ...unique])];
      // Every device a touched environment runs on, before or after the edit.
      const deviceIds = new Set<string>([hostId]);
      for (const device of (await devicesForEnvironmentIds(tx, touched, { create: false })).values()) {
        if (device) deviceIds.add(device.id);
      }
      // Every device's accounts before the edit, also of a device an unmapped
      // environment returns to, which joins `deviceIds` only after the write.
      const before = await boundAccountsByDevice(tx, { create: false });
      await tx.delete(aiAccountHostEnvironments).where(eq(aiAccountHostEnvironments.hostId, hostId));
      if (unique.length > 0) {
        await tx.delete(aiAccountHostEnvironments).where(inArray(aiAccountHostEnvironments.environmentId, unique));
        await tx.insert(aiAccountHostEnvironments).values(unique.map((environmentId) => ({ environmentId, hostId })));
      }
      // An environment that returns to its own device creates that device, as its next run would.
      for (const device of (await devicesForEnvironmentIds(tx, touched)).values()) {
        if (device) deviceIds.add(device.id);
      }
      const after = await boundAccountsByDevice(tx, { deviceIds: [...deviceIds], create: false });
      const devices = await tx.select().from(aiAccountHosts).where(inArray(aiAccountHosts.id, [...deviceIds])).orderBy(asc(aiAccountHosts.name));
      for (const device of devices) {
        const accountIds = after.get(device.id)?.accountIds ?? new Set<string>();
        const previous = before.get(device.id)?.accountIds;
        const limit = capOf(device);
        if (accountIds.size > limit && [...accountIds].some((id) => !previous?.has(id))) {
          throw await deviceLimitConflict(tx, device, accountIds, limit,
            `With these environments, agents that can run on ${device.name} would use ${accountIds.size} Claude accounts, ` +
            `more than its limit of ${limit}. Move some of those agents to another device or give them other accounts first.`);
        }
      }
      return { host, environments: rows.map(environmentSummary), deviceIds: [...deviceIds], touched };
    });
    await afterDeviceChange({ deviceIds: result.deviceIds, environmentIds: result.touched });
    return { host: result.host, environments: result.environments };
  }

  return {
    list,
    getHost,
    createHost,
    updateHost,
    deleteHost,
    setEnvironments,
    companiesUsingDevices,
  };
}
