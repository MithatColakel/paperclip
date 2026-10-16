import { describe, expect, it } from "vitest";
import { RESOURCE_WAIT_ERROR_CODES, RESOURCE_WAIT_RETRY_REASONS } from "@paperclipai/shared";
import { legacyExecutionNeedsReconciliation } from "../services/legacy-execution-recovery.js";

// Fork: spec 7.6. A resource-wait deferral and a lane run cancelled before it
// started never reached a provider, so neither may create a board
// reconciliation hold, even after earlier failure retries.

describe("legacy reconciliation exemptions for resource waits", () => {
  it.each(RESOURCE_WAIT_ERROR_CODES)("(a) exempts a %s deferral with resource-wait evidence", (errorCode) => {
    const deferral = {
      runtimeMode: "legacy", status: "cancelled", errorCode, scheduledRetryAttempt: 7,
      scheduledRetryReason: "transient_failure",
      startedAt: new Date(), processPid: null, runtimeModeResolvedAt: null,
      resultJson: { executionRecovery: { kind: "resource_wait", providerWorkStarted: false } },
    };
    expect(legacyExecutionNeedsReconciliation(deferral)).toBe(false);
    // The evidence is what proves no provider work started.
    expect(legacyExecutionNeedsReconciliation({ ...deferral, resultJson: {} })).toBe(true);
    expect(legacyExecutionNeedsReconciliation({ ...deferral, resultJson: {
      executionRecovery: { kind: "resource_wait", providerWorkStarted: true },
    } })).toBe(true);
    expect(legacyExecutionNeedsReconciliation({ ...deferral, status: "failed" })).toBe(true);
    expect(legacyExecutionNeedsReconciliation({ ...deferral, errorCode: "setup_failed" })).toBe(true);
  });

  it.each(RESOURCE_WAIT_RETRY_REASONS)("(b) exempts a never-started %s run cancelled by pause, budget or a comment", (scheduledRetryReason) => {
    const waiting = {
      runtimeMode: "legacy", status: "cancelled", errorCode: "agent_not_invokable", scheduledRetryAttempt: 9,
      scheduledRetryReason, startedAt: null, processPid: null, runtimeModeResolvedAt: null,
      resultJson: { cancellation: { source: "control_plane", expected: true } },
    };
    expect(legacyExecutionNeedsReconciliation(waiting)).toBe(false);
    // A lane run that started (or got a process or a resolved runtime mode) is an ordinary run again.
    expect(legacyExecutionNeedsReconciliation({ ...waiting, startedAt: new Date() })).toBe(true);
    expect(legacyExecutionNeedsReconciliation({ ...waiting, processPid: 4242 })).toBe(true);
    expect(legacyExecutionNeedsReconciliation({ ...waiting, runtimeModeResolvedAt: new Date() })).toBe(true);
    expect(legacyExecutionNeedsReconciliation({ ...waiting, status: "failed" })).toBe(true);
    expect(legacyExecutionNeedsReconciliation({ ...waiting, scheduledRetryReason: "transient_failure" })).toBe(true);
  });

  it("keeps the workspace_busy and ai_connection_busy behaviour", () => {
    const workspace = {
      runtimeMode: "legacy", status: "cancelled", errorCode: "workspace_busy", scheduledRetryAttempt: 6,
      resultJson: { executionRecovery: { kind: "workspace_wait", providerWorkStarted: false } },
    };
    expect(legacyExecutionNeedsReconciliation(workspace)).toBe(false);
    expect(legacyExecutionNeedsReconciliation({ ...workspace, resultJson: {} })).toBe(true);
    const subscription = {
      runtimeMode: "legacy", status: "cancelled", errorCode: "ai_connection_busy", scheduledRetryAttempt: 6,
      resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false } },
    };
    expect(legacyExecutionNeedsReconciliation(subscription)).toBe(false);
    expect(legacyExecutionNeedsReconciliation({ ...subscription, resultJson: {
      executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: true },
    } })).toBe(true);
  });

  it("never exempts a native run or a live status", () => {
    const deferral = {
      runtimeMode: "legacy", status: "cancelled", errorCode: "environment_unavailable",
      resultJson: { executionRecovery: { kind: "resource_wait", providerWorkStarted: false } },
    };
    expect(legacyExecutionNeedsReconciliation({ ...deferral, runtimeMode: "native" })).toBe(false);
    expect(legacyExecutionNeedsReconciliation({ ...deferral, status: "running" })).toBe(false);
  });
});
