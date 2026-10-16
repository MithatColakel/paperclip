import { z } from "zod";
import {
  AI_ACCOUNT_CREDENTIAL_TYPES,
  MAX_AI_ACCOUNTS_PER_HOST,
  type AiAccountCredentialType,
  type AiAccountHostKind,
  type AiAccountLimitReason,
  type AiAccountProjectSummary,
  type AiAccountStatus,
  type AiAccountUsage,
} from "./ai-account-hosts.js";
import type { ResourceWaitKind, ResourceWaitReason, ScheduledRetryResourceWait } from "./resource-waits.js";

/**
 * Fork: user-owned Claude account pool. Each pool account belongs to one user
 * (its owner) and is usable only in companies where the owner is an active
 * member. An agent is bound to one pool account, or explicitly to its
 * device's own login. Execution devices (the Paperclip server, SSH hosts and
 * devices an environment driver plugin registers) take at most
 * `DEVICE_POOL_ACCOUNT_LIMIT` distinct pool accounts.
 *
 * Product rule: Paperclip never moves a task to another account. When an
 * account hits its limit, its tasks wait for the reset.
 *
 * Browser-safe: no Node-only code. Responses never carry credential values.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** `pool_account`: a pool account (or none yet, which waits); `device_login`: the device's own login. */
export const AI_ACCOUNT_BINDING_MODES = ["pool_account", "device_login"] as const;
export type AiAccountBindingMode = (typeof AI_ACCOUNT_BINDING_MODES)[number];

export const AI_ACCOUNT_BINDING_SOURCES = ["manual", "migrated_host_pool", "migrated_company_pool"] as const;
export type AiAccountBindingSource = (typeof AI_ACCOUNT_BINDING_SOURCES)[number];

/** `legacy_host_pool`: added under the per-host pool before accounts had owners. */
export const AI_ACCOUNT_ORIGINS = ["pool", "legacy_host_pool"] as const;
export type AiAccountOrigin = (typeof AI_ACCOUNT_ORIGINS)[number];

/** Where `exhaustedUntil` came from: a typed provider reset, or an estimate. */
export const AI_ACCOUNT_LIMIT_SOURCES = ["provider", "estimated"] as const;
export type AiAccountLimitSource = (typeof AI_ACCOUNT_LIMIT_SOURCES)[number];

/** At most this many distinct pool accounts per execution device, at binding time and at run time. */
export const DEVICE_POOL_ACCOUNT_LIMIT = MAX_AI_ACCOUNTS_PER_HOST;

/**
 * Non-secret marker in a pool run's environment: "Paperclip supplied this
 * run's AI credential". The value is the account's credential reference, 16
 * lowercase hex characters. Drivers and adapters use it to keep a separate
 * credential slot and config directory per account.
 */
export const AI_CREDENTIAL_REF_ENV_KEY = "PAPERCLIP_AI_CREDENTIAL_REF";
export const AI_CREDENTIAL_REF_PATTERN = /^[a-f0-9]{16}$/;

/** Credential variables a pool run blanks before it sets the one its account uses. */
export const POOL_RUN_AUTH_ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

/**
 * Credential carriers a pool run deletes from its environment. They are
 * deleted, never blanked: an empty `CLAUDE_SECURESTORAGE_CONFIG_DIR` selects
 * the device owner's own stored login.
 */
export const POOL_RUN_REMOVED_ENV_KEYS = [
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
  "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_HOST_CREDS_FILE",
  "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "ANTHROPIC_UNIX_SOCKET",
] as const;

/** The provider routing keys the per-host pool already refused. */
export const POOL_RUN_LEGACY_ROUTING_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

/**
 * One rule for a routing override. `prefix_and_suffix` checks the prefix and
 * the suffix independently, so `ANTHROPIC_BASE_URL` matches
 * `ANTHROPIC_` + `_BASE_URL`. Only `exact_any_case` ignores case.
 */
export type PoolRunEnvMatcher =
  | { kind: "exact"; key: string }
  | { kind: "exact_any_case"; key: string }
  | { kind: "prefix"; prefix: string }
  | { kind: "prefix_and_suffix"; prefix: string; suffix: string };

/**
 * Environment keys that would send a pool credential somewhere other than
 * Anthropic. A pool run whose resolved environment sets any of them is
 * refused (`ai_connection_incompatible`).
 */
