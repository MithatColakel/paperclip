import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import {
  type Db,
  aiAccountHostEnvironments,
  aiAccountHosts,
  aiAccountProjects,
  aiAccounts,
  companies,
  connectionGrants,
  costEvents,
  environments,
  heartbeatRuns,
  projects,
  toolConnections,
} from "@paperclipai/db";
import {
  AI_ACCOUNT_ENV_KEY,
  MAX_AI_ACCOUNTS_PER_HOST,
  type AiAccountCredentialType,
  type AiAccountHostEnvironmentSummary,
  type AiAccountHostKind,
  type AiAccountHostsResponse,
  type AiAccountLimitReason,
  type AiAccountProjectSummary,
  type AiAccountRunAttribution,
  type AiAccountSummary,
  type AiAccountUsage,
  type AiAccountUsageWindow,
  type CreateAiAccount,
  type CreateAiAccountHost,
  type UpdateAiAccount,
  type UpdateAiAccountHost,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import type { StoredSecretVersionMaterial } from "../secrets/types.js";
import { aiConnectionService } from "./ai-connections.js";

/**
 * Fork: Claude credentials per execution host (see
 * doc/plans/2026-10-14-host-ai-account-pools.md). Instance-level by design:
 * a machine serves every company's runs, so its pool cannot be company-scoped.
 * Routes restrict every mutation to instance admins.
 */

type AccountRow = typeof aiAccounts.$inferSelect;
type HostRow = typeof aiAccountHosts.$inferSelect;

/** Which environment drivers a host kind can serve. */
const DRIVERS_FOR_KIND: Record<AiAccountHostKind, readonly string[]> = {
  server: ["local"],
  ssh_host: ["ssh"],
  // A Mac reached over SSH honours the token Paperclip sends; Mac Fleet
  // sandboxes do not yet (the Mac agent prefers its own vault login).
  mac: ["ssh"],
};

/** Auth variables a host-pool run controls; the selected one is set, the others blanked. */
export const HOST_POOL_AUTH_ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

/** An API key whose credit ran out; it does not reset with the usage windows. */
export function isCreditBalanceFailure(text: string | null | undefined): boolean {
  return Boolean(text && /credit\s+balance\s+is\s+too\s+low/i.test(text));
}

/** Drivers whose runs receive a host-pool credential today. */
export const HOST_POOL_DRIVERS = new Set(["local", "ssh"]);

function fingerprint(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function hintFor(value: string) {
  return value.length > 8 ? `…${value.slice(-4)}` : null;
}

function iso(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function isUniqueViolation(error: unknown, constraint?: string): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const record = current as { code?: unknown; constraint_name?: unknown; constraint?: unknown; cause?: unknown };
    if (record.code === "23505") {
      if (!constraint) return true;
      return record.constraint_name === constraint || record.constraint === constraint;
    }
    current = record.cause;
  }
  return false;
}

const EMPTY_USAGE_WINDOW: AiAccountUsageWindow = { runs: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costCents: 0 };
const EMPTY_USAGE: AiAccountUsage = { lastFiveHours: EMPTY_USAGE_WINDOW, lastSevenDays: EMPTY_USAGE_WINDOW, thisMonth: EMPTY_USAGE_WINDOW };

function summarizeAccount(
  row: AccountRow,
  runningRuns: number,
  reservedFor: AiAccountProjectSummary[] = [],
  usage: AiAccountUsage = EMPTY_USAGE,
): AiAccountSummary {
  return {
    id: row.id,
    hostId: row.hostId,
    provider: "anthropic",
    credentialType: row.credentialType,
    label: row.label,
    emailHint: row.emailHint,
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
  };
}

function attributionFor(
  account: Pick<AccountRow, "id" | "label" | "credentialType">,
  host: Pick<HostRow, "id" | "name">,
  scope: AiAccountRunAttribution["scope"],
): AiAccountRunAttribution {
  return {
    mode: "host_pool",
    provider: "anthropic",
    method: account.credentialType,
    accountId: account.id,
    accountName: account.label,
    hostId: host.id,
    hostName: host.name,
    scope,
  };
}

/** Routing variables that would send a pool credential somewhere other than Anthropic. */
export const HOST_POOL_FORBIDDEN_ROUTING_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

/** Pure selection rule, exported for tests: balanced over available accounts. */
export function pickBalancedAccount<T extends Pick<AccountRow, "id" | "poolEnabled" | "status" | "exhaustedUntil" | "lastSelectedAt" | "createdAt">>(
  accounts: T[],
  running: Map<string, number>,
  now: Date,
): { account: T | null; limitedUntil: Date | null; usable: number } {
  let limitedUntil: Date | null = null;
  const available: T[] = [];
  let usable = 0;
  for (const account of accounts) {
    if (!account.poolEnabled || account.status !== "active") continue;
    usable += 1;
    if (account.exhaustedUntil && account.exhaustedUntil.getTime() > now.getTime()) {
      if (!limitedUntil || account.exhaustedUntil.getTime() < limitedUntil.getTime()) limitedUntil = account.exhaustedUntil;
      continue;
    }
    available.push(account);
  }
  available.sort((a, b) => {
    const load = (running.get(a.id) ?? 0) - (running.get(b.id) ?? 0);
    if (load !== 0) return load;
    const aSelected = a.lastSelectedAt?.getTime() ?? 0;
    const bSelected = b.lastSelectedAt?.getTime() ?? 0;
    if (aSelected !== bSelected) return aSelected - bSelected;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
  return { account: available[0] ?? null, limitedUntil, usable };
}

type PickableAccount = Pick<AccountRow, "id" | "poolEnabled" | "status" | "exhaustedUntil" | "lastSelectedAt" | "createdAt">;

/**
 * Pure tiered rule, exported for tests. A run of a project uses that
 * project's own accounts first. Unreserved (shared) accounts serve runs
 * without a project and projects without accounts of their own. When the
 * host allows overflow, a run whose own tier has nothing available continues
 * on the next tier: own → shared → other projects' accounts.
 */
export function pickAccountForRun<T extends PickableAccount>(input: {
  accounts: T[];
  reservations: Map<string, Set<string>>;
  projectId: string | null;
  overflow: boolean;
  running: Map<string, number>;
  now: Date;
}): { account: T | null; scope: AiAccountRunAttribution["scope"]; limitedUntil: Date | null; usable: number } {
  const reservedFor = (account: T) => input.reservations.get(account.id) ?? new Set<string>();
  const own = input.projectId ? input.accounts.filter((account) => reservedFor(account).has(input.projectId!)) : [];
  const shared = input.accounts.filter((account) => reservedFor(account).size === 0);
  const others = input.accounts.filter((account) => reservedFor(account).size > 0 && !own.includes(account));
  const tiers: Array<{ scope: AiAccountRunAttribution["scope"]; accounts: T[] }> = own.length > 0
    ? [{ scope: "project", accounts: own }, ...(input.overflow ? [{ scope: "shared" as const, accounts: shared }, { scope: "overflow" as const, accounts: others }] : [])]
    : [{ scope: "shared", accounts: shared }, ...(input.overflow ? [{ scope: "overflow" as const, accounts: others }] : [])];
  let limitedUntil: Date | null = null;
  let usable = 0;
  for (const tier of tiers) {
    const choice = pickBalancedAccount(tier.accounts, input.running, input.now);
    usable += choice.usable;
    if (choice.account) return { account: choice.account, scope: tier.scope, limitedUntil: null, usable };
    if (choice.limitedUntil && (!limitedUntil || choice.limitedUntil.getTime() < limitedUntil.getTime())) limitedUntil = choice.limitedUntil;
  }
  return { account: null, scope: tiers[0]!.scope, limitedUntil, usable };
}

export function aiAccountHostService(db: Db) {
  async function runningCounts(excludeRunId?: string | null, executor: Pick<Db, "select"> = db): Promise<Map<string, number>> {
    const rows = await executor
      .select({
        accountId: sql<string>`${heartbeatRuns.contextSnapshot} -> 'aiConnection' ->> 'accountId'`,
        count: sql<number>`count(*)::int`,
      })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.status, "running"),
        sql`${heartbeatRuns.contextSnapshot} -> 'aiConnection' ->> 'mode' = 'host_pool'`,
        excludeRunId ? sql`${heartbeatRuns.id} <> ${excludeRunId}` : sql`true`,
      ))
      .groupBy(sql`${heartbeatRuns.contextSnapshot} -> 'aiConnection' ->> 'accountId'`);
    return new Map(rows.filter((row) => row.accountId).map((row) => [row.accountId, Number(row.count)]));
  }

  async function reservationsFor(accountIds: string[], executor: Pick<Db, "select"> = db) {
    const map = new Map<string, Set<string>>();
    if (accountIds.length === 0) return map;
    const rows = await executor.select().from(aiAccountProjects).where(inArray(aiAccountProjects.accountId, accountIds));
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

  /** Paperclip's own use of each account, from the cost events of its host-pool runs. */
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
      .where(and(
        sql`${costEvents.occurredAt} >= ${since}::timestamptz`,
        sql`${heartbeatRuns.contextSnapshot} -> 'aiConnection' ->> 'mode' = 'host_pool'`,
      ))
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

  function environmentSummary(row: Pick<typeof environments.$inferSelect, "id" | "name" | "driver" | "companyId">): AiAccountHostEnvironmentSummary {
    return { id: row.id, name: row.name, driver: row.driver, companyId: row.companyId ?? null };
  }

  async function getHost(hostId: string): Promise<HostRow> {
    const [host] = await db.select().from(aiAccountHosts).where(eq(aiAccountHosts.id, hostId));
    if (!host) throw notFound("Host not found");
    return host;
  }

  async function getAccount(accountId: string): Promise<AccountRow> {
    const [account] = await db.select().from(aiAccounts).where(eq(aiAccounts.id, accountId));
    if (!account) throw notFound("Account not found");
    return account;
  }

  async function list(): Promise<AiAccountHostsResponse> {
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
        accounts: accounts.filter((row) => row.hostId === host.id).map((row) => summarizeAccount(row, running.get(row.id) ?? 0, reservedSummaries(row.id), usage.get(row.id))),
        createdAt: host.createdAt.toISOString(),
      })),
      unmappedEnvironments: unmapped.map(environmentSummary),
      projects: allProjects,
      maxAccountsPerHost: MAX_AI_ACCOUNTS_PER_HOST,
    };
  }

  async function createHost(input: CreateAiAccountHost, actorUserId: string | null) {
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
      if (isUniqueViolation(error)) throw conflict("A host with this name already exists");
      throw error;
    }
  }

  async function updateHost(hostId: string, input: UpdateAiAccountHost) {
    return db.transaction(async (tx) => {
      const [host] = await tx.select().from(aiAccountHosts).where(eq(aiAccountHosts.id, hostId)).for("update");
      if (!host) throw notFound("Host not found");
      if (input.maxAccounts !== undefined) {
        const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(aiAccounts).where(eq(aiAccounts.hostId, hostId));
        if (Number(count) > input.maxAccounts) {
          throw unprocessable(`This host has ${count} accounts; remove some before lowering the limit to ${input.maxAccounts}`);
        }
      }
      try {
        const [updated] = await tx.update(aiAccountHosts).set({ ...input, updatedAt: new Date() }).where(eq(aiAccountHosts.id, hostId)).returning();
        return updated!;
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict("A host with this name already exists");
        throw error;
      }
    });
  }

  async function deleteHost(hostId: string) {
    const host = await getHost(hostId);
    await db.delete(aiAccountHosts).where(eq(aiAccountHosts.id, hostId));
    return host;
  }

  /** Replaces the host's environment list. An environment moves here from any other host. */
  async function setEnvironments(hostId: string, environmentIds: string[]) {
    const host = await getHost(hostId);
    const unique = [...new Set(environmentIds)];
    const rows = unique.length > 0 ? await db.select().from(environments).where(inArray(environments.id, unique)) : [];
    if (rows.length !== unique.length) throw unprocessable("An environment was not found");
    const allowed = DRIVERS_FOR_KIND[host.kind];
    const wrong = rows.find((row) => !allowed.includes(row.driver));
    if (wrong) {
      throw unprocessable(`Environment "${wrong.name}" (${wrong.driver}) cannot run on a ${host.kind} host`);
    }
    await db.transaction(async (tx) => {
      await tx.delete(aiAccountHostEnvironments).where(eq(aiAccountHostEnvironments.hostId, hostId));
      if (unique.length > 0) {
        await tx.delete(aiAccountHostEnvironments).where(inArray(aiAccountHostEnvironments.environmentId, unique));
        await tx.insert(aiAccountHostEnvironments).values(unique.map((environmentId) => ({ environmentId, hostId })));
      }
    });
    return { host, environments: rows.map(environmentSummary) };
  }

  /** Reads the credential to add, from a pasted value or a server-side import. */
  async function resolveNewCredential(input: CreateAiAccount, actorUserId: string | null): Promise<string> {
    if (input.value) return input.value.trim();
    const source = input.importFrom!;
    if (source.kind === "server_env") {
      const value = process.env[AI_ACCOUNT_ENV_KEY[input.credentialType]]?.trim();
      if (!value) throw unprocessable(`The server has no ${AI_ACCOUNT_ENV_KEY[input.credentialType]} to import`);
      return value;
    }
    if (!actorUserId) throw forbidden("Only a signed-in user can import their own Claude connection");
    const [connection] = await db.select().from(toolConnections).where(and(
      eq(toolConnections.id, source.connectionId),
      eq(toolConnections.companyId, source.companyId),
      eq(toolConnections.connectionPurpose, "ai"),
    ));
    if (!connection) throw notFound("Claude connection not found");
    const [grant] = await db.select().from(connectionGrants).where(and(
      eq(connectionGrants.companyId, source.companyId),
      eq(connectionGrants.connectionId, source.connectionId),
      eq(connectionGrants.kind, "user"),
      eq(connectionGrants.subjectUserId, actorUserId),
      eq(connectionGrants.status, "active"),
      isNull(connectionGrants.revokedAt),
    ));
    if (!grant) throw forbidden("Only the owner of a personal Claude connection can import it");
    const value = String(await aiConnectionService(db).credential({ connection, grant })).trim();
    return value;
  }

  function assertCredentialShape(type: AiAccountCredentialType, value: string) {
    const prefix = type === "subscription" ? "sk-ant-oat" : "sk-ant-api";
    if (!value.startsWith(prefix)) {
      throw unprocessable(type === "subscription"
        ? "This credential is not a Claude subscription token from `claude setup-token`"
        : "This credential is not a Claude Console API key");
    }
  }

  async function addAccount(hostId: string, input: CreateAiAccount, actorUserId: string | null) {
    const value = await resolveNewCredential(input, actorUserId);
    assertCredentialShape(input.credentialType, value);
    const prepared = await localEncryptedProvider.createSecret({ value });
    try {
      return await db.transaction(async (tx) => {
        const [host] = await tx.select().from(aiAccountHosts).where(eq(aiAccountHosts.id, hostId)).for("update");
        if (!host) throw notFound("Host not found");
        const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(aiAccounts).where(eq(aiAccounts.hostId, hostId));
        const limit = Math.min(host.maxAccounts, MAX_AI_ACCOUNTS_PER_HOST);
        if (Number(count) >= limit) throw conflict(`${host.name} already has ${limit} accounts, the most a host can have`);
        const [account] = await tx.insert(aiAccounts).values({
          hostId,
          credentialType: input.credentialType,
          label: input.label,
          emailHint: input.emailHint ?? null,
          plan: input.plan ?? null,
          poolEnabled: input.poolEnabled ?? true,
          credentialMaterial: prepared.material as unknown as Record<string, unknown>,
          credentialFingerprint: fingerprint(value),
          credentialHint: hintFor(value),
          createdByUserId: actorUserId,
        }).returning();
        return { host, account: account! };
      });
    } catch (error) {
      if (isUniqueViolation(error, "ai_accounts_fingerprint_uq")) throw conflict("This credential is already on a host. A credential can serve one host only.");
      if (isUniqueViolation(error, "ai_accounts_email_hint_uq")) throw conflict("An account with this email is already on a host. Each host uses its own accounts.");
      throw error;
    }
  }

  async function updateAccount(accountId: string, input: UpdateAiAccount) {
    const existing = await getAccount(accountId);
    const patch: Partial<typeof aiAccounts.$inferInsert> = { updatedAt: new Date() };
    if (input.label !== undefined) patch.label = input.label;
    if (input.emailHint !== undefined) patch.emailHint = input.emailHint;
    if (input.plan !== undefined) patch.plan = input.plan;
    if (input.poolEnabled !== undefined) patch.poolEnabled = input.poolEnabled;
    if (input.status !== undefined) {
      patch.status = input.status;
      patch.statusMessage = null;
    }
    try {
      const [updated] = await db.update(aiAccounts).set(patch).where(eq(aiAccounts.id, accountId)).returning();
      return { before: existing, account: updated! };
    } catch (error) {
      if (isUniqueViolation(error, "ai_accounts_email_hint_uq")) throw conflict("An account with this email is already on a host. Each host uses its own accounts.");
      throw error;
    }
  }

  /** Reserves an account for projects (any company); an empty list makes it shared. */
  async function setAccountProjects(accountId: string, projectIds: string[]) {
    const account = await getAccount(accountId);
    const unique = [...new Set(projectIds)];
    const found = await projectSummaries(unique);
    if (found.length !== unique.length) throw unprocessable("A project was not found");
    await db.transaction(async (tx) => {
      await tx.delete(aiAccountProjects).where(eq(aiAccountProjects.accountId, accountId));
      if (unique.length > 0) await tx.insert(aiAccountProjects).values(unique.map((projectId) => ({ accountId, projectId })));
    });
    return { account, projects: found };
  }

  async function clearLimit(accountId: string) {
    await getAccount(accountId);
    const [updated] = await db.update(aiAccounts)
      .set({ exhaustedUntil: null, limitReason: null, limitRunId: null, updatedAt: new Date() })
      .where(eq(aiAccounts.id, accountId)).returning();
    return updated!;
  }

  async function deleteAccount(accountId: string) {
    const existing = await getAccount(accountId);
    await db.delete(aiAccounts).where(eq(aiAccounts.id, accountId));
    return existing;
  }

  /** The host an environment runs on, when that host has a pool to draw from. */
  async function poolHostForEnvironment(environment: { id: string; driver: string } | null | undefined): Promise<HostRow | null> {
    if (!environment || !HOST_POOL_DRIVERS.has(environment.driver)) return null;
    const [row] = await db
      .select({ host: aiAccountHosts })
      .from(aiAccountHostEnvironments)
      .innerJoin(aiAccountHosts, eq(aiAccountHosts.id, aiAccountHostEnvironments.hostId))
      .where(eq(aiAccountHostEnvironments.environmentId, environment.id));
    if (!row) return null;
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(aiAccounts)
      .where(and(eq(aiAccounts.hostId, row.host.id), eq(aiAccounts.poolEnabled, true)));
    return Number(count) > 0 ? row.host : null;
  }

  /**
   * Picks the account for one run on `host`: balanced over available accounts
   * (fewest running host-pool runs, then the least recently picked). Throws
   * `ai_connection_pool_exhausted` with the earliest reset when every usable
   * account is limited, and `ai_account_host_unavailable` when none is usable.
   */
  async function selectForRun(input: { host: HostRow; runId: string; projectId?: string | null; now?: Date }) {
    const now = input.now ?? new Date();
    // The host lock covers the load reading and the run's attribution, so two
    // runs starting together see each other and spread across accounts.
    const selected = await db.transaction(async (tx) => {
      await tx.select({ id: aiAccountHosts.id }).from(aiAccountHosts).where(eq(aiAccountHosts.id, input.host.id)).for("update");
      const running = await runningCounts(input.runId, tx);
      const accounts = await tx.select().from(aiAccounts).where(eq(aiAccounts.hostId, input.host.id));
      const choice = pickAccountForRun({
        accounts,
        reservations: await reservationsFor(accounts.map((row) => row.id), tx),
        projectId: input.projectId ?? null,
        overflow: input.host.overflowToOtherAccounts,
        running,
        now,
      });
      if (!choice.account) return choice;
      await tx.update(aiAccounts).set({ lastSelectedAt: now, lastUsedAt: now }).where(eq(aiAccounts.id, choice.account.id));
      await tx.update(heartbeatRuns)
        .set({ contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || ${JSON.stringify({ aiConnection: attributionFor(choice.account, input.host, choice.scope) })}::jsonb` })
        .where(eq(heartbeatRuns.id, input.runId));
      return choice;
    });
    if (!selected.account) {
      if (selected.limitedUntil) {
        throw unprocessable(`Every Claude account on ${input.host.name} is at its usage limit`, {
          code: "ai_connection_pool_exhausted",
          retryAt: selected.limitedUntil.toISOString(),
        });
      }
      throw unprocessable(
        selected.usable === 0
          ? `No Claude account on ${input.host.name} can serve this run (none for its project or shared, or they are signed out or switched off). Fix it in Instance settings → Claude accounts.`
          : `No Claude account on ${input.host.name} is available`,
        { code: "ai_account_host_unavailable" },
      );
    }
    const account = selected.account;
    const value = await localEncryptedProvider.resolveVersion({
      material: account.credentialMaterial as unknown as StoredSecretVersionMaterial,
      externalRef: null,
    });
    const attribution = attributionFor(account, input.host, selected.scope);
    return { account, value, envKey: AI_ACCOUNT_ENV_KEY[account.credentialType], attribution };
  }

  /** Rests an account until `until`; a later reset always wins over a shorter one. */
  async function markLimited(input: { accountId: string; until: Date; reason: AiAccountLimitReason; runId: string | null }) {
    const [updated] = await db.update(aiAccounts).set({
      exhaustedUntil: sql`greatest(coalesce(${aiAccounts.exhaustedUntil}, ${input.until.toISOString()}::timestamptz), ${input.until.toISOString()}::timestamptz)`,
      limitReason: input.reason,
      limitRunId: input.runId,
      lastLimitedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(aiAccounts.id, input.accountId)).returning();
    return updated ?? null;
  }

  async function markAuthFailed(input: { accountId: string; message: string }) {
    const [updated] = await db.update(aiAccounts).set({
      status: "auth_failed",
      statusMessage: input.message.slice(0, 500),
      updatedAt: new Date(),
    }).where(and(eq(aiAccounts.id, input.accountId), eq(aiAccounts.status, "active"))).returning();
    return updated ?? null;
  }

  /** True when an account of the host could serve a run of `projectId` at `now`. */
  async function hasAvailableAccount(hostId: string, now = new Date(), projectId: string | null = null) {
    const host = await getHost(hostId);
    const accounts = await db.select().from(aiAccounts).where(eq(aiAccounts.hostId, hostId));
    return pickAccountForRun({
      accounts,
      reservations: await reservationsFor(accounts.map((row) => row.id)),
      projectId,
      overflow: host.overflowToOtherAccounts,
      running: new Map(),
      now,
    }).account !== null;
  }

  async function countPoolAccounts(hostId: string) {
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(aiAccounts)
      .where(and(eq(aiAccounts.hostId, hostId), eq(aiAccounts.poolEnabled, true), eq(aiAccounts.status, "active")));
    return Number(count);
  }

  return {
    list,
    getHost,
    getAccount,
    createHost,
    updateHost,
    deleteHost,
    setEnvironments,
    addAccount,
    updateAccount,
    setAccountProjects,
    reservationsFor,
    clearLimit,
    deleteAccount,
    poolHostForEnvironment,
    selectForRun,
    markLimited,
    markAuthFailed,
    hasAvailableAccount,
    countPoolAccounts,
    summarizeAccount,
  };
}
