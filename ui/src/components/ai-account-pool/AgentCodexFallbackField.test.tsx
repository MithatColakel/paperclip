import { describe, expect, it } from "vitest";
import type { AgentCodexFallbackView } from "@paperclipai/shared";
import { codexFallbackStatusText } from "./AgentCodexFallbackField";

const now = new Date("2026-11-20T10:00:00");

function view(overrides: Partial<AgentCodexFallbackView> = {}): AgentCodexFallbackView {
  return {
    agentId: "agent-1",
    enabled: true,
    model: null,
    modelReasoningEffort: null,
    canChange: true,
    unsupportedReason: null,
    environment: { id: "env-1", name: "Mac: Test device" },
    active: false,
    claudeUntil: null,
    codexBlockedUntil: null,
    codexBlockReason: null,
    ...overrides,
  };
}

describe("codexFallbackStatusText", () => {
  it("says what happens next for each state", () => {
    expect(codexFallbackStatusText(view({ enabled: false }), now)).toMatch(/^Off:/);
    expect(codexFallbackStatusText(view(), now)).toBe(
      "On: if Claude reaches its usage limit, this agent's tasks run on Codex on Mac: Test device until the reset.",
    );
    expect(codexFallbackStatusText(view({ active: true, claudeUntil: "2026-11-20T18:00:00" }), now))
      .toBe("Claude is at its usage limit until 18:00; this agent's tasks run on Codex on Mac: Test device meanwhile.");
    expect(codexFallbackStatusText(view({ codexBlockedUntil: "2026-11-20T11:00:00", codexBlockReason: "codex_limit" }), now))
      .toContain("at its own usage limit until 11:00");
    expect(codexFallbackStatusText(view({ codexBlockedUntil: "2026-11-20T11:00:00", codexBlockReason: "codex_failed" }), now))
      .toContain("Check that Codex is installed and signed in");
    expect(codexFallbackStatusText(view({ unsupportedReason: "no_device_environment", environment: null }), now))
      .toContain("device (Mac Fleet)");
    expect(codexFallbackStatusText(view({ unsupportedReason: "adapter" }), now)).toBe("Only a Claude agent can fall back to Codex.");
  });
});
