// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { AiManagedConnectionSummary } from "@paperclipai/shared";
import { CLAUDE_ROUTER_RETIRED_TEXT } from "@/lib/agent-claude-account";
import { AiConnectionField } from "./AiConnectionField";
import type { AiConnectionCredentialStep } from "./AiConnectionCredentialStep";

const mocks = vi.hoisted(() => ({ list: vi.fn(), setDefault: vi.fn() }));
let credentialProps: ComponentProps<typeof AiConnectionCredentialStep> | undefined;
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: mocks }));
vi.mock("./AiConnectionCredentialStep", () => ({
  AiConnectionCredentialStep: (props: ComponentProps<typeof AiConnectionCredentialStep>) => {
    credentialProps = props;
    return <div>Provider sign-in</div>;
  },
}));
vi.mock("./AiConnectionManagement", () => ({ AiConnectionLegacyNotice: () => null }));
vi.mock("@/pages/apps/AppLogo", () => ({ AppLogo: () => null }));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const onChange = vi.fn();
const account = (overrides: Partial<AiManagedConnectionSummary> = {}): AiManagedConnectionSummary => ({
  id: "old-connection", grantId: "old-grant", companyId: "company",
  provider: "anthropic", method: "subscription", name: "My Claude",
  ownership: "personal", ownerUserId: "owner", isDefault: true,
  status: "needs_attention", ...overrides,
});
async function settle() {
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
    flushSync(() => {});
  }
}
async function mount(connections: AiManagedConnectionSummary[], canManageConnections = true, agentId: string | null = "agent") {
  mocks.list.mockResolvedValue({ currentUserId: "owner", connections, canManageConnections });
  flushSync(() => root.render(<QueryClientProvider client={client}>
    <AiConnectionField companyId="company" agentId={agentId ?? undefined} agentName="Nova" adapterType="claude_local"
      value={{ provider: "anthropic", method: "subscription", mode: "responsible_user" }} onChange={onChange} />
  </QueryClientProvider>));
  await settle();
}
function click(label: string) {
  const button = Array.from(document.querySelectorAll("button")).find(item => item.textContent === label || item.getAttribute("aria-label") === label);
  expect(button, `Missing button: ${label}`).toBeDefined();
  flushSync(() => button!.click());
}
beforeEach(() => {
  vi.clearAllMocks();
  credentialProps = undefined;
  mocks.setDefault.mockResolvedValue({});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(() => { flushSync(() => root.unmount()); client.clear(); container.remove(); });

it("reconnects the unavailable personal default in place", async () => {
  await mount([account()]);
  click("Reconnect account");
  expect(credentialProps).toMatchObject({ connectionId: "old-connection", initialMethod: "subscription", fixedMethod: true });
  credentialProps!.onComplete({ connectionId: "old-connection", grantId: "old-grant", method: "subscription" });
  await settle();
  expect(mocks.setDefault).not.toHaveBeenCalled();
  expect(onChange).toHaveBeenCalledWith({ provider: "anthropic", method: "subscription", mode: "responsible_user" });
});

it("selects the returned new grant and actual method before adopting the personal default", async () => {
  await mount([account()]);
  click("Connect another account");
  click("My account");
  expect(document.body.textContent).toContain("default");
  expect(credentialProps).toMatchObject({ connectionId: undefined, allAgents: true });
  let resolveDefault!: () => void;
  mocks.setDefault.mockImplementation(() => new Promise<void>(resolve => { resolveDefault = resolve; }));
  credentialProps!.onComplete({ connectionId: "new-connection", grantId: "new-grant", method: "api_key" });
  await settle();
  expect(mocks.setDefault).toHaveBeenCalledWith("company", "new-grant");
  expect(onChange).not.toHaveBeenCalled();
  resolveDefault();
  await settle();
  expect(onChange).toHaveBeenCalledWith({ provider: "anthropic", method: "api_key", mode: "responsible_user" });
});

it("lets the owner limit a new personal connection to this agent", async () => {
  await mount([]);
  click("Connect another account");
  click("My account");
  const checkbox = document.querySelector<HTMLButtonElement>('[role="checkbox"]')!;
  expect(checkbox).not.toBeNull();
  expect(checkbox.getAttribute("aria-checked")).toBe("true");
  flushSync(() => checkbox.click());
  expect(credentialProps).toMatchObject({ allAgents: false, agentIds: ["agent"] });
});

it("keeps default-update failures visible and retries without another provider login", async () => {
  await mount([account()]);
  click("Connect another account");
  click("My account");
  mocks.setDefault.mockRejectedValueOnce(new Error("Default update failed"));
  credentialProps!.onComplete({ connectionId: "new-connection", grantId: "new-grant", method: "api_key" });
  await settle();
  expect(document.body.textContent).toContain("Default update failed");
  expect(onChange).not.toHaveBeenCalled();
  click("Retry default selection");
  await settle();
  expect(mocks.setDefault).toHaveBeenCalledTimes(2);
  expect(onChange).toHaveBeenCalledWith({ provider: "anthropic", method: "api_key", mode: "responsible_user" });
});

it("does not offer reconnection for a healthy default or another owner's account", async () => {
  await mount([account({ status: "connected" }), account({ id: "someone-else", ownerUserId: "other" })]);
  expect(document.body.textContent).not.toContain("Reconnect account");
});

it("keeps an ordinary member's new connection scoped to the current agent by default", async () => {
  await mount([], false);
  click("Connect another account");
  expect(credentialProps).toMatchObject({ allAgents: false, agentIds: ["agent"] });
});

it("uses the server's connection-manager permission for company-wide access", async () => {
  await mount([], true);
  click("Connect another account");
  click("My account");
  expect(credentialProps).toMatchObject({ allAgents: true });
});

it("offers an ordinary member no company-shared account for this agent", async () => {
  // Creating company-shared access needs a connection manager; the server
  // refuses it for anyone else, so the dialog keeps the personal path.
  await mount([], false);
  click("Connect another account");
  expect(document.body.textContent).not.toContain("Only Nova");
  expect(credentialProps).toMatchObject({ ownership: "personal", allAgents: false, agentIds: ["agent"], name: "My Claude subscription" });
  credentialProps!.onComplete({ connectionId: "new-connection", grantId: "new-grant", method: "subscription" });
  await settle();
  expect(mocks.setDefault).toHaveBeenCalledWith("company", "new-grant");
  expect(onChange).toHaveBeenCalledWith({ provider: "anthropic", method: "subscription", mode: "responsible_user" });
});

it("defaults a connection manager to an account for this agent only", async () => {
  await mount([], true);
  click("Connect another account");
  const choice = (label: string) => document.querySelector(`button[aria-label="${label}"]`);
  expect(choice("Only Nova")?.getAttribute("aria-pressed")).toBe("true");
  expect(choice("My account")?.getAttribute("aria-pressed")).toBe("false");
  expect(credentialProps).toMatchObject({ ownership: "shared", allAgents: false, agentIds: ["agent"] });
});

it("connects a new account for this agent only and selects it", async () => {
  await mount([account()]);
  click("Connect another account");
  expect(credentialProps).toMatchObject({ ownership: "shared", agentIds: ["agent"], allAgents: false, name: "Nova Claude subscription", connectionId: undefined });
  expect(document.querySelector('[role="checkbox"]')).toBeNull();
  credentialProps!.onComplete({ connectionId: "new-connection", grantId: "new-grant", method: "subscription" });
  await settle();
  expect(mocks.setDefault).not.toHaveBeenCalled();
  expect(onChange).toHaveBeenCalledWith({ provider: "anthropic", method: "subscription", mode: "shared", connectionId: "new-connection", grantId: "new-grant" });
});

it("keeps the personal account path when the user chooses it", async () => {
  await mount([]);
  click("Connect another account");
  click("My account");
  expect(credentialProps).toMatchObject({ ownership: "personal", agentIds: ["agent"], name: "My Claude subscription" });
  credentialProps!.onComplete({ connectionId: "new-connection", grantId: "new-grant", method: "subscription" });
  await settle();
  expect(mocks.setDefault).toHaveBeenCalledWith("company", "new-grant");
  expect(onChange).toHaveBeenCalledWith({ provider: "anthropic", method: "subscription", mode: "responsible_user" });
});

it("offers no agent-only account before the agent exists", async () => {
  await mount([], true, null);
  click("Connect another account");
  expect(document.body.textContent).not.toContain("Only Nova");
  expect(credentialProps).toMatchObject({ ownership: "personal", agentIds: [] });
});

// Fork: Paperclip never moves a task to another account, so a claude_local
// agent gets no new router binding, and the company pool takes no new agents.
describe("account switching choices", () => {
  const pool = (id: string, name: string, provider: "anthropic" | "openai") => ({
    id, companyId: "company", pluginKey: "router", revision: 1, name, enabled: true,
    mode: "round_robin", thresholdPercent: 90,
    members: [{
      id: `${id.slice(0, -1)}9`,
      binding: { provider, method: "subscription", mode: "shared", connectionId: "33333333-3333-4333-8333-333333333333", grantId: "44444444-4444-4444-8444-444444444444" },
      profile: provider === "anthropic" ? { provider: "acpx", acpxAgent: "claude", model: "claude-sonnet" } : { provider: "codex", model: "gpt-5" },
    }],
  });
  const CLAUDE_POOL = pool("11111111-1111-4111-8111-111111111111", "Claude rotation", "anthropic");
  const OTHER_CLAUDE_POOL = pool("22222222-2222-4222-8222-222222222222", "Second rotation", "anthropic");
  const CODEX_POOL = pool("55555555-5555-4555-8555-555555555555", "Codex rotation", "openai");

  async function mountField(input: {
    adapterType?: string;
    value?: ComponentProps<typeof AiConnectionField>["value"];
    pools?: unknown[];
    connections?: AiManagedConnectionSummary[];
  }) {
    const adapterType = input.adapterType ?? "claude_local";
    mocks.list.mockResolvedValue({ currentUserId: "owner", connections: input.connections ?? [], canManageConnections: true, pools: input.pools ?? [] });
    flushSync(() => root.render(<QueryClientProvider client={client}>
      <AiConnectionField companyId="company" agentId="agent" agentName="Nova" adapterType={adapterType} routerAdapterType={adapterType}
        value={input.value ?? { provider: "anthropic", method: "subscription", mode: "responsible_user" }} onChange={onChange} />
    </QueryClientProvider>));
    await settle();
  }
  const routerOptions = () => Array.from(document.querySelectorAll("select option")).map((option) => option.textContent);

  it("hides router pools from a claude_local agent", async () => {
    await mountField({ pools: [CLAUDE_POOL] });
    expect(document.querySelector("select")).toBeNull();
    expect(document.body.textContent).not.toContain("Experimental pool");
    expect(document.body.textContent).toContain("Responsible user’s connection");
  });

  it("keeps router pools for other adapters", async () => {
    await mountField({ adapterType: "codex_local", value: { provider: "openai", method: "subscription", mode: "responsible_user" }, pools: [CODEX_POOL] });
    expect(routerOptions()).toEqual(["Individual account", "Codex rotation · Experimental pool"]);
  });

  it("says a codex agent's router rotates, as before", async () => {
    await mountField({ adapterType: "codex_local", value: { mode: "router", connectionId: CODEX_POOL.id }, pools: [CODEX_POOL] });
    expect(document.body.textContent).toContain("New tasks rotate. Existing tasks keep their account.");
    expect(document.body.textContent).not.toContain(CLAUDE_ROUTER_RETIRED_TEXT);
  });

  it("keeps a claude_local agent's current router listed so it can move off, and offers no other", async () => {
    await mountField({ value: { mode: "router", connectionId: CLAUDE_POOL.id }, pools: [CLAUDE_POOL, OTHER_CLAUDE_POOL] });
    expect(routerOptions()).toEqual(["Individual account", "Claude rotation · Experimental pool"]);
    // The router is retired for Claude agents: no rotation is promised.
    expect(document.body.textContent).toContain(CLAUDE_ROUTER_RETIRED_TEXT);
    expect(document.body.textContent).not.toContain("New tasks rotate");
    const select = document.querySelector("select")!;
    flushSync(() => {
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith({ mode: "responsible_user", provider: "anthropic", method: "subscription" });
  });

  it("offers the retired company pool only to an agent already on it", async () => {
    const shared = account({ id: "shared-connection", ownership: "shared", status: "connected", isDefault: false, name: "Team Claude" });
    await mountField({ connections: [shared] });
    expect(document.querySelector('button[aria-label="Team Claude"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain("Company account pool");
    flushSync(() => root.render(<div />));

    await mountField({ connections: [shared], value: { provider: "anthropic", method: "subscription", mode: "company_pool" } });
    const retired = document.querySelector('button[aria-label="Company account pool (retired)"]');
    expect(retired?.getAttribute("aria-pressed")).toBe("true");
    expect(retired?.textContent).toContain("waits for that account’s reset at a usage limit");
    expect(retired?.textContent).not.toContain("moves to the next account");
  });
});