export const POOL_RUN_FORBIDDEN_ENV_MATCHERS: readonly PoolRunEnvMatcher[] = [
  { kind: "prefix_and_suffix", prefix: "ANTHROPIC_", suffix: "_BASE_URL" },
  { kind: "prefix_and_suffix", prefix: "CLAUDE_CODE_", suffix: "_BASE_URL" },
  { kind: "prefix", prefix: "CLAUDE_CODE_USE_" },
  { kind: "exact_any_case", key: "HTTP_PROXY" },
  { kind: "exact_any_case", key: "HTTPS_PROXY" },
  { kind: "exact_any_case", key: "ALL_PROXY" },
  { kind: "exact", key: "NODE_EXTRA_CA_CERTS" },
  { kind: "exact", key: "NODE_TLS_REJECT_UNAUTHORIZED" },
  ...POOL_RUN_LEGACY_ROUTING_ENV_KEYS.map((key): PoolRunEnvMatcher => ({ kind: "exact", key })),
];

/** Claude settings keys that run a helper or export credentials; refused in project settings and stripped from seeded settings. */
export const FORBIDDEN_SETTINGS_KEYS = ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport"] as const;

/** What a pasted credential of each type starts with. */
export const AI_ACCOUNT_CREDENTIAL_PREFIXES: Readonly<Record<AiAccountCredentialType, string>> = {
  subscription: "sk-ant-oat",
  api_key: "sk-ant-api",
};

/** Migration marker of the binding backfill job in `deferred_data_migrations`. */
export const AI_ACCOUNT_BINDING_MIGRATION_KEY = "ai-account-bindings-v1";

// ---------------------------------------------------------------------------
// Matchers and helpers
// ---------------------------------------------------------------------------

function matchesEnvKey(matcher: PoolRunEnvMatcher, key: string): boolean {
  switch (matcher.kind) {
    case "exact":
      return key === matcher.key;
    case "exact_any_case":
      return key.toUpperCase() === matcher.key.toUpperCase();
    case "prefix":
      return key.startsWith(matcher.prefix);
    case "prefix_and_suffix":
      return key.startsWith(matcher.prefix) && key.endsWith(matcher.suffix);
  }
}

/** Whether an environment key is a provider routing override for pool runs. */
export function isPoolRunForbiddenEnvKey(key: string): boolean {
  return POOL_RUN_FORBIDDEN_ENV_MATCHERS.some((matcher) => matchesEnvKey(matcher, key));
}

/** A variable counts as set when it is a non-blank string, or any other non-null value except false. */
function isEnvValueSet(value: unknown): boolean {
  return typeof value === "string" ? value.trim().length > 0 : value != null && value !== false;
}

/** The routing overrides set in an environment map, in key order. */
export function findPoolRunForbiddenEnvKeys(env: Record<string, unknown> | null | undefined): string[] {
  if (!env || typeof env !== "object" || Array.isArray(env)) return [];
  return Object.keys(env).filter((key) => isPoolRunForbiddenEnvKey(key) && isEnvValueSet(env[key]));
}

/**
 * Conflicts in a parsed Claude settings object (`.claude/settings*.json`):
 * forbidden helper keys by name, and routing overrides in its `env` block as
 * `env.<KEY>`.
 */
export function findPoolRunSettingsConflicts(settings: unknown): string[] {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return [];
  const record = settings as Record<string, unknown>;
  const conflicts: string[] = FORBIDDEN_SETTINGS_KEYS.filter((key) => isEnvValueSet(record[key]));
  const env = record.env;
  if (env && typeof env === "object" && !Array.isArray(env)) {
    conflicts.push(...findPoolRunForbiddenEnvKeys(env as Record<string, unknown>).map((key) => `env.${key}`));
  }
  return conflicts;
}

