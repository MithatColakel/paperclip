import {
  MAX_AI_ACCOUNTS_PER_HOST,
  type AiAccountCredentialType,
  type AiAccountHostEnvironmentSummary,
  type AiAccountHostKind,
  type AiAccountHostSummary,
  type AiAccountLimitReason,
  type AiAccountProjectSummary,
  type AiAccountSummary,
  type AiAccountUsageWindow,
  type AiManagedConnectionSummary,
  type AiConnectionList,
} from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { formatTokens } from "@/lib/utils";

export const HOST_KIND_LABELS: Record<AiAccountHostKind, string> = {
  server: "Paperclip server",
  ssh_host: "Runner server (SSH)",
  mac: "Mac over SSH",
  external: "Plugin device",
};

export const HOST_KIND_DESCRIPTIONS: Record<AiAccountHostKind, string> = {
  server: "Runs every Local environment.",
  ssh_host: "A runner machine reached over SSH.",
  mac: "A Mac reached over an SSH environment.",
  external: "A device an environment driver plugin registered.",
};

/** Mirrors the server rule: which environment drivers can run on each host kind. */
export const HOST_KIND_DRIVERS: Record<AiAccountHostKind, readonly string[]> = {
  server: ["local"],
  ssh_host: ["ssh"],
  mac: ["ssh"],
  external: ["sandbox"],
};

export const CREDENTIAL_TYPE_LABELS: Record<AiAccountCredentialType, string> = {
  subscription: "Subscription",
  api_key: "API key",
};

/** What a pasted credential of each type starts with; the server checks the same. */
export const CREDENTIAL_PREFIX: Record<AiAccountCredentialType, string> = {
  subscription: "sk-ant-oat",
  api_key: "sk-ant-api",
};

const LIMIT_REASON_LABELS: Record<AiAccountLimitReason, string> = {
  provider_quota: "usage limit",
  credit_balance: "no API credit",
  manual: "manual",
};

export function limitReasonLabel(reason: AiAccountLimitReason | null): string | null {
  return reason ? LIMIT_REASON_LABELS[reason] : null;
}

/** The most accounts a host can take: its own setting, never above the operator ceiling. */
export function hostAccountLimit(host: Pick<AiAccountHostSummary, "maxAccounts">, maxAccountsPerHost = MAX_AI_ACCOUNTS_PER_HOST): number {
  return Math.min(host.maxAccounts, maxAccountsPerHost);
}

export function hostIsFull(host: Pick<AiAccountHostSummary, "maxAccounts" | "accounts">, maxAccountsPerHost = MAX_AI_ACCOUNTS_PER_HOST): boolean {
  return host.accounts.length >= hostAccountLimit(host, maxAccountsPerHost);
}

export type AiAccountState =
  | { kind: "available" }
  | { kind: "limited"; until: string; reason: AiAccountLimitReason | null }
  | { kind: "auth_failed"; message: string | null }
  | { kind: "disabled" }
  | { kind: "out_of_pool" };

/** One state per account, in the order an operator needs to act on it. */
export function aiAccountState(
  account: Pick<AiAccountSummary, "status" | "statusMessage" | "exhaustedUntil" | "limitReason"> & { poolEnabled?: boolean },
  now = Date.now(),
): AiAccountState {
  if (account.status === "disabled") return { kind: "disabled" };
  if (account.status === "auth_failed") return { kind: "auth_failed", message: account.statusMessage };
  if (account.exhaustedUntil && new Date(account.exhaustedUntil).getTime() > now) {
    return { kind: "limited", until: account.exhaustedUntil, reason: account.limitReason };
  }
  if (account.poolEnabled === false) return { kind: "out_of_pool" };
  return { kind: "available" };
}

