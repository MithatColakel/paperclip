// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EnvironmentAvailabilitySummary,
  ExecutionDeviceDetail,
  ExecutionDeviceSummary,
  ExecutionWaitSettings,
  InstanceExecutionDeviceSummary,
} from "@paperclipai/shared";
import type { CurrentBoardAccess } from "@/api/access";
import { ApiError } from "@/api/client";
import { formatResetTime } from "@/lib/ai-account-pool";
import { ExecutionDevices } from "./ExecutionDevices";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  checkNow: vi.fn(),
  getWaitSettings: vi.fn(),
  updateWaitSettings: vi.fn(),
  listInstance: vi.fn(),
  updateInstance: vi.fn(),
  linkTarget: vi.fn(),
  getCurrentBoardAccess: vi.fn(),
  setBreadcrumbs: vi.fn(),
}));

vi.mock("@/api/execution-devices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/execution-devices")>();
  return {
    ...actual,
    executionDevicesApi: {
      list: mocks.list,
      get: mocks.get,
      checkNow: mocks.checkNow,
      getWaitSettings: mocks.getWaitSettings,
      updateWaitSettings: mocks.updateWaitSettings,
      listInstance: mocks.listInstance,
      updateInstance: mocks.updateInstance,
      linkTarget: mocks.linkTarget,
    },
  };
});
vi.mock("@/api/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/access")>();
  return { ...actual, accessApi: { ...actual.accessApi, getCurrentBoardAccess: mocks.getCurrentBoardAccess } };
});
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: mocks.setBreadcrumbs }) }));

const COMPANY = { id: "company-a", name: "Acme", issuePrefix: "ACM" };
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ companies: [COMPANY], selectedCompanyId: COMPANY.id, selectedCompany: COMPANY }),
}));

const PLUGIN_ID = "0b9a3c52-1f0e-4a77-9b51-6d9c2a1e4f10";
// A minute ago, so the expectations hold at any time of day.
const SINCE = new Date(Date.now() - 60_000).toISOString();
const SINCE_TEXT = formatResetTime(SINCE)!;
const CHECKED_AT = new Date().toISOString();
const CHECKED_TEXT = formatResetTime(CHECKED_AT)!;

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
const OFFLINE: EnvironmentAvailabilitySummary = { ...AVAILABLE, state: "unavailable", reason: "offline", unavailableSince: SINCE };
const RETIRED: EnvironmentAvailabilitySummary = { ...AVAILABLE, state: "retired", reason: null };

function device(overrides: Partial<ExecutionDeviceSummary>): ExecutionDeviceSummary {
  return {
    id: "dev-server",
    name: "Paperclip server",
    kind: "server",
    managedByPluginId: null,
    managedByPluginName: null,
    owner: null,
    limit: 3,
    inUse: 0,
    overLimit: false,
    overLimitSince: null,
    availability: AVAILABLE,
    environments: [],
    accounts: [],
    otherCompaniesAccounts: 0,
    agents: [],
    ownLoginAgents: 0,
    acceptedCredentialTypes: null,
    duplicateHints: [],
    waitingCount: 0,
    ...overrides,
  };
}

const SERVER = device({
  inUse: 3,
  accounts: [
    { id: "acc-max", label: "Max-2", credentialType: "subscription", state: "active" },
    { id: "acc-team", label: "Team", credentialType: "subscription", state: "limited" },
  ],
  otherCompaniesAccounts: 1,
  environments: [{ id: "env-local", name: "Local", driver: "local", companyId: null, explicit: false, availability: AVAILABLE }],
  agents: [
    { agentId: "agent-alice", agentName: "Alice", mode: "pool_account", accountId: "acc-max" },
    { agentId: "agent-bob", agentName: "Bob", mode: "device_login", accountId: null },
    { agentId: "agent-carol", agentName: "Carol", mode: null, accountId: null },
    { agentId: "agent-dave", agentName: "Dave", mode: "pool_account", accountId: null },
  ],
  ownLoginAgents: 2,
});
const BUILD_BOX = device({
  id: "dev-build",
  name: "Build box",
  kind: "ssh_host",
  owner: { userId: "user-ada", name: "Ada", email: "ada@example.com" },
  availability: OFFLINE,
  inUse: 4,
  limit: 3,
  overLimit: true,
  overLimitSince: SINCE,
  environments: [{ id: "env-ssh", name: "Build tunnel", driver: "ssh", companyId: COMPANY.id, explicit: false, availability: OFFLINE }],
  waitingCount: 2,
});
const STUDIO = device({
  id: "dev-studio",
  name: "Studio",
  kind: "external",
  managedByPluginId: PLUGIN_ID,
  managedByPluginName: "Remote devices",
  availability: RETIRED,
  acceptedCredentialTypes: ["subscription"],
  duplicateHints: [{ deviceId: "dev-build", deviceName: "Build box", matchedBy: "alias" }],
});