/** The credential type a pasted value belongs to, from its prefix. */
export function credentialTypeOfValue(value: string): AiAccountCredentialType | null {
  const trimmed = value.trim();
  for (const type of AI_ACCOUNT_CREDENTIAL_TYPES) {
    if (trimmed.startsWith(AI_ACCOUNT_CREDENTIAL_PREFIXES[type])) return type;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Device identity (`ai_account_hosts.external_key`)
// ---------------------------------------------------------------------------

/** The `external_key` of the Paperclip server's device, which the Local environment maps to. */
export const LOCAL_EXECUTION_DEVICE_KEY = "local";

const SSH_DEVICE_PORT_PATTERN = /^[0-9]{1,5}$/;

/** Spaces only, like Postgres `btrim(text)`; tabs and other whitespace stay. */
function trimSpaces(value: string): string {
  return value.replace(/^ +| +$/g, "");
}

/**
 * The `external_key` of an SSH host's device: `ssh:<host>:<port>`, from an SSH
 * environment's `config.host` and `config.port`. It applies migration 0310's
 * backfill rule exactly, so a new SSH environment on a known machine joins
 * that machine's device instead of creating a second one:
 * - the host has its spaces trimmed (as `btrim` does) and is lower-cased
 *   (hostnames are ASCII);
 * - the port is 22 when it is missing, null or blank, and is written without
 *   leading zeros (`'0022'` and `22` both give `22`).
 * Returns null where 0310 sets no key: a host that is not a string or is
 * blank, or a port that is not 1 to 5 digits.
 */
export function sshExecutionDeviceKey(host: unknown, port?: unknown): string | null {
  if (typeof host !== "string") return null;
  const normalizedHost = trimSpaces(host);
  if (normalizedHost.length === 0) return null;
  let portText: string;
  if (port === undefined || port === null) {
    portText = "22";
  } else if (typeof port === "number" || typeof port === "string") {
    portText = trimSpaces(String(port));
    if (portText.length === 0) portText = "22";
  } else {
    return null;
  }
  if (!SSH_DEVICE_PORT_PATTERN.test(portText)) return null;
  return `ssh:${normalizedHost.toLowerCase()}:${Number.parseInt(portText, 10)}`;
}

// ---------------------------------------------------------------------------
// States and reasons
// ---------------------------------------------------------------------------

/**
 * The state badge of an account, in precedence order: an instance admin
 * disabled it, its owner withdrew it, its sign-in failed, it is at a limit,
 * or it is active.
 */
export const AI_ACCOUNT_STATES = ["admin_disabled", "withdrawn", "signed_out", "limited", "active"] as const;
export type AiAccountState = (typeof AI_ACCOUNT_STATES)[number];

export function deriveAiAccountState(
  account: {
    status: AiAccountStatus;
    adminDisabled?: boolean;
    adminDisabledAt?: string | Date | null;
    exhaustedUntil?: string | Date | null;
  },
  now: Date = new Date(),
): AiAccountState {
  if (account.adminDisabled || account.adminDisabledAt) return "admin_disabled";
  if (account.status === "disabled") return "withdrawn";
  if (account.status === "auth_failed") return "signed_out";
  const until = account.exhaustedUntil ? new Date(account.exhaustedUntil).getTime() : Number.NaN;
  if (Number.isFinite(until) && until > now.getTime()) return "limited";
  return "active";
}

/** The wait reasons planCredential can return (its rows 1 to 9), in row order. */
export const AI_ACCOUNT_PLAN_WAIT_REASONS = [
  "unassigned",
  "owner_not_member",
  "reserved_elsewhere",
  "withdrawn",
  "signed_out",
  "device_unknown",
  "credential_type_unsupported",
  "usage_limit",
  "credit_balance",
] as const;
export type AiAccountPlanWaitReason = (typeof AI_ACCOUNT_PLAN_WAIT_REASONS)[number];

/**
 * Why an account cannot be selected for an agent. Covers every planCredential
 * reason, plus the binding-only ones: the agent's adapter takes no pool
 * account, a device would exceed its account limit, or the caller may not
 * bind this account.
 */
export const AI_ACCOUNT_UNSELECTABLE_REASONS = [
  ...AI_ACCOUNT_PLAN_WAIT_REASONS,
  "adapter_unsupported",
  "device_account_limit",
  "not_permitted",
] as const;
export type AiAccountUnselectableReason = (typeof AI_ACCOUNT_UNSELECTABLE_REASONS)[number];

/** A limited account may still be selected, with this warning. */
export const AI_ACCOUNT_SELECTION_WARNINGS = ["usage_limit", "credit_balance"] as const;
export type AiAccountSelectionWarning = (typeof AI_ACCOUNT_SELECTION_WARNINGS)[number];

/** `reason` of a 422 `ai_account_incompatible` from the binding routes. */
export const AI_ACCOUNT_INCOMPATIBLE_REASONS = [
  "adapter_unsupported",
  "device_unknown",
  "credential_type_unsupported",
  "account_signed_out",
  "account_disabled",
] as const;
export type AiAccountIncompatibleReason = (typeof AI_ACCOUNT_INCOMPATIBLE_REASONS)[number];

/** Error `code`s of the account pool, binding and device routes. */
export const AI_ACCOUNT_POOL_ERROR_CODES = [
  "ai_account_duplicate",
  "ai_account_in_use",
  "ai_account_binding_forbidden",
  "ai_account_not_eligible",
  "ai_account_incompatible",
  "device_account_limit",
  "placement_conflict",
  "ai_account_route_moved",
  "resource_still_unavailable",
] as const;
export type AiAccountPoolErrorCode = (typeof AI_ACCOUNT_POOL_ERROR_CODES)[number];

/**
 * An agent's binding as the company sees it.
 * - `unbound`: no binding; the upstream AI connection or the device login applies.
 * - `device_login`: the device's own login, chosen explicitly.
 * - `pool_account`: bound to a pool account available in this company.
 * - `unassigned`: pool mode without an account; runs wait until one is bound.
 * - `account_unavailable`: bound to an account that is no longer available in this company.
 */
export const AI_ACCOUNT_BINDING_STATES = ["unbound", "device_login", "pool_account", "unassigned", "account_unavailable"] as const;
export type AiAccountBindingState = (typeof AI_ACCOUNT_BINDING_STATES)[number];

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

const trimmed = z.string().trim();
const labelSchema = trimmed.min(1).max(80);
const emailHintSchema = trimmed.min(3).max(200).nullable();
const planSchema = trimmed.min(1).max(40).nullable();
const credentialValueSchema = z.string().trim().min(20).max(4000)
  .regex(/^\S+$/, "A credential has no spaces or line breaks");

function credentialPrefixMessage(type: AiAccountCredentialType): string {
  return type === "subscription"
    ? "A subscription token from `claude setup-token` starts with sk-ant-oat"
    : "A Claude Console API key starts with sk-ant-api";
}

/**
 * Add a pool account owned by the caller. Exactly one source: a pasted value,
 * the caller's own saved Claude connection, or the server's environment token
 * (`server_env`, instance admins only; the route enforces that). Imports move
 * the value server-side, so it never travels to the browser.
 */
export const createMyAiAccountSchema = z.object({
  label: labelSchema,
  credentialType: z.enum(AI_ACCOUNT_CREDENTIAL_TYPES),
  value: credentialValueSchema.optional(),
  importFrom: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("ai_connection"), companyId: z.string().guid(), connectionId: z.string().guid() }).strict(),
    z.object({ kind: z.literal("server_env") }).strict(),
  ]).optional(),
  emailHint: emailHintSchema.optional(),
  plan: planSchema.optional(),
}).strict().superRefine((input, ctx) => {
  if ((input.value === undefined) === (input.importFrom === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Give either a value or an import source", path: ["value"] });
  }
  if (input.value !== undefined && !input.value.startsWith(AI_ACCOUNT_CREDENTIAL_PREFIXES[input.credentialType])) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: credentialPrefixMessage(input.credentialType), path: ["value"] });
  }
});
export type CreateMyAiAccount = z.infer<typeof createMyAiAccountSchema>;

