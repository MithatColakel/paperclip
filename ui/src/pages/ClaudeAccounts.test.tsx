// @vitest-environment jsdom

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentAiAccountBindingSummary,
  AiAccountBindingAccountRef,
  AiAccountProjectSummary,
  AiAccountUsageWindow,
  CompanyAiAccountOption,
  ExecutionDeviceRef,
  MyAiAccount,
  SetAgentAiAccountResponse,
} from "@paperclipai/shared";
import { aiAccountPoolKeys } from "@/api/ai-account-pool";
import { ApiError } from "@/api/client";
import { DEVICE_LOGIN_NOT_PERMITTED_TEXT, POOL_PRODUCT_LINE } from "@/lib/ai-account-pool";
import { ClaudeAccounts } from "./ClaudeAccounts";

const mocks = vi.hoisted(() => ({
  api: {
    listMine: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    replaceCredential: vi.fn(),
    clearLimit: vi.fn(),
    remove: vi.fn(),
    listCompanyAccounts: vi.fn(),
    listBindings: vi.fn(),
    setAgentBinding: vi.fn(),
    clearAgentBinding: vi.fn(),
    reviewAgentBinding: vi.fn(),
  },
  listConnections: vi.fn(),
  isInstanceAdmin: vi.fn(() => false),
  setBreadcrumbs: vi.fn(),
}));

vi.mock("@/api/ai-account-pool", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/ai-account-pool")>()),
  aiAccountPoolApi: mocks.api,
}));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: { list: mocks.listConnections } }));
vi.mock("@/hooks/useIsInstanceAdmin", () => ({ useIsInstanceAdmin: () => mocks.isInstanceAdmin() }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: mocks.setBreadcrumbs }) }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [
      { id: "company-a", name: "Cleanio", issuePrefix: "CLE" },
      { id: "company-b", name: "Presto", issuePrefix: "PRE" },
    ],
    selectedCompanyId: "company-a",
    selectedCompany: { id: "company-a", name: "Cleanio", issuePrefix: "CLE" },
  }),
}));

// --- Fixtures --------------------------------------------------------------

const SUBSCRIPTION_TOKEN = `sk-ant-oat01-${"s".repeat(90)}`;
const API_KEY = `sk-ant-api03-${"k".repeat(90)}`;
const FUTURE = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
const EMPTY_WINDOW: AiAccountUsageWindow = { runs: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costCents: 0 };
const NO_USAGE = { lastFiveHours: EMPTY_WINDOW, lastSevenDays: EMPTY_WINDOW, thisMonth: EMPTY_WINDOW };
const MOBILE: AiAccountProjectSummary = { id: "project-mobile", name: "Mobile app", companyId: "company-a", companyName: "Cleanio", issuePrefix: "CLE" };
const SERVER: ExecutionDeviceRef = { id: "device-server", name: "Paperclip server", kind: "server", owner: null };
const BUILD_BOX: ExecutionDeviceRef = {
  id: "device-build",
  name: "Build box",
  kind: "external",
  owner: { userId: "user-ada", name: "Ada", email: "ad•••@example.com" },
};

function myAccount(overrides: Partial<MyAiAccount>): MyAiAccount {
  return {
    id: "acc",
    provider: "anthropic",
    credentialType: "subscription",
    label: "Account",
    emailHint: null,
    plan: null,
    origin: "pool",
    status: "active",
    statusMessage: null,
    state: "active",
    credentialHint: null,
    adminDisabled: false,
    adminDisabledReason: null,
    exhaustedUntil: null,
    limitReason: null,
    limitSource: null,
    lastLimitedAt: null,
    reservedProjects: [],
    usedBy: [],
    otherCompanies: 0,
    usage: NO_USAGE,
    lastUsedAt: null,
    createdAt: "2026-10-14T00:00:00.000Z",
    ...overrides,
  };
}

const TEAM_MAX = myAccount({
  id: "acc-max",
  label: "Team Max",
  emailHint: "mithat@example.com",
  plan: "Max 20x",
  credentialHint: "…a1b2",
  reservedProjects: [MOBILE],
  usedBy: [{ companyId: "company-a", companyName: "Cleanio", agents: [{ agentId: "agent-dev", agentName: "Dev", devices: [SERVER] }] }],
  otherCompanies: 2,
  usage: { ...NO_USAGE, lastFiveHours: { ...EMPTY_WINDOW, runs: 3, inputTokens: 12_300_000, outputTokens: 840_000 } },
});
const NIGHT_PRO = myAccount({
  id: "acc-night",
  label: "Night Pro",
  state: "limited",
  exhaustedUntil: FUTURE,
  limitReason: "provider_quota",
  limitSource: "estimated",
});
const OLD_KEY = myAccount({
  id: "acc-old",
  label: "Old key",
  credentialType: "api_key",
  status: "auth_failed",
  state: "signed_out",
  statusMessage: "The key was revoked.",
});
const SPARE = myAccount({ id: "acc-spare", label: "Spare", status: "disabled", state: "withdrawn" });

