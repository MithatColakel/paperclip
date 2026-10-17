/**
 * Fork: display helpers for the user-owned Claude account pool and execution
 * devices. Pages and fields (Claude accounts, Devices, the agent's Claude
 * account field) share these so every surface names a state, a reason and
 * its fix the same way.
 *
 * Product rule: Paperclip never moves a task to another account. When an
 * account hits its limit, its tasks wait for the reset.
 */
import type {
  AiAccountBindingMode,
  AiAccountBindingState,
  AiAccountCredentialType,
  AiAccountIncompatibleReason,
  AiAccountLimitSource,
  AiAccountSelectionWarning,
  AiAccountState,
  AiAccountUnselectableReason,
  CompanyAiAccountOption,
  DeviceAccountLimitErrorDetails,
  EnvironmentAvailabilitySummary,
  ExecutionDeviceKind,
  ExecutionDeviceOwner,
  SetAgentAiAccount,
} from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import type { SearchableSelectGroup, SearchableSelectOption } from "@/components/SearchableSelect";
import { aiAccountErrorMessage, maskEmail } from "@/components/ai-accounts/model";

export { maskEmail };

// ---------------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------------

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function calendarDayDiff(date: Date, now: Date): number {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((start - today) / DAY_MS);
}

/** Whether a time came from an estimate rather than a provider reset or a check. */
export function isEstimatedSource(source: string | null | undefined): boolean {
  return source === "estimated";
}

/**
 * A reset or resume time in local time: `18:00` today, `Tue 18:00` within the
 * week around today, `Tue 23 Oct 18:00` further away, and ` (estimated)` when
 * the time is an estimate. Returns null for a missing or invalid time.
 */
export function formatResetTime(
  value: string | Date | null | undefined,
  options: { now?: Date; estimated?: boolean } = {},
): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const now = options.now ?? new Date();
  const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  const dayDiff = calendarDayDiff(date, now);
  const weekday = WEEKDAYS[date.getDay()];
  const text = dayDiff === 0
    ? clock
    : Math.abs(dayDiff) <= 6
      ? `${weekday} ${clock}`
      : `${weekday} ${date.getDate()} ${MONTHS[date.getMonth()]} ${clock}`;
  return options.estimated ? `${text} (estimated)` : text;
}

// ---------------------------------------------------------------------------
// Account and device labels
// ---------------------------------------------------------------------------

export const POOL_CREDENTIAL_TYPE_LABELS: Record<AiAccountCredentialType, string> = {
  subscription: "Subscription",
  api_key: "API key",
};

/** Device kinds; a device an environment driver plugin manages shows its plugin instead. */
export const EXECUTION_DEVICE_KIND_LABELS: Record<ExecutionDeviceKind, string> = {
  server: "Paperclip server",
  ssh_host: "SSH host",
  mac: "Computer over SSH",
  external: "Plugin device",
};

export type PoolBadgeTone = "positive" | "info" | "warning" | "danger" | "muted";

/** Badge classes per tone; shared by account states, device availability and waits. */
export const POOL_BADGE_TONE_CLASS: Record<PoolBadgeTone, string> = {
  positive: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  danger: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  muted: "border-border bg-muted text-muted-foreground",
};

export interface AiAccountStateDisplay {
  state: AiAccountState;
  label: string;
  tone: PoolBadgeTone;
}

/** The state badge of a pool account: `Active`, `Limited until 18:00 (estimated)`, `Signed out`, … */
export function aiAccountStateDisplay(
  account: { state: AiAccountState; exhaustedUntil?: string | null; limitSource?: AiAccountLimitSource | null },
  now: Date = new Date(),
): AiAccountStateDisplay {
  switch (account.state) {
    case "active":
      return { state: "active", label: "Active", tone: "positive" };
    case "limited": {
      const until = formatResetTime(account.exhaustedUntil, { now, estimated: isEstimatedSource(account.limitSource) });
      return { state: "limited", label: until ? `Limited until ${until}` : "Limited", tone: "warning" };
    }
    case "signed_out":
      return { state: "signed_out", label: "Signed out", tone: "danger" };
    case "withdrawn":
      return { state: "withdrawn", label: "Paused by owner", tone: "muted" };
    case "admin_disabled":
      return { state: "admin_disabled", label: "Disabled by admin", tone: "danger" };
  }
}

/**
 * `device_unknown` also happens to a pinned agent (a sandbox environment no
 * reported target matches, a driver that maps to no device), so the text
 * names the instance-admin fix too.
 */
