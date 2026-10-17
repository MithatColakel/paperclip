// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AiAccountHostsResponse,
  AiAccountMigrationReport,
  AiAccountSummary,
  AiAccountUsageWindow,
  EnvironmentAvailabilitySummary,
  InstanceAiAccountSummary,
  InstanceExecutionDeviceSummary,
} from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { formatResetTime } from "@/lib/ai-account-pool";
import { formatDateTime } from "@/lib/utils";
import { InstanceAiAccounts } from "./InstanceAiAccounts";

const mocks = vi.hoisted(() => ({
  devices: {
    list: vi.fn(),
    get: vi.fn(),
    checkNow: vi.fn(),
    getWaitSettings: vi.fn(),
    updateWaitSettings: vi.fn(),
    listInstance: vi.fn(),
    updateInstance: vi.fn(),
    linkTarget: vi.fn(),
  },
  pool: {
    listInstanceAccounts: vi.fn(),
    updateInstanceAccount: vi.fn(),
    setAdminDisabled: vi.fn(),
    transferOwner: vi.fn(),
    clearInstanceLimit: vi.fn(),
    removeInstanceAccount: vi.fn(),
    getMigrationReport: vi.fn(),
    runMigration: vi.fn(),
  },
  hosts: {
    list: vi.fn(),
    createHost: vi.fn(),
    updateHost: vi.fn(),
    deleteHost: vi.fn(),
    setEnvironments: vi.fn(),
  },
  searchAdminUsers: vi.fn(),
  setBreadcrumbs: vi.fn(),
}));

vi.mock("@/api/execution-devices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/execution-devices")>();
  return { ...actual, executionDevicesApi: mocks.devices };
});
vi.mock("@/api/ai-account-pool", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/ai-account-pool")>();
  return { ...actual, aiAccountPoolApi: mocks.pool };
});
vi.mock("@/api/ai-account-hosts", () => ({ aiAccountHostsApi: mocks.hosts }));
vi.mock("@/api/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/access")>();
  return { ...actual, accessApi: { ...actual.accessApi, searchAdminUsers: mocks.searchAdminUsers } };
});
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: mocks.setBreadcrumbs }) }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-a", name: "Acme", issuePrefix: "ACM" }],
    selectedCompanyId: "company-a",
  }),
}));

const PLUGIN_ID = "0b9a3c52-1f0e-4a77-9b51-6d9c2a1e4f10";
// A minute ago, so the expectations hold at any time of day.
const SINCE = new Date(Date.now() - 60_000).toISOString();
const SINCE_TEXT = formatResetTime(SINCE)!;
const LATER = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
const LAST_LIMIT = "2026-10-13T09:30:00.000Z";

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
  reason: "unreachable",
  message: "Connection timed out during banner exchange",
  unavailableSince: SINCE,
};

function device(overrides: Partial<InstanceExecutionDeviceSummary>): InstanceExecutionDeviceSummary {
  return {
    id: "dev-server",
    name: "Paperclip server",
    kind: "server",
    maxAccounts: 3,
    limit: 3,
    inUse: 0,
    overLimit: false,
    overLimitSince: null,
    externalKey: null,
    targetKey: null,
    targetProvider: null,
    targetMatch: null,
    targetReportedAt: null,
    managedByPluginId: null,
    managedByPluginName: null,
    owner: null,
    aliases: [],
    servedCompanyIds: [],
    availability: AVAILABLE,
    acceptedCredentialTypes: null,
    environments: [],
    accounts: [],
    companies: [],
    duplicateHints: [],
    createdAt: "2026-10-16T00:00:00.000Z",
    ...overrides,
  };
}