/** Owner edits. `status` withdraws (`disabled`) or resumes (`active`) the account. */
export const updateMyAiAccountSchema = z.object({
  label: labelSchema.optional(),
  emailHint: emailHintSchema.optional(),
  plan: planSchema.optional(),
  status: z.enum(["active", "disabled"]).optional(),
  /** Remove the project reservation that limits the account to some companies. */
  clearProjectRestriction: z.literal(true).optional(),
}).strict();
export type UpdateMyAiAccount = z.infer<typeof updateMyAiAccountSchema>;

/** Replace the credential; the route also requires the account's own type. */
export const replaceAiAccountCredentialSchema = z.object({
  value: credentialValueSchema,
}).strict().superRefine((input, ctx) => {
  if (!credentialTypeOfValue(input.value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A credential starts with sk-ant-oat (subscription) or sk-ant-api (API key)",
      path: ["value"],
    });
  }
});
export type ReplaceAiAccountCredential = z.infer<typeof replaceAiAccountCredentialSchema>;

/** Bind an agent to a pool account, or explicitly to its device's own login. */
export const setAgentAiAccountSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("pool_account"), accountId: z.string().guid() }).strict(),
  z.object({ mode: z.literal("device_login") }).strict(),
]);
export type SetAgentAiAccount = z.infer<typeof setAgentAiAccountSchema>;

/** Instance admin controls: disable or re-enable, and transfer to another existing user. */
export const updateInstanceAiAccountSchema = z.object({
  adminDisabled: z.boolean().optional(),
  reason: trimmed.max(300).nullable().optional(),
  ownerUserId: trimmed.min(1).max(200).optional(),
}).strict();
export type UpdateInstanceAiAccount = z.infer<typeof updateInstanceAiAccountSchema>;

