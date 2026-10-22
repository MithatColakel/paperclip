import type { AgentRunner, AgentRunnerChoice, Environment, EnvironmentProbeResult } from "@paperclipai/shared";
import type { AdapterInfo } from "../api/adapters";

export function needsClaudeSetupQualification(input: {
  adapterType: string;
  runner: AgentRunnerChoice;
  savedAgentId?: string | null;
  environment?: Pick<Environment, "driver" | "config"> | null;
}): boolean {
  const config = input.environment?.config;
  const immutableImage = typeof config?.image === "string" && /^[^\s@]+@sha256:[a-f0-9]{64}$/.test(config.image) && !config.snapshot;
  const daytonaSnapshot = config?.provider === "daytona" && typeof config.snapshot === "string" && !!config.snapshot.trim() && !config.image;
  // Fork: a new Claude agent stays on Legacy unless Paperclip Runner is chosen
  // explicitly (server/src/services/agent-runner-selection.ts), so the platform
  // probe can change the outcome only for that choice. An automatic or Legacy
  // Claude setup never leases a sandbox for it and is never blocked by it.
  return !input.savedAgentId && input.adapterType === "claude_local" && input.runner === "paperclip"
    && input.environment?.driver === "sandbox" && (immutableImage || daytonaSnapshot)
    && !config?.template && !config?.templateRef;
}

export async function qualifyClaudeSetup(input: Parameters<typeof needsClaudeSetupQualification>[0] & {
  readAdapters: () => Promise<AdapterInfo[]>;
  probeEnvironment: () => Promise<EnvironmentProbeResult>;
  isCurrent: () => boolean;
}): Promise<{ runner: AgentRunner; adapters: AdapterInfo[] } | undefined> {
  if (!needsClaudeSetupQualification(input)) return undefined;
  const validate = (adapters: AdapterInfo[]) => {
    const claude = adapters.find(adapter => adapter.type === "claude_local");
    const runner = claude?.defaultRunner;
    if (!claude || (runner !== "paperclip" && runner !== "legacy") || !claude.supportedRunners?.includes(runner)) {
      throw new Error("Could not confirm Claude runner availability for this environment. Retry setup.");
    }
    return claude;
  };
  let adapters = await input.readAdapters();
  if (!input.isCurrent()) return undefined;
  const claude = validate(adapters);
  const native = adapters.find(adapter => adapter.type === "paperclip_runner");
  // Fork: the runner is the explicit Paperclip choice; discovery only tells
  // whether this environment's platform is already qualified for it.
  if (claude.supportedRunners?.includes("paperclip") || claude.disabled || claude.overriddenBuiltin
    || !native || native.disabled || native.overriddenBuiltin) return { runner: "paperclip", adapters };
  const probe = await input.probeEnvironment();
  if (!input.isCurrent()) return undefined;
  if (probe.ok !== true || probe.details?.platformQualificationRecorded !== true
    || typeof probe.details.leaseId !== "string" || !probe.details.leaseId) {
    throw new Error(typeof probe.details?.platformQualificationDiagnostic === "string"
      ? probe.details.platformQualificationDiagnostic
      : probe.summary || "The environment's platform qualification could not be confirmed. Retry the connection probe or select Legacy runner in Advanced.");
  }
  adapters = await input.readAdapters();
  if (!input.isCurrent()) return undefined;
  validate(adapters);
  return { runner: "paperclip", adapters };
}