const SERVER = device({
  externalKey: "local",
  inUse: 2,
  environments: [{ id: "env-local", name: "Local", driver: "local", companyId: null, explicit: false, availability: AVAILABLE }],
  accounts: [
    { id: "acc-max", label: "Max-2", credentialType: "subscription", state: "active", owner: { userId: "user-ada", name: "Ada", email: "ada@example.com" } },
    { id: "acc-team", label: "Team", credentialType: "subscription", state: "limited", owner: { userId: "user-bob", name: "Bob", email: "bob@example.com" } },
  ],
  companies: [
    { companyId: "company-a", companyName: "Acme", agentCount: 3 },
    { companyId: "company-b", companyName: "Globex", agentCount: 1 },
  ],
});
const SSH_BOX = device({
  id: "dev-ssh",
  name: "SSH · Build tunnel",
  kind: "ssh_host",
  externalKey: "ssh:build.internal:2222",
  availability: OFFLINE,
  inUse: 4,
  overLimit: true,
  overLimitSince: SINCE,
  environments: [{ id: "env-ssh", name: "Build tunnel", driver: "ssh", companyId: "company-a", explicit: true, availability: OFFLINE }],
  duplicateHints: [{ deviceId: "dev-studio", deviceName: "Studio", matchedBy: "alias" }],
});
const STUDIO = device({
  id: "dev-studio",
  name: "Studio",
  kind: "external",
  targetKey: `target:${PLUGIN_ID}:remote-box:studio`,
  targetProvider: "remote-box",
  targetReportedAt: SINCE,
  managedByPluginId: PLUGIN_ID,
  managedByPluginName: "Remote devices",
  owner: { userId: "user-ada", name: "Ada", email: "ada@example.com" },
  aliases: ["build.internal"],
  acceptedCredentialTypes: ["subscription"],
  duplicateHints: [{ deviceId: "dev-ssh", deviceName: "SSH · Build tunnel", matchedBy: "alias" }],
});
const RETIRED_BOX = device({
  id: "dev-retired",
  name: "Old studio",
  kind: "external",
  availability: { ...AVAILABLE, state: "retired" },
});

const EMPTY_WINDOW: AiAccountUsageWindow = { runs: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costCents: 0 };

function account(overrides: Partial<InstanceAiAccountSummary>): InstanceAiAccountSummary {
  return {
    id: "account",
    provider: "anthropic",
    credentialType: "subscription",
    label: "Account",
    plan: null,
    emailHint: null,
    credentialHint: null,
    owner: { userId: "user-ada", name: "Ada", email: "ada@example.com" },
    origin: "pool",
    status: "active",
    statusMessage: null,
    state: "active",
    adminDisabled: false,
    adminDisabledAt: null,
    adminDisabledReason: null,
    exhaustedUntil: null,
    limitReason: null,
    limitSource: null,
    limitStrikes: 0,
    lastLimitedAt: null,
    legacyHostId: null,
    legacyHostName: null,
    reservedProjects: [],
    companies: [],
    usage: { lastFiveHours: EMPTY_WINDOW, lastSevenDays: EMPTY_WINDOW, thisMonth: EMPTY_WINDOW },
    lastUsedAt: null,
    createdAt: "2026-10-16T00:00:00.000Z",
    ...overrides,
  };
}

const MAX = account({
  id: "acc-max",
  label: "Max-2",
  plan: "Max 20x",
  emailHint: "ad•••@example.com",
  credentialHint: "…a1b2",
  companies: [{ companyId: "company-a", companyName: "Acme", agentCount: 2 }],
  lastLimitedAt: LAST_LIMIT,
  usage: {
    lastFiveHours: { runs: 3, inputTokens: 12_300_000, cachedInputTokens: 9_800_000, outputTokens: 840_000, costCents: 0 },
    lastSevenDays: { runs: 1, inputTokens: 999, cachedInputTokens: 0, outputTokens: 1_500, costCents: 0 },
    thisMonth: EMPTY_WINDOW,
  },
});
const TEAM = account({
  id: "acc-team",
  label: "Team",
  owner: { userId: "user-bob", name: "Bob", email: "bob@example.com" },
  state: "limited",
  exhaustedUntil: LATER,
  limitReason: "provider_quota",
  limitSource: "estimated",
  limitStrikes: 2,
});
const LEGACY = account({
  id: "acc-legacy",
  label: "Old shared",
  owner: null,
  origin: "legacy_host_pool",
  legacyHostId: "dev-server",
  legacyHostName: "Paperclip server",
  adminDisabled: true,
  adminDisabledAt: SINCE,
  adminDisabledReason: "Shared outside the team",
  state: "admin_disabled",
  reservedProjects: [{ id: "project-mobile", name: "Mobile app", companyId: "company-a", companyName: "Acme", issuePrefix: "ACM" }],
});
const KEY = account({
  id: "acc-key",
  label: "Console key",
  credentialType: "api_key",
  status: "auth_failed",
  state: "signed_out",
  statusMessage: "The key was revoked.",
  usage: { lastFiveHours: EMPTY_WINDOW, lastSevenDays: EMPTY_WINDOW, thisMonth: { ...EMPTY_WINDOW, runs: 12, costCents: 1_234 } },
});

