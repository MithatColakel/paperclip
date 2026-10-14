// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiAccountHostsResponse, AiAccountProjectSummary, AiAccountSummary, AiAccountUsageWindow } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { formatDateTime } from "@/lib/utils";
import { InstanceAiAccounts } from "./InstanceAiAccounts";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  createHost: vi.fn(),
  updateHost: vi.fn(),
  deleteHost: vi.fn(),
  setEnvironments: vi.fn(),
  addAccount: vi.fn(),
  updateAccount: vi.fn(),
  clearLimit: vi.fn(),
  setAccountProjects: vi.fn(),
  deleteAccount: vi.fn(),
  listConnections: vi.fn(),
  listPlugins: vi.fn(),
  setBreadcrumbs: vi.fn(),
}));

vi.mock("@/api/ai-account-hosts", () => ({ aiAccountHostsApi: mocks }));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: { list: mocks.listConnections } }));
vi.mock("@/api/plugins", () => ({ pluginsApi: { list: mocks.listPlugins } }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: mocks.setBreadcrumbs }) }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-a", name: "Cleanio", issuePrefix: "CLE" }],
    selectedCompanyId: "company-a",
  }),
}));

const PASTED_TOKEN = `sk-ant-oat01-${"x".repeat(90)}`;
const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const LAST_LIMIT = "2026-10-13T09:30:00.000Z";
const EMPTY_WINDOW: AiAccountUsageWindow = { runs: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costCents: 0 };
const usage = (
  lastFiveHours: Partial<AiAccountUsageWindow>,
  lastSevenDays: Partial<AiAccountUsageWindow>,
  thisMonth: Partial<AiAccountUsageWindow> = {},
) => ({
  lastFiveHours: { ...EMPTY_WINDOW, ...lastFiveHours },
  lastSevenDays: { ...EMPTY_WINDOW, ...lastSevenDays },
  thisMonth: { ...EMPTY_WINDOW, ...thisMonth },
});
const MOBILE: AiAccountProjectSummary = { id: "project-mobile", name: "Mobile app", companyId: "company-a", companyName: "Cleanio", issuePrefix: "CLE" };
const WEBSITE: AiAccountProjectSummary = { id: "project-web", name: "Website", companyId: "company-a", companyName: "Cleanio", issuePrefix: "CLE" };
const VPN: AiAccountProjectSummary = { id: "project-vpn", name: "VPN core", companyId: "company-b", companyName: "Presto", issuePrefix: "PRE" };

function account(overrides: Partial<AiAccountSummary>): AiAccountSummary {
  return {
    id: "account",
    hostId: "host-server",
    provider: "anthropic",
    credentialType: "subscription",
    label: "Account",
    emailHint: null,
    plan: null,
    poolEnabled: true,
    status: "active",
    statusMessage: null,
    credentialHint: null,
    exhaustedUntil: null,
    limitReason: null,
    runningRuns: 0,
    projects: [],
    lastLimitedAt: null,
    usage: usage({}, {}),
    lastSelectedAt: null,
    lastUsedAt: null,
    createdAt: "2026-10-14T00:00:00.000Z",
    ...overrides,
  };
}

