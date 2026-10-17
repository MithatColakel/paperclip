/**
 * Fork: an agent's Claude account, as the agent's Claude account field, the
 * overview rows, the Claude accounts page's agent assignments and the AI
 * connection field show it, so each names a device or a selection the same
 * way. A Claude agent uses one pool account, or explicitly its device's own
 * login. A change applies from the agent's next run and never touches a
 * running one.
 *
 * Product rule: Paperclip never moves a task to another account. When an
 * account hits its limit, its tasks wait for the reset.
 */
import type {
  AgentAiAccountBindingSummary,
  AiAccountBindingAccountRef,
  AiAccountBindingState,
  AiAccountState,
  AiAccountUnselectableReason,
  AiConnectionList,
  AiRuntimeConnectionBinding,
  CompanyAiAccountOption,
  EnvironmentAvailabilitySummary,
  ExecutionDeviceRef,
  ResourceWaitReason,
  SetAgentAiAccount,
  SetAgentAiAccountResponse,
} from "@paperclipai/shared";
import {
  AI_ACCOUNT_POOL_ERROR_CODES,
  POOL_RUN_AUTH_ENV_KEYS,
  aiRuntimeConnectionBindingSchema,
  isResourceWaitRetryReason,
} from "@paperclipai/shared";
import { AI_CONNECTION_STATUS, AI_PROVIDERS, personalAiDefault } from "@/components/ai-connections/model";
import { CLAUDE_OAUTH_TOKEN_ENV_KEY } from "@/components/environment-variables-editor/model";
import {
  accountSelectValueFromBinding,
  aiAccountPoolErrorMessage,
  aiAccountSelectionWarningText,
  deviceAvailabilityDisplay,
  deviceOwnerText,
  readAiAccountPoolError,
  type AccountSelectValue,
  type PoolBadgeTone,
} from "./ai-account-pool";

/** The only adapter a pool-account or device-login selection applies to. */
export const POOL_ACCOUNT_ADAPTER_TYPE = "claude_local";

export function usesPoolAccounts(adapterType: string | null | undefined): boolean {
  return adapterType === POOL_ACCOUNT_ADAPTER_TYPE;
}

/**
 * The router pools an AI connection field may offer. A router picks among
 * accounts on its own, so a `claude_local` agent gets no new router binding
 * (the server refuses one). A router the agent already uses stays listed, so
 * it can still be replaced.
 */
export function routerPoolsOffered<TPool extends { id: string }>(
  adapterType: string | null | undefined,
  value: { mode: string; connectionId?: string } | null | undefined,
  pools: readonly TPool[],
): TPool[] {
  if (!usesPoolAccounts(adapterType)) return [...pools];
  const current = value?.mode === "router" ? value.connectionId : undefined;
  return pools.filter((pool) => pool.id === current);
}

/** The hint under a router a `claude_local` agent still uses, in place of "New tasks rotate". */
export const CLAUDE_ROUTER_RETIRED_TEXT =
  "Router pools are retired for Claude agents: Paperclip never moves a task to another account. Choose an individual account, or set a Claude account on the agent page.";

/**
 * Whether an existing agent's configuration shows the Claude account field
 * in place of the AI connection field: its saved adapter and the adapter the
 * form shows are both `claude_local`. A form switched to another adapter
 * shows that adapter's AI connection until it is saved.
 */
export function showsClaudeAccountField(savedAdapterType: string | null | undefined, formAdapterType: string | null | undefined): boolean {
  return usesPoolAccounts(savedAdapterType) && usesPoolAccounts(formAdapterType);
}

/** "Build box — owner x@y.com". The owner is shown for display only and never decides where a run goes. */
export function deviceDisplayName(device: Pick<ExecutionDeviceRef, "name" | "owner">): string {
  const owner = deviceOwnerText(device.owner);
  return owner ? `${device.name} — ${owner}` : device.name;
}

