/**
 * Fork: an agent's Claude account, as the agent page card, the overview rows,
 * the Claude accounts page's agent assignments and the AI connection field
 * show it, so each names a device or a selection the same way. A Claude agent
 * uses one pool account, or explicitly its device's own login. A change
 * applies from the agent's next run and never touches a running one.
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
  CompanyAiAccountOption,
  EnvironmentAvailabilitySummary,
  ExecutionDeviceRef,
  ResourceWaitReason,
  SetAgentAiAccount,
  SetAgentAiAccountResponse,
} from "@paperclipai/shared";
import { AI_ACCOUNT_POOL_ERROR_CODES, isResourceWaitRetryReason } from "@paperclipai/shared";
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

/** Why the card's selector is read-only for this person. */
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

/**
 * The note on the AI connection field while a Claude account selection exists:
 * the selection, not the field, decides the agent's credential.
 */
export function aiConnectionOverrideText(
  binding: Pick<AgentAiAccountBindingSummary, "supported" | "mode" | "state" | "account">,
): string | null {
  if (!binding.supported || binding.mode === null) return null;
  const selection = binding.mode === "device_login"
    ? "This agent uses its device's own login."
    : binding.state === "pool_account" && binding.account
      ? `This agent uses the Claude account ${binding.account.label}.`
      : binding.state === "account_unavailable"
        ? "This agent is assigned an account that is no longer available in this company."
        : "This agent waits until a Claude account is chosen for it.";
  return `${selection} The AI connection below applies only if that selection is cleared in the Claude account section.`;
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
