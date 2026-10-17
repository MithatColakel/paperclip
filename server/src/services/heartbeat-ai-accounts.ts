import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  type Db,
  agents,
  aiAccountAgentBindings,
  aiAccountHosts,
  aiAccounts,
  aiConnectionQuotaStates,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  AI_ACCOUNT_CREDIT_BALANCE_COOLDOWN_MS,
  AI_ACCOUNT_DEFAULT_LIMIT_COOLDOWN_MS,
  AI_ACCOUNT_ENV_KEY,
  AI_CONNECTION_POOL_DEFAULT_COOLDOWN_MS,
  AI_CREDENTIAL_REF_ENV_KEY,
  POOL_RUN_AUTH_ENV_KEYS,
  POOL_RUN_REMOVED_ENV_KEYS,
  aiProviderSchema,
  findPoolRunForbiddenEnvKeys,
  findPoolRunSettingsConflicts,
  isResourceWaitErrorCode,
  type AiAccountBindingMode,
  type AiAccountCredentialType,
  type AiAccountLimitSource,
  type AiAccountWaitReason,
  type AiPoolAccountRunAttribution,
  type DeploymentMode,
} from "@paperclipai/shared";
import {
  runAdapterExecutionTargetProcess,
  type AdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import { resolveDeploymentMode } from "../config-file.js";
import { logger } from "../middleware/logger.js";
import { AI_CONNECTION_POOL_WAIT_RETRY_REASON } from "../modules/run-dispatch/index.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import type { StoredSecretVersionMaterial } from "../secrets/types.js";
import { logActivity } from "./activity-log.js";
import { credentialRefForAccount } from "./ai-account-credentials.js";
import { isCreditBalanceFailure } from "./ai-account-hosts.js";
import { isAiAuthenticationFailure } from "./ai-auth-failure.js";
import { aiConnectionPoolService } from "./ai-connection-pool.js";
import { assertManagedAiProjectAuth } from "./ai-connection-runtime.js";
import {
  LEGACY_HOST_POOL_ATTRIBUTION_MODE,
  capOf,
  deviceForEnvironment,
  insertRunSlot,
  lockDevice,
  runningPoolAccountsOnDevice,
  wouldExceedDeviceCap,
  type DeviceEnvironmentRef,
  type ExecutionDeviceRow,
} from "./execution-devices.js";
import { executionRetryAttemptCount } from "./execution-recovery-attempt.js";
import {
  ConfigurationRefusal,
  RESOURCE_WAIT_TIMINGS,
  accountWaitDeferral,
  claimAccountProbe,
  claimResourceWaitNotice,
  deviceSlotsDeferral,
  effectiveAccountOwner,
  evaluateAccountPlan,
  isActiveUserMember,
  mergeWakeEpochs,
  readWakeEpochs,
  releaseResourceWaitNotice,
  resourceWaitJitterMs,
  type ResourceWaitDeferral,
  type ResourceWaitScheduleOutcome,
  type ResourceWaits,
  type WakeEpochSnapshot,
} from "./resource-waits/index.js";
import type { RunEnvironmentRow } from "./resource-waits/run-environment.js";

/**
 * Fork: the run-path side of the Claude account pool (spec 4). Input-only:
 * heartbeat (W8) passes the run, agent, environment and resolved config, and
 * this module never imports heartbeat.
 *
 * - `readBinding` decides where a run's Claude credential comes from (spec
 *   4.1): a pool account, the device's own login, or the upstream binding.
 * - `planCredential` walks spec 4.2 rows 0–10. A run that has to wait throws
 *   a `ResourceWaitDeferral` (the executeRun outer catch finalizes it); real
 *   configuration throws a `ConfigurationRefusal`. `previewCredentialPlan` is
 *   its dry run (nothing created, nothing thrown).
 * - `assertRoutingCompatible` refuses routing overrides in the run's env layers
 *   and in the project's Claude settings (spec 4.4).
 * - `acquire` takes the device row lock, checks the device's running accounts
 *   against its cap, records the run slot and the attribution, and decrypts the
 *   credential only after commit (spec 4.3). `inject` puts it into the run
 *   environment with the pool hygiene of spec 4.4.
 * - `handleRunLimit`, `handleRunAuthFailure`, `handleCompanyPoolLimit` and
 *   `noteAccountRunSucceeded` handle how a pool run ended (spec 4.6).
 *
 * Product rule P7: nothing here ever chooses, rotates, balances or fails over
 * between accounts. A limited account makes its tasks wait for the reset; a
 * signed-out account makes them wait for its owner. Every handler changes an
 * account only when the run's own attribution names it.
 *
 * A run slot (`ai_account_run_slots`) is never deleted when its run ends: the
 * running set only counts slots of runs whose status is `running`, and the
 * resource-wait sweep prunes slots of runs that ended more than 24 h ago.
 */

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type AgentRow = typeof agents.$inferSelect;
type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;
type AccountRow = typeof aiAccounts.$inferSelect;

/** The attribution mode a pool run records in `contextSnapshot.aiConnection`. */
export const POOL_ACCOUNT_ATTRIBUTION_MODE = "pool_account";

/** Limit and sign-in timings of spec 4.6. */
export const HEARTBEAT_AI_ACCOUNT_LIMITS = {
  /** A typed provider reset further out than this is clamped to it (source `estimated`). */
  typedResetMaxAheadMs: 7 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000,
  /** Credit balance: a typed reset is clamped to, and an untyped one estimated at, 24 h. */
  creditBalanceMs: AI_ACCOUNT_CREDIT_BALANCE_COOLDOWN_MS,
  /** Untyped usage limits: 1 h × 2^strikes, at most 12 h. */
  estimateBaseMs: AI_ACCOUNT_DEFAULT_LIMIT_COOLDOWN_MS,
  estimateMaxMs: 12 * 60 * 60 * 1000,
  /** A second untyped sign-in failure on another run within this marks the account signed out. */
  authStrikeWindowMs: 2 * 60 * 60 * 1000,
} as const;

const LIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const PROJECT_SETTINGS_FILES = [".claude/settings.json", ".claude/settings.local.json"] as const;
const ACCOUNT_STATUS_MESSAGE_MAX_LENGTH = 500;

/**
 * A settings key that routes a pool credential away from Anthropic, runs a
 * credential helper, or carries another credential (the keys a pool run
 * deletes from its env: the CLI applies a settings `env` block itself, so it
 * would put them back), as a JSON key (for files that cannot be parsed, and
 * for the remote scan, which never returns file content). Wider than the
 * exact matchers on purpose: a remote scan cannot read values, so a present
 * key refuses.
 */
const SETTINGS_CONFLICT_KEY_SOURCE =
  "apiKeyHelper|awsAuthRefresh|awsCredentialExport|ANTHROPIC_[A-Za-z0-9_]*BASE_URL|CLAUDE_CODE_[A-Za-z0-9_]*BASE_URL" +
  "|CLAUDE_CODE_USE_[A-Za-z0-9_]*|[Hh][Tt][Tt][Pp][Ss]?_[Pp][Rr][Oo][Xx][Yy]|[Aa][Ll][Ll]_[Pp][Rr][Oo][Xx][Yy]" +
  `|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|${POOL_RUN_REMOVED_ENV_KEYS.join("|")}`;
const SETTINGS_CONFLICT_KEY_RE = new RegExp(`"(${SETTINGS_CONFLICT_KEY_SOURCE})"\\s*:`);
const SETTINGS_CONFLICT_KEY_ERE = `"(${SETTINGS_CONFLICT_KEY_SOURCE})"[[:space:]]*:`;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function toDate(value: unknown): Date | null {
  if (!(typeof value === "string" || typeof value === "number" || value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function isLimitReason(reason: string | null | undefined): reason is "usage_limit" | "credit_balance" {
  return reason === "usage_limit" || reason === "credit_balance";
}

function namedRef(value: { id: string; name: string } | null | undefined): { id: string; name: string } | null {
  return value ? { id: value.id, name: value.name } : null;
}

/** `evaluateAccountPlan` reads only `id`, `name`, `driver` and `config` of the environment. */
function asRunEnvironment(environment: DeviceEnvironmentRef): RunEnvironmentRow {
  return environment as unknown as RunEnvironmentRow;
}

/** `evaluateAccountPlan` runs plain selects; inside `acquire` they run on the transaction. */
function asQueryDb(tx: Tx): Db {
  return tx as unknown as Db;
}

function configuredDeploymentMode(): DeploymentMode | undefined {
  try {
    return resolveDeploymentMode();
  } catch (error) {
    logger.warn({ err: error }, "heartbeat AI accounts could not read the deployment mode; treating the local board user as a non-member");
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

/** A pool account (or legacy host-pool) attribution in a run's `contextSnapshot.aiConnection`. */
export interface RunPoolAttribution {
  mode: "pool_account" | "host_pool";
  accountId: string;
  accountName: string | null;
  /** The execution device (`hostId`). */
  deviceId: string | null;
  deviceName: string | null;
  method: AiAccountCredentialType | null;
  /** The run that acquired the account (pool_account only; the previous image stamped none). */
  runId: string | null;
}

export function readPoolAttribution(value: unknown): RunPoolAttribution | null {
  const record = asRecord(value);
  const mode = record.mode;
  if (mode !== POOL_ACCOUNT_ATTRIBUTION_MODE && mode !== LEGACY_HOST_POOL_ATTRIBUTION_MODE) return null;
  const accountId = nonEmptyString(record.accountId);
  if (!accountId) return null;
  return {
    mode,
    accountId,
    accountName: nonEmptyString(record.accountName),
    deviceId: nonEmptyString(record.hostId),
    deviceName: nonEmptyString(record.hostName),
    method: record.method === "api_key" || record.method === "subscription" ? record.method : null,
    runId: mode === POOL_ACCOUNT_ATTRIBUTION_MODE ? nonEmptyString(record.runId) : null,
  };
}

/**
 * The attribution the run itself acquired: a `pool_account` attribution
 * stamped with this run's id, or a legacy `host_pool` one (a run the previous
 * image started). A retry copies its source run's context, so a
 * `pool_account` attribution stamped with another run is not this run's.
 */
export function ownPoolAttribution(run: Pick<HeartbeatRunRow, "id" | "contextSnapshot">): RunPoolAttribution | null {
  const attribution = readPoolAttribution(asRecord(run.contextSnapshot).aiConnection);
  if (!attribution) return null;
  if (attribution.mode === POOL_ACCOUNT_ATTRIBUTION_MODE && attribution.runId !== run.id) return null;
  return attribution;
}

/** The run resumes a persisted native execution (its input is immutable, and it never waits). */
export function isPersistedNativeRun(run: Pick<HeartbeatRunRow, "runtimeMode" | "runnerProfileJson">): boolean {
  return run.runtimeMode === "native" && asRecord(run.runnerProfileJson).nativeExecutionInput !== undefined;
}

// ---------------------------------------------------------------------------
// Binding (spec 4.1)
// ---------------------------------------------------------------------------

/**
 * Where a run's Claude credential comes from, after a persisted router
 * selection (which keeps its upstream behaviour while that run resumes):
 * - `pool`: the pool path; a `pool_account` binding, or a resumed persisted
 *   native run whose own attribution names an account (row 0);
 * - `device_login`: the device's own login; no pool and no upstream binding;
 * - `none`: no fork row applies (no row, another adapter, or a persisted
 *   native run that started without a pool account, or with an upstream
 *   connection that keeps its own identity check); the upstream
 *   `aiConnection` applies, else the device login.
 */
export type RunAccountSource = "pool" | "device_login" | "none";

export interface RunAccountBinding {
  source: RunAccountSource;
  /** The binding row's mode and account; null without a row. */
  mode: AiAccountBindingMode | null;
  accountId: string | null;
  /** A resumed persisted native run's own pool attribution (row 0). */
  persisted: RunPoolAttribution | null;
  /** Read before the binding row (spec 7.3 step 5); merge with the preflight's epochs. */
  epochs: WakeEpochSnapshot;
}

const POOL_BINDING_ADAPTER_TYPE = "claude_local";

/**
 * Reads the agent's binding for a run that is starting. Every run start reads
 * it again, so a change applies from the next run. Only `claude_local`
 * agents use a binding.
 */
export async function readBinding(
  db: Db,
  input: {
    agent: Pick<AgentRow, "id" | "companyId" | "adapterType">;
    run?: Pick<HeartbeatRunRow, "runtimeMode" | "runnerProfileJson" | "contextSnapshot"> | null;
  },
): Promise<RunAccountBinding> {
  const { agent, run } = input;
  // The lost-wake guard: the binding's epoch is read before the binding row.
  const epochs = await readWakeEpochs(db, { agentId: agent.id });
  const [row] = await db
    .select({ mode: aiAccountAgentBindings.mode, accountId: aiAccountAgentBindings.accountId })
    .from(aiAccountAgentBindings)
    .where(and(eq(aiAccountAgentBindings.agentId, agent.id), eq(aiAccountAgentBindings.companyId, agent.companyId)));
  const mode = row?.mode ?? null;
  const accountId = row?.accountId ?? null;
  if (agent.adapterType !== POOL_BINDING_ADAPTER_TYPE) return { source: "none", mode, accountId, persisted: null, epochs };
  const persistedRun = run ? isPersistedNativeRun(run) : false;
  if (persistedRun && run) {
    // Persisted native runs keep the account they started with (spec 4.5):
    // a pool attribution is row 0, and any other saved connection
    // (responsible_user, shared, company_pool, …) stays on the upstream path,
    // whose identity check refuses the run once that connection changed. A
    // device_login row must not move either onto the device's own login.
    const saved = asRecord(run.contextSnapshot).aiConnection;
    const persisted = readPoolAttribution(saved);
    if (persisted) return { source: "pool", mode, accountId, persisted, epochs };
    const savedMode = nonEmptyString(asRecord(saved).mode);
    if (savedMode && savedMode !== POOL_ACCOUNT_ATTRIBUTION_MODE && savedMode !== LEGACY_HOST_POOL_ATTRIBUTION_MODE) {
      return { source: "none", mode, accountId, persisted: null, epochs };
    }
  }
  if (mode === "device_login") return { source: "device_login", mode, accountId, persisted: null, epochs };
  if (mode === "pool_account" && !persistedRun) return { source: "pool", mode, accountId, persisted: null, epochs };
  return { source: "none", mode, accountId, persisted: null, epochs };
}

// ---------------------------------------------------------------------------
// Plan (spec 4.2)
// ---------------------------------------------------------------------------

export interface PlanCredentialInput {
  run: Pick<HeartbeatRunRow, "id" | "companyId" | "agentId">;
  agent: Pick<AgentRow, "id" | "companyId" | "name" | "adapterType">;
  binding: Pick<RunAccountBinding, "source" | "accountId" | "persisted">;
  /** The resolved run environment; null maps to no device. */
  environment: DeviceEnvironmentRef | null;
  /** `readBinding`'s epochs merged with the preflight's (`mergeWakeEpochs`). */
  epochs?: WakeEpochSnapshot | null;
  now?: Date;
}

/** The account a run will use. Carries no credential material. */
export interface CredentialPlanUse {
  kind: "use";
  accountId: string;
  accountLabel: string;
  credentialType: AiAccountCredentialType;
  ownerUserId: string | null;
  /** The run's device; null only for a persisted run whose environment maps to none. */
  device: ExecutionDeviceRow | null;
  environment: DeviceEnvironmentRef | null;
  /** Row 0: a resumed persisted native run keeps its account and never waits. */
  persisted: boolean;
  /** The run holds the account's single probe after an estimated or repeated limit. */
  probe: boolean;
  epochs: WakeEpochSnapshot | null;
}

export type CredentialPlan = { kind: "none" } | CredentialPlanUse;

/** `previewCredentialPlan`'s answer. */
export type CredentialPlanPreview =
  | { outcome: "none"; reason: "unbound" | "device_login" | "adapter_unsupported" }
  | { outcome: "use"; accountId: string; deviceId: string | null; deviceName: string | null }
  | {
    outcome: "wait";
    reason: AiAccountWaitReason;
    accountId: string | null;
    deviceId: string | null;
    deviceName: string | null;
    resumeAt: string | null;
  }
  | { outcome: "refuse"; reason: "ai_connection_changed"; message: string };

type PlanEvaluation =
  | { outcome: "none" }
  | { outcome: "use"; plan: CredentialPlanUse }
  | { outcome: "wait"; deferral: ResourceWaitDeferral }
  | { outcome: "refuse"; refusal: ConfigurationRefusal };

interface EvaluateOptions {
  /** A dry run creates no device, reads no epochs and claims no probe. */
  dryRun: boolean;
  deploymentMode?: DeploymentMode;
}

function accountChangedRefusal(input: { companyId: string; agentId: string; accountLabel: string | null }): ConfigurationRefusal {
  const refusal = new ConfigurationRefusal({
    reason: "ai_connection_changed",
    message: `The Claude account ${input.accountLabel ? `"${input.accountLabel}" ` : ""}this native run used is no longer available. Start a new execution.`,
    companyId: input.companyId,
    agentId: input.agentId,
  });
  Object.assign(asRecord(refusal.resultJson.configurationIncomplete), { actionUrl: `/agents/${input.agentId}/runtime` });
  return refusal;
}

/** The device a persisted run reported, when its environment maps to none now. */
async function deviceById(db: Db, deviceId: string | null): Promise<ExecutionDeviceRow | null> {
  if (!deviceId) return null;
  const [row] = await db.select().from(aiAccountHosts).where(eq(aiAccountHosts.id, deviceId));
  return row ?? null;
}

/** Whether another live run holds the account's probe claim (dry runs only). */
async function probeHeldElsewhere(db: Db, account: Pick<AccountRow, "limitProbeRunId">, runId: string | null): Promise<boolean> {
  if (!account.limitProbeRunId || account.limitProbeRunId === runId) return false;
  const [holder] = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, account.limitProbeRunId), inArray(heartbeatRuns.status, [...LIVE_RUN_STATUSES])));
  return Boolean(holder);
}

/** Rows 0–10 for one run. Throws nothing: callers decide what a wait or a refusal does. */
async function evaluateCredentialPlan(db: Db, input: PlanCredentialInput, options: EvaluateOptions): Promise<PlanEvaluation> {
  const { run, agent, binding, environment } = input;
  const now = input.now ?? new Date();
  const companyId = agent.companyId;

  // Row 0: a resumed persisted native run keeps the account in its attribution
  // while it is usable; a persisted run never waits and never takes another account.
  if (binding.persisted) {
    const evaluation = await evaluateAccountPlan(db, {
      companyId,
      accountId: binding.persisted.accountId,
      environment: null,
      now,
      deploymentMode: options.deploymentMode,
    });
    const account = evaluation.account;
    if (!account || (evaluation.reason !== null && !isLimitReason(evaluation.reason))) {
      return {
        outcome: "refuse",
        refusal: accountChangedRefusal({
          companyId,
          agentId: agent.id,
          accountLabel: evaluation.ownerIsMember ? account?.label ?? null : null,
        }),
      };
    }
    const device = (environment ? await deviceForEnvironment(db, environment, { create: !options.dryRun }) : null)
      ?? await deviceById(db, binding.persisted.deviceId);
    return {
      outcome: "use",
      plan: {
        kind: "use",
        accountId: account.id,
        accountLabel: account.label,
        credentialType: account.credentialType,
        ownerUserId: effectiveAccountOwner(account),
        device,
        environment,
        persisted: true,
        probe: false,
        epochs: input.epochs ?? null,
      },
    };
  }
  if (binding.source !== "pool") return { outcome: "none" };

  // The lost-wake guard (spec 7.3 step 5): every epoch is read before the row
  // it guards. The binding's and the environment's came from readBinding and
  // the preflight; the account's and the device's are read here.
  let epochs: WakeEpochSnapshot | null = null;
  let device: ExecutionDeviceRow | null | undefined;
  if (!options.dryRun) {
    const early = input.epochs ?? await readWakeEpochs(db, { environmentId: environment?.id ?? null, agentId: agent.id });
    // The run creates the server or SSH device on first use (spec 6.1).
    const resolved = environment ? await deviceForEnvironment(db, environment, { create: true }) : null;
    const late = await readWakeEpochs(db, {
      environmentId: early.environmentId === null ? environment?.id ?? null : null,
      accountId: binding.accountId,
      deviceId: resolved?.id ?? null,
    });
    epochs = mergeWakeEpochs(early, late);
    device = resolved ? await deviceById(db, resolved.id) : null;
  }

  // Rows 1–9 (one predicate, shared with the hold's re-check).
  const evaluation = await evaluateAccountPlan(db, {
    companyId,
    accountId: binding.accountId,
    environment: environment ? asRunEnvironment(environment) : null,
    now,
    deploymentMode: options.deploymentMode,
    ...(environment && device !== undefined ? { device } : {}),
  });
  const account = evaluation.account;
  const accountLabel = account && evaluation.ownerIsMember ? account.label : null;
  const runDevice = evaluation.device ?? device ?? null;
  // Without an environment the run maps to no device (row 7), which comes before a limit (row 9).
  const reason = !environment && (evaluation.reason === null || isLimitReason(evaluation.reason))
    ? "device_unknown"
    : evaluation.reason;
  const wait = (waitReason: AiAccountWaitReason, resumeAt: Date | null = null) => ({
    outcome: "wait" as const,
    deferral: accountWaitDeferral({
      reason: waitReason,
      accountId: account?.id ?? binding.accountId,
      accountLabel,
      environment: namedRef(environment),
      device: namedRef(runDevice),
      resumeAt,
      resumeAtSource: resumeAt ? account?.limitSource ?? "estimated" : null,
      epochs,
    }),
  });
  if (reason !== null) {
    if (isLimitReason(reason) && account?.exhaustedUntil) {
      // Row 9: resume at the reset plus a stable per-run spread (0–120 s).
      return wait(reason, new Date(account.exhaustedUntil.getTime() + resourceWaitJitterMs(run.id)));
    }
    return wait(reason);
  }
  if (!account) return wait("unassigned");

  // The probe rule (spec 7.4): once an estimated or repeated limit has passed,
  // one run at a time tests the account. A fresh run takes the probe itself or
  // waits for the run that holds it.
  let probe = false;
  const probeApplies = account.exhaustedUntil !== null && (account.limitSource === "estimated" || account.limitStrikes > 0);
  if (probeApplies) {
    const limitReason = account.limitReason === "credit_balance" ? "credit_balance" : "usage_limit";
    if (options.dryRun) {
      if (await probeHeldElsewhere(db, account, null)) return wait(limitReason);
    } else {
      probe = await claimAccountProbe(db, account.id, run.id);
      if (!probe) return wait(limitReason);
    }
  }

  // Row 10.
  return {
    outcome: "use",
    plan: {
      kind: "use",
      accountId: account.id,
      accountLabel: account.label,
      credentialType: account.credentialType,
      ownerUserId: effectiveAccountOwner(account),
      device: runDevice,
      environment,
      persisted: false,
      probe,
      epochs,
    },
  };
}

/**
 * Dry run of `planCredential` for an agent in an environment (the migration
 * job's go/no-go and previews): rows 0–10 without creating a device, reading
 * epochs or claiming a probe. A device the run would create on first use (the
 * server, an SSH host) counts as known. The device cap is not checked here;
 * `acquire` checks the running set at run time.
 */
export async function previewCredentialPlan(
  db: Db,
  input: {
    agent: Pick<AgentRow, "id" | "companyId" | "name" | "adapterType">;
    environment: DeviceEnvironmentRef | null;
    /** Defaults to the agent's binding row. */
    binding?: Pick<RunAccountBinding, "source" | "accountId" | "persisted"> | null;
    now?: Date;
    deploymentMode?: DeploymentMode;
  },
): Promise<CredentialPlanPreview> {
  const binding = input.binding ?? await readBinding(db, { agent: input.agent });
  if (binding.source !== "pool" && !binding.persisted) {
    if (input.agent.adapterType !== POOL_BINDING_ADAPTER_TYPE) return { outcome: "none", reason: "adapter_unsupported" };
    return { outcome: "none", reason: binding.source === "device_login" ? "device_login" : "unbound" };
  }
  const evaluation = await evaluateCredentialPlan(db, {
    run: { id: "", companyId: input.agent.companyId, agentId: input.agent.id },
    agent: input.agent,
    binding,
    environment: input.environment,
    now: input.now,
  }, { dryRun: true, deploymentMode: input.deploymentMode ?? configuredDeploymentMode() });
  switch (evaluation.outcome) {
    case "none":
      return { outcome: "none", reason: "unbound" };
    case "use":
      return {
        outcome: "use",
        accountId: evaluation.plan.accountId,
        deviceId: evaluation.plan.device?.id ?? null,
        deviceName: evaluation.plan.device?.name ?? null,
      };
    case "wait": {
      const wait = evaluation.deferral.wait;
      return {
        outcome: "wait",
        reason: wait.reason as AiAccountWaitReason,
        accountId: wait.accountId,
        deviceId: wait.deviceId,
        deviceName: wait.deviceName,
        resumeAt: wait.resumeAt ? wait.resumeAt.toISOString() : null,
      };
    }
    case "refuse":
      return { outcome: "refuse", reason: "ai_connection_changed", message: evaluation.refusal.message };
  }
}

// ---------------------------------------------------------------------------
// Routing guard (spec 4.4)
// ---------------------------------------------------------------------------

/** A layer value as the run would see it: a plain binding's value; a secret reference counts as set. */
function layerValue(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const binding = value as Record<string, unknown>;
    if (binding.type === "plain") return binding.value;
    return "<secret>";
  }
  return value;
}

/**
 * The routing overrides set in env maps (the resolved run env and its
 * environment, agent, project and routine layers): `ANTHROPIC_*` or
 * `CLAUDE_CODE_*` keys ending in `_BASE_URL`, `CLAUDE_CODE_USE_*`, the proxy
 * variables in any case, `NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED`
 * and the legacy routing keys. Names only, sorted.
 */
export function findRoutingOverrides(layers: ReadonlyArray<unknown>): string[] {
  const keys = new Set<string>();
  for (const layer of layers) {
    const record = asRecord(layer);
    const values = Object.fromEntries(Object.entries(record).map(([key, value]) => [key, layerValue(value)]));
    for (const key of findPoolRunForbiddenEnvKeys(values)) keys.add(key);
  }
  return [...keys].sort();
}

/**
 * The conflicts in one project settings file: forbidden helper keys by name,
 * routing overrides in its `env` block as `env.<KEY>`, and any credential
 * carrier a pool run deletes from its env present in that block, whatever its
 * value (an empty `CLAUDE_SECURESTORAGE_CONFIG_DIR` selects the device
 * owner's own login). A file that is not valid JSON is matched by key name.
 */
export function projectSettingsConflicts(content: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    const match = SETTINGS_CONFLICT_KEY_RE.exec(content);
    return match ? [match[1]!] : [];
  }
  const conflicts = new Set(findPoolRunSettingsConflicts(parsed));
  const env = asRecord(asRecord(parsed).env);
  for (const key of POOL_RUN_REMOVED_ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(env, key)) conflicts.add(`env.${key}`);
  }
  return [...conflicts];
}