const REPORT: AiAccountMigrationReport = {
  key: "ai-account-bindings-v1",
  status: "completed",
  attempts: 1,
  lastError: null,
  completedAt: "2026-10-16T10:02:00.000Z",
  summary: {
    bound: 1,
    unassigned: 1,
    unbound: 1,
    agents: [
      { agentId: "agent-alice", agentName: "Alice", companyId: "company-a", companyName: "Acme", outcome: "bound", accountId: "acc-max", accountLabel: "Max-2", rule: "agent_history", note: null },
      { agentId: "agent-bob", agentName: "Bob", companyId: "company-a", companyName: "Acme", outcome: "unassigned", accountId: null, accountLabel: null, rule: null, note: "Over the device's account limit" },
      { agentId: "agent-carol", agentName: "Carol", companyId: "company-a", companyName: "Acme", outcome: "unbound", accountId: null, accountLabel: null, rule: null, note: "No host pool runs in 45 days" },
    ],
    overLimitDevices: [{ deviceId: "dev-ssh", deviceName: "SSH · Build tunnel", limit: 3, inUse: 4 }],
  },
  goNoGo: {
    go: false,
    agents: [
      { agentId: "agent-alice", agentName: "Alice", companyId: "company-a", plan: "use", reason: null },
      { agentId: "agent-bob", agentName: "Bob", companyId: "company-a", plan: "wait", reason: "unassigned" },
      // Not in the summary (bound by hand): its company comes with the entry.
      { agentId: "agent-dave", agentName: "Dave", companyId: "company-b", companyName: "Globex", plan: "none", reason: "no Claude account is assigned" },
      // A server that predates companyName: the company the page cannot name.
      { agentId: "agent-erin", agentName: "Erin", companyId: "company-c", plan: "none", reason: "set explicitly in its Claude account selection" },
    ],
  },
};

function legacyAccount(overrides: Partial<AiAccountSummary>): AiAccountSummary {
  return {
    id: "acc-legacy",
    hostId: "dev-server",
    provider: "anthropic",
    credentialType: "subscription",
    label: "Old shared",
    emailHint: null,
    plan: null,
    poolEnabled: true,
    status: "active",
    statusMessage: null,
    credentialHint: null,
    exhaustedUntil: null,
    limitReason: null,
    lastLimitedAt: null,
    usage: { lastFiveHours: EMPTY_WINDOW, lastSevenDays: EMPTY_WINDOW, thisMonth: EMPTY_WINDOW },
    runningRuns: 0,
    projects: [],
    lastSelectedAt: null,
    lastUsedAt: null,
    createdAt: "2026-10-14T00:00:00.000Z",
    ...overrides,
  };
}

const HOSTS: AiAccountHostsResponse = {
  maxAccountsPerHost: 3,
  unmappedEnvironments: [
    { id: "env-runner-2", name: "Runner 2", driver: "ssh", companyId: "company-a" },
    { id: "env-sandbox", name: "Studio sandbox", driver: "sandbox", companyId: "company-a" },
    { id: "env-local-2", name: "Local 2", driver: "local", companyId: null },
  ],
  hosts: [
    {
      id: "dev-server",
      name: "Paperclip server",
      kind: "server",
      maxAccounts: 3,
      overflowToOtherAccounts: true,
      createdAt: "2026-10-14T00:00:00.000Z",
      environments: [{ id: "env-local", name: "Local", driver: "local", companyId: null }],
      accounts: [legacyAccount({})],
    },
    {
      id: "dev-ssh",
      name: "SSH · Build tunnel",
      kind: "ssh_host",
      maxAccounts: 3,
      overflowToOtherAccounts: false,
      createdAt: "2026-10-14T00:00:00.000Z",
      environments: [{ id: "env-ssh", name: "Build tunnel", driver: "ssh", companyId: "company-a" }],
      accounts: [],
    },
  ],
};

const USERS = [
  { id: "user-ada", email: "ada@example.com", name: "Ada", image: null, isInstanceAdmin: true, activeCompanyMembershipCount: 2 },
  { id: "user-cem", email: "cem@example.com", name: "Cem", image: null, isInstanceAdmin: false, activeCompanyMembershipCount: 1 },
];

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

async function renderPage() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <InstanceAiAccounts />
      </QueryClientProvider>,
    );
  });
}