const DEVICE_UNKNOWN_TEXT =
  "Paperclip cannot tell which device this agent runs on. Pin the agent to an environment, or ask an instance admin to map the environment to a device.";

/** Why an account cannot be chosen for an agent. Each text names the fix. */
export const AI_ACCOUNT_UNSELECTABLE_REASON_TEXT: Record<AiAccountUnselectableReason, string> = {
  unassigned: "No account is chosen yet. Pick one for this agent.",
  owner_not_member: "Its owner is not a member of this company. The owner must rejoin, or choose another account.",
  reserved_elsewhere: "Reserved for other projects. Its owner can clear the reservation.",
  withdrawn: "Switched off. It must be turned back on before it can be used.",
  signed_out: "Signed out. Its owner must replace the token.",
  device_unknown: DEVICE_UNKNOWN_TEXT,
  credential_type_unsupported: "The agent's device does not accept this credential type. Choose another account, or move the agent.",
  usage_limit: "At its usage limit. Tasks would wait for the reset.",
  credit_balance: "Out of API credit. Add credit, then the owner can clear the limit.",
  adapter_unsupported: "This agent's adapter cannot use a Claude pool account.",
  device_account_limit: "The device already runs its maximum of Claude accounts. Choose an account already on it, or free a slot.",
  not_permitted: "Only its owner or a company admin can assign it.",
};

/** Why an account in this state cannot be chosen, when the server sent no reason. */
const STATE_UNSELECTABLE_TEXT: Partial<Record<AiAccountState, string>> = {
  withdrawn: "Paused by its owner. The owner can resume it.",
  signed_out: AI_ACCOUNT_UNSELECTABLE_REASON_TEXT.signed_out,
  admin_disabled: "Disabled by an instance admin. Ask an instance admin to re-enable it.",
};

/** A limited account may still be chosen; its tasks wait for the reset. */
export function aiAccountSelectionWarningText(
  warning: AiAccountSelectionWarning,
  account: { exhaustedUntil?: string | null; limitSource?: AiAccountLimitSource | null },
  now: Date = new Date(),
): string {
  if (warning === "credit_balance") {
    return "Out of API credit. Tasks wait until credit is added and the limit is cleared.";
  }
  const until = formatResetTime(account.exhaustedUntil, { now, estimated: isEstimatedSource(account.limitSource) });
  return until
    ? `At its usage limit until ${until}. Tasks wait for the reset.`
    : "At its usage limit. Tasks wait for the reset.";
}

/** `reason` of a 422 `ai_account_incompatible` from the binding routes. */
export const AI_ACCOUNT_INCOMPATIBLE_REASON_TEXT: Record<AiAccountIncompatibleReason, string> = {
  adapter_unsupported: "This agent's adapter cannot use a Claude pool account.",
  device_unknown: DEVICE_UNKNOWN_TEXT,
  credential_type_unsupported:
    "The agent's device does not accept this account's credential type. Choose another account, or move the agent to another device.",
  account_signed_out: "This account is signed out. Its owner must replace the token first.",
  account_disabled: "This account is switched off. It must be turned back on first.",
};

/** An agent's binding as one line. */
export const AI_ACCOUNT_BINDING_STATE_TEXT: Record<AiAccountBindingState, string> = {
  unbound: "Not set: the agent's AI connection or the device's own login applies",
  device_login: "Device's own login",
  pool_account: "Claude account",
  unassigned: "No account: tasks wait until one is chosen",
  account_unavailable: "An account that is no longer available in this company",
};

const DEVICE_UNAVAILABLE_LABELS: Record<string, string> = {
  offline: "Offline",
  paused: "Paused",
  maintenance: "Maintenance",
  updating: "Updating",
  unreachable: "Unreachable",
};

/** A device's availability badge: `Available`, `Offline since 13:02`, `Removed`. */
export function deviceAvailabilityDisplay(
  availability: Pick<EnvironmentAvailabilitySummary, "state" | "reason" | "label" | "unavailableSince">,
  now: Date = new Date(),
): { label: string; tone: PoolBadgeTone } {
  if (availability.state === "available") return { label: "Available", tone: "positive" };
  if (availability.state === "retired") return { label: "Removed", tone: "danger" };
  const base = (availability.reason && DEVICE_UNAVAILABLE_LABELS[availability.reason]) ?? "Unavailable";
  const since = formatResetTime(availability.unavailableSince, { now });
  return { label: since ? `${base} since ${since}` : base, tone: "warning" };
}