export const updateExecutionDeviceSchema = z.object({
  name: trimmed.min(1).max(80).optional(),
  maxAccounts: z.number().int().min(1).max(DEVICE_POOL_ACCOUNT_LIMIT).optional(),
}).strict();
export type UpdateExecutionDevice = z.infer<typeof updateExecutionDeviceSchema>;

/** Link an existing device to a plugin-reported target (one machine reached two ways). */
export const linkDeviceTargetSchema = z.object({
  pluginId: z.string().guid(),
  provider: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/, "A provider key is lowercase letters, digits, dots, hyphens or underscores"),
  targetKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/, "A target key is 1 to 128 letters, digits, dots, colons, underscores or hyphens"),
}).strict();
export type LinkDeviceTarget = z.infer<typeof linkDeviceTargetSchema>;

/** `notifyAfterHours`: null uses the instance default, 0 never notifies. */
export const updateExecutionWaitSettingsSchema = z.object({
  notifyAfterHours: z.number().int().min(0).max(168).nullable().optional(),
  notifyPmOnDeviceWait: z.boolean().optional(),
  notifyPmOnAccountWait: z.boolean().optional(),
}).strict();
export type UpdateExecutionWaitSettings = z.infer<typeof updateExecutionWaitSettingsSchema>;

// ---------------------------------------------------------------------------
// Shared references
// ---------------------------------------------------------------------------

export type ExecutionDeviceKind = AiAccountHostKind;

/** A device owner, for display only. Ownership never gates runs. */
export interface ExecutionDeviceOwner {
  userId: string;
  name: string | null;
  email: string | null;
}

export interface ExecutionDeviceRef {
  id: string;
  name: string;
  kind: ExecutionDeviceKind;
  owner: ExecutionDeviceOwner | null;
}

/** An account owner. `email` is masked for everyone but the owner and instance admins. */
export interface AiAccountOwnerRef {
  userId: string;
  name: string | null;
  email: string | null;
}

/** What a pool run records in `contextSnapshot.aiConnection`. */
export interface AiPoolAccountRunAttribution {
  mode: "pool_account";
  provider: "anthropic";
  method: AiAccountCredentialType;
  accountId: string;
  accountName: string;
  ownerUserId: string | null;
  /** The execution device; the name keeps the existing usage queries working. */
  hostId: string;
  hostName: string;
  credentialRef: string;
  /** The run that acquired the account; a copied attribution never counts as running. */
  runId: string;
}

// ---------------------------------------------------------------------------
// My accounts (`/api/me/ai-accounts`)
// ---------------------------------------------------------------------------

export interface AiAccountUsedByAgent {
  agentId: string;
  agentName: string;
  devices: ExecutionDeviceRef[];
}

export interface AiAccountUsedByCompany {
  companyId: string;
  companyName: string;
  agents: AiAccountUsedByAgent[];
}

