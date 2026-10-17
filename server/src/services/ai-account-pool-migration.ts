import { and, asc, desc, eq, gte, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import {
  type Db,
  agents,
  aiAccountAgentBindings,
  aiAccountHosts,
  aiAccountProjects,
  aiAccounts,
  aiConnectionPoolMembers,
  companies,
  companySecretVersions,
  companySecrets,
  connectionGrants,
  deferredDataMigrations,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import {
  AI_ACCOUNT_BINDING_MIGRATION_KEY,
  AI_ACCOUNT_MIGRATION_OUTCOMES,
  AI_ACCOUNT_MIGRATION_RULES,
  DEFERRED_DATA_MIGRATION_STATUSES,
  type AiAccountBindingSource,
  type AiAccountMigrationAgentEntry,
  type AiAccountMigrationDeviceEntry,
  type AiAccountMigrationGoNoGoEntry,
  type AiAccountMigrationReport,
  type AiAccountMigrationRule,
  type AiAccountMigrationSummary,
  type DeferredDataMigrationStatus,
  type DeploymentMode,
} from "@paperclipai/shared";
import { resolveDeploymentMode } from "../config-file.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import {
  POOL_ACCOUNT_ADAPTER_TYPE,
  checkAccountBinding,
  poolPlacementOf,
  type AccountBindingFailure,
  type AiAccountRow,
  type PoolAuditActor,
} from "./ai-account-pool.js";
import {
  LEGACY_HOST_POOL_ATTRIBUTION_MODE,
  acquireBindingsLock,
  boundAccountsByDevice,
  candidateDevicesForAgents,
  capOf,
  type CandidateDevice,
  type ExecutionDeviceRow,
  type ExecutionEnvironmentRow,
} from "./execution-devices.js";
import { previewCredentialPlan, readBinding, type CredentialPlanPreview } from "./heartbeat-ai-accounts.js";
import { wakeResourceWaits } from "./resource-waits/wake.js";

/**
 * Fork: the Claude account binding backfill (spec 15.3, decision D7), its
 * report and the go/no-go preview (spec 15.1, 15.3).
 *
 * Migration 0310 inserts no bindings. This job runs once at boot, after the
 * migrations and outside their transaction, and again when an instance admin
 * re-runs it. Under the bindings advisory lock it gives each candidate one
 * account, in processing order (company id, agent `created_at`, agent id),
 * by the first rule that applies:
 *
 * 1. the only account reserved (`ai_account_projects`) for the agent's
 *    projects, i.e. the projects of its runs in the last 45 days;
 * 2. the account the agent used most in its host-pool history: runs of the
 *    last 45 days with attribution scope `project` or `shared`, so an account
 *    it only reached through overflow is never chosen. Ties go to the oldest
 *    account;
 * 3. the account its company used most on the agent's devices, likewise;
 * 4. none: the agent stays unbound and the report lists it for review.
 *
 * A `company_pool` agent takes the pool account that holds the credential of
 * the member it used last (else the first member), matched by fingerprint.
 *
 * Every choice then passes `checkAccountBinding` (spec 5.3 steps 3–7) with
 * this run's own bound sets, so the device cap holds in processing order:
 * - passed: a `migrated_*` binding whose note names the rule; it shows
 *   "review" until a company admin confirms it;
 * - over the cap, or any failed check of an agent with history: a
 *   `pool_account` row without an account, so the agent waits `unassigned`
 *   with a notice instead of silently falling back to its device's login;
 * - any other failure, or no choice: no row; the agent keeps its device login
 *   or its pinned company pool, and the report says why.
 *
 * Only agents without a binding row are candidates, so a re-run adds only the
 * bindings an earlier run could not make. A failure marks the job `failed` and
 * never throws, so boot always continues. Nothing here rewrites
 * `runtime_config`, reservations or the company pool tables, and nothing is
 * decrypted: the company pool match compares hashes. Paperclip never moves a
 * task to another account (P7): the chosen account is the agent's from then
 * on, and nothing rotates or balances.
 */

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type MarkerRow = typeof deferredDataMigrations.$inferSelect;

/** The history and project window of spec 15.3. */
export const AI_ACCOUNT_MIGRATION_HISTORY_DAYS = 45;
/** Go/no-go: every Claude agent with a host-pool run this recent must plan to use its account. */
export const AI_ACCOUNT_MIGRATION_GO_NO_GO_DAYS = 7;
/** Activity actor of the boot run. */
export const AI_ACCOUNT_MIGRATION_ACTOR_ID = "ai-account-migration";

const DAY_MS = 24 * 60 * 60 * 1000;
const COMPANY_POOL_MODE = "company_pool";
const AI_CREDENTIAL_CONFIG_PATH = "ai.credential";
const LAST_ERROR_MAX_LENGTH = 500;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AiAccountMigrationOptions {
  /** In `local_trusted` the local board user is a member of every company. Defaults to the configured mode. */
  deploymentMode?: DeploymentMode;
  /** The clock (tests pass a fixed one). */
  now?: Date;
  /** Run even when the marker says completed: the instance admin's re-run. Boot runs leave it unset. */
  force?: boolean;
  /** Who asked for a re-run. Boot runs are logged as the system. */
  actor?: { audit: PoolAuditActor; userId: string | null } | null;
}

export type AiAccountMigrationRunResult =
  | { status: "skipped"; reason: "completed" }
  | { status: "completed"; added: number; summary: AiAccountMigrationSummary }
  | { status: "failed"; error: string };

/** One candidate environment's dry run of `planCredential`. */
export interface AiAccountPlanPreviewEnvironment {
  environmentId: string | null;
  environmentName: string | null;
  preview: CredentialPlanPreview;
}

/** `previewPlan`: the dry run of `planCredential` over an agent's candidate environments. */
export interface AiAccountPlanPreview {
  agentId: string;
  agentName: string;
  companyId: string;
  /** The worst outcome over the candidate environments: refuse, then wait, then none, then use. */
  outcome: CredentialPlanPreview["outcome"];
  /** The wait or `none` reason, or the refusal message; null for `use`. */
  reason: string | null;
  environments: AiAccountPlanPreviewEnvironment[];
}

interface UnboundAgent {
  id: string;
  companyId: string;
  companyName: string;
  name: string;
  createdAt: Date;
  defaultEnvironmentId: string | null;
  /** `runtimeConfig.aiConnection`, as stored. */
  aiConnection: unknown;
}

interface HistoryRow {
  agentId: string;
  companyId: string;
  accountId: string;
  deviceId: string | null;
  runs: number;
}

interface AccountChoice {
  rule: AiAccountMigrationRule;
  account: AiAccountRow;
  /** History runs behind the choice (rules 2 and 3). */
  runs: number | null;
  /** Rule company_pool_fingerprint: the member was the one the agent used last. */
  lastUsedMember?: boolean;
}

type PoolMatchProblem = "provider" | "no_members" | "no_credential" | "no_match";

type PoolMatch =
  | { ok: true; account: AiAccountRow; lastUsedMember: boolean }
  | { ok: false; problem: PoolMatchProblem };

type Decision =
  | { outcome: "bound"; choice: AccountChoice; devices: ExecutionDeviceRow[]; note: string }
  | { outcome: "unassigned"; choice: AccountChoice | null; note: string }
  | { outcome: "unbound"; choice: AccountChoice | null; rule: AiAccountMigrationRule | null; note: string };

interface InsertedBinding {
  agentId: string;
  companyId: string;
  accountId: string | null;
  accountLabel: string | null;
  source: AiAccountBindingSource;
  rule: AiAccountMigrationRule | null;
  note: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Read as the run path reads it: any truthy `runtimeConfig.aiConnection` is an upstream binding. */
function hasAiConnection(agent: Pick<UnboundAgent, "aiConnection">): boolean {
  return Boolean(agent.aiConnection);
}

function isCompanyPoolAgent(agent: Pick<UnboundAgent, "aiConnection">): boolean {
  return asRecord(agent.aiConnection).mode === COMPANY_POOL_MODE;
}

function distinctDevices(candidates: readonly CandidateDevice[]): ExecutionDeviceRow[] {
  const byId = new Map<string, ExecutionDeviceRow>();
  for (const candidate of candidates) {
    if (candidate.device) byId.set(candidate.device.id, candidate.device);
  }
  return [...byId.values()];
}

function configuredDeploymentMode(): DeploymentMode | undefined {
  try {
    return resolveDeploymentMode();
  } catch (error) {
    logger.warn({ err: error }, "the Claude account migration could not read the deployment mode; treating the local board user as a non-member");
    return undefined;
  }
}

/**
 * The database's own message, on one line. A wrapped query error carries the
 * whole statement and its parameters, so the innermost cause is reported.
 */
function errorText(error: unknown): string {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && current.cause instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (!("query" in current) && !current.message.startsWith("Failed query:")) break;
    current = current.cause;
  }
  const message = current instanceof Error ? current.message : String(current);
  return message.replace(/\s+/g, " ").trim().slice(0, LAST_ERROR_MAX_LENGTH) || "The Claude account migration failed.";
}

/** A text id as a uuid, or null when it is not one (so a malformed context never fails the job). */
function uuidOrNull(text: SQL): SQL {
  return sql`(case when ${text} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (${text})::uuid end)`;
}

/** Plain code-unit order, the same order Postgres gives these ids. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function runsText(runs: number | null): string {
  return runs === 1 ? "1 run" : `${runs ?? 0} runs`;
}

/** The most-used account; ties go to the oldest account, then the lowest id. */
function mostUsed(counts: ReadonlyMap<string, number>, accountsById: ReadonlyMap<string, AiAccountRow>): { account: AiAccountRow; runs: number } | null {
  let best: { account: AiAccountRow; runs: number } | null = null;
  for (const [accountId, runs] of counts) {
    const account = accountsById.get(accountId);
    if (!account || runs <= 0) continue;
    if (
      !best
      || runs > best.runs
      || (runs === best.runs && account.createdAt.getTime() < best.account.createdAt.getTime())
      || (runs === best.runs && account.createdAt.getTime() === best.account.createdAt.getTime() && account.id < best.account.id)
    ) {
      best = { account, runs };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Notes (shown to the agent's company: never another company's account label)
// ---------------------------------------------------------------------------

function chosenNote(choice: AccountChoice): string {
  switch (choice.rule) {
    case "reservation":
      return "Chosen because it is the only Claude account reserved for this agent's projects.";
    case "agent_history":
      return `Chosen because this agent used it most in the last ${AI_ACCOUNT_MIGRATION_HISTORY_DAYS} days (${runsText(choice.runs)}).`;
    case "company_history":
      return `Chosen because this company's agents used it most on this agent's devices in the last ${AI_ACCOUNT_MIGRATION_HISTORY_DAYS} days (${runsText(choice.runs)}).`;
    case "company_pool_fingerprint":
      return choice.lastUsedMember
        ? "Chosen because it holds the credential of the company pool account this agent used last."
        : "Chosen because it holds the credential of the first account in this company's pool.";
  }
}

function choiceSubject(rule: AiAccountMigrationRule): string {
  switch (rule) {
    case "reservation":
      return "The only Claude account reserved for this agent's projects";
    case "agent_history":
      return `The Claude account this agent used most in the last ${AI_ACCOUNT_MIGRATION_HISTORY_DAYS} days`;
    case "company_history":
      return "The Claude account this company's agents used most on this agent's devices";
    case "company_pool_fingerprint":
      return "The Claude account with this agent's company pool credential";
  }
}

function failureProblem(failure: AccountBindingFailure): string {
  switch (failure.code) {
    case "ai_account_not_eligible":
      switch (failure.reason) {
        case "owner_not_member":
          return "belongs to someone who is not a member of this company";
        case "reserved_elsewhere":
          return "is reserved for another company's projects";
        case "unassigned":
          return "no longer exists";
        default:
          return "is not available in this company";
      }
    case "ai_account_incompatible":
      switch (failure.reason) {
        case "account_disabled":
          return "is switched off";
        case "account_signed_out":
          return "is signed out";
        case "device_unknown":
          return failure.environmentName
            ? `cannot be checked: Paperclip cannot tell which device the environment "${failure.environmentName}" runs on`
            : "cannot be checked: Paperclip cannot tell which device this agent runs on";
        case "credential_type_unsupported":
          return `cannot run on ${failure.deviceName ?? "this agent's device"}, which does not accept its credential type`;
        case "adapter_unsupported":
          return "cannot serve this agent";
      }
      return "cannot serve this agent";
    case "device_account_limit":
      return `cannot be added: ${failure.deviceName} already runs ${failure.accountIds.length} of ${failure.limit} Claude accounts`;
  }
}

function failedNote(choice: AccountChoice, failure: AccountBindingFailure, outcome: "unassigned" | "unbound" | "company_pool"): string {
  const sentence = `${choiceSubject(choice.rule)} ${failureProblem(failure)}.`;
  switch (outcome) {
    case "unassigned":
      return failure.code === "device_account_limit"
        ? `${sentence} No account was assigned: choose one already on that device, or free a slot.`
        : `${sentence} No account was assigned: choose one for this agent.`;
    case "unbound":
      return `${sentence} The agent was left without a Claude account.`;
    case "company_pool":
      return `${sentence} The agent keeps its company pool connection.`;
  }
}

const NO_CHOICE_NOTE =
  "No reserved project, history of this agent, or company history on its devices points to a Claude account. Choose one for this agent.";

function poolProblemNote(problem: PoolMatchProblem): string {
  const reason = {
    provider: "Its company pool is not a Claude pool.",
    no_members: "Its company pool has no Claude account.",
    no_credential: "Its company pool account has no stored credential to compare.",
    no_match: "No Claude account holds the credential of its company pool account.",
  }[problem];
  return `${reason} The agent keeps its company pool connection.`;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Non-terminated Claude agents without a binding row, in processing order. */
async function unboundClaudeAgents(tx: Tx): Promise<UnboundAgent[]> {
  const rows = await tx
    .select({
      id: agents.id,
      companyId: agents.companyId,
      companyName: companies.name,
      name: agents.name,
      createdAt: agents.createdAt,
      defaultEnvironmentId: agents.defaultEnvironmentId,
      runtimeConfig: agents.runtimeConfig,
    })
    .from(agents)
    .innerJoin(companies, eq(companies.id, agents.companyId))
    .leftJoin(aiAccountAgentBindings, eq(aiAccountAgentBindings.agentId, agents.id))
    .where(and(
      eq(agents.adapterType, POOL_ACCOUNT_ADAPTER_TYPE),
      ne(agents.status, "terminated"),
      isNull(aiAccountAgentBindings.agentId),
    ))
    .orderBy(asc(agents.companyId), asc(agents.createdAt), asc(agents.id));
  return rows.map(({ runtimeConfig, ...row }) => ({ ...row, aiConnection: asRecord(runtimeConfig).aiConnection }));
}

/** Host-pool history (spec 15.3): runs of the window with attribution scope `project` or `shared`; overflow is ignored. */
async function hostPoolHistory(tx: Tx, since: Date): Promise<HistoryRow[]> {
  const attribution = sql`${heartbeatRuns.contextSnapshot} -> 'aiConnection'`;
  const accountId = sql<string | null>`${attribution} ->> 'accountId'`;
  const deviceId = sql<string | null>`${attribution} ->> 'hostId'`;
  const rows = await tx
    .select({
      agentId: heartbeatRuns.agentId,
      companyId: heartbeatRuns.companyId,
      accountId,
      deviceId,
      runs: sql<number>`count(*)::int`,
    })
    .from(heartbeatRuns)
    .where(and(
      gte(heartbeatRuns.createdAt, since),
      sql`${attribution} ->> 'mode' = ${LEGACY_HOST_POOL_ATTRIBUTION_MODE}`,
      sql`${attribution} ->> 'scope' in ('project', 'shared')`,
    ))
    .groupBy(heartbeatRuns.agentId, heartbeatRuns.companyId, accountId, deviceId);
  return rows.flatMap((row) => typeof row.accountId === "string" && UUID_PATTERN.test(row.accountId)
    ? [{
        agentId: row.agentId,
        companyId: row.companyId,
        accountId: row.accountId,
        deviceId: typeof row.deviceId === "string" && UUID_PATTERN.test(row.deviceId) ? row.deviceId : null,
        runs: Number(row.runs),
      }]
    : []);
}

/**
 * "The agent's projects" (spec 15.3): the projects of the runs it worked on in
 * the window, as upstream reads a run's project (its context, else its issue's).
 */
async function projectsOfAgents(tx: Tx, agentIds: readonly string[], since: Date): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  if (agentIds.length === 0) return result;
  const runIssueId = uuidOrNull(sql`${heartbeatRuns.contextSnapshot} ->> 'issueId'`);
  const runProjectId = sql`coalesce(${uuidOrNull(sql`${heartbeatRuns.contextSnapshot} ->> 'projectId'`)}, ${issues.projectId})`;
  const rows = await tx
    .selectDistinct({ agentId: heartbeatRuns.agentId, projectId: projects.id })
    .from(heartbeatRuns)
    .leftJoin(issues, and(eq(issues.companyId, heartbeatRuns.companyId), sql`${issues.id} = ${runIssueId}`))
    .innerJoin(projects, and(eq(projects.companyId, heartbeatRuns.companyId), sql`${projects.id} = ${runProjectId}`))
    .where(and(inArray(heartbeatRuns.agentId, [...agentIds]), gte(heartbeatRuns.createdAt, since)));
  for (const row of rows) {
    const set = result.get(row.agentId) ?? new Set<string>();
    set.add(row.projectId);
    result.set(row.agentId, set);
  }
  return result;
}

/**
 * The company pool fingerprint path (draft v1 §15.2 (c)): the member the agent
 * used last in the window, else the first member by priority, then
 * `grant_id` → the grant's `ai.credential` secret ref → that secret version's
 * `value_sha256`, which equals `ai_accounts.credential_fingerprint` for the
 * same credential. Only hashes are compared; nothing is decrypted.
 */
async function companyPoolMatches(
  tx: Tx,
  poolAgents: readonly UnboundAgent[],
  accountsByFingerprint: ReadonlyMap<string, AiAccountRow>,
  since: Date,
): Promise<Map<string, PoolMatch>> {
  const result = new Map<string, PoolMatch>();
  if (poolAgents.length === 0) return result;
  const members = await tx
    .select({
      companyId: aiConnectionPoolMembers.companyId,
      connectionId: aiConnectionPoolMembers.connectionId,
      grantId: aiConnectionPoolMembers.grantId,
    })
    .from(aiConnectionPoolMembers)
    .where(and(
      inArray(aiConnectionPoolMembers.companyId, unique(poolAgents.map((agent) => agent.companyId))),
      eq(aiConnectionPoolMembers.provider, "anthropic"),
    ))
    .orderBy(asc(aiConnectionPoolMembers.companyId), asc(aiConnectionPoolMembers.priority));
  const connectionOf = sql<string | null>`${heartbeatRuns.contextSnapshot} -> 'aiConnection' ->> 'connectionId'`;
  const lastRuns = await tx
    .selectDistinctOn([heartbeatRuns.agentId], { agentId: heartbeatRuns.agentId, connectionId: connectionOf })
    .from(heartbeatRuns)
    .where(and(
      inArray(heartbeatRuns.agentId, poolAgents.map((agent) => agent.id)),
      gte(heartbeatRuns.createdAt, since),
      sql`${heartbeatRuns.contextSnapshot} -> 'aiConnection' ->> 'mode' = ${COMPANY_POOL_MODE}`,
    ))
    .orderBy(heartbeatRuns.agentId, desc(heartbeatRuns.createdAt));
  const lastConnection = new Map(lastRuns.map((row) => [row.agentId, row.connectionId]));

  const grantIds = unique(members.map((member) => member.grantId));
  const grants = grantIds.length > 0
    ? await tx
      .select({ id: connectionGrants.id, companyId: connectionGrants.companyId, refs: connectionGrants.credentialSecretRefs })
      .from(connectionGrants)
      .where(inArray(connectionGrants.id, grantIds))
    : [];
  const grantsById = new Map(grants.map((grant) => [grant.id, grant]));
  const refOf = (grantId: string) => {
    const grant = grantsById.get(grantId);
    const ref = (grant?.refs ?? []).find((candidate) => candidate?.configPath === AI_CREDENTIAL_CONFIG_PATH);
    return grant && ref && typeof ref.secretId === "string" && UUID_PATTERN.test(ref.secretId) ? { grant, ref } : null;
  };
  const secretIds = unique(grantIds.map(refOf).flatMap((found) => (found ? [found.ref.secretId] : [])));
  const secrets = secretIds.length > 0
    ? await tx
      .select({ id: companySecrets.id, companyId: companySecrets.companyId, latestVersion: companySecrets.latestVersion, deletedAt: companySecrets.deletedAt })
      .from(companySecrets)
      .where(inArray(companySecrets.id, secretIds))
    : [];
  const secretsById = new Map(secrets.map((secret) => [secret.id, secret]));
  const versions = secretIds.length > 0
    ? await tx
      .select({ secretId: companySecretVersions.secretId, version: companySecretVersions.version, valueSha256: companySecretVersions.valueSha256 })
      .from(companySecretVersions)
      .where(inArray(companySecretVersions.secretId, secretIds))
    : [];

  for (const agent of poolAgents) {
    const provider = asRecord(agent.aiConnection).provider;
    if (provider !== undefined && provider !== "anthropic") {
      result.set(agent.id, { ok: false, problem: "provider" });
      continue;
    }
    const own = members.filter((member) => member.companyId === agent.companyId);
    const last = lastConnection.get(agent.id) ?? null;
    const lastUsed = last ? own.find((member) => member.connectionId === last) ?? null : null;
    const member = lastUsed ?? own[0] ?? null;
    if (!member) {
      result.set(agent.id, { ok: false, problem: "no_members" });
      continue;
    }
    const found = refOf(member.grantId);
    // Company boundary: the grant and the secret must belong to the agent's company.
    const secret = found && found.grant.companyId === agent.companyId ? secretsById.get(found.ref.secretId) ?? null : null;
    const wanted = found && typeof found.ref.versionSelector === "number" ? found.ref.versionSelector : secret?.latestVersion;
    const version = secret && secret.companyId === agent.companyId && !secret.deletedAt
      ? versions.find((row) => row.secretId === secret.id && row.version === wanted) ?? null
      : null;
    if (!version) {
      result.set(agent.id, { ok: false, problem: "no_credential" });
      continue;
    }
    const account = accountsByFingerprint.get(version.valueSha256) ?? null;
    result.set(agent.id, account ? { ok: true, account, lastUsedMember: lastUsed !== null } : { ok: false, problem: "no_match" });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Account choice (D7)
// ---------------------------------------------------------------------------

function chooseHostPoolAccount(input: {
  candidates: readonly CandidateDevice[];
  agentProjects: ReadonlySet<string>;
  reservations: ReadonlyArray<{ accountId: string; projectId: string }>;
  agentHistory: readonly HistoryRow[];
  companyHistory: readonly HistoryRow[];
  accountsById: ReadonlyMap<string, AiAccountRow>;
}): AccountChoice | null {
  // 1. Exactly one account reserved for the agent's projects.
  const reserved = unique(input.reservations
    .filter((row) => input.agentProjects.has(row.projectId) && input.accountsById.has(row.accountId))
    .map((row) => row.accountId));
  if (reserved.length === 1) return { rule: "reservation", account: input.accountsById.get(reserved[0]!)!, runs: null };

  // 2. The account this agent used most.
  const own = new Map<string, number>();
  for (const row of input.agentHistory) own.set(row.accountId, (own.get(row.accountId) ?? 0) + row.runs);
  const agentPick = mostUsed(own, input.accountsById);
  if (agentPick) return { rule: "agent_history", account: agentPick.account, runs: agentPick.runs };

  // 3. The account the agent's company used most on the agent's devices.
  const deviceIds = new Set(distinctDevices(input.candidates).map((device) => device.id));
  const company = new Map<string, number>();
  for (const row of input.companyHistory) {
    if (row.deviceId && deviceIds.has(row.deviceId)) company.set(row.accountId, (company.get(row.accountId) ?? 0) + row.runs);
  }
  const companyPick = mostUsed(company, input.accountsById);
  if (companyPick) return { rule: "company_history", account: companyPick.account, runs: companyPick.runs };

  // 4. No choice.
  return null;
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

async function readMarker(db: Db | Tx): Promise<MarkerRow | null> {
  const [row] = await db.select().from(deferredDataMigrations).where(eq(deferredDataMigrations.key, AI_ACCOUNT_BINDING_MIGRATION_KEY));
  return row ?? null;
}

/** Marks the job running and counts the attempt; false when a boot run finds it already completed. */
async function markRunning(db: Db, force: boolean): Promise<boolean> {
  const rows = await db
    .insert(deferredDataMigrations)
    .values({ key: AI_ACCOUNT_BINDING_MIGRATION_KEY, status: "running", attempts: 1 })
    .onConflictDoUpdate({
      target: deferredDataMigrations.key,
      set: { status: "running", attempts: sql`${deferredDataMigrations.attempts} + 1`, lastError: null },
      ...(force ? {} : { setWhere: ne(deferredDataMigrations.status, "completed") }),
    })
    .returning({ key: deferredDataMigrations.key });
  return rows.length > 0;
}

async function markFailed(db: Db, message: string): Promise<void> {
  await db
    .insert(deferredDataMigrations)
    .values({ key: AI_ACCOUNT_BINDING_MIGRATION_KEY, status: "failed", attempts: 1, lastError: message })
    .onConflictDoUpdate({ target: deferredDataMigrations.key, set: { status: "failed", lastError: message } });
}

function isAgentEntry(value: unknown): value is AiAccountMigrationAgentEntry {
  const entry = asRecord(value);
  return typeof entry.agentId === "string"
    && typeof entry.companyId === "string"
    && (AI_ACCOUNT_MIGRATION_OUTCOMES as readonly unknown[]).includes(entry.outcome)
    && (entry.rule === null || (AI_ACCOUNT_MIGRATION_RULES as readonly unknown[]).includes(entry.rule));
}

function isDeviceEntry(value: unknown): value is AiAccountMigrationDeviceEntry {
  const entry = asRecord(value);
  return typeof entry.deviceId === "string" && typeof entry.deviceName === "string"
    && typeof entry.limit === "number" && typeof entry.inUse === "number";
}

/** The stored summary, or null when there is none (the job never completed). */
function readSummary(value: unknown): AiAccountMigrationSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const entries = Array.isArray(record.agents) ? record.agents.filter(isAgentEntry) : [];
  const devices = Array.isArray(record.overLimitDevices) ? record.overLimitDevices.filter(isDeviceEntry) : [];
  return { ...countOutcomes(entries), agents: entries, overLimitDevices: devices };
}

function countOutcomes(entries: readonly AiAccountMigrationAgentEntry[]): Pick<AiAccountMigrationSummary, "bound" | "unassigned" | "unbound"> {
  return {
    bound: entries.filter((entry) => entry.outcome === "bound").length,
    unassigned: entries.filter((entry) => entry.outcome === "unassigned").length,
    unbound: entries.filter((entry) => entry.outcome === "unbound").length,
  };
}

/**
 * The run's summary merged with the previous one: an earlier entry stays while
 * it still describes the agent (its migrated row is unchanged, or it is still
 * waiting for an account); a re-evaluated agent gets its new entry. Devices
 * are listed while they are full after refusing a migrated binding, or over
 * their cap.
 */
async function mergeSummary(
  tx: Tx,
  input: {
    previous: AiAccountMigrationSummary | null;
    entries: AiAccountMigrationAgentEntry[];
    order: ReadonlyMap<string, { companyId: string; createdAt: Date }>;
    refusedDeviceIds: ReadonlySet<string>;
    bound: ReadonlyMap<string, ReadonlySet<string>>;
  },
): Promise<AiAccountMigrationSummary> {
  const evaluated = new Set(input.entries.map((entry) => entry.agentId));
  const earlier = (input.previous?.agents ?? []).filter((entry) => !evaluated.has(entry.agentId) && entry.outcome !== "unbound");
  const order = new Map(input.order);
  const kept: AiAccountMigrationAgentEntry[] = [];
  if (earlier.length > 0) {
    const ids = unique(earlier.map((entry) => entry.agentId));
    const rows = await tx
      .select({
        id: agents.id,
        companyId: agents.companyId,
        companyName: companies.name,
        name: agents.name,
        status: agents.status,
        createdAt: agents.createdAt,
        mode: aiAccountAgentBindings.mode,
        accountId: aiAccountAgentBindings.accountId,
        source: aiAccountAgentBindings.source,
      })
      .from(agents)
      .innerJoin(companies, eq(companies.id, agents.companyId))
      .innerJoin(aiAccountAgentBindings, and(eq(aiAccountAgentBindings.agentId, agents.id), eq(aiAccountAgentBindings.companyId, agents.companyId)))
      .where(inArray(agents.id, ids));
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const entry of earlier) {
      const row = byId.get(entry.agentId);
      const unchanged = row
        && row.status !== "terminated"
        && row.source !== "manual"
        && row.mode === "pool_account"
        && (row.accountId ?? null) === (entry.outcome === "bound" ? entry.accountId : null);
      if (!row || !unchanged) continue;
      kept.push({ ...entry, agentName: row.name, companyId: row.companyId, companyName: row.companyName });
      order.set(row.id, { companyId: row.companyId, createdAt: row.createdAt });
    }
  }
  const merged = [...kept, ...input.entries].sort((a, b) => {
    const left = order.get(a.agentId);
    const right = order.get(b.agentId);
    return compareText(left?.companyId ?? a.companyId, right?.companyId ?? b.companyId)
      || (left?.createdAt.getTime() ?? 0) - (right?.createdAt.getTime() ?? 0)
      || compareText(a.agentId, b.agentId);
  });

  const listed = new Set([...input.refusedDeviceIds, ...(input.previous?.overLimitDevices ?? []).map((device) => device.deviceId)]);
  const deviceIds = unique([...listed, ...input.bound.keys()]);
  const devices = deviceIds.length > 0
    ? await tx.select().from(aiAccountHosts).where(inArray(aiAccountHosts.id, deviceIds)).orderBy(asc(aiAccountHosts.name))
    : [];
  const overLimitDevices: AiAccountMigrationDeviceEntry[] = [];
  for (const device of devices) {
    const inUse = input.bound.get(device.id)?.size ?? 0;
    const limit = capOf(device);
    if (inUse > limit || (listed.has(device.id) && inUse >= limit)) {
      overLimitDevices.push({ deviceId: device.id, deviceName: device.name, limit, inUse });
    }
  }
  return { ...countOutcomes(merged), agents: merged, overLimitDevices };
}

/** Steps 3–7 of the job inside the locked transaction. */
async function backfillBindings(
  tx: Tx,
  input: { now: Date; deploymentMode: DeploymentMode | undefined; updatedByUserId: string | null; previous: AiAccountMigrationSummary | null },
): Promise<{ summary: AiAccountMigrationSummary; inserted: InsertedBinding[] }> {
  const { now, deploymentMode } = input;
  const since = new Date(now.getTime() - AI_ACCOUNT_MIGRATION_HISTORY_DAYS * DAY_MS);
  const considered = (await unboundClaudeAgents(tx)).filter((agent) => !hasAiConnection(agent) || isCompanyPoolAgent(agent));
  const hostPoolAgents = considered.filter((agent) => !hasAiConnection(agent));
  const poolAgents = considered.filter(isCompanyPoolAgent);

  const accountRows = await tx.select().from(aiAccounts);
  const accountsById = new Map(accountRows.map((row) => [row.id, row]));
  const accountsByFingerprint = new Map(accountRows.map((row) => [row.credentialFingerprint, row]));
  // Devices whose legacy host-pool accounts the old image could pick from.
  const usableDeviceIds = new Set(accountRows
    .filter((row) => row.hostId && row.status === "active" && !row.adminDisabledAt)
    .map((row) => row.hostId!));
  const history = await hostPoolHistory(tx, since);
  const historyByAgent = new Map<string, HistoryRow[]>();
  const historyByCompany = new Map<string, HistoryRow[]>();
  for (const row of history) {
    const ofAgent = historyByAgent.get(row.agentId) ?? [];
    ofAgent.push(row);
    historyByAgent.set(row.agentId, ofAgent);
    const ofCompany = historyByCompany.get(row.companyId) ?? [];
    ofCompany.push(row);
    historyByCompany.set(row.companyId, ofCompany);
  }
  const projectsByAgent = await projectsOfAgents(tx, hostPoolAgents.map((agent) => agent.id), since);
  const reservations = await tx.select({ accountId: aiAccountProjects.accountId, projectId: aiAccountProjects.projectId }).from(aiAccountProjects);
  const poolMatches = await companyPoolMatches(tx, poolAgents, accountsByFingerprint, since);
  // One batch for every candidate; the Local environment's server device is created on first use.
  const candidatesByAgent = await candidateDevicesForAgents(tx, considered.map((agent) => poolPlacementOf(agent)));
  // bound(D) of every existing binding, extended in processing order as this run binds.
  const bound = new Map<string, Set<string>>();
  for (const [deviceId, entry] of await boundAccountsByDevice(tx)) bound.set(deviceId, new Set(entry.accountIds));

  const entries: AiAccountMigrationAgentEntry[] = [];
  const inserted: InsertedBinding[] = [];
  const order = new Map<string, { companyId: string; createdAt: Date }>();
  const refusedDeviceIds = new Set<string>();

  const check = async (agent: UnboundAgent, candidates: readonly CandidateDevice[], account: AiAccountRow) =>
    checkAccountBinding(tx, {
      agent: poolPlacementOf(agent),
      account,
      checkEligibility: true,
      newSelection: true,
      deploymentMode,
      now,
      candidates,
      boundAccounts: bound,
    });

  for (const agent of considered) {
    const candidates = candidatesByAgent.get(agent.id) ?? [];
    let decision: Decision;
    let source: AiAccountBindingSource;
    if (isCompanyPoolAgent(agent)) {
      source = "migrated_company_pool";
      const match = poolMatches.get(agent.id) ?? { ok: false as const, problem: "no_match" as const };
      if (!match.ok) {
        decision = { outcome: "unbound", choice: null, rule: "company_pool_fingerprint", note: poolProblemNote(match.problem) };
      } else {
        const choice: AccountChoice = { rule: "company_pool_fingerprint", account: match.account, runs: null, lastUsedMember: match.lastUsedMember };
        const result = await check(agent, candidates, match.account);
        if (result.ok) {
          decision = { outcome: "bound", choice, devices: result.devices, note: chosenNote(choice) };
        } else {
          // A pinned company pool keeps working (spec 15.5), the cap included.
          if (result.failure.code === "device_account_limit") refusedDeviceIds.add(result.failure.deviceId);
          decision = { outcome: "unbound", choice, rule: choice.rule, note: failedNote(choice, result.failure, "company_pool") };
        }
      }
    } else {
      source = "migrated_host_pool";
      const agentHistory = historyByAgent.get(agent.id) ?? [];
      const withHistory = agentHistory.length > 0;
      const onPoolDevice = candidates.some((candidate) => candidate.device !== null && usableDeviceIds.has(candidate.device.id));
      // Not a host-pool agent: it never used the pool and cannot reach one.
      if (!withHistory && !onPoolDevice) continue;
      const choice = chooseHostPoolAccount({
        candidates,
        agentProjects: projectsByAgent.get(agent.id) ?? new Set(),
        reservations,
        agentHistory,
        companyHistory: historyByCompany.get(agent.companyId) ?? [],
        accountsById,
      });
      if (!choice) {
        decision = { outcome: "unbound", choice: null, rule: null, note: NO_CHOICE_NOTE };
      } else {
        const result = await check(agent, candidates, choice.account);
        if (result.ok) {
          decision = { outcome: "bound", choice, devices: result.devices, note: chosenNote(choice) };
        } else if (result.failure.code === "device_account_limit") {
          refusedDeviceIds.add(result.failure.deviceId);
          decision = { outcome: "unassigned", choice, note: failedNote(choice, result.failure, "unassigned") };
        } else if (withHistory) {
          decision = { outcome: "unassigned", choice, note: failedNote(choice, result.failure, "unassigned") };
        } else {
          decision = { outcome: "unbound", choice, rule: choice.rule, note: failedNote(choice, result.failure, "unbound") };
        }
      }
    }

    const accountId = decision.outcome === "bound" ? decision.choice.account.id : null;
    if (decision.outcome !== "unbound") {
      const rows = await tx
        .insert(aiAccountAgentBindings)
        .values({
          agentId: agent.id,
          companyId: agent.companyId,
          mode: "pool_account",
          accountId,
          source,
          migrationNote: decision.note,
          reviewedAt: null,
          updatedByUserId: input.updatedByUserId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: aiAccountAgentBindings.agentId })
        .returning({ agentId: aiAccountAgentBindings.agentId });
      // A row that appeared meanwhile is someone's own choice: it is not this run's to report.
      if (rows.length === 0) continue;
      if (decision.outcome === "bound") {
        for (const device of decision.devices) {
          const set = bound.get(device.id) ?? new Set<string>();
          set.add(decision.choice.account.id);
          bound.set(device.id, set);
        }
      }
      inserted.push({
        agentId: agent.id,
        companyId: agent.companyId,
        accountId,
        accountLabel: decision.outcome === "bound" ? decision.choice.account.label : null,
        source,
        rule: decision.choice?.rule ?? null,
        note: decision.note,
      });
    }
    order.set(agent.id, { companyId: agent.companyId, createdAt: agent.createdAt });
    entries.push({
      agentId: agent.id,
      agentName: agent.name,
      companyId: agent.companyId,
      companyName: agent.companyName,
      outcome: decision.outcome,
      accountId: decision.choice?.account.id ?? null,
      accountLabel: decision.choice?.account.label ?? null,
      rule: decision.outcome === "unbound" ? decision.rule : decision.choice?.rule ?? null,
      note: decision.note,
    });
  }

  const summary = await mergeSummary(tx, { previous: input.previous, entries, order, refusedDeviceIds, bound });
  return { summary, inserted };
}

/** After commit: wake the agents' waits and log each new binding in its agent's company. Best effort. */
async function afterCommit(
  db: Db,
  inserted: readonly InsertedBinding[],
  input: { now: Date; actor: AiAccountMigrationOptions["actor"] },
): Promise<void> {
  if (inserted.length === 0) return;
  try {
    await wakeResourceWaits(db, { agentIds: inserted.map((row) => row.agentId) }, { now: input.now });
  } catch (error) {
    logger.warn({ err: error }, "failed to wake resource waits after the Claude account migration");
  }
  const audit: PoolAuditActor = input.actor?.audit ?? { actorType: "system", actorId: AI_ACCOUNT_MIGRATION_ACTOR_ID };
  for (const row of inserted) {
    try {
      await logActivity(db, {
        companyId: row.companyId,
        actorType: audit.actorType,
        actorId: audit.actorId,
        agentId: audit.agentId ?? null,
        runId: audit.runId ?? null,
        agentApiKeyId: audit.agentApiKeyId ?? null,
        action: "ai_account.binding_updated",
        entityType: "agent",
        entityId: row.agentId,
        details: {
          mode: "pool_account",
          accountId: row.accountId,
          // A bound account passed eligibility, so its owner is a member of this company.
          ...(row.accountLabel ? { accountLabel: row.accountLabel } : {}),
          source: row.source,
          rule: row.rule,
          migrationNote: row.note,
          previousMode: null,
          previousAccountId: null,
        },
      });
    } catch (error) {
      logger.warn({ err: error, agentId: row.agentId }, "failed to log a migrated Claude account binding");
    }
  }
}

/**
 * The binding backfill job (spec 15.3), marker `ai-account-bindings-v1`.
 * W8 awaits it once at boot, after the migrations and before the scheduler
 * starts; the instance admin's re-run passes `force`. It never throws: a
 * failure is logged, marked `failed` with its message, and returned.
 */
export async function runDeferredAiAccountMigration(db: Db, options: AiAccountMigrationOptions = {}): Promise<AiAccountMigrationRunResult> {
  const now = options.now ?? new Date();
  const force = options.force === true;
  try {
    // 1. A completed job is done; only an explicit re-run repeats it.
    if (!force && (await readMarker(db))?.status === "completed") return { status: "skipped", reason: "completed" };
    if (!(await markRunning(db, force))) return { status: "skipped", reason: "completed" };
    const deploymentMode = options.deploymentMode ?? configuredDeploymentMode();
    const outcome = await db.transaction(async (tx) => {
      // 2. The bindings advisory lock serializes this run with binding changes and with another server's boot.
      await acquireBindingsLock(tx);
      const [marker] = await tx.select().from(deferredDataMigrations)
        .where(eq(deferredDataMigrations.key, AI_ACCOUNT_BINDING_MIGRATION_KEY))
        .for("update");
      if (!force && marker?.status === "completed") return null;
      // 3–6. Choose, check and insert.
      const result = await backfillBindings(tx, {
        now,
        deploymentMode,
        updatedByUserId: options.actor?.userId ?? null,
        previous: readSummary(marker?.summary),
      });
      // 7. The summary and the marker commit with the bindings.
      await tx.update(deferredDataMigrations)
        .set({
          status: "completed",
          summary: result.summary as unknown as Record<string, unknown>,
          completedAt: options.now ?? new Date(),
          lastError: null,
        })
        .where(eq(deferredDataMigrations.key, AI_ACCOUNT_BINDING_MIGRATION_KEY));
      return result;
    });
    if (!outcome) return { status: "skipped", reason: "completed" };
    await afterCommit(db, outcome.inserted, { now, actor: options.actor });
    logger.info(
      { added: outcome.inserted.length, bound: outcome.summary.bound, unassigned: outcome.summary.unassigned, unbound: outcome.summary.unbound },
      "Claude account binding backfill completed",
    );
    return { status: "completed", added: outcome.inserted.length, summary: outcome.summary };
  } catch (error) {
    // 8. Never block boot.
    const message = errorText(error);
    logger.error({ err: error }, "the Claude account binding backfill failed; boot continues");
    try {
      await markFailed(db, message);
    } catch (markError) {
      logger.error({ err: markError }, "could not mark the Claude account binding backfill as failed");
    }
    return { status: "failed", error: message };
  }
}

// ---------------------------------------------------------------------------
// Previews and go/no-go
// ---------------------------------------------------------------------------

type PreviewAgent = Pick<typeof agents.$inferSelect, "id" | "companyId" | "name" | "adapterType" | "defaultEnvironmentId">;

const PREVIEW_SEVERITY: Record<CredentialPlanPreview["outcome"], number> = { use: 0, none: 1, wait: 2, refuse: 3 };

/**
 * Go/no-go wording for why an agent's runs would get no pool account (plan
 * `none`, which the instance page reads as "would use its device's own
 * login"); shown as is.
 */
const NO_POOL_ACCOUNT_TEXT: Record<Extract<CredentialPlanPreview, { outcome: "none" }>["reason"], string> = {
  unbound: "no Claude account is assigned",
  device_login: "set explicitly in its Claude account selection",
  adapter_unsupported: "it is not a Claude agent",
};

function previewReason(preview: CredentialPlanPreview): string | null {
  switch (preview.outcome) {
    case "use":
      return null;
    case "wait":
    case "none":
      return preview.reason;
    case "refuse":
      return preview.message;
  }
}

async function previewPlans(
  db: Db,
  agentList: readonly PreviewAgent[],
  opts: { deploymentMode?: DeploymentMode; now?: Date },
): Promise<Map<string, AiAccountPlanPreview>> {
  const result = new Map<string, AiAccountPlanPreview>();
  if (agentList.length === 0) return result;
  const now = opts.now ?? new Date();
  const deploymentMode = opts.deploymentMode ?? configuredDeploymentMode();
  // A dry run: nothing is created, so a device a run would create on first use counts as known.
  const candidatesByAgent = await candidateDevicesForAgents(db, agentList.map((agent) => poolPlacementOf(agent)), { create: false });
  for (const agent of agentList) {
    const binding = await readBinding(db, { agent });
    const candidates = candidatesByAgent.get(agent.id) ?? [];
    const targets: Array<{ environmentId: string | null; environment: ExecutionEnvironmentRow | null }> = candidates.length > 0
      ? candidates.map((candidate) => ({ environmentId: candidate.environmentId, environment: candidate.environment }))
      : [{ environmentId: null, environment: null }];
    const environments: AiAccountPlanPreviewEnvironment[] = [];
    for (const target of targets) {
      const preview = await previewCredentialPlan(db, { agent, environment: target.environment, binding, now, deploymentMode });
      environments.push({ environmentId: target.environmentId, environmentName: target.environment?.name ?? null, preview });
    }
    const worst = environments.reduce((a, b) => (PREVIEW_SEVERITY[b.preview.outcome] > PREVIEW_SEVERITY[a.preview.outcome] ? b : a));
    result.set(agent.id, {
      agentId: agent.id,
      agentName: agent.name,
      companyId: agent.companyId,
      outcome: worst.preview.outcome,
      reason: previewReason(worst.preview),
      environments,
    });
  }
  return result;
}

/**
 * A dry run of `planCredential` for one agent (W7b's `previewCredentialPlan`)
 * over each of its candidate environments (spec 5.3 step 4), with the worst
 * outcome first. Creates nothing and claims nothing; the device cap is checked
 * at run time only. Null for an unknown agent.
 */
export async function previewPlan(
  db: Db,
  agentId: string,
  opts: { deploymentMode?: DeploymentMode; now?: Date } = {},
): Promise<AiAccountPlanPreview | null> {
  if (!UUID_PATTERN.test(agentId)) return null;
  const [agent] = await db
    .select({ id: agents.id, companyId: agents.companyId, name: agents.name, adapterType: agents.adapterType, defaultEnvironmentId: agents.defaultEnvironmentId })
    .from(agents)
    .where(eq(agents.id, agentId));
  if (!agent) return null;
  return (await previewPlans(db, [agent], opts)).get(agent.id) ?? null;
}

/**
 * Go/no-go (spec 15.3): every non-terminated Claude agent with a host-pool run
 * in the last 7 days, with its preview and its company. `go` only when each
 * one would use its account. An agent that would get no pool account at all
 * is listed as `none` (its runs would use the device's own login) with the
 * reason in words. An agent without a binding row that now has its own AI
 * connection (`runtimeConfig.aiConnection`) is left out: its runs use that
 * connection, never the device's own login.
 */
export async function aiAccountMigrationGoNoGo(
  db: Db,
  opts: { deploymentMode?: DeploymentMode; now?: Date } = {},
): Promise<AiAccountMigrationReport["goNoGo"]> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - AI_ACCOUNT_MIGRATION_GO_NO_GO_DAYS * DAY_MS);
  const rows = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      companyName: companies.name,
      name: agents.name,
      adapterType: agents.adapterType,
      defaultEnvironmentId: agents.defaultEnvironmentId,
      runtimeConfig: agents.runtimeConfig,
      bindingAgentId: aiAccountAgentBindings.agentId,
    })
    .from(agents)
    .innerJoin(companies, eq(companies.id, agents.companyId))
    .leftJoin(aiAccountAgentBindings, eq(aiAccountAgentBindings.agentId, agents.id))
    .where(and(
      eq(agents.adapterType, POOL_ACCOUNT_ADAPTER_TYPE),
      ne(agents.status, "terminated"),
      sql`exists (
        select 1 from ${heartbeatRuns}
        where ${heartbeatRuns.agentId} = ${agents.id}
          and ${heartbeatRuns.companyId} = ${agents.companyId}
          and ${heartbeatRuns.createdAt} >= ${since.toISOString()}::timestamptz
          and ${heartbeatRuns.contextSnapshot} -> 'aiConnection' ->> 'mode' = ${LEGACY_HOST_POOL_ATTRIBUTION_MODE}
      )`,
    ))
    .orderBy(asc(agents.companyId), asc(agents.createdAt), asc(agents.id));
  const recent = rows.filter((row) => row.bindingAgentId !== null || !hasAiConnection({ aiConnection: asRecord(row.runtimeConfig).aiConnection }));
  const previews = await previewPlans(
    db,
    recent.map(({ runtimeConfig: _runtimeConfig, bindingAgentId: _bindingAgentId, companyName: _companyName, ...agent }): PreviewAgent => agent),
    { ...opts, now },
  );
  const entries = recent.map((agent): AiAccountMigrationGoNoGoEntry => {
    const preview = previews.get(agent.id)!;
    return {
      agentId: agent.id,
      agentName: agent.name,
      companyId: agent.companyId,
      companyName: agent.companyName,
      plan: preview.outcome,
      reason: preview.outcome === "none"
        ? NO_POOL_ACCOUNT_TEXT[preview.reason as keyof typeof NO_POOL_ACCOUNT_TEXT] ?? preview.reason
        : preview.reason,
    };
  });
  return { go: entries.every((entry) => entry.plan === "use"), agents: entries };
}

function markerStatus(marker: MarkerRow | null): DeferredDataMigrationStatus {
  return marker && (DEFERRED_DATA_MIGRATION_STATUSES as readonly string[]).includes(marker.status)
    ? marker.status as DeferredDataMigrationStatus
    : "pending";
}

/**
 * `GET /api/instance/ai-accounts/migration`: the job's state and summary
 * (`pending` with a null summary before it ever ran) and a fresh go/no-go.
 */
export async function readAiAccountMigrationReport(
  db: Db,
  opts: { deploymentMode?: DeploymentMode; now?: Date } = {},
): Promise<AiAccountMigrationReport> {
  const marker = await readMarker(db);
  return {
    key: AI_ACCOUNT_BINDING_MIGRATION_KEY,
    status: markerStatus(marker),
    attempts: marker?.attempts ?? 0,
    lastError: marker?.lastError ?? null,
    completedAt: marker?.completedAt ? marker.completedAt.toISOString() : null,
    summary: readSummary(marker?.summary),
    goNoGo: await aiAccountMigrationGoNoGo(db, opts),
  };
}
