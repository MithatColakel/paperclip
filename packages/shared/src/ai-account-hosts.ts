import { z } from "zod";

/**
 * Fork: Claude credentials per execution host. A host is a machine that runs
 * agents (the Paperclip server, a runner server, later a Mac). Every run on a
 * host draws a credential from that host's pool, balanced across its
 * available accounts, and moves to another account of the same host when one
 * reaches its usage limit.
 */

/** Operator rule: at most this many credentials per host. */
export const MAX_AI_ACCOUNTS_PER_HOST = 3;

/** Without a provider reset time, a usage-limited account rests this long. */
export const AI_ACCOUNT_DEFAULT_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;

/** An API key whose credit balance ran out rests this long before it is tried again. */
export const AI_ACCOUNT_CREDIT_BALANCE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export const AI_ACCOUNT_HOST_KINDS = ["server", "ssh_host", "mac"] as const;
export type AiAccountHostKind = (typeof AI_ACCOUNT_HOST_KINDS)[number];

export const AI_ACCOUNT_CREDENTIAL_TYPES = ["subscription", "api_key"] as const;
export type AiAccountCredentialType = (typeof AI_ACCOUNT_CREDENTIAL_TYPES)[number];

export const AI_ACCOUNT_STATUSES = ["active", "auth_failed", "disabled"] as const;
export type AiAccountStatus = (typeof AI_ACCOUNT_STATUSES)[number];

export const AI_ACCOUNT_LIMIT_REASONS = ["provider_quota", "credit_balance", "manual"] as const;
export type AiAccountLimitReason = (typeof AI_ACCOUNT_LIMIT_REASONS)[number];

/** The env var a credential type is delivered in. */
export const AI_ACCOUNT_ENV_KEY: Record<AiAccountCredentialType, "CLAUDE_CODE_OAUTH_TOKEN" | "ANTHROPIC_API_KEY"> = {
  subscription: "CLAUDE_CODE_OAUTH_TOKEN",
  api_key: "ANTHROPIC_API_KEY",
};

export interface AiAccountProjectSummary {
  id: string;
  name: string;
  companyId: string;
  companyName: string;
  issuePrefix: string;
}

/** What Paperclip runs used on an account in a window (from run cost events). */
export interface AiAccountUsageWindow {
  runs: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costCents: number;
}

/**
 * Paperclip's own use of an account. A setup token cannot read the account's
 * official usage (Anthropic requires a full sign-in for that), and other use
 * of the same account outside Paperclip is not counted.
 */
export interface AiAccountUsage {
  lastFiveHours: AiAccountUsageWindow;
  lastSevenDays: AiAccountUsageWindow;
  /** Calendar month (UTC) so far; for an API key this is the reported spend. */
  thisMonth: AiAccountUsageWindow;
}