/** The agent's device in a few words, for the overview row. */
export function agentDeviceSummary(binding: Pick<AgentAiAccountBindingSummary, "devices" | "pinned">): string {
  if (binding.devices.length === 0) return "Unknown";
  if (binding.pinned) return binding.devices.map(deviceDisplayName).join(", ");
  return binding.devices.length === 1
    ? `${deviceDisplayName(binding.devices[0]!)} (varies by project)`
    : `Varies by project (${binding.devices.length} devices)`;
}

/**
 * Where the agent's runs happen, to end a sentence: `on Build box`, or for an
 * agent without a pinned environment `on Build box (varies by project)` or
 * `on the device of each task's project`. Null while no device is known.
 */
export function agentDevicePhrase(binding: Pick<AgentAiAccountBindingSummary, "devices" | "pinned">): string | null {
  const names = binding.devices.map((device) => device.name);
  if (names.length === 0) return null;
  if (binding.pinned) return `on ${names.join(", ")}`;
  return names.length === 1 ? `on ${names[0]} (varies by project)` : "on the device of each task's project";
}

/**
 * A pool account in a sentence: `your Claude account My Pro`, `Ada's Claude
 * account Team Max`, or `Berna Manav's Claude account` when the label is
 * the owner's name.
 */
function poolAccountPhrase(account: Pick<AiAccountBindingAccountRef, "label" | "ownedByMe" | "ownerName">): string {
  const label = account.label.trim();
  if (account.ownedByMe) return `your Claude account ${label}`;
  const owner = account.ownerName?.trim();
  if (!owner) return `the Claude account ${label}`;
  return owner.localeCompare(label, undefined, { sensitivity: "base" }) === 0
    ? `${owner}'s Claude account`
    : `${owner}'s Claude account ${label}`;
}

/** The agent's AI connection while it applies, as the Claude account field shows it. */
export interface CurrentAiConnectionChoice {
  /** As the AI connection picker names it, e.g. "Responsible user's connection". */
  label: string;
  /** What the agent's runs use with it, in one sentence. */
  usage: string;
  /**
   * Behind a responsible-user connection, the viewer's own connection is
   * missing (`connect`) or not connected (`reconnect`), so the viewer's tasks
   * cannot run until it is fixed under Apps.
   */
  ownConnectionFix?: "connect" | "reconnect";
}

export const RESPONSIBLE_USER_CONNECTION_LABEL = "Responsible user's connection";

/** The agent's saved AI connection (`runtimeConfig.aiConnection`), or null without a readable one. */
export function agentAiConnection(runtimeConfig: unknown): AiRuntimeConnectionBinding | null {
  if (!runtimeConfig || typeof runtimeConfig !== "object") return null;
  return aiRuntimeConnectionBindingSchema.safeParse((runtimeConfig as { aiConnection?: unknown }).aiConnection).data ?? null;
}

/**
 * The agent's AI connection (`runtimeConfig.aiConnection`) while the agent
 * has no Claude account selection, so the connection is what its runs use.
 * The company's AI connections as this viewer reads them name a shared
 * connection, a pool, and the viewer's own default behind a
 * responsible-user connection (as the AI connection picker reads it);
 * without them the text stays general.
 */
