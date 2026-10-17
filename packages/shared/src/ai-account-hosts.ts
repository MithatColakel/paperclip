import { z } from "zod";
import type { AiAccountOrigin, AiAccountOwnerRef } from "./ai-account-pool.js";

/**
 * Fork: execution hosts (devices) and their Claude accounts. A host is a
 * machine that runs agents: the Paperclip server, an SSH runner, or a device
 * that an environment driver plugin registered (`external`). Accounts are now
 * user-owned pool accounts bound per agent (see ai-account-pool.ts); the
 * per-host shapes below remain for the legacy host routes. Paperclip never
 * moves a task to another account.
 */

/** Operator rule: at most this many credentials per host. */
export const MAX_AI_ACCOUNTS_PER_HOST = 3;

/** Without a provider reset time, a usage-limited account rests this long. */
export const AI_ACCOUNT_DEFAULT_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;

/** An API key whose credit balance ran out rests this long before it is tried again. */
export const AI_ACCOUNT_CREDIT_BALANCE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** `external`: registered by an environment driver plugin's target report. */
export const AI_ACCOUNT_HOST_KINDS = ["server", "ssh_host", "mac", "external"] as const;
export type AiAccountHostKind = (typeof AI_ACCOUNT_HOST_KINDS)[number];

/**
 * The kinds a person may add by hand. An `external` device comes only from an
 * environment driver plugin's target report, which also gives it its target
 * key and its managing plugin.
 */
export const AI_ACCOUNT_HOST_CREATABLE_KINDS = ["server", "ssh_host", "mac"] as const satisfies readonly AiAccountHostKind[];

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
  /** The legacy host the account was added to; null for pool accounts. */
  hostId: string | null;
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
  /** The effective owner; null for a legacy account without one. Absent from servers that predate it. */
  owner?: AiAccountOwnerRef | null;
  /** Absent from servers that predate it. */
  origin?: AiAccountOrigin;
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
  kind: z.enum(AI_ACCOUNT_HOST_CREATABLE_KINDS, {
    error: (issue) => issue.input === "external"
      ? "Plugin devices come only from their environment driver plugin's reports"
      : undefined,
  }),
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
