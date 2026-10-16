// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanyAiAccountOption } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import {
  AI_ACCOUNT_INCOMPATIBLE_REASON_TEXT,
  AI_ACCOUNT_UNSELECTABLE_REASON_TEXT,
  DEVICE_LOGIN_NOT_PERMITTED_TEXT,
  accountSelectSelection,
  accountSelectValueFromBinding,
  aiAccountPoolErrorMessage,
  aiAccountStateDisplay,
  buildAccountSelectGroups,
  canChooseDeviceLogin,
  deviceAccountUsageText,
  deviceAvailabilityDisplay,
  formatResetTime,
  poolAccountRunBadgeLabel,
} from "@/lib/ai-account-pool";
import { AccountSelect } from "./AccountSelect";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Local times, so the expectations hold in any time zone.
const NOW = new Date(2026, 9, 16, 12, 0);
const TODAY_18 = new Date(2026, 9, 16, 18, 0);

function weekday(date: Date): string {
  return date.toLocaleDateString("en-US", { weekday: "short" });
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
    ...overrides,
  };
}

const MINE = option({ id: "acct-mine", label: "My Pro", ownedByMe: true, owner: { userId: "me", name: "Me", email: "me@example.com" } });
const TEAM = option({ id: "acct-team", label: "Team Max" });
const ON_DEVICE = option({ id: "acct-device", label: "Studio", onAgentDevice: true });

describe("formatResetTime", () => {
  it("shows HH:MM today, the weekday on another day, and marks estimates", () => {
    expect(formatResetTime(TODAY_18, { now: NOW })).toBe("18:00");
    expect(formatResetTime(new Date(2026, 9, 16, 8, 7), { now: NOW })).toBe("08:07");
    expect(formatResetTime(TODAY_18.toISOString(), { now: NOW, estimated: true })).toBe("18:00 (estimated)");

    const tomorrow = new Date(2026, 9, 17, 9, 5);
    expect(formatResetTime(tomorrow, { now: NOW })).toBe(`${weekday(tomorrow)} 09:05`);
    const yesterday = new Date(2026, 9, 15, 23, 30);
    expect(formatResetTime(yesterday, { now: NOW })).toBe(`${weekday(yesterday)} 23:30`);
  });

  it("adds the date once the weekday alone would be ambiguous", () => {
    const later = new Date(2026, 9, 26, 18, 0);
    expect(formatResetTime(later, { now: NOW, estimated: true })).toBe(`${weekday(later)} 26 Oct 18:00 (estimated)`);
  });

  it("returns null for a missing or invalid time", () => {
    expect(formatResetTime(null, { now: NOW })).toBeNull();
    expect(formatResetTime("not a date", { now: NOW })).toBeNull();
  });
});

