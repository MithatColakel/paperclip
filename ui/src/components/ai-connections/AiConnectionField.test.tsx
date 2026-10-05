// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiConnectionBinding } from "@paperclipai/shared";

const api = vi.hoisted(() => ({
  list: vi.fn(async () => ({ currentUserId: "user-1", connections: [] })),
}));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: api }));
const step = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));
vi.mock("./AiConnectionCredentialStep", () => ({
  AiConnectionCredentialStep: (props: Record<string, unknown> & { onComplete: (result: unknown) => void }) => {
    step.props.push(props);
    return (
      <button type="button" onClick={() => props.onComplete({ connectionId: "11111111-1111-4111-8111-111111111111", grantId: "22222222-2222-4222-8222-222222222222", method: "subscription" })}>
        Finish connecting
      </button>
    );
  },
}));

import { AiConnectionField } from "./AiConnectionField";

let root: Root | undefined;
beforeEach(() => {
  step.props = [];
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

async function mount(agentId?: string) {
  const onChange = vi.fn<(binding: AiConnectionBinding) => void>();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <AiConnectionField
          companyId="company-1"
          agentId={agentId}
          agentName="PM"
          adapterType="claude_local"
          value={{ provider: "anthropic", method: "subscription", mode: "responsible_user" }}
          onChange={onChange}
          environmentId="ssh-env"
        />
      </QueryClientProvider>,
    );
  });
  return { onChange };
}
async function click(label: string) {
  const button = [...document.body.querySelectorAll("button")].find(
    (item) => item.getAttribute("aria-label") === label || item.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Missing button ${label}`);
  await act(async () => button.click());
}

describe("AiConnectionField connect another account", () => {
  it("connects a new account for this agent only and selects it", async () => {
    const { onChange } = await mount("agent-pm");
    await click("Connect another account");
    expect(step.props.at(-1)).toMatchObject({ ownership: "shared", agentIds: ["agent-pm"], allAgents: false, name: "PM Claude subscription", environmentId: "ssh-env" });
    await click("Finish connecting");
    expect(onChange).toHaveBeenCalledWith({
      provider: "anthropic",
      method: "subscription",
      mode: "shared",
      connectionId: "11111111-1111-4111-8111-111111111111",
      grantId: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("keeps the personal account path when the user chooses it", async () => {
    const { onChange } = await mount("agent-pm");
    await click("Connect another account");
    await click("My account");
    expect(step.props.at(-1)).toMatchObject({ ownership: "personal", agentIds: ["agent-pm"], name: "My Claude subscription" });
    await click("Finish connecting");
    expect(onChange).toHaveBeenCalledWith({ provider: "anthropic", method: "subscription", mode: "responsible_user" });
  });

  it("offers no agent-only account before the agent exists", async () => {
    const { onChange } = await mount();
    await click("Connect another account");
    expect(document.body.textContent).not.toContain("Only PM");
    expect(step.props.at(-1)).toMatchObject({ ownership: "personal", agentIds: [] });
    await click("Finish connecting");
    expect(onChange).toHaveBeenCalledWith({ provider: "anthropic", method: "subscription", mode: "responsible_user" });
  });
});
