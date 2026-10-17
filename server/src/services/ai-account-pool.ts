import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  type Db,
  agents,
  aiAccountAgentBindings,
  aiAccountHosts,
  aiAccountProjects,
  aiAccounts,
  authUsers,
  companies,
  companyMemberships,
  costEvents,
  heartbeatRuns,
  projects,
} from "@paperclipai/db";
import {
  credentialTypeOfValue,
  deriveAiAccountState,
  type AgentAiAccountBindingDetail,
  type AgentAiAccountBindingSummary,
  type AiAccountBindingAccountRef,
  type AiAccountBindingMode,
  type AiAccountBindingState,
  type AiAccountIncompatibleErrorDetails,
  type AiAccountIncompatibleReason,
  type AiAccountInUseErrorDetails,
  type AiAccountOwnerRef,
  type AiAccountPlanWaitReason,
  type AiAccountProjectSummary,
  type AiAccountSelectionWarning,
  type AiAccountUnselectableReason,
  type AiAccountUsage,
  type AiAccountUsageWindow,
  type AiAccountUsedByCompany,
  type CompanyAiAccountBindingsResponse,
  type CompanyAiAccountOption,
  type CompanyAiAccountsResponse,
  type CreateMyAiAccount,
  type DeploymentMode,
  type DeviceAccountLimitErrorDetails,
  type ExecutionDeviceOwner,
  type ExecutionDeviceRef,
  type InstanceAiAccountSummary,
  type InstanceAiAccountsResponse,
  type MyAiAccount,
  type MyAiAccountsResponse,
  type ReplaceAiAccountCredential,
  type SetAgentAiAccount,
  type SetAgentAiAccountResponse,
  type UpdateInstanceAiAccount,
  type UpdateMyAiAccount,
} from "@paperclipai/shared";
import { resolveDeploymentMode } from "../config-file.js";
import { conflict, forbidden, type HttpError, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity, type LogActivityInput } from "./activity-log.js";
import {
  aiAccountDuplicateError,
  assertCredentialShape,
  credentialFingerprint,
  credentialHint,
  encryptCredential,
  resolveImportedCredential,
} from "./ai-account-credentials.js";
import {
  acceptedCredentialTypes,
  acceptsCredentialType,
  acquireBindingsLock,
  boundAccountsByDevice,
  candidateDevicesForAgent,
  candidateDevicesForAgents,
  capOf,
  markOverLimitIfNeeded,
  wouldExceedDeviceCap,
  type CandidateDevice,
  type DeviceDb,
  type DeviceLimitCheck,
  type DevicePlacementAgent,
  type ExecutionDeviceRow,
} from "./execution-devices.js";
import { effectiveAccountOwner, evaluateAccountPlan } from "./resource-waits/account-plan.js";
import { wakeResourceWaits, type ResourceWaitWakeFilter } from "./resource-waits/wake.js";
import { noteDeviceOverLimit } from "./attention-resource-waits.js";

/**
 * Fork: the user-owned Claude account pool (spec 5, 12 and 14).
 *
 * - Owners add, edit, pause, re-token and remove their own accounts. An
 *   account is usable only in companies where its owner is an active member
 *   (`evaluateAccountPlan`, the same predicate the run path and the hold use).
 * - The owner, or a company admin, binds an agent to one account or to its
 *   device's own login. Every binding change and every move of a pool-bound
 *   agent runs under the bindings advisory lock with the device checks of
 *   spec 5.3: a device for every candidate environment, the credential type,
 *   and at most `capOf(device)` distinct accounts per device. No check looks
 *   at who owns a device.
 * - Instance admins see every account, disable and re-enable them, clear
 *   limits, remove them, and transfer them to another existing user.
 *
 * Paperclip never moves a task to another account: a binding is read at
 * every run start and a change applies from the agent's next run. Waits are
 * woken after every change. No response, activity entry or log line carries
 * a credential value.
 *
 * Audit: binding events go to the agent's company; account events go to every
 * company where the owner is an active member, and nowhere else.
 */

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type PoolDb = Db | Tx;
export type AiAccountRow = typeof aiAccounts.$inferSelect;
export type PoolAgentRow = Pick<
  typeof agents.$inferSelect,
  "id" | "companyId" | "name" | "status" | "adapterType" | "defaultEnvironmentId" | "runtimeConfig"
>;

/** The only adapter whose runs use a pool binding (spec 4.1, 5.3 step 2). */
export const POOL_ACCOUNT_ADAPTER_TYPE = "claude_local";
/** Activity actor of the pool's own system entries (device over-limit notices). */
export const AI_ACCOUNT_POOL_SYSTEM_ACTOR_ID = "ai-account-pool";
const LOCAL_BOARD_USER_ID = "local-board";
const EMPTY_SET: ReadonlySet<string> = new Set();
/** planCredential rows that leave an account eligible (spec 5.2): signed-out and limited accounts carry a state. */
const ELIGIBLE_PLAN_REASONS: ReadonlySet<AiAccountPlanWaitReason | null> = new Set([null, "signed_out", "usage_limit", "credit_balance"]);

// ---------------------------------------------------------------------------
// Actors and permissions (spec 5.1, decision D4)
// ---------------------------------------------------------------------------

/** The request actor fields the pool reads; `req.actor` fits. */
export interface PoolActor {
  type: "board" | "agent" | "none";
  userId?: string | null;
  agentId?: string | null;
  source?: string | null;
  isInstanceAdmin?: boolean;
  companyIds?: readonly string[];
  memberships?: ReadonlyArray<{ companyId: string; membershipRole?: string | null; status?: string }>;
}

/** Who an activity entry names; `getActorInfo(req)` fits. */
export type PoolAuditActor = Pick<LogActivityInput, "actorType" | "actorId" | "agentId" | "runId" | "agentApiKeyId">;

export interface PoolContext {
  actor: PoolActor;
  audit: PoolAuditActor;
}

function activeMembership(actor: PoolActor, companyId: string) {
  return actor.memberships?.find((membership) =>
    membership.companyId === companyId && (membership.status === undefined || membership.status === "active")) ?? null;
}

/** `local_implicit` or an instance admin. */
export function isInstanceAdminActor(actor: PoolActor): boolean {
  return actor.type === "board" && (actor.source === "local_implicit" || actor.isInstanceAdmin === true);
}

/**
 * The canonical company-admin predicate (spec 5.1, decision D4): the
 * `local_implicit` board, an active membership with role owner or admin, or
 * an instance admin with access to the company (its `companyIds` include it,
 * whatever the membership role). Agents are never company admins.
 */
export function isCompanyAdmin(actor: PoolActor, companyId: string): boolean {
  if (actor.type !== "board") return false;
  if (actor.source === "local_implicit") return true;
  const membership = activeMembership(actor, companyId);
  if (membership?.membershipRole === "owner" || membership?.membershipRole === "admin") return true;
  return actor.isInstanceAdmin === true && (actor.companyIds ?? []).includes(companyId);
}

/** An active member of the company who is not a viewer: an account owner binds only as such. */
export function isActiveNonViewerMember(actor: PoolActor, companyId: string): boolean {
  if (actor.type !== "board") return false;
  if (actor.source === "local_implicit") return true;
  if (!(actor.companyIds ?? []).includes(companyId)) return false;
  // Actors without a membership list pass on company access alone, as assertCompanyAccess does.
  if (!Array.isArray(actor.memberships)) return true;
  const membership = activeMembership(actor, companyId);
  return membership !== null && membership.membershipRole !== "viewer";
}

/** Whether the actor may bind this account to an agent of the company: a company admin, or its owner as a non-viewer member. */
export function canBindAccount(
  actor: PoolActor,
  companyId: string,
  account: Pick<AiAccountRow, "ownerUserId" | "createdByUserId">,
): boolean {
  if (isCompanyAdmin(actor, companyId)) return true;
  return Boolean(actor.userId) && effectiveAccountOwner(account) === actor.userId && isActiveNonViewerMember(actor, companyId);
}

/** An agent's current binding as the permission rules read it. */
export interface BindingPermissionState {
  mode: AiAccountBindingMode;
  accountId: string | null;
  /** The bound account's effective owner; null without an account. */
  accountOwnerId: string | null;
}

export type BindingChange =
  | { mode: "pool_account"; accountOwnerId: string | null }
  | { mode: "device_login" }
  | { mode: "clear" };

/**
 * Spec 5.1. Agents never change a binding. A company admin changes any
 * binding in the company. An account owner (an active non-viewer member)
 * binds their own account while the agent is unbound, on its device login,
 * on `pool_account` without an account, or on one of the owner's accounts;
 * the owner sets the device login or clears the binding only while the agent
 * is on one of the owner's accounts.
 */
export function mayChangeBinding(
  actor: PoolActor,
  companyId: string,
  current: BindingPermissionState | null,
  change: BindingChange,
): boolean {
  if (actor.type !== "board") return false;
  if (isCompanyAdmin(actor, companyId)) return true;
  if (!actor.userId || !isActiveNonViewerMember(actor, companyId)) return false;
  const ownsCurrent = current?.mode === "pool_account" && current.accountId !== null && current.accountOwnerId === actor.userId;
  if (change.mode === "pool_account") {
    const replaceable = !current || current.mode === "device_login" || current.accountId === null || ownsCurrent;
    return replaceable && change.accountOwnerId === actor.userId;
  }
  return ownsCurrent;
}

/** `canChange` of a binding summary: whether any change by this caller could be allowed (spec 5.1). */
export function mayEditBinding(actor: PoolActor, companyId: string, current: BindingPermissionState | null): boolean {
  if (actor.type !== "board") return false;
  if (isCompanyAdmin(actor, companyId)) return true;
  if (!actor.userId || !isActiveNonViewerMember(actor, companyId)) return false;
  return !current || current.mode === "device_login" || current.accountId === null || current.accountOwnerId === actor.userId;
}

function bindingForbidden(message = "Only the account's owner or a company admin can change this agent's Claude account."): HttpError {
  return forbidden(message, { code: "ai_account_binding_forbidden" });
}

/**
 * Refuses AI connection bindings the account pool retires (spec 4.1, 15.5):
 * any new or changed `company_pool` binding, and a `router` binding for a
 * Claude agent, because a router switches between accounts by itself.
 * Callers that may see an existing agent's unchanged binding use
 * `assertAccountPoolAllowsBindingChange`, so existing bindings keep working.
 */
export function assertAccountPoolAllowsManagedBinding(binding: { mode: string }, adapterType: string): void {
  if (binding.mode === "company_pool") {
    throw unprocessable("The company account pool is retired. Choose a Claude account for this agent instead.", {
      code: "ai_connection_company_pool_retired",
    });
  }
  if (binding.mode === "router" && adapterType === POOL_ACCOUNT_ADAPTER_TYPE) {
    throw unprocessable("A Claude agent cannot use a connection router, because a router switches accounts by itself. Choose a Claude account instead.", {
      code: "ai_connection_router_unsupported",
    });
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `assertAccountPoolAllowsManagedBinding` for new and changed bindings only.
 * An existing agent that keeps the binding it already has, on the adapter it
 * already has, passes: a pinned company pool keeps working (spec 15.5), and
 * so does an existing router, until either changes. The stored binding is
 * compared by value, because jsonb returns its keys in another order than
 * the request schema.
 */
export async function assertAccountPoolAllowsBindingChange(
  db: DeviceDb,
  input: { companyId: string; agentId: string; binding: { mode: string }; adapterType: string; newAgent: boolean },
): Promise<void> {
  const retired = input.binding.mode === "company_pool" || (input.binding.mode === "router" && input.adapterType === POOL_ACCOUNT_ADAPTER_TYPE);
  if (!retired) return;
  if (!input.newAgent && UUID_PATTERN.test(input.agentId)) {
    const [agent] = await db
      .select({ adapterType: agents.adapterType, runtimeConfig: agents.runtimeConfig })
      .from(agents)
      .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)));
    const stored = (agent?.runtimeConfig as Record<string, unknown> | null | undefined)?.aiConnection;
    if (agent && agent.adapterType === input.adapterType && isDeepStrictEqual(stored, input.binding)) return;
  }
  assertAccountPoolAllowsManagedBinding(input.binding, input.adapterType);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function asDb(db: PoolDb): Db {
  return db as unknown as Db;
}