function companyOption(overrides: Partial<CompanyAiAccountOption>): CompanyAiAccountOption {
  return {
    id: "acc",
    label: "Account",
    credentialType: "subscription",
    plan: null,
    owner: { userId: "me", name: "Me", email: "me@example.com" },
    ownedByMe: true,
    state: "active",
    exhaustedUntil: null,
    limitSource: null,
    canBind: true,
    agents: [],
    devices: [],
    ...overrides,
  };
}

const MAX_OPTION = companyOption({
  id: "acc-max",
  label: "Team Max",
  plan: "Max 20x",
  agents: [{ agentId: "agent-dev", agentName: "Dev" }],
  devices: [SERVER],
});
const ADA_OPTION = companyOption({
  id: "acc-ada",
  label: "Ada Max",
  owner: { userId: "user-ada", name: "Ada", email: "ad•••@example.com" },
  ownedByMe: false,
  agents: [{ agentId: "agent-ops", agentName: "Ops" }],
  devices: [BUILD_BOX],
});

const MAX_REF: AiAccountBindingAccountRef = {
  id: "acc-max",
  label: "Team Max",
  credentialType: "subscription",
  state: "active",
  ownedByMe: true,
  ownerName: "Me",
  exhaustedUntil: null,
  limitSource: null,
};
const ADA_REF: AiAccountBindingAccountRef = { ...MAX_REF, id: "acc-ada", label: "Ada Max", ownedByMe: false, ownerName: "Ada" };

function binding(overrides: Partial<AgentAiAccountBindingSummary>): AgentAiAccountBindingSummary {
  return {
    agentId: "agent",
    agentName: "Agent",
    companyId: "company-a",
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
    ...overrides,
  };
}

const DEV = binding({
  agentId: "agent-dev",
  agentName: "Dev",
  state: "pool_account",
  mode: "pool_account",
  account: MAX_REF,
  source: "migrated_host_pool",
  migrationNote: "The account this agent used most in the last 45 days.",
  needsReview: true,
  devices: [SERVER],
});
const OPS = binding({
  agentId: "agent-ops",
  agentName: "Ops",
  state: "pool_account",
  mode: "pool_account",
  account: ADA_REF,
  pinned: false,
  canChange: false,
});
const NEWBIE = binding({ agentId: "agent-new", agentName: "Newbie" });
// Bound to an account whose owner left the company: the company sees no label.
const GHOST = binding({ agentId: "agent-ghost", agentName: "Ghost", state: "account_unavailable", mode: "pool_account", canChange: false });
const CODER = binding({
  agentId: "agent-codex",
  agentName: "Coder",
  adapterType: "codex_local",
  supported: false,
  state: "pool_account",
  mode: "pool_account",
  account: MAX_REF,
});

function setResponses({ admin = false }: { admin?: boolean } = {}) {
  mocks.api.listMine.mockResolvedValue({ accounts: [TEAM_MAX, NIGHT_PRO, OLD_KEY, SPARE] });
  mocks.api.listCompanyAccounts.mockImplementation(async (_companyId: string, options: { agentId?: string | null } = {}) => ({
    canBindAny: admin,
    accounts: options.agentId
      ? [
          { ...MAX_OPTION, selectable: true, reason: null },
          { ...ADA_OPTION, canBind: admin, selectable: admin, reason: admin ? null : "not_permitted" },
        ]
      : [MAX_OPTION, { ...ADA_OPTION, canBind: admin }],
  }));
  mocks.api.listBindings.mockResolvedValue({ bindings: [DEV, admin ? { ...OPS, canChange: true } : OPS, NEWBIE, GHOST, CODER] });
}

// --- Harness ---------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let originalResizeObserver: typeof ResizeObserver | undefined;

async function renderPage() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/CLE/company/settings/claude-accounts"]}>
          <ClaudeAccounts />
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
  return document.body.querySelector<HTMLElement>(`[role="region"][aria-label="${name}"]`)!;
}

function row(scope: ParentNode, name: string) {
  return scope.querySelector<HTMLElement>(`li[aria-label="${name}"]`)!;
}