function response(): AiAccountHostsResponse {
  return {
    maxAccountsPerHost: 3,
    projects: [VPN, WEBSITE, MOBILE],
    unmappedEnvironments: [{ id: "env-mac", name: "Mac mini tunnel", driver: "ssh", companyId: "company-a" }],
    hosts: [
      {
        id: "host-server",
        name: "Main server",
        kind: "server",
        maxAccounts: 3,
        overflowToOtherAccounts: true,
        createdAt: "2026-10-14T00:00:00.000Z",
        environments: [{ id: "env-local", name: "Local", driver: "local", companyId: "company-a" }],
        accounts: [
          account({
            id: "acc-s", label: "Account S", emailHint: "mithat@example.com", plan: "Max 20x", credentialHint: "…a1b2", runningRuns: 2,
            lastLimitedAt: LAST_LIMIT,
            usage: usage(
              { runs: 3, inputTokens: 12_300_000, cachedInputTokens: 9_800_000, outputTokens: 840_000, costCents: 4_200 },
              { runs: 1, inputTokens: 999, outputTokens: 1_500 },
              { runs: 40, costCents: 98_765 },
            ),
          }),
          account({ id: "acc-m", label: "Account M", exhaustedUntil: FUTURE, limitReason: "provider_quota", projects: [MOBILE] }),
          account({
            id: "acc-b", label: "Account B", credentialType: "api_key", status: "auth_failed", statusMessage: "The token was revoked.",
            usage: usage({}, { runs: 12, inputTokens: 2_000_000, outputTokens: 50_000 }, { runs: 12, costCents: 1_234 }),
          }),
        ],
      },
      {
        id: "host-runner",
        name: "Runner",
        kind: "ssh_host",
        maxAccounts: 3,
        overflowToOtherAccounts: false,
        createdAt: "2026-10-14T00:00:00.000Z",
        environments: [],
        accounts: [account({ id: "acc-t", hostId: "host-runner", label: "Account T", status: "disabled" })],
      },
    ],
  };
}

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

beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.list.mockResolvedValue(response());
  mocks.listPlugins.mockResolvedValue([]);
  mocks.listConnections.mockResolvedValue({ currentUserId: "me", canManageConnections: true, connections: [] });
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
  it("shows each host with its environments, accounts and states", async () => {
    await renderPage();
    await eventually(() => expect(region("Main server")).toBeTruthy());

    const server = region("Main server");
    expect(server.textContent).toContain("Paperclip server · 3 of 3 accounts");
    expect(server.textContent).toContain("Local· Cleanio");
    expect(region("Runner").textContent).toContain("Runner server (SSH) · 1 of 3 accounts");

    const s = row("Account S");
    expect(s.textContent).toContain("Available");
    expect(s.textContent).toContain("Subscription");
    expect(s.textContent).toContain("mi•••@example.com · Max 20x");
    expect(s.textContent).not.toContain("mithat@example.com");
    expect(s.textContent).toContain("…a1b2");
    expect(s.textContent).toContain("Running now: 2");

    const m = row("Account M");
    expect(m.textContent).toContain("Limited until");
    expect(m.textContent).toContain("(usage limit)");
    expect(buttonIn(m, "Clear limit")).toBeDefined();

    const b = row("Account B");
    expect(b.textContent).toContain("API key");
    expect(b.textContent).toContain("Sign-in failed");
    expect(b.textContent).toContain("The token was revoked.");
    expect(buttonIn(b, "Set active again")).toBeDefined();

    const t = row("Account T");
    expect(t.textContent).toContain("Switched off");
    expect(buttonIn(t, "Set active again")).toBeDefined();
    expect(buttonIn(t, "Clear limit")).toBeUndefined();

    expect(container.textContent).toContain("Mac mini tunnel");
    expect(mocks.setBreadcrumbs).toHaveBeenCalled();
  });

  it("shows Paperclip's usage per account, money only for API keys, and the last limit", async () => {
    await renderPage();
    await eventually(() => expect(region("Main server")).toBeTruthy());
    const usageOf = (name: string) => row(name).querySelector<HTMLElement>('[data-testid="account-usage"]')!.textContent ?? "";

    const subscription = usageOf("Account S");
    expect(subscription).toContain("Last 5 h: 3 runs · 12.3M in · 840.0k out + 9.8M cached");
    expect(subscription).toContain("Last 7 days: 1 run · 999 in · 1.5k out");
    const sevenDays = [...row("Account S").querySelectorAll('[data-testid="account-usage"] p')]
      .find((line) => line.textContent?.startsWith("Last 7 days"));
    expect(sevenDays?.textContent).toBe("Last 7 days: 1 run · 999 in · 1.5k out");
    expect(subscription).not.toContain("$");
    expect(subscription).not.toContain("This month");
    expect(subscription).toContain(`Last limit: ${formatDateTime(LAST_LIMIT)}`);

    const apiKey = usageOf("Account B");
    expect(apiKey).toContain("Last 5 h: 0 runs · 0 in · 0 out");
    expect(apiKey).toContain("Last 7 days: 12 runs · 2.0M in · 50.0k out");
    expect(apiKey).not.toContain("cached");
    expect(apiKey).toContain("This month: $12.34");
    expect(apiKey).not.toContain("Last limit");

    expect(container.textContent).toContain("Usage shows what Paperclip ran on each account.");
  });

  it("disables Add account on a host that has three accounts", async () => {
    await renderPage();
    await eventually(() => expect(region("Main server")).toBeTruthy());
    expect(buttonIn(region("Main server"), "Add account")?.disabled).toBe(true);
    expect(region("Main server").textContent).toContain("This host has 3 accounts, the most it can have.");
    expect(buttonIn(region("Runner"), "Add account")?.disabled).toBe(false);
  });

  it("runs the account actions against the API", async () => {
    mocks.clearLimit.mockResolvedValue({});
    mocks.updateAccount.mockResolvedValue({});
    mocks.deleteAccount.mockResolvedValue({ ok: true });
    await renderPage();
    await eventually(() => expect(region("Main server")).toBeTruthy());

    await click(buttonIn(row("Account M"), "Clear limit"));
    await eventually(() => expect(mocks.clearLimit).toHaveBeenCalledWith("acc-m"));

    await click(row("Account S").querySelector<HTMLButtonElement>('[role="switch"]')!);
    await eventually(() => expect(mocks.updateAccount).toHaveBeenCalledWith("acc-s", { poolEnabled: false }));

    await click(buttonIn(row("Account B"), "Set active again"));
    await eventually(() => expect(mocks.updateAccount).toHaveBeenCalledWith("acc-b", { status: "active" }));

    await click(buttonIn(row("Account T"), "Remove"));
    await eventually(() => expect(buttonIn(document.body, "Remove account")).toBeDefined());
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
    await click(buttonIn(document.body, "Remove account"));
    await eventually(() => expect(mocks.deleteAccount).toHaveBeenCalledWith("acc-t"));
  });

  it("adds a pasted token without ever rendering it, and shows the server's refusal", async () => {
    mocks.addAccount.mockRejectedValueOnce(
      new ApiError("This credential is already on a host. A credential can serve one host only.", 409, {}),
    );
    await renderPage();
    await eventually(() => expect(region("Runner")).toBeTruthy());

    await click(buttonIn(region("Runner"), "Add account"));
    await eventually(() => expect(document.body.querySelector("#ai-account-label")).toBeTruthy());
    // The server's own token can only be imported on the Paperclip server host.
    expect(document.body.textContent).not.toContain("Import the server's own token");
    expect(document.body.textContent).toContain("Import my saved Claude subscription");
    expect(document.body.textContent).toContain("Get it from a Mac");

    await type(document.body.querySelector<HTMLInputElement>("#ai-account-label")!, "Account R");
    const secret = document.body.querySelector<HTMLInputElement>("#ai-account-value")!;
    expect(secret.type).toBe("password");
    await type(secret, PASTED_TOKEN);
    expect(document.body.textContent).not.toContain(PASTED_TOKEN);

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    await click(buttonIn(dialog, "Add account"));
    await eventually(() => expect(mocks.addAccount).toHaveBeenCalledWith("host-runner", {
      label: "Account R",
      credentialType: "subscription",
      value: PASTED_TOKEN,
    }));
    await eventually(() =>
      expect(document.body.textContent).toContain("This credential is already on a host. A credential can serve one host only."));
    expect(document.body.textContent).not.toContain(PASTED_TOKEN);
  });

  it("shows shared and reserved accounts and saves a project reservation", async () => {
    mocks.setAccountProjects.mockResolvedValue({ accountId: "acc-s", projects: [WEBSITE, VPN] });
    await renderPage();
    await eventually(() => expect(region("Main server")).toBeTruthy());

    const shared = row("Account S").querySelector<HTMLElement>('[data-testid="account-projects"]')!;
    expect(shared.textContent).toContain("Shared (any project)");
    const reserved = row("Account M").querySelector<HTMLElement>('[data-testid="account-projects"]')!;
    expect(reserved.textContent).not.toContain("Shared (any project)");
    const chip = [...reserved.querySelectorAll<HTMLElement>('[data-slot="badge"]')].find((badge) => badge.textContent === "CLE · Mobile app");
    expect(chip?.getAttribute("title")).toBe("Cleanio");

    await click(buttonIn(row("Account S"), "Edit projects"));
    await eventually(() => expect(document.body.querySelector('[role="dialog"]')).toBeTruthy());
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("With nothing selected, the account is shared by every run on Main server.");
    // Grouped by company, companies and projects in name order.
    expect([...dialog.querySelectorAll("legend")].map((legend) => legend.textContent)).toEqual(["Cleanio", "Presto"]);
    expect(dialog.textContent).toContain("Nothing selected: this account is shared (any project).");

    const checkbox = (label: string) => {
      const target = [...dialog.querySelectorAll("label")].find((element) => element.textContent === label)!;
      return dialog.querySelector<HTMLButtonElement>(`#${CSS.escape(target.htmlFor)}`)!;
    };
    await click(checkbox("CLE · Website"));
    await click(checkbox("PRE · VPN core"));
    expect(dialog.textContent).toContain("Reserved for 2 projects.");
    await click(buttonIn(dialog, "Save projects"));
    await eventually(() => expect(mocks.setAccountProjects).toHaveBeenCalledWith("acc-s", ["project-web", "project-vpn"]));
  });

  it("makes a reserved account shared again with an empty selection", async () => {
    mocks.setAccountProjects.mockResolvedValue({ accountId: "acc-m", projects: [] });
    await renderPage();
    await eventually(() => expect(region("Main server")).toBeTruthy());

    await click(buttonIn(row("Account M"), "Edit projects"));
    await eventually(() => expect(document.body.querySelector('[role="dialog"]')).toBeTruthy());
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Reserved for 1 project.");
    const mobile = dialog.querySelector<HTMLButtonElement>('[role="checkbox"][aria-checked="true"]')!;
    await click(mobile);
    expect(dialog.textContent).toContain("Nothing selected: this account is shared (any project).");
    await click(buttonIn(dialog, "Save projects"));
    await eventually(() => expect(mocks.setAccountProjects).toHaveBeenCalledWith("acc-m", []));
  });

  it("switches a host's overflow to other accounts", async () => {
    mocks.updateHost.mockResolvedValue({});
    await renderPage();
    await eventually(() => expect(region("Runner")).toBeTruthy());

    const overflow = (name: string) => region(name).querySelector<HTMLButtonElement>('[role="switch"][aria-labelledby]')!;
    expect(overflow("Main server").getAttribute("aria-checked")).toBe("true");
    expect(region("Runner").textContent).toContain("Off: a project waits for its own accounts' reset.");
    expect(overflow("Runner").getAttribute("aria-checked")).toBe("false");

    await click(overflow("Runner"));
    await eventually(() => expect(mocks.updateHost).toHaveBeenCalledWith("host-runner", { overflowToOtherAccounts: true }));
    await click(overflow("Main server"));
    await eventually(() => expect(mocks.updateHost).toHaveBeenCalledWith("host-server", { overflowToOtherAccounts: false }));
  });

  it("explains when the viewer is not an instance admin", async () => {
    mocks.list.mockRejectedValue(new ApiError("Instance admin access required", 403, {}));
    await renderPage();
    await eventually(() =>
      expect(container.textContent).toContain("Instance admin access is required to manage Claude accounts."));
    expect(buttonIn(container, "Add host")).toBeUndefined();
  });
});
