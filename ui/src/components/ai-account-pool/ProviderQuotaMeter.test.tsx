// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AiAccountProviderQuota } from "@paperclipai/shared";
import { ProviderQuotaMeter, providerQuotaWindowLabel } from "./ProviderQuotaMeter";

const NOW = new Date(2026, 10, 15, 20, 0);
const FRIDAY_9 = new Date(2026, 10, 20, 9, 0);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

function render(quota: AiAccountProviderQuota | null) {
  flushSync(() => root.render(<ProviderQuotaMeter quota={quota} now={NOW} />));
  return container;
}

function quota(windows: AiAccountProviderQuota["windows"], extra: Partial<AiAccountProviderQuota> = {}): AiAccountProviderQuota {
  return { observedAt: new Date(NOW.getTime() - 3 * 3_600_000).toISOString(), status: "allowed", usingOverage: false, windows, ...extra };
}

describe("ProviderQuotaMeter", () => {
  it("says when no run has reported yet", () => {
    expect(render(null).textContent).toContain("Claude quota: no reading yet");
  });

  it("shows each window's use and reset, the 5-hour window first", () => {
    const view = render(quota([
      { id: "seven_day", usedPercent: 32, resetsAt: FRIDAY_9.toISOString(), status: "allowed" },
      { id: "five_hour", usedPercent: 5.4, resetsAt: new Date(2026, 10, 15, 22, 0).toISOString(), status: null },
    ]));
    const labels = [...view.querySelectorAll("[data-testid^='provider-quota-']")].map((node) => node.getAttribute("data-testid"));
    expect(labels).toEqual(["provider-quota-five_hour", "provider-quota-seven_day"]);
    const weekly = view.querySelector("[data-testid='provider-quota-seven_day']")!;
    expect(weekly.textContent).toContain("Weekly limit");
    expect(weekly.textContent).toContain("32% used");
    expect(weekly.textContent).toContain("Resets Fri 09:00");
    expect(weekly.querySelector("[role='progressbar']")?.getAttribute("aria-valuenow")).toBe("32");
    expect(view.querySelector("[data-testid='provider-quota-five_hour']")?.textContent).toContain("5.4% used");
    expect(view.textContent).toContain("Reported by Claude Code in a run 3h ago");
  });

  it("marks a reached limit, and a window whose reset has passed without a bar", () => {
    const view = render(quota([
      { id: "five_hour", usedPercent: 100, resetsAt: new Date(2026, 10, 15, 21, 0).toISOString(), status: "rejected" },
      { id: "seven_day", usedPercent: 97, resetsAt: new Date(2026, 10, 15, 19, 0).toISOString(), status: "allowed" },
    ], { usingOverage: true }));
    expect(view.querySelector("[data-testid='provider-quota-five_hour']")?.textContent).toContain("Limit reached");
    const weekly = view.querySelector("[data-testid='provider-quota-seven_day']")!;
    expect(weekly.textContent).toContain("Reset 19:00. The next run brings a new reading.");
    expect(weekly.querySelector("[role='progressbar']")).toBeNull();
    expect(view.textContent).toContain("extra usage is in use");
  });

  it("names unknown windows readably", () => {
    expect(providerQuotaWindowLabel("seven_day_opus")).toBe("Weekly Opus limit");
    expect(providerQuotaWindowLabel("monthly_extra")).toBe("Monthly extra limit");
  });
});
