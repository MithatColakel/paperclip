import { describe, expect, it } from "vitest";
import { projectExecution } from "./execution-projection.js";

type Run = Parameters<typeof projectExecution>[0];
type Coordinator = NonNullable<Parameters<typeof projectExecution>[1]>;
const now = new Date("2026-09-08T12:00:00Z");
const run = (values: Partial<Run> = {}) =>
  ({
    status: "running",
    runtimeMode: "native",
    errorCode: null,
    nextAction: null,
    lastUsefulActionAt: now,
    lastOutputAt: null,
    startedAt: now,
    scheduledRetryAt: null,
    scheduledRetryAttempt: 1,
    retryOfRunId: null,
    executionControlDeadlineAt: null,
    ...values,
  }) as Run;
const coordinator = (values: Partial<Coordinator> = {}) =>
  ({
    phase: "observed",
    attempt: 1,
    failureCode: null,
    failureDetail: {},
    nextAttemptAt: null,
    leaseExpiresAt: new Date(now.getTime() + 30_000),
    controlDeadlineAt: null,
    ...values,
  }) as Coordinator;
const project = (
  r = run(),
  c: Coordinator | undefined = coordinator(),
  pending: { kind: string }[] = [],
) => projectExecution(r, c, pending, undefined, now);

describe("execution truth projection", () => {
  it("keeps cleanup quarantine visible without a coordinator or recovery row", () => {
    const stopped = run({ id: "stopped", status: "failed", errorCode: "native_session_cleanup_quarantined" });
    expect(projectExecution(stopped, undefined, [], undefined, now)).toMatchObject({
      phase: "recovery_needed", cause: "native_session_cleanup_quarantined", recoveryOwner: "board",
      permittedActions: ["inspect_run", "inspect_recovery"],
    });
    expect(projectExecution(stopped, coordinator({ phase: "retryable_failure" }), [], undefined, now).phase).toBe("recovery_needed");
    expect(projectExecution({ ...stopped, finishedAt: now }, coordinator({
      phase: "terminal_failure", failureCode: "native_provider_terminal_failed",
    }), [], undefined, now)).toMatchObject({ phase: "recovery_needed", recoveryOwner: "board" });
    expect(projectExecution({ ...stopped, errorCode: "provider_frame_too_large" }, undefined, [], undefined, now).phase).toBe("failed");
    expect(projectExecution(stopped, undefined, [], { status: "resolved", cause: "native_session_cleanup_quarantined", nextAction: "Verify prior execution",
      evidence: { executionReconciliation: { providerStopped: true }, continuationRunId: "successor" } }, now))
      .toMatchObject({ phase: "completed", successorRunId: "successor", cause: null });
  });
  it("shows subscription contention as a resource wait without failed provider attempts", () => {
    expect(projectExecution(run({ runtimeMode: "legacy", status: "scheduled_retry", scheduledRetryReason: "ai_connection_busy",
      scheduledRetryAttempt: 12, contextSnapshot: { failureRetriesBeforeAiConnectionWait: 0 } }), undefined, [], undefined, now))
      .toMatchObject({ label: "Waiting for AI subscription", phase: "retry_scheduled", attempt: 1, recoveryOwner: null });
  });
  it("shows a workspace wait without presenting its deferral count as failed attempts", () => {
    expect(projectExecution(run({ runtimeMode: "legacy", status: "scheduled_retry", scheduledRetryReason: "workspace_busy",
      scheduledRetryAttempt: 12, contextSnapshot: { failureRetriesBeforeWorkspaceWait: 1 } }), undefined, [], undefined, now))
      .toMatchObject({ label: "Waiting for workspace", phase: "retry_scheduled", attempt: 2, recoveryOwner: null });
  });
  it.each([
    { status: "resolved", previousRunId: "old", nextRunId: "next", continued: true },
    { status: "active", previousRunId: "old", nextRunId: "next", continued: false },
    { status: "resolved", previousRunId: "other", nextRunId: "next", continued: false },
    { status: "resolved", previousRunId: "old", nextRunId: "old", continued: false },
    { status: "resolved", previousRunId: "old", nextRunId: null, continued: false },
  ])("projects the recorded explicit successor without hiding unresolved recovery: $status/$previousRunId/$nextRunId", ({ status, previousRunId, nextRunId, continued }) => {
    const source = run({ id: "old", status: "failed", errorCode: "adapter_failed" });
    expect(projectExecution(source, coordinator({ phase: "terminal_failure" }), [], {
      status,
      cause: "native_continuation_requires_reconciliation",
      nextAction: "Inspect the stopped execution.",
      evidence: {
        automaticRecovery: { policy: "preserve_without_replay_v1" },
        explicitUserContinuation: { previousRunId, runId: nextRunId },
      },
    }, now)).toMatchObject(continued ? {
      phase: "completed", label: "Continued in another run", successorRunId: "next",
      cause: "native_continuation_requires_reconciliation", nextAction: null,
    } : { phase: "recovery_needed", successorRunId: null });
    expect(source.status).toBe("failed");
  });

  it("shows a reconciled continuation as queued until its durable delivery is recorded", () => {
    const action = {
      cause: "native_session_retry_exhausted",
      nextAction: "Old recovery action",
      status: "resolved" as const,
      evidence: {
        executionReconciliation: { runId: "old" },
        continuationDelivery: "pending",
      },
    };
    expect(
      projectExecution(
        run({ status: "failed" }),
        coordinator({ phase: "terminal_failure" }),
        [],
        action,
        now,
      ),
    ).toMatchObject({
      phase: "queued",
      label: "Continuation queued",
      cause: null,
    });
    expect(
      projectExecution(
        run({ status: "failed" }),
        coordinator({ phase: "terminal_failure" }),
        [],
        {
          ...action,
          evidence: { ...action.evidence, continuationRunId: "next" },
        },
        now,
      ),
    ).toMatchObject({ phase: "completed", successorRunId: "next" });
    expect(
      projectExecution(
        run({ status: "failed" }),
        coordinator({ phase: "terminal_failure" }),
        [],
        {
          ...action,
          evidence: { ...action.evidence, continuationDelivery: "invalidated" },
        },
        now,
      ),
    ).toMatchObject({ phase: "failed", label: "Continuation cancelled" });
  });
  it("requires current execution evidence, without treating output silence as failure", () => {
    expect(project(run({ lastOutputAt: new Date(0) })).phase).toBe("working");
    expect(
      project(run(), coordinator({ leaseExpiresAt: new Date(0) })),
    ).toMatchObject({ phase: "reconnecting", label: "Confirming execution" });
    expect(
      project(
        run({ runtimeMode: "legacy", processPid: process.pid }),
        undefined,
      ).phase,
    ).toBe("working");
  });
  it("distinguishes provider work, finalization and timed retry", () => {
    expect(
      project(
        run({ executionControlDeadlineAt: new Date(now.getTime() + 60_000) }),
      ).phase,
    ).toBe("finishing");
    expect(
      project(
        run({ status: "failed" }),
        coordinator({
          phase: "retryable_failure",
          nextAttemptAt: new Date(now.getTime() + 30_000),
          attempt: 2,
        }),
      ),
    ).toMatchObject({ phase: "retry_scheduled", attempt: 2, maxAttempts: 3 });
    expect(
      project(
        run({ status: "failed" }),
        coordinator({ phase: "retryable_failure", nextAttemptAt: new Date(0) }),
      ).phase,
    ).toBe("reconnecting");
  });
  it("includes the original legacy attempt in the displayed incident budget", () => {
    expect(projectExecution(run({ runtimeMode: "legacy", status: "scheduled_retry", scheduledRetryAttempt: 1 }), undefined, [], undefined, now)).toMatchObject({ attempt: 2, maxAttempts: 3 });
  });
  it("shows pending interaction only after productive work has stopped", () => {
    expect(
      project(run(), coordinator(), [{ kind: "connection_intent" }]).phase,
    ).toBe("working");
    expect(
      project(run({ status: "succeeded" }), undefined, [
        { kind: "connection_intent" },
      ]).phase,
    ).toBe("waiting_for_access");
    expect(
      project(run({ status: "succeeded" }), undefined, [
        { kind: "ask_user_questions" },
      ]).phase,
    ).toBe("waiting_for_answer");
  });
  it("retains replacement lineage and exposes operator-owned failures for legacy runs", () => {
    expect(
      project(
        run({ status: "failed" }),
        coordinator({
          phase: "terminal_failure",
          failureDetail: { successorRunId: "replacement" },
        }),
      ),
    ).toMatchObject({ phase: "completed", successorRunId: "replacement" });
    expect(
      projectExecution(
        run({ runtimeMode: "legacy", status: "failed" }),
        undefined,
        [],
        {
          cause: "uncertain_external_action",
          nextAction: "Reconcile the email delivery.",
        },
        now,
      ),
    ).toMatchObject({
      phase: "recovery_needed",
      recoveryOwner: "board",
      nextAction: "Reconcile the email delivery.",
    });
  });
  describe("resource waits (fork, spec 7.7)", () => {
    const wait = (values: Record<string, unknown>) => ({
      version: 1,
      episodeId: "episode-1",
      kind: "environment",
      reason: "offline",
      scope: "target",
      environmentId: "environment-1",
      environmentName: "Studio",
      deviceId: "device-1",
      deviceName: "Build box",
      accountId: null,
      accountLabel: null,
      resumeAt: null,
      resumeAtSource: null,
      message: null,
      ...values,
    });
    const lane = (scheduledRetryReason: string, resourceWait: Record<string, unknown> | null, values: Partial<Run> = {}) =>
      projectExecution(run({
        runtimeMode: "legacy",
        status: "scheduled_retry",
        scheduledRetryReason,
        scheduledRetryAt: new Date(now.getTime() + 600_000),
        scheduledRetryAttempt: 7,
        contextSnapshot: { failureRetriesBeforeResourceWait: 1, ...(resourceWait ? { resourceWait } : {}) },
        ...values,
      }), undefined, [], undefined, now);

    it("names the device a task waits for, without counting waits as failed attempts", () => {
      expect(lane("environment_wait", wait({}))).toMatchObject({
        phase: "retry_scheduled",
        label: "Waiting for device",
        attempt: 2,
        recoveryOwner: null,
        nextAction: expect.stringContaining("Waiting for device Build box (offline)"),
      });
      expect(lane("environment_wait", wait({ reason: "not_allowed", scope: "admission" })).nextAction)
        .toContain("This project is not enabled for this company on device Build box");
      // The driver's own message names its fix.
      expect(lane("environment_wait", wait({ reason: "not_serving", scope: "admission", message: "Ask the owner to share this computer" })).nextAction)
        .toBe("Ask the owner to share this computer. The task then starts automatically.");
      expect(lane("environment_wait", wait({ reason: "stopped", scope: "admission" })).nextAction).toContain("stopped");
    });

    it("says what an account wait needs and when a limit resets", () => {
      const account = { kind: "ai_account", scope: "account", environmentId: null, environmentName: null, deviceId: null, deviceName: null, accountId: "account-1", accountLabel: "Max-2" };
      const provider = lane("ai_account_wait", wait({ ...account, reason: "usage_limit", resumeAt: "2026-09-08T18:00:00.000Z", resumeAtSource: "provider" }));
      expect(provider).toMatchObject({ phase: "retry_scheduled", label: "Waiting for usage limit reset", recoveryOwner: null });
      expect(provider.nextAction).toBe("Claude account Max-2 reached its usage limit. The task resumes automatically when it resets at 2026-09-08 18:00 UTC. Paperclip never moves a task to another account.");
      expect(lane("ai_account_wait", wait({ ...account, reason: "usage_limit", resumeAt: "2026-09-08T18:00:00.000Z", resumeAtSource: "estimated" })).nextAction)
        .toContain("at 2026-09-08 18:00 UTC (estimated)");
      expect(lane("ai_account_wait", wait({ ...account, reason: "credit_balance" })).label).toBe("Waiting for API credit");
      expect(lane("ai_account_wait", wait({ ...account, reason: "auth_unconfirmed" })).label).toBe("Checking Claude account sign-in");
      const signedOut = lane("ai_account_wait", wait({ ...account, reason: "signed_out" }));
      expect(signedOut).toMatchObject({ label: "Waiting for a Claude account" });
      expect(signedOut.nextAction).toContain("Claude account Max-2 is signed out. Its owner must replace the token");
      // A hidden label never shows up: the context of another company's account carries none.
      expect(lane("ai_account_wait", wait({ ...account, accountLabel: null, reason: "withdrawn" })).nextAction)
        .toContain("The agent's Claude account is switched off");
      expect(lane("ai_account_wait", wait({ ...account, accountId: null, accountLabel: null, reason: "unassigned" })).nextAction)
        .toContain("No Claude account is chosen for the agent");
    });

    it("labels slot waits, and keeps the lane label without a readable wait", () => {
      expect(lane("device_slot_wait", wait({ kind: "device_slots", reason: "slots_full", scope: "device" }))).toMatchObject({
        label: "Waiting for an account slot",
        nextAction: expect.stringContaining("Device Build box already runs its maximum of Claude accounts"),
      });
      expect(lane("environment_wait", null)).toMatchObject({ label: "Waiting for device", nextAction: expect.stringContaining("its execution device") });
      expect(lane("ai_account_wait", { version: 2 }).label).toBe("Waiting for a Claude account");
      expect(lane("device_slot_wait", null).nextAction).toContain("Its device already runs");
    });

    it("shows a deferral as waited, never as a failed or cancelled run", () => {
      for (const errorCode of ["environment_unavailable", "ai_account_unavailable", "device_slots_full"]) {
        expect(projectExecution(run({ runtimeMode: "legacy", status: "cancelled", errorCode }), undefined, [], undefined, now))
          .toMatchObject({ phase: "completed", label: "Waited", recoveryOwner: null, nextAction: expect.stringContaining("started no provider work") });
      }
      // Other cancellations, and a lane successor cancelled by a pause, stay cancelled.
      expect(projectExecution(run({ runtimeMode: "legacy", status: "cancelled", errorCode: "issue_reassigned" }), undefined, [], undefined, now).label).toBe("Cancelled");
      expect(projectExecution(run({ runtimeMode: "legacy", status: "cancelled", scheduledRetryReason: "environment_wait" }), undefined, [], undefined, now).label).toBe("Cancelled");
    });
  });
  it("bounds recovery checking and surfaces its next action if verification never finishes", () => {
    const c = coordinator({
      phase: "terminal_failure",
      failureCode: "native_provider_terminal_failed",
    });
    expect(project(run({ status: "failed", finishedAt: now }), c).label).toBe(
      "Checking recovery",
    );
    expect(
      project(
        run({ status: "failed", finishedAt: new Date(now.getTime() - 60_000) }),
        c,
      ).phase,
    ).toBe("recovery_needed");
    expect(
      project(
        run({ status: "failed", finishedAt: now }),
        coordinator({
          ...c,
          failureDetail: { replacementDenied: "uncertain_provider_action" },
        }),
      ).phase,
    ).toBe("recovery_needed");
  });
});