export interface MyAiAccount {
  id: string;
  provider: "anthropic";
  credentialType: AiAccountCredentialType;
  label: string;
  emailHint: string | null;
  plan: string | null;
  origin: AiAccountOrigin;
  /** The owner-controlled status. */
  status: AiAccountStatus;
  statusMessage: string | null;
  state: AiAccountState;
  /** Last characters of the credential, for recognition only. */
  credentialHint: string | null;
  adminDisabled: boolean;
  adminDisabledReason: string | null;
  exhaustedUntil: string | null;
  limitReason: AiAccountLimitReason | null;
  limitSource: AiAccountLimitSource | null;
  lastLimitedAt: string | null;
  /** Projects the account is reserved for; it is usable only in their companies until the owner clears this. */
  reservedProjects: AiAccountProjectSummary[];
  /** Bindings in the caller's companies only. */
  usedBy: AiAccountUsedByCompany[];
  /** Number of other companies whose agents use the account. */
  otherCompanies: number;
  usage: AiAccountUsage;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface MyAiAccountsResponse {
  accounts: MyAiAccount[];
}

// ---------------------------------------------------------------------------
// Company accounts and bindings
// ---------------------------------------------------------------------------

/** An account eligible in a company, as one caller sees it. */
export interface CompanyAiAccountOption {
  id: string;
  label: string;
  credentialType: AiAccountCredentialType;
  plan: string | null;
  owner: AiAccountOwnerRef;
  ownedByMe: boolean;
  state: AiAccountState;
  exhaustedUntil: string | null;
  limitSource: AiAccountLimitSource | null;
  /** Whether this caller may bind the account to an agent of this company. */
  canBind: boolean;
  /** This company's agents bound to the account. */
  agents: Array<{ agentId: string; agentName: string }>;
  /** Devices those agents run on. */
  devices: ExecutionDeviceRef[];
  /** Set when the list was requested for one agent. */
  selectable?: boolean;
  reason?: AiAccountUnselectableReason | null;
  warning?: AiAccountSelectionWarning | null;
  /** Already in use on one of that agent's devices, so it takes no new slot there. */
  onAgentDevice?: boolean;
}

export interface CompanyAiAccountsResponse {
  accounts: CompanyAiAccountOption[];
  /** Whether the caller is a company admin, who may bind any eligible account. */
  canBindAny: boolean;
}

export interface AiAccountBindingAccountRef {
  id: string;
  label: string;
  credentialType: AiAccountCredentialType;
  state: AiAccountState;
  ownedByMe: boolean;
  ownerName: string | null;
  exhaustedUntil: string | null;
  limitSource: AiAccountLimitSource | null;
}

export interface AgentAiAccountBindingSummary {
  agentId: string;
  agentName: string;
  companyId: string;
  adapterType: string;
  /** Pool bindings apply to this agent's adapter. */
  supported: boolean;
  state: AiAccountBindingState;
  /** Null when the agent has no binding. */
  mode: AiAccountBindingMode | null;
  /** The bound account, when it is available in this company. */
  account: AiAccountBindingAccountRef | null;
  source: AiAccountBindingSource | null;
  migrationNote: string | null;
  reviewedAt: string | null;
  /** A migrated binding nobody has confirmed yet. */
  needsReview: boolean;
  /** The devices the agent can run on: its pinned environment's device, or every candidate. */
  devices: ExecutionDeviceRef[];
  /** False when the device depends on the project, because the agent has no pinned environment. */
  pinned: boolean;
  /** The binding overrides an AI connection set in the agent's runtime config. */
  overridesAiConnection: boolean;
  /** Whether the caller may change this binding. */
  canChange: boolean;
  updatedAt: string | null;
}

/** `GET /api/agents/:agentId/ai-account`. */
export interface AgentAiAccountBindingDetail extends AgentAiAccountBindingSummary {
  options: CompanyAiAccountOption[];
}

export interface CompanyAiAccountBindingsResponse {
  bindings: AgentAiAccountBindingSummary[];
}

/** `PUT /api/agents/:agentId/ai-account`. A binding applies from the agent's next run. */
export interface SetAgentAiAccountResponse extends AgentAiAccountBindingSummary {
  appliesFrom: "next_run";
  /** Runs that keep their current account until they finish. */
  runningRunIds: string[];
  warnings: AiAccountSelectionWarning[];
}

// ---------------------------------------------------------------------------
// Error details
// ---------------------------------------------------------------------------

/** 409 `device_account_limit`. Accounts of other companies are a count, never labels. */
export interface DeviceAccountLimitErrorDetails {
  code: "device_account_limit";
  deviceId: string;
  deviceName: string;
  limit: number;
  inUse: number;
  /** Labels of the accounts in use there that are available in the caller's company. */
  accounts: string[];
  otherCompaniesAccounts: number;
}

/** 422 `ai_account_incompatible`. */
export interface AiAccountIncompatibleErrorDetails {
  code: "ai_account_incompatible";
  reason: AiAccountIncompatibleReason;
  deviceName?: string | null;
  environmentName?: string | null;
}

/** 409 `ai_account_in_use` from a delete without `release=true`. */
export interface AiAccountInUseErrorDetails {
  code: "ai_account_in_use";
  /** Bindings in the caller's companies. */
  bindings: Array<{ agentId: string; agentName: string; companyId: string; companyName: string }>;
  otherCompanies: number;
}

/** 409 `resource_still_unavailable` from "Check now" on a waiting task. */
export interface ResourceStillUnavailableErrorDetails {
  code: "resource_still_unavailable";
  resourceWait: ScheduledRetryResourceWait | null;
  checkedAt: string;
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

/** A missing registry row means available. `retired` is a refusal: the target was removed. */
export const ENVIRONMENT_AVAILABILITY_STATES = ["available", "unavailable", "retired"] as const;
export type EnvironmentAvailabilityState = (typeof ENVIRONMENT_AVAILABILITY_STATES)[number];

export const ENVIRONMENT_AVAILABILITY_SOURCES = ["lease_error", "probe", "check", "plugin_report"] as const;
export type EnvironmentAvailabilitySource = (typeof ENVIRONMENT_AVAILABILITY_SOURCES)[number];

export interface EnvironmentAvailabilitySummary {
  state: EnvironmentAvailabilityState;
  reason: string | null;
  label: string | null;
  message: string | null;
  unavailableSince: string | null;
  retryAfter: string | null;
  checkedAt: string | null;
  /** Null means any credential type. */
  acceptedCredentialTypes: AiAccountCredentialType[] | null;
}

export interface ExecutionDeviceEnvironmentSummary {
  id: string;
  name: string;
  driver: string;
  companyId: string | null;
  /** True for an explicit instance-admin mapping, false for a derived one. */
  explicit: boolean;
  availability: EnvironmentAvailabilitySummary;
}

export interface ExecutionDeviceAccountRef {
  id: string;
  label: string;
  credentialType: AiAccountCredentialType;
  state: AiAccountState;
}

export interface ExecutionDeviceAgentRef {
  agentId: string;
  agentName: string;
  mode: AiAccountBindingMode | null;
  accountId: string | null;
}

/** A likely duplicate: the same machine reached another way. */
export interface ExecutionDeviceDuplicateHint {
  deviceId: string;
  deviceName: string;
  matchedBy: "alias" | "label";
}

export interface ExecutionDeviceWaitSummary {
  runId: string;
  agentId: string;
  agentName: string;
  issueId: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
  kind: ResourceWaitKind;
  reason: ResourceWaitReason;
  since: string | null;
  resumeAt: string | null;
}

/** A device as one company sees it. */
export interface ExecutionDeviceSummary {
  id: string;
  name: string;
  kind: ExecutionDeviceKind;
  managedByPluginId: string | null;
  managedByPluginName: string | null;
  /** Display only. */
  owner: ExecutionDeviceOwner | null;
  /** The device's account limit, never above `DEVICE_POOL_ACCOUNT_LIMIT`. */
  limit: number;
  /** Distinct pool accounts bound to agents that can run on the device, across companies. */
  inUse: number;
  overLimit: boolean;
  overLimitSince: string | null;
  /** The state the device badge shows. */
  availability: EnvironmentAvailabilitySummary;
  /** Environments that reach the device and are visible to the company. */
  environments: ExecutionDeviceEnvironmentSummary[];
  /** Accounts in use there that are available in this company. */
  accounts: ExecutionDeviceAccountRef[];
  /** Accounts in use there that belong to other companies, as a count. */
  otherCompaniesAccounts: number;
  agents: ExecutionDeviceAgentRef[];
  /** Agents on the device's own login; they never count toward the limit. */
  ownLoginAgents: number;
  acceptedCredentialTypes: AiAccountCredentialType[] | null;
  duplicateHints: ExecutionDeviceDuplicateHint[];
  waitingCount: number;
}

export interface ExecutionDeviceDetail extends ExecutionDeviceSummary {
  /** This company's tasks waiting for the device. */
  waits: ExecutionDeviceWaitSummary[];
}

export interface CompanyExecutionDevicesResponse {
  limitPerDevice: number;
  devices: ExecutionDeviceSummary[];
}

/** `POST /api/companies/:companyId/devices/:deviceId/check-now`. */
export interface ExecutionDeviceCheckNowResponse {
  checkedAt: string;
  device: ExecutionDeviceDetail;
  /** Waiting runs the check woke. */
  woken: number;
}

/** A device in the instance admin view: keys, owner, limit and accounts with labels. */
export interface InstanceExecutionDeviceSummary {
  id: string;
  name: string;
  kind: ExecutionDeviceKind;
  maxAccounts: number;
  limit: number;
  inUse: number;
  overLimit: boolean;
  overLimitSince: string | null;
  /** `local` or `ssh:<host>:<port>`. */
  externalKey: string | null;
  /** `target:<pluginId>:<provider>:<targetKey>`. */
  targetKey: string | null;
  targetProvider: string | null;
  targetMatch: Record<string, string> | null;
  targetReportedAt: string | null;
  managedByPluginId: string | null;
  managedByPluginName: string | null;
  owner: ExecutionDeviceOwner | null;
  aliases: string[];
  servedCompanyIds: string[];
  availability: EnvironmentAvailabilitySummary;
  acceptedCredentialTypes: AiAccountCredentialType[] | null;
  environments: ExecutionDeviceEnvironmentSummary[];
  accounts: Array<ExecutionDeviceAccountRef & { owner: AiAccountOwnerRef | null }>;
  companies: Array<{ companyId: string; companyName: string; agentCount: number }>;
  duplicateHints: ExecutionDeviceDuplicateHint[];
  createdAt: string;
}

export interface InstanceExecutionDevicesResponse {
  limitPerDevice: number;
  devices: InstanceExecutionDeviceSummary[];
}

// ---------------------------------------------------------------------------
// Instance accounts
// ---------------------------------------------------------------------------

export interface InstanceAiAccountSummary {
  id: string;
  provider: "anthropic";
  credentialType: AiAccountCredentialType;
  label: string;
  plan: string | null;
  /** Masked. */
  emailHint: string | null;
  credentialHint: string | null;
  /** Null for a legacy account without an owner. */
  owner: AiAccountOwnerRef | null;
  origin: AiAccountOrigin;
  status: AiAccountStatus;
  statusMessage: string | null;
  state: AiAccountState;
  adminDisabled: boolean;
  adminDisabledAt: string | null;
  adminDisabledReason: string | null;
  exhaustedUntil: string | null;
  limitReason: AiAccountLimitReason | null;
  limitSource: AiAccountLimitSource | null;
  limitStrikes: number;
  lastLimitedAt: string | null;
  /** The per-host pool this account came from, kept as a hint. */
  legacyHostId: string | null;
  legacyHostName: string | null;
  reservedProjects: AiAccountProjectSummary[];
  companies: Array<{ companyId: string; companyName: string; agentCount: number }>;
  usage: AiAccountUsage;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface InstanceAiAccountsResponse {
  accounts: InstanceAiAccountSummary[];
}

// ---------------------------------------------------------------------------
// Wait settings
// ---------------------------------------------------------------------------

export interface ExecutionWaitSettings {
  companyId: string;
  /** Null uses `instanceDefaultHours`; 0 never notifies. */
  notifyAfterHours: number | null;
  notifyPmOnDeviceWait: boolean;
  notifyPmOnAccountWait: boolean;
  instanceDefaultHours: number;
  updatedAt: string | null;
}

// ---------------------------------------------------------------------------
// Binding migration report
// ---------------------------------------------------------------------------

/** Which rule chose a migrated account, in the order they are tried. */
export const AI_ACCOUNT_MIGRATION_RULES = ["reservation", "agent_history", "company_history", "company_pool_fingerprint"] as const;
export type AiAccountMigrationRule = (typeof AI_ACCOUNT_MIGRATION_RULES)[number];

/**
 * `bound`: bound to the chosen account. `unassigned`: pool mode without an
 * account, waiting for review. `unbound`: left without a binding, with a
 * review note.
 */
export const AI_ACCOUNT_MIGRATION_OUTCOMES = ["bound", "unassigned", "unbound"] as const;
export type AiAccountMigrationOutcome = (typeof AI_ACCOUNT_MIGRATION_OUTCOMES)[number];

export const DEFERRED_DATA_MIGRATION_STATUSES = ["pending", "running", "completed", "failed"] as const;
export type DeferredDataMigrationStatus = (typeof DEFERRED_DATA_MIGRATION_STATUSES)[number];

export interface AiAccountMigrationAgentEntry {
  agentId: string;
  agentName: string;
  companyId: string;
  companyName: string;
  outcome: AiAccountMigrationOutcome;
  accountId: string | null;
  accountLabel: string | null;
  rule: AiAccountMigrationRule | null;
  /** Why this account was chosen, or why none could be. */
  note: string | null;
}

export interface AiAccountMigrationDeviceEntry {
  deviceId: string;
  deviceName: string;
  limit: number;
  inUse: number;
}

export interface AiAccountMigrationSummary {
  bound: number;
  unassigned: number;
  unbound: number;
  agents: AiAccountMigrationAgentEntry[];
  overLimitDevices: AiAccountMigrationDeviceEntry[];
}

/** Go/no-go: a recently active agent must plan to `use` its account. */
export interface AiAccountMigrationGoNoGoEntry {
  agentId: string;
  agentName: string;
  companyId: string;
  plan: "use" | "wait" | "refuse";
  reason: string | null;
}

export interface AiAccountMigrationReport {
  key: typeof AI_ACCOUNT_BINDING_MIGRATION_KEY;
  status: DeferredDataMigrationStatus;
  attempts: number;
  lastError: string | null;
  completedAt: string | null;
  summary: AiAccountMigrationSummary | null;
  goNoGo: {
    go: boolean;
    agents: AiAccountMigrationGoNoGoEntry[];
  };
}