export function currentAiConnectionChoice(
  connection: AiRuntimeConnectionBinding,
  context: {
    companyId: string;
    list?: Pick<AiConnectionList, "connections" | "currentUserId" | "pools"> | null;
    /** Where the runs happen, from `agentDevicePhrase`. */
    devicePhrase?: string | null;
  },
): CurrentAiConnectionChoice {
  const on = context.devicePhrase ? ` ${context.devicePhrase}` : "";
  const list = context.list ?? null;
  if (connection.mode === "router") {
    const pool = list?.pools?.find((entry) => entry.id === connection.connectionId);
    return {
      label: pool?.name ?? "Connection pool",
      usage: `Each new task takes an account from ${pool ? `the connection pool ${pool.name}` : "a connection pool"}. Pools are retired for Claude agents: choose a Claude account instead.`,
    };
  }
  const provider = AI_PROVIDERS[connection.provider].name;
  switch (connection.mode) {
    case "responsible_user": {
      const usage = `Each task uses the ${provider} connection of the person responsible for it`;
      if (!list) return { label: RESPONSIBLE_USER_CONNECTION_LABEL, usage: `${usage}: for your tasks, that is your own ${provider} connection.` };
      const mine = personalAiDefault(list.connections, { companyId: context.companyId, provider: connection.provider }, list.currentUserId);
      if (!mine) {
        return { label: RESPONSIBLE_USER_CONNECTION_LABEL, usage: `${usage}. You have not connected one yet.`, ownConnectionFix: "connect" };
      }
      if (mine.status === "connected") {
        return { label: RESPONSIBLE_USER_CONNECTION_LABEL, usage: `${usage}: for your tasks, that is ${mine.name}.` };
      }
      return {
        label: RESPONSIBLE_USER_CONNECTION_LABEL,
        usage: `${usage}: for your tasks, that is ${mine.name} (${AI_CONNECTION_STATUS[mine.status].toLowerCase()}).`,
        ownConnectionFix: "reconnect",
      };
    }
    case "shared": {
      const shared = list?.connections.find((entry) => entry.id === connection.connectionId);
      return shared
        ? { label: shared.name, usage: `Runs use the company-shared ${provider} connection ${shared.name}${on}.` }
        : { label: "Company shared connection", usage: `Runs use a company-shared ${provider} connection${on}.` };
    }
    case "delegated": {
      const delegated = list?.connections.find((entry) => entry.id === connection.connectionId);
      return delegated
        ? { label: delegated.name, usage: `Runs use the ${provider} connection ${delegated.name}${on}.` }
        : { label: "Delegated connection", usage: `Runs use a ${provider} connection shared with this agent${on}.` };
    }
    case "company_pool":
      return {
        label: "Company account pool (retired)",
        usage: "Runs stay on the company pool account they used last, and wait for its reset at a usage limit.",
      };
  }
}

/**
 * A Claude credential variable of the agent's own environment. Without a
 * Claude account or an AI connection, runs use it ahead of the device's own
 * login, and with the device's own login chosen it still applies; a pool
 * run blanks it and uses its account.
 */
export interface ClaudeEnvironmentCredential {
  key: (typeof POOL_RUN_AUTH_ENV_KEYS)[number];
  /**
   * A value each person saves under My secrets (a `user_secret_ref`), so a
   * run uses the one its responsible person saved; otherwise one value (a
   * plain value or a company secret) serves every run.
   */
  perPerson: boolean;
  /** The Claude login a Claude sign-in saves under My secrets (`CLAUDE_CODE_OAUTH_TOKEN`). */
  savedLogin: boolean;
  /** A run whose responsible person has not saved a value cannot start. */
  required: boolean;
}

/** The Claude credential variables the agent's own environment sets, e.g. a saved login bound to `CLAUDE_CODE_OAUTH_TOKEN`. */
export function claudeEnvironmentCredentials(env: unknown): ClaudeEnvironmentCredential[] {
  if (!env || typeof env !== "object" || Array.isArray(env)) return [];
  const bindings = env as Record<string, unknown>;
  return POOL_RUN_AUTH_ENV_KEYS.flatMap((key): ClaudeEnvironmentCredential[] => {
    const binding = bindings[key];
    const shared = { key, perPerson: false, savedLogin: false, required: false };
    if (typeof binding === "string") return binding.trim() ? [shared] : [];
    if (!binding || typeof binding !== "object") return [];
    const { type, value, key: secretKey, required, allowMissingOverride } = binding as Record<string, unknown>;
    if (type === "plain") return typeof value === "string" && value.trim() ? [shared] : [];
    if (type !== "user_secret_ref") return [shared];
    // As the server reads a user secret binding: required unless it says otherwise.
    return [{
      key,
      perPerson: true,
      savedLogin: secretKey === CLAUDE_OAUTH_TOKEN_ENV_KEY,
      required: required !== false && allowMissingOverride !== true,
    }];
  });
}