async function eventually(assertion: () => void) {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assertion();
  });
}

function region(name: string) {
  return container.querySelector<HTMLElement>(`[role="region"][aria-label="${name}"]`)!;
}

function row(name: string) {
  return container.querySelector<HTMLElement>(`li[aria-label="${name}"]`)!;
}

function section(headingId: string) {
  return container.querySelector<HTMLElement>(`section[aria-labelledby="${headingId}"]`)!;
}

function dialog() {
  return document.body.querySelector<HTMLElement>('[role="dialog"]')!;
}

function buttonIn(scope: ParentNode, text: string) {
  return [...scope.querySelectorAll("button")].find((element) => element.textContent?.trim() === text) as HTMLButtonElement | undefined;
}

async function click(element: HTMLElement | undefined) {
  expect(element).toBeDefined();
  await act(async () => element!.click());
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function choose(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function renderLoaded() {
  await renderPage();
  await eventually(() => {
    expect(region("Studio")).toBeTruthy();
    expect(row("Max-2")).toBeTruthy();
    expect(region("Migration report")).toBeTruthy();
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.devices.listInstance.mockResolvedValue({ limitPerDevice: 3, devices: [SERVER, SSH_BOX, STUDIO, RETIRED_BOX] });
  mocks.pool.listInstanceAccounts.mockResolvedValue({ accounts: [MAX, TEAM, LEGACY, KEY] });
  mocks.pool.getMigrationReport.mockResolvedValue(REPORT);
  mocks.hosts.list.mockResolvedValue(HOSTS);
  mocks.searchAdminUsers.mockResolvedValue(USERS);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  document.body.innerHTML = "";
});

describe("InstanceAiAccounts", () => {
  it("is the Devices & Claude accounts page, without product names", async () => {
    await renderLoaded();
    expect(container.querySelector("h1")?.textContent).toBe("Devices & Claude accounts");
    expect(mocks.setBreadcrumbs).toHaveBeenCalledWith([
      { label: "Settings", href: "/company/settings" },
      { label: "Devices & Claude accounts" },
    ]);
    expect(container.textContent).toContain("Paperclip never moves a task to another account.");
    expect(container.textContent).not.toMatch(/\bmacs?\b/i);
  });

  it("shows every device with its availability, keys, owner, limit, environments and duplicate hints", async () => {
    await renderLoaded();

    const server = region("Paperclip server");
    expect(server.querySelector("[data-device-availability]")?.textContent).toBe("Available");
    expect(server.textContent).toContain("Paperclip server");
    expect(server.textContent).toContain("local");
    expect(server.textContent).toContain("2 of 3 Claude accounts · Acme: 3 agents · Globex: 1 agent");
    expect(server.textContent).toContain("Max-2· Ada");
    expect(server.textContent).toContain("Team· Bob");
    expect(server.textContent).toContain("Limited");
    expect(server.textContent).toContain("Local · Local · shared");

    const ssh = region("SSH · Build tunnel");
    expect(ssh.querySelector("[data-device-availability]")?.textContent).toBe(`Unreachable since ${SINCE_TEXT}`);
    // Instance admins see the host and the connection's own words.
    expect(ssh.textContent).toContain("ssh:build.internal:2222");
    expect(ssh.textContent).toContain("Build tunnel · SSH · Acme · mapped by hand");
    expect(ssh.textContent).toContain(`Unreachable since ${SINCE_TEXT}: Connection timed out during banner exchange`);
    expect(ssh.textContent).toContain("Over limit");
    expect(ssh.textContent).toContain("Likely the same machine as Studio");

    const studio = region("Studio");
    expect(studio.textContent).toContain("— owner ada@example.com");
    expect(studio.textContent).toContain(`Managed by Remote devices · Takes subscription accounts only · last report ${SINCE_TEXT}`);
    expect(studio.textContent).toContain(`target:${PLUGIN_ID}:remote-box:studio`);
    expect(studio.textContent).toContain("Also known as build.internal");

    expect(region("Old studio").querySelector("[data-device-availability]")?.textContent).toBe("Removed");
  });

  it("links a likely duplicate through the API and refreshes the devices", async () => {
    mocks.devices.linkTarget.mockResolvedValue(SSH_BOX);
    await renderLoaded();
    const before = mocks.devices.listInstance.mock.calls.length;

    await click(buttonIn(region("SSH · Build tunnel"), "Link"));
    await eventually(() => expect(dialog().textContent).toContain("Link SSH · Build tunnel and Studio?"));
    expect(dialog().textContent).toContain("Studio is merged into SSH · Build tunnel");
    await click(buttonIn(dialog(), "Link devices"));

    await eventually(() =>
      expect(mocks.devices.linkTarget).toHaveBeenCalledWith("dev-ssh", { pluginId: PLUGIN_ID, provider: "remote-box", targetKey: "studio" }));
    await eventually(() => expect(mocks.devices.listInstance.mock.calls.length).toBeGreaterThan(before));
    await eventually(() => expect(document.body.querySelector('[role="dialog"]')).toBeNull());
  });

  it("shows a refused link inline", async () => {
    mocks.devices.linkTarget.mockRejectedValue(new ApiError("This target is already linked to Build box", 409, { error: "This target is already linked to Build box" }));
    await renderLoaded();
    await click(buttonIn(region("Studio"), "Link"));
    await eventually(() => expect(buttonIn(dialog(), "Link devices")?.disabled).toBe(false));
    await click(buttonIn(dialog(), "Link devices"));
    await eventually(() => expect(dialog().textContent).toContain("This target is already linked to Build box"));
  });

  it("edits a device's name and account limit, and shows a refused lower limit inline", async () => {
    mocks.devices.updateInstance
      .mockRejectedValueOnce(new ApiError("2 Claude accounts are in use on Paperclip server", 409, { error: "2 Claude accounts are in use on Paperclip server" }))
      .mockResolvedValueOnce(SERVER);
    await renderLoaded();

    await click(buttonIn(region("Paperclip server"), "Edit"));
    await eventually(() => expect(dialog().querySelector("select")).toBeTruthy());
    expect(buttonIn(dialog(), "Save device")?.disabled).toBe(true);
    await choose(dialog().querySelector<HTMLSelectElement>("select")!, "1");
    await click(buttonIn(dialog(), "Save device"));
    await eventually(() => expect(dialog().textContent).toContain("2 Claude accounts are in use on Paperclip server"));
    expect(mocks.devices.updateInstance).toHaveBeenCalledWith("dev-server", { maxAccounts: 1 });

    await choose(dialog().querySelector<HTMLSelectElement>("select")!, "2");
    await type(dialog().querySelector<HTMLInputElement>("input")!, "Main server");
    await click(buttonIn(dialog(), "Save device"));
    await eventually(() => expect(mocks.devices.updateInstance).toHaveBeenLastCalledWith("dev-server", { name: "Main server", maxAccounts: 2 }));
    await eventually(() => expect(document.body.querySelector('[role="dialog"]')).toBeNull());
  });

  it("maps environments to a device by hand through the host routes", async () => {
    mocks.hosts.setEnvironments.mockRejectedValueOnce(new ApiError("SSH · Build tunnel would run 4 Claude accounts", 409, {}));
    await renderLoaded();
    expect(mocks.hosts.list).not.toHaveBeenCalled();

    await click(buttonIn(region("SSH · Build tunnel"), "Map environments"));
    await eventually(() => expect(dialog().textContent).toContain("Runner 2"));
    // An SSH host takes SSH environments only.
    expect(dialog().textContent).not.toContain("Studio sandbox");
    expect(dialog().textContent).not.toContain("Local 2");
    const checkbox = (name: string) => {
      const label = [...dialog().querySelectorAll("label")].find((element) => element.textContent?.startsWith(name))!;
      return dialog().querySelector<HTMLButtonElement>(`#${CSS.escape(label.htmlFor)}`)!;
    };
    expect(checkbox("Build tunnel").getAttribute("aria-checked")).toBe("true");
    await click(checkbox("Runner 2"));
    await click(buttonIn(dialog(), "Save mappings"));
    await eventually(() => expect(mocks.hosts.setEnvironments).toHaveBeenCalledWith("dev-ssh", ["env-ssh", "env-runner-2"]));
    await eventually(() => expect(dialog().textContent).toContain("SSH · Build tunnel would run 4 Claude accounts"));
  });

  it("lists every account with its owner, state, use and usage", async () => {
    await renderLoaded();

    const max = row("Max-2");
    expect(max.textContent).toContain("Subscription");
    expect(max.textContent).toContain("Active");
    expect(max.textContent).toContain("Owner: Ada · ada@example.com · ad•••@example.com · Max 20x · …a1b2");
    expect(max.textContent).toContain("Used by Acme: 2 agents");
    expect(max.textContent).toContain("Last 5 h: 3 runs · 12.3M in · 840.0k out + 9.8M cached");
    expect(max.textContent).toContain(`Last limit: ${formatDateTime(LAST_LIMIT)}`);
    expect(max.textContent).not.toContain("This month");
    expect(buttonIn(max, "Clear limit")).toBeUndefined();

    const team = row("Team");
    expect(team.textContent).toContain(`Limited until ${formatResetTime(LATER, { estimated: true })}`);
    expect(team.textContent).toContain("Reached its limit 2 times in a row without a successful run in between.");
    expect(team.textContent).toContain("Not assigned to any agent.");
    expect(buttonIn(team, "Clear limit")).toBeDefined();

    const legacy = row("Old shared");
    expect(legacy.textContent).toContain("No owner");
    expect(legacy.textContent).not.toContain("Owner:");
    expect(legacy.textContent).toContain("Disabled by admin");
    expect(legacy.textContent).toContain("Reason: Shared outside the team");
    expect(legacy.textContent).toContain("From the host pool");
    expect(legacy.textContent).toContain("Added to Paperclip server before accounts had owners.");
    expect(legacy.textContent).toContain("Reserved forACM · Mobile app");

    const key = row("Console key");
    expect(key.textContent).toContain("API key");
    expect(key.textContent).toContain("Signed out");
    expect(key.textContent).toContain("The key was revoked.");
    expect(key.textContent).toContain("This month: $12.34");
  });

  it("disables an account for everyone after asking for a reason, and enables it again at once", async () => {
    mocks.pool.setAdminDisabled.mockResolvedValue({});
    await renderLoaded();

    const maxSwitch = row("Max-2").querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(maxSwitch.getAttribute("aria-checked")).toBe("false");
    await click(maxSwitch);
    await eventually(() => expect(dialog().textContent).toContain("Disable Max-2 for everyone?"));
    expect(mocks.pool.setAdminDisabled).not.toHaveBeenCalled();
    await type(dialog().querySelector<HTMLInputElement>("input")!, "  Shared outside the team  ");
    await click(buttonIn(dialog(), "Disable account"));
    await eventually(() => expect(mocks.pool.setAdminDisabled).toHaveBeenCalledWith("acc-max", true, "Shared outside the team"));
    await eventually(() => expect(document.body.querySelector('[role="dialog"]')).toBeNull());

    const legacySwitch = row("Old shared").querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(legacySwitch.getAttribute("aria-checked")).toBe("true");
    await click(legacySwitch);
    await eventually(() => expect(mocks.pool.setAdminDisabled).toHaveBeenCalledWith("acc-legacy", false));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("clears a limit", async () => {
    mocks.pool.clearInstanceLimit.mockResolvedValue(TEAM);
    await renderLoaded();
    await click(buttonIn(row("Team"), "Clear limit"));
    await eventually(() => expect(mocks.pool.clearInstanceLimit).toHaveBeenCalledWith("acc-team"));
  });

  it("transfers an account to an existing user, showing a 422 inline", async () => {
    mocks.pool.transferOwner
      .mockRejectedValueOnce(new ApiError("User not found", 422, { error: "User not found" }))
      .mockResolvedValueOnce(MAX);
    await renderLoaded();

    await click(buttonIn(row("Max-2"), "Transfer owner"));
    await eventually(() => expect(dialog().textContent).toContain("Cem"));
    expect(dialog().textContent).toContain("Owner now: Ada · ada@example.com");
    // The current owner is not offered.
    expect([...dialog().querySelectorAll('[role="radio"]')].map((option) => option.textContent)).toEqual([
      "Cemcem@example.com · 1 company",
    ]);
    expect(buttonIn(dialog(), "Transfer account")?.disabled).toBe(true);

    await type(dialog().querySelector<HTMLInputElement>("input")!, "cem");
    await eventually(() => expect(mocks.searchAdminUsers).toHaveBeenCalledWith("cem"));

    await click(dialog().querySelector<HTMLButtonElement>('[role="radio"]')!);
    await click(buttonIn(dialog(), "Transfer account"));
    await eventually(() => expect(mocks.pool.transferOwner).toHaveBeenCalledWith("acc-max", "user-cem"));
    await eventually(() => expect(dialog().textContent).toContain("That user does not exist. Choose an existing user."));

    await click(buttonIn(dialog(), "Transfer account"));
    await eventually(() => expect(mocks.pool.transferOwner).toHaveBeenCalledTimes(2));
    await eventually(() => expect(document.body.querySelector('[role="dialog"]')).toBeNull());
  });

  it("removes an account, releasing its agents after the server says it is in use", async () => {
    mocks.pool.removeInstanceAccount
      .mockRejectedValueOnce(new ApiError("Account in use", 409, {
        code: "ai_account_in_use",
        details: { code: "ai_account_in_use", bindings: [{ agentId: "a", agentName: "Alice", companyId: "company-a", companyName: "Acme" }], otherCompanies: 1 },
      }))
      .mockResolvedValueOnce(undefined);
    await renderLoaded();

    await click(buttonIn(row("Team"), "Remove"));
    await eventually(() => expect(dialog().textContent).toContain("Remove Team?"));
    await click(buttonIn(dialog(), "Remove account"));
    await eventually(() => expect(mocks.pool.removeInstanceAccount).toHaveBeenCalledWith("acc-team", { release: false }));
    await eventually(() => expect(dialog().textContent).toContain("This account is still assigned to 2 agents."));

    await click(buttonIn(dialog(), "Remove and release agents"));
    await eventually(() => expect(mocks.pool.removeInstanceAccount).toHaveBeenLastCalledWith("acc-team", { release: true }));
    await eventually(() => expect(document.body.querySelector('[role="dialog"]')).toBeNull());
  });

  it("shows the migration report with its go/no-go and runs it again", async () => {
    mocks.pool.runMigration.mockResolvedValue({ ...REPORT, attempts: 2 });
    await renderLoaded();

    const report = region("Migration report");
    expect(report.textContent).toContain(`Completed ${formatDateTime(REPORT.completedAt!)} · 1 attempt`);
    expect(report.textContent).toContain("No-go");
    expect(report.textContent).toContain("Bob (Acme) would wait: no account chosen");
    expect(report.textContent).toContain("Dave (Globex) would use its device's own login: no Claude account is assigned");
    expect(report.textContent).toContain("Erin (another company) would use its device's own login: set explicitly in its Claude account selection");
    expect(report.textContent).not.toContain("would be refused");
    expect(report.textContent).not.toContain("Alice (Acme) would");
    expect(report.textContent).toContain("1 assigned · 1 waiting for an account · 1 not assigned");
    expect(report.textContent).toContain("Bob (Acme) · Waiting for an account · Over the device's account limit");
    expect(report.textContent).toContain("Carol (Acme) · Not assigned · No host pool runs in 45 days");
    expect(report.textContent).toContain("Assigned agents (1)");
    expect(report.textContent).toContain("Over their limit: SSH · Build tunnel (4 of 3)");

    await click(buttonIn(section("instance-migration-heading"), "Run again"));
    await eventually(() => expect(mocks.pool.runMigration).toHaveBeenCalledTimes(1));
  });

  it("lists an agent that waits for its own account's limit as a warning, which does not block go", async () => {
    mocks.pool.getMigrationReport.mockResolvedValue({
      ...REPORT,
      goNoGo: {
        go: true,
        agents: [
          { agentId: "agent-alice", agentName: "Alice", companyId: "company-a", plan: "use", reason: null },
          { agentId: "agent-bob", agentName: "Bob", companyId: "company-a", plan: "wait", reason: "usage_limit" },
        ],
      },
    });
    await renderLoaded();

    const report = region("Migration report");
    expect(report.textContent).toContain("Go");
    expect(report.textContent).not.toContain("No-go");
    expect(report.textContent).toContain("some wait for their account's limit to reset first");
    const limited = report.querySelector<HTMLElement>('[data-testid="go-no-go-limited"]');
    expect(limited?.textContent).toContain("Bob (Acme) would wait");
  });

  it("keeps the legacy host pool collapsed until opened, and adds devices of the kinds a person may add", async () => {
    mocks.hosts.createHost.mockResolvedValue({});
    await renderLoaded();
    const legacy = section("instance-legacy-heading");
    expect(legacy.textContent).not.toContain("Accounts added here");
    expect(mocks.hosts.list).not.toHaveBeenCalled();

    await click(buttonIn(legacy, "Show"));
    await eventually(() => expect(legacy.textContent).toContain("Accounts added here: Old shared"));
    expect(mocks.hosts.list).toHaveBeenCalledTimes(1);
    expect(legacy.textContent).toContain("Mapped by hand: Build tunnel");
    expect(legacy.textContent).toContain("Not mapped by hand: Runner 2, Studio sandbox, Local 2.");

    await click(buttonIn(legacy, "Add device"));
    await eventually(() => expect(dialog().querySelector("#legacy-device-name")).toBeTruthy());
    const kinds = [...dialog().querySelectorAll('[role="radio"]')].map((option) => option.textContent ?? "");
    expect(kinds).toHaveLength(3);
    expect(kinds[0]).toMatch(/^Paperclip server/);
    expect(kinds[1]).toMatch(/^SSH host/);
    expect(kinds[2]).toMatch(/^Computer over SSH/);
    // The server refuses plugin devices made by hand.
    expect(dialog().textContent).not.toContain("Plugin device");

    await type(dialog().querySelector<HTMLInputElement>("#legacy-device-name")!, "Build machine");
    await click(buttonIn(dialog(), "Add device"));
    await eventually(() => expect(mocks.hosts.createHost).toHaveBeenCalledWith({ name: "Build machine", kind: "ssh_host" }));
  });

  it("removes a device from the legacy host pool after confirming", async () => {
    mocks.hosts.deleteHost.mockResolvedValue({ ok: true });
    await renderLoaded();
    await click(buttonIn(section("instance-legacy-heading"), "Show"));
    await eventually(() => expect(section("instance-legacy-heading").textContent).toContain("Accounts added here"));

    const legacyCard = section("instance-legacy-heading").querySelector<HTMLElement>('[role="region"][aria-label="SSH · Build tunnel"]')!;
    await click(buttonIn(legacyCard, "Remove"));
    await eventually(() => expect(dialog().textContent).toContain("Remove SSH · Build tunnel?"));
    expect(mocks.hosts.deleteHost).not.toHaveBeenCalled();
    await click(buttonIn(dialog(), "Remove device"));
    await eventually(() => expect(mocks.hosts.deleteHost).toHaveBeenCalledWith("dev-ssh"));
  });

  it("never renders anything that looks like a credential, even when a response carries one", async () => {
    // A server regression that put a credential into these responses must still show none of it.
    const token = `sk-ant-oat01-${"x".repeat(80)}`;
    const leak = { credential: token, value: token, token };
    mocks.devices.listInstance.mockResolvedValue({
      limitPerDevice: 3,
      devices: [SERVER, SSH_BOX, STUDIO, RETIRED_BOX].map((entry) => ({
        ...entry,
        ...leak,
        accounts: entry.accounts.map((deviceAccount) => ({ ...deviceAccount, ...leak })),
      }) as InstanceExecutionDeviceSummary),
    });
    mocks.pool.listInstanceAccounts.mockResolvedValue({
      accounts: [MAX, TEAM, LEGACY, KEY].map((entry) => ({ ...entry, ...leak }) as InstanceAiAccountSummary),
    });
    mocks.hosts.list.mockResolvedValue({
      ...HOSTS,
      hosts: HOSTS.hosts.map((host) => ({
        ...host,
        ...leak,
        accounts: host.accounts.map((hostAccount) => ({ ...hostAccount, ...leak })),
      })),
    } as AiAccountHostsResponse);
    await renderLoaded();
    await click(buttonIn(section("instance-legacy-heading"), "Show"));
    await eventually(() => expect(section("instance-legacy-heading").textContent).toContain("Accounts added here"));
    expect(document.body.textContent).not.toMatch(/sk-ant-[a-z]{3}/i);
    // The only credential trace is the recognition hint the server derives, shown exactly as given.
    expect([...row("Max-2").querySelectorAll("span")].some((element) => element.textContent === "…a1b2")).toBe(true);
  });

  it("explains when the viewer is not an instance admin", async () => {
    mocks.devices.listInstance.mockRejectedValue(new ApiError("Instance admin access required", 403, {}));
    mocks.pool.listInstanceAccounts.mockRejectedValue(new ApiError("Instance admin access required", 403, {}));
    mocks.pool.getMigrationReport.mockRejectedValue(new ApiError("Instance admin access required", 403, {}));
    await renderPage();
    await eventually(() =>
      expect(container.textContent).toContain("Instance admin access is required to manage devices and Claude accounts."));
    expect(container.querySelector('section[aria-labelledby="instance-devices-heading"]')).toBeNull();
  });
});
