import { describe, expect, it } from "vitest";
import { noticeMetadataReferencesRecoveryAction } from "./successful-run-handoff.js";
import {
  DEFAULT_STRANDED_RECOVERY_NOTICE_BODY,
  buildConfigurationIncompleteRecoveryNoticeSeed,
  buildExecutionReviewParticipantRecoveryNoticeSeed,
  buildExecutionReviewParticipantUnavailableNoticeSeed,
  buildImmediateExecutionPathRecoveryNoticeSeed,
  buildStrandedRecoveryEscalationNotice,
  buildWorkspaceValidationRecoveryNoticeSeed,
} from "./stranded-notice.js";
import { resourceWaitRefusalNoticeSeed } from "./resource-wait-refusal-notice.js";

function allRows(metadata: { sections: Array<{ rows: unknown[] }> }) {
  return metadata.sections.flatMap((section) => section.rows) as Array<Record<string, unknown>>;
}

describe("stranded recovery notice seeds", () => {
  it.each([
    ["todo dispatch", buildImmediateExecutionPathRecoveryNoticeSeed({ status: "todo" }), "No live execution path"],
    ["in_progress continuation", buildImmediateExecutionPathRecoveryNoticeSeed({ status: "in_progress" }), "No live execution path"],
    ["workspace validation", buildWorkspaceValidationRecoveryNoticeSeed(), "Workspace validation failed"],
    ["configuration incomplete", buildConfigurationIncompleteRecoveryNoticeSeed(), "Configuration incomplete"],
    ["review participant recovery", buildExecutionReviewParticipantRecoveryNoticeSeed(), "Review recovery stalled"],
    ["review participant unavailable", buildExecutionReviewParticipantUnavailableNoticeSeed(), "Review recovery stalled"],
  ])("%s seed has a short body plus title and tone", (_label, seed, expectedTitle) => {
    expect(seed.title).toBe(expectedTitle);
    expect(seed.tone).toBe("danger");
    expect(seed.body.length).toBeGreaterThan(0);
    // Failure details now live in metadata rows, never inline in the body.
    expect(seed.body).not.toContain("Latest retry failure");
    expect(seed.body).not.toContain("Recovery action:");
  });

  it("names the sandbox provider plugin and its status when that is the configuration gap", () => {
    const seed = buildConfigurationIncompleteRecoveryNoticeSeed({
      reason: "sandbox_provider_plugin_not_ready",
      pluginKey: "paperclip.kubernetes-sandbox-provider",
      pluginStatus: "error",
    });
    expect(seed.title).toBe("Configuration incomplete");
    expect(seed.tone).toBe("danger");
    expect(seed.body).toContain("`paperclip.kubernetes-sandbox-provider`");
    expect(seed.body).toContain("`error`");
    expect(seed.body).toContain("enable the plugin");
    expect(seed.body).not.toContain("secret/env bindings");
  });

  it("asks for a capability review before enabling an upgrade_pending plugin, and names an operator disable", () => {
    const upgrade = buildConfigurationIncompleteRecoveryNoticeSeed({
      reason: "sandbox_provider_plugin_not_ready",
      pluginKey: "paperclip.daytona-sandbox-provider",
      pluginStatus: "upgrade_pending",
    });
    expect(upgrade.body).toContain("review and approve the upgraded plugin's capabilities");
    const disabled = buildConfigurationIncompleteRecoveryNoticeSeed({
      reason: "sandbox_provider_plugin_not_ready",
      pluginKey: "paperclip.daytona-sandbox-provider",
      pluginStatus: "disabled",
    });
    expect(disabled.body).toContain("an operator disabled it");
  });

  it("names the refusing or removed execution device and the move, not secret bindings (fork)", () => {
    // The payload a resource-wait refusal records today: ids only.
    const generic = buildConfigurationIncompleteRecoveryNoticeSeed({
      reason: "environment_refused",
      agentId: "4d5e6f70-8a9b-4c1d-8e2f-444444444444",
      environmentId: "0c1d2e3f-4a5b-4c6d-8e7f-555555555555",
      fingerprint: "environment_refused:0c1d2e3f-4a5b-4c6d-8e7f-555555555555",
    });
    expect(generic.title).toBe("Execution device refused the run");
    expect(generic.tone).toBe("danger");
    expect(generic.body).toContain("the agent's execution device was removed or refuses this agent's runs");
    expect(generic.body).toContain("move the agent to another environment");
    expect(generic.nextAction).toContain("Move the agent to another environment");
    expect(generic.body).not.toContain("secret/env bindings");
    expect(generic.body).not.toContain("0c1d2e3f");

    const named = buildConfigurationIncompleteRecoveryNoticeSeed({ reason: "environment_refused", deviceName: "Build `box`" });
    expect(named.body).toContain("the execution device `Build 'box'` was removed or refuses this agent's runs");
    expect(buildConfigurationIncompleteRecoveryNoticeSeed({ reason: "environment_refused", environmentName: "SSH · Runner" }).body)
      .toContain("the execution device `SSH · Runner`");
    // It titles the escalation notice too.
    expect(buildStrandedRecoveryEscalationNotice({
      seed: named,
      recoveryActionId: "6a2f8e64-6f5e-4b58-b7fd-111111111111",
      recoveryOwner: null,
      sourceRun: { id: "run-1", status: "failed", errorCode: "configuration_incomplete" },
    }).presentation.title).toBe("Execution device refused the run");
  });

  it("names the setting to remove for a routing refusal, and a new execution for a changed account (fork)", () => {
    // The payloads the account pool's refusals record (ids, an action link and a fingerprint), and upstream's bare one.
    for (const payload of [
      {
        reason: "ai_connection_incompatible",
        companyId: "9b1c2d3e-4f50-4a61-8b72-222222222222",
        agentId: "4d5e6f70-8a9b-4c1d-8e2f-444444444444",
        actionUrl: "/agents/4d5e6f70-8a9b-4c1d-8e2f-444444444444/runtime",
        fingerprint: "ai-pool-incompatible:4d5e6f70-8a9b-4c1d-8e2f-444444444444:settings",
      },
      { reason: "ai_connection_incompatible", actionUrl: "/agents/4d5e6f70-8a9b-4c1d-8e2f-444444444444/runtime" },
    ]) {
      const seed = buildConfigurationIncompleteRecoveryNoticeSeed(payload);
      expect(seed.title).toBe("AI account blocked by a conflicting setting");
      expect(seed.tone).toBe("danger");
      expect(seed.body).toContain("a provider routing override or an authentication setting conflicts with this agent's AI account");
      expect(seed.body).toContain("`.claude/settings.json`");
      expect(seed.nextAction).toBe("Remove the routing override or authentication setting named in the run failure, then resume the task.");
      expect(seed.body).not.toContain("secret/env bindings");
      expect(seed.body).not.toContain("4d5e6f70");
    }

    for (const payload of [
      { reason: "ai_connection_changed", companyId: "9b1c2d3e-4f50-4a61-8b72-222222222222", agentId: "4d5e6f70-8a9b-4c1d-8e2f-444444444444" },
      { reason: "ai_connection_changed", actionUrl: "/agents/4d5e6f70-8a9b-4c1d-8e2f-444444444444/runtime" },
    ]) {
      const seed = buildConfigurationIncompleteRecoveryNoticeSeed(payload);
      expect(seed.title).toBe("AI account of a suspended run changed");
      expect(seed.body).toContain("a suspended run never continues on another account");
      expect(seed.body).toContain("start a new execution");
      expect(seed.nextAction).toBe("Start a new execution of the task; it uses the agent's current AI account.");
      expect(seed.body).not.toContain("secret/env bindings");
    }

    // They title the escalation notice and fill its next action.
    const notice = buildStrandedRecoveryEscalationNotice({
      seed: buildConfigurationIncompleteRecoveryNoticeSeed({ reason: "ai_connection_incompatible" }),
      recoveryActionId: "6a2f8e64-6f5e-4b58-b7fd-111111111111",
      recoveryOwner: null,
      sourceRun: {
        id: "run-1",
        status: "failed",
        errorCode: "configuration_incomplete",
        errorSummary: "ANTHROPIC_UNIX_SOCKET is set for Coder, so its Claude account cannot serve this run.",
      },
    });
    expect(notice.presentation.title).toBe("AI account blocked by a conflicting setting");
    expect(allRows(notice.metadata)).toContainEqual({
      type: "key_value",
      label: "Next action",
      value: "Remove the routing override or authentication setting named in the run failure, then resume the task.",
    });
  });

  it("leaves every other reason to the secret-binding copy (fork)", () => {
    for (const payload of [{ reason: "secret_binding_missing" }, { reason: "environment_variable_missing" }, { reason: "" }, {}, null, undefined]) {
      const seed = buildConfigurationIncompleteRecoveryNoticeSeed(payload);
      expect(seed.title).toBe("Configuration incomplete");
      expect(seed.body).toContain("secret/env bindings");
      expect(seed.nextAction).toBeUndefined();
      expect(resourceWaitRefusalNoticeSeed(payload)).toBeNull();
    }
  });

  it("keeps the secret-binding copy for other configuration gaps", () => {
    expect(buildConfigurationIncompleteRecoveryNoticeSeed({ reason: "secret_binding_missing" }).body).toContain(
      "secret/env bindings",
    );
    expect(buildConfigurationIncompleteRecoveryNoticeSeed(null).body).toContain("secret/env bindings");
  });

  it("distinguishes todo dispatch from in_progress continuation copy", () => {
    expect(buildImmediateExecutionPathRecoveryNoticeSeed({ status: "todo" }).body).toContain("retried dispatch");
    expect(buildImmediateExecutionPathRecoveryNoticeSeed({ status: "in_progress" }).body).toContain(
      "retried continuation",
    );
  });
});

