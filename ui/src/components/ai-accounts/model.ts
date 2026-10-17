import {
  type AiAccountCredentialType,
  type AiAccountHostEnvironmentSummary,
  type AiAccountHostKind,
  type AiAccountHostSummary,
  type AiAccountMigrationOutcome,
  type AiAccountMigrationReport,
  type AiAccountMigrationRule,
  type AiAccountOwnerRef,
  type AiAccountProjectSummary,
  type AiAccountUsageWindow,
  type AiManagedConnectionSummary,
  type AiConnectionList,
  type ExecutionDeviceKind,
  type LinkDeviceTarget,
} from "@paperclipai/shared";
import type { CurrentBoardAccess } from "@/api/access";
import { ApiError } from "@/api/client";
import { formatDateTime, formatTokens } from "@/lib/utils";

/**
 * Device kinds by their generic names; the same words as the device pages
 * (`EXECUTION_DEVICE_KIND_LABELS`). Fork: the legacy `mac` kind is a computer
 * reached over SSH that an environment driver plugin may also manage.
 */
export const HOST_KIND_LABELS: Record<AiAccountHostKind, string> = {
  server: "Paperclip server",
  ssh_host: "SSH host",
  mac: "Computer over SSH",
  external: "Plugin device",
};

export const HOST_KIND_DESCRIPTIONS: Record<AiAccountHostKind, string> = {
  server: "The machine Paperclip runs on. It runs every Local environment.",
  ssh_host: "A machine Paperclip reaches over SSH.",
  mac: "A computer reached over SSH that an environment driver plugin can also manage. Link the two so they count as one device.",
  external: "A device an environment driver plugin registered.",
};

/** Mirrors the server rule (spec 6.1): which environment drivers an explicit mapping may put on each kind. */
export const HOST_KIND_DRIVERS: Record<AiAccountHostKind, readonly string[]> = {
  server: ["local"],
  ssh_host: ["ssh"],
  mac: ["ssh", "sandbox"],
  external: ["sandbox"],
};

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

/** Saved Claude connections the signed-in user can import: their own, of the chosen type. */
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

// ---------------------------------------------------------------------------
// Execution devices: linking one machine reached two ways (spec 6.6)
// ---------------------------------------------------------------------------

/** Mirrors the server's key format; the plugin's own target key may contain colons. */
const PLUGIN_TARGET_KEY_PATTERN = /^target:([0-9a-fA-F-]{36}):([a-z0-9][a-z0-9._-]*):(.+)$/;

/** A device's plugin target key, `target:<pluginId>:<provider>:<targetKey>`, as the `link-target` body. */
export function parseDeviceTargetKey(key: string | null | undefined): LinkDeviceTarget | null {
  const match = key ? PLUGIN_TARGET_KEY_PATTERN.exec(key) : null;
  return match ? { pluginId: match[1]!, provider: match[2]!, targetKey: match[3]! } : null;
}

/** Only a machine reached over SSH can take a plugin target; the server refuses the other kinds. */
export const LINKABLE_DEVICE_KINDS: readonly ExecutionDeviceKind[] = ["ssh_host", "mac"];

export interface DeviceLinkSide {
  id: string;
  name: string;
  kind: ExecutionDeviceKind;
  targetKey: string | null;
}

export interface DeviceLinkPlan {
  /** The device reached over SSH. It keeps its id and takes the plugin's target. */
  device: { id: string; name: string };
  /** The plugin's device. Its slots, mappings and waits move to `device`, and it leaves the list. */
  target: { id: string; name: string };
  input: LinkDeviceTarget;
}

/**
 * How to link a likely-duplicate pair, in either order: the device reached
 * over SSH takes the plugin device's target. Null when the pair cannot be
 * linked: neither is a plugin device with a readable target key, or the other
 * one is not reached over SSH or already has a target of its own.
 */
export function deviceLinkPlan(a: DeviceLinkSide, b: DeviceLinkSide): DeviceLinkPlan | null {
  const [target, device] = a.kind === "external" ? [a, b] : [b, a];
  if (target.kind !== "external" || !LINKABLE_DEVICE_KINDS.includes(device.kind) || device.targetKey) return null;
  const input = parseDeviceTargetKey(target.targetKey);
  if (!input) return null;
  return { device: { id: device.id, name: device.name }, target: { id: target.id, name: target.name }, input };
}

const ONLY_CREDENTIAL_TYPE_TEXT: Record<AiAccountCredentialType, string> = {
  subscription: "Takes subscription accounts only",
  api_key: "Takes API key accounts only",
};

/** What a device takes; null when it takes any credential type. */
export function acceptedCredentialTypesText(types: readonly AiAccountCredentialType[] | null | undefined): string | null {
  if (!types) return null;
  if (types.length === 0) return "Takes no Claude accounts";
  return types.length === 1 ? ONLY_CREDENTIAL_TYPE_TEXT[types[0]!] : null;
}

/** Where an account or a device is used: `Acme: 2 agents · Globex: 1 agent`. */
export function companyAgentCountsText(companies: ReadonlyArray<{ companyName: string; agentCount: number }>): string | null {
  if (companies.length === 0) return null;
  return companies
    .map((company) => `${company.companyName || "Another company"}: ${company.agentCount} ${company.agentCount === 1 ? "agent" : "agents"}`)
    .join(" · ");
}

/** An account owner in one line: `Ada · ada@example.com`, or `No owner` for a legacy account without one. */
export function accountOwnerText(owner: AiAccountOwnerRef | null | undefined): string {
  if (!owner) return "No owner";
  const parts = [owner.name?.trim(), owner.email?.trim()].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : "Unknown user";
}