describe("account state and reason texts", () => {
  it("labels every state, with the reset time of a limited account", () => {
    expect(aiAccountStateDisplay({ state: "active" }, NOW).label).toBe("Active");
    expect(aiAccountStateDisplay({ state: "limited", exhaustedUntil: TODAY_18.toISOString(), limitSource: "estimated" }, NOW))
      .toMatchObject({ label: "Limited until 18:00 (estimated)", tone: "warning" });
    expect(aiAccountStateDisplay({ state: "limited", exhaustedUntil: TODAY_18.toISOString(), limitSource: "provider" }, NOW).label)
      .toBe("Limited until 18:00");
    expect(aiAccountStateDisplay({ state: "signed_out" }, NOW).label).toBe("Signed out");
    expect(aiAccountStateDisplay({ state: "withdrawn" }, NOW).label).toBe("Paused by owner");
    expect(aiAccountStateDisplay({ state: "admin_disabled" }, NOW).label).toBe("Disabled by admin");
  });

  it("names a fix for every unselectable reason", () => {
    for (const text of Object.values(AI_ACCOUNT_UNSELECTABLE_REASON_TEXT)) {
      expect(text.length).toBeGreaterThan(20);
    }
    expect(AI_ACCOUNT_UNSELECTABLE_REASON_TEXT.signed_out).toContain("replace the token");
    expect(AI_ACCOUNT_UNSELECTABLE_REASON_TEXT.not_permitted).toContain("owner or a company admin");
    // An agent that is already pinned can still have no known device: the fix may need an instance admin.
    expect(AI_ACCOUNT_UNSELECTABLE_REASON_TEXT.device_unknown).toBe(AI_ACCOUNT_INCOMPATIBLE_REASON_TEXT.device_unknown);
    expect(AI_ACCOUNT_UNSELECTABLE_REASON_TEXT.device_unknown).toContain("ask an instance admin to map the environment to a device");
  });

  it("shows a device limit with this company's labels and other companies as a count only", () => {
    const error = new ApiError("Device account limit", 409, {
      error: "Device account limit",
      code: "device_account_limit",
      details: {
        code: "device_account_limit",
        deviceName: "Build box",
        deviceId: "device-1",
        limit: 3,
        inUse: 3,
        accounts: ["Team Max"],
        otherCompaniesAccounts: 2,
      },
    });
    const message = aiAccountPoolErrorMessage(error);
    expect(message).toBe(
      "Build box already runs 3 of 3 Claude accounts (Team Max, 2 accounts of other companies). Choose an account already on that device, or free a slot first.",
    );
  });

  it("explains binding refusals and incompatible accounts", () => {
    expect(aiAccountPoolErrorMessage(new ApiError("Forbidden", 403, { code: "ai_account_binding_forbidden" })))
      .toContain("owner or a company admin");
    expect(aiAccountPoolErrorMessage(new ApiError("Incompatible", 422, {
      code: "ai_account_incompatible",
      details: { code: "ai_account_incompatible", reason: "account_signed_out" },
    }))).toContain("replace the token");
  });

  it("formats device availability, the account meter and pool run badges", () => {
    expect(deviceAvailabilityDisplay({ state: "available", reason: null, label: null, unavailableSince: null }, NOW).label)
      .toBe("Available");
    expect(deviceAvailabilityDisplay({
      state: "unavailable",
      reason: "offline",
      label: null,
      unavailableSince: new Date(2026, 9, 16, 9, 2).toISOString(),
    }, NOW).label).toBe("Offline since 09:02");
    expect(deviceAvailabilityDisplay({ state: "retired", reason: null, label: null, unavailableSince: null }, NOW).label)
      .toBe("Removed");
    expect(deviceAccountUsageText({ limit: 3, inUse: 2, otherCompaniesAccounts: 1 }))
      .toBe("2 of 3 Claude accounts · +1 used by another company");
    expect(poolAccountRunBadgeLabel({ aiConnection: { mode: "pool_account", accountName: "Team Max" } }))
      .toBe("Claude account: Team Max");
    expect(poolAccountRunBadgeLabel({ aiConnection: { mode: "responsible_user" } })).toBeNull();
  });
});

