// @vitest-environment jsdom

import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_CLAUDE_ACCOUNT_LOCKED_TEXT } from "@/lib/agent-claude-account";
import { AI_ACCOUNT_UNSELECTABLE_REASON_TEXT, DEVICE_LOGIN_NOT_PERMITTED_TEXT } from "@/lib/ai-account-pool";
import { AccountPoolDesignExamples } from "./AccountPoolDesignExamples";

const poolApi = vi.hoisted(() => ({
  getAgentBinding: vi.fn(),
  setAgentBinding: vi.fn(),
  clearAgentBinding: vi.fn(),
  reviewAgentBinding: vi.fn(),
  listCompanyAccounts: vi.fn(),
}));
const devicesApi = vi.hoisted(() => ({ list: vi.fn(), listInstance: vi.fn(), linkTarget: vi.fn() }));
const runsApi = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));
const issuesApi = vi.hoisted(() => ({ retryScheduledRetryNow: vi.fn() }));
const pushToast = vi.hoisted(() => vi.fn());

vi.mock("@/api/ai-account-pool", async () => {
  const actual = await vi.importActual<typeof import("@/api/ai-account-pool")>("@/api/ai-account-pool");
  return { ...actual, aiAccountPoolApi: poolApi };
});
vi.mock("@/api/execution-devices", async () => {
  const actual = await vi.importActual<typeof import("@/api/execution-devices")>("@/api/execution-devices");
  return { ...actual, executionDevicesApi: devicesApi };
});
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: runsApi }));
vi.mock("@/api/issues", async () => {
  const actual = await vi.importActual<typeof import("@/api/issues")>("@/api/issues");
  return { ...actual, issuesApi };
});
vi.mock("@/context/ToastContext", () => ({
  useToastActions: () => ({ pushToast, dismissToast: vi.fn(), clearToasts: vi.fn() }),
}));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string } & ComponentProps<"a">) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let originalResizeObserver: typeof ResizeObserver | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
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

async function click(element: Element | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
}

function buttonIn(scope: ParentNode, text: string) {
  return [...scope.querySelectorAll("button")].find((element) => element.textContent?.trim() === text);
}

function allApiCalls() {
  return [...Object.values(poolApi), ...Object.values(devicesApi), ...Object.values(runsApi), ...Object.values(issuesApi)]
    .flatMap((mock) => mock.mock.calls);
}

function texts(selector: string) {
  return [...container.querySelectorAll(selector)].map((element) => element.textContent ?? "");
}

/** Opens a picker and returns its options' text by label; the list renders in a portal. */
async function openPicker(label: string) {
  const trigger = container.querySelector(`button[role='combobox'][aria-label='${label}']`);
  await click(trigger);
  const items = [...document.body.querySelectorAll("[cmdk-item]")];
  const item = (text: string) => items.find((element) => element.querySelector("[data-account-option]")?.textContent?.startsWith(text));
  return { trigger: trigger!, item };
}

