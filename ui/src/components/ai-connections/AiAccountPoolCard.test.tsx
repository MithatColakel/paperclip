// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiConnectionPoolSummary } from "@paperclipai/shared";

const first = { connectionId: "c1", grantId: "g1" };
const second = { connectionId: "c2", grantId: "g2" };
const summary: AiConnectionPoolSummary = {
  companyId: "company-1",
  provider: "anthropic",
  members: [
    {
      ...first, provider: "anthropic", method: "subscription", priority: 0, name: "Max one", status: "connected",
      exhaustedUntil: "2099-01-01T16:00:00.000Z", quotaReason: "provider_quota", quotaSource: "run_failure",
      usageCheckedAt: null, usageWindows: [{ key: "five_hour", usedPercent: 100, resetsAt: null }],
    },
    {
      ...second, provider: "anthropic", method: "subscription", priority: 1, name: "Max two", status: "connected",
      exhaustedUntil: null, quotaReason: null, quotaSource: null, usageCheckedAt: null, usageWindows: [],
    },
  ],
  candidates: [{ connectionId: "c3", grantId: "g3", method: "api_key", name: "API fallback", status: "connected" }],
};
const api = vi.hoisted(() => ({
  pool: vi.fn(),
  replacePool: vi.fn(),
  clearPoolLimit: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: api }));

import { AiAccountPoolCard } from "./AiAccountPoolCard";

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

async function mount() {
  api.pool.mockResolvedValue(summary);
  api.replacePool.mockResolvedValue(summary);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <AiAccountPoolCard companyId="company-1" />
      </QueryClientProvider>,
    );
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}
async function click(label: string) {
  const button = [...document.body.querySelectorAll("button")].find(
    (item) => item.getAttribute("aria-label") === label || item.textContent?.includes(label),
  );
  if (!button) throw new Error(`Missing button ${label}`);
  await act(async () => button.click());
}

describe("AiAccountPoolCard", () => {
  it("shows pool order, usage limits and usage", async () => {
    await mount();
    const text = document.body.textContent ?? "";
    expect(text).toContain("Max one");
    expect(text).toContain("Usage limit until");
    expect(text).toContain("Session 100%");
    expect(text).toContain("Available");
    expect(text.indexOf("Max one")).toBeLessThan(text.indexOf("Max two"));
  });

  it("reorders, adds accounts and clears a limit", async () => {
    await mount();
    await click("Move Max two up");
    expect(api.replacePool).toHaveBeenLastCalledWith("company-1", { provider: "anthropic", members: [second, first] });
    await click("API fallback");
    expect(api.replacePool).toHaveBeenLastCalledWith("company-1", { provider: "anthropic", members: [first, second, { connectionId: "c3", grantId: "g3" }] });
    await click("Clear limit");
    expect(api.clearPoolLimit).toHaveBeenCalledWith("company-1", "c1");
  });
});
