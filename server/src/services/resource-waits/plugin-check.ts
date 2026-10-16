import type { Db } from "@paperclipai/db";
import {
  ENVIRONMENT_PROJECT_ID_FEATURE,
  readEnvironmentAvailabilityResult,
  type PluginEnvironmentAvailability,
} from "@paperclipai/plugin-sdk";
import { resolveEnvironmentDriverConfigForRuntime, stripSandboxProviderEnvelope } from "../environment-config.js";
import { soleProviderPlugin } from "../execution-devices.js";
import type { PluginWorkerManager } from "../plugin-worker-manager.js";
import { RESOURCE_WAIT_TIMINGS } from "./types.js";

/**
 * Fork: the sweep's target-level availability check of a plugin sandbox
 * environment (spec 7.4 step 1, 9.3). It calls the optional
 * `environmentCheckAvailability` method of the provider's only installed
 * plugin, with a 10 s timeout. It never falls back to the plugin's probe,
 * which may run work on the device: without the method, without a running
 * worker, on a timeout or an error, the answer is `unknown`.
 */

export type TargetCheckDetail = "checked" | "no_plugin" | "not_running" | "unsupported" | "config_error" | "timeout" | "error";

export interface TargetAvailabilityCheck {
  availability: PluginEnvironmentAvailability;
  detail: TargetCheckDetail;
  pluginId: string | null;
}

const CHECK_METHOD = "environmentCheckAvailability";

class CheckTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CheckTimeoutError("availability check timed out")), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function checkTargetAvailability(input: {
  db: Db;
  pluginWorkerManager: PluginWorkerManager | null | undefined;
  environment: { id: string; driver: string; config: Record<string, unknown> | null | undefined };
  /** The company whose waiting run the check serves; the plugin call is scoped to it. */
  companyId: string;
  agentId?: string | null;
  timeoutMs?: number;
  now?: Date;
}): Promise<TargetAvailabilityCheck> {
  const unknown = (detail: TargetCheckDetail, pluginId: string | null = null): TargetAvailabilityCheck =>
    ({ availability: { state: "unknown" }, detail, pluginId });
  const provider = typeof input.environment.config?.provider === "string" ? input.environment.config.provider : null;
  if (input.environment.driver !== "sandbox" || !provider) return unknown("no_plugin");
  const plugin = await soleProviderPlugin(input.db, provider);
  if (!plugin) return unknown("no_plugin");
  const manager = input.pluginWorkerManager;
  if (!manager || !manager.isRunning(plugin.id)) return unknown("not_running", plugin.id);
  const supportedMethods = manager.getWorker(plugin.id)?.supportedMethods ?? [];
  if (!supportedMethods.includes(CHECK_METHOD)) return unknown("unsupported", plugin.id);

  let config: Record<string, unknown>;
  try {
    const parsed = await resolveEnvironmentDriverConfigForRuntime(input.db, input.companyId, {
      id: input.environment.id,
      driver: input.environment.driver,
      config: input.environment.config ?? {},
    });
    if (parsed.driver !== "sandbox") return unknown("config_error", plugin.id);
    config = stripSandboxProviderEnvelope(parsed.config);
  } catch {
    return unknown("config_error", plugin.id);
  }

  const timeoutMs = input.timeoutMs ?? RESOURCE_WAIT_TIMINGS.pluginCheckTimeoutMs;
  try {
    const result = await withTimeout(manager.call(plugin.id, CHECK_METHOD, {
      driverKey: provider,
      companyId: input.companyId,
      environmentId: input.environment.id,
      issueId: null,
      // Negotiated (spec 9.2): only workers that opted in receive the key.
      ...(supportedMethods.includes(ENVIRONMENT_PROJECT_ID_FEATURE) ? { projectId: null } : {}),
      config,
      agentId: input.agentId ?? null,
    }, timeoutMs), timeoutMs + 500);
    return { availability: readEnvironmentAvailabilityResult(result, input.now ?? new Date()), detail: "checked", pluginId: plugin.id };
  } catch (error) {
    return unknown(error instanceof CheckTimeoutError ? "timeout" : "error", plugin.id);
  }
}