const BUILD_BOX_DETAIL: ExecutionDeviceDetail = {
  ...BUILD_BOX,
  waits: [
    {
      runId: "run-1",
      agentId: "agent-alice",
      agentName: "Alice",
      issueId: "issue-12",
      issueIdentifier: "ACM-12",
      issueTitle: "Fix the login form",
      kind: "environment",
      reason: "offline",
      since: SINCE,
      resumeAt: null,
    },
    {
      runId: "run-2",
      agentId: "agent-eve",
      agentName: "Eve",
      issueId: null,
      issueIdentifier: null,
      issueTitle: null,
      kind: "environment",
      reason: "unreachable",
      since: SINCE,
      resumeAt: null,
    },
  ],
};

function instanceDevice(source: ExecutionDeviceSummary, overrides: Partial<InstanceExecutionDeviceSummary>): InstanceExecutionDeviceSummary {
  return {
    id: source.id,
    name: source.name,
    kind: source.kind,
    maxAccounts: 3,
    limit: 3,
    inUse: source.inUse,
    overLimit: source.overLimit,
    overLimitSince: source.overLimitSince,
    externalKey: null,
    targetKey: null,
    targetProvider: null,
    targetMatch: null,
    targetReportedAt: null,
    managedByPluginId: source.managedByPluginId,
    managedByPluginName: source.managedByPluginName,
    owner: source.owner,
    aliases: [],
    servedCompanyIds: [],
    availability: source.availability,
    acceptedCredentialTypes: source.acceptedCredentialTypes,
    environments: source.environments,
    accounts: [],
    companies: [],
    duplicateHints: source.duplicateHints,
    createdAt: "2026-10-16T00:00:00.000Z",
    ...overrides,
  };
}

const SETTINGS: ExecutionWaitSettings = {
  companyId: COMPANY.id,
  notifyAfterHours: null,
  notifyPmOnDeviceWait: false,
  notifyPmOnAccountWait: true,
  instanceDefaultHours: 24,
  updatedAt: null,
};

function boardAccess(overrides: Partial<CurrentBoardAccess>): CurrentBoardAccess {
  return {
    user: { id: "me", email: "me@example.com", name: "Me", image: null },
    userId: "me",
    isInstanceAdmin: false,
    companyIds: [COMPANY.id],
    memberships: [{ companyId: COMPANY.id, membershipRole: "operator", status: "active" }],
    source: "session",
    keyId: null,
    ...overrides,
  };
}
const OPERATOR = boardAccess({});
const VIEWER = boardAccess({ memberships: [{ companyId: COMPANY.id, membershipRole: "viewer", status: "active" }] });
const ADMIN = boardAccess({ memberships: [{ companyId: COMPANY.id, membershipRole: "admin", status: "active" }] });
const INSTANCE_ADMIN = boardAccess({ isInstanceAdmin: true });

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

async function renderPage() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/ACM/company/settings/devices"]}>
          <ExecutionDevices />
        </MemoryRouter>
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

function buttonIn(scope: ParentNode, text: string) {
  return [...scope.querySelectorAll("button")].find((element) => element.textContent?.trim() === text) as HTMLButtonElement | undefined;
}

