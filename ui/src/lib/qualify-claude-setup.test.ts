import { describe, expect, it, vi } from "vitest";
import type { AdapterInfo } from "../api/adapters";
import { qualifyClaudeSetup } from "./qualify-claude-setup";

const image = `registry.example.test/runtime@sha256:${"a".repeat(64)}`;
// Fork: Claude's default runner stays Legacy on every target; a qualified
// platform only adds Paperclip Runner to the runners it supports.
const discovery = (qualified: boolean, overrides = {}) => [
  { type: "claude_local", defaultRunner: "legacy", supportedRunners: qualified ? ["paperclip", "legacy"] : ["legacy"], ...overrides },
  { type: "paperclip_runner" },
] as AdapterInfo[];
function setup() {
  return {
    adapterType: "claude_local", runner: "paperclip" as const,
    environment: { driver: "sandbox" as const, config: { provider: "daytona", image } },
    readAdapters: vi.fn().mockResolvedValueOnce(discovery(false)).mockResolvedValue(discovery(true)),
    probeEnvironment: vi.fn().mockResolvedValue({ ok: true, driver: "sandbox", summary: "Measured image",
      details: { platformQualificationRecorded: true, leaseId: "owned-probe-lease" } }),
    isCurrent: vi.fn(() => true),
  };
}

describe("Claude explicit setup qualification", () => {
  it("qualifies a named Daytona snapshot through the normal Connect action", async () => {
    const s = setup();
    const input: Parameters<typeof qualifyClaudeSetup>[0] = { ...s, environment: { driver: "sandbox", config: { provider: "daytona", snapshot: "managed-snapshot" } } };
    expect((await qualifyClaudeSetup(input))?.runner).toBe("paperclip");
    expect(s.probeEnvironment).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("qualifies the platform for an explicit Paperclip Runner choice and returns fresh discovery (qualified=%s)", async qualified => {
    const s = setup();
    s.readAdapters.mockReset().mockResolvedValueOnce(discovery(false)).mockResolvedValue(discovery(qualified));
    const result = await qualifyClaudeSetup(s);
    // The explicit choice stands; whether the platform supports it is the server's decision on the next step.
    expect(result?.runner).toBe("paperclip");
    expect(result?.adapters.find(adapter => adapter.type === "claude_local")?.supportedRunners).toEqual(qualified ? ["paperclip", "legacy"] : ["legacy"]);
    expect(s.readAdapters).toHaveBeenCalledTimes(2);
    expect(s.probeEnvironment).toHaveBeenCalledTimes(1);
    expect(s.readAdapters.mock.invocationCallOrder[0]).toBeLessThan(s.probeEnvironment.mock.invocationCallOrder[0]);
    expect(s.probeEnvironment.mock.invocationCallOrder[0]).toBeLessThan(s.readAdapters.mock.invocationCallOrder[1]);
  });

  it.each(["permission", "cleanup", "missing-lease", "connection", "discovery"])("stops before adapter setup after %s failure", async failure => {
    const s = setup();
    if (failure === "permission") s.probeEnvironment.mockRejectedValue(new Error("Instance admin access required"));
    else if (failure === "discovery") s.readAdapters.mockRejectedValue(new Error("Discovery unavailable"));
    else s.probeEnvironment.mockResolvedValue({ ok: failure !== "connection", summary: "Qualification rejected",
      details: { platformQualificationRecorded: failure !== "cleanup", ...(failure === "missing-lease" ? {} : { leaseId: "lease" }) } });
    await expect(qualifyClaudeSetup(s)).rejects.toThrow(failure === "permission" ? "Instance admin" : failure === "discovery" ? "Discovery" : "Qualification rejected");
  });

  // Fork: a Claude agent that is not explicitly on Paperclip Runner stays on
  // Legacy, so a probe could not change its runner: none is leased, and a
  // probe or discovery failure cannot block its setup.
  it.each(["auto", "legacy"] as const)("never leases a sandbox for, or blocks, a %s Claude setup", async runner => {
    const s = setup();
    s.readAdapters.mockReset().mockRejectedValue(new Error("Discovery unavailable"));
    s.probeEnvironment.mockReset().mockRejectedValue(new Error("Instance admin access required"));
    expect(await qualifyClaudeSetup({ ...s, runner })).toBeUndefined();
    expect(s.readAdapters).not.toHaveBeenCalled();
    expect(s.probeEnvironment).not.toHaveBeenCalled();
  });

  it.each(["auto", "legacy", "local", "snapshot", "tag", "saved", "codex", "qualified", "disabled", "override", "missing-native"])("does not allocate an extra probe for %s", async mode => {
    const s = setup();
    const input: Parameters<typeof qualifyClaudeSetup>[0] = s;
    if (mode === "auto" || mode === "legacy") input.runner = mode;
    if (mode === "local") input.environment = { driver: "local", config: {} };
    if (mode === "snapshot") input.environment = { driver: "sandbox", config: { image, snapshot: "named-snapshot" } };
    if (mode === "tag") input.environment = { driver: "sandbox", config: { image: "registry.example.test/runtime:latest" } };
    if (mode === "saved") input.savedAgentId = "saved-agent";
    if (mode === "codex") input.adapterType = "codex_local";
    if (mode === "qualified") s.readAdapters.mockReset().mockResolvedValue(discovery(true));
    if (mode === "disabled" || mode === "override") s.readAdapters.mockReset().mockResolvedValue(discovery(false, mode === "disabled" ? { disabled: true } : { overriddenBuiltin: true }));
    if (mode === "missing-native") s.readAdapters.mockReset().mockResolvedValue(discovery(false).slice(0, 1));
    await qualifyClaudeSetup(input);
    expect(s.probeEnvironment).not.toHaveBeenCalled();
  });

  it("abandons a stale selection before probing and after probing", async () => {
    const before = setup(); before.isCurrent.mockReturnValue(false);
    expect(await qualifyClaudeSetup(before)).toBeUndefined();
    expect(before.probeEnvironment).not.toHaveBeenCalled();
    const after = setup(); after.isCurrent.mockReturnValueOnce(true).mockReturnValue(false);
    expect(await qualifyClaudeSetup(after)).toBeUndefined();
    expect(after.probeEnvironment).toHaveBeenCalledTimes(1);
    expect(after.readAdapters).toHaveBeenCalledTimes(1);
  });
});