describe("buildStrandedRecoveryEscalationNotice", () => {
  it("names a workspace timeout and its repair instead of claiming generic continuation", () => {
    const notice = buildStrandedRecoveryEscalationNotice({
      seed: buildImmediateExecutionPathRecoveryNoticeSeed({ status: "in_progress" }),
      recoveryActionId: "scan-recovery",
      recoveryOwner: null,
      sourceRun: { id: "failed-run", status: "failed", errorCode: "workspace_git_scan_timeout" },
    });
    expect(notice.presentation.title).toBe("Workspace scan timed out");
    expect(notice.body).toContain("before the agent started");
    expect(notice.body).not.toContain("retried continuation");
    expect(JSON.stringify(notice.metadata)).toContain("repository access and server load");
  });
  const actionId = "6a2f8e64-6f5e-4b58-b7fd-111111111111";
  const owner = { id: "9b1c2d3e-4f50-4a61-8b72-222222222222", name: "CTO" };
  const sourceRun = {
    id: "0c1d2e3f-4a5b-4c6d-8e7f-333333333333",
    agentId: "4d5e6f70-8a9b-4c1d-8e2f-444444444444",
    status: "failed",
    errorCode: "workspace_validation_failed",
    errorSummary: "Expected project worktree but resolved the agent fallback directory.",
  };

  it("emits system_notice presentation and the required metadata rows", () => {
    const seed = buildWorkspaceValidationRecoveryNoticeSeed();
    const notice = buildStrandedRecoveryEscalationNotice({
      seed,
      recoveryActionId: actionId,
      recoveryOwner: owner,
      sourceRun,
    });

    expect(notice.body).toBe(seed.body);
    expect(notice.presentation).toMatchObject({
      kind: "system_notice",
      tone: "danger",
      title: "Workspace validation failed",
    });
    expect(notice.metadata.version).toBe(1);
    expect(notice.metadata.sourceRunId).toBe(sourceRun.id);

    const rows = allRows(notice.metadata);
    expect(rows).toContainEqual({ type: "key_value", label: "Recovery action", value: actionId });
    expect(rows).toContainEqual({ type: "agent_link", label: "Recovery owner", agentId: owner.id, name: owner.name });
    expect(rows).toContainEqual({
      type: "run_link",
      label: "Source run",
      runId: sourceRun.id,
      agentId: sourceRun.agentId,
      title: "failed",
    });
    expect(rows).toContainEqual({
      type: "key_value",
      label: "Failure code",
      value: "workspace_validation_failed",
    });
    expect(rows).toContainEqual({
      type: "key_value",
      label: "Failure summary",
      value: sourceRun.errorSummary,
    });
    expect(rows.some((row) => row.label === "Next action")).toBe(true);
  });

  it("records board escalation when there is no invokable recovery owner", () => {
    const notice = buildStrandedRecoveryEscalationNotice({
      seed: buildConfigurationIncompleteRecoveryNoticeSeed(),
      recoveryActionId: actionId,
      recoveryOwner: null,
      sourceRun,
    });

    const ownerRow = allRows(notice.metadata).find((row) => row.label === "Recovery owner");
    expect(ownerRow?.type).toBe("key_value");
    expect(ownerRow?.value).toBe("Board decision required");
  });

  it("derives title from the recovery cause and body from the plain-comment fallback", () => {
    const notice = buildStrandedRecoveryEscalationNotice({
      fallbackBody: "Legacy plain comment body.",
      recoveryCause: "configuration_incomplete",
      recoveryActionId: actionId,
      recoveryOwner: owner,
      sourceRun: null,
    });

    expect(notice.body).toBe("Legacy plain comment body.");
    expect(notice.presentation.title).toBe("Configuration incomplete");
    expect(notice.metadata.sourceRunId).toBeNull();
    expect(notice.metadata.sections).toHaveLength(1);
  });

  it("falls back to the default body and title when no seed or comment is given", () => {
    const notice = buildStrandedRecoveryEscalationNotice({
      recoveryActionId: actionId,
      recoveryOwner: null,
      sourceRun: null,
    });

    expect(notice.body).toBe(DEFAULT_STRANDED_RECOVERY_NOTICE_BODY);
    expect(notice.presentation.title).toBe("Automatic recovery blocked");
  });

  it("omits the failure code row when the source run has no error code", () => {
    const notice = buildStrandedRecoveryEscalationNotice({
      seed: buildImmediateExecutionPathRecoveryNoticeSeed({ status: "in_progress" }),
      recoveryActionId: actionId,
      recoveryOwner: owner,
      sourceRun: {
        id: sourceRun.id,
        agentId: sourceRun.agentId,
        status: "cancelled",
        errorCode: null,
        errorSummary: null,
      },
    });

    const rows = allRows(notice.metadata);
    expect(rows).toContainEqual({
      type: "run_link",
      label: "Source run",
      runId: sourceRun.id,
      agentId: sourceRun.agentId,
      title: "cancelled",
    });
    expect(rows.some((row) => row.label === "Failure code")).toBe(false);
    expect(rows.some((row) => row.label === "Failure summary")).toBe(false);
  });

  it("leads with the classified run failure code over the generic seed title", () => {
    const notice = buildStrandedRecoveryEscalationNotice({
      seed: buildImmediateExecutionPathRecoveryNoticeSeed({ status: "in_progress" }),
      recoveryActionId: actionId,
      recoveryOwner: owner,
      sourceRun: {
        ...sourceRun,
        errorCode: "provider_quota",
        errorSummary: "You've hit your limit · resets 2:30am (UTC)",
      },
    });

    expect(notice.presentation.title).toBe("Error: usage limit reached");
    expect(allRows(notice.metadata)).toContainEqual({
      type: "key_value",
      label: "Failure code",
      value: "provider_quota",
    });
  });

  it("titles auth-required run failures as a login error", () => {
    expect(
      buildStrandedRecoveryEscalationNotice({
        seed: buildImmediateExecutionPathRecoveryNoticeSeed({ status: "todo" }),
        recoveryActionId: actionId,
        recoveryOwner: null,
        sourceRun: { ...sourceRun, errorCode: "claude_auth_required" },
      }).presentation.title,
    ).toBe("Error: not logged in to Claude");
  });

  it("is matched by the metadata-based escalation dedupe matcher", () => {
    const notice = buildStrandedRecoveryEscalationNotice({
      seed: buildImmediateExecutionPathRecoveryNoticeSeed({ status: "todo" }),
      recoveryActionId: actionId,
      recoveryOwner: owner,
      sourceRun,
    });

    // The escalation dedupe in recovery/service.ts no longer relies on the
    // `Recovery action: \`id\`` body marker for new comments; the metadata
    // matcher must recognize every notice this builder produces.
    expect(notice.body).not.toContain(actionId);
    expect(noticeMetadataReferencesRecoveryAction(notice.metadata, actionId)).toBe(true);
    expect(
      noticeMetadataReferencesRecoveryAction(notice.metadata, "1f2e3d4c-5b6a-4798-8899-444444444444"),
    ).toBe(false);
  });
});


it("names the unavailable AI account instead of suggesting secret bindings", () => {
  const notice = buildConfigurationIncompleteRecoveryNoticeSeed({ reason: "ai_connection_unavailable", provider: "openai" });
  expect(notice.nextAction).toContain("Reconnect the selected AI account");
  expect(notice.title).toBe("AI connection needs attention");
  expect(notice.body).toContain("Reconnect the account");
  expect(notice.body).not.toContain("secret/env");
});
