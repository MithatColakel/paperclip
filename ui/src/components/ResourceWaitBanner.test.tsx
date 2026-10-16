// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RESOURCE_WAIT_REASONS_BY_KIND,
  type IssueScheduledRetry,
  type ResourceWaitKind,
  type ResourceWaitReason,
  type ScheduledRetryResourceWait,
} from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import {
  describeResourceWait,
  describeResourceWaitCheckNow,
  isResourceWaitDeferralRun,
  readRunResourceWait,
  resourceWaitLaneLabel,
  resourceWaitReasonLabel,
  resourceWaitReasonText,
} from "@/lib/resource-wait";
import { formatResetTime } from "@/lib/ai-account-pool";
import { ResourceWaitBanner, ResourceWaitChip, ResourceWaitPropertyValue } from "./ResourceWaitBanner";

const retryNowMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/issues", () => ({
  issuesApi: {
    retryScheduledRetryNow: retryNowMock,
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string } & ComponentProps<"a">) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Local times, so the expectations hold in any time zone.
const NOW = new Date(2026, 9, 16, 15, 0);
const SINCE = new Date(2026, 9, 16, 13, 2);
const RESET = new Date(2026, 9, 16, 18, 0);

const SCOPE_BY_KIND: Record<ResourceWaitKind, ScheduledRetryResourceWait["scope"]> = {
  environment: "target",
  ai_account: "account",
  device_slots: "device",
};

function wait(overrides: Partial<ScheduledRetryResourceWait> = {}): ScheduledRetryResourceWait {
  const kind = overrides.kind ?? "environment";
  return {
    version: 1,
    episodeId: "episode-1",
    kind,
    reason: "offline",
    scope: SCOPE_BY_KIND[kind],
    environmentId: "environment-1",
    environmentName: "SSH · Build box",
    deviceId: "device-1",
    deviceName: "Build box",
    accountId: kind === "ai_account" ? "account-1" : null,
    accountLabel: kind === "ai_account" ? "Team Max" : null,
    resumeAt: null,
    resumeAtSource: null,
    message: null,
    since: SINCE.toISOString(),
    notifiedAt: null,
    ...overrides,
  };
}

function scheduledRetry(resourceWait: ScheduledRetryResourceWait | null, lane = "environment_wait"): IssueScheduledRetry {
  return {
    runId: "run-successor",
    status: "scheduled_retry",
    agentId: "agent-1",
    agentName: "Coder",
    retryOfRunId: "run-deferral",
    scheduledRetryAt: new Date(NOW.getTime() + 60_000).toISOString(),
    scheduledRetryAttempt: 2,
    scheduledRetryReason: lane,
    error: "Waiting for device Build box",
    errorCode: "environment_unavailable",
    resourceWait,
  };
}

/** The fix each reason that needs a person names. */
const FIX_BY_REASON: Partial<Record<ResourceWaitReason, string>> = {
  not_allowed: "Enable this project",
  not_serving: "Add its owner to this company",
  signed_out: "must replace its token",
  withdrawn: "turned back on",
  unassigned: "Choose a Claude account for Coder",
  owner_not_member: "Choose another account for Coder",
  reserved_elsewhere: "clear the reservation",
  device_unknown: "Pin Coder to an environment",
  credential_type_unsupported: "Choose an account of a type",
};

