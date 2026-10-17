// @vitest-environment jsdom

import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RESOURCE_WAIT_ERROR_CODE_BY_KIND,
  type AgentAiAccountBindingDetail,
  type AiAccountBindingAccountRef,
  type CompanyAiAccountOption,
  type EnvironmentAvailabilitySummary,
  type ExecutionDeviceRef,
  type ExecutionDeviceSummary,
  type HeartbeatRun,
  type ResourceWaitContext,
  type SetAgentAiAccountResponse,
} from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import {
  AGENT_CLAUDE_ACCOUNT_LOCKED_TEXT,
  accountOptionsWithCurrent,
  accountSelectValueForBinding,
  agentDeviceSummary,
  aiAccountPoolRefusalMessage,
  aiConnectionOverrideText,
  bindingSavedToast,
  bindingWaitReason,
  currentResourceWaitRun,
  deviceAvailabilityNotes,
  deviceDisplayName,
  isCurrentSelection,
  routerPoolsOffered,
} from "@/lib/agent-claude-account";
import {
  AI_ACCOUNT_BINDING_STATE_TEXT,
  AI_ACCOUNT_UNSELECTABLE_REASON_TEXT,
  DEVICE_LOGIN_NOT_PERMITTED_TEXT,
  aiAccountPoolErrorMessage,
} from "@/lib/ai-account-pool";
import { resourceWaitReasonText } from "@/lib/resource-wait";
import { AgentClaudeAccountCard, AgentClaudeAccountOverviewRows, AiConnectionOverrideNote } from "./AgentClaudeAccountCard";
import { RunResourceWaitBadge } from "./RunResourceWaitBadge";

const poolApi = vi.hoisted(() => ({
  getAgentBinding: vi.fn(),
  setAgentBinding: vi.fn(),
  clearAgentBinding: vi.fn(),
  reviewAgentBinding: vi.fn(),
  listCompanyAccounts: vi.fn(),
}));
const invalidatePool = vi.hoisted(() => vi.fn(async () => undefined));
const runsApi = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));
const devicesApi = vi.hoisted(() => ({ list: vi.fn() }));
const pushToast = vi.hoisted(() => vi.fn());

vi.mock("@/api/ai-account-pool", async () => {
  const actual = await vi.importActual<typeof import("@/api/ai-account-pool")>("@/api/ai-account-pool");
  return { ...actual, aiAccountPoolApi: poolApi, invalidateAiAccountPoolQueries: invalidatePool };
});
vi.mock("@/api/execution-devices", async () => {
  const actual = await vi.importActual<typeof import("@/api/execution-devices")>("@/api/execution-devices");
  return { ...actual, executionDevicesApi: devicesApi };
});
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: runsApi }));
vi.mock("@/context/ToastContext", () => ({
  useToastActions: () => ({ pushToast, dismissToast: vi.fn(), clearToasts: vi.fn() }),
}));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string } & ComponentProps<"a">) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Local times, so the expectations hold in any time zone.
const NOW = new Date(2026, 9, 16, 12, 0);
const TODAY_18 = new Date(2026, 9, 16, 18, 0);

const AGENT = { id: "agent-1", name: "Coder", companyId: "company-1", adapterType: "claude_local" };
const CODEX_AGENT = { ...AGENT, adapterType: "codex_local" };

const BUILD_BOX: ExecutionDeviceRef = {
  id: "device-1",
  name: "Build box",
  kind: "ssh_host",
  owner: { userId: "user-ada", name: "Ada", email: "ada@example.com" },
};
const SERVER: ExecutionDeviceRef = { id: "device-2", name: "Paperclip server", kind: "server", owner: null };
const STUDIO: ExecutionDeviceRef = { id: "device-3", name: "Studio", kind: "external", owner: null };

const AVAILABLE: EnvironmentAvailabilitySummary = {
  state: "available",
  reason: null,
  label: null,
  message: null,
  unavailableSince: null,
  retryAfter: null,
  checkedAt: null,
  acceptedCredentialTypes: null,
};
const OFFLINE: EnvironmentAvailabilitySummary = {
  ...AVAILABLE,
  state: "unavailable",
  reason: "offline",
  unavailableSince: new Date(2026, 9, 16, 11, 30).toISOString(),
};
const RETIRED: EnvironmentAvailabilitySummary = { ...AVAILABLE, state: "retired" };

/** The company's device list entry of a device, as the Devices page reads it. */
function deviceSummary(device: ExecutionDeviceRef, availability: EnvironmentAvailabilitySummary): ExecutionDeviceSummary {
  return {
    ...device,
    managedByPluginId: null,
    managedByPluginName: null,
    limit: 3,
    inUse: 1,
    overLimit: false,
    overLimitSince: null,
    availability,
    environments: [],
    accounts: [],
    otherCompaniesAccounts: 0,
    agents: [],
    ownLoginAgents: 0,
    acceptedCredentialTypes: null,
    duplicateHints: [],
    waitingCount: 0,
  };
}

function option(overrides: Partial<CompanyAiAccountOption> = {}): CompanyAiAccountOption {
  return {
    id: "acct-team",
    label: "Team Max",
    credentialType: "subscription",
    plan: "Max",
    owner: { userId: "user-ada", name: "Ada", email: "ad•••@example.com" },
    ownedByMe: false,
    state: "active",
    exhaustedUntil: null,
    limitSource: null,
    canBind: true,
    agents: [],
    devices: [],
    selectable: true,
    reason: null,
    warning: null,
    ...overrides,
  };
}

const TEAM = option();
const MINE = option({ id: "acct-mine", label: "My Pro", ownedByMe: true, owner: { userId: "me", name: "Me", email: "me@example.com" } });

function accountRef(overrides: Partial<AiAccountBindingAccountRef> = {}): AiAccountBindingAccountRef {
  return {
    id: "acct-team",
    label: "Team Max",
    credentialType: "subscription",
    state: "active",
    ownedByMe: false,
    ownerName: "Ada",
    exhaustedUntil: null,
    limitSource: null,
    ...overrides,
  };
}