describe("buildAccountSelectGroups", () => {
  it("puts accounts already on the device first, then the others", () => {
    const groups = buildAccountSelectGroups({ options: [TEAM, ON_DEVICE, MINE], canBindAny: true, now: NOW });
    expect(groups.map((group) => group.label)).toEqual(["Already on this device", "Other accounts"]);
    expect(groups[0].options.map((entry) => entry.label)).toEqual(["Studio"]);
    expect(groups[1].options.map((entry) => entry.label)).toEqual(["My Pro", "Team Max"]);
  });

  it("uses one group when nothing is on the device yet, and offers the device login first", () => {
    const groups = buildAccountSelectGroups({
      options: [TEAM, MINE],
      canBindAny: false,
      includeDeviceLogin: true,
      canSetDeviceLogin: true,
      now: NOW,
    });
    expect(groups.map((group) => group.label)).toEqual(["Device", "Claude accounts"]);
    expect(groups[0].options[0]).toMatchObject({ label: "Device's own login", disabled: false, disabledReason: null });
  });

  it("offers the device login to company admins, and to an owner only while the agent is on their own account", () => {
    const deviceLogin = (input: { canBindAny: boolean; canSetDeviceLogin?: boolean }) =>
      buildAccountSelectGroups({ options: [MINE], includeDeviceLogin: true, now: NOW, ...input })[0].options[0];
    // The default follows canBindAny.
    expect(deviceLogin({ canBindAny: true })).toMatchObject({ disabled: false, disabledReason: null });
    expect(deviceLogin({ canBindAny: false })).toMatchObject({ disabled: true, disabledReason: DEVICE_LOGIN_NOT_PERMITTED_TEXT });
    expect(deviceLogin({ canBindAny: false, canSetDeviceLogin: true })).toMatchObject({ disabled: false });

    const owner = (binding: Parameters<typeof canChooseDeviceLogin>[0]["binding"]) =>
      canChooseDeviceLogin({ canBindAny: false, binding });
    expect(owner({ mode: "pool_account", account: { ownedByMe: true } })).toBe(true);
    expect(owner(null)).toBe(false);
    expect(owner({ mode: null, account: null })).toBe(false);
    expect(owner({ mode: "pool_account", account: null })).toBe(false);
    expect(owner({ mode: "pool_account", account: { ownedByMe: false } })).toBe(false);
    expect(owner({ mode: "device_login", account: null })).toBe(false);
    expect(canChooseDeviceLogin({ canBindAny: true, binding: { mode: "pool_account", account: { ownedByMe: false } } })).toBe(true);
  });

  it("lets members choose only their own accounts", () => {
    const [group] = buildAccountSelectGroups({ options: [TEAM, MINE], canBindAny: false, now: NOW });
    const mine = group.options.find((entry) => entry.label === "My Pro")!;
    const team = group.options.find((entry) => entry.label === "Team Max")!;
    expect(mine).toMatchObject({ disabled: false, disabledReason: null, ownerText: "yours" });
    expect(team).toMatchObject({ disabled: true, disabledReason: AI_ACCOUNT_UNSELECTABLE_REASON_TEXT.not_permitted, ownerText: "Ada" });
    // Choosable accounts come first.
    expect(group.options.map((entry) => entry.label)).toEqual(["My Pro", "Team Max"]);
  });

  it("lets company admins choose every eligible account", () => {
    const [group] = buildAccountSelectGroups({ options: [TEAM, MINE], canBindAny: true, now: NOW });
    expect(group.options.every((entry) => !entry.disabled)).toBe(true);
  });

  it("keeps the server's reason, and refuses accounts the caller may not bind", () => {
    const full = option({ id: "acct-full", label: "Full", selectable: false, reason: "device_account_limit" });
    const notMine = option({ id: "acct-other", label: "Other", canBind: false });
    const [group] = buildAccountSelectGroups({ options: [full, notMine], canBindAny: true, now: NOW });
    expect(group.options.find((entry) => entry.label === "Full")).toMatchObject({
      disabled: true,
      disabledReason: AI_ACCOUNT_UNSELECTABLE_REASON_TEXT.device_account_limit,
    });
    expect(group.options.find((entry) => entry.label === "Other")).toMatchObject({
      disabled: true,
      disabledReason: AI_ACCOUNT_UNSELECTABLE_REASON_TEXT.not_permitted,
    });
  });

  it("disables signed-out and paused accounts and warns about a limited one", () => {
    const signedOut = option({ id: "acct-signed-out", label: "Signed out", state: "signed_out" });
    const paused = option({ id: "acct-paused", label: "Paused", state: "withdrawn" });
    const limited = option({
      id: "acct-limited",
      label: "Limited",
      state: "limited",
      exhaustedUntil: TODAY_18.toISOString(),
      limitSource: "estimated",
    });
    const [group] = buildAccountSelectGroups({ options: [signedOut, paused, limited], canBindAny: true, now: NOW });
    expect(group.options.find((entry) => entry.label === "Signed out")).toMatchObject({ disabled: true });
    expect(group.options.find((entry) => entry.label === "Signed out")?.disabledReason).toContain("replace the token");
    expect(group.options.find((entry) => entry.label === "Paused")?.disabledReason).toContain("Paused by its owner");
    expect(group.options.find((entry) => entry.label === "Limited")).toMatchObject({
      disabled: false,
      warning: "At its usage limit until 18:00 (estimated). Tasks wait for the reset.",
    });
    expect(group.options.find((entry) => entry.label === "Limited")?.stateDisplay?.label).toBe("Limited until 18:00 (estimated)");
  });

  it("maps picks and bindings to the PUT body", () => {
    expect(accountSelectSelection("account:acct-1")).toEqual({ mode: "pool_account", accountId: "acct-1" });
    expect(accountSelectSelection("device_login")).toEqual({ mode: "device_login" });
    expect(accountSelectSelection("")).toBeNull();
    expect(accountSelectValueFromBinding({ mode: "pool_account", account: null })).toEqual({ mode: "pool_account", accountId: null });
    expect(accountSelectValueFromBinding({ mode: null, account: null })).toBeNull();
  });
});