export interface AiAccountSummary {
  id: string;
  hostId: string;
  provider: "anthropic";
  credentialType: AiAccountCredentialType;
  label: string;
  emailHint: string | null;
  plan: string | null;
  poolEnabled: boolean;
  status: AiAccountStatus;
  statusMessage: string | null;
  /** Last characters of the credential, for recognition only. */
  credentialHint: string | null;
  exhaustedUntil: string | null;
  limitReason: AiAccountLimitReason | null;
  /** When the account last reached a limit (usage, credit or manual). */
  lastLimitedAt: string | null;
  usage: AiAccountUsage;
  /** Host-pool runs this account serves right now. */
  runningRuns: number;
  /** Projects this account is reserved for; empty means shared by every run on the host. */
  projects: AiAccountProjectSummary[];
  lastSelectedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface AiAccountHostEnvironmentSummary {
  id: string;
  name: string;
  driver: string;
  companyId: string | null;
}

export interface AiAccountHostSummary {
  id: string;
  name: string;
  kind: AiAccountHostKind;
  maxAccounts: number;
  overflowToOtherAccounts: boolean;
  environments: AiAccountHostEnvironmentSummary[];
  accounts: AiAccountSummary[];
  createdAt: string;
}

export interface AiAccountHostsResponse {
  hosts: AiAccountHostSummary[];
  /** Environments not mapped to any host; their runs keep their own env credentials. */
  unmappedEnvironments: AiAccountHostEnvironmentSummary[];
  /** Every active project on the instance, for reserving accounts. */
  projects: AiAccountProjectSummary[];
  maxAccountsPerHost: number;
}

/** What a host-pool run records in `contextSnapshot.aiConnection`. */
export interface AiAccountRunAttribution {
  mode: "host_pool";
  provider: "anthropic";
  method: AiAccountCredentialType;
  accountId: string;
  accountName: string;
  hostId: string;
  hostName: string;
  /** project: the run's own account; shared: an unreserved account; overflow: another project's account. */
  scope: "project" | "shared" | "overflow";
}

const trimmed = z.string().trim();

export const createAiAccountHostSchema = z.object({
  name: trimmed.min(1).max(80),
  kind: z.enum(AI_ACCOUNT_HOST_KINDS),
  maxAccounts: z.number().int().min(1).max(MAX_AI_ACCOUNTS_PER_HOST).optional(),
  overflowToOtherAccounts: z.boolean().optional(),
}).strict();
export type CreateAiAccountHost = z.infer<typeof createAiAccountHostSchema>;

export const updateAiAccountHostSchema = z.object({
  name: trimmed.min(1).max(80).optional(),
  maxAccounts: z.number().int().min(1).max(MAX_AI_ACCOUNTS_PER_HOST).optional(),
  overflowToOtherAccounts: z.boolean().optional(),
}).strict();
export type UpdateAiAccountHost = z.infer<typeof updateAiAccountHostSchema>;

export const setAiAccountHostEnvironmentsSchema = z.object({
  environmentIds: z.array(z.string().uuid()).max(200),
}).strict();
export type SetAiAccountHostEnvironments = z.infer<typeof setAiAccountHostEnvironmentsSchema>;

/**
 * Add a credential to a host. Exactly one source: a pasted value, the
 * server's own `CLAUDE_CODE_OAUTH_TOKEN`, or the caller's own saved Claude
 * connection in one of their companies. Imports move the value server-side,
 * so it never travels back to the browser.
 */
export const createAiAccountSchema = z.object({
  label: trimmed.min(1).max(80),
  emailHint: trimmed.min(3).max(200).nullable().optional(),
  plan: trimmed.min(1).max(40).nullable().optional(),
  poolEnabled: z.boolean().optional(),
  credentialType: z.enum(AI_ACCOUNT_CREDENTIAL_TYPES),
  value: z.string().trim().min(20).max(4000).optional(),
  importFrom: z.union([
    z.object({ kind: z.literal("server_env") }).strict(),
    z.object({ kind: z.literal("ai_connection"), companyId: z.string().uuid(), connectionId: z.string().uuid() }).strict(),
  ]).optional(),
}).strict().superRefine((value, ctx) => {
  if (Boolean(value.value) === Boolean(value.importFrom)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Give either a value or an import source", path: ["value"] });
  }
  if (value.value && value.credentialType === "subscription" && !value.value.startsWith("sk-ant-oat")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A subscription token from `claude setup-token` starts with sk-ant-oat", path: ["value"] });
  }
  if (value.value && value.credentialType === "api_key" && !value.value.startsWith("sk-ant-api")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A Claude Console API key starts with sk-ant-api", path: ["value"] });
  }
});
export type CreateAiAccount = z.infer<typeof createAiAccountSchema>;

export const updateAiAccountSchema = z.object({
  label: trimmed.min(1).max(80).optional(),
  emailHint: trimmed.min(3).max(200).nullable().optional(),
  plan: trimmed.min(1).max(40).nullable().optional(),
  poolEnabled: z.boolean().optional(),
  /** Back to `active` after a sign-in failure was fixed, or `disabled` to keep it out of the pool. */
  status: z.enum(["active", "disabled"]).optional(),
}).strict();
export type UpdateAiAccount = z.infer<typeof updateAiAccountSchema>;

/** Reserve an account for projects; an empty list makes it shared again. */
export const setAiAccountProjectsSchema = z.object({
  projectIds: z.array(z.string().uuid()).max(200),
}).strict();
export type SetAiAccountProjects = z.infer<typeof setAiAccountProjectsSchema>;
