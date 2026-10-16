import { describe, expect, it } from "vitest";
import { describeRunRetryState, formatRetryReason } from "./runRetryState";

describe("runRetryState", () => {
  it("formats internal retry reasons for operators", () => {
    expect(formatRetryReason("transient_failure")).toBe("Transient failure");
    expect(formatRetryReason("native_provider_overloaded")).toBe("Model at capacity");
    expect(formatRetryReason("issue_continuation_needed")).toBe("Continuation needed");
    expect(formatRetryReason("max_turns_continuation")).toBe("Max-turn continuation");
    expect(formatRetryReason("custom_reason")).toBe("custom reason");
  });

  it("describes scheduled retries", () => {
    expect(
      describeRunRetryState({
        status: "scheduled_retry",
        retryOfRunId: "run-1",
        scheduledRetryAttempt: 2,
        scheduledRetryReason: "transient_failure",
        scheduledRetryAt: "2026-04-18T20:15:00.000Z",
      }),
    ).toMatchObject({
      kind: "scheduled",
      badgeLabel: "Retry scheduled",
      detail: "Attempt 2 · Transient failure",
    });
  });

  it("describes max-turn continuation retries distinctly", () => {
    expect(
      describeRunRetryState({
        status: "scheduled_retry",
        retryOfRunId: "run-max-turns",
        scheduledRetryAttempt: 1,
        scheduledRetryReason: "max_turns_continuation",
        scheduledRetryAt: "2026-04-18T20:15:00.000Z",
      }),
    ).toMatchObject({
      kind: "scheduled",
      badgeLabel: "Continuation scheduled",
      detail: "Attempt 1 · Max-turn continuation",
    });
  });

  it("describes exhausted retries", () => {
    expect(
      describeRunRetryState({
        status: "failed",
        retryOfRunId: "run-1",
        scheduledRetryAttempt: 4,
        scheduledRetryReason: "transient_failure",
        retryExhaustedReason: "Bounded retry exhausted after 4 scheduled attempts; no further automatic retry will be queued",
      }),
    ).toMatchObject({
      kind: "exhausted",
      badgeLabel: "Retry exhausted",
      detail: "Attempt 4 · Transient failure · Automatic retries exhausted",
      secondary: "Bounded retry exhausted after 4 scheduled attempts; no further automatic retry will be queued Manual intervention required.",
    });
  });
});

describe("runRetryState resource waits (fork)", () => {
  const deviceWait = {
    version: 1,
    episodeId: "episode-1",
    kind: "environment",
    reason: "offline",
    scope: "target",
    environmentId: "environment-1",
    environmentName: "SSH · Build box",
    deviceId: "device-1",
    deviceName: "Build box",
    accountId: null,
    accountLabel: null,
    resumeAt: null,
    resumeAtSource: null,
    message: null,
  };

  it("labels the three wait lanes", () => {
    expect(formatRetryReason("environment_wait")).toBe("Waiting for device");
    expect(formatRetryReason("ai_account_wait")).toBe("Waiting for Claude account");
    expect(formatRetryReason("device_slot_wait")).toBe("Waiting for account slot");
  });

  it("describes a waiting successor as waiting, not as a scheduled retry", () => {
    expect(
      describeRunRetryState({
        status: "scheduled_retry",
        retryOfRunId: "run-deferral",
        scheduledRetryAttempt: 2,
        scheduledRetryReason: "environment_wait",
        scheduledRetryAt: "2026-04-18T20:15:00.000Z",
        contextSnapshot: { resourceWait: deviceWait },
      } as Parameters<typeof describeRunRetryState>[0]),
    ).toMatchObject({
      kind: "scheduled",
      badgeLabel: "Waiting",
      detail: "Waiting for device Build box (offline)",
      retryOfRunId: "run-deferral",
    });
  });

  it("describes a deferral as waited, with no retry wording", () => {
    const state = describeRunRetryState({
      status: "cancelled",
      errorCode: "ai_account_unavailable",
      resultJson: {
        executionRecovery: { kind: "resource_wait", providerWorkStarted: false },
        resourceWait: { kind: "ai_account", reason: "usage_limit" },
      },
    } as Parameters<typeof describeRunRetryState>[0]);
    expect(state).toMatchObject({ kind: "attempted", badgeLabel: "Waited", detail: "Waited: usage limit" });
    expect(`${state?.detail} ${state?.secondary}`).not.toMatch(/retr/i);
  });

  it("describes a successor that ran as resumed", () => {
    expect(
      describeRunRetryState({
        status: "succeeded",
        retryOfRunId: "run-deferral",
        scheduledRetryAttempt: 3,
        scheduledRetryReason: "device_slot_wait",
      }),
    ).toMatchObject({ kind: "attempted", badgeLabel: "Resumed", detail: "Started after waiting for an account slot" });
  });
});