describe("describeResourceWait", () => {
  const cases = (Object.entries(RESOURCE_WAIT_REASONS_BY_KIND) as Array<[ResourceWaitKind, readonly ResourceWaitReason[]]>)
    .flatMap(([kind, reasons]) => reasons.map((reason) => [kind, reason] as const));

  it.each(cases)("has its own banner copy for %s / %s", (kind, reason) => {
    const copy = describeResourceWait(wait({ kind, reason, resumeAt: RESET.toISOString(), resumeAtSource: "provider" }), {
      agentName: "Coder",
      now: NOW,
    });
    expect(copy.reason).toBe(reason);
    expect(copy.title).toMatch(/^Waiting for /);
    expect(copy.detail.length).toBeGreaterThan(20);
    expect(copy.chip).toMatch(/^Waiting for /);
    expect(copy.short.length).toBeGreaterThan(3);
    const fix = FIX_BY_REASON[reason];
    if (fix) {
      expect(copy.tone).toBe("warning");
      expect(copy.detail).toContain(fix);
    } else {
      expect(copy.tone).toBe("info");
      expect(copy.detail).toMatch(/automatically|tries again|Add credit/);
    }
  });

  it("names the device and when it went offline", () => {
    const copy = describeResourceWait(wait(), { agentName: "Coder", now: NOW });
    expect(copy.title).toBe("Waiting for device Build box (offline since 13:02)");
    expect(copy.detail).toBe(
      "Starts automatically when Build box is back online. To run it elsewhere, move Coder to another device.",
    );
    expect(copy.chip).toBe("Waiting for device: Build box");
    expect(copy.short).toBe("device offline");
  });

  it("shows the reset time of a usage limit, with the weekday and the estimate marked", () => {
    const today = describeResourceWait(
      wait({ kind: "ai_account", reason: "usage_limit", resumeAt: RESET.toISOString(), resumeAtSource: "estimated" }),
      { now: NOW },
    );
    expect(today.title).toBe("Waiting for Claude account Team Max: the usage limit resets at 18:00 (estimated)");
    expect(today.chip).toBe("Waiting for limit reset: 18:00 (estimated)");
    expect(today.detail).toContain("Paperclip never moves a task to another account");

    const tomorrow = new Date(2026, 9, 17, 9, 30);
    const later = describeResourceWait(
      wait({ kind: "ai_account", reason: "usage_limit", resumeAt: tomorrow.toISOString(), resumeAtSource: "provider" }),
      { now: NOW },
    );
    expect(later.chip).toBe(`Waiting for limit reset: ${formatResetTime(tomorrow, { now: NOW })}`);
    expect(later.chip).toMatch(/^Waiting for limit reset: [A-Z][a-z]{2} 09:30$/);
  });

  it("explains throttling as a short pause", () => {
    const copy = describeResourceWait(wait({ reason: "throttled", scope: "admission" }), { now: NOW });
    expect(copy.title).toBe("Waiting for device Build box (too many connections)");
    expect(copy.detail).toContain("tries again shortly");
    expect(copy.tone).toBe("info");
  });

  it("shows the driver's own fix for an admission refusal, and a generic one without it", () => {
    const unowned = "Build box has no owner yet, so it takes work only for the company it was set up in. An admin assigns it an owner; until then, run the agent on another environment.";
    const notServing = describeResourceWait(wait({ reason: "not_serving", scope: "admission", message: unowned }), { agentName: "Coder", now: NOW });
    expect(notServing).toMatchObject({
      title: "Waiting for device Build box: it does not serve this company",
      detail: unowned,
      tone: "warning",
    });
    const noProject = "Build box takes work only for its assigned projects, and this run has no project. Allow runs without a project there, or give the issue a project.";
    expect(describeResourceWait(wait({ reason: "not_allowed", scope: "admission", message: `  ${noProject} ` }), { agentName: "Coder", now: NOW }).detail)
      .toBe(noProject);
    // Without a message (or a blank one), the generic text covers a device with and without an owner.
    const generic = describeResourceWait(wait({ reason: "not_serving", scope: "admission", message: "   " }), { agentName: "Coder", now: NOW });
    expect(generic.detail).toBe(
      "Build box takes work only for companies its owner belongs to. Add its owner to this company (if it has no owner, an admin assigns one first), or move Coder to another device.",
    );
  });

  it("never names an account whose owner left the company", () => {
    const copy = describeResourceWait(
      wait({ kind: "ai_account", reason: "owner_not_member", accountLabel: "Private label" }),
      { agentName: "Coder", now: NOW },
    );
    expect(`${copy.title} ${copy.detail} ${copy.chip}`).not.toContain("Private label");
    expect(copy.title).toContain("no longer available in this company");
  });

  it("falls back to the lane when the context is missing", () => {
    expect(describeResourceWait(null, { kind: "device_slots" })).toMatchObject({
      reason: null,
      title: "Waiting for an account slot",
      tone: "info",
    });
    expect(resourceWaitLaneLabel("ai_account_wait")).toBe("Waiting for Claude account");
    expect(resourceWaitLaneLabel("transient_failure")).toBeNull();
  });

  it.each(cases)("has a name-free label and fix text for %s / %s", (_kind, reason) => {
    expect(resourceWaitReasonLabel(reason).length).toBeGreaterThan(3);
    const text = resourceWaitReasonText(reason);
    expect(text.length).toBeGreaterThan(20);
    expect(text).not.toContain("Build box");
    const fix = FIX_BY_REASON[reason];
    if (fix) expect(text).toContain(fix.replace("Coder", "the agent"));
  });
});

describe("wait runs", () => {
  it("recognises a deferral by its code or its recovery record and reads its reason", () => {
    const deferral = {
      status: "cancelled",
      errorCode: "ai_account_unavailable",
      resultJson: { resourceWait: { kind: "ai_account", reason: "signed_out" } },
    };
    expect(isResourceWaitDeferralRun(deferral)).toBe(true);
    expect(readRunResourceWait(deferral)).toMatchObject({ kind: "ai_account", wait: { reason: "signed_out" } });
    expect(isResourceWaitDeferralRun({
      status: "cancelled",
      errorCode: null,
      resultJson: { executionRecovery: { kind: "resource_wait", providerWorkStarted: false } },
    })).toBe(true);
    expect(isResourceWaitDeferralRun({ status: "cancelled", errorCode: "workspace_busy", resultJson: null })).toBe(false);
    expect(isResourceWaitDeferralRun({ status: "failed", errorCode: "environment_unavailable", resultJson: null })).toBe(false);
  });
});