function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * `updated_at` for a change that the lost-wake guard must notice (spec 7.3
 * step 5): never equal to the value it replaces, even within one clock tick.
 */
function touched(column: AnyPgColumn, now: Date): SQL {
  return sql`greatest(${now.toISOString()}::timestamptz, ${column} + interval '1 microsecond')`;
}

/** `pool_enabled` is dual-written for a rolled-back image: on unless the owner or an admin switched the account off. */
function poolEnabledFor(status: AiAccountRow["status"], adminDisabledAt: Date | null): boolean {
  return status !== "disabled" && adminDisabledAt === null;
}

/** `ab•••@example.com`, the same masking the UI uses. */
export function maskEmail(email: string | null | undefined): string | null {
  const value = email?.trim();
  if (!value) return null;
  const at = value.indexOf("@");
  if (at < 0) return `${value.slice(0, 2)}•••`;
  const local = value.slice(0, at);
  return `${local.slice(0, Math.min(2, local.length))}•••${value.slice(at)}`;
}

function accountStateOf(account: AiAccountRow, now: Date) {
  return deriveAiAccountState({ status: account.status, adminDisabledAt: account.adminDisabledAt, exhaustedUntil: account.exhaustedUntil }, now);
}

/** A limited account may still be chosen; its tasks wait for the reset. */
export function selectionWarnings(
  account: Pick<AiAccountRow, "exhaustedUntil" | "limitReason">,
  now: Date,
): AiAccountSelectionWarning[] {
  if (!account.exhaustedUntil || account.exhaustedUntil.getTime() <= now.getTime()) return [];
  return [account.limitReason === "credit_balance" ? "credit_balance" : "usage_limit"];
}

/** A bound agent is always placed as a Claude agent, as `boundAccountsByDevice` places it. */
export function poolPlacementOf(
  agent: Pick<PoolAgentRow, "id" | "companyId" | "defaultEnvironmentId">,
  defaultEnvironmentId: string | null = agent.defaultEnvironmentId,
): DevicePlacementAgent {
  return { id: agent.id, companyId: agent.companyId, adapterType: POOL_ACCOUNT_ADAPTER_TYPE, defaultEnvironmentId };
}

function distinctDevices(candidates: readonly CandidateDevice[]): ExecutionDeviceRow[] {
  const byId = new Map<string, ExecutionDeviceRow>();
  for (const candidate of candidates) {
    if (candidate.device) byId.set(candidate.device.id, candidate.device);
  }
  return [...byId.values()];
}

async function usersById(db: PoolDb, userIds: Iterable<string | null | undefined>): Promise<Map<string, { name: string | null; email: string | null }>> {
  const ids = unique([...userIds].filter((id): id is string => typeof id === "string" && id.length > 0));
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: authUsers.id, name: authUsers.name, email: authUsers.email }).from(authUsers).where(inArray(authUsers.id, ids));
  return new Map(rows.map((row) => [row.id, { name: row.name || null, email: row.email || null }]));
}

function deviceRefOf(device: ExecutionDeviceRow, users: Map<string, { name: string | null; email: string | null }>): ExecutionDeviceRef {
  let owner: ExecutionDeviceOwner | null = null;
  if (device.ownerUserId) {
    const user = users.get(device.ownerUserId);
    owner = { userId: device.ownerUserId, name: user?.name ?? null, email: user?.email ?? null };
  }
  return { id: device.id, name: device.name, kind: device.kind, owner };
}

// ---------------------------------------------------------------------------
// Membership and eligibility (spec 5.2)
// ---------------------------------------------------------------------------

/** Users who are active `user` members of the company; in `local_trusted` also the local board user. */
async function activeMemberUserIds(db: PoolDb, companyId: string, deploymentMode: DeploymentMode | undefined): Promise<Set<string>> {
  const rows = await db.select({ userId: companyMemberships.principalId }).from(companyMemberships).where(and(
    eq(companyMemberships.companyId, companyId),
    eq(companyMemberships.principalType, "user"),
    eq(companyMemberships.status, "active"),
  ));
  const members = new Set(rows.map((row) => row.userId));
  if (deploymentMode === "local_trusted") members.add(LOCAL_BOARD_USER_ID);
  return members;
}

/** The companies where a user is an active member; in `local_trusted` the local board user is in every company. */
async function memberCompanyIds(db: PoolDb, userId: string | null, deploymentMode: DeploymentMode | undefined): Promise<string[]> {
  if (!userId) return [];
  if (deploymentMode === "local_trusted" && userId === LOCAL_BOARD_USER_ID) {
    return (await db.select({ id: companies.id }).from(companies)).map((row) => row.id);
  }
  const rows = await db.select({ companyId: companyMemberships.companyId }).from(companyMemberships).where(and(
    eq(companyMemberships.principalType, "user"),
    eq(companyMemberships.principalId, userId),
    eq(companyMemberships.status, "active"),
  ));
  return unique(rows.map((row) => row.companyId));
}

/**
 * Spec 5.2 for one account in one company, through `evaluateAccountPlan`
 * (rows 1–6 and 9 without an environment). Eligible means the owner is an
 * active member, no reservation excludes the company, and neither the owner
 * nor an admin switched it off. Signed-out and limited accounts stay
 * eligible with their state.
 */
export async function evaluateAccountEligibility(
  db: DeviceDb,
  input: { companyId: string; accountId: string; deploymentMode?: DeploymentMode; now?: Date },
): Promise<{ eligible: boolean; reason: AiAccountPlanWaitReason | null; account: AiAccountRow | null }> {
  const plan = await evaluateAccountPlan(asDb(db), {
    companyId: input.companyId,
    accountId: input.accountId,
    environment: null,
    now: input.now ?? new Date(),
    deploymentMode: input.deploymentMode,
  });
  return { eligible: plan.account !== null && ELIGIBLE_PLAN_REASONS.has(plan.reason), reason: plan.reason, account: plan.account };
}

/**
 * The accounts eligible in a company, by label: `evaluateAccountEligibility`
 * for every account at once, in three queries whatever the pool's size. The
 * owner is an active member (the members filter), neither the owner nor an
 * admin switched the account off, and no reservation excludes the company.
 * Signed-out and limited accounts stay eligible with their state.
 */
export async function eligibleAccountsForCompany(
  db: DeviceDb,
  companyId: string,
  opts: { deploymentMode?: DeploymentMode; now?: Date } = {},
): Promise<AiAccountRow[]> {
  const members = await activeMemberUserIds(db, companyId, opts.deploymentMode);
  if (members.size === 0) return [];
  const owned = await db.select().from(aiAccounts)
    .where(and(
      inArray(sql`coalesce(${aiAccounts.ownerUserId}, ${aiAccounts.createdByUserId})`, [...members]),
      isNull(aiAccounts.adminDisabledAt),
      ne(aiAccounts.status, "disabled"),
    ))
    .orderBy(asc(aiAccounts.label), asc(aiAccounts.createdAt));
  if (owned.length === 0) return [];
  // Reserved elsewhere: reserved for projects, none of them this company's.
  const reservations = await db
    .select({
      accountId: aiAccountProjects.accountId,
      inCompany: sql<boolean | null>`bool_or(${projects.companyId} = ${companyId})`,
    })
    .from(aiAccountProjects)
    .leftJoin(projects, eq(projects.id, aiAccountProjects.projectId))
    .where(inArray(aiAccountProjects.accountId, owned.map((row) => row.id)))
    .groupBy(aiAccountProjects.accountId);
  const reservedElsewhere = new Set(reservations.filter((row) => row.inCompany !== true).map((row) => row.accountId));
  return owned.filter((row) => !reservedElsewhere.has(row.id));
}

// ---------------------------------------------------------------------------
// Binding checks (spec 5.3 steps 3–7)
// ---------------------------------------------------------------------------

export type AccountBindingFailure =
  | { code: "ai_account_not_eligible"; reason: AiAccountPlanWaitReason }
  | {
      code: "ai_account_incompatible";
      reason: AiAccountIncompatibleReason;
      environmentId: string | null;
      environmentName: string | null;
      deviceId: string | null;
      deviceName: string | null;
    }
  | { code: "device_account_limit"; deviceId: string; deviceName: string; limit: number; accountIds: string[] };

export interface AccountBindingCheckInput {
  /** The agent placed where the binding must hold: its current pin, or the proposed one for a move. */
  agent: DevicePlacementAgent;
  account: AiAccountRow;
  /** Step 3 (eligibility). Placement changes run steps 4–7 only. Default true. */
  checkEligibility?: boolean;
  /** A new selection must not be signed out (step 3). Default true. */
  newSelection?: boolean;
  deploymentMode?: DeploymentMode;
  now?: Date;
  /** Step 4, precomputed (e.g. `candidateDevicesForAgents` for a batch). Default: `candidateDevicesForAgent`, creating server and SSH devices on first use. */
  candidates?: readonly CandidateDevice[];
  /**
   * `bound(D)` per device id without this agent's own binding, e.g. sets a
   * migration keeps in processing order. Default: `boundAccountsByDevice`
   * for the candidate devices, excluding this agent.
   */
  boundAccounts?: ReadonlyMap<string, ReadonlySet<string>>;
}

export type AccountBindingCheckResult =
  | { ok: true; candidates: CandidateDevice[]; devices: ExecutionDeviceRow[]; warnings: AiAccountSelectionWarning[] }
  | { ok: false; failure: AccountBindingFailure; candidates: CandidateDevice[] };

function eligibilityFailure(reason: AiAccountPlanWaitReason | null, newSelection: boolean): AccountBindingFailure | null {
  const incompatible = (incompatibleReason: AiAccountIncompatibleReason): AccountBindingFailure => ({
    code: "ai_account_incompatible",
    reason: incompatibleReason,
    environmentId: null,
    environmentName: null,
    deviceId: null,
    deviceName: null,
  });
  switch (reason) {
    case "unassigned":
    case "owner_not_member":
    case "reserved_elsewhere":
      return { code: "ai_account_not_eligible", reason };
    case "withdrawn":
      return incompatible("account_disabled");
    case "signed_out":
      return newSelection ? incompatible("account_signed_out") : null;
    default:
      return null;
  }
}

/**
 * Steps 5–7 for one account over the agent's candidates: every candidate
 * environment maps to a device, takes the credential type, and the account
 * fits each device's cap. An account already bound on a device takes no new
 * slot there.
 */
export function placementFailureOf(
  candidates: readonly CandidateDevice[],
  account: Pick<AiAccountRow, "id" | "credentialType">,
  boundOn: (deviceId: string) => ReadonlySet<string>,
  now: Date,
): AccountBindingFailure | null {
  for (const candidate of candidates) {
    if (!candidate.device) {
      return {
        code: "ai_account_incompatible",
        reason: "device_unknown",
        environmentId: candidate.environmentId,
        environmentName: candidate.environment?.name ?? null,
        deviceId: null,
        deviceName: null,
      };
    }
  }
  for (const candidate of candidates) {
    const types = acceptedCredentialTypes(candidate.environment ?? { driver: "sandbox" }, candidate.device, now);
    if (!acceptsCredentialType(types, account.credentialType)) {
      return {
        code: "ai_account_incompatible",
        reason: "credential_type_unsupported",
        environmentId: candidate.environmentId,
        environmentName: candidate.environment?.name ?? null,
        deviceId: candidate.device?.id ?? null,
        deviceName: candidate.device?.name ?? null,
      };
    }
  }
  for (const device of distinctDevices(candidates)) {
    const inUse = boundOn(device.id);
    if (wouldExceedDeviceCap({ cap: capOf(device), inUse, accountId: account.id })) {
      return { code: "device_account_limit", deviceId: device.id, deviceName: device.name, limit: capOf(device), accountIds: [...inUse].sort() };
    }
  }
  return null;
}