/**
 * The local project's `.claude/settings*.json` conflicts, from `cwd` up to the
 * filesystem root. With `skipUserSettings` (a run on a remote target, checked
 * before its workspace is realized) the server user's own `~/.claude` files
 * are skipped when the walk passes through the home directory: a remote pool
 * run reads the account's managed config directory, never them. A Local run
 * reads them, so its walk keeps them.
 */
async function localProjectSettingsConflicts(cwd: string, options: { skipUserSettings: boolean }): Promise<string[]> {
  const conflicts = new Set<string>();
  const start = path.resolve(cwd);
  const homeDirectory = options.skipUserSettings ? os.homedir() : "";
  const home = homeDirectory ? path.resolve(homeDirectory) : null;
  let directory = start;
  for (;;) {
    // The home directory as the project itself still counts.
    const userSettings = directory === home && directory !== start;
    for (const relative of userSettings ? [] : PROJECT_SETTINGS_FILES) {
      try {
        const content = await readFile(path.join(directory, relative), "utf8");
        for (const conflict of projectSettingsConflicts(content)) conflicts.add(conflict);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return [...conflicts].sort();
}

/**
 * The `sh -c` script of the remote scan: `$1` is the working directory, `$2`
 * the ERE of conflicting keys, then the settings files relative to each
 * directory. Exit 42: a conflict; 43: a file could not be read; 0: none. The
 * home directory as the project itself still counts.
 */
const REMOTE_SETTINGS_SCAN_SCRIPT = `
directory=$1; pattern=$2; shift 2
start=$directory
home=\${HOME%/}
while :; do
  if test "$directory" = "$start" || test -z "$home" || test "$directory" != "$home"; then
    for relative in "$@"; do
      file="$directory/$relative"
      if test -f "$file"; then
        grep -Eq "$pattern" "$file"
        result=$?
        if test "$result" -eq 0; then exit 42; fi
        if test "$result" -ne 1; then exit 43; fi
      fi
    done
  fi
  parent=$(dirname "$directory")
  if test "$parent" = "$directory"; then break; fi
  directory=$parent
done`;

/**
 * The same scan on a remote target, from its working directory up. Only an
 * exit code comes back, never file content. The remote user's own
 * `$HOME/.claude` files are skipped when the walk passes through `$HOME`:
 * claude-local points a remote pool run at the account's managed config
 * directory, so it never reads them. True when a conflicting key is present;
 * throws when the scan could not run.
 */
async function remoteProjectSettingsConflict(runId: string, target: AdapterExecutionTarget): Promise<boolean> {
  if (target.kind !== "remote") return false;
  const result = await runAdapterExecutionTargetProcess(
    `ai-pool-routing-check-${runId}`,
    target,
    "sh",
    ["-c", REMOTE_SETTINGS_SCAN_SCRIPT, "ai-pool-routing-check", target.remoteCwd, SETTINGS_CONFLICT_KEY_ERE, ...PROJECT_SETTINGS_FILES],
    { cwd: target.remoteCwd, env: {}, timeoutSec: 15, graceSec: 1, onLog: async () => {} },
  );
  if (result.exitCode === 42) return true;
  if (result.exitCode === 0) return false;
  throw new Error(`The project's Claude settings could not be checked (exit ${result.exitCode ?? "unknown"})`);
}

export interface AssertRoutingCompatibleInput {
  run: Pick<HeartbeatRunRow, "id" | "companyId">;
  agent: Pick<AgentRow, "id" | "companyId" | "name">;
  /** The resolved adapter config: its `env`, `cwd`, `extraArgs` and `args` are checked. */
  config: Record<string, unknown>;
  /** The raw environment, agent, project and routine env layers (secret references count as set). */
  envLayers?: ReadonlyArray<unknown>;
  /** The realized execution target: a remote one is scanned on the target. */
  target?: AdapterExecutionTarget | null;
  /**
   * The run executes on a remote (SSH or sandbox) target that is not realized
   * yet, so `config.cwd` is scanned on the server: the server user's own
   * `~/.claude` settings are skipped there, since a remote pool run never
   * reads them. Default false; a remote `target` is scanned on the target.
   */
  targetIsRemote?: boolean;
  /** Default true. */
  checkEnv?: boolean;
  /** Default true: arguments and the project's `.claude/settings*.json`. */
  checkProjectSettings?: boolean;
}

// ---------------------------------------------------------------------------
// Injection (spec 4.4)
// ---------------------------------------------------------------------------

/** What `acquire` hands to `inject`. The credential value never leaves the run environment. */
export interface AcquiredPoolCredential {
  readonly attribution: AiPoolAccountRunAttribution;
  readonly envKey: (typeof AI_ACCOUNT_ENV_KEY)[AiAccountCredentialType];
  readonly credentialRef: string;
  readonly accountLabel: string;
  readonly deviceName: string | null;
  /** The decrypted credential. Not enumerable, so logging or spreading the object never carries it. */
  readonly value: string;
}

/**
 * Puts a pool credential into the resolved config (mutated in place):
 * - the three auth keys are blanked, so nothing inherited stands in, and the
 *   one the account uses is set;
 * - the credential carriers are deleted, never blanked (an empty
 *   `CLAUDE_SECURESTORAGE_CONFIG_DIR` would select the device owner's login);
 * - the marker `PAPERCLIP_AI_CREDENTIAL_REF` is set. On sandbox and SSH
 *   targets claude-local then uses the account's own sanitized config
 *   directory, and on SSH it unsets the routing, proxy and carrier keys after
 *   the login profiles (W17); its secret keys go to the target off the
 *   command line;
 * - the auth keys join `secretKeys`, so logs and failure reports redact them;
 * - `context.aiConnection` is the attribution `acquire` wrote.
 */
export function injectPoolCredential(input: {
  config: Record<string, unknown>;
  secretKeys: Set<string>;
  context: Record<string, unknown>;
  credential: AcquiredPoolCredential;
}): void {
  const { config, secretKeys, context, credential } = input;
  const env: Record<string, unknown> = { ...asRecord(config.env) };
  for (const key of POOL_RUN_AUTH_ENV_KEYS) env[key] = "";
  for (const key of POOL_RUN_REMOVED_ENV_KEYS) delete env[key];
  env[credential.envKey] = credential.value;
  env[AI_CREDENTIAL_REF_ENV_KEY] = credential.credentialRef;
  config.env = env;
  for (const key of POOL_RUN_AUTH_ENV_KEYS) secretKeys.add(key);
  context.aiConnection = { ...credential.attribution };
}

// ---------------------------------------------------------------------------
// Stale attributions
// ---------------------------------------------------------------------------

/**
 * A retry copies its source run's context. Drops a copied `pool_account`
 * attribution (stamped with another run) or a legacy `host_pool` one, from
 * the in-memory context and the run row, before `acquire` reads the device's
 * running set: a copied `host_pool` attribution on a running run would count
 * as a legacy running account there, and a later failure handler must never
 * act on an account this run did not use. A resumed persisted native run keeps
 * its attribution (row 0 reads it). Returns true when one was dropped.
 */
export async function dropStaleAttribution(
  db: Db,
  input: {
    run: Pick<HeartbeatRunRow, "id" | "contextSnapshot">;
    context: Record<string, unknown>;
    persistedNativeExecutionInput?: boolean;
  },
): Promise<boolean> {
  if (input.persistedNativeExecutionInput) return false;
  const inMemory = readPoolAttribution(input.context.aiConnection);
  const stored = readPoolAttribution(asRecord(input.run.contextSnapshot).aiConnection);
  const stale = (attribution: RunPoolAttribution | null) =>
    attribution !== null && (attribution.mode === LEGACY_HOST_POOL_ATTRIBUTION_MODE || attribution.runId !== input.run.id);
  if (!stale(inMemory) && !stale(stored)) return false;
  if (stale(inMemory)) delete input.context.aiConnection;
  await db
    .update(heartbeatRuns)
    .set({ contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) - 'aiConnection'` })
    .where(and(
      eq(heartbeatRuns.id, input.run.id),
      sql`${heartbeatRuns.contextSnapshot} -> 'aiConnection' ->> 'mode' in (${POOL_ACCOUNT_ATTRIBUTION_MODE}, ${LEGACY_HOST_POOL_ATTRIBUTION_MODE})`,
      sql`coalesce(${heartbeatRuns.contextSnapshot} -> 'aiConnection' ->> 'runId', '') <> ${input.run.id}`,
    ));
  return true;
}

// ---------------------------------------------------------------------------
// Failure provenance (W16)
// ---------------------------------------------------------------------------

/**
 * The adapter result's classification of a failed run. Pass the adapter
 * result's fields where heartbeat still holds them; whatever is left out is
 * read from the run row's `resultJson`.
 */
export interface RunFailureProvenance {
  errorFamily?: string | null;
  /** "terminal": the CLI's own result, error or stderr; "transcript": only model or tool text matched. */
  classificationSource?: "terminal" | "transcript" | null;
  retryNotBefore?: string | Date | null;
  /** "provider_terminal": `retryNotBefore` is the provider's own reset time. */
  retryNotBeforeSource?: "provider_terminal" | null;
}

interface RunFailureFacts {
  errorCode: string | null;
  /** The run's error line (the CLI's own result message). */
  error: string | null;
  /** Terminal text only (the CLI's result message and stderr), never the transcript. */
  terminalText: string;
  family: string | null;
  source: "terminal" | "transcript" | null;
  typedReset: Date | null;
  apiErrorStatus: number | null;
}

/**
 * Reads what the adapter recorded for a run straight from its row, so a
 * caller holding a projected row (an oversized or SQL_ASCII `resultJson`)
 * still sees it. claude-local reports `provider_quota` and sign-in failures
 * only from the CLI's own output (W16), so a result that names no source
 * (an adapter build from before it) counts as terminal for those two.
 */
async function readRunFailureFacts(db: Db, runId: string, explicit: RunFailureProvenance | null | undefined): Promise<RunFailureFacts | null> {
  const [row] = await db
    .select({
      errorCode: heartbeatRuns.errorCode,
      error: heartbeatRuns.error,
      stderrExcerpt: heartbeatRuns.stderrExcerpt,
      errorFamily: sql<string | null>`${heartbeatRuns.resultJson} ->> 'errorFamily'`,
      classificationSource: sql<string | null>`${heartbeatRuns.resultJson} ->> 'classificationSource'`,
      retryNotBefore: sql<string | null>`${heartbeatRuns.resultJson} ->> 'retryNotBefore'`,
      retryNotBeforeSource: sql<string | null>`${heartbeatRuns.resultJson} ->> 'retryNotBeforeSource'`,
      providerQuotaRetryNotBefore: sql<string | null>`${heartbeatRuns.resultJson} ->> 'providerQuotaRetryNotBefore'`,
      apiErrorStatus: sql<string | null>`coalesce(${heartbeatRuns.resultJson} ->> 'api_error_status', ${heartbeatRuns.resultJson} ->> 'error_status')`,
    })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId));
  if (!row) return null;
  const family = nonEmptyString(explicit?.errorFamily)
    ?? nonEmptyString(row.errorFamily)
    ?? (row.errorCode === "provider_quota" ? "provider_quota" : null);
  const storedSource = row.classificationSource === "terminal" || row.classificationSource === "transcript" ? row.classificationSource : null;
  const typed = family === "provider_quota" || isAiAuthenticationFailure(row.errorCode);
  const source = (explicit?.classificationSource !== undefined ? explicit.classificationSource : storedSource) ?? (typed ? "terminal" : null);
  let typedReset: Date | null;
  if (explicit && explicit.retryNotBeforeSource !== undefined) {
    typedReset = explicit.retryNotBeforeSource === "provider_terminal" ? toDate(explicit.retryNotBefore) : null;
  } else if (row.retryNotBeforeSource === "provider_terminal") {
    typedReset = toDate(row.retryNotBefore);
  } else {
    // claude-local writes this only for a provider_quota reset read from the CLI's own output.
    typedReset = toDate(row.providerQuotaRetryNotBefore);
  }
  const status = Number(row.apiErrorStatus);
  return {
    errorCode: row.errorCode,
    error: nonEmptyString(row.error),
    terminalText: [row.error, row.stderrExcerpt].filter(Boolean).join("\n"),
    family,
    source,
    typedReset,
    apiErrorStatus: Number.isInteger(status) && status > 0 ? status : null,
  };
}

/**
 * When a usage limit or a credit balance resets (spec 4.6 step 2): a typed
 * provider reset in the future, clamped to 7 d + 1 h (24 h for credit) and
 * then `estimated`; otherwise null, meaning the strike-based estimate (credit:
 * 24 h).
 */
export function typedLimitUntil(input: { now: Date; typedReset: Date | null; creditBalance: boolean }):
  { until: Date; source: AiAccountLimitSource } | null {
  const { now, typedReset } = input;
  if (!typedReset || typedReset.getTime() <= now.getTime()) return null;
  const maxAhead = input.creditBalance ? HEARTBEAT_AI_ACCOUNT_LIMITS.creditBalanceMs : HEARTBEAT_AI_ACCOUNT_LIMITS.typedResetMaxAheadMs;
  const cap = now.getTime() + maxAhead;
  return typedReset.getTime() > cap
    ? { until: new Date(cap), source: "estimated" }
    : { until: typedReset, source: "provider" };
}

/** The estimated rest after `strikes` earlier hits of one limit: 1 h × 2^strikes, at most 12 h. */
export function estimatedLimitMs(strikes: number): number {
  const exponent = Math.min(Math.max(0, Math.floor(strikes)), 20);
  return Math.min(HEARTBEAT_AI_ACCOUNT_LIMITS.estimateBaseMs * 2 ** exponent, HEARTBEAT_AI_ACCOUNT_LIMITS.estimateMaxMs);
}

// ---------------------------------------------------------------------------
// How a run ended (the success hook)
// ---------------------------------------------------------------------------

/** What the success hook needs of a finished run, read from its row. */
export interface RunEndFacts {
  status: string;
  errorCode: string | null;
  errorFamily: string | null;
  /** The run itself consumed tokens or cost (heartbeat's per-run `usageJson` counts). */
  providerServed: boolean;
}

function consumedUsage(usage: unknown): boolean {
  const record = asRecord(usage);
  return ["inputTokens", "cachedInputTokens", "outputTokens", "costUsd"].some((key) => {
    const value = record[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0;
  });
}

/**
 * Whether a finished run ended without a limit or a sign-in failure after the
 * provider served it (spec 4.6, "Success"): it succeeded, or it failed or
 * timed out for another reason after consuming tokens. A cancelled or
 * interrupted run (a wait's deferral, a stop), a limit, a sign-in failure, a
 * resource-wait code, and a failure before the provider served anything (a
 * workspace, spawn or configuration error, an unreachable provider) say
 * nothing about the account.
 */
export function endedWithoutAccountFailure(end: RunEndFacts): boolean {
  if (end.status === "succeeded") return true;
  if (end.status !== "failed" && end.status !== "timed_out") return false;
  if (end.errorFamily === "provider_quota" || end.errorCode === "provider_quota") return false;
  if (isAiAuthenticationFailure(end.errorCode) || isResourceWaitErrorCode(end.errorCode)) return false;
  return end.providerServed;
}

/**
 * Reads a finished run's end from its row (a caller may hold a projected row
 * without `usageJson` or `resultJson`), with its stored `aiConnection`.
 */
async function readRunEnd(db: Db, runId: string): Promise<{ end: RunEndFacts; aiConnection: unknown } | null> {
  const [row] = await db
    .select({
      status: heartbeatRuns.status,
      errorCode: heartbeatRuns.errorCode,
      errorFamily: sql<string | null>`${heartbeatRuns.resultJson} ->> 'errorFamily'`,
      usageJson: heartbeatRuns.usageJson,
      aiConnection: sql<unknown>`${heartbeatRuns.contextSnapshot} -> 'aiConnection'`,
    })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId));
  if (!row) return null;
  return {
    end: {
      status: row.status,
      errorCode: row.errorCode,
      errorFamily: nonEmptyString(row.errorFamily),
      providerServed: consumedUsage(row.usageJson),
    },
    aiConnection: row.aiConnection,
  };
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/** Options for heartbeat's `scheduleBoundedRetryForRun` (company-pool waits). */
export interface CompanyPoolRetryOptions {
  now: Date;
  retryReason: string;
  wakeReason: string;
  maxAttempts: number;
  delayMs: number;
}

/** Heartbeat closures (W8). */
export interface HeartbeatAiAccountsDeps {
  appendRunEvent(
    run: HeartbeatRunRow,
    event: {
      eventType: string;
      stream?: "system" | "stdout" | "stderr";
      level?: "info" | "warn" | "error";
      message?: string;
      payload?: Record<string, unknown>;
    },
  ): Promise<void>;
  /** Used only for the company-pool wait; pool waits go through `resourceWaits.scheduleResourceWait`. */
  scheduleBoundedRetryForRun(
    run: HeartbeatRunRow,
    agent: AgentRow,
    opts: CompanyPoolRetryOptions,
  ): Promise<ResourceWaitScheduleOutcome>;
}

export interface CreateHeartbeatAiAccountsOptions {
  db: Db;
  resourceWaits: Pick<ResourceWaits, "scheduleResourceWait" | "noteRunPassed" | "noteRunRefused" | "wakeResourceWaits">;
  deps: HeartbeatAiAccountsDeps;
  /** In `local_trusted` the local board user is a member of every company. Defaults to the server's mode. */
  deploymentMode?: DeploymentMode;
  now?: () => Date;
  /** Decrypts stored credential material; defaults to the local encrypted provider. */
  decryptCredential?: (material: Record<string, unknown>) => Promise<string>;
}

export interface AcquireInput {
  run: Pick<HeartbeatRunRow, "id" | "companyId" | "agentId">;
  plan: CredentialPlanUse;
  now?: Date;
}

/** How a pool run's failure was handled. */
export interface PoolFailureOutcome {
  /** A waiting successor owns the task: no transient retry and no provider-quota monitor. */
  handled: boolean;
  /** The wait's reason, or why the failure was left to the normal path. */
  reason: string;
  accountId: string | null;
  episodeId: string | null;
  successorRunId: string | null;
}

export interface RunLimitOutcome extends PoolFailureOutcome {
  until: Date | null;
  limitSource: AiAccountLimitSource | null;
  strikes: number | null;
}

export interface CompanyPoolLimitOutcome {
  handled: boolean;
  reason: string;
  connectionId: string | null;
  until: Date | null;
  successorRunId: string | null;
}

export interface AccountRunSucceededOutcome {
  /** Strikes, a passed limit, a sign-in suspicion or a probe claim were cleared. */
  cleared: boolean;
  /** Waiting runs made due. */
  woken: number;
  /** The run's wait episode (a limit probe's) ended. */
  episodeResolved: boolean;
}

interface FailureInput {
  /** The finished run (status `failed`). */
  run: HeartbeatRunRow;
  agent: AgentRow;
  /** The adapter result's fields; the rest is read from the run row. */
  provenance?: RunFailureProvenance | null;
  /** The run's environment; defaults to `contextSnapshot.paperclipEnvironment`. */
  environment?: { id: string; name: string } | null;
  now?: Date;
}

function notHandled(reason: string, accountId: string | null = null): PoolFailureOutcome {
  return { handled: false, reason, accountId, episodeId: null, successorRunId: null };
}

function environmentRefOfRun(run: Pick<HeartbeatRunRow, "contextSnapshot">): { id: string; name: string } | null {
  const environment = asRecord(asRecord(run.contextSnapshot).paperclipEnvironment);
  const id = nonEmptyString(environment.id);
  return id ? { id, name: nonEmptyString(environment.name) ?? id } : null;
}

export function createHeartbeatAiAccounts(options: CreateHeartbeatAiAccountsOptions) {
  const { db, resourceWaits, deps } = options;
  const clock = options.now ?? (() => new Date());
  const deploymentMode = options.deploymentMode ?? configuredDeploymentMode();
  const decrypt = options.decryptCredential
    ?? ((material: Record<string, unknown>) =>
      localEncryptedProvider.resolveVersion({ material: material as StoredSecretVersionMaterial, externalRef: null }));

  async function refuse(run: Pick<HeartbeatRunRow, "id" | "companyId">, refusal: ConfigurationRefusal): Promise<never> {
    await resourceWaits.noteRunRefused(run).catch((error) => {
      logger.warn({ err: error, runId: run.id }, "failed to end a resource wait episode for a refused run");
    });
    throw refusal;
  }

  /**
   * Spec 4.2 rows 0–10 for a run that is starting. Returns `{kind:'none'}`
   * when the run takes no pool account, or the account, device and
   * environment to use. Throws a `ResourceWaitDeferral` when the run has to
   * wait (`unassigned`, `owner_not_member`, `reserved_elsewhere`,
   * `withdrawn`, `signed_out`, `device_unknown`,
   * `credential_type_unsupported`, `usage_limit`, `credit_balance`), and a
   * `ConfigurationRefusal` (`ai_connection_changed`) when a resumed persisted
   * native run's account is no longer usable. No row compares the run's
   * responsible user with the owner, and no row checks who owns the device.
   */
  async function planCredential(input: PlanCredentialInput): Promise<CredentialPlan> {
    const evaluation = await evaluateCredentialPlan(db, { ...input, now: input.now ?? clock() }, { dryRun: false, deploymentMode });
    switch (evaluation.outcome) {
      case "none":
        return { kind: "none" };
      case "use":
        return evaluation.plan;
      case "wait":
        throw evaluation.deferral;
      case "refuse":
        return refuse(input.run, evaluation.refusal);
    }
  }

  /**
   * Refuses a pool run (`ai_connection_incompatible`, a `ConfigurationRefusal`)
   * when a routing override would send the credential somewhere other than
   * Anthropic: in the run's env (resolved config and raw layers, read before
   * auth keys are stripped), in authentication arguments, or in the project's
   * `.claude/settings*.json` (helper keys, and routing keys in its `env`
   * block). Call it before `acquire` with the resolved config, and again after
   * the workspace is realized with the realized cwd and target.
   */
  async function assertRoutingCompatible(input: AssertRoutingCompatibleInput): Promise<void> {
    const { run, agent, config } = input;
    const refusal = (message: string, fingerprint: string) => {
      const refused = new ConfigurationRefusal({
        reason: "ai_connection_incompatible",
        message,
        companyId: agent.companyId,
        agentId: agent.id,
      });
      Object.assign(asRecord(refused.resultJson.configurationIncomplete), {
        actionUrl: `/agents/${agent.id}/runtime`,
        fingerprint: `ai-pool-incompatible:${agent.id}:${fingerprint}`,
      });
      return refused;
    };
    if (input.checkEnv !== false) {
      const overrides = findRoutingOverrides([config.env, ...(input.envLayers ?? [])]);
      if (overrides.length > 0) {
        await refuse(run, refusal(
          `${overrides.join(", ")} ${overrides.length === 1 ? "is" : "are"} set for ${agent.name}, so its Claude account cannot serve this run. Remove the provider routing override.`,
          "env",
        ));
      }
    }
    if (input.checkProjectSettings === false) return;
    const target = input.target ?? null;
    try {
      await assertManagedAiProjectAuth(config, "anthropic", target);
    } catch {
      await refuse(run, refusal(`Project or argument authentication conflicts with ${agent.name}'s Claude account.`, "auth"));
    }
    let conflicts: string[];
    try {
      conflicts = target?.kind === "remote"
        ? (await remoteProjectSettingsConflict(run.id, target) ? ["a provider routing or credential key"] : [])
        : await localProjectSettingsConflicts(typeof config.cwd === "string" ? config.cwd : process.cwd(), {
          skipUserSettings: input.targetIsRemote ?? false,
        });
    } catch (error) {
      logger.warn({ err: error, runId: run.id }, "could not check the project's Claude settings for a pool run");
      return refuse(run, refusal(
        `The project's Claude settings could not be checked before using ${agent.name}'s Claude account.`,
        "settings_unchecked",
      ));
    }
    if (conflicts.length > 0) {
      await refuse(run, refusal(
        `The project's Claude settings set ${conflicts.join(", ")}, so ${agent.name}'s Claude account cannot serve this run. Remove ${conflicts.length === 1 ? "it" : "them"} from .claude/settings.json.`,
        "settings",
      ));
    }
  }

  /**
   * Spec 4.3, one transaction: locks the device row, re-checks the account
   * (rows 1–9; any change throws the matching wait), counts the distinct pool
   * accounts running on the device (run slots of running runs, plus legacy
   * host-pool runs for one release), throws a `device_slots` / `slots_full`
   * wait when a new account would exceed `min(max_accounts, 3)`, then records
   * the run slot, `last_selected_at` / `last_used_at` and the attribution
   * (`jsonb_set` on `aiConnection` only). The credential is decrypted after
   * commit. A resumed persisted native run is never deferred: it skips the
   * cap and refuses only when its account is no longer usable.
   */
  async function acquire(input: AcquireInput): Promise<AcquiredPoolCredential> {
    const { run, plan } = input;
    const now = input.now ?? clock();
    let committed: { account: AccountRow; attribution: AiPoolAccountRunAttribution; deviceName: string | null };
    try {
      committed = await db.transaction(async (tx) => {
        const device = plan.device ? await lockDevice(tx, plan.device.id) : null;
        const evaluation = await evaluateAccountPlan(asQueryDb(tx), {
          companyId: run.companyId,
          accountId: plan.accountId,
          environment: !plan.persisted && plan.environment ? asRunEnvironment(plan.environment) : null,
          now,
          deploymentMode,
          ...(!plan.persisted && plan.environment ? { device } : {}),
        });
        const account = evaluation.account;
        const accountLabel = account && evaluation.ownerIsMember ? account.label : null;
        if (plan.persisted) {
          if (!account || (evaluation.reason !== null && !isLimitReason(evaluation.reason))) {
            throw accountChangedRefusal({ companyId: run.companyId, agentId: run.agentId, accountLabel });
          }
        } else {
          const reason = !plan.environment && (evaluation.reason === null || isLimitReason(evaluation.reason))
            ? "device_unknown"
            : evaluation.reason ?? (device || !plan.device ? null : "device_unknown");
          if (reason !== null || !account) {
            const waitReason = reason ?? "unassigned";
            throw accountWaitDeferral({
              reason: waitReason,
              accountId: account?.id ?? plan.accountId,
              accountLabel,
              environment: namedRef(plan.environment),
              device: namedRef(device ?? plan.device),
              resumeAt: isLimitReason(waitReason) && account?.exhaustedUntil
                ? new Date(account.exhaustedUntil.getTime() + resourceWaitJitterMs(run.id))
                : null,
              resumeAtSource: isLimitReason(waitReason) ? account?.limitSource ?? "estimated" : null,
              epochs: plan.epochs,
            });
          }
        }
        if (device) {
          if (!plan.persisted) {
            const running = await runningPoolAccountsOnDevice(tx, device.id, run.id);
            if (wouldExceedDeviceCap({ cap: capOf(device), inUse: running, accountId: account.id })) {
              throw deviceSlotsDeferral({
                device: { id: device.id, name: device.name },
                environment: namedRef(plan.environment),
                accountId: account.id,
                accountLabel,
                epochs: plan.epochs,
              });
            }
          }
          await insertRunSlot(tx, { runId: run.id, companyId: run.companyId, deviceId: device.id, accountId: account.id, acquiredAt: now });
        }
        // Not `updated_at`: it is the account's wake epoch, and a run starting is no change anybody waits for.
        await tx.update(aiAccounts).set({ lastSelectedAt: now, lastUsedAt: now }).where(eq(aiAccounts.id, account.id));
        const attribution: AiPoolAccountRunAttribution = {
          mode: POOL_ACCOUNT_ATTRIBUTION_MODE,
          provider: "anthropic",
          method: account.credentialType,
          accountId: account.id,
          accountName: account.label,
          ownerUserId: effectiveAccountOwner(account),
          hostId: device?.id ?? "",
          hostName: device?.name ?? plan.environment?.name ?? "",
          credentialRef: credentialRefForAccount(account.id),
          runId: run.id,
        };
        await tx
          .update(heartbeatRuns)
          .set({
            contextSnapshot: sql`jsonb_set(coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb), '{aiConnection}', ${JSON.stringify(attribution)}::jsonb, true)`,
          })
          .where(eq(heartbeatRuns.id, run.id));
        return { account, attribution, deviceName: device?.name ?? null };
      });
    } catch (error) {
      if (error instanceof ConfigurationRefusal) return refuse(run, error);
      throw error;
    }
    // Decrypted only after commit; the value goes nowhere but the run environment.
    const value = await decrypt(committed.account.credentialMaterial);
    const credential = {
      attribution: committed.attribution,
      envKey: AI_ACCOUNT_ENV_KEY[committed.account.credentialType],
      credentialRef: committed.attribution.credentialRef,
      accountLabel: committed.account.label,
      deviceName: committed.deviceName,
    } as AcquiredPoolCredential;
    Object.defineProperty(credential, "value", { value, enumerable: false });
    return credential;
  }

  /**
   * `injectPoolCredential` plus the run event "Using Claude account <label>
   * (subscription | API key) on <device>". Call it right after `acquire`, so
   * the in-memory context carries the attribution before anything writes the
   * whole context back.
   */
  async function inject(input: {
    run: HeartbeatRunRow;
    config: Record<string, unknown>;
    secretKeys: Set<string>;
    context: Record<string, unknown>;
    credential: AcquiredPoolCredential;
  }): Promise<void> {
    injectPoolCredential(input);
    const { credential } = input;
    const method = credential.attribution.method === "api_key" ? "API key" : "subscription";
    await deps.appendRunEvent(input.run, {
      eventType: "lifecycle",
      stream: "system",
      level: "info",
      message: `Using Claude account "${credential.accountLabel}" (${method}) on ${credential.deviceName ?? "this device"}`,
      payload: {
        accountId: credential.attribution.accountId,
        deviceId: credential.attribution.hostId || null,
        method: credential.attribution.method,
        credentialRef: credential.credentialRef,
      },
    }).catch((error) => {
      logger.warn({ err: error, runId: input.run.id }, "failed to record the Claude account a pool run uses");
    });
  }

  async function labelInCompany(account: AccountRow, companyId: string): Promise<string | null> {
    return await isActiveUserMember(db, companyId, effectiveAccountOwner(account), deploymentMode) ? account.label : null;
  }

  /** Activity in the run's company; `once` gates it through `resource_wait_notices`. */
  async function logAccountActivity(input: {
    run: HeartbeatRunRow;
    agent: AgentRow;
    action: string;
    accountId: string;
    details: Record<string, unknown>;
    onceKey?: string;
    now: Date;
  }): Promise<void> {
    const { run } = input;
    if (input.onceKey && !(await claimResourceWaitNotice(db, run.companyId, input.onceKey, input.now))) return;
    try {
      await logActivity(db, {
        companyId: run.companyId,
        actorType: "system",
        actorId: "heartbeat",
        action: input.action,
        entityType: "ai_account",
        entityId: input.accountId,
        agentId: input.agent.id,
        runId: run.id,
        details: input.details,
      });
    } catch (error) {
      if (input.onceKey) await releaseResourceWaitNotice(db, run.companyId, input.onceKey).catch(() => undefined);
      logger.warn({ err: error, runId: run.id, action: input.action }, "failed to log a Claude account activity entry");
    }
  }

  /** Schedules the successor of a finished run in the account lane (no failover). */
  async function scheduleAccountWait(input: {
    run: HeartbeatRunRow;
    agent: AgentRow;
    reason: AiAccountWaitReason;
    account: Pick<AccountRow, "id" | "exhaustedUntil" | "limitSource">;
    accountLabel: string | null;
    attribution: RunPoolAttribution;
    environment: { id: string; name: string } | null;
    now: Date;
  }): Promise<PoolFailureOutcome> {
    const { run, account, attribution } = input;
    // Read after this handler's own account write, so the guard sees only later changes.
    const epochs = await readWakeEpochs(db, { agentId: run.agentId, accountId: account.id, deviceId: attribution.deviceId });
    const resumeAt = isLimitReason(input.reason) && account.exhaustedUntil
      ? new Date(account.exhaustedUntil.getTime() + resourceWaitJitterMs(run.id))
      : null;
    const deferral = accountWaitDeferral({
      reason: input.reason,
      accountId: account.id,
      accountLabel: input.accountLabel,
      environment: input.environment,
      device: attribution.deviceId ? { id: attribution.deviceId, name: attribution.deviceName ?? attribution.deviceId } : null,
      resumeAt,
      resumeAtSource: resumeAt ? account.limitSource ?? "estimated" : null,
      epochs,
    });
    // The caller's normal finalization releases the issue lock when nothing was scheduled.
    const scheduled = await resourceWaits.scheduleResourceWait({
      run,
      wait: deferral.wait,
      epochs,
      agent: input.agent,
      releaseIfUnscheduled: false,
      now: input.now,
    });
    return {
      handled: scheduled.outcome === "scheduled",
      reason: scheduled.outcome === "scheduled" ? input.reason : scheduled.reason ?? "not_scheduled",
      accountId: account.id,
      episodeId: scheduled.episodeId,
      successorRunId: scheduled.successorRunId,
    };
  }

  /**
   * A pool run ended on a usage limit or an exhausted credit balance (spec
   * 4.6). Only a terminal-sourced `provider_quota` changes the account; a
   * transcript-only match is left to the normal transient lane. The reset:
   * a typed provider reset clamped to 7 d + 1 h (credit: 24 h), else 24 h for
   * credit or 1 h × 2^strikes up to 12 h. A provider value overwrites a stored
   * estimate; between two of the same kind the later one stays. A hit while
   * the limit is in force (another run that was already running) counts no
   * new strike. `ai_account.limit_reached` is logged once per limit episode
   * in the run's company, and an `ai_account_wait` successor waits for the
   * reset plus `jitter(runId)`; a failed probe reuses the open episode.
   */
  async function handleRunLimit(input: FailureInput): Promise<RunLimitOutcome> {
    const { run, agent } = input;
    const empty = { until: null, limitSource: null, strikes: null };
    const attribution = ownPoolAttribution(run);
    if (!attribution) return { ...notHandled("not_pool_run"), ...empty };
    const facts = await readRunFailureFacts(db, run.id, input.provenance);
    if (!facts || facts.family !== "provider_quota") return { ...notHandled("not_a_limit", attribution.accountId), ...empty };
    if (facts.source !== "terminal") return { ...notHandled("transcript_only", attribution.accountId), ...empty };
    const now = input.now ?? clock();
    const nowText = now.toISOString();
    const creditBalance = isCreditBalanceFailure(facts.terminalText);
    const typed = typedLimitUntil({ now, typedReset: facts.typedReset, creditBalance });
    const limits = HEARTBEAT_AI_ACCOUNT_LIMITS;

    const active = sql`(${aiAccounts.exhaustedUntil} is not null and ${aiAccounts.exhaustedUntil} > ${nowText}::timestamptz)`;
    // This limit already counted its strike: the hit came from a run that was already running.
    const counted = sql`(${active} and ${aiAccounts.limitStrikes} > 0)`;
    const exponent = sql`least(greatest(case when ${counted} then ${aiAccounts.limitStrikes} - 1 else ${aiAccounts.limitStrikes} end, 0), 20)`;
    const newUntil = typed
      ? sql`${typed.until.toISOString()}::timestamptz`
      : creditBalance
        ? sql`${nowText}::timestamptz + make_interval(secs => ${limits.creditBalanceMs / 1000}::double precision)`
        : sql`${nowText}::timestamptz + make_interval(secs => least(${limits.estimateMaxMs / 1000}::double precision, ${limits.estimateBaseMs / 1000}::double precision * power(2::double precision, (${exponent})::double precision)))`;
    const source: AiAccountLimitSource = typed?.source ?? "estimated";
    const storedProvider = sql`(${active} and ${aiAccounts.limitSource} = 'provider')`;
    const [updated] = await db
      .update(aiAccounts)
      .set({
        exhaustedUntil: source === "provider"
          ? sql`case when ${storedProvider} then greatest(${aiAccounts.exhaustedUntil}, ${newUntil}) else ${newUntil} end`
          : sql`case when not ${active} then ${newUntil} when ${storedProvider} then ${aiAccounts.exhaustedUntil} else greatest(${aiAccounts.exhaustedUntil}, ${newUntil}) end`,
        limitSource: source === "provider"
          ? "provider"
          : sql`case when ${storedProvider} then 'provider' else 'estimated' end`,
        limitStrikes: sql`case when ${counted} then ${aiAccounts.limitStrikes} else ${aiAccounts.limitStrikes} + 1 end`,
        limitEpisodeStartedAt: sql`case when ${aiAccounts.limitStrikes} > 0 and ${aiAccounts.limitEpisodeStartedAt} is not null then ${aiAccounts.limitEpisodeStartedAt} else ${nowText}::timestamptz end`,
        limitProbeRunId: null,
        limitReason: creditBalance ? "credit_balance" : "provider_quota",
        limitRunId: run.id,
        lastLimitedAt: now,
        updatedAt: now,
      })
      .where(eq(aiAccounts.id, attribution.accountId))
      .returning();
    if (!updated) return { ...notHandled("account_missing", attribution.accountId), ...empty };
    const reason = creditBalance ? "credit_balance" : "usage_limit";
    const accountLabel = await labelInCompany(updated, run.companyId);
    await logAccountActivity({
      run,
      agent,
      action: "ai_account.limit_reached",
      accountId: updated.id,
      onceKey: `activity:ai_account.limit_reached:${updated.id}:${(updated.limitEpisodeStartedAt ?? now).toISOString()}`,
      now,
      details: {
        account: accountLabel,
        device: attribution.deviceName,
        reason: creditBalance ? "credit_balance" : "provider_quota",
        exhaustedUntil: updated.exhaustedUntil?.toISOString() ?? null,
        limitSource: updated.limitSource,
        strikes: updated.limitStrikes,
      },
    });
    const outcome = await scheduleAccountWait({
      run,
      agent,
      reason,
      account: updated,
      accountLabel,
      attribution,
      environment: input.environment ?? environmentRefOfRun(run),
      now,
    });
    return { ...outcome, until: updated.exhaustedUntil, limitSource: updated.limitSource, strikes: updated.limitStrikes };
  }

  /**
   * A pool run that ended on a sign-in failure (spec 4.6, two-strike rule). A
   * terminal typed 401 or 403 (`api_error_status`), or a second sign-in
   * failure on another run within 2 h of the first, marks the account signed
   * out and waits `signed_out` with an immediate notice. The first untyped one
   * only records the suspicion and waits `auth_unconfirmed` (10 min) for this
   * run; the account is unchanged. A transcript-only match is left to the
   * normal path.
   */
  async function handleRunAuthFailure(input: FailureInput): Promise<PoolFailureOutcome> {
    const { run, agent } = input;
    const attribution = ownPoolAttribution(run);
    if (!attribution) return notHandled("not_pool_run");
    const facts = await readRunFailureFacts(db, run.id, input.provenance);
    if (!facts || !isAiAuthenticationFailure(facts.errorCode)) return notHandled("not_an_auth_failure", attribution.accountId);
    if (facts.source !== "terminal") return notHandled("transcript_only", attribution.accountId);
    const now = input.now ?? clock();
    const nowText = now.toISOString();
    const typed = facts.apiErrorStatus === 401 || facts.apiErrorStatus === 403;
    const message = (facts.error ?? "Claude sign-in failed").slice(0, ACCOUNT_STATUS_MESSAGE_MAX_LENGTH);
    const windowStart = new Date(now.getTime() - HEARTBEAT_AI_ACCOUNT_LIMITS.authStrikeWindowMs).toISOString();
    // One statement, so two runs failing together see each other's strike.
    const signsOut = typed
      ? sql`true`
      : sql`(${aiAccounts.authSuspectAt} is not null and ${aiAccounts.authSuspectAt} >= ${windowStart}::timestamptz and ${aiAccounts.authSuspectRunId} is distinct from ${run.id}::uuid)`;
    const [updated] = await db
      .update(aiAccounts)
      .set({
        status: sql`case when ${signsOut} then 'auth_failed' else ${aiAccounts.status} end`,
        statusMessage: sql`case when ${signsOut} then ${message} else ${aiAccounts.statusMessage} end`,
        authSuspectAt: sql`case when ${signsOut} then null else ${nowText}::timestamptz end`,
        authSuspectRunId: sql`case when ${signsOut} then null else ${run.id}::uuid end`,
        // A suspicion is no state change anybody waits for; signing out is.
        updatedAt: sql`case when ${signsOut} then ${nowText}::timestamptz else ${aiAccounts.updatedAt} end`,
      })
      .where(and(eq(aiAccounts.id, attribution.accountId), eq(aiAccounts.status, "active")))
      .returning();
    let reason: AiAccountWaitReason;
    let account: AccountRow | null = updated ?? null;
    if (updated?.status === "auth_failed") {
      reason = "signed_out";
      await logAccountActivity({
        run,
        agent,
        action: "ai_account.signed_out",
        accountId: updated.id,
        now,
        details: {
          account: await labelInCompany(updated, run.companyId),
          device: attribution.deviceName,
          reason: typed ? "provider_rejected_credential" : "repeated_sign_in_failure",
        },
      });
    } else if (updated) {
      reason = "auth_unconfirmed";
    } else {
      // Already signed out, withdrawn or gone: wait for whatever the account needs now.
      const evaluation = await evaluateAccountPlan(db, {
        companyId: run.companyId,
        accountId: attribution.accountId,
        environment: null,
        now,
        deploymentMode,
      });
      account = evaluation.account;
      reason = evaluation.reason ?? "auth_unconfirmed";
    }
    const accountLabel = account ? await labelInCompany(account, run.companyId) : null;
    return scheduleAccountWait({
      run,
      agent,
      reason,
      account: account ?? { id: attribution.accountId, exhaustedUntil: null, limitSource: null },
      accountLabel,
      attribution,
      environment: input.environment ?? environmentRefOfRun(run),
      now,
    });
  }

  /**
   * A legacy `company_pool` run hit its member's limit (spec 4.6, 15.5): the
   * member is marked exhausted and logged as before, and an
   * `ai_connection_pool_wait` successor waits for that member's reset plus
   * `jitter(runId)`. Nothing moves the task to another member, and the
   * provider-quota monitor is not used. Returns `handled: false` when no
   * successor could be scheduled (for example a user-continued turn, whose
   * authorization this lane cannot renew), so the normal path stays in charge.
   */
  async function handleCompanyPoolLimit(input: FailureInput): Promise<CompanyPoolLimitOutcome> {
    const { run, agent } = input;
    const attribution = asRecord(asRecord(run.contextSnapshot).aiConnection);
    const connectionId = nonEmptyString(attribution.connectionId);
    const provider = aiProviderSchema.safeParse(attribution.provider);
    const empty = { connectionId, until: null, successorRunId: null };
    if (attribution.mode !== "company_pool" || !connectionId || !provider.success) return { handled: false, reason: "not_company_pool_run", ...empty };
    const facts = await readRunFailureFacts(db, run.id, input.provenance);
    if (!facts || facts.family !== "provider_quota") return { handled: false, reason: "not_a_limit", ...empty };
    if (facts.source !== "terminal") return { handled: false, reason: "transcript_only", ...empty };
    const now = input.now ?? clock();
    const typed = typedLimitUntil({ now, typedReset: facts.typedReset, creditBalance: false });
    const until = typed?.until ?? new Date(now.getTime() + AI_CONNECTION_POOL_DEFAULT_COOLDOWN_MS);
    await aiConnectionPoolService(db).markExhausted({
      companyId: run.companyId,
      connectionId,
      until,
      reason: "provider_quota",
      source: "run_failure",
      runId: run.id,
    });
    await logActivity(db, {
      companyId: run.companyId,
      actorType: "system",
      actorId: "heartbeat",
      action: "ai_connection.pool_limit_reached",
      entityType: "tool_connection",
      entityId: connectionId,
      agentId: agent.id,
      runId: run.id,
      details: { provider: provider.data, exhaustedUntil: until.toISOString(), poolPriority: attribution.poolPriority ?? null },
    }).catch((error) => {
      logger.warn({ err: error, runId: run.id }, "failed to log a company AI account limit");
    });
    // The stored reset wins when it is later (markExhausted keeps the greater one).
    const [state] = await db
      .select({ exhaustedUntil: aiConnectionQuotaStates.exhaustedUntil })
      .from(aiConnectionQuotaStates)
      .where(and(eq(aiConnectionQuotaStates.companyId, run.companyId), eq(aiConnectionQuotaStates.connectionId, connectionId)));
    const memberUntil = state?.exhaustedUntil && state.exhaustedUntil.getTime() > until.getTime() ? state.exhaustedUntil : until;
    let outcome: ResourceWaitScheduleOutcome;
    try {
      outcome = await deps.scheduleBoundedRetryForRun(run, agent, {
        now,
        retryReason: AI_CONNECTION_POOL_WAIT_RETRY_REASON,
        wakeReason: "ai_connection_pool_retry",
        maxAttempts: executionRetryAttemptCount(run, AI_CONNECTION_POOL_WAIT_RETRY_REASON) + 1,
        delayMs: Math.max(1_000, memberUntil.getTime() - now.getTime() + resourceWaitJitterMs(run.id)),
      });
    } catch (error) {
      logger.error({ err: error, runId: run.id }, "failed to schedule the company AI account wait");
      return { handled: false, reason: "schedule_failed", connectionId, until: memberUntil, successorRunId: null };
    }
    const scheduled = outcome.outcome === "scheduled";
    await deps.appendRunEvent(run, {
      eventType: "lifecycle",
      stream: "system",
      level: "info",
      message: scheduled
        ? `This company AI account reached its usage limit until ${memberUntil.toISOString()}. Paperclip never moves a task to another account; this task resumes after the reset.`
        : "This company AI account reached its usage limit; no waiting run could be scheduled.",
      payload: { connectionId, exhaustedUntil: memberUntil.toISOString(), retryOutcome: outcome.outcome },
    }).catch(() => undefined);
    return {
      handled: scheduled,
      reason: scheduled ? "usage_limit" : outcome.outcome === "not_scheduled" ? outcome.reason : outcome.outcome,
      connectionId,
      until: memberUntil,
      successorRunId: outcome.outcome === "scheduled" ? outcome.run.id : null,
    };
  }

  /**
   * The provider-quota dispatcher (hook H9): a pool or legacy host-pool
   * attribution goes to `handleRunLimit`, a `company_pool` one to
   * `handleCompanyPoolLimit`. Anything else is not handled.
   */
  async function handleProviderLimit(input: FailureInput): Promise<{ handled: boolean; reason: string; via: "pool_account" | "company_pool" | null }> {
    if (ownPoolAttribution(input.run)) {
      const outcome = await handleRunLimit(input);
      return { handled: outcome.handled, reason: outcome.reason, via: "pool_account" };
    }
    if (asRecord(asRecord(input.run.contextSnapshot).aiConnection).mode === "company_pool") {
      const outcome = await handleCompanyPoolLimit(input);
      return { handled: outcome.handled, reason: outcome.reason, via: "company_pool" };
    }
    return { handled: false, reason: "not_pool_run", via: null };
  }

  /**
   * A run ended without a limit or a sign-in failure after the provider
   * served it (hook H14, spec 4.6 "Success"): it succeeded, or it failed or
   * timed out for another reason after consuming tokens
   * (`endedWithoutAccountFailure`, read from the run row). When the run's
   * own attribution names a pool account, that account's strikes, sign-in
   * suspicion, limit episode and probe claim are cleared, a reset that has
   * passed is forgotten (a typed reset still ahead stays), and the account's
   * waiting runs are woken, staggered by up to 120 s. Then the run's own wait
   * episode, a limit probe's, ends with "Resumed" and its resolved notice;
   * that also holds for a lane run that no longer carries a pool attribution
   * (rebound while it waited). Any other end (cancelled, a limit, a sign-in
   * failure, a failure before the provider served the run) changes nothing,
   * so the account stays under the single probe. Pass the finished run row.
   */
  async function noteAccountRunSucceeded(input: { run: HeartbeatRunRow; now?: Date }): Promise<AccountRunSucceededOutcome> {
    const { run } = input;
    const result: AccountRunSucceededOutcome = { cleared: false, woken: 0, episodeResolved: false };
    const stored = await readRunEnd(db, run.id);
    if (!stored || !endedWithoutAccountFailure(stored.end)) return result;
    const attribution = ownPoolAttribution({ id: run.id, contextSnapshot: { aiConnection: stored.aiConnection } });
    if (attribution) {
      const now = input.now ?? clock();
      const nowText = now.toISOString();
      const passed = sql`(${aiAccounts.exhaustedUntil} is not null and ${aiAccounts.exhaustedUntil} <= ${nowText}::timestamptz)`;
      const cleared = await db
        .update(aiAccounts)
        .set({
          limitStrikes: 0,
          authSuspectAt: null,
          authSuspectRunId: null,
          limitEpisodeStartedAt: null,
          limitProbeRunId: null,
          exhaustedUntil: sql`case when ${passed} then null else ${aiAccounts.exhaustedUntil} end`,
          limitSource: sql`case when ${passed} then null else ${aiAccounts.limitSource} end`,
          updatedAt: now,
        })
        .where(and(
          eq(aiAccounts.id, attribution.accountId),
          sql`(${aiAccounts.limitStrikes} > 0 or ${aiAccounts.authSuspectAt} is not null or ${aiAccounts.limitEpisodeStartedAt} is not null
            or ${aiAccounts.limitProbeRunId} is not null or ${passed})`,
        ))
        .returning({ id: aiAccounts.id });
      if (cleared.length > 0) {
        result.cleared = true;
        const woken = await resourceWaits.wakeResourceWaits(
          { accountIds: [attribution.accountId] },
          { now, jitterMs: RESOURCE_WAIT_TIMINGS.limitJitterMaxMs },
        );
        result.woken = woken.runIds.length;
      }
    }
    const passedWait = await resourceWaits.noteRunPassed({ run, step: "succeeded" });
    result.episodeResolved = passedWait.resolved;
    return result;
  }

  return {
    readBinding: (input: Parameters<typeof readBinding>[1]) => readBinding(db, input),
    planCredential,
    assertRoutingCompatible,
    acquire,
    inject,
    dropStaleAttribution: (input: Parameters<typeof dropStaleAttribution>[1]) => dropStaleAttribution(db, input),
    handleProviderLimit,
    handleRunLimit,
    handleCompanyPoolLimit,
    handleRunAuthFailure,
    noteAccountRunSucceeded,
  };
}

export type HeartbeatAiAccounts = ReturnType<typeof createHeartbeatAiAccounts>;