describe("describeResourceWaitCheckNow", () => {
  it("answers a 409 as still unavailable, not as a failure", () => {
    const error = new ApiError("Still unavailable", 409, {
      error: "Still unavailable",
      code: "resource_still_unavailable",
      details: { code: "resource_still_unavailable", resourceWait: null, checkedAt: NOW.toISOString() },
    });
    expect(describeResourceWaitCheckNow(undefined, error)).toEqual({
      tone: "neutral",
      text: "Still unavailable (checked just now)",
    });
    expect(describeResourceWaitCheckNow(undefined, new ApiError("Too many", 429, { error: "Too many" }))?.text)
      .toBe("Checked less than a minute ago. Try again in a minute.");
    expect(describeResourceWaitCheckNow({ outcome: "promoted", message: "ok", scheduledRetry: null }, null))
      .toEqual({ tone: "success", text: "Available. Starting now." });
  });
});

describe("ResourceWaitBanner", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    retryNowMock.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(ui: ReactNode) {
    // No ToastProvider: a wait never raises a toast.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    act(() => {
      root.render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
    });
  }

  function checkNowButton() {
    return container.querySelector<HTMLButtonElement>('[data-testid="resource-wait-check-now"]');
  }

  async function waitForText(text: string) {
    await vi.waitFor(async () => {
      await act(async () => {
        await Promise.resolve();
      });
      expect(container.textContent).toContain(text);
    });
  }

  it("shows what the task waits for, the fix, and Check now", () => {
    render(<ResourceWaitBanner issueId="issue-1" scheduledRetry={scheduledRetry(wait({ reason: "not_allowed", scope: "admission" }))} />);
    const banner = container.querySelector('[data-testid="resource-wait-banner"]');
    expect(banner?.getAttribute("data-wait-reason")).toBe("not_allowed");
    expect(container.textContent).toContain("Waiting for device Build box: this project is not enabled there");
    expect(container.textContent).toContain("Enable this project for this company on Build box, or move Coder to another device.");
    expect(checkNowButton()?.textContent).toContain("Check now");
    expect(container.textContent).not.toMatch(/Retry|failed|Attempt/);
  });

  it("renders a 409 from Check now as still unavailable, in place", async () => {
    retryNowMock.mockRejectedValue(new ApiError("Still unavailable", 409, {
      error: "Still unavailable",
      code: "resource_still_unavailable",
      details: { code: "resource_still_unavailable", resourceWait: wait(), checkedAt: new Date().toISOString() },
    }));
    render(<ResourceWaitBanner issueId="issue-1" scheduledRetry={scheduledRetry(wait())} />);
    act(() => checkNowButton()!.click());
    await waitForText("Still unavailable (checked just now)");
    expect(retryNowMock).toHaveBeenCalledWith("issue-1");
    expect(checkNowButton()!.disabled).toBe(false);
    expect(container.textContent).not.toContain("Couldn't");
  });

  it("shows a successful check as starting", async () => {
    retryNowMock.mockResolvedValue({ outcome: "promoted", message: "Promoted", scheduledRetry: null });
    render(<ResourceWaitBanner issueId="issue-1" scheduledRetry={scheduledRetry(wait())} />);
    act(() => checkNowButton()!.click());
    await waitForText("Available. Starting now.");
    expect(checkNowButton()!.disabled).toBe(true);
  });

  it("renders nothing for an ordinary retry or a retry that already started", () => {
    render(
      <>
        <ResourceWaitBanner issueId="issue-1" scheduledRetry={scheduledRetry(wait(), "transient_failure")} />
        <ResourceWaitBanner issueId="issue-1" scheduledRetry={{ ...scheduledRetry(wait()), status: "queued" }} />
      </>,
    );
    expect(container.textContent).toBe("");
  });

  it("renders the row chip and the properties value", () => {
    render(
      <>
        <ResourceWaitChip
          scheduledRetry={scheduledRetry(
            wait({ kind: "ai_account", reason: "usage_limit", resumeAt: RESET.toISOString(), resumeAtSource: "estimated" }),
            "ai_account_wait",
          )}
        />
        <ResourceWaitPropertyValue scheduledRetry={scheduledRetry(wait({ kind: "device_slots", reason: "slots_full" }), "device_slot_wait")} />
      </>,
    );
    const chip = container.querySelector('[data-testid="issue-row-resource-wait"]');
    expect(chip?.textContent).toMatch(/^Waiting for limit reset: .+\(estimated\)$/);
    expect(container.querySelector('[data-testid="issue-properties-resource-wait"]')?.textContent)
      .toBe("an account slot on Build box");
  });
});