describe("AccountPoolDesignExamples", () => {
  it("shows every example from sample data, without one request", async () => {
    await act(async () => root.render(<AccountPoolDesignExamples />));
    await settle();

    const cards = [...container.querySelectorAll("[data-agent-claude-account]")];
    expect(cards).toHaveLength(4);
    expect(cards[0]!.textContent).toContain("Team Max");
    expect(cards[0]!.querySelector("[data-account-state='limited']")?.textContent).toMatch(/^Limited until .+\(estimated\)$/);
    expect(cards[0]!.textContent).toContain("Tasks wait: usage limit");
    expect(cards[0]!.textContent).toContain("Build box — owner ada@example.com");
    expect(cards[1]!.textContent).toContain("Tasks wait: no account chosen");
    expect(cards[1]!.textContent).toContain("Review this migrated assignment");
    expect(cards[1]!.querySelector("[data-device='design-device-server'] [data-device-availability]")?.textContent)
      .toMatch(/^Offline since /);
    // On the device's own login: nothing waits, and an admin can clear it.
    expect(cards[2]!.querySelector("[data-binding-state='device_login']")?.textContent).toBe("Device's own login");
    expect(cards[2]!.querySelector("button[role='combobox']")?.textContent).toContain("Device's own login");
    expect(cards[2]!.textContent).not.toContain("Tasks wait");
    expect(buttonIn(cards[2]!, "Clear")).toBeTruthy();
    // Read-only: the picker is disabled and says who can change it.
    expect(cards[3]!.querySelector("button[role='combobox']")?.hasAttribute("disabled")).toBe(true);
    expect(cards[3]!.querySelector("button[role='combobox']")?.textContent).toContain("Ada's Max");
    expect(cards[3]!.textContent).toContain(AGENT_CLAUDE_ACCOUNT_LOCKED_TEXT);
    expect(buttonIn(cards[3]!, "Clear")).toBeUndefined();

    // The pickers: the admin's shows the chosen limited account with its state, the owner's has no choice yet.
    expect(container.querySelector("button[aria-label='Claude account, as a company admin']")?.textContent)
      .toMatch(/^Team MaxLimited until .+\(estimated\)$/);
    expect(container.querySelector("button[aria-label='Claude account, as an account owner']")?.textContent)
      .toBe("Choose a Claude account");

    expect(
      [...container.querySelectorAll("[data-account-state]")]
        .filter((badge) => !badge.closest("[data-agent-claude-account]") && !badge.closest("button"))
        .map((badge) => badge.textContent),
    ).toEqual([
      "Active",
      expect.stringMatching(/^Limited until .+ \(estimated\)$/),
      expect.stringMatching(/^Limited until (?!.*estimated).+$/),
      "Signed out",
      "Paused by owner",
      "Disabled by admin",
    ]);

    const banners = [...container.querySelectorAll("[data-testid='resource-wait-banner']")];
    expect(banners.map((banner) => banner.getAttribute("data-wait-reason"))).toEqual(["offline", "unreachable", "usage_limit", "signed_out"]);
    expect(banners[0]!.textContent).toMatch(/Waiting for device Build box \(offline since [^)]+\)/);
    // A wait that joined another one has no start time: no "since", and the run is the reviewer's, not the assignee's.
    expect(banners[1]!.textContent).toContain("Waiting for device Build box (unreachable)");
    expect(banners[1]!.textContent).not.toContain("since");
    expect(banners[1]!.querySelector("[data-testid='resource-wait-run']")?.textContent).toBe("Waiting run 7c3d1e22 by Reviewer");
    expect(banners[2]!.textContent).toMatch(/Waiting for Claude account Team Max: the usage limit resets at .+ \(estimated\)/);
    expect(banners[2]!.textContent).toContain("Paperclip never moves a task to another account");
    expect(banners[3]!.textContent).toContain("Waiting for a Claude account: Old token is signed out");
    expect(banners.every((banner) => buttonIn(banner, "Check now"))).toBe(true);

    expect(texts("[data-testid='issue-row-resource-wait']")).toEqual([
      "Waiting for device: Build box",
      "Waiting for device: Build box",
      expect.stringMatching(/^Waiting for limit reset: .+ \(estimated\)$/),
      "Waiting for a Claude account",
      "Waiting for an account slot: Build box",
      "Waiting for device: Build box",
    ]);
    expect(texts("[data-testid='issue-properties-resource-wait']")).toEqual([
      expect.stringMatching(/^device Build box \(offline since [^)]+\)$/),
      "device Build box (unreachable)",
      expect.stringMatching(/^Claude account Team Max: the usage limit resets at .+ \(estimated\)$/),
      "a Claude account: Old token is signed out",
      "an account slot on Build box",
    ]);

    const ledger = container.querySelector("[data-testid='run-ledger-resource-wait']");
    expect(ledger?.textContent).toContain("Waiting: device offline");
    expect(ledger?.textContent).toContain("2 attempts");
    expect(ledger?.textContent).toContain("Runs 4f2a9c10, 1b2c3d4e, 9e8d7c6b");

    expect([...container.querySelectorAll("[data-run-wait]")].map((badge) => badge.textContent)).toEqual(["Waited", "Waiting", "Resumed"]);

    await click(buttonIn(container, "Linkable pair"));
    expect(document.body.textContent).toContain("Link SSH · Build box and Build box?");
    await click(buttonIn(document.body, "Cancel"));
    await click(buttonIn(container, "Pair that cannot be linked"));
    expect(document.body.textContent).toContain("These two cannot be linked.");

    expect(allApiCalls()).toEqual([]);
  });

  it("shows each picker option's state and reason, for a company admin and for an account owner", async () => {
    await act(async () => root.render(<AccountPoolDesignExamples />));
    await settle();

    const admin = await openPicker("Claude account, as a company admin");
    expect(admin.item("Device's own login")?.getAttribute("aria-disabled")).not.toBe("true");
    expect(admin.item("Team Max")?.textContent).toMatch(/At its usage limit until .+ \(estimated\)\. Tasks wait for the reset\./);
    expect(admin.item("Team Max")?.getAttribute("aria-disabled")).not.toBe("true");
    expect(admin.item("My Pro")?.getAttribute("aria-disabled")).not.toBe("true");
    expect(admin.item("Night shift")?.textContent).toContain(AI_ACCOUNT_UNSELECTABLE_REASON_TEXT.device_account_limit);
    expect(admin.item("Night shift")?.getAttribute("aria-disabled")).toBe("true");
    expect(admin.item("Old token")?.textContent).toContain(AI_ACCOUNT_UNSELECTABLE_REASON_TEXT.signed_out);
    expect(admin.item("Old token")?.querySelector("[data-account-state='signed_out']")?.textContent).toBe("Signed out");
    await click(admin.trigger);

    const owner = await openPicker("Claude account, as an account owner");
    expect(owner.item("Device's own login")?.textContent).toContain(DEVICE_LOGIN_NOT_PERMITTED_TEXT);
    expect(owner.item("Device's own login")?.getAttribute("aria-disabled")).toBe("true");
    expect(owner.item("Team Max")?.textContent).toContain(AI_ACCOUNT_UNSELECTABLE_REASON_TEXT.not_permitted);
    expect(owner.item("Team Max")?.getAttribute("aria-disabled")).toBe("true");
    expect(owner.item("My Pro")?.getAttribute("aria-disabled")).not.toBe("true");
    expect(owner.item("Night shift")?.textContent).toContain(AI_ACCOUNT_UNSELECTABLE_REASON_TEXT.device_account_limit);
    expect(owner.item("Old token")?.textContent).toContain(AI_ACCOUNT_UNSELECTABLE_REASON_TEXT.signed_out);

    // A choice stays in place: the owner picks their own account, and may then switch it to the device's own login.
    await click(owner.item("My Pro"));
    expect(owner.trigger.textContent).toBe("My Pro");
    const again = await openPicker("Claude account, as an account owner");
    expect(again.item("Device's own login")?.getAttribute("aria-disabled")).not.toBe("true");

    expect(allApiCalls()).toEqual([]);
  });

  it("stops every save and check before it reaches the server, and says so in place", async () => {
    await act(async () => root.render(<AccountPoolDesignExamples />));
    await settle();

    const migrated = [...container.querySelectorAll("[data-agent-claude-account]")][1]!;
    await click(buttonIn(migrated, "Confirm"));
    expect(migrated.querySelector("[role='alert']")?.textContent).toBe("This is an example: nothing was saved.");

    const banner = container.querySelector("[data-testid='resource-wait-banner']")!;
    await click(banner.querySelector("[data-testid='resource-wait-check-now']"));
    expect(banner.querySelector("[data-testid='resource-wait-check-now-result']")?.textContent)
      .toBe("Couldn't check now: This is an example: nothing was saved.");

    await click(buttonIn(container, "Linkable pair"));
    await click(buttonIn(document.body, "Link devices"));
    expect(document.body.querySelector("[role='dialog'] [role='alert']")?.textContent).toBe("This is an example: nothing was saved.");

    expect(poolApi.reviewAgentBinding).not.toHaveBeenCalled();
    expect(issuesApi.retryScheduledRetryNow).not.toHaveBeenCalled();
    expect(devicesApi.linkTarget).not.toHaveBeenCalled();
    expect(pushToast).not.toHaveBeenCalled();
    expect(allApiCalls()).toEqual([]);
  });
});