// ---------------------------------------------------------------------------
// Who may act. The server stays authoritative; these only decide what to offer.
// ---------------------------------------------------------------------------

type BoardAccessSnapshot = Pick<CurrentBoardAccess, "isInstanceAdmin" | "source" | "companyIds" | "memberships">;

function activeMembership(companyId: string, boardAccess: BoardAccessSnapshot) {
  return boardAccess.memberships?.find((membership) => membership.companyId === companyId && membership.status === "active") ?? null;
}

/**
 * A company admin (spec 5.1, decisions D4 and D10): the local board, an active
 * owner or admin membership, or an instance admin with access to the company.
 * False while the access snapshot is unknown.
 */
export function isCompanyAdminAccess(
  companyId: string | null | undefined,
  boardAccess: BoardAccessSnapshot | null | undefined,
): boolean {
  if (!companyId || !boardAccess) return false;
  if (boardAccess.source === "local_implicit") return true;
  const membership = activeMembership(companyId, boardAccess);
  if (membership?.membershipRole === "owner" || membership?.membershipRole === "admin") return true;
  return boardAccess.isInstanceAdmin && (membership !== null || (boardAccess.companyIds ?? []).includes(companyId));
}

/** True only when the snapshot shows a viewer membership and no admin rights; viewers cannot "Check now". */
export function isCompanyViewerAccess(
  companyId: string | null | undefined,
  boardAccess: BoardAccessSnapshot | null | undefined,
): boolean {
  if (!companyId || !boardAccess || isCompanyAdminAccess(companyId, boardAccess)) return false;
  return activeMembership(companyId, boardAccess)?.membershipRole === "viewer";
}

// ---------------------------------------------------------------------------
// Wait notifications (`execution-wait-settings`)
// ---------------------------------------------------------------------------

/** Preset delays for the long-wait notice, in hours. */
export const NOTIFY_AFTER_HOUR_CHOICES = [1, 2, 4, 8, 12, 24, 48, 72, 168] as const;

const NOTIFY_AFTER_DEFAULT = "default";
const NOTIFY_AFTER_NEVER = "never";

/** `1 hour`, `12 hours`, `24 hours`, `2 days`, `7 days`. */
export function formatWaitHours(hours: number): string {
  if (hours >= 48 && hours % 24 === 0) return `${hours / 24} days`;
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/** The select value of a stored `notifyAfterHours`: null is the instance default and 0 is never. */
export function notifyAfterSelectValue(hours: number | null): string {
  if (hours === null) return NOTIFY_AFTER_DEFAULT;
  if (hours <= 0) return NOTIFY_AFTER_NEVER;
  return String(hours);
}

/** The `notifyAfterHours` to save for a select value. */
export function notifyAfterHoursFromSelect(value: string): number | null {
  if (value === NOTIFY_AFTER_DEFAULT) return null;
  if (value === NOTIFY_AFTER_NEVER) return 0;
  const hours = Number.parseInt(value, 10);
  if (!Number.isInteger(hours) || hours < 1) throw new Error(`Not a notice delay: ${value}`);
  return hours;
}

/** The choices, in order: the instance default, the presets (plus a stored custom value), then never. */
export function notifyAfterOptions(settings: { notifyAfterHours: number | null; instanceDefaultHours: number }): Array<{ value: string; label: string }> {
  const hours = new Set<number>(NOTIFY_AFTER_HOUR_CHOICES);
  if (settings.notifyAfterHours !== null && settings.notifyAfterHours > 0) hours.add(settings.notifyAfterHours);
  const instanceDefault = settings.instanceDefaultHours > 0 ? formatWaitHours(settings.instanceDefaultHours) : "never";
  return [
    { value: NOTIFY_AFTER_DEFAULT, label: `Instance default (${instanceDefault})` },
    ...[...hours].sort((a, b) => a - b).map((value) => ({ value: String(value), label: formatWaitHours(value) })),
    { value: NOTIFY_AFTER_NEVER, label: "Never" },
  ];
}

// ---------------------------------------------------------------------------
// Binding migration report
// ---------------------------------------------------------------------------

/** Why the migration chose an agent's account. */
export const MIGRATION_RULE_LABELS: Record<AiAccountMigrationRule, string> = {
  reservation: "Reserved for its projects",
  agent_history: "The account this agent used most",
  company_history: "The account its company used most on its device",
  company_pool_fingerprint: "The credential of its company pool connection",
};

export const MIGRATION_OUTCOME_LABELS: Record<AiAccountMigrationOutcome, string> = {
  bound: "Assigned",
  unassigned: "Waiting for an account",
  unbound: "Not assigned",
};

/** The job's state in one line: `Completed Oct 16, 2026, 1:02 PM · 1 attempt`, `Failed after 2 attempts: …`. */
export function migrationStatusText(
  report: Pick<AiAccountMigrationReport, "status" | "attempts" | "completedAt" | "lastError">,
): string {
  const attempts = report.attempts === 1 ? "1 attempt" : `${report.attempts} attempts`;
  switch (report.status) {
    case "pending":
      return "Not run yet.";
    case "running":
      return "Running now…";
    case "completed":
      return report.completedAt ? `Completed ${formatDateTime(report.completedAt)} · ${attempts}` : `Completed · ${attempts}`;
    case "failed":
      return report.lastError ? `Failed after ${attempts}: ${report.lastError}` : `Failed after ${attempts}.`;
  }
}