/**
 * Spec 5.3 steps 3–7 for one agent and account, without authorization or the
 * adapter check (the caller's): eligibility, a device for every candidate
 * environment (`device_unknown`), the credential type
 * (`credential_type_unsupported`) and the device cap
 * (`device_account_limit`). No step looks at who owns a device. Run it inside
 * the transaction that holds `acquireBindingsLock` and then writes.
 */
export async function checkAccountBinding(db: DeviceDb, input: AccountBindingCheckInput): Promise<AccountBindingCheckResult> {
  const now = input.now ?? new Date();
  if (input.checkEligibility !== false) {
    const eligibility = await evaluateAccountEligibility(db, {
      companyId: input.agent.companyId,
      accountId: input.account.id,
      deploymentMode: input.deploymentMode,
      now,
    });
    const failure = eligibilityFailure(eligibility.reason, input.newSelection !== false);
    if (failure) return { ok: false, failure, candidates: [] };
  }
  const candidates = input.candidates ? [...input.candidates] : await candidateDevicesForAgent(db, input.agent);
  const devices = distinctDevices(candidates);
  let bound = input.boundAccounts;
  if (!bound) {
    const entries = devices.length > 0
      ? await boundAccountsByDevice(db, { deviceIds: devices.map((device) => device.id), excludeAgentId: input.agent.id })
      : new Map();
    bound = new Map([...entries].map(([deviceId, entry]) => [deviceId, entry.accountIds as ReadonlySet<string>]));
  }
  const boundSets = bound;
  const failure = placementFailureOf(candidates, input.account, (deviceId) => boundSets.get(deviceId) ?? EMPTY_SET, now);
  if (failure) return { ok: false, failure, candidates };
  return { ok: true, candidates, devices, warnings: selectionWarnings(input.account, now) };
}

function incompatibleMessage(failure: Extract<AccountBindingFailure, { code: "ai_account_incompatible" }>): string {
  switch (failure.reason) {
    case "adapter_unsupported":
      return "Only Claude agents can use a Claude account from the pool.";
    case "device_unknown":
      return failure.environmentName
        ? `Paperclip cannot tell which device the environment "${failure.environmentName}" runs on. Pin the agent to another environment, or ask an instance admin to map it to a device.`
        : "Paperclip cannot tell which device this agent runs on. Pin the agent to an environment, or ask an instance admin to map it to a device.";
    case "credential_type_unsupported":
      return `${failure.deviceName ?? "The agent's device"} does not accept this account's credential type. Choose another account, or move the agent.`;
    case "account_signed_out":
      return "This Claude account is signed out. Its owner must replace the token first.";
    case "account_disabled":
      return "This Claude account is switched off. It must be turned back on first.";
  }
}

/**
 * The HTTP error of a failed binding check. `device_account_limit` names only
 * accounts eligible in `companyId`; other companies' accounts are a count.
 */