/** The account meter: `2 of 3 Claude accounts · +1 used by another company`. Other companies are a count only. */
export function deviceAccountUsageText(device: { limit: number; inUse: number; otherCompaniesAccounts: number }): string {
  const usage = `${device.inUse} of ${device.limit} Claude accounts`;
  if (device.otherCompaniesAccounts <= 0) return usage;
  const others = device.otherCompaniesAccounts === 1
    ? "+1 used by another company"
    : `+${device.otherCompaniesAccounts} used by other companies`;
  return `${usage} · ${others}`;
}

/** "Build box — owner x@y.com"; the owner is shown for display only. */
export function deviceOwnerText(owner: ExecutionDeviceOwner | null): string | null {
  if (!owner) return null;
  const who = owner.email ?? owner.name;
  return who ? `owner ${who}` : null;
}

/** The run badge of a pool-account run, e.g. "Claude account: Max-2"; null for other runs. */
export function poolAccountRunBadgeLabel(contextSnapshot: Record<string, unknown> | null | undefined): string | null {
  const attribution = asRecord(contextSnapshot?.aiConnection);
  if (attribution?.mode !== "pool_account") return null;
  const name = typeof attribution.accountName === "string" ? attribution.accountName.trim() : "";
  return name ? `Claude account: ${name}` : "Claude account";
}