/** Shows enough of an email to recognise it: `mi•••@example.com`. */
export function maskEmail(email: string | null | undefined): string | null {
  const value = email?.trim();
  if (!value) return null;
  const at = value.indexOf("@");
  if (at < 0) return `${value.slice(0, 2)}•••`;
  const local = value.slice(0, at);
  return `${local.slice(0, Math.min(2, local.length))}•••${value.slice(at)}`;
}

/** Environments a host can take: its own plus unmapped ones whose driver fits the host kind. */
export function environmentChoicesForHost(
  host: Pick<AiAccountHostSummary, "kind" | "environments">,
  unmapped: AiAccountHostEnvironmentSummary[],
): AiAccountHostEnvironmentSummary[] {
  const allowed = HOST_KIND_DRIVERS[host.kind];
  const seen = new Set<string>();
  const choices: AiAccountHostEnvironmentSummary[] = [];
  for (const environment of [...host.environments, ...unmapped]) {
    if (seen.has(environment.id) || !allowed.includes(environment.driver)) continue;
    seen.add(environment.id);
    choices.push(environment);
  }
  return choices;
}

/** One usage window as text: `3 runs · 12.3M in · 840.0k out`, with cached input apart. */
export function formatUsageWindow(window: AiAccountUsageWindow): { summary: string; cached: string | null } {
  return {
    summary: [
      `${window.runs} ${window.runs === 1 ? "run" : "runs"}`,
      `${formatTokens(window.inputTokens)} in`,
      `${formatTokens(window.outputTokens)} out`,
    ].join(" · "),
    cached: window.cachedInputTokens > 0 ? `+ ${formatTokens(window.cachedInputTokens)} cached` : null,
  };
}

/** How a reserved project reads on a chip: `CLE · Mobile app`. */
export function projectChipLabel(project: Pick<AiAccountProjectSummary, "issuePrefix" | "name">): string {
  return `${project.issuePrefix} · ${project.name}`;
}

/**
 * Projects to offer for an account, grouped by company and sorted by name. The
 * account's current projects stay listed even when the instance list no longer
 * has them, so saving never drops a reservation silently.
 */
export function projectChoicesByCompany(
  projects: AiAccountProjectSummary[],
  reserved: AiAccountProjectSummary[] = [],
): Array<{ companyId: string; companyName: string; projects: AiAccountProjectSummary[] }> {
  const byId = new Map<string, AiAccountProjectSummary>();
  for (const project of [...projects, ...reserved]) if (!byId.has(project.id)) byId.set(project.id, project);
  const groups = new Map<string, { companyId: string; companyName: string; projects: AiAccountProjectSummary[] }>();
  for (const project of byId.values()) {
    const group = groups.get(project.companyId) ?? { companyId: project.companyId, companyName: project.companyName, projects: [] };
    group.projects.push(project);
    groups.set(project.companyId, group);
  }
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return [...groups.values()]
    .map((group) => ({ ...group, projects: group.projects.sort(byName) }))
    .sort((a, b) => a.companyName.localeCompare(b.companyName));
}

/** Saved Claude connections the signed-in user can move onto a host: their own, of the chosen type. */
export function importableConnections(
  list: Pick<AiConnectionList, "currentUserId" | "connections"> | undefined,
  credentialType: AiAccountCredentialType,
): AiManagedConnectionSummary[] {
  if (!list) return [];
  return list.connections.filter((connection) =>
    connection.provider === "anthropic" &&
    connection.method === credentialType &&
    connection.ownership === "personal" &&
    connection.ownerUserId === list.currentUserId);
}

/** The server's message, including field-level validation messages when it sent them. */
export function aiAccountErrorMessage(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof ApiError) {
    const details = (error.body as { details?: unknown } | null)?.details;
    if (Array.isArray(details)) {
      const messages = details
        .map((issue) => (issue && typeof issue === "object" ? (issue as { message?: unknown }).message : null))
        .filter((message): message is string => typeof message === "string" && message.length > 0);
      if (messages.length > 0) return messages.join(" ");
    }
    return error.message;
  }
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}
