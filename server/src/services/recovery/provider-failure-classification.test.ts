import { classifyRunLiveness } from "../run-liveness.js";
import { isAiAuthenticationBlocked } from "../ai-auth-failure.js";
import { describe, expect, it } from "vitest";
import {
  PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS,
  classifyAdapterFailureForRecovery,
  classifyContinuationFailure,
} from "./service.js";
import { legacyExecutionNeedsReconciliation } from "../legacy-execution-recovery.js";

describe("classifyAdapterFailureForRecovery", () => {
  it.each(["acpx_auth_required", "claude_auth_required", "codex_auth_required", "adapter_auth_missing", "refresh_token_reused", "authentication_required"])("does not automatically retry provider authentication failure %s", (errorCode) => {
    const classification = classifyRunLiveness({ runStatus: "failed", issue: null, errorCode, authenticationRepairRequested: true });
    const run = { errorCode, ...classification };
    expect(isAiAuthenticationBlocked(run)).toBe(true);
    expect(classifyContinuationFailure(run as never)).toMatchObject({ kind: "non_retryable", maxAttempts: 0 });
  });

  it.each(["kimi_auth_required", "acpx_auth_required", "gemini_auth_required"])("preserves recovery when %s did not produce an inline repair card", (errorCode) => {
    const classification = classifyRunLiveness({ runStatus: "failed", issue: null, errorCode, authenticationRepairRequested: false });
    const run = { errorCode, ...classification };
    expect(isAiAuthenticationBlocked(run)).toBe(false);
    expect(classifyContinuationFailure(run as never).kind).toBe("default");
  });

  it("uses a typed ACP quota reset without needing the provider's original message", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "ACP agent reported a terminal limit failure.",
      resultJson: {
        errorFamily: "provider_quota",
        retryNotBefore: "2026-07-15T21:30:00.000Z",
        providerQuotaRetryNotBefore: "2026-07-15T21:30:00.000Z",
      },
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("uses the existing backoff for a typed ACP quota failure with no reset timestamp", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "ACP agent reported a terminal limit failure.",
      resultJson: { errorFamily: "provider_quota" },
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

  it("classifies usage-limit messages and parses the provider reset time", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit for GPT-5. Try again at 4:30 PM (America/Chicago).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("uses the default recovery backoff when quota reset time is absent", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Provider quota exceeded for this model.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

  it("treats timezone-less provider reset clocks as UTC", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit. Try again at 4:30 PM.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-16T16:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("parses provider reset clocks in 24-hour format", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit. Try again at 21:30 (UTC).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("classifies the qualifier-less limit wording and parses the 'resets' clock", () => {
    // Current Claude CLI phrasing, as recorded on the run by the adapter.
    const now = new Date("2026-08-28T22:30:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Claude run failed: subtype=success: You've hit your limit · resets 2:30am (UTC)",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-08-29T02:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  // Limit messages recorded on prod provider_quota runs (2026-10-05..10-12),
  // resolved against the run's own finish time.
  it.each([
    [
      "Claude run failed: subtype=success: You've hit your weekly limit · resets Oct 15, 6am (UTC)",
      "2026-10-11T04:07:50.025Z",
      "2026-10-15T06:00:00.000Z",
    ],
    [
      "Claude run failed: subtype=success: You've hit your session limit · resets 4pm (UTC)",
      "2026-10-05T15:16:36.054Z",
      "2026-10-05T16:00:00.000Z",
    ],
    [
      "Claude run failed: subtype=success: You've hit your weekly limit · resets 6am (UTC)",
      "2026-10-08T04:12:18.538Z",
      "2026-10-08T06:00:00.000Z",
    ],
  ])("parses the prod limit message %s", (error, finishedAt, expected) => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error,
      resultJson: { errorFamily: "provider_quota" },
      finishedAt: new Date(finishedAt),
    }, new Date(finishedAt))).toEqual({
      kind: "provider_quota",
      retryAt: new Date(expected),
      parsedResetTime: true,
    });
  });

  it("reads the dated reset from an ACP compaction summary", () => {
    const now = new Date("2026-10-12T01:20:17.088Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "ACP agent reported a terminal limit failure.",
      resultJson: {
        errorFamily: "provider_quota",
        summary: "Compacting...\n\nCompacting failed: You've hit your weekly limit · resets Oct 15, 6am (UTC)",
      },
    }, now)).toMatchObject({ retryAt: new Date("2026-10-15T06:00:00.000Z"), parsedResetTime: true });
  });

  // The run the claude-local ACP lane now stores when automatic compaction
  // fails on the usage limit (a `request` typed failure).
  it("reads the dated reset from an ACP request-category compaction failure", () => {
    const title =
      "Prompt is too long · automatic compaction failed: You've hit your weekly limit · resets Oct 15, 6am (UTC)";
    const finishedAt = new Date("2026-10-12T01:21:00.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: `ACP agent reported a terminal request failure.\n${title}`,
      resultJson: {
        errorFamily: "provider_quota",
        terminalSessionFailure: { category: "request", title },
      },
      finishedAt,
    }, finishedAt)).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-10-15T06:00:00.000Z"),
      parsedResetTime: true,
    });
  });

  it.each([
    ["resets Oct 15 at 6am", "2026-10-15T06:00:00.000Z"],
    ["resets Oct 15, 6:30pm (America/Chicago)", "2026-10-15T23:30:00.000Z"],
    ["resets Thu, Oct 15, 6am (UTC)", "2026-10-15T06:00:00.000Z"],
    ["resets October 15th at 06:00", "2026-10-15T06:00:00.000Z"],
    ["resets on Oct 15 at 6am UTC", "2026-10-15T06:00:00.000Z"],
    ["resets in 3 hours", "2026-10-11T07:00:00.000Z"],
    ["Try again in 2h 30m.", "2026-10-11T06:30:00.000Z"],
  ])("parses the reset form %s", (form, expected) => {
    const finishedAt = new Date("2026-10-11T04:00:00.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: `You've hit your weekly limit · ${form}`,
      resultJson: null,
      finishedAt,
    }, finishedAt)).toMatchObject({ retryAt: new Date(expected), parsedResetTime: true });
  });

  it("rolls a dated reset into the next year only when the date is far behind the message", () => {
    const finishedAt = new Date("2026-12-30T22:00:00.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "You've hit your weekly limit · resets Jan 2, 6am (UTC)",
      resultJson: null,
      finishedAt,
    }, finishedAt)).toMatchObject({ retryAt: new Date("2027-01-02T06:00:00.000Z") });
  });

  it("resolves the reset against the failed run, so a reset that has passed is due now", () => {
    // Without the run time, "resets 4pm" read at 18:00 would wait a whole day
    // and "Oct 15" read after Oct 16 would land next year.
    const now = new Date("2026-10-16T18:00:00.000Z");
    for (const [error, finishedAt] of [
      ["You've hit your session limit · resets 4pm (UTC)", "2026-10-16T15:10:00.000Z"],
      ["You've hit your weekly limit · resets Oct 15, 6am (UTC)", "2026-10-11T04:07:50.025Z"],
    ] as const) {
      expect(classifyAdapterFailureForRecovery({
        errorCode: "provider_quota",
        error,
        resultJson: null,
        finishedAt: new Date(finishedAt),
      }, now)).toEqual({ kind: "provider_quota", retryAt: now, parsedResetTime: true });
    }
  });

  it.each([
    "model_not_found: requested model does not exist",
    "No API credentials were found for this provider",
    "API key is not set",
  ])("classifies configuration failures: %s", (error) => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error,
      resultJson: null,
    })).toEqual({ kind: "configuration_incomplete" });
  });

  it("ignores quota-like text from non-adapter failures", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "timeout",
      error: "Provider quota exceeded while waiting for a downstream service.",
      resultJson: null,
    })).toBeNull();
  });

  it("routes unavailable engines to a configuration blocker instead of retrying", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_engine_unavailable",
      error: "Node v22.22.2 does not satisfy Codex ACP's Node >=24.11.0 prerequisite.",
      resultJson: null,
    })).toEqual({ kind: "configuration_incomplete" });
    expect(classifyContinuationFailure({ errorCode: "adapter_engine_unavailable" } as never))
      .toMatchObject({ kind: "non_retryable", maxAttempts: 0 });
    expect(legacyExecutionNeedsReconciliation({
      runtimeMode: "legacy",
      status: "failed",
      errorCode: "adapter_engine_unavailable",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    })).toBe(false);
  });

  it("does not treat a generic capacity limit as provider quota", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Workspace storage capacity limit reached.",
      resultJson: null,
    })).toBeNull();
  });
});