describe("AccountSelect", () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let originalResizeObserver: typeof ResizeObserver | undefined;

  beforeEach(() => {
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    if (root) flushSync(() => root?.unmount());
    globalThis.ResizeObserver = originalResizeObserver!;
    container.remove();
    document.body.innerHTML = "";
  });

  function render(node: ReactNode) {
    root = createRoot(container);
    flushSync(() => root!.render(node));
  }

  async function open() {
    const trigger = container.querySelector<HTMLButtonElement>("button[role='combobox']");
    flushSync(() => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await Promise.resolve();
  }

  function item(text: string) {
    return Array.from(container.querySelectorAll("[cmdk-item]")).find((element) => element.textContent?.includes(text));
  }

  it("groups options, shows each state and the reason an option is disabled", async () => {
    const signedOut = option({ id: "acct-signed-out", label: "Old token", state: "signed_out", ownedByMe: true });
    render(
      <AccountSelect
        options={[TEAM, ON_DEVICE, MINE, signedOut]}
        canBindAny={false}
        value={null}
        onChange={vi.fn()}
        includeDeviceLogin
        disablePortal
        now={NOW}
      />,
    );
    expect(container.querySelector("button[role='combobox']")?.textContent).toContain("Choose a Claude account");
    await open();

    const headings = Array.from(container.querySelectorAll("[cmdk-group-heading]")).map((element) => element.textContent);
    expect(headings).toEqual(["Device", "Already on this device", "Other accounts"]);
    expect(container.querySelectorAll("[data-account-state='active']").length).toBeGreaterThanOrEqual(3);
    expect(container.querySelector("[data-account-state='signed_out']")?.textContent).toBe("Signed out");
    expect(item("Team Max")?.textContent).toContain(AI_ACCOUNT_UNSELECTABLE_REASON_TEXT.not_permitted);
    expect(item("Old token")?.textContent).toContain("replace the token");
    expect(item("My Pro")?.textContent).not.toContain(AI_ACCOUNT_UNSELECTABLE_REASON_TEXT.not_permitted);
  });

  it("emits the PUT body for a choosable account and the device login, and ignores disabled options", async () => {
    const onChange = vi.fn();
    render(
      <AccountSelect
        options={[TEAM, MINE]}
        canBindAny={false}
        value={{ mode: "pool_account", accountId: "acct-mine" }}
        onChange={onChange}
        includeDeviceLogin
        canSetDeviceLogin
        disablePortal
        now={NOW}
      />,
    );
    await open();
    flushSync(() => item("Team Max")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    expect(onChange).not.toHaveBeenCalled();

    flushSync(() => item("My Pro")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    expect(onChange).toHaveBeenLastCalledWith({ mode: "pool_account", accountId: "acct-mine" });

    await open();
    flushSync(() => item("Device's own login")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    expect(onChange).toHaveBeenLastCalledWith({ mode: "device_login" });
  });

  it("lets a company admin choose another member's account", async () => {
    const onChange = vi.fn();
    render(<AccountSelect options={[TEAM, MINE]} canBindAny value={null} onChange={onChange} disablePortal now={NOW} />);
    await open();
    flushSync(() => item("Team Max")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    expect(onChange).toHaveBeenCalledWith({ mode: "pool_account", accountId: "acct-team" });
  });

  describe("the device's own login (decision D4)", () => {
    function renderForBinding(input: {
      canBindAny: boolean;
      binding: { mode: "pool_account" | "device_login" | null; account: { id: string; ownedByMe: boolean } | null };
      onChange: (selection: unknown) => void;
    }) {
      render(
        <AccountSelect
          options={[TEAM, MINE]}
          canBindAny={input.canBindAny}
          value={accountSelectValueFromBinding(input.binding)}
          onChange={input.onChange}
          includeDeviceLogin
          canSetDeviceLogin={canChooseDeviceLogin({ canBindAny: input.canBindAny, binding: input.binding })}
          disablePortal
          now={NOW}
        />,
      );
    }

    function clickDeviceLogin() {
      flushSync(() => item("Device's own login")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    }

    it("keeps it visible but disabled, with the reason, for an owner of an unbound agent", async () => {
      const onChange = vi.fn();
      renderForBinding({ canBindAny: false, binding: { mode: null, account: null }, onChange });
      await open();
      const deviceLogin = item("Device's own login");
      expect(deviceLogin?.getAttribute("aria-disabled")).toBe("true");
      expect(deviceLogin?.textContent).toContain(DEVICE_LOGIN_NOT_PERMITTED_TEXT);
      clickDeviceLogin();
      expect(onChange).not.toHaveBeenCalled();
      // The owner may still bind their own account to the unbound agent.
      flushSync(() => item("My Pro")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
      expect(onChange).toHaveBeenCalledWith({ mode: "pool_account", accountId: "acct-mine" });
    });

    it("lets an owner switch an agent on one of their own accounts to it", async () => {
      const onChange = vi.fn();
      renderForBinding({ canBindAny: false, binding: { mode: "pool_account", account: { id: "acct-mine", ownedByMe: true } }, onChange });
      await open();
      expect(item("Device's own login")?.getAttribute("aria-disabled")).not.toBe("true");
      expect(item("Device's own login")?.textContent).not.toContain(DEVICE_LOGIN_NOT_PERMITTED_TEXT);
      clickDeviceLogin();
      expect(onChange).toHaveBeenCalledWith({ mode: "device_login" });
    });

    it("lets a company admin switch any agent to it", async () => {
      const onChange = vi.fn();
      renderForBinding({ canBindAny: true, binding: { mode: "pool_account", account: { id: "acct-team", ownedByMe: false } }, onChange });
      await open();
      expect(item("Device's own login")?.getAttribute("aria-disabled")).not.toBe("true");
      clickDeviceLogin();
      expect(onChange).toHaveBeenCalledWith({ mode: "device_login" });
    });
  });

  it("names the current account, or says it is no longer available here", () => {
    render(
      <AccountSelect
        options={[TEAM]}
        canBindAny
        value={{ mode: "pool_account", accountId: "acct-team" }}
        onChange={vi.fn()}
        disablePortal
        now={NOW}
      />,
    );
    expect(container.querySelector("button[role='combobox']")?.textContent).toContain("Team Max");

    flushSync(() => root!.render(
      <AccountSelect
        options={[TEAM]}
        canBindAny
        value={{ mode: "pool_account", accountId: "acct-gone" }}
        onChange={vi.fn()}
        disablePortal
        now={NOW}
      />,
    ));
    expect(container.querySelector("button[role='combobox']")?.textContent)
      .toContain("An account that is no longer available in this company");
  });
});