export async function bindingFailureError(
  db: DeviceDb,
  failure: AccountBindingFailure,
  input: { companyId: string; deploymentMode?: DeploymentMode; now?: Date },
): Promise<HttpError> {
  switch (failure.code) {
    case "ai_account_not_eligible":
      // A missing account and another company's account answer alike; only a
      // reservation, which its owner can clear, is named.
      return unprocessable("This Claude account is not available in this company.", {
        code: "ai_account_not_eligible",
        ...(failure.reason === "reserved_elsewhere" ? { reason: failure.reason } : {}),
      });
    case "ai_account_incompatible": {
      const details: AiAccountIncompatibleErrorDetails = {
        code: "ai_account_incompatible",
        reason: failure.reason,
        deviceName: failure.deviceName,
        environmentName: failure.environmentName,
      };
      return unprocessable(incompatibleMessage(failure), details);
    }
    case "device_account_limit": {
      const labels: string[] = [];
      for (const accountId of failure.accountIds) {
        const eligibility = await evaluateAccountEligibility(db, { companyId: input.companyId, accountId, deploymentMode: input.deploymentMode, now: input.now });
        if (eligibility.eligible && eligibility.account) labels.push(eligibility.account.label);
      }
      labels.sort((a, b) => a.localeCompare(b));
      const details: DeviceAccountLimitErrorDetails = {
        code: "device_account_limit",
        deviceId: failure.deviceId,
        deviceName: failure.deviceName,
        limit: failure.limit,
        inUse: failure.accountIds.length,
        accounts: labels,
        otherCompaniesAccounts: failure.accountIds.length - labels.length,
      };
      return conflict(
        `${failure.deviceName} already runs ${details.inUse} of ${failure.limit} Claude accounts. Choose an account already on it, or free a slot first.`,
        details,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Device limits after changes that cannot be refused (spec 5.6)
// ---------------------------------------------------------------------------

/**
 * Re-runs the device cap check after a change that cannot be refused
 * synchronously (a project, company or instance default environment edit).
 * Devices whose bound accounts now exceed their cap get `over_limit_at`, and
 * each affected company gets an immediate `execution_device.over_limit`
 * entry; runs there take `device_slot_wait`. Without `deviceIds` every device
 * is checked.
 */
export async function recheckDeviceLimits(
  db: Db,
  opts: { deviceIds?: readonly string[] | null; now?: Date } = {},
): Promise<DeviceLimitCheck[]> {
  const results = await markOverLimitIfNeeded(db, opts.deviceIds ?? null, { now: opts.now });
  for (const result of results) {
    if (result.change !== "flagged") continue;
    // The immediate admin notice (spec 5.6): an inbox item in each affected company while the flag stays.
    await noteDeviceOverLimit(db, result, opts.now);
    await Promise.all(result.companyIds.map((companyId) => logActivity(db, {
      companyId,
      actorType: "system",
      actorId: AI_ACCOUNT_POOL_SYSTEM_ACTOR_ID,
      action: "execution_device.over_limit",
      entityType: "execution_device",
      entityId: result.deviceId,
      details: { deviceName: result.deviceName, limit: result.limit, inUse: result.inUse },
    })));
  }
  return results;
}

/**
 * The after-commit hook of a default environment edit (spec 5.6): a project
 * created with a default or given another one, a project archived or
 * restored, a company default or the instance default. It re-checks every
 * device in the background; the edit itself is never refused, delayed or
 * failed by it.
 */
export function recheckDeviceLimitsAfterChange(db: Db, change: string): void {
  void recheckDeviceLimits(db).catch((error: unknown) => {
    logger.warn({ err: error, change }, "failed to re-check device account limits after a default environment change");
  });
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

const EMPTY_USAGE_WINDOW: AiAccountUsageWindow = { runs: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costCents: 0 };
const EMPTY_USAGE: AiAccountUsage = { lastFiveHours: EMPTY_USAGE_WINDOW, lastSevenDays: EMPTY_USAGE_WINDOW, thisMonth: EMPTY_USAGE_WINDOW };

/** Paperclip's own use of each account, from the cost events of its pool and legacy host-pool runs. */
async function usageByAccount(db: PoolDb, accountIds: readonly string[], now: Date): Promise<Map<string, AiAccountUsage>> {
  if (accountIds.length === 0) return new Map();
  const fiveHoursAgo = new Date(now.getTime() - 5 * 60 * 60 * 1000).toISOString();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const since = sevenDaysAgo < monthStart ? sevenDaysAgo : monthStart;
  const accountId = sql<string>`${heartbeatRuns.contextSnapshot} -> 'aiConnection' ->> 'accountId'`;
  const sums = (from: string) => ({
    runs: sql<number>`count(distinct ${costEvents.heartbeatRunId}) filter (where ${costEvents.occurredAt} >= ${from}::timestamptz)::int`,
    input: sql<number>`coalesce(sum(${costEvents.inputTokens}) filter (where ${costEvents.occurredAt} >= ${from}::timestamptz), 0)::bigint`,
    cached: sql<number>`coalesce(sum(${costEvents.cachedInputTokens}) filter (where ${costEvents.occurredAt} >= ${from}::timestamptz), 0)::bigint`,
    output: sql<number>`coalesce(sum(${costEvents.outputTokens}) filter (where ${costEvents.occurredAt} >= ${from}::timestamptz), 0)::bigint`,
    cost: sql<number>`coalesce(sum(${costEvents.costCents}) filter (where ${costEvents.occurredAt} >= ${from}::timestamptz), 0)::bigint`,
  });
  const five = sums(fiveHoursAgo);
  const seven = sums(sevenDaysAgo);
  const month = sums(monthStart);
  const rows = await db
    .select({
      accountId,
      fRuns: five.runs, fIn: five.input, fCached: five.cached, fOut: five.output, fCost: five.cost,
      sRuns: seven.runs, sIn: seven.input, sCached: seven.cached, sOut: seven.output, sCost: seven.cost,
      mRuns: month.runs, mIn: month.input, mCached: month.cached, mOut: month.output, mCost: month.cost,
    })
    .from(costEvents)
    .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, costEvents.heartbeatRunId))
    .where(and(
      sql`${costEvents.occurredAt} >= ${since}::timestamptz`,
      sql`${heartbeatRuns.contextSnapshot} -> 'aiConnection' ->> 'mode' in ('pool_account', 'host_pool')`,
      inArray(accountId, [...accountIds]),
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
    lastFiveHours: window(row.fRuns, row.fIn, row.fCached, row.fOut, row.fCost),
    lastSevenDays: window(row.sRuns, row.sIn, row.sCached, row.sOut, row.sCost),
    thisMonth: window(row.mRuns, row.mIn, row.mCached, row.mOut, row.mCost),
  }]));
}

async function reservedProjectsByAccount(db: PoolDb, accountIds: readonly string[]): Promise<Map<string, AiAccountProjectSummary[]>> {
  const result = new Map<string, AiAccountProjectSummary[]>();
  if (accountIds.length === 0) return result;
  const rows = await db
    .select({
      accountId: aiAccountProjects.accountId,
      id: projects.id,
      name: projects.name,
      companyId: companies.id,
      companyName: companies.name,
      issuePrefix: companies.issuePrefix,
    })
    .from(aiAccountProjects)
    .innerJoin(projects, eq(projects.id, aiAccountProjects.projectId))
    .innerJoin(companies, eq(companies.id, projects.companyId))
    .where(inArray(aiAccountProjects.accountId, [...accountIds]))
    .orderBy(asc(companies.name), asc(projects.name));
  for (const row of rows) {
    const list = result.get(row.accountId) ?? [];
    list.push({ id: row.id, name: row.name, companyId: row.companyId, companyName: row.companyName, issuePrefix: row.issuePrefix ?? "" });
    result.set(row.accountId, list);
  }
  return result;
}

interface AccountBindingUse {
  accountId: string;
  agentId: string;
  agentName: string;
  companyId: string;
  companyName: string;
  defaultEnvironmentId: string | null;
}

/** Pool bindings of non-terminated agents to these accounts, with their companies. */
async function bindingsOfAccounts(db: PoolDb, accountIds: readonly string[]): Promise<AccountBindingUse[]> {
  if (accountIds.length === 0) return [];
  const rows = await db
    .select({
      accountId: aiAccountAgentBindings.accountId,
      agentId: agents.id,
      agentName: agents.name,
      companyId: companies.id,
      companyName: companies.name,
      defaultEnvironmentId: agents.defaultEnvironmentId,
    })
    .from(aiAccountAgentBindings)
    .innerJoin(agents, and(eq(agents.id, aiAccountAgentBindings.agentId), eq(agents.companyId, aiAccountAgentBindings.companyId)))
    .innerJoin(companies, eq(companies.id, aiAccountAgentBindings.companyId))
    .where(and(
      eq(aiAccountAgentBindings.mode, "pool_account"),
      inArray(aiAccountAgentBindings.accountId, [...accountIds]),
      ne(agents.status, "terminated"),
    ))
    .orderBy(asc(companies.name), asc(agents.name));
  return rows.flatMap((row) => (row.accountId ? [{ ...row, accountId: row.accountId }] : []));
}

/** Each agent's candidate devices as display refs, without creating devices. */
async function deviceRefsByAgent(
  db: PoolDb,
  placements: readonly DevicePlacementAgent[],
  opts: { create: boolean },
): Promise<Map<string, ExecutionDeviceRef[]>> {
  const result = new Map<string, ExecutionDeviceRef[]>();
  if (placements.length === 0) return result;
  const candidates = await candidateDevicesForAgents(db, placements, { create: opts.create });
  const devices = [...candidates.values()].flatMap((list) => distinctDevices(list));
  const users = await usersById(db, devices.map((device) => device.ownerUserId));
  for (const placement of placements) {
    result.set(placement.id, distinctDevices(candidates.get(placement.id) ?? []).map((device) => deviceRefOf(device, users)));
  }
  return result;
}

function summarizeUsedBy(
  uses: readonly AccountBindingUse[],
  devicesByAgent: Map<string, ExecutionDeviceRef[]>,
): AiAccountUsedByCompany[] {
  const byCompany = new Map<string, AiAccountUsedByCompany>();
  for (const use of uses) {
    const entry = byCompany.get(use.companyId) ?? { companyId: use.companyId, companyName: use.companyName, agents: [] };
    entry.agents.push({ agentId: use.agentId, agentName: use.agentName, devices: devicesByAgent.get(use.agentId) ?? [] });
    byCompany.set(use.companyId, entry);
  }
  return [...byCompany.values()];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface AiAccountPoolServiceOptions {
  /** In `local_trusted` the local board user is a member of every company. Defaults to the server's configured mode. */
  deploymentMode?: DeploymentMode;
  /** The clock (tests pass a fixed one). */
  now?: () => Date;
}

function configuredDeploymentMode(): DeploymentMode | undefined {
  try {
    return resolveDeploymentMode();
  } catch (error) {
    logger.warn({ err: error }, "the account pool could not read the deployment mode; treating the local board user as a non-member");
    return undefined;
  }
}

export function aiAccountPoolService(db: Db, options: AiAccountPoolServiceOptions = {}) {
  const clock = options.now ?? (() => new Date());
  let resolvedMode: { value: DeploymentMode | undefined } | null = options.deploymentMode ? { value: options.deploymentMode } : null;
  /** Read lazily, so building the service never touches the config file. */
  function deploymentMode(): DeploymentMode | undefined {
    resolvedMode ??= { value: configuredDeploymentMode() };
    return resolvedMode.value;
  }

  async function wake(filter: ResourceWaitWakeFilter): Promise<void> {
    try {
      await wakeResourceWaits(db, filter, { now: clock() });
    } catch (error) {
      logger.warn({ err: error, filter }, "failed to wake resource waits after an account pool change");
    }
  }

  /**
   * After a change that can free a device slot (a binding replaced or
   * removed, an account removed, a bound agent moved away), re-runs the cap
   * check for the devices these placements reach, so a device that fits
   * again loses its `over_limit_at` and a later overflow is noticed afresh.
   */
  async function refreshDeviceFlags(placements: readonly DevicePlacementAgent[]): Promise<void> {
    try {
      const deviceIds: string[] = [];
      for (const placement of placements) {
        for (const device of distinctDevices(await candidateDevicesForAgent(db, placement, { create: false }))) deviceIds.push(device.id);
      }
      if (deviceIds.length > 0) await recheckDeviceLimits(db, { deviceIds: unique(deviceIds), now: clock() });
    } catch (error) {
      logger.warn({ err: error }, "failed to refresh device limits after an account pool change");
    }
  }

  async function audit(
    ctx: PoolContext,
    companyIds: readonly string[],
    entry: Pick<LogActivityInput, "action" | "entityType" | "entityId" | "details">,
  ): Promise<void> {
    await Promise.all(unique(companyIds).map((companyId) => logActivity(db, {
      companyId,
      actorType: ctx.audit.actorType,
      actorId: ctx.audit.actorId,
      agentId: ctx.audit.agentId ?? null,
      runId: ctx.audit.runId ?? null,
      agentApiKeyId: ctx.audit.agentApiKeyId ?? null,
      ...entry,
    })));
  }

  /**
   * Where an account's lifecycle entries go: every company where its owner
   * is an active member, with the label. Without any (a legacy account
   * without an owner, or an owner who left every company), the companies
   * whose agents use it, without the label.
   */
  async function accountAuditTargets(account: AiAccountRow, executor: PoolDb = db): Promise<{ companyIds: string[]; labelled: boolean }> {
    const ownerCompanies = await memberCompanyIds(executor, effectiveAccountOwner(account), deploymentMode());
    if (ownerCompanies.length > 0) return { companyIds: ownerCompanies, labelled: true };
    const uses = await bindingsOfAccounts(executor, [account.id]);
    return { companyIds: unique(uses.map((use) => use.companyId)), labelled: false };
  }

  async function auditAccount(
    ctx: PoolContext,
    account: AiAccountRow,
    action: string,
    details: Record<string, unknown> = {},
    targets?: { companyIds: string[]; labelled: boolean },
  ): Promise<void> {
    const { companyIds, labelled } = targets ?? await accountAuditTargets(account);
    if (companyIds.length === 0) {
      logger.info({ accountId: account.id, action }, "account pool change has no company to audit in");
      return;
    }
    await audit(ctx, companyIds, {
      action,
      entityType: "ai_account",
      entityId: account.id,
      details: labelled ? { accountLabel: account.label, ...details } : details,
    });
  }

  async function accountById(executor: PoolDb, accountId: string): Promise<AiAccountRow | null> {
    const [row] = await executor.select().from(aiAccounts).where(eq(aiAccounts.id, accountId));
    return row ?? null;
  }

  /** 404 unless the account exists and the actor is its effective owner. */
  async function ownedAccount(executor: PoolDb, actor: PoolActor, accountId: string): Promise<AiAccountRow> {
    const account = await accountById(executor, accountId);
    if (!account || !actor.userId || effectiveAccountOwner(account) !== actor.userId) throw notFound("Claude account not found");
    return account;
  }

  async function requireAccount(executor: PoolDb, accountId: string): Promise<AiAccountRow> {
    const account = await accountById(executor, accountId);
    if (!account) throw notFound("Claude account not found");
    return account;
  }

  async function getAgent(agentId: string, executor: PoolDb = db): Promise<PoolAgentRow | null> {
    const [row] = await executor
      .select({
        id: agents.id,
        companyId: agents.companyId,
        name: agents.name,
        status: agents.status,
        adapterType: agents.adapterType,
        defaultEnvironmentId: agents.defaultEnvironmentId,
        runtimeConfig: agents.runtimeConfig,
      })
      .from(agents)
      .where(eq(agents.id, agentId));
    return row ?? null;
  }

  // --- Read models ---------------------------------------------------------

  async function myAccountViews(actor: PoolActor, rows: readonly AiAccountRow[]): Promise<MyAiAccount[]> {
    if (rows.length === 0) return [];
    const now = clock();
    const ids = rows.map((row) => row.id);
    const callerCompanies = new Set(await memberCompanyIds(db, actor.userId ?? null, deploymentMode()));
    const reservations = await reservedProjectsByAccount(db, ids);
    const usage = await usageByAccount(db, ids, now);
    const uses = await bindingsOfAccounts(db, ids);
    const visibleUses = uses.filter((use) => callerCompanies.has(use.companyId));
    const devicesByAgent = await deviceRefsByAgent(db, visibleUses.map((use) => poolPlacementOf({
      id: use.agentId,
      companyId: use.companyId,
      defaultEnvironmentId: use.defaultEnvironmentId,
    })), { create: false });
    return rows.map((row): MyAiAccount => {
      const accountUses = uses.filter((use) => use.accountId === row.id);
      // Fork: a reservation in a company the caller is not a member of shows as a count only.
      const reserved = reservations.get(row.id) ?? [];
      return {
        id: row.id,
        provider: "anthropic",
        credentialType: row.credentialType,
        label: row.label,
        emailHint: row.emailHint,
        plan: row.plan,
        origin: row.origin,
        status: row.status,
        statusMessage: row.statusMessage,
        state: accountStateOf(row, now),
        credentialHint: row.credentialHint,
        adminDisabled: row.adminDisabledAt !== null,
        adminDisabledReason: row.adminDisabledReason,
        exhaustedUntil: iso(row.exhaustedUntil),
        limitReason: row.limitReason,
        limitSource: row.limitSource,
        lastLimitedAt: iso(row.lastLimitedAt),
        reservedProjects: reserved.filter((project) => callerCompanies.has(project.companyId)),
        otherReservedProjects: reserved.filter((project) => !callerCompanies.has(project.companyId)).length,
        usedBy: summarizeUsedBy(accountUses.filter((use) => callerCompanies.has(use.companyId)), devicesByAgent),
        otherCompanies: unique(accountUses.filter((use) => !callerCompanies.has(use.companyId)).map((use) => use.companyId)).length,
        usage: usage.get(row.id) ?? EMPTY_USAGE,
        lastUsedAt: iso(row.lastUsedAt),
        createdAt: row.createdAt.toISOString(),
      };
    });
  }

  async function myAccountView(actor: PoolActor, accountId: string): Promise<MyAiAccount> {
    const [view] = await myAccountViews(actor, [await ownedAccount(db, actor, accountId)]);
    return view!;
  }

  async function instanceViews(rows: readonly AiAccountRow[]): Promise<InstanceAiAccountSummary[]> {
    if (rows.length === 0) return [];
    const now = clock();
    const ids = rows.map((row) => row.id);
    const reservations = await reservedProjectsByAccount(db, ids);
    const usage = await usageByAccount(db, ids, now);
    const uses = await bindingsOfAccounts(db, ids);
    const owners = await usersById(db, rows.map((row) => effectiveAccountOwner(row)));
    const hostIds = unique(rows.map((row) => row.hostId).filter((id): id is string => Boolean(id)));
    const hosts = hostIds.length > 0
      ? new Map((await db.select({ id: aiAccountHosts.id, name: aiAccountHosts.name }).from(aiAccountHosts).where(inArray(aiAccountHosts.id, hostIds))).map((row) => [row.id, row.name]))
      : new Map<string, string>();
    return rows.map((row): InstanceAiAccountSummary => {
      const ownerId = effectiveAccountOwner(row);
      const ownerUser = ownerId ? owners.get(ownerId) : undefined;
      const owner: AiAccountOwnerRef | null = ownerId ? { userId: ownerId, name: ownerUser?.name ?? null, email: ownerUser?.email ?? null } : null;
      const companyCounts = new Map<string, { companyId: string; companyName: string; agentCount: number }>();
      for (const use of uses.filter((entry) => entry.accountId === row.id)) {
        const entry = companyCounts.get(use.companyId) ?? { companyId: use.companyId, companyName: use.companyName, agentCount: 0 };
        entry.agentCount += 1;
        companyCounts.set(use.companyId, entry);
      }
      return {
        id: row.id,
        provider: "anthropic",
        credentialType: row.credentialType,
        label: row.label,
        plan: row.plan,
        emailHint: maskEmail(row.emailHint),
        credentialHint: row.credentialHint,
        owner,
        origin: row.origin,
        status: row.status,
        statusMessage: row.statusMessage,
        state: accountStateOf(row, now),
        adminDisabled: row.adminDisabledAt !== null,
        adminDisabledAt: iso(row.adminDisabledAt),
        adminDisabledReason: row.adminDisabledReason,
        exhaustedUntil: iso(row.exhaustedUntil),
        limitReason: row.limitReason,
        limitSource: row.limitSource,
        limitStrikes: row.limitStrikes,
        lastLimitedAt: iso(row.lastLimitedAt),
        legacyHostId: row.hostId,
        legacyHostName: row.hostId ? hosts.get(row.hostId) ?? null : null,
        reservedProjects: reservations.get(row.id) ?? [],
        companies: [...companyCounts.values()].sort((a, b) => a.companyName.localeCompare(b.companyName)),
        usage: usage.get(row.id) ?? EMPTY_USAGE,
        lastUsedAt: iso(row.lastUsedAt),
        createdAt: row.createdAt.toISOString(),
      };
    });
  }

  async function instanceView(accountId: string): Promise<InstanceAiAccountSummary> {
    const [view] = await instanceViews([await requireAccount(db, accountId)]);
    return view!;
  }

  /**
   * The accounts eligible in a company as this caller sees them, with
   * `canBind`. For one agent each option also says whether it can be chosen
   * for that agent, why not, a limit warning, and whether the account is
   * already on one of the agent's devices.
   */
  async function companyOptions(actor: PoolActor, companyId: string, agent: PoolAgentRow | null): Promise<CompanyAiAccountOption[]> {
    const now = clock();
    const mode = deploymentMode();
    const eligible = await eligibleAccountsForCompany(db, companyId, { deploymentMode: mode, now });
    if (eligible.length === 0) return [];
    const ids = eligible.map((account) => account.id);
    const uses = (await bindingsOfAccounts(db, ids)).filter((use) => use.companyId === companyId);
    const devicesByAgent = await deviceRefsByAgent(db, uses.map((use) => poolPlacementOf({
      id: use.agentId,
      companyId: use.companyId,
      defaultEnvironmentId: use.defaultEnvironmentId,
    })), { create: true });
    const owners = await usersById(db, eligible.map((account) => effectiveAccountOwner(account)));
    const seeFullEmail = isInstanceAdminActor(actor);

    let perAgent: {
      supported: boolean;
      candidates: CandidateDevice[];
      devices: ExecutionDeviceRow[];
      bound: Map<string, ReadonlySet<string>>;
      currentAccountId: string | null;
    } | null = null;
    if (agent) {
      const candidates = await candidateDevicesForAgent(db, poolPlacementOf(agent));
      const devices = distinctDevices(candidates);
      const entries = devices.length > 0
        ? await boundAccountsByDevice(db, { deviceIds: devices.map((device) => device.id), excludeAgentId: agent.id })
        : new Map();
      const [binding] = await db.select().from(aiAccountAgentBindings).where(eq(aiAccountAgentBindings.agentId, agent.id));
      perAgent = {
        supported: agent.adapterType === POOL_ACCOUNT_ADAPTER_TYPE,
        candidates,
        devices,
        bound: new Map([...entries].map(([deviceId, entry]) => [deviceId, entry.accountIds as ReadonlySet<string>])),
        currentAccountId: binding?.mode === "pool_account" ? binding.accountId : null,
      };
    }

    return eligible.map((account): CompanyAiAccountOption => {
      const ownerId = effectiveAccountOwner(account)!;
      const ownerUser = owners.get(ownerId);
      const ownedByMe = Boolean(actor.userId) && ownerId === actor.userId;
      const canBind = canBindAccount(actor, companyId, account);
      const accountUses = uses.filter((use) => use.accountId === account.id);
      const deviceRefs = new Map<string, ExecutionDeviceRef>();
      for (const use of accountUses) {
        for (const device of devicesByAgent.get(use.agentId) ?? []) deviceRefs.set(device.id, device);
      }
      const option: CompanyAiAccountOption = {
        id: account.id,
        label: account.label,
        credentialType: account.credentialType,
        plan: account.plan,
        owner: {
          userId: ownerId,
          name: ownerUser?.name ?? null,
          email: ownedByMe || seeFullEmail ? ownerUser?.email ?? null : maskEmail(ownerUser?.email),
        },
        ownedByMe,
        state: accountStateOf(account, now),
        exhaustedUntil: iso(account.exhaustedUntil),
        limitSource: account.limitSource,
        canBind,
        agents: accountUses.map((use) => ({ agentId: use.agentId, agentName: use.agentName })),
        devices: [...deviceRefs.values()],
      };
      if (!perAgent) return option;
      const context = perAgent;
      let reason: AiAccountUnselectableReason | null = null;
      if (!context.supported) reason = "adapter_unsupported";
      else if (!canBind) reason = "not_permitted";
      else if (account.status === "auth_failed") reason = "signed_out";
      else {
        const failure = placementFailureOf(context.candidates, account, (deviceId) => context.bound.get(deviceId) ?? EMPTY_SET, now);
        if (failure?.code === "device_account_limit") reason = "device_account_limit";
        else if (failure?.code === "ai_account_incompatible" && failure.reason === "device_unknown") reason = "device_unknown";
        else if (failure?.code === "ai_account_incompatible" && failure.reason === "credential_type_unsupported") reason = "credential_type_unsupported";
      }
      const warnings = selectionWarnings(account, now);
      return {
        ...option,
        selectable: reason === null,
        reason,
        warning: reason === null ? warnings[0] ?? null : null,
        onAgentDevice: context.devices.some((device) => context.bound.get(device.id)?.has(account.id))
          || (context.devices.length > 0 && context.currentAccountId === account.id),
      };
    });
  }

  /** Binding summaries for agents of one company, as this caller sees them. */
  async function bindingSummaries(actor: PoolActor, companyId: string, agentRows: readonly PoolAgentRow[]): Promise<AgentAiAccountBindingSummary[]> {
    if (agentRows.length === 0) return [];
    const now = clock();
    const mode = deploymentMode();
    const agentIds = agentRows.map((agent) => agent.id);
    const bindingRows = await db.select().from(aiAccountAgentBindings).where(and(
      eq(aiAccountAgentBindings.companyId, companyId),
      inArray(aiAccountAgentBindings.agentId, agentIds),
    ));
    const bindings = new Map(bindingRows.map((row) => [row.agentId, row]));
    const accountIds = unique(bindingRows.map((row) => row.accountId).filter((id): id is string => Boolean(id)));
    const accountRows = accountIds.length > 0 ? await db.select().from(aiAccounts).where(inArray(aiAccounts.id, accountIds)) : [];
    const accountsById = new Map(accountRows.map((row) => [row.id, row]));
    const members = await activeMemberUserIds(db, companyId, mode);
    const owners = await usersById(db, accountRows.map((row) => effectiveAccountOwner(row)));
    const devicesByAgent = await deviceRefsByAgent(db, agentRows.map((agent) => poolPlacementOf(agent)), { create: true });
    return agentRows.map((agent): AgentAiAccountBindingSummary => {
      const binding = bindings.get(agent.id) ?? null;
      const account = binding?.accountId ? accountsById.get(binding.accountId) ?? null : null;
      const ownerId = account ? effectiveAccountOwner(account) : null;
      const ownerIsMember = ownerId !== null && members.has(ownerId);
      let state: AiAccountBindingState;
      if (!binding) state = "unbound";
      else if (binding.mode === "device_login") state = "device_login";
      else if (!account) state = "unassigned";
      else state = ownerIsMember ? "pool_account" : "account_unavailable";
      const accountRef: AiAccountBindingAccountRef | null = account && state === "pool_account"
        ? {
            id: account.id,
            label: account.label,
            credentialType: account.credentialType,
            state: accountStateOf(account, now),
            ownedByMe: Boolean(actor.userId) && ownerId === actor.userId,
            ownerName: ownerId ? owners.get(ownerId)?.name ?? null : null,
            exhaustedUntil: iso(account.exhaustedUntil),
            limitSource: account.limitSource,
          }
        : null;
      const permissionState: BindingPermissionState | null = binding
        ? { mode: binding.mode, accountId: account ? account.id : null, accountOwnerId: ownerId }
        : null;
      const aiConnection = (agent.runtimeConfig as Record<string, unknown> | null)?.aiConnection;
      return {
        agentId: agent.id,
        agentName: agent.name,
        companyId: agent.companyId,
        adapterType: agent.adapterType,
        supported: agent.adapterType === POOL_ACCOUNT_ADAPTER_TYPE,
        state,
        mode: binding?.mode ?? null,
        account: accountRef,
        source: binding?.source ?? null,
        migrationNote: binding?.migrationNote ?? null,
        reviewedAt: iso(binding?.reviewedAt),
        needsReview: Boolean(binding && binding.source !== "manual" && !binding.reviewedAt),
        devices: devicesByAgent.get(agent.id) ?? [],
        pinned: agent.defaultEnvironmentId !== null,
        overridesAiConnection: Boolean(binding) && aiConnection !== null && typeof aiConnection === "object",
        canChange: mayEditBinding(actor, companyId, permissionState),
        updatedAt: iso(binding?.updatedAt),
      };
    });
  }

  async function bindingSummary(actor: PoolActor, agentId: string): Promise<AgentAiAccountBindingSummary> {
    const agent = await getAgent(agentId);
    if (!agent) throw notFound("Agent not found");
    const [summary] = await bindingSummaries(actor, agent.companyId, [agent]);
    return summary!;
  }

  // --- Owner operations -------------------------------------------------------

  async function listMine(ctx: PoolContext): Promise<MyAiAccountsResponse> {
    const userId = ctx.actor.userId;
    if (!userId) return { accounts: [] };
    const rows = await db.select().from(aiAccounts)
      .where(sql`coalesce(${aiAccounts.ownerUserId}, ${aiAccounts.createdByUserId}) = ${userId}`)
      .orderBy(asc(aiAccounts.label), asc(aiAccounts.createdAt));
    return { accounts: await myAccountViews(ctx.actor, rows) };
  }

  /**
   * Adds an account owned by the actor (owner = creator = actor; no legacy
   * host). A pasted value, the actor's own saved Claude connection, or, for
   * instance admins, the server's environment token. A credential or e-mail
   * already in use is a generic 409 `ai_account_duplicate`.
   */
  async function create(ctx: PoolContext, input: CreateMyAiAccount): Promise<MyAiAccount> {
    const { actor } = ctx;
    if (actor.type !== "board" || !actor.userId) throw forbidden("Only a signed-in board user can add a Claude account");
    const ownerCompanies = await memberCompanyIds(db, actor.userId, deploymentMode());
    if (ownerCompanies.length === 0) {
      throw unprocessable("Join a company before adding a Claude account: an account is usable only in its owner's companies.");
    }
    const { value, source } = await resolveImportedCredential(db, input, {
      userId: actor.userId,
      isInstanceAdmin: isInstanceAdminActor(actor),
    });
    const material = await encryptCredential(value);
    let row: AiAccountRow;
    try {
      [row] = await db.insert(aiAccounts).values({
        hostId: null,
        credentialType: input.credentialType,
        label: input.label,
        emailHint: input.emailHint ?? null,
        plan: input.plan ?? null,
        poolEnabled: true,
        status: "active",
        credentialMaterial: material,
        credentialFingerprint: credentialFingerprint(value),
        credentialHint: credentialHint(value),
        ownerUserId: actor.userId,
        createdByUserId: actor.userId,
        origin: "pool",
      }).returning() as [AiAccountRow];
    } catch (error) {
      throw aiAccountDuplicateError(error);
    }
    await auditAccount(ctx, row, "ai_account.created", { credentialType: row.credentialType, source }, { companyIds: ownerCompanies, labelled: true });
    return myAccountView(actor, row.id);
  }

  /**
   * Owner edits: label, e-mail hint, plan, pausing (`disabled`) and resuming
   * (`active`), and clearing a project reservation. `pool_enabled` is
   * dual-written. A signed-out account comes back only with a new token, so
   * it is neither resumed nor paused: a pause would overwrite the signed-out
   * state, and a later resume would bring back a token the provider rejected.
   */
  async function update(ctx: PoolContext, accountId: string, input: UpdateMyAiAccount): Promise<MyAiAccount> {
    const now = clock();
    const account = await ownedAccount(db, ctx.actor, accountId);
    if (input.status === "active" && account.status === "auth_failed") {
      throw unprocessable("This account is signed out. Replace its token to use it again.");
    }
    if (input.status === "disabled" && account.status === "auth_failed") {
      throw unprocessable("This account is signed out. Replace its token or remove it.");
    }
    const nextStatus = input.status ?? account.status;
    const resumed = input.status === "active" && account.status === "disabled";
    const restrictionCleared = input.clearProjectRestriction === true;
    const patch: Partial<typeof aiAccounts.$inferInsert> = {};
    if (input.label !== undefined) patch.label = input.label;
    if (input.emailHint !== undefined) patch.emailHint = input.emailHint;
    if (input.plan !== undefined) patch.plan = input.plan;
    if (input.status !== undefined && input.status !== account.status) {
      patch.status = input.status;
      patch.statusMessage = null;
    }
    patch.poolEnabled = poolEnabledFor(nextStatus, account.adminDisabledAt);
    let updated: AiAccountRow;
    try {
      updated = await db.transaction(async (tx) => {
        const [row] = await tx.update(aiAccounts)
          .set({ ...patch, updatedAt: touched(aiAccounts.updatedAt, now) })
          .where(eq(aiAccounts.id, account.id))
          .returning();
        if (restrictionCleared) await tx.delete(aiAccountProjects).where(eq(aiAccountProjects.accountId, account.id));
        return row!;
      });
    } catch (error) {
      throw aiAccountDuplicateError(error);
    }
    if (resumed || restrictionCleared) await wake({ accountIds: [account.id] });
    await auditAccount(ctx, updated, "ai_account.updated", {
      changedKeys: Object.keys(input).sort(),
      status: updated.status,
      ...(restrictionCleared ? { projectRestrictionCleared: true } : {}),
    });
    return myAccountView(ctx.actor, account.id);
  }

  async function clearProjectRestriction(ctx: PoolContext, accountId: string): Promise<MyAiAccount> {
    return update(ctx, accountId, { clearProjectRestriction: true });
  }

  /**
   * A new token of the same type. The account is signed in again: status
   * active, its limit, strikes and sign-in suspicion cleared, and its waits
   * woken.
   */
  async function replaceCredential(ctx: PoolContext, accountId: string, input: ReplaceAiAccountCredential): Promise<MyAiAccount> {
    const now = clock();
    const account = await ownedAccount(db, ctx.actor, accountId);
    const value = input.value.trim();
    if (credentialTypeOfValue(value) !== account.credentialType) {
      throw unprocessable(account.credentialType === "subscription"
        ? "This account takes a subscription token from `claude setup-token`. Add a new account for an API key."
        : "This account takes a Claude Console API key. Add a new account for a subscription token.");
    }
    assertCredentialShape(account.credentialType, value);
    const material = await encryptCredential(value);
    let updated: AiAccountRow;
    try {
      [updated] = await db.update(aiAccounts).set({
        credentialMaterial: material,
        credentialFingerprint: credentialFingerprint(value),
        credentialHint: credentialHint(value),
        status: "active",
        statusMessage: null,
        poolEnabled: poolEnabledFor("active", account.adminDisabledAt),
        exhaustedUntil: null,
        limitReason: null,
        limitRunId: null,
        limitSource: null,
        limitStrikes: 0,
        limitEpisodeStartedAt: null,
        limitProbeRunId: null,
        authSuspectAt: null,
        authSuspectRunId: null,
        updatedAt: touched(aiAccounts.updatedAt, now),
      }).where(eq(aiAccounts.id, account.id)).returning() as [AiAccountRow];
    } catch (error) {
      throw aiAccountDuplicateError(error);
    }
    await wake({ accountIds: [account.id] });
    await auditAccount(ctx, updated, "ai_account.credential_replaced");
    return myAccountView(ctx.actor, account.id);
  }

  /**
   * Clears a limit (the owner or an admin checked it): the reset, the strikes,
   * the limit episode, the probe claim and an unconfirmed sign-in failure, so
   * neither the single-probe rule nor the two-strike rule acts on what came
   * before (spec 4.6, 12). Waits are woken.
   */
  async function clearLimitOf(ctx: PoolContext, account: AiAccountRow): Promise<AiAccountRow> {
    const now = clock();
    const [updated] = await db.update(aiAccounts).set({
      exhaustedUntil: null,
      limitReason: null,
      limitRunId: null,
      limitSource: null,
      limitStrikes: 0,
      limitEpisodeStartedAt: null,
      limitProbeRunId: null,
      authSuspectAt: null,
      authSuspectRunId: null,
      updatedAt: touched(aiAccounts.updatedAt, now),
    }).where(eq(aiAccounts.id, account.id)).returning();
    await wake({ accountIds: [account.id] });
    await auditAccount(ctx, updated!, "ai_account.limit_cleared");
    return updated!;
  }

  async function clearLimit(ctx: PoolContext, accountId: string): Promise<MyAiAccount> {
    await clearLimitOf(ctx, await ownedAccount(db, ctx.actor, accountId));
    return myAccountView(ctx.actor, accountId);
  }

  /**
   * Removes an account. While agents use it this is a 409
   * `ai_account_in_use` (bindings in `visibleCompanyIds` by name, others as a
   * count), unless `release` is set: the bindings then become
   * `pool_account` without an account and wait `unassigned` with a notice.
   */
  async function removeAccount(
    ctx: PoolContext,
    accountId: string,
    input: { release: boolean; owner: boolean },
  ): Promise<void> {
    const now = clock();
    const visibleCompanies = input.owner
      ? new Set(await memberCompanyIds(db, ctx.actor.userId ?? null, deploymentMode()))
      : null;
    const outcome = await db.transaction(async (tx) => {
      await acquireBindingsLock(tx);
      const account = input.owner ? await ownedAccount(tx, ctx.actor, accountId) : await requireAccount(tx, accountId);
      const uses = await bindingsOfAccounts(tx, [account.id]);
      if (uses.length > 0 && !input.release) {
        const shown = visibleCompanies ? uses.filter((use) => visibleCompanies.has(use.companyId)) : uses;
        const details: AiAccountInUseErrorDetails = {
          code: "ai_account_in_use",
          bindings: shown.map((use) => ({ agentId: use.agentId, agentName: use.agentName, companyId: use.companyId, companyName: use.companyName })),
          otherCompanies: unique(uses.filter((use) => !shown.includes(use)).map((use) => use.companyId)).length,
        };
        throw conflict("This Claude account is still assigned to agents. Release them to remove it; they then wait until another account is chosen.", details);
      }
      // Read before the delete: the fallback audit targets are the companies using it.
      const targets = await accountAuditTargets(account, tx);
      const released = await tx.update(aiAccountAgentBindings)
        .set({ accountId: null, updatedByUserId: ctx.actor.userId ?? null, updatedAt: touched(aiAccountAgentBindings.updatedAt, now) })
        .where(eq(aiAccountAgentBindings.accountId, account.id))
        .returning({ agentId: aiAccountAgentBindings.agentId, companyId: aiAccountAgentBindings.companyId });
      await tx.delete(aiAccounts).where(eq(aiAccounts.id, account.id));
      return { account, released, targets, uses };
    });
    await wake({ accountIds: [outcome.account.id] });
    if (outcome.released.length > 0) {
      await wake({ agentIds: outcome.released.map((row) => row.agentId) });
      await refreshDeviceFlags(outcome.uses.map((use) => poolPlacementOf({ id: use.agentId, companyId: use.companyId, defaultEnvironmentId: use.defaultEnvironmentId })));
    }
    await auditAccount(ctx, outcome.account, "ai_account.deleted", { releasedAgents: outcome.released.length }, outcome.targets);
    // The released bindings changed too: their companies hear about it without the account's name.
    for (const row of outcome.released) {
      await audit(ctx, [row.companyId], {
        action: "ai_account.binding_updated",
        entityType: "agent",
        entityId: row.agentId,
        details: { mode: "pool_account", accountId: null, previousAccountId: outcome.account.id, reason: "account_removed" },
      });
    }
  }

  async function remove(ctx: PoolContext, accountId: string, options: { release?: boolean } = {}): Promise<void> {
    await removeAccount(ctx, accountId, { release: options.release === true, owner: true });
  }

  // --- Company operations -----------------------------------------------------

  async function listForCompany(ctx: PoolContext, companyId: string, opts: { agentId?: string | null } = {}): Promise<CompanyAiAccountsResponse> {
    let agent: PoolAgentRow | null = null;
    if (opts.agentId) {
      agent = await getAgent(opts.agentId);
      if (!agent || agent.companyId !== companyId) throw notFound("Agent not found");
    }
    return {
      accounts: await companyOptions(ctx.actor, companyId, agent),
      canBindAny: isCompanyAdmin(ctx.actor, companyId),
    };
  }

  /**
   * Every non-terminated Claude agent of the company, plus agents on other
   * adapters that still have a binding row (`supported: false`): such a
   * binding still holds a device slot, so admins must be able to remove it.
   */
  async function listBindings(ctx: PoolContext, companyId: string): Promise<CompanyAiAccountBindingsResponse> {
    const rows = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        name: agents.name,
        status: agents.status,
        adapterType: agents.adapterType,
        defaultEnvironmentId: agents.defaultEnvironmentId,
        runtimeConfig: agents.runtimeConfig,
        bindingAgentId: aiAccountAgentBindings.agentId,
      })
      .from(agents)
      .leftJoin(aiAccountAgentBindings, and(eq(aiAccountAgentBindings.agentId, agents.id), eq(aiAccountAgentBindings.companyId, agents.companyId)))
      .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")))
      .orderBy(asc(agents.name));
    const listed = rows
      .filter((row) => row.adapterType === POOL_ACCOUNT_ADAPTER_TYPE || row.bindingAgentId !== null)
      .map(({ bindingAgentId: _bindingAgentId, ...agent }) => agent);
    return { bindings: await bindingSummaries(ctx.actor, companyId, listed) };
  }

  /** One agent's binding, its devices and its options. Agents read only their own, without options. */
  async function getAgentBinding(ctx: PoolContext, agentId: string): Promise<AgentAiAccountBindingDetail> {
    const agent = await getAgent(agentId);
    if (!agent) throw notFound("Agent not found");
    const [summary] = await bindingSummaries(ctx.actor, agent.companyId, [agent]);
    if (ctx.actor.type !== "board") return { ...summary!, options: [], canBindAny: false };
    return {
      ...summary!,
      // Fork: another adapter can take no account, so its options would all be `adapter_unsupported`.
      options: agent.adapterType === POOL_ACCOUNT_ADAPTER_TYPE ? await companyOptions(ctx.actor, agent.companyId, agent) : [],
      canBindAny: isCompanyAdmin(ctx.actor, agent.companyId),
    };
  }

  /**
   * Binds an agent (spec 5.3), in one transaction under the bindings lock:
   * authorization (5.1), the Claude adapter, eligibility, a device for every
   * candidate environment, the credential type and the device cap; then the
   * row is written. After commit the agent's waits are woken. Running runs
   * keep their account; the binding applies from the next run.
   */
  async function setBinding(ctx: PoolContext, agentId: string, input: SetAgentAiAccount): Promise<SetAgentAiAccountResponse> {
    const { actor } = ctx;
    if (actor.type !== "board") throw bindingForbidden("Agents cannot change Claude account bindings.");
    const now = clock();
    const mode = deploymentMode();
    const outcome = await db.transaction(async (tx) => {
      await acquireBindingsLock(tx);
      const agent = await getAgent(agentId, tx);
      if (!agent) throw notFound("Agent not found");
      if (agent.status === "terminated") throw conflict("A terminated agent cannot take a Claude account.");
      const [current] = await tx.select().from(aiAccountAgentBindings).where(eq(aiAccountAgentBindings.agentId, agent.id)).for("update");
      const currentAccount = current?.accountId ? await accountById(tx, current.accountId) : null;
      const permissionState: BindingPermissionState | null = current
        ? { mode: current.mode, accountId: currentAccount?.id ?? null, accountOwnerId: currentAccount ? effectiveAccountOwner(currentAccount) : null }
        : null;
      let account: AiAccountRow | null = null;
      if (input.mode === "pool_account") {
        account = await accountById(tx, input.accountId);
        const change: BindingChange = { mode: "pool_account", accountOwnerId: account ? effectiveAccountOwner(account) : null };
        if (!mayChangeBinding(actor, agent.companyId, permissionState, change)) throw bindingForbidden();
      } else if (!mayChangeBinding(actor, agent.companyId, permissionState, { mode: "device_login" })) {
        throw bindingForbidden("Only a company admin, or the owner of the agent's current Claude account, can switch it to the device's own login.");
      }
      if (agent.adapterType !== POOL_ACCOUNT_ADAPTER_TYPE) {
        throw await bindingFailureError(tx, {
          code: "ai_account_incompatible",
          reason: "adapter_unsupported",
          environmentId: null,
          environmentName: null,
          deviceId: null,
          deviceName: null,
        }, { companyId: agent.companyId });
      }
      if (input.mode === "pool_account" && !account) {
        throw await bindingFailureError(tx, { code: "ai_account_not_eligible", reason: "unassigned" }, { companyId: agent.companyId });
      }
      const nextAccountId = account?.id ?? null;
      // Choosing the current manual selection again changes nothing, so nothing is checked or written.
      const unchanged = current?.mode === input.mode && (current.accountId ?? null) === nextAccountId && current.source === "manual";
      let warnings: AiAccountSelectionWarning[] = account ? selectionWarnings(account, now) : [];
      if (account && !unchanged) {
        const check = await checkAccountBinding(tx, {
          agent: poolPlacementOf(agent),
          account,
          newSelection: !(current?.mode === "pool_account" && current.accountId === account.id),
          deploymentMode: mode,
          now,
        });
        if (!check.ok) throw await bindingFailureError(tx, check.failure, { companyId: agent.companyId, deploymentMode: mode, now });
        warnings = check.warnings;
      }
      if (!unchanged) {
        await tx.insert(aiAccountAgentBindings).values({
          agentId: agent.id,
          companyId: agent.companyId,
          mode: input.mode,
          accountId: nextAccountId,
          source: "manual",
          migrationNote: null,
          reviewedAt: null,
          updatedByUserId: actor.userId ?? null,
          createdAt: now,
          updatedAt: now,
        }).onConflictDoUpdate({
          target: aiAccountAgentBindings.agentId,
          set: {
            mode: input.mode,
            accountId: nextAccountId,
            source: "manual",
            migrationNote: null,
            reviewedAt: null,
            updatedByUserId: actor.userId ?? null,
            updatedAt: touched(aiAccountAgentBindings.updatedAt, now),
          },
        });
      }
      return { agent, account, previous: current ?? null, changed: !unchanged, warnings };
    });
    if (outcome.changed) {
      await wake({ agentIds: [outcome.agent.id] });
      // A replaced account may have freed a slot on the agent's devices.
      if (outcome.previous?.accountId) await refreshDeviceFlags([poolPlacementOf(outcome.agent)]);
      await audit(ctx, [outcome.agent.companyId], {
        action: "ai_account.binding_updated",
        entityType: "agent",
        entityId: outcome.agent.id,
        details: {
          mode: input.mode,
          accountId: outcome.account?.id ?? null,
          ...(outcome.account ? { accountLabel: outcome.account.label } : {}),
          previousMode: outcome.previous?.mode ?? null,
          previousAccountId: outcome.previous?.accountId ?? null,
        },
      });
    }
    const runningRuns = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, outcome.agent.companyId),
      eq(heartbeatRuns.agentId, outcome.agent.id),
      eq(heartbeatRuns.status, "running"),
    ));
    return {
      ...(await bindingSummary(ctx.actor, outcome.agent.id)),
      appliesFrom: "next_run",
      runningRunIds: runningRuns.map((run) => run.id),
      warnings: outcome.warnings,
    };
  }

  /**
   * Removes the binding row: the agent goes back to its AI connection or the
   * device's own login. Never refused for the adapter, so a selection left on
   * an agent moved off Claude can always be removed.
   */
  async function clearBinding(ctx: PoolContext, agentId: string): Promise<void> {
    const { actor } = ctx;
    if (actor.type !== "board") throw bindingForbidden("Agents cannot change Claude account bindings.");
    const outcome = await db.transaction(async (tx) => {
      await acquireBindingsLock(tx);
      const agent = await getAgent(agentId, tx);
      if (!agent) throw notFound("Agent not found");
      const [current] = await tx.select().from(aiAccountAgentBindings).where(eq(aiAccountAgentBindings.agentId, agent.id)).for("update");
      if (!current) return null;
      const currentAccount = current.accountId ? await accountById(tx, current.accountId) : null;
      const permissionState: BindingPermissionState = {
        mode: current.mode,
        accountId: currentAccount?.id ?? null,
        accountOwnerId: currentAccount ? effectiveAccountOwner(currentAccount) : null,
      };
      if (!mayChangeBinding(actor, agent.companyId, permissionState, { mode: "clear" })) {
        throw bindingForbidden("Only a company admin, or the owner of the agent's current Claude account, can remove it.");
      }
      await tx.delete(aiAccountAgentBindings).where(eq(aiAccountAgentBindings.agentId, agent.id));
      return { agent, previous: current };
    });
    if (!outcome) return;
    await wake({ agentIds: [outcome.agent.id] });
    if (outcome.previous.accountId) await refreshDeviceFlags([poolPlacementOf(outcome.agent)]);
    await audit(ctx, [outcome.agent.companyId], {
      action: "ai_account.binding_cleared",
      entityType: "agent",
      entityId: outcome.agent.id,
      details: { previousMode: outcome.previous.mode, previousAccountId: outcome.previous.accountId },
    });
  }

  /** A company admin confirms a migrated binding (`reviewed_at`). */
  async function confirmMigratedBinding(ctx: PoolContext, agentId: string): Promise<AgentAiAccountBindingSummary> {
    const agent = await getAgent(agentId);
    if (!agent) throw notFound("Agent not found");
    if (!isCompanyAdmin(ctx.actor, agent.companyId)) throw bindingForbidden("Only a company admin can confirm a migrated assignment.");
    const now = clock();
    const [row] = await db.update(aiAccountAgentBindings)
      .set({ reviewedAt: now, updatedByUserId: ctx.actor.userId ?? null, updatedAt: touched(aiAccountAgentBindings.updatedAt, now) })
      .where(and(eq(aiAccountAgentBindings.agentId, agent.id), eq(aiAccountAgentBindings.companyId, agent.companyId)))
      .returning();
    if (!row) throw notFound("This agent has no Claude account assignment to confirm");
    await audit(ctx, [agent.companyId], {
      action: "ai_account.binding_reviewed",
      entityType: "agent",
      entityId: agent.id,
      details: { mode: row.mode, accountId: row.accountId, source: row.source },
    });
    return bindingSummary(ctx.actor, agent.id);
  }

  // --- Placement (spec 5.6) ---------------------------------------------------

  /**
   * Under the bindings lock (inside `tx`): the move of a pool-bound agent
   * to `nextEnvironmentId` is allowed by spec 5.1, and its new candidate set
   * passes steps 4–7. The agent row must still have `previousEnvironmentId`
   * (409 `placement_conflict`). Agents never move a pool-bound agent. Once
   * the move may go ahead, the agent's binding row (any mode) gets a new
   * `updated_at`: the lost-wake guard of a deferral racing the move reads it
   * (spec 7.3 step 5).
   */
  async function assertPlacementIn(
    tx: Tx,
    actor: PoolActor,
    agent: Pick<PoolAgentRow, "id" | "companyId">,
    previousEnvironmentId: string | null,
    nextEnvironmentId: string | null,
  ): Promise<{ status: string; holdsAccount: boolean } | null> {
    const now = clock();
    const mode = deploymentMode();
    await acquireBindingsLock(tx);
    const [row] = await tx
      .select({ id: agents.id, companyId: agents.companyId, status: agents.status, defaultEnvironmentId: agents.defaultEnvironmentId })
      .from(agents)
      .where(and(eq(agents.id, agent.id), eq(agents.companyId, agent.companyId)))
      .for("update");
    if (!row) return null;
    if ((row.defaultEnvironmentId ?? null) !== previousEnvironmentId) {
      throw conflict("This agent's environment changed while you were editing it. Reload and try again.", { code: "placement_conflict" });
    }
    const [binding] = await tx.select().from(aiAccountAgentBindings).where(eq(aiAccountAgentBindings.agentId, agent.id));
    let holdsAccount = false;
    if (binding?.mode === "pool_account") {
      if (actor.type !== "board") {
        throw bindingForbidden("An agent cannot move itself while it uses a Claude account from the pool. Ask its owner or a company admin.");
      }
      const account = binding.accountId ? await accountById(tx, binding.accountId) : null;
      if (account) {
        if (!canBindAccount(actor, agent.companyId, account)) {
          throw bindingForbidden("Only the owner of this agent's Claude account or a company admin can move the agent to another environment.");
        }
        const check = await checkAccountBinding(tx, {
          agent: poolPlacementOf({ ...agent, defaultEnvironmentId: nextEnvironmentId }),
          account,
          checkEligibility: false,
          newSelection: false,
          deploymentMode: mode,
          now,
        });
        if (!check.ok) throw await bindingFailureError(tx, check.failure, { companyId: agent.companyId, deploymentMode: mode, now });
        holdsAccount = true;
      }
    }
    if (binding) {
      await tx.update(aiAccountAgentBindings)
        .set({ updatedAt: touched(aiAccountAgentBindings.updatedAt, now) })
        .where(eq(aiAccountAgentBindings.agentId, agent.id));
    }
    return { status: row.status, holdsAccount };
  }

  /**
   * The wakes after a move: the agent's waits, and the epoch of the
   * environment it was pinned to, so a deferral racing the move on that
   * environment notices it even without a binding row to read.
   */
  async function wakeAfterMove(agentId: string, previousEnvironmentId: string | null): Promise<void> {
    await wake({ agentIds: [agentId] });
    if (previousEnvironmentId) await wake({ agentIds: [agentId], environmentIds: [previousEnvironmentId] });
  }

  /**
   * The placement hook of PATCH /agents/:id and the revision rollback (spec
   * 5.6). When `patch.defaultEnvironmentId` moves the agent, `save` (the
   * upstream write, given a transaction-bound handle) runs inside one
   * transaction under the bindings lock, after the placement checks and a
   * compare-and-set on the environment the caller validated
   * (`agent.defaultEnvironmentId`; 409 `placement_conflict`). The write
   * itself stays upstream's, so config revisions and the pending-approval
   * freeze see the move. Otherwise `save` runs as it is. The agent's waits
   * are woken after a move.
   */
  async function savePlacement<T>(
    actor: PoolActor,
    agent: Pick<PoolAgentRow, "id" | "companyId" | "defaultEnvironmentId">,
    patch: object,
    save: (executor: Db) => Promise<T>,
  ): Promise<T> {
    if (!hasOwn(patch, "defaultEnvironmentId")) return save(db);
    const requested = (patch as { defaultEnvironmentId?: unknown }).defaultEnvironmentId;
    const nextEnvironmentId = typeof requested === "string" ? requested : null;
    const previousEnvironmentId = agent.defaultEnvironmentId ?? null;
    if (nextEnvironmentId === previousEnvironmentId) return save(db);
    // A handle without transactions (a unit-test stub) cannot hold the lock;
    // the agent service makes the same allowance for its own write.
    if (typeof (db as { transaction?: unknown }).transaction !== "function") return save(db);
    const { result, holdsAccount } = await db.transaction(async (tx) => {
      const placement = await assertPlacementIn(tx, actor, agent, previousEnvironmentId, nextEnvironmentId);
      return { result: await save(asDb(tx)), holdsAccount: placement?.holdsAccount ?? false };
    });
    await wakeAfterMove(agent.id, previousEnvironmentId);
    // The account left the devices of the previous placement.
    if (holdsAccount) await refreshDeviceFlags([poolPlacementOf({ ...agent, defaultEnvironmentId: previousEnvironmentId })]);
    return result;
  }

  /**
   * Spec 5.6 as written, for an agent that holds a pool account: checks the
   * move and writes `agents.default_environment_id` itself, compare-and-set
   * on the previous value, in one transaction under the bindings lock. For
   * callers whose own write happens elsewhere and later writes the same
   * value. Any other agent is left as it is (false): the caller's own write
   * applies its environment, as upstream does.
   */
  async function assertPlacementAndWriteEnvironment(
    actor: PoolActor,
    agent: Pick<PoolAgentRow, "id" | "companyId" | "defaultEnvironmentId">,
    nextEnvironmentId: string | null,
    opts: { onlyStatus?: string } = {},
  ): Promise<boolean> {
    const previousEnvironmentId = agent.defaultEnvironmentId ?? null;
    if (nextEnvironmentId === previousEnvironmentId) return false;
    const now = clock();
    const outcome = await db.transaction(async (tx) => {
      const row = await assertPlacementIn(tx, actor, agent, previousEnvironmentId, nextEnvironmentId);
      if (!row || !row.holdsAccount || (opts.onlyStatus && row.status !== opts.onlyStatus)) return null;
      const updated = await tx.update(agents)
        .set({ defaultEnvironmentId: nextEnvironmentId, updatedAt: now })
        .where(and(
          eq(agents.id, agent.id),
          eq(agents.companyId, agent.companyId),
          sql`${agents.defaultEnvironmentId} is not distinct from ${previousEnvironmentId}`,
        ))
        .returning({ id: agents.id });
      if (updated.length === 0) {
        throw conflict("This agent's environment changed while you were editing it. Reload and try again.", { code: "placement_conflict" });
      }
      return row;
    });
    if (!outcome) return false;
    await wakeAfterMove(agent.id, previousEnvironmentId);
    await refreshDeviceFlags([poolPlacementOf({ ...agent, defaultEnvironmentId: previousEnvironmentId })]);
    return true;
  }

  /**
   * The hire-approval hook (spec 5.6): when approving a hire moves a pending
   * agent that holds a pool account to another environment, the move passes
   * the placement checks and is written now, under the bindings lock;
   * activation then writes the same value. Any other hire is left to
   * activation, which applies the approved payload's environment as
   * upstream does. The environment applies only when the approved payload
   * carries one, as activation reads it.
   */
  async function placeHireForApproval(
    actor: PoolActor,
    approval: { companyId: string; type: string; status: string; payload: unknown },
    requestedEnvironmentId: unknown,
  ): Promise<void> {
    if (approval.type !== "hire_agent" || !["pending", "revision_requested"].includes(approval.status)) return;
    const payload = approval.payload && typeof approval.payload === "object" ? approval.payload as Record<string, unknown> : {};
    const merged = requestedEnvironmentId !== undefined ? { ...payload, defaultEnvironmentId: requestedEnvironmentId } : payload;
    if (!hasOwn(merged, "defaultEnvironmentId") || typeof payload.agentId !== "string") return;
    const nextEnvironmentId = typeof merged.defaultEnvironmentId === "string" ? merged.defaultEnvironmentId : null;
    const agent = await getAgent(payload.agentId);
    if (!agent || agent.companyId !== approval.companyId || agent.status !== "pending_approval") return;
    await assertPlacementAndWriteEnvironment(actor, agent, nextEnvironmentId, { onlyStatus: "pending_approval" });
  }

  // --- Instance admin operations ----------------------------------------------

  async function listAll(): Promise<InstanceAiAccountsResponse> {
    const rows = await db.select().from(aiAccounts).orderBy(asc(aiAccounts.createdAt), asc(aiAccounts.id));
    return { accounts: await instanceViews(rows) };
  }

  /**
   * Withdraws an account for every company (separate from the owner's own
   * pause), or lifts that. Only admins clear it, and they never resume an
   * account its owner paused.
   */
  async function setAdminDisabled(
    ctx: PoolContext,
    accountId: string,
    input: { adminDisabled: boolean; reason?: string | null },
  ): Promise<InstanceAiAccountSummary> {
    const now = clock();
    const account = await requireAccount(db, accountId);
    if (input.adminDisabled) {
      const [updated] = await db.update(aiAccounts).set({
        adminDisabledAt: account.adminDisabledAt ?? now,
        adminDisabledByUserId: account.adminDisabledAt ? account.adminDisabledByUserId : ctx.actor.userId ?? null,
        adminDisabledReason: input.reason === undefined ? account.adminDisabledReason : input.reason,
        poolEnabled: false,
        updatedAt: touched(aiAccounts.updatedAt, now),
      }).where(eq(aiAccounts.id, account.id)).returning();
      if (!account.adminDisabledAt) await auditAccount(ctx, updated!, "ai_account.admin_disabled", { reason: updated!.adminDisabledReason });
    } else if (account.adminDisabledAt) {
      const [updated] = await db.update(aiAccounts).set({
        adminDisabledAt: null,
        adminDisabledByUserId: null,
        adminDisabledReason: null,
        poolEnabled: poolEnabledFor(account.status, null),
        updatedAt: touched(aiAccounts.updatedAt, now),
      }).where(eq(aiAccounts.id, account.id)).returning();
      await wake({ accountIds: [account.id] });
      await auditAccount(ctx, updated!, "ai_account.admin_enabled");
    }
    return instanceView(account.id);
  }

  /**
   * Transfers an account to another existing user (422 otherwise; 409
   * `ai_account_duplicate` when the new owner already has that e-mail hint).
   * `ai_account.owner_changed` goes to every company where the old or the new
   * owner is an active member; an entry names an owner only where that owner
   * is a member. When neither owner is a member anywhere, it goes to the
   * companies whose agents use the account, without the label or either
   * owner. The account's waits are woken. Its limit and sign-in state stay:
   * they describe the credential, which a transfer does not change.
   */
  async function transferOwner(ctx: PoolContext, accountId: string, ownerUserId: string): Promise<InstanceAiAccountSummary> {
    const now = clock();
    const account = await requireAccount(db, accountId);
    const previousOwnerId = effectiveAccountOwner(account);
    if (previousOwnerId === ownerUserId) return instanceView(account.id);
    const [user] = await db.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.id, ownerUserId));
    if (!user) throw unprocessable("No user with this id exists. An account can move only to an existing user.", { code: "ai_account_owner_unknown" });
    const mode = deploymentMode();
    const previousCompanies = new Set(await memberCompanyIds(db, previousOwnerId, mode));
    const nextCompanies = new Set(await memberCompanyIds(db, ownerUserId, mode));
    let updated: AiAccountRow;
    try {
      [updated] = await db.update(aiAccounts)
        .set({ ownerUserId, updatedAt: touched(aiAccounts.updatedAt, now) })
        .where(eq(aiAccounts.id, account.id))
        .returning() as [AiAccountRow];
    } catch (error) {
      throw aiAccountDuplicateError(error, "The new owner already has a Claude account with this e-mail.");
    }
    await wake({ accountIds: [account.id] });
    if (previousCompanies.size === 0 && nextCompanies.size === 0) {
      const fallback = await accountAuditTargets(updated);
      await auditAccount(ctx, updated, "ai_account.owner_changed", {}, { companyIds: fallback.companyIds, labelled: false });
    }
    for (const companyId of unique([...previousCompanies, ...nextCompanies])) {
      await audit(ctx, [companyId], {
        action: "ai_account.owner_changed",
        entityType: "ai_account",
        entityId: account.id,
        details: {
          accountLabel: updated.label,
          ...(previousCompanies.has(companyId) && previousOwnerId ? { previousOwnerUserId: previousOwnerId } : {}),
          ...(nextCompanies.has(companyId) ? { newOwnerUserId: ownerUserId } : {}),
        },
      });
    }
    return instanceView(account.id);
  }

  /** PATCH /api/instance/ai-accounts/:id: the owner transfer first, then the admin switch. */
  async function updateInstanceAccount(ctx: PoolContext, accountId: string, input: UpdateInstanceAiAccount): Promise<InstanceAiAccountSummary> {
    let view: InstanceAiAccountSummary | null = null;
    if (input.ownerUserId !== undefined) view = await transferOwner(ctx, accountId, input.ownerUserId);
    if (input.adminDisabled !== undefined) {
      view = await setAdminDisabled(ctx, accountId, { adminDisabled: input.adminDisabled, reason: input.reason });
    } else if (input.reason !== undefined) {
      const account = await requireAccount(db, accountId);
      if (account.adminDisabledAt) {
        await db.update(aiAccounts).set({ adminDisabledReason: input.reason, updatedAt: touched(aiAccounts.updatedAt, clock()) }).where(eq(aiAccounts.id, account.id));
      }
    }
    return view ?? instanceView(accountId);
  }

  async function adminClearLimit(ctx: PoolContext, accountId: string): Promise<InstanceAiAccountSummary> {
    await clearLimitOf(ctx, await requireAccount(db, accountId));
    return instanceView(accountId);
  }

  async function adminDelete(ctx: PoolContext, accountId: string, options: { release?: boolean } = {}): Promise<void> {
    await removeAccount(ctx, accountId, { release: options.release === true, owner: false });
  }

  return {
    getAgent: (agentId: string) => getAgent(agentId),
    // Owner
    listMine,
    create,
    update,
    replaceCredential,
    clearLimit,
    clearProjectRestriction,
    remove,
    // Company
    listForCompany,
    listBindings,
    getAgentBinding,
    setBinding,
    clearBinding,
    confirmMigratedBinding,
    // Placement
    savePlacement,
    assertPlacementAndWriteEnvironment,
    placeHireForApproval,
    // Instance admin
    listAll,
    updateInstanceAccount,
    setAdminDisabled,
    transferOwner,
    adminClearLimit,
    adminDelete,
  };
}

export type AiAccountPoolService = ReturnType<typeof aiAccountPoolService>;