async function click(element: HTMLElement | undefined) {
  expect(element).toBeDefined();
  await act(async () => element!.click());
}

async function choose(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function renderLoaded(access: CurrentBoardAccess = OPERATOR) {
  mocks.getCurrentBoardAccess.mockResolvedValue(access);
  await renderPage();
  await eventually(() => expect(region("Studio")).toBeTruthy());
}

beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.list.mockResolvedValue({ limitPerDevice: 3, devices: [SERVER, BUILD_BOX, STUDIO] });
  mocks.get.mockImplementation(async (_companyId: string, deviceId: string) => {
    if (deviceId === BUILD_BOX.id) return BUILD_BOX_DETAIL;
    throw new ApiError("Not found", 404, {});
  });
  mocks.getWaitSettings.mockResolvedValue(SETTINGS);
  mocks.getCurrentBoardAccess.mockResolvedValue(OPERATOR);
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

describe("ExecutionDevices", () => {
  it("shows each device's availability, owner, accounts and agents, with other companies' accounts as a count", async () => {
    await renderLoaded();

    const server = region("Paperclip server");
    expect(server.querySelector("[data-device-availability]")?.textContent).toBe("Available");
    expect(server.textContent).toContain("3 of 3 Claude accounts · +1 used by another company");
    expect(server.textContent).toContain("Max-2");
    expect(server.textContent).toContain("Team");
    expect(server.textContent).toContain("Limited");
    expect(server.textContent).toContain("Alice · Max-2");
    // No chosen account, or one whose owner is not a member here: never a name.
    expect(server.textContent).toContain("Dave · no usable Claude account");
    // Agents on the device's own login, or not set, are a count only.
    expect(server.textContent).toContain("Own login: 2 agents (not counted)");
    expect(server.textContent).not.toContain("Bob");
    expect(server.textContent).not.toContain("Carol");
    expect(server.textContent).toContain("Reached through Local");

    const build = region("Build box");
    expect(build.querySelector("[data-device-availability]")?.textContent).toBe(`Offline since ${SINCE_TEXT}`);
    expect(build.textContent).toContain("— owner ada@example.com");
    expect(build.textContent).toContain("Over limit");
    expect(build.textContent).toContain(`Over its limit since ${SINCE_TEXT}: agents that can run here use 4 Claude accounts, more than its 3.`);
    expect(build.textContent).toContain(`Build tunnel (Offline since ${SINCE_TEXT})`);

    const studio = region("Studio");
    expect(studio.querySelector("[data-device-availability]")?.textContent).toBe("Removed");
    expect(studio.textContent).toContain("Managed by Remote devices · Takes subscription accounts only");
    expect(studio.textContent).toContain("Likely the same machine as Build box");

    expect(mocks.list).toHaveBeenCalledWith(COMPANY.id);
    expect(mocks.setBreadcrumbs).toHaveBeenCalledWith([
      { label: "Settings", href: "/company/settings" },
      { label: "Devices" },
    ]);
  });

  it("lists the waiting tasks of a device from its detail", async () => {
    await renderLoaded();
    await eventually(() => expect(region("Build box").textContent).toContain("ACM-12 Fix the login form"));

    const build = region("Build box");
    expect(build.textContent).toContain("Waiting tasks (2)");
    expect(build.textContent).toContain(`Alice · device offline · since ${SINCE_TEXT}`);
    expect(build.textContent).toContain(`Eve`);
    expect(build.textContent).toContain(`device unreachable · since ${SINCE_TEXT}`);
    expect(build.querySelector('a[href="/ACM/issues/ACM-12"]')).toBeTruthy();
    expect(mocks.get).toHaveBeenCalledWith(COMPANY.id, BUILD_BOX.id);
    // Devices without waits are not fetched one by one.
    expect(mocks.get).not.toHaveBeenCalledWith(COMPANY.id, SERVER.id);
  });

  it("reads the waiting tasks from the device list, with no request per device", async () => {
    mocks.list.mockResolvedValue({
      limitPerDevice: 3,
      devices: [{ ...SERVER, waits: [] }, { ...BUILD_BOX, waits: BUILD_BOX_DETAIL.waits }, { ...STUDIO, waits: [] }],
    });
    await renderLoaded();
    await eventually(() => expect(region("Build box").textContent).toContain("ACM-12 Fix the login form"));
    expect(region("Build box").textContent).toContain(`Alice · device offline · since ${SINCE_TEXT}`);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("never polls a device's detail on a timer when the list has no waits", async () => {
    await renderLoaded();
    await eventually(() => expect(region("Build box").textContent).toContain("ACM-12 Fix the login form"));
    const detailIntervals = client.getQueryCache().findAll({ queryKey: ["execution-devices", "company", COMPANY.id, "device"] })
      .flatMap((query) => query.observers.map((observer) => observer.options.refetchInterval));
    expect(detailIntervals.length).toBeGreaterThan(0);
    expect(detailIntervals.every((interval) => interval === undefined || interval === false)).toBe(true);
  });

  it("answers Check now in place, including 404 and 429", async () => {
    mocks.checkNow.mockImplementation(async (_companyId: string, deviceId: string) => {
      if (deviceId === SERVER.id) return { checkedAt: CHECKED_AT, device: { ...SERVER, waits: [] }, woken: 2 };
      if (deviceId === BUILD_BOX.id) return { checkedAt: CHECKED_AT, device: BUILD_BOX_DETAIL, woken: 0 };
      throw new ApiError("Device not found", 404, { error: "Device not found" });
    });
    await renderLoaded();

    await click(buttonIn(region("Paperclip server"), "Check now"));
    await eventually(() =>
      expect(region("Paperclip server").textContent).toContain(`Available (checked at ${CHECKED_TEXT}). 2 waiting tasks are starting.`));
    expect(mocks.checkNow).toHaveBeenCalledWith(COMPANY.id, SERVER.id);

    await click(buttonIn(region("Build box"), "Check now"));
    await eventually(() =>
      expect(region("Build box").textContent).toContain(`Still unavailable: Offline since ${SINCE_TEXT} (checked at ${CHECKED_TEXT}).`));

    await click(buttonIn(region("Studio"), "Check now"));
    await eventually(() =>
      expect(region("Studio").textContent).toContain("Not found. It may have been removed, or it is not visible to this company."));

    mocks.checkNow.mockRejectedValueOnce(new ApiError("Too many requests", 429, {}));
    await click(buttonIn(region("Paperclip server"), "Check now"));
    await eventually(() =>
      expect(region("Paperclip server").textContent).toContain("Checked less than a minute ago. Try again in a minute."));
    expect(region("Paperclip server").textContent).not.toContain("checked at");
  });

  it("offers no Check now and no settings to a viewer", async () => {
    await renderLoaded(VIEWER);
    expect(buttonIn(container, "Check now")).toBeUndefined();
    expect(container.querySelector('[aria-label="Waiting notifications"]')).toBeNull();
    expect(mocks.getWaitSettings).not.toHaveBeenCalled();
    expect(region("Studio").textContent).toContain("An instance admin can link them so they count as one device.");
    expect(buttonIn(region("Studio"), "Link")).toBeUndefined();
  });

  it("lets company admins choose when a long device wait is reported", async () => {
    mocks.updateWaitSettings.mockImplementation(async (_companyId: string, input: Partial<ExecutionWaitSettings>) => ({ ...SETTINGS, ...input }));
    await renderLoaded(ADMIN);
    await eventually(() => expect(region("Waiting notifications").querySelector("select")).toBeTruthy());

    const settings = region("Waiting notifications");
    const select = settings.querySelector<HTMLSelectElement>("select")!;
    expect(select.value).toBe("default");
    expect(select.options[0]!.textContent).toBe("Instance default (24 hours)");
    await choose(select, "12");
    await eventually(() => expect(mocks.updateWaitSettings).toHaveBeenCalledWith(COMPANY.id, { notifyAfterHours: 12 }));
    await eventually(() => expect(settings.querySelector<HTMLSelectElement>("select")!.value).toBe("12"));

    await choose(settings.querySelector<HTMLSelectElement>("select")!, "never");
    await eventually(() => expect(mocks.updateWaitSettings).toHaveBeenCalledWith(COMPANY.id, { notifyAfterHours: 0 }));

    const switches = [...settings.querySelectorAll<HTMLButtonElement>('[role="switch"]')];
    expect(switches.map((toggle) => toggle.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    await click(switches[1]);
    await eventually(() => expect(mocks.updateWaitSettings).toHaveBeenCalledWith(COMPANY.id, { notifyPmOnDeviceWait: true }));
  });

  it("does not show the wait settings to members who are not admins", async () => {
    await renderLoaded(OPERATOR);
    expect(container.querySelector('[aria-label="Waiting notifications"]')).toBeNull();
    expect(mocks.getWaitSettings).not.toHaveBeenCalled();
  });

  it("lets an instance admin link a likely duplicate, then refreshes the devices", async () => {
    mocks.listInstance.mockResolvedValue({
      limitPerDevice: 3,
      devices: [
        instanceDevice(BUILD_BOX, { externalKey: "ssh:build.internal:22" }),
        instanceDevice(STUDIO, { targetKey: `target:${PLUGIN_ID}:remote-box:studio`, targetProvider: "remote-box" }),
      ],
    });
    mocks.linkTarget.mockResolvedValue({});
    await renderLoaded(INSTANCE_ADMIN);
    expect(mocks.list).toHaveBeenCalledTimes(1);

    await click(buttonIn(region("Studio"), "Link"));
    await eventually(() => expect(document.body.textContent).toContain("Link Build box and Studio?"));
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    await click(buttonIn(dialog, "Link devices"));
    await eventually(() =>
      expect(mocks.linkTarget).toHaveBeenCalledWith(BUILD_BOX.id, { pluginId: PLUGIN_ID, provider: "remote-box", targetKey: "studio" }));
    await eventually(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    await eventually(() => expect(document.body.querySelector('[role="dialog"]')).toBeNull());
  });

  it("never renders anything that looks like a credential, even when a response carries one", async () => {
    // A server regression that put a credential into these responses must still show none of it.
    const token = `sk-ant-oat01-${"x".repeat(80)}`;
    const leak = { credential: token, value: token, token };
    const leaky = <T extends ExecutionDeviceSummary>(entry: T): T => ({
      ...entry,
      ...leak,
      accounts: entry.accounts.map((deviceAccount) => ({ ...deviceAccount, ...leak })),
      agents: entry.agents.map((agent) => ({ ...agent, ...leak })),
      environments: entry.environments.map((environment) => ({ ...environment, ...leak })),
    }) as T;
    mocks.list.mockResolvedValue({ limitPerDevice: 3, devices: [SERVER, BUILD_BOX, STUDIO].map(leaky) });
    mocks.get.mockImplementation(async (_companyId: string, deviceId: string) => {
      if (deviceId !== BUILD_BOX.id) throw new ApiError("Not found", 404, {});
      const detail = leaky(BUILD_BOX_DETAIL);
      return { ...detail, waits: detail.waits.map((wait) => ({ ...wait, ...leak })) } as ExecutionDeviceDetail;
    });
    await renderLoaded(INSTANCE_ADMIN);
    await eventually(() => expect(region("Build box").textContent).toContain("ACM-12"));
    expect(region("Paperclip server").textContent).toContain("Alice · Max-2");
    expect(document.body.textContent).not.toMatch(/sk-ant-[a-z]{3}/i);
    expect(document.body.textContent).not.toMatch(/\bmacs?\b/i);
  });

  it("shows a load failure with a retry", async () => {
    mocks.list.mockRejectedValue(new ApiError("Server error", 500, {}));
    mocks.getCurrentBoardAccess.mockResolvedValue(OPERATOR);
    await renderPage();
    await eventually(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("Server error"));
    expect(buttonIn(container, "Try again")).toBeDefined();
  });
});