/** "A", "A and B", "A, B and C". */
function listText(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function variablesText(keys: readonly string[]): string {
  return `${listText(keys)} ${keys.length === 1 ? "variable" : "variables"}`;
}

/**
 * The agent's own Claude credentials in a sentence: one value for every run
 * (`the Claude credential in this agent's ANTHROPIC_API_KEY variable`), or
 * each task's responsible person's own (`the Claude login that the person
 * responsible for each task saved under My secrets (…)`).
 */
function environmentCredentialPhrase(credentials: readonly ClaudeEnvironmentCredential[]): string {
  const shared = credentials.filter((credential) => !credential.perPerson);
  const perPerson = credentials.filter((credential) => credential.perPerson);
  const phrases: string[] = [];
  if (shared.length > 0) {
    phrases.push(`the Claude credential in this agent's ${variablesText(shared.map((credential) => credential.key))}`);
  }
  if (perPerson.length > 0) {
    const what = perPerson.every((credential) => credential.savedLogin) ? "Claude login" : "Claude credential";
    const variables = variablesText(perPerson.map((credential) => credential.key));
    phrases.push(`the ${what} that the person responsible for each task saved under My secrets (this agent's ${variables})`);
  }
  return phrases.join(" and ");
}

/** The viewer's own saved Claude login, while the agent's runs use each responsible person's. */
function savedLoginStatusText(credentials: readonly ClaudeEnvironmentCredential[], saved: boolean | null | undefined): string {
  const login = credentials.find((credential) => credential.savedLogin);
  if (!login || saved == null) return "";
  if (saved) return " Your Claude login is saved.";
  return login.required
    ? " You have not saved a Claude login, so your tasks cannot run until you save one under My secrets or choose a Claude account above."
    : " You have not saved a Claude login.";
}

/**
 * What the agent's runs use now, under the Claude account field's picker.
 * `aiConnection` is the agent's AI connection while it applies (the agent has
 * no selection); `environmentCredentials` are the Claude credential variables
 * of the agent's own environment; `savedClaudeLogin` is whether the viewer
 * has saved a Claude login under My secrets (null while unknown). With the
 * device's own login chosen, a credential variable still applies, so the
 * text names the variables to remove.
 */
export function agentClaudeAccountUsageText(
  binding: Pick<AgentAiAccountBindingSummary, "state" | "account" | "devices" | "pinned">,
  context: {
    aiConnection?: Pick<CurrentAiConnectionChoice, "usage"> | null;
    environmentCredentials?: readonly ClaudeEnvironmentCredential[];
    savedClaudeLogin?: boolean | null;
  } = {},
): string {
  const where = agentDevicePhrase(binding);
  const on = where ? ` ${where}` : "";
  const credentials = context.environmentCredentials ?? [];
  switch (binding.state) {
    case "pool_account":
      return `Runs use ${binding.account ? poolAccountPhrase(binding.account) : "a Claude account"}${on}.`;
    case "device_login":
      if (credentials.length === 0) return `Runs use the device's own Claude login${on}.`;
      return `Runs use ${environmentCredentialPhrase(credentials)}${on}, not the device's own login. `
        + `To use the device's own login, remove ${listText(credentials.map((credential) => credential.key))} under Environment variables.`;
    case "unbound":
      if (context.aiConnection) return context.aiConnection.usage;
      if (credentials.length === 0) return `No account is chosen, so runs use the device's own Claude login${on}.`;
      return `No account is chosen, so runs use ${environmentCredentialPhrase(credentials)}${on}.`
        + savedLoginStatusText(credentials, context.savedClaudeLogin);
    case "unassigned":
      return "No account is chosen, so runs wait until one is.";
    case "account_unavailable":
      return "The chosen account is no longer available in this company, so runs wait until another one is chosen.";
  }
}

export interface DeviceAvailabilityNote {
  deviceId: string;
  state: EnvironmentAvailabilitySummary["state"];
  label: string;
  tone: PoolBadgeTone;
}

/**
 * The overview's note for each of the agent's devices that is not available,
 * e.g. `Offline since 13:02`, named by its device when there are several. A
 * device without a known availability gets no note.
 */
export function deviceAvailabilityNotes(
  devices: readonly Pick<ExecutionDeviceRef, "id" | "name">[],
  availabilityById: ReadonlyMap<string, EnvironmentAvailabilitySummary>,
  now?: Date,
): DeviceAvailabilityNote[] {
  return devices.flatMap((device) => {
    const availability = availabilityById.get(device.id);
    if (!availability || availability.state === "available") return [];
    const display = deviceAvailabilityDisplay(availability, now);
    const label = devices.length === 1 ? display.label : `${device.name}: ${display.label}`;
    return [{ deviceId: device.id, state: availability.state, label, tone: display.tone }];
  });
}

/** An agent's selection in a few words, for rows and chips. */
export const AI_ACCOUNT_BINDING_STATE_SHORT_TEXT: Record<AiAccountBindingState, string> = {
  unbound: "Not set",
  device_login: "Device's own login",
  pool_account: "Claude account",
  unassigned: "None chosen",
  account_unavailable: "No longer available",
};

/** Whether a pick is what the agent already has, so picking it again saves nothing. */
export function isCurrentSelection(
  selection: SetAgentAiAccount,
  binding: Pick<AgentAiAccountBindingSummary, "mode" | "account">,
): boolean {
  if (selection.mode === "device_login") return binding.mode === "device_login";
  return binding.mode === "pool_account" && binding.account?.id === selection.accountId;
}

/** Never an account id (those are UUIDs): stands for an account this company can no longer see. */
const UNAVAILABLE_ACCOUNT_SELECT_ID = "unavailable";

/**
 * The picker value of an agent's binding. A binding to an account that is no
 * longer available in this company names that, rather than "No account chosen".
 */
export function accountSelectValueForBinding(
  binding: Pick<AgentAiAccountBindingSummary, "state" | "mode" | "account">,
): AccountSelectValue {
  if (binding.state === "account_unavailable") return { mode: "pool_account", accountId: UNAVAILABLE_ACCOUNT_SELECT_ID };
  return accountSelectValueFromBinding(binding);
}

/** Why the agent's current account cannot be chosen again, by its state. */
const CURRENT_ACCOUNT_REASON: Partial<Record<AiAccountState, AiAccountUnselectableReason>> = {
  signed_out: "signed_out",
  withdrawn: "withdrawn",
  admin_disabled: "withdrawn",
};

/**
 * The picker's options with the agent's current account kept in them. The
 * company's list leaves out an account that is paused or switched off (and
 * has no rows before it loads), so the picker would call the agent's own
 * account unavailable; this names it instead.
 */
export function accountOptionsWithCurrent(
  options: readonly CompanyAiAccountOption[],
  account: AiAccountBindingAccountRef | null,
): readonly CompanyAiAccountOption[] {
  if (!account || options.some((option) => option.id === account.id)) return options;
  const reason = CURRENT_ACCOUNT_REASON[account.state] ?? null;
  return [
    ...options,
    {
      id: account.id,
      label: account.label,
      credentialType: account.credentialType,
      plan: null,
      owner: { userId: "", name: account.ownerName, email: null },
      ownedByMe: account.ownedByMe,
      state: account.state,
      exhaustedUntil: account.exhaustedUntil,
      limitSource: account.limitSource,
      canBind: true,
      agents: [],
      devices: [],
      selectable: reason ? false : undefined,
      reason,
    },
  ];
}

/** Why the Claude account field's picker is read-only for this person. */
export const AGENT_CLAUDE_ACCOUNT_LOCKED_TEXT =
  "Only a company admin, or the owner of the account this agent uses, can change it.";

/**
 * The account wait the agent's next run would hit, read from its selection in
 * the order the server checks them, or null. An account that is no longer
 * available in this company has no reason here: the company cannot see why.
 */
export function bindingWaitReason(
  binding: Pick<AgentAiAccountBindingSummary, "supported" | "mode" | "state" | "account" | "devices">,
): ResourceWaitReason | null {
  if (!binding.supported || binding.mode !== "pool_account") return null;
  if (binding.state === "unassigned") return "unassigned";
  if (binding.state !== "pool_account" || !binding.account) return null;
  if (binding.account.state === "admin_disabled" || binding.account.state === "withdrawn") return "withdrawn";
  if (binding.account.state === "signed_out") return "signed_out";
  if (binding.devices.length === 0) return "device_unknown";
  if (binding.account.state === "limited") return "usage_limit";
  return null;
}

/** A limit resolves on its own; every other account wait needs a person first. */
export function bindingWaitTone(reason: ResourceWaitReason): "info" | "warning" {
  return reason === "usage_limit" || reason === "credit_balance" ? "info" : "warning";
}

interface WaitRunLike {
  status: string;
  scheduledRetryReason?: string | null;
  createdAt: string | Date;
}

/**
 * The agent's newest run that is waiting in a resource-wait lane, and how many
 * of its runs wait. A deferral's successor is re-armed in place, so the
 * newest waiting run is the current wait.
 */
export function currentResourceWaitRun<TRun extends WaitRunLike>(
  runs: readonly TRun[],
): { run: TRun; waiting: number } | null {
  const waiting = runs.filter(
    (run) => run.status === "scheduled_retry" && isResourceWaitRetryReason(run.scheduledRetryReason),
  );
  if (waiting.length === 0) return null;
  const newest = waiting.reduce((latest, run) =>
    new Date(run.createdAt).getTime() > new Date(latest.createdAt).getTime() ? run : latest,
  );
  return { run: newest, waiting: waiting.length };
}

/** The toast after a selection is saved: when it applies, plus the warning of a limited account. */
export function bindingSavedToast(
  response: Pick<SetAgentAiAccountResponse, "runningRunIds" | "warnings" | "account">,
  now: Date = new Date(),
): { title: string; body: string; tone: "success" | "warn" } {
  const running = response.runningRunIds.length;
  const applies = running === 0
    ? "Applies from the agent's next run."
    : running === 1
      ? "Applies from the next run; the current run keeps its account."
      : `Applies from the next run; the ${running} current runs keep their account.`;
  const warnings = response.warnings.map((warning) => aiAccountSelectionWarningText(warning, response.account ?? {}, now));
  return {
    title: "Claude account saved",
    body: [applies, ...warnings].join(" "),
    tone: warnings.length > 0 ? "warn" : "success",
  };
}

const AI_ACCOUNT_POOL_ERROR_CODE_SET: ReadonlySet<string> = new Set(AI_ACCOUNT_POOL_ERROR_CODES);

/**
 * The sentence for a refusal of the account pool rules from a route outside
 * the pool's own, e.g. an agent save whose environment change would break
 * its Claude account selection (spec 5.6); null for any other error.
 */
export function aiAccountPoolRefusalMessage(error: unknown): string | null {
  const code = readAiAccountPoolError(error)?.code;
  if (!code || !AI_ACCOUNT_POOL_ERROR_CODE_SET.has(code)) return null;
  if (code === "placement_conflict") {
    return "Someone changed this agent's environment at the same time. Reload the agent and try again.";
  }
  return aiAccountPoolErrorMessage(error);
}