function binding(overrides: Partial<AgentAiAccountBindingDetail> = {}): AgentAiAccountBindingDetail {
  return {
    agentId: AGENT.id,
    agentName: AGENT.name,
    companyId: AGENT.companyId,
    adapterType: "claude_local",
    supported: true,
    state: "unbound",
    mode: null,
    account: null,
    source: null,
    migrationNote: null,
    reviewedAt: null,
    needsReview: false,
    devices: [BUILD_BOX],
    pinned: true,
    overridesAiConnection: false,
    canChange: true,
    updatedAt: null,
    options: [TEAM, MINE],
    canBindAny: true,
    ...overrides,
  };
}

const ON_TEAM = { state: "pool_account" as const, mode: "pool_account" as const, account: accountRef() };
const ON_MINE = {
  state: "pool_account" as const,
  mode: "pool_account" as const,
  account: accountRef({ id: "acct-mine", label: "My Pro", ownedByMe: true, ownerName: "Me" }),
};

function setResponse(overrides: Partial<SetAgentAiAccountResponse> = {}): SetAgentAiAccountResponse {
  const { options: _options, canBindAny: _canBindAny, ...summary } = binding(ON_MINE);
  return { ...summary, appliesFrom: "next_run", runningRunIds: [], warnings: [], ...overrides };
}

function run(overrides: Partial<HeartbeatRun> = {}): HeartbeatRun {
  return {
    id: "run-1",
    companyId: AGENT.companyId,
    agentId: AGENT.id,
    invocationSource: "assignment",
    triggerDetail: null,
    status: "succeeded",
    responsibleUserId: null,
    startedAt: null,
    finishedAt: null,
    error: null,
    wakeupRequestId: null,
    exitCode: null,
    signal: null,
    usageJson: null,
    resultJson: null,
    sessionIdBefore: null,
    sessionIdAfter: null,
    logStore: null,
    logRef: null,
    logBytes: null,
    logSha256: null,
    logCompressed: false,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    errorCode: null,
    externalRunId: null,
    processPid: null,
    processStartedAt: null,
    lastOutputAt: null,
    lastOutputSeq: 0,
    lastOutputStream: null,
    lastOutputBytes: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    livenessState: null,
    livenessReason: null,
    continuationAttempt: 0,
    lastUsefulActionAt: null,
    nextAction: null,
    contextSnapshot: null,
    createdAt: new Date(2026, 9, 16, 11, 0),
    updatedAt: new Date(2026, 9, 16, 11, 0),
    ...overrides,
  } as HeartbeatRun;
}

function waitContext(overrides: Partial<ResourceWaitContext> = {}): ResourceWaitContext {
  return {
    version: 1,
    episodeId: "episode-1",
    kind: "ai_account",
    reason: "usage_limit",
    scope: "account",
    environmentId: null,
    environmentName: null,
    deviceId: null,
    deviceName: null,
    accountId: "acct-team",
    accountLabel: "Team Max",
    resumeAt: TODAY_18.toISOString(),
    resumeAtSource: "estimated",
    message: null,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root | null;
let originalResizeObserver: typeof ResizeObserver | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  poolApi.listCompanyAccounts.mockResolvedValue({ accounts: [TEAM, MINE], canBindAny: true });
  runsApi.list.mockResolvedValue([]);
  devicesApi.list.mockResolvedValue({ limitPerDevice: 3, devices: [] });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = null;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  globalThis.ResizeObserver = originalResizeObserver!;
  container.remove();
  document.body.innerHTML = "";
});

async function settle() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  root = createRoot(container);
  await act(async () => {
    root!.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  });
  await settle();
  return client;
}

async function renderCard(detail: AgentAiAccountBindingDetail, agent: typeof AGENT = AGENT) {
  poolApi.getAgentBinding.mockResolvedValue(detail);
  return render(<AgentClaudeAccountCard agent={agent} now={NOW} />);
}

function trigger() {
  return container.querySelector<HTMLButtonElement>("button[role='combobox']");
}