function buttonIn(scope: ParentNode, text: string) {
  return [...scope.querySelectorAll("button")].find((element) => element.textContent?.trim() === text) as HTMLButtonElement | undefined;
}

function dialog() {
  return document.body.querySelector<HTMLElement>('[role="dialog"]');
}

function alertDialog() {
  return document.body.querySelector<HTMLElement>('[role="alertdialog"]');
}

async function click(element: HTMLElement | undefined | null) {
  expect(element).toBeTruthy();
  await act(async () => element!.click());
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function openPicker(scope: HTMLElement) {
  await click(scope.querySelector<HTMLButtonElement>("button[role='combobox']"));
}

/** Toggles the picker shut, then lets its focus scope return focus (a zero-delay timer) before anything else opens. */
async function closePicker(scope: HTMLElement) {
  await openPicker(scope);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function pickerItem(text: string) {
  return [...document.body.querySelectorAll<HTMLElement>('[data-slot="popover-content"][data-state="open"] [cmdk-item]')]
    .find((element) => element.textContent?.includes(text));
}

async function choose(text: string) {
  await eventually(() => expect(pickerItem(text)).toBeDefined());
  await act(async () => {
    pickerItem(text)!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function savedResponse(summary: AgentAiAccountBindingSummary, runningRunIds: string[] = []): SetAgentAiAccountResponse {
  return { ...summary, appliesFrom: "next_run", runningRunIds, warnings: [] };
}

beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // The account picker's list (cmdk) observes its size; jsdom has no ResizeObserver.
  originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  mocks.isInstanceAdmin.mockReturnValue(false);
  mocks.listConnections.mockResolvedValue({ currentUserId: "me", canManageConnections: false, connections: [] });
  setResponses();
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
  globalThis.ResizeObserver = originalResizeObserver!;
});

async function renderLoaded() {
  await renderPage();
  await eventually(() => {
    expect(row(region("My Claude accounts"), "Team Max")).toBeTruthy();
    expect(row(region("Agent assignments"), "Dev")).toBeTruthy();
    expect(row(region("Available in Cleanio"), "Ada Max")).toBeTruthy();
  });
}

// --- My accounts -------------------------------------------------------------

describe("ClaudeAccounts: my accounts", () => {
  it("shows the product line and each account's state, usage, reservation and use", async () => {
    await renderLoaded();
    const mine = region("My Claude accounts");
    expect(mine.textContent).toContain(POOL_PRODUCT_LINE);
    expect(mocks.setBreadcrumbs).toHaveBeenCalled();

    const max = row(mine, "Team Max");
    expect(max.textContent).toContain("Subscription");
    expect(max.querySelector("[data-account-state='active']")?.textContent).toBe("Active");
    expect(max.textContent).toContain("mi•••@example.com · Max 20x");
    expect(max.textContent).not.toContain("mithat@example.com");
    expect(max.textContent).toContain("…a1b2");
    expect(max.querySelector('[data-testid="account-used-by"]')?.textContent).toContain("Cleanio: Dev (Paperclip server)");
    expect(max.textContent).toContain("Agents in 2 other companies");
    expect(max.querySelector('[data-testid="account-usage"]')?.textContent).toContain("Last 5 h: 3 runs · 12.3M in · 840.0k out");
    const restriction = max.querySelector<HTMLElement>('[data-testid="account-restriction"]')!;
    expect(restriction.textContent).toContain("CLE · Mobile app");
    expect(buttonIn(restriction, "Clear")).toBeDefined();

    const night = row(mine, "Night Pro");
    expect(night.querySelector("[data-account-state='limited']")?.textContent).toMatch(/^Limited until .*\(estimated\)$/);
    expect(night.textContent).toContain("Its tasks wait for the reset.");
    expect(buttonIn(night, "Clear limit")).toBeDefined();
    expect(night.textContent).toContain("No agent uses it yet.");

    const old = row(mine, "Old key");
    expect(old.textContent).toContain("API key");
    expect(old.textContent).toContain("Signed out: The key was revoked. Replace the key to use it again");
    expect(buttonIn(old, "Replace key")).toBeDefined();
    expect(old.querySelector('[data-testid="account-usage"]')?.textContent).toContain("This month: $0.00");

    const spare = row(mine, "Spare");
    expect(spare.textContent).toContain("Paused by owner");
    expect(buttonIn(spare, "Resume")).toBeDefined();
    expect(buttonIn(spare, "Pause")).toBeUndefined();
  });

  it("does not poll my accounts, which sum usage, while the company lists stay current", async () => {
    await renderLoaded();
    const intervals = (queryKey: readonly unknown[]) =>
      client.getQueryCache().find({ queryKey, exact: true })?.observers.map((observer) => observer.options.refetchInterval);
    expect(intervals(aiAccountPoolKeys.mine)).toEqual([undefined]);
    expect(intervals(aiAccountPoolKeys.bindings("company-a"))).toEqual([60_000]);
    expect(intervals(aiAccountPoolKeys.companyAccounts("company-a"))).toEqual([60_000]);
  });

  it("runs the owner actions and refreshes the page after each", async () => {
    mocks.api.update.mockResolvedValue(TEAM_MAX);
    mocks.api.clearLimit.mockResolvedValue(NIGHT_PRO);
    await renderLoaded();
    const mine = region("My Claude accounts");
    expect(mocks.api.listMine).toHaveBeenCalledTimes(1);

    await click(buttonIn(row(mine, "Team Max").querySelector('[data-testid="account-restriction"]')!, "Clear"));
    await eventually(() => expect(mocks.api.update).toHaveBeenCalledWith("acc-max", { clearProjectRestriction: true }));
    await eventually(() => expect(mocks.api.listMine).toHaveBeenCalledTimes(2));

    await click(buttonIn(row(mine, "Night Pro"), "Clear limit"));
    await eventually(() => expect(mocks.api.clearLimit).toHaveBeenCalledWith("acc-night"));

    await click(buttonIn(row(mine, "Spare"), "Resume"));
    await eventually(() => expect(mocks.api.update).toHaveBeenCalledWith("acc-spare", { status: "active" }));

    // An account agents use asks first: their tasks wait while it is paused.
    await click(buttonIn(row(mine, "Team Max"), "Pause"));
    await eventually(() => expect(alertDialog()?.textContent).toContain("Pause Team Max?"));
    expect(mocks.api.update).not.toHaveBeenCalledWith("acc-max", { status: "disabled" });
    await click(buttonIn(alertDialog()!, "Pause account"));
    await eventually(() => expect(mocks.api.update).toHaveBeenCalledWith("acc-max", { status: "disabled" }));

    // An unused account pauses at once.
    await click(buttonIn(row(mine, "Night Pro"), "Pause"));
    await eventually(() => expect(mocks.api.update).toHaveBeenCalledWith("acc-night", { status: "disabled" }));
    await eventually(() => expect(mocks.api.listMine.mock.calls.length).toBeGreaterThan(2));
  });

  it("edits the name, plan and e-mail", async () => {
    mocks.api.update.mockResolvedValue(TEAM_MAX);
    await renderLoaded();
    await click(buttonIn(row(region("My Claude accounts"), "Team Max"), "Edit"));
    await eventually(() => expect(dialog()?.textContent).toContain("Edit Team Max"));
    await type(document.body.querySelector<HTMLInputElement>("#pool-account-acc-max-label")!, "Team Max 2");
    await type(document.body.querySelector<HTMLInputElement>("#pool-account-acc-max-plan")!, "");
    await click(buttonIn(dialog()!, "Save changes"));
    await eventually(() => expect(mocks.api.update).toHaveBeenCalledWith("acc-max", { label: "Team Max 2", plan: null }));
    await eventually(() => expect(dialog()).toBeNull());
  });

  it("replaces a key without ever rendering it, and clears the field on submit", async () => {
    const pending = deferred<MyAiAccount>();
    mocks.api.replaceCredential.mockReturnValue(pending.promise);
    await renderLoaded();
    await click(buttonIn(row(region("My Claude accounts"), "Old key"), "Replace key"));
    await eventually(() => expect(dialog()?.textContent).toContain("Replace the key of Old key"));

    const field = document.body.querySelector<HTMLInputElement>("#pool-account-acc-old-value")!;
    expect(field.type).toBe("password");
    await type(field, SUBSCRIPTION_TOKEN);
    expect(dialog()!.textContent).toContain("A Claude Console API key starts with sk-ant-api.");
    expect(buttonIn(dialog()!, "Replace key")?.disabled).toBe(true);

    await type(field, API_KEY);
    await click(buttonIn(dialog()!, "Replace key"));
    expect(document.body.querySelector<HTMLInputElement>("#pool-account-acc-old-value")!.value).toBe("");
    await eventually(() => expect(mocks.api.replaceCredential).toHaveBeenCalledWith("acc-old", { value: API_KEY }));

    await act(async () => pending.reject(new ApiError("Conflict", 409, { error: "Conflict", code: "ai_account_duplicate" })));
    await eventually(() => expect(dialog()?.textContent).toContain("This Claude account is already in Paperclip."));
    expect(dialog()!.textContent).toContain("The field was cleared when you submitted it.");
    expect(document.body.querySelector<HTMLInputElement>("#pool-account-acc-old-value")!.value).toBe("");
    expect(document.body.innerHTML).not.toContain(API_KEY);
  });

  it("removes an unused account, and releases the agents of one in use", async () => {
    mocks.api.remove.mockResolvedValueOnce(undefined);
    await renderLoaded();
    const mine = region("My Claude accounts");

    await click(buttonIn(row(mine, "Team Max"), "Remove"));
    await eventually(() => expect(alertDialog()?.textContent).toContain("Remove Team Max?"));
    const bindings = alertDialog()!.querySelector('[data-testid="remove-account-bindings"]')!;
    expect(bindings.textContent).toContain("Cleanio: Dev");
    expect(bindings.textContent).toContain("Agents in 2 other companies");
    await click(buttonIn(alertDialog()!, "Remove and release agents"));
    await eventually(() => expect(mocks.api.remove).toHaveBeenCalledWith("acc-max", { release: true }));
    await eventually(() => expect(alertDialog()).toBeNull());

    // The server knows of an agent the page did not show yet: the dialog says so and offers the release.
    mocks.api.remove.mockRejectedValueOnce(new ApiError("In use", 409, {
      error: "In use",
      code: "ai_account_in_use",
      details: {
        code: "ai_account_in_use",
        bindings: [{ agentId: "agent-night", agentName: "Night shift", companyId: "company-b", companyName: "Presto" }],
        otherCompanies: 0,
      },
    }));
    mocks.api.remove.mockResolvedValueOnce(undefined);
    await click(buttonIn(row(mine, "Spare"), "Remove"));
    await eventually(() => expect(alertDialog()?.textContent).toContain("No agent uses it."));
    await click(buttonIn(alertDialog()!, "Remove account"));
    await eventually(() => expect(mocks.api.remove).toHaveBeenCalledWith("acc-spare", { release: false }));
    await eventually(() => expect(alertDialog()?.textContent).toContain("Presto: Night shift"));
    await click(buttonIn(alertDialog()!, "Remove and release agents"));
    await eventually(() => expect(mocks.api.remove).toHaveBeenCalledWith("acc-spare", { release: true }));
    await eventually(() => expect(alertDialog()).toBeNull());
  });
});

// --- Add dialog ------------------------------------------------------------

describe("ClaudeAccounts: add dialog", () => {
  async function openAddDialog() {
    await click(buttonIn(region("My Claude accounts"), "Add account"));
    await eventually(() => expect(document.body.querySelector("#pool-account-label")).toBeTruthy());
    return dialog()!;
  }

  it("offers paste and my own saved connection, but not the server's token, to a member", async () => {
    await renderLoaded();
    const add = await openAddDialog();
    const sources = [...add.querySelectorAll('[role="radiogroup"][aria-label="Credential source"] [role="radio"]')]
      .map((element) => element.textContent);
    expect(sources).toHaveLength(2);
    expect(sources[0]).toContain("Paste a token");
    expect(sources[1]).toContain("Import my saved Claude subscription");
    expect(add.textContent).not.toContain("Import the server's own token");
  });

  it("imports the server's own token into an instance admin's pool", async () => {
    mocks.isInstanceAdmin.mockReturnValue(true);
    mocks.api.create.mockResolvedValue(myAccount({ id: "acc-server", label: "Server token" }));
    await renderLoaded();
    const add = await openAddDialog();
    const serverSource = [...add.querySelectorAll<HTMLElement>('[role="radio"]')]
      .find((element) => element.textContent?.includes("Import the server's own token"));
    await click(serverSource);
    expect(add.textContent).toContain("The server reads its own CLAUDE_CODE_OAUTH_TOKEN");
    expect(document.body.querySelector("#pool-account-value")).toBeNull();

    await type(document.body.querySelector<HTMLInputElement>("#pool-account-label")!, "Server token");
    await click(buttonIn(add, "Import token"));
    await eventually(() => expect(mocks.api.create).toHaveBeenCalledWith({
      label: "Server token",
      credentialType: "subscription",
      importFrom: { kind: "server_env" },
    }));
    await eventually(() => expect(dialog()).toBeNull());
    await eventually(() => expect(mocks.api.listMine).toHaveBeenCalledTimes(2));
  });

  it("adds a pasted token, clears the field on submit and never shows the token again", async () => {
    const pending = deferred<MyAiAccount>();
    mocks.api.create.mockReturnValue(pending.promise);
    await renderLoaded();
    const add = await openAddDialog();

    await type(document.body.querySelector<HTMLInputElement>("#pool-account-label")!, "Night shift");
    await type(document.body.querySelector<HTMLInputElement>("#pool-account-plan")!, "Max 5x");
    const field = document.body.querySelector<HTMLInputElement>("#pool-account-value")!;
    expect(field.type).toBe("password");
    // Terminals wrap long tokens; the pasted spaces are removed.
    await type(field, `${SUBSCRIPTION_TOKEN.slice(0, 40)} ${SUBSCRIPTION_TOKEN.slice(40)}`);
    expect(document.body.textContent).not.toContain(SUBSCRIPTION_TOKEN.slice(13));

    await click(buttonIn(add, "Add account"));
    expect(document.body.querySelector<HTMLInputElement>("#pool-account-value")!.value).toBe("");
    await eventually(() => expect(mocks.api.create).toHaveBeenCalledWith({
      label: "Night shift",
      credentialType: "subscription",
      plan: "Max 5x",
      value: SUBSCRIPTION_TOKEN,
    }));
    expect(buttonIn(add, "Adding…")?.disabled).toBe(true);

    await act(async () => pending.reject(new ApiError("Conflict", 409, { error: "Conflict", code: "ai_account_duplicate" })));
    await eventually(() => expect(add.textContent).toContain("This Claude account is already in Paperclip. Each account can be added once."));
    expect(add.textContent).toContain("Paste the token again to try once more.");
    expect(document.body.querySelector<HTMLInputElement>("#pool-account-value")!.value).toBe("");
    expect(document.body.innerHTML).not.toContain(SUBSCRIPTION_TOKEN.slice(13));
    // The request's variables never held the token either.
    expect(JSON.stringify(client.getMutationCache().getAll().map((mutation) => mutation.state.variables))).not.toContain(
      SUBSCRIPTION_TOKEN,
    );
  });

  it("forgets a typed token when the dialog closes", async () => {
    await renderLoaded();
    const add = await openAddDialog();
    await type(document.body.querySelector<HTMLInputElement>("#pool-account-value")!, SUBSCRIPTION_TOKEN);
    await click(buttonIn(add, "Cancel"));
    await eventually(() => expect(dialog()).toBeNull());

    await openAddDialog();
    expect(document.body.querySelector<HTMLInputElement>("#pool-account-value")!.value).toBe("");
    expect(mocks.api.create).not.toHaveBeenCalled();
  });

  it("imports only my own saved Claude connection, and ignores companies it cannot read", async () => {
    mocks.listConnections.mockImplementation(async (companyId: string) => {
      if (companyId === "company-b") throw new ApiError("Forbidden", 403, { error: "Forbidden" });
      return {
        currentUserId: "me",
        canManageConnections: true,
        connections: [
          { id: "conn-mine", grantId: "grant-1", companyId, provider: "anthropic", method: "subscription", name: "My Claude Max", accountLabel: "Claude Max", ownership: "personal", ownerUserId: "me", isDefault: true, status: "connected" },
          { id: "conn-shared", grantId: "grant-2", companyId, provider: "anthropic", method: "subscription", name: "Team shared", ownership: "shared", isDefault: false, status: "connected" },
          { id: "conn-theirs", grantId: "grant-3", companyId, provider: "anthropic", method: "subscription", name: "Ada's Max", ownership: "personal", ownerUserId: "user-ada", isDefault: false, status: "connected" },
          { id: "conn-key", grantId: "grant-4", companyId, provider: "anthropic", method: "api_key", name: "My key", ownership: "personal", ownerUserId: "me", isDefault: false, status: "connected" },
        ],
      };
    });
    mocks.api.create.mockResolvedValue(myAccount({ id: "acc-imported", label: "Imported" }));
    await renderLoaded();
    const add = await openAddDialog();
    const importSource = [...add.querySelectorAll<HTMLElement>('[role="radio"]')]
      .find((element) => element.textContent?.includes("Import my saved Claude subscription"));
    await click(importSource);
    await eventually(() => expect(add.querySelector('[role="radiogroup"][aria-label="Your Claude connections"]')).toBeTruthy());

    const connections = add.querySelector('[role="radiogroup"][aria-label="Your Claude connections"]')!;
    expect(connections.textContent).toContain("My Claude Max");
    expect(connections.textContent).toContain("Cleanio · Claude Max");
    expect(connections.textContent).not.toContain("Team shared");
    expect(connections.textContent).not.toContain("Ada's Max");
    expect(connections.textContent).not.toContain("My key");
    expect(add.textContent).not.toContain("Could not load your connections");

    await type(document.body.querySelector<HTMLInputElement>("#pool-account-label")!, "Imported");
    await click(buttonIn(add, "Import connection"));
    await eventually(() => expect(mocks.api.create).toHaveBeenCalledWith({
      label: "Imported",
      credentialType: "subscription",
      importFrom: { kind: "ai_connection", companyId: "company-a", connectionId: "conn-mine" },
    }));
  });
});

// --- Available accounts and bindings ----------------------------------------------

describe("ClaudeAccounts: available accounts and agent assignments", () => {
  it("lists the accounts available in the company with owner, agents and devices", async () => {
    await renderLoaded();
    const available = region("Available in Cleanio");
    expect(row(available, "Team Max").textContent).toContain("Yours · Max 20x");
    const ada = row(available, "Ada Max");
    expect(ada.textContent).toContain("Owner Ada");
    expect(ada.textContent).toContain("Agents: Ops");
    expect(ada.textContent).toContain("Devices: Build box — owner ad•••@example.com");
  });

  it("shows each Claude agent's account and devices", async () => {
    await renderLoaded();
    const assignments = region("Agent assignments");
    const dev = row(assignments, "Dev");
    expect(dev.querySelector("button[role='combobox']")?.textContent).toContain("Team Max");
    expect(dev.textContent).toContain("Paperclip server");
    expect(dev.querySelector("a")?.getAttribute("href")).toContain("/agents/");

    const ops = row(assignments, "Ops");
    expect(ops.textContent).toContain("Varies by project: Build box — owner ad•••@example.com");
    expect(ops.querySelector<HTMLButtonElement>("button[role='combobox']")?.disabled).toBe(true);
    expect(ops.textContent).toContain("Only a company admin or the owner of its current account can change this.");

    const ghost = row(assignments, "Ghost");
    expect(ghost.querySelector("button[role='combobox']")?.textContent).toContain("An account that is no longer available in this company");
    expect(ghost.textContent).toContain("Its tasks wait until someone chooses another account.");

    const newbie = row(assignments, "Newbie");
    expect(newbie.textContent).toContain("Not set: the agent's AI connection or the device's own login applies");
    expect(buttonIn(newbie, "Clear")).toBeUndefined();
    expect(mocks.api.listCompanyAccounts).not.toHaveBeenCalledWith("company-a", { agentId: "agent-new" });
  });

  it("saves a change from the next run and refreshes the assignments", async () => {
    mocks.api.setAgentBinding.mockResolvedValue(savedResponse({ ...NEWBIE, state: "pool_account", mode: "pool_account", account: MAX_REF }, ["run-1"]));
    await renderLoaded();
    const newbie = row(region("Agent assignments"), "Newbie");
    await openPicker(newbie);
    await eventually(() => expect(mocks.api.listCompanyAccounts).toHaveBeenCalledWith("company-a", { agentId: "agent-new" }));
    await choose("Team Max");
    await eventually(() => expect(mocks.api.setAgentBinding).toHaveBeenCalledWith("agent-new", { mode: "pool_account", accountId: "acc-max" }));
    await eventually(() => expect(row(region("Agent assignments"), "Newbie").textContent)
      .toContain("Saved. It applies from the agent's next run. The run in progress keeps its account."));
    expect(mocks.api.listBindings.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("shows a 422 refusal on the row, naming the device", async () => {
    mocks.api.setAgentBinding.mockRejectedValue(new ApiError("Incompatible", 422, {
      error: "Incompatible",
      code: "ai_account_incompatible",
      details: { code: "ai_account_incompatible", reason: "credential_type_unsupported", deviceName: "Build box", environmentName: "Studio" },
    }));
    await renderLoaded();
    await openPicker(row(region("Agent assignments"), "Newbie"));
    await choose("Team Max");
    await eventually(() => expect(row(region("Agent assignments"), "Newbie").querySelector('[role="alert"]')?.textContent).toBe(
      "Build box: The agent's device does not accept this account's credential type. Choose another account, or move the agent to another device.",
    ));
  });

  it("shows a device limit with other companies' accounts as a count only", async () => {
    mocks.api.setAgentBinding.mockRejectedValue(new ApiError("Device account limit", 409, {
      error: "Device account limit",
      code: "device_account_limit",
      details: { code: "device_account_limit", deviceId: "device-build", deviceName: "Build box", limit: 3, inUse: 3, accounts: ["Ada Max"], otherCompaniesAccounts: 2 },
    }));
    await renderLoaded();
    await openPicker(row(region("Agent assignments"), "Newbie"));
    await choose("Team Max");
    await eventually(() => expect(row(region("Agent assignments"), "Newbie").querySelector('[role="alert"]')?.textContent).toBe(
      "Build box already runs 3 of 3 Claude accounts (Ada Max, 2 accounts of other companies). Choose an account already on that device, or free a slot first.",
    ));
  });

  it("lets an owner switch only an agent on their own account to the device's own login", async () => {
    mocks.api.setAgentBinding.mockResolvedValue(savedResponse({ ...DEV, state: "device_login", mode: "device_login", account: null }));
    await renderLoaded();
    const assignments = region("Agent assignments");

    await openPicker(row(assignments, "Newbie"));
    await eventually(() => expect(pickerItem("Device's own login")?.getAttribute("aria-disabled")).toBe("true"));
    expect(pickerItem("Device's own login")?.textContent).toContain(DEVICE_LOGIN_NOT_PERMITTED_TEXT);
    expect(pickerItem("Ada Max")?.getAttribute("aria-disabled")).toBe("true");
    await closePicker(row(assignments, "Newbie"));

    await openPicker(row(assignments, "Dev"));
    await eventually(() => expect(pickerItem("Device's own login")).toBeDefined());
    expect(pickerItem("Device's own login")?.getAttribute("aria-disabled")).not.toBe("true");
    await choose("Device's own login");
    await eventually(() => expect(mocks.api.setAgentBinding).toHaveBeenCalledWith("agent-dev", { mode: "device_login" }));
  });

  it("clears an agent's account back to its AI connection", async () => {
    mocks.api.clearAgentBinding.mockResolvedValue(undefined);
    await renderLoaded();
    await click(buttonIn(row(region("Agent assignments"), "Dev"), "Clear"));
    await eventually(() => expect(mocks.api.clearAgentBinding).toHaveBeenCalledWith("agent-dev"));
  });

  it("asks a company admin to review migrated assignments, one by one or all at once", async () => {
    setResponses({ admin: true });
    mocks.api.reviewAgentBinding.mockResolvedValue({ ...DEV, needsReview: false, reviewedAt: "2026-10-16T12:00:00.000Z" });
    await renderLoaded();
    await eventually(() => expect(region("Review migrated assignments")).toBeTruthy());
    const banner = region("Review migrated assignments");
    expect(banner.textContent).toContain("Review migrated assignments (1)");
    const dev = row(region("Agent assignments"), "Dev");
    expect(dev.textContent).toContain("The account this agent used most in the last 45 days.");

    await click(buttonIn(banner, "Show only these"));
    expect(row(region("Agent assignments"), "Newbie")).toBeNull();
    await click(buttonIn(banner, "Show all agents"));
    expect(row(region("Agent assignments"), "Newbie")).toBeTruthy();

    await click(buttonIn(dev, "Confirm"));
    await eventually(() => expect(mocks.api.reviewAgentBinding).toHaveBeenCalledWith("agent-dev"));
    mocks.api.reviewAgentBinding.mockClear();
    await click(buttonIn(region("Review migrated assignments"), "Confirm all"));
    await eventually(() => expect(mocks.api.reviewAgentBinding).toHaveBeenCalledWith("agent-dev"));
  });

  it("tells members that a company admin confirms migrated assignments", async () => {
    await renderLoaded();
    await eventually(() => expect(region("Review migrated assignments")).toBeTruthy());
    const banner = region("Review migrated assignments");
    expect(banner.textContent).toContain("A company admin confirms them.");
    expect(buttonIn(banner, "Confirm all")).toBeUndefined();
    expect(buttonIn(row(region("Agent assignments"), "Dev"), "Confirm")).toBeUndefined();
  });

  it("lists agents that moved to another adapter with their account, so it can be removed", async () => {
    mocks.api.clearAgentBinding.mockResolvedValue(undefined);
    await renderLoaded();
    const others = region("Agents on another adapter");
    expect(row(region("Agent assignments"), "Coder")).toBeTruthy();
    const coder = row(others, "Coder");
    expect(coder.textContent).toContain("Team Max");
    await click(buttonIn(coder, "Remove"));
    await eventually(() => expect(mocks.api.clearAgentBinding).toHaveBeenCalledWith("agent-codex"));
  });
});

// --- Public core ------------------------------------------------------------

// Plain paths: under jsdom the global URL is not the one node:fs accepts.
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [path];
  });
}

describe("public core", () => {
  it("asks no plugin for a Claude token: device token flows live on the plugins' own pages", () => {
    const uiSource = join(dirname(fileURLToPath(import.meta.url)), "..");
    const offenders = sourceFiles(uiSource).filter((file) => /claude-token/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});