/** The one product line every Claude accounts surface repeats. */
export const POOL_PRODUCT_LINE =
  "Paperclip never moves a task to another account. When an account hits its limit, its tasks wait for the reset.";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface AiAccountPoolErrorInfo {
  status: number | null;
  code: string | null;
  message: string;
  details: Record<string, unknown> | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The status, error code and details of a failed pool, binding or device request. */
export function readAiAccountPoolError(error: unknown): AiAccountPoolErrorInfo | null {
  if (!error) return null;
  if (error instanceof ApiError) {
    const body = asRecord(error.body);
    const details = asRecord(body?.details);
    const code = typeof body?.code === "string"
      ? body.code
      : typeof details?.code === "string"
        ? details.code
        : null;
    return { status: error.status, code, message: error.message, details };
  }
  return { status: null, code: null, message: error instanceof Error ? error.message : String(error), details: null };
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** The 409 `device_account_limit` body as a sentence. Other companies' accounts are a count only. */
export function deviceAccountLimitMessage(details: Partial<DeviceAccountLimitErrorDetails>): string {
  const device = typeof details.deviceName === "string" && details.deviceName ? details.deviceName : "The device";
  const limit = typeof details.limit === "number" ? details.limit : null;
  const inUse = typeof details.inUse === "number" ? details.inUse : null;
  const labels = Array.isArray(details.accounts) ? details.accounts.filter((label) => typeof label === "string") : [];
  const others = typeof details.otherCompaniesAccounts === "number" ? details.otherCompaniesAccounts : 0;
  const usage = limit !== null && inUse !== null ? `${inUse} of ${limit} Claude accounts` : "its maximum of Claude accounts";
  const parts = [...labels];
  if (others > 0) parts.push(`${plural(others, "account")} of other companies`);
  const list = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return `${device} already runs ${usage}${list}. Choose an account already on that device, or free a slot first.`;
}

/** User-facing text for a failed pool, binding or device request; names the fix where there is one. */
export function aiAccountPoolErrorMessage(error: unknown): string {
  const info = readAiAccountPoolError(error);
  if (!info) return "Something went wrong. Try again.";
  const details = info.details ?? {};
  switch (info.code) {
    case "device_account_limit":
      return deviceAccountLimitMessage(details as Partial<DeviceAccountLimitErrorDetails>);
    case "ai_account_incompatible": {
      const reason = details.reason as AiAccountIncompatibleReason | undefined;
      return (reason && AI_ACCOUNT_INCOMPATIBLE_REASON_TEXT[reason]) ?? info.message;
    }
    case "ai_account_not_eligible":
      return "This account is not available in this company. Its owner must be a member here, and the account must be switched on.";
    case "ai_account_binding_forbidden":
      return "Only the account's owner or a company admin can change this assignment.";
    case "ai_account_in_use": {
      const bindings = Array.isArray(details.bindings) ? details.bindings.length : 0;
      const others = typeof details.otherCompanies === "number" ? details.otherCompanies : 0;
      const total = bindings + others;
      return total > 0
        ? `This account is still assigned to ${plural(total, "agent")}. Remove it and release them; they then wait until another account is chosen.`
        : "This account is still assigned to agents. Remove it and release them.";
    }
    case "ai_account_route_moved":
      return "This page is out of date. Reload to use the Claude accounts page.";
    case "resource_still_unavailable":
      return "Still unavailable (checked just now).";
    default:
      break;
  }
  if (info.status === 429) return "Checked less than a minute ago. Try again in a minute.";
  if (info.status === 404) return "Not found. It may have been removed, or it is not visible to this company.";
  if (info.status === 403) return "You do not have access to this.";
  return aiAccountErrorMessage(error) ?? info.message;
}

// ---------------------------------------------------------------------------
// AccountSelect options
// ---------------------------------------------------------------------------

/**
 * The picker's value: the device's own login, a pool account, pool mode
 * without an account, the agent's AI connection while it is what the agent
 * uses, or nothing yet.
 */
export type AccountSelectValue =
  | { mode: "device_login" }
  | { mode: "pool_account"; accountId: string | null }
  | { mode: "ai_connection" }
  | null;

export const DEVICE_LOGIN_SELECT_VALUE = "device_login";
/** The agent's current AI connection. It is no PUT body, so picking it saves nothing. */
export const AI_CONNECTION_SELECT_VALUE = "ai_connection";
const ACCOUNT_VALUE_PREFIX = "account:";

export function accountSelectKey(value: AccountSelectValue): string {
  if (!value) return "";
  if (value.mode === "device_login") return DEVICE_LOGIN_SELECT_VALUE;
  if (value.mode === "ai_connection") return AI_CONNECTION_SELECT_VALUE;
  return value.accountId ? `${ACCOUNT_VALUE_PREFIX}${value.accountId}` : "";
}

/** The PUT body for a picked option. */
export function accountSelectSelection(key: string): SetAgentAiAccount | null {
  if (key === DEVICE_LOGIN_SELECT_VALUE) return { mode: "device_login" };
  if (key.startsWith(ACCOUNT_VALUE_PREFIX) && key.length > ACCOUNT_VALUE_PREFIX.length) {
    return { mode: "pool_account", accountId: key.slice(ACCOUNT_VALUE_PREFIX.length) };
  }
  return null;
}

/** The picker value of an agent's current binding. */
export function accountSelectValueFromBinding(binding: {
  mode: "pool_account" | "device_login" | null;
  account: { id: string } | null;
}): AccountSelectValue {
  if (binding.mode === "device_login") return { mode: "device_login" };
  if (binding.mode === "pool_account") return { mode: "pool_account", accountId: binding.account?.id ?? null };
  return null;
}

export interface AccountSelectOption extends SearchableSelectOption<string> {
  /** Null for the device-login and AI connection choices. */
  account: CompanyAiAccountOption | null;
  stateDisplay: AiAccountStateDisplay | null;
  /** "yours", or the owner's name. */
  ownerText: string | null;
  /** Why the option is disabled; names the fix. */
  disabledReason: string | null;
  /** A limited account stays selectable, with this note. */
  warning: string | null;
  /** What a choice that is not an account means; null for an account. */
  description: string | null;
}

export type AccountSelectGroup = SearchableSelectGroup<string, AccountSelectOption>;

function ownerText(option: CompanyAiAccountOption): string {
  if (option.ownedByMe) return "yours";
  return option.owner.name?.trim() || maskEmail(option.owner.email) || "another member";
}

/**
 * Why this caller cannot choose the account, or null when they can. The
 * server's per-agent answer wins. Company admins may choose any eligible
 * account; everyone else only their own (decision D4).
 */
export function accountUnselectableReason(
  option: CompanyAiAccountOption,
  canBindAny: boolean,
): string | null {
  if (option.selectable === false) {
    return AI_ACCOUNT_UNSELECTABLE_REASON_TEXT[option.reason ?? "not_permitted"] ?? AI_ACCOUNT_UNSELECTABLE_REASON_TEXT.not_permitted;
  }
  if (!option.canBind || (!canBindAny && !option.ownedByMe)) return AI_ACCOUNT_UNSELECTABLE_REASON_TEXT.not_permitted;
  return STATE_UNSELECTABLE_TEXT[option.state] ?? null;
}

function accountWarning(option: CompanyAiAccountOption, now: Date): string | null {
  const warning: AiAccountSelectionWarning | null = option.warning
    ?? (option.state === "limited" ? "usage_limit" : null);
  return warning ? aiAccountSelectionWarningText(warning, option, now) : null;
}

/** Why the device's own login is not choosable for a caller who is not a company admin. */
export const DEVICE_LOGIN_NOT_PERMITTED_TEXT =
  "Only a company admin, or the owner of the agent's current Claude account, can switch it to the device's own login.";

/** The device-login choice, under its name in the picker. */
export const DEVICE_LOGIN_OPTION_TEXT =
  "Whatever login the device already has. It does not count toward the device's Claude accounts.";

/** The current AI connection choice, under its name in the picker. */
export const CURRENT_AI_CONNECTION_OPTION_TEXT =
  "What this agent uses now. Once you choose another option, it is no longer offered here.";

/**
 * Whether the caller may switch an agent to the device's own login (spec 5.1,
 * decision D4): a company admin always; an account owner only while the agent
 * is bound to one of the owner's own accounts. An owner may still bind their
 * own account to an unbound agent, which `canBindAny` cannot express.
 */
export function canChooseDeviceLogin(input: {
  canBindAny: boolean;
  binding: { mode: AiAccountBindingMode | null; account: { ownedByMe: boolean } | null } | null | undefined;
}): boolean {
  if (input.canBindAny) return true;
  return input.binding?.mode === "pool_account" && input.binding.account?.ownedByMe === true;
}

/**
 * Groups for `AccountSelect`: the agent's current AI connection (when it is
 * what the agent uses), the device's own login (when offered), accounts
 * already on the agent's device (they take no new slot), then the others.
 * Within a group, choosable accounts come first, then by label.
 */
export function buildAccountSelectGroups(input: {
  options: readonly CompanyAiAccountOption[];
  canBindAny: boolean;
  includeDeviceLogin?: boolean;
  /**
   * The caller may switch the agent to the device's own login; defaults to
   * `canBindAny`. Otherwise the option stays visible, disabled, with the
   * reason (see `canChooseDeviceLogin`).
   */
  canSetDeviceLogin?: boolean;
  /**
   * The agent's AI connection while the agent has no Claude account
   * selection, named as the AI connection picker names it. It is offered
   * only then: once the agent has an account or the device's own login, it
   * cannot be chosen again here.
   */
  currentAiConnection?: { label: string } | null;
  now?: Date;
}): AccountSelectGroup[] {
  const now = input.now ?? new Date();
  const build = (option: CompanyAiAccountOption): AccountSelectOption => {
    const disabledReason = accountUnselectableReason(option, input.canBindAny);
    const owner = ownerText(option);
    return {
      key: `${ACCOUNT_VALUE_PREFIX}${option.id}`,
      value: `${ACCOUNT_VALUE_PREFIX}${option.id}`,
      label: option.label,
      searchText: [owner, option.plan, POOL_CREDENTIAL_TYPE_LABELS[option.credentialType]].filter(Boolean).join(" "),
      disabled: disabledReason !== null,
      account: option,
      stateDisplay: aiAccountStateDisplay(option, now),
      ownerText: owner,
      disabledReason,
      warning: disabledReason === null ? accountWarning(option, now) : null,
      description: null,
    };
  };
  const order = (a: AccountSelectOption, b: AccountSelectOption) =>
    Number(a.disabled) - Number(b.disabled) || a.label.localeCompare(b.label);
  const onDevice = input.options.filter((option) => option.onAgentDevice === true).map(build).sort(order);
  const others = input.options.filter((option) => option.onAgentDevice !== true).map(build).sort(order);

  const groups: AccountSelectGroup[] = [];
  if (input.currentAiConnection) {
    groups.push({
      id: "ai-connection",
      label: "AI connection",
      options: [{
        key: AI_CONNECTION_SELECT_VALUE,
        value: AI_CONNECTION_SELECT_VALUE,
        label: input.currentAiConnection.label,
        searchText: "ai connection",
        disabled: false,
        account: null,
        stateDisplay: null,
        ownerText: null,
        disabledReason: null,
        warning: null,
        description: CURRENT_AI_CONNECTION_OPTION_TEXT,
      }],
    });
  }
  if (input.includeDeviceLogin) {
    const deviceLoginReason = (input.canSetDeviceLogin ?? input.canBindAny) ? null : DEVICE_LOGIN_NOT_PERMITTED_TEXT;
    groups.push({
      id: "device-login",
      label: "Device",
      options: [{
        key: DEVICE_LOGIN_SELECT_VALUE,
        value: DEVICE_LOGIN_SELECT_VALUE,
        label: "Device's own login",
        searchText: "device login own",
        disabled: deviceLoginReason !== null,
        account: null,
        stateDisplay: null,
        ownerText: null,
        disabledReason: deviceLoginReason,
        warning: null,
        description: DEVICE_LOGIN_OPTION_TEXT,
      }],
    });
  }
  if (onDevice.length > 0) groups.push({ id: "on-device", label: "Already on this device", options: onDevice });
  if (others.length > 0) {
    groups.push({ id: "other", label: onDevice.length > 0 ? "Other accounts" : "Claude accounts", options: others });
  }
  return groups;
}