async function openSelect() {
  await act(async () => {
    trigger()?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function item(text: string) {
  return Array.from(document.querySelectorAll("[cmdk-item]")).find((element) => element.textContent?.includes(text));
}

async function choose(text: string) {
  await openSelect();
  await act(async () => {
    item(text)?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
}

function button(text: string) {
  return Array.from(container.querySelectorAll("button")).find((element) => element.textContent === text);
}

async function click(text: string) {
  const target = button(text);
  expect(target, `Missing button: ${text}`).toBeDefined();
  await act(async () => {
    target!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
}

function alerts() {
  return Array.from(container.querySelectorAll("[role='alert']")).map((element) => element.textContent);
}

describe("AgentClaudeAccountCard", () => {
  it("renders every binding state, with the wait its next run would hit", async () => {
    await renderCard(binding());
    expect(container.querySelector("[data-binding-state='unbound']")?.textContent).toBe(AI_ACCOUNT_BINDING_STATE_TEXT.unbound);
    expect(trigger()?.textContent).toContain("Choose a Claude account");
    expect(container.querySelector("[role='note']")).toBeNull();
    expect(button("Clear")).toBeUndefined();
    await act(async () => root?.unmount());

    await renderCard(binding({ state: "device_login", mode: "device_login" }));
    expect(container.querySelector("[data-binding-state='device_login']")?.textContent).toBe("Device's own login");
    expect(trigger()?.textContent).toContain("Device's own login");
    await act(async () => root?.unmount());

    await renderCard(binding(ON_TEAM));
    expect(trigger()?.textContent).toContain("Team Max");
    const state = container.querySelector("[data-binding-state='pool_account']");
    expect(state?.textContent).toContain("Owner: Ada");
    expect(state?.textContent).toContain("Subscription");
    expect(state?.querySelector("[data-account-state='active']")?.textContent).toBe("Active");
    await act(async () => root?.unmount());

    await renderCard(binding({ state: "unassigned", mode: "pool_account", account: null }));
    expect(container.querySelector("[data-binding-state='unassigned']")?.textContent).toBe(AI_ACCOUNT_BINDING_STATE_TEXT.unassigned);
    expect(trigger()?.textContent).toContain("No account chosen");
    expect(container.textContent).toContain("Tasks wait: no account chosen");
    expect(container.textContent).toContain(resourceWaitReasonText("unassigned"));
    await act(async () => root?.unmount());

    await renderCard(binding({ state: "account_unavailable", mode: "pool_account", account: null }));
    expect(container.querySelector("[data-binding-state='account_unavailable']")?.textContent)
      .toBe(AI_ACCOUNT_BINDING_STATE_TEXT.account_unavailable);
    // The picker names it as the Claude accounts page does, not as "No account chosen".
    expect(trigger()?.textContent).toContain(AI_ACCOUNT_BINDING_STATE_TEXT.account_unavailable);
    expect(trigger()?.textContent).not.toContain("No account chosen");
    expect(container.textContent).toContain("The account is no longer available in this company");
    // The company cannot see the account, so it is never named.
    expect(container.textContent).not.toContain("Team Max");
    await act(async () => root?.unmount());

    await renderCard(binding({
      ...ON_TEAM,
      account: accountRef({ state: "limited", exhaustedUntil: TODAY_18.toISOString(), limitSource: "estimated" }),
    }));
    expect(container.querySelector("[data-account-state='limited']")?.textContent).toBe("Limited until 18:00 (estimated)");
    expect(container.textContent).toContain("Tasks wait: usage limit");
    expect(container.textContent).toContain("Paperclip never moves a task to another account");
  });

  it("shows the device and its owner for display only", async () => {
    await renderCard(binding(ON_TEAM));
    const device = container.querySelector("[data-device='device-1']");
    expect(device?.textContent).toContain("Build box — owner ada@example.com");
    expect(device?.textContent).toContain("SSH host");
    expect(container.textContent).toContain("Device");
    await act(async () => root?.unmount());

    await renderCard(binding({ ...ON_TEAM, pinned: false, devices: [BUILD_BOX, SERVER] }));
    expect(container.textContent).toContain("Devices (varies by project)");
    expect(container.querySelector("[data-device='device-2']")?.textContent).toContain("Paperclip server");
    expect(container.textContent).toContain("its device depends on the task's project");
    await act(async () => root?.unmount());

    // A pool account on an agent without a known device waits until the device is known.
    devicesApi.list.mockClear();
    await renderCard(binding({ ...ON_TEAM, devices: [] }));
    expect(container.textContent).toContain("Unknown");
    expect(container.textContent).toContain("Tasks wait: device unknown");
    expect(devicesApi.list).not.toHaveBeenCalled();
  });

  it("shows each device's availability from the company's device list", async () => {
    devicesApi.list.mockResolvedValue({
      limitPerDevice: 3,
      devices: [deviceSummary(BUILD_BOX, AVAILABLE), deviceSummary(SERVER, OFFLINE), deviceSummary(STUDIO, RETIRED)],
    });
    await renderCard(binding({ ...ON_TEAM, pinned: false, devices: [BUILD_BOX, SERVER, STUDIO] }));
    expect(devicesApi.list).toHaveBeenCalledWith(AGENT.companyId);
    const badge = (deviceId: string) => container.querySelector(`[data-device='${deviceId}'] [data-device-availability]`);
    expect(badge(BUILD_BOX.id)?.textContent).toBe("Available");
    expect(badge(BUILD_BOX.id)?.getAttribute("data-device-availability")).toBe("available");
    expect(badge(SERVER.id)?.textContent).toBe("Offline since 11:30");
    expect(badge(SERVER.id)?.getAttribute("data-device-availability")).toBe("unavailable");
    expect(badge(STUDIO.id)?.textContent).toBe("Removed");
    expect(badge(STUDIO.id)?.getAttribute("data-device-availability")).toBe("retired");
  });

  it("shows no availability for a device the list leaves out, or when the list fails", async () => {
    devicesApi.list.mockResolvedValue({ limitPerDevice: 3, devices: [deviceSummary(SERVER, OFFLINE)] });
    await renderCard(binding({ ...ON_TEAM, pinned: false, devices: [BUILD_BOX, SERVER] }));
    expect(container.querySelector(`[data-device='${BUILD_BOX.id}'] [data-device-availability]`)).toBeNull();
    expect(container.querySelector(`[data-device='${SERVER.id}'] [data-device-availability]`)?.textContent)
      .toBe("Offline since 11:30");
    await act(async () => root?.unmount());

    devicesApi.list.mockRejectedValue(new ApiError("Forbidden", 403, { error: "Forbidden" }));
    await renderCard(binding(ON_TEAM));
    expect(container.querySelector("[data-device-availability]")).toBeNull();
    expect(container.querySelector(`[data-device='${BUILD_BOX.id}']`)?.textContent).toContain("Build box — owner ada@example.com");
    expect(alerts()).toEqual([]);
  });

  it.each([
    ["403", new ApiError("Forbidden", 403, { error: "Forbidden", code: "ai_account_binding_forbidden" })],
    ["409", new ApiError("Device account limit", 409, {
      error: "Device account limit",
      code: "device_account_limit",
      details: {
        code: "device_account_limit",
        deviceId: "device-1",
        deviceName: "Build box",
        limit: 3,
        inUse: 3,
        accounts: ["Team Max"],
        otherCompaniesAccounts: 2,
      },
    })],
    ["422", new ApiError("Incompatible", 422, {
      error: "Incompatible",
      code: "ai_account_incompatible",
      details: { code: "ai_account_incompatible", reason: "credential_type_unsupported", deviceName: "Build box" },
    })],
  ])("shows a %s refusal inline, with no toast", async (_status, error) => {
    poolApi.setAgentBinding.mockRejectedValue(error);
    await renderCard(binding(ON_TEAM));
    await choose("My Pro");
    expect(poolApi.setAgentBinding).toHaveBeenCalledWith(AGENT.id, { mode: "pool_account", accountId: "acct-mine" });
    expect(alerts()).toContain(aiAccountPoolErrorMessage(error));
    expect(pushToast).not.toHaveBeenCalled();
    expect(invalidatePool).not.toHaveBeenCalled();
  });

  it("shows other companies' accounts as a count only in a device limit refusal", async () => {
    poolApi.setAgentBinding.mockRejectedValue(new ApiError("Device account limit", 409, {
      code: "device_account_limit",
      details: { code: "device_account_limit", deviceName: "Build box", limit: 3, inUse: 3, accounts: ["Team Max"], otherCompaniesAccounts: 2 },
    }));
    await renderCard(binding(ON_TEAM));
    await choose("My Pro");
    expect(alerts().join(" ")).toContain("Build box already runs 3 of 3 Claude accounts (Team Max, 2 accounts of other companies)");
  });

  it("saves a choice, toasts when it applies and refreshes every pool query", async () => {
    poolApi.setAgentBinding.mockResolvedValue(setResponse({ runningRunIds: ["run-9"] }));
    await renderCard(binding(ON_TEAM));
    await choose("My Pro");
    expect(poolApi.setAgentBinding).toHaveBeenCalledWith(AGENT.id, { mode: "pool_account", accountId: "acct-mine" });
    expect(pushToast).toHaveBeenCalledWith({
      title: "Claude account saved",
      body: "Applies from the next run; the current run keeps its account.",
      tone: "success",
    });
    expect(invalidatePool).toHaveBeenCalled();
    // The card shows the saved choice at once.
    expect(trigger()?.textContent).toContain("My Pro");
    expect(alerts()).toEqual([]);
  });

  it("warns in the toast when the chosen account is at its limit", async () => {
    poolApi.setAgentBinding.mockResolvedValue(setResponse({
      account: accountRef({ id: "acct-mine", label: "My Pro", ownedByMe: true, state: "limited", exhaustedUntil: TODAY_18.toISOString(), limitSource: "provider" }),
      warnings: ["usage_limit"],
    }));
    await renderCard(binding(ON_TEAM));
    await choose("My Pro");
    expect(pushToast).toHaveBeenCalledWith({
      title: "Claude account saved",
      body: "Applies from the agent's next run. At its usage limit until 18:00. Tasks wait for the reset.",
      tone: "warn",
    });
  });

  it("does not save the account the agent already has", async () => {
    await renderCard(binding(ON_MINE));
    await choose("My Pro");
    expect(poolApi.setAgentBinding).not.toHaveBeenCalled();
  });

  it("offers the binding's own options for this agent, with the server's reason per account, and no second request", async () => {
    // The binding's options are this agent's: Team Max would take a new slot on a full device.
    await renderCard(binding({ ...ON_MINE, options: [option({ selectable: false, reason: "device_account_limit" }), MINE] }));
    await openSelect();
    expect(item("Team Max")?.getAttribute("aria-disabled")).toBe("true");
    expect(item("Team Max")?.textContent).toContain(AI_ACCOUNT_UNSELECTABLE_REASON_TEXT.device_account_limit);
    expect(item("My Pro")?.getAttribute("aria-disabled")).not.toBe("true");
    expect(poolApi.getAgentBinding).toHaveBeenCalledTimes(1);
    expect(poolApi.listCompanyAccounts).not.toHaveBeenCalled();
  });

  it("keeps the agent's own paused account named in the picker", async () => {
    // A paused account is not eligible, so the binding's options leave it out.
    await renderCard(binding({ ...ON_TEAM, account: accountRef({ state: "withdrawn" }), options: [MINE] }));
    expect(trigger()?.textContent).toContain("Team Max");
    expect(trigger()?.textContent).toContain("Paused by owner");
    expect(trigger()?.textContent).not.toContain(AI_ACCOUNT_BINDING_STATE_TEXT.account_unavailable);
    await openSelect();
    expect(item("Team Max")?.getAttribute("aria-disabled")).toBe("true");
  });

  it("is read-only for a person who may not change the assignment", async () => {
    await renderCard(binding({ ...ON_TEAM, canChange: false }));
    expect(trigger()?.disabled).toBe(true);
    expect(container.textContent).toContain(AGENT_CLAUDE_ACCOUNT_LOCKED_TEXT);
    expect(button("Clear")).toBeUndefined();
    expect(poolApi.listCompanyAccounts).not.toHaveBeenCalled();
  });

  it("offers an owner the device login only while the agent is on their own account (D4)", async () => {
    // Not a company admin: the binding says so itself.
    poolApi.setAgentBinding.mockResolvedValue(setResponse({ state: "device_login", mode: "device_login", account: null }));
    await renderCard(binding({ ...ON_MINE, canBindAny: false }));
    expect(poolApi.listCompanyAccounts).not.toHaveBeenCalled();
    expect(button("Clear")).toBeDefined();
    await openSelect();
    expect(item("Device's own login")?.getAttribute("aria-disabled")).not.toBe("true");
    await act(async () => {
      item("Device's own login")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(poolApi.setAgentBinding).toHaveBeenCalledWith(AGENT.id, { mode: "device_login" });
    await act(async () => root?.unmount());
    document.body.innerHTML = "";
    document.body.appendChild(container);

    await renderCard(binding({ canBindAny: false }));
    await openSelect();
    expect(item("Device's own login")?.getAttribute("aria-disabled")).toBe("true");
    expect(item("Device's own login")?.textContent).toContain(DEVICE_LOGIN_NOT_PERMITTED_TEXT);
    // The owner may still bind their own account to the unbound agent; another member's stays closed.
    expect(item("My Pro")?.getAttribute("aria-disabled")).not.toBe("true");
    expect(item("Team Max")?.getAttribute("aria-disabled")).toBe("true");
  });

  it("lets a company admin clear the selection", async () => {
    poolApi.clearAgentBinding.mockResolvedValue(undefined);
    await renderCard(binding({ state: "device_login", mode: "device_login" }));
    await click("Clear");
    expect(poolApi.clearAgentBinding).toHaveBeenCalledWith(AGENT.id);
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Claude account selection cleared", tone: "success" }));
    expect(invalidatePool).toHaveBeenCalled();
  });

  it("shows a refused clear inline", async () => {
    const error = new ApiError("Forbidden", 403, { code: "ai_account_binding_forbidden" });
    poolApi.clearAgentBinding.mockRejectedValue(error);
    await renderCard(binding(ON_TEAM));
    await click("Clear");
    expect(alerts()).toContain(aiAccountPoolErrorMessage(error));
    expect(pushToast).not.toHaveBeenCalled();
  });

  it("shows the agent's current wait from its newest waiting run", async () => {
    const waiting = run({
      id: "run-wait",
      status: "scheduled_retry",
      scheduledRetryReason: "ai_account_wait",
      createdAt: new Date(2026, 9, 16, 10, 0),
    });
    runsApi.list.mockResolvedValue([run({ id: "run-done" }), waiting]);
    runsApi.get.mockResolvedValue({ ...waiting, contextSnapshot: { resourceWait: waitContext() } });
    await renderCard(binding(ON_TEAM));
    expect(runsApi.list).toHaveBeenCalledWith(AGENT.companyId, AGENT.id, 25, { summary: true });
    expect(runsApi.get).toHaveBeenCalledWith("run-wait");
    expect(container.textContent).toContain("Waiting for Claude account Team Max: the usage limit resets at 18:00 (estimated)");
    expect(container.textContent).toContain(resourceWaitReasonText("usage_limit"));
  });

  it("names the lane while the waiting run's reason is still loading", async () => {
    runsApi.list.mockResolvedValue([run({ id: "run-wait", status: "scheduled_retry", scheduledRetryReason: "environment_wait" })]);
    runsApi.get.mockReturnValue(new Promise(() => {}));
    await renderCard(binding(ON_TEAM));
    expect(container.textContent).toContain("Waiting for a device");
    expect(container.textContent).toContain("Starts automatically when the device is available.");
  });

  it("asks a company admin to confirm a migrated assignment", async () => {
    poolApi.reviewAgentBinding.mockResolvedValue(binding(ON_TEAM));
    await renderCard(binding({ ...ON_TEAM, needsReview: true, source: "migrated_host_pool", migrationNote: "Used most by this agent in the last 45 days." }));
    expect(container.textContent).toContain("Used most by this agent in the last 45 days.");
    await click("Confirm");
    expect(poolApi.reviewAgentBinding).toHaveBeenCalledWith(AGENT.id);
    expect(invalidatePool).toHaveBeenCalled();
  });

  it("notes an overridden AI connection and repeats the product rule", async () => {
    await renderCard(binding({ ...ON_TEAM, overridesAiConnection: true }));
    expect(container.textContent).toContain("This selection overrides the AI connection set in the agent's configuration.");
    expect(container.textContent).toContain("Paperclip never moves a task to another account.");
    expect(container.querySelector("a[href='/company/settings/claude-accounts']")).not.toBeNull();
  });

  it("shows a load failure with a retry", async () => {
    poolApi.getAgentBinding.mockRejectedValueOnce(new ApiError("Not found", 404, { error: "Not found" }));
    await render(<AgentClaudeAccountCard agent={AGENT} now={NOW} />);
    expect(alerts().join(" ")).toContain("Not found");
    poolApi.getAgentBinding.mockResolvedValue(binding(ON_TEAM));
    await click("Try again");
    expect(trigger()?.textContent).toContain("Team Max");
  });

  it("stays hidden for another adapter unless a selection is left over", async () => {
    await renderCard(binding({ supported: false, adapterType: "codex_local" }), CODEX_AGENT);
    expect(container.innerHTML).toBe("");
    expect(runsApi.list).not.toHaveBeenCalled();
    // Nothing to remove, so no account list and no device list either.
    expect(poolApi.listCompanyAccounts).not.toHaveBeenCalled();
    expect(devicesApi.list).not.toHaveBeenCalled();
    await act(async () => root?.unmount());

    poolApi.clearAgentBinding.mockResolvedValue(undefined);
    await renderCard(binding({ ...ON_TEAM, supported: false, adapterType: "codex_local" }), CODEX_AGENT);
    expect(container.textContent).toContain("A Claude account selection is left over");
    expect(container.textContent).toContain("still counts toward its device's Claude account limit");
    // Whether the caller is a company admin comes with the binding: no account list is read.
    expect(poolApi.listCompanyAccounts).not.toHaveBeenCalled();
    await click("Remove");
    expect(poolApi.clearAgentBinding).toHaveBeenCalledWith(AGENT.id);
  });

  it("offers Remove on a left-over selection only to those who may clear it", async () => {
    await renderCard(binding({ ...ON_TEAM, supported: false, adapterType: "codex_local", canBindAny: false }), CODEX_AGENT);
    expect(container.textContent).toContain("A Claude account selection is left over");
    expect(button("Remove")).toBeUndefined();
    await act(async () => root?.unmount());

    // An owner may remove it while it is their own account.
    await renderCard(binding({ ...ON_MINE, supported: false, adapterType: "codex_local", canBindAny: false }), CODEX_AGENT);
    expect(button("Remove")).toBeDefined();
    await act(async () => root?.unmount());

    // A binding from a server that does not say whether the caller is a company admin: only the owner's rule applies.
    await renderCard(binding({ ...ON_TEAM, supported: false, adapterType: "codex_local", canBindAny: undefined }), CODEX_AGENT);
    expect(button("Remove")).toBeUndefined();
    expect(poolApi.listCompanyAccounts).not.toHaveBeenCalled();
  });
});

describe("AgentClaudeAccountOverviewRows", () => {
  const RUNTIME_HREF = "/agents/coder/runtime";

  function Row({ label, children }: { label: string; children: ReactNode }) {
    return <div data-row={label}>{children}</div>;
  }

  it("adds the Device and Claude account rows for a Claude agent", async () => {
    poolApi.getAgentBinding.mockResolvedValue(binding({
      ...ON_TEAM,
      account: accountRef({ state: "signed_out" }),
    }));
    await render(<AgentClaudeAccountOverviewRows agent={AGENT} Row={Row} now={NOW} />);
    expect(container.querySelector("[data-row='Device']")?.textContent).toBe("Build box — owner ada@example.com");
    const account = container.querySelector("[data-row='Claude account']");
    expect(account?.textContent).toContain("Team Max");
    expect(account?.querySelector("[data-account-state='signed_out']")?.textContent).toBe("Signed out");
  });

  it("marks a device that is not available, and nothing for an available one", async () => {
    devicesApi.list.mockResolvedValue({ limitPerDevice: 3, devices: [deviceSummary(BUILD_BOX, OFFLINE)] });
    poolApi.getAgentBinding.mockResolvedValue(binding(ON_TEAM));
    await render(<AgentClaudeAccountOverviewRows agent={AGENT} Row={Row} now={NOW} />);
    expect(devicesApi.list).toHaveBeenCalledWith(AGENT.companyId);
    const device = container.querySelector("[data-row='Device']");
    expect(device?.querySelector("[data-device-availability='unavailable']")?.textContent).toBe("Offline since 11:30");
    expect(device?.textContent).toBe("Build box — owner ada@example.comOffline since 11:30");
    await act(async () => root?.unmount());

    devicesApi.list.mockResolvedValue({ limitPerDevice: 3, devices: [deviceSummary(BUILD_BOX, AVAILABLE)] });
    await render(<AgentClaudeAccountOverviewRows agent={AGENT} Row={Row} now={NOW} />);
    expect(container.querySelector("[data-row='Device']")?.textContent).toBe("Build box — owner ada@example.com");
  });

  it("names the selection when no account is chosen, and renders nothing for another adapter", async () => {
    poolApi.getAgentBinding.mockResolvedValue(binding({ state: "device_login", mode: "device_login", pinned: false, devices: [BUILD_BOX, SERVER] }));
    await render(<AgentClaudeAccountOverviewRows agent={AGENT} Row={Row} now={NOW} />);
    expect(container.querySelector("[data-row='Device']")?.textContent).toBe("Varies by project (2 devices)");
    expect(container.querySelector("[data-row='Claude account']")?.textContent).toBe("Device's own login");
    await act(async () => root?.unmount());

    poolApi.getAgentBinding.mockClear();
    await render(<AgentClaudeAccountOverviewRows agent={CODEX_AGENT} Row={Row} />);
    expect(container.innerHTML).toBe("");
    expect(poolApi.getAgentBinding).not.toHaveBeenCalled();
  });

  it("links the Claude account row to where the account is chosen, for those who may change it", async () => {
    poolApi.getAgentBinding.mockResolvedValue(binding(ON_TEAM));
    await render(<AgentClaudeAccountOverviewRows agent={AGENT} Row={Row} changeHref={RUNTIME_HREF} now={NOW} />);
    const account = container.querySelector("[data-row='Claude account']");
    expect(account?.textContent).toBe("Team Max·Change");
    const change = account?.querySelector("a");
    expect(change?.getAttribute("href")).toBe(RUNTIME_HREF);
    expect(change?.textContent).toBe("Change");
    expect(change?.getAttribute("aria-label")).toBe("Change the Claude account");
    // The device is not chosen here, so its row has no link.
    expect(container.querySelector("[data-row='Device'] a")).toBeNull();
  });

  it("offers no Change link without a target, to those who may not change the account, or before the binding loads", async () => {
    poolApi.getAgentBinding.mockResolvedValue(binding(ON_TEAM));
    await render(<AgentClaudeAccountOverviewRows agent={AGENT} Row={Row} now={NOW} />);
    expect(container.querySelector("[data-row='Claude account']")?.textContent).toBe("Team Max");
    expect(container.querySelector("a")).toBeNull();
    await act(async () => root?.unmount());

    poolApi.getAgentBinding.mockResolvedValue(binding({ ...ON_TEAM, canChange: false }));
    await render(<AgentClaudeAccountOverviewRows agent={AGENT} Row={Row} changeHref={RUNTIME_HREF} now={NOW} />);
    expect(container.querySelector("[data-row='Claude account']")?.textContent).toBe("Team Max");
    expect(container.querySelector("a")).toBeNull();
    await act(async () => root?.unmount());

    poolApi.getAgentBinding.mockReturnValue(new Promise(() => {}));
    await render(<AgentClaudeAccountOverviewRows agent={AGENT} Row={Row} changeHref={RUNTIME_HREF} now={NOW} />);
    expect(container.querySelector("[data-row='Claude account']")?.textContent).toBe("Loading…");
    expect(container.querySelector("a")).toBeNull();
    await act(async () => root?.unmount());

    poolApi.getAgentBinding.mockRejectedValue(new ApiError("Not found", 404, { error: "Not found" }));
    await render(<AgentClaudeAccountOverviewRows agent={AGENT} Row={Row} changeHref={RUNTIME_HREF} now={NOW} />);
    expect(container.querySelector("[data-row='Claude account']")?.textContent).toBe("Could not load");
    expect(container.querySelector("a")).toBeNull();
  });
});

describe("AiConnectionOverrideNote", () => {
  it("tells the AI connection field that the Claude account selection overrides it", async () => {
    poolApi.getAgentBinding.mockResolvedValue(binding({ state: "device_login", mode: "device_login" }));
    await render(<AiConnectionOverrideNote agentId={AGENT.id} adapterType="claude_local" />);
    expect(container.textContent).toContain("Overridden by the Claude account selection");
    expect(container.textContent).toContain("This agent uses its device's own login.");
  });

  it("stays hidden without a selection and for another adapter", async () => {
    poolApi.getAgentBinding.mockResolvedValue(binding());
    await render(<AiConnectionOverrideNote agentId={AGENT.id} adapterType="claude_local" />);
    expect(container.innerHTML).toBe("");
    await act(async () => root?.unmount());

    poolApi.getAgentBinding.mockClear();
    await render(<AiConnectionOverrideNote agentId={AGENT.id} adapterType="codex_local" />);
    expect(container.innerHTML).toBe("");
    expect(poolApi.getAgentBinding).not.toHaveBeenCalled();
  });
});

describe("RunResourceWaitBadge", () => {
  it("reads a deferral as Waited and its successor as Waiting, and leaves other runs alone", async () => {
    await render(
      <div>
        <span data-case="deferral"><RunResourceWaitBadge run={run({ status: "cancelled", errorCode: RESOURCE_WAIT_ERROR_CODE_BY_KIND.environment })} /></span>
        <span data-case="successor"><RunResourceWaitBadge run={run({ status: "scheduled_retry", scheduledRetryReason: "device_slot_wait" })} /></span>
        <span data-case="failed"><RunResourceWaitBadge run={run({ status: "failed", errorCode: "adapter_failed" })} /></span>
      </div>,
    );
    expect(container.querySelector("[data-case='deferral']")?.textContent).toBe("Waited");
    expect(container.querySelector("[data-case='successor']")?.textContent).toBe("Waiting");
    expect(container.querySelector("[data-case='failed']")?.textContent).toBe("");
  });
});

describe("agent Claude account helpers", () => {
  it("keeps router pools from claude_local agents, except the one an agent already uses", () => {
    const pools = [{ id: "pool-a" }, { id: "pool-b" }];
    expect(routerPoolsOffered("claude_local", { mode: "responsible_user" }, pools)).toEqual([]);
    expect(routerPoolsOffered("claude_local", { mode: "router", connectionId: "pool-b" }, pools)).toEqual([{ id: "pool-b" }]);
    expect(routerPoolsOffered("codex_local", { mode: "responsible_user" }, pools)).toEqual(pools);
    expect(routerPoolsOffered("paperclip_runner", undefined, pools)).toEqual(pools);
  });

  it("reads the account wait of the next run in the server's order", () => {
    expect(bindingWaitReason(binding())).toBeNull();
    expect(bindingWaitReason(binding({ state: "device_login", mode: "device_login" }))).toBeNull();
    expect(bindingWaitReason(binding({ state: "unassigned", mode: "pool_account" }))).toBe("unassigned");
    expect(bindingWaitReason(binding({ state: "account_unavailable", mode: "pool_account" }))).toBeNull();
    expect(bindingWaitReason(binding(ON_TEAM))).toBeNull();
    expect(bindingWaitReason(binding({ ...ON_TEAM, account: accountRef({ state: "admin_disabled" }) }))).toBe("withdrawn");
    expect(bindingWaitReason(binding({ ...ON_TEAM, account: accountRef({ state: "withdrawn" }) }))).toBe("withdrawn");
    expect(bindingWaitReason(binding({ ...ON_TEAM, account: accountRef({ state: "signed_out" }), devices: [] }))).toBe("signed_out");
    expect(bindingWaitReason(binding({ ...ON_TEAM, account: accountRef({ state: "limited" }), devices: [] }))).toBe("device_unknown");
    expect(bindingWaitReason(binding({ ...ON_TEAM, account: accountRef({ state: "limited" }) }))).toBe("usage_limit");
    expect(bindingWaitReason(binding({ ...ON_TEAM, supported: false, account: accountRef({ state: "limited" }) }))).toBeNull();
  });

  it("finds the newest waiting run and counts the others", () => {
    const older = run({ id: "older", status: "scheduled_retry", scheduledRetryReason: "environment_wait", createdAt: new Date(2026, 9, 16, 9, 0) });
    const newer = run({ id: "newer", status: "scheduled_retry", scheduledRetryReason: "ai_account_wait", createdAt: new Date(2026, 9, 16, 10, 0) });
    const retry = run({ id: "retry", status: "scheduled_retry", scheduledRetryReason: "transient_failure", createdAt: new Date(2026, 9, 16, 11, 0) });
    expect(currentResourceWaitRun([older, retry, newer])).toEqual({ run: newer, waiting: 2 });
    expect(currentResourceWaitRun([retry, run()])).toBeNull();
  });

  it("words the save toast by the runs that keep their account", () => {
    expect(bindingSavedToast(setResponse(), NOW)).toEqual({ title: "Claude account saved", body: "Applies from the agent's next run.", tone: "success" });
    expect(bindingSavedToast(setResponse({ runningRunIds: ["a", "b"] }), NOW).body)
      .toBe("Applies from the next run; the 2 current runs keep their account.");
    expect(bindingSavedToast(setResponse({ warnings: ["credit_balance"] }), NOW)).toMatchObject({
      body: "Applies from the agent's next run. Out of API credit. Tasks wait until credit is added and the limit is cleared.",
      tone: "warn",
    });
  });

  it("formats devices, picks and the override note", () => {
    expect(deviceDisplayName(BUILD_BOX)).toBe("Build box — owner ada@example.com");
    expect(deviceDisplayName(SERVER)).toBe("Paperclip server");
    expect(agentDeviceSummary(binding({ devices: [] }))).toBe("Unknown");
    expect(agentDeviceSummary(binding({ pinned: false }))).toBe("Build box — owner ada@example.com (varies by project)");
    expect(isCurrentSelection({ mode: "pool_account", accountId: "acct-mine" }, binding(ON_MINE))).toBe(true);
    expect(isCurrentSelection({ mode: "device_login" }, binding(ON_MINE))).toBe(false);
    expect(isCurrentSelection({ mode: "device_login" }, binding({ mode: "device_login", state: "device_login" }))).toBe(true);
    expect(aiConnectionOverrideText(binding())).toBeNull();
    expect(aiConnectionOverrideText(binding(ON_TEAM))).toBe(
      "This agent uses the Claude account Team Max. The AI connection below applies only if that selection is cleared in the Claude account section.",
    );
    expect(aiConnectionOverrideText(binding({ state: "unassigned", mode: "pool_account" })))
      .toContain("This agent waits until a Claude account is chosen for it.");
  });

  it("names an account that is no longer available in the picker, and keeps the agent's current account listed", () => {
    expect(accountSelectValueForBinding(binding({ state: "account_unavailable", mode: "pool_account", account: null })))
      .toEqual({ mode: "pool_account", accountId: "unavailable" });
    expect(accountSelectValueForBinding(binding(ON_TEAM))).toEqual({ mode: "pool_account", accountId: "acct-team" });
    expect(accountSelectValueForBinding(binding({ state: "unassigned", mode: "pool_account" })))
      .toEqual({ mode: "pool_account", accountId: null });
    expect(accountSelectValueForBinding(binding({ state: "device_login", mode: "device_login" }))).toEqual({ mode: "device_login" });
    expect(accountSelectValueForBinding(binding())).toBeNull();

    expect(accountOptionsWithCurrent([TEAM, MINE], accountRef())).toEqual([TEAM, MINE]);
    expect(accountOptionsWithCurrent([MINE], null)).toEqual([MINE]);
    const withPaused = accountOptionsWithCurrent([MINE], accountRef({ state: "withdrawn" }));
    expect(withPaused.map((account) => account.id)).toEqual(["acct-mine", "acct-team"]);
    expect(withPaused[1]).toMatchObject({ label: "Team Max", owner: { name: "Ada" }, selectable: false, reason: "withdrawn" });
    // A limited account stays selectable; the list just has not loaded yet.
    expect(accountOptionsWithCurrent([], accountRef({ state: "limited" }))[0]).toMatchObject({ id: "acct-team", reason: null });
    expect(accountOptionsWithCurrent([], accountRef({ state: "limited" }))[0]?.selectable).toBeUndefined();
  });

  it("notes the devices that are not available, by name when there are several", () => {
    const availability = new Map([[BUILD_BOX.id, AVAILABLE], [SERVER.id, OFFLINE], [STUDIO.id, RETIRED]]);
    expect(deviceAvailabilityNotes([SERVER], availability, NOW)).toEqual([
      { deviceId: SERVER.id, state: "unavailable", label: "Offline since 11:30", tone: "warning" },
    ]);
    expect(deviceAvailabilityNotes([BUILD_BOX, SERVER, STUDIO], availability, NOW).map((note) => note.label))
      .toEqual(["Paperclip server: Offline since 11:30", "Studio: Removed"]);
    expect(deviceAvailabilityNotes([BUILD_BOX], availability, NOW)).toEqual([]);
    expect(deviceAvailabilityNotes([SERVER], new Map(), NOW)).toEqual([]);
  });

  it("words a pool refusal of an agent save, and leaves other errors alone", () => {
    const limit = new ApiError("Device account limit", 409, {
      code: "device_account_limit",
      details: { code: "device_account_limit", deviceName: "Build box", limit: 3, inUse: 3, accounts: [], otherCompaniesAccounts: 3 },
    });
    expect(aiAccountPoolRefusalMessage(limit)).toBe(aiAccountPoolErrorMessage(limit));
    expect(aiAccountPoolRefusalMessage(limit)).toContain("Build box already runs 3 of 3 Claude accounts (3 accounts of other companies)");
    expect(aiAccountPoolRefusalMessage(new ApiError("Forbidden", 403, { code: "ai_account_binding_forbidden" })))
      .toBe("Only the account's owner or a company admin can change this assignment.");
    expect(aiAccountPoolRefusalMessage(new ApiError("Incompatible", 422, {
      code: "ai_account_incompatible",
      details: { code: "ai_account_incompatible", reason: "credential_type_unsupported" },
    }))).toContain("does not accept this account's credential type");
    expect(aiAccountPoolRefusalMessage(new ApiError("Placement changed", 409, { code: "placement_conflict" })))
      .toBe("Someone changed this agent's environment at the same time. Reload the agent and try again.");
    // The code may come in the details only, and a device Paperclip cannot place names that fix.
    const unknownDevice = new ApiError("Incompatible", 422, {
      error: "Incompatible",
      details: { code: "ai_account_incompatible", reason: "device_unknown", environmentName: "Orphan sandbox" },
    });
    expect(aiAccountPoolRefusalMessage(unknownDevice)).toBe(aiAccountPoolErrorMessage(unknownDevice));
    expect(aiAccountPoolRefusalMessage(unknownDevice)).not.toBe("Incompatible");
    expect(aiAccountPoolRefusalMessage(new ApiError("Placement changed", 409, { details: { code: "placement_conflict" } })))
      .toBe("Someone changed this agent's environment at the same time. Reload the agent and try again.");
    expect(aiAccountPoolRefusalMessage(new ApiError("Name taken", 409, { error: "Name taken", code: "agent_name_conflict" }))).toBeNull();
    expect(aiAccountPoolRefusalMessage(new ApiError("Bad request", 400, { error: "Bad request" }))).toBeNull();
    expect(aiAccountPoolRefusalMessage(new Error("Network down"))).toBeNull();
  });
});
