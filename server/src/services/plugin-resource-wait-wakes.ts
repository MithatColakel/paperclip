import type { LiveEvent, ResourceWaitReason } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import type { heartbeatService } from "./heartbeat.js";
import { subscribeGlobalLiveEvents } from "./live-events.js";
import type { PluginLifecycleManager } from "./plugin-lifecycle.js";

/**
 * Fork: the plugin resume trigger of the resource waits (spec 7.5). A run
 * whose sandbox provider plugin had no running worker (`restarting`) or was
 * waiting for an upgrade (`plugin_upgrade_pending`) waits for that plugin.
 * When the plugin is enabled or loaded, those waits on its providers'
 * environments are woken; the hold still re-checks each one before it runs.
 */
export const PLUGIN_START_WAIT_REASONS = ["restarting", "plugin_upgrade_pending"] as const satisfies readonly ResourceWaitReason[];

/**
 * The plugin routes run their own lifecycle manager, so their transitions
 * never reach the app's. Each one publishes `plugin.ui.updated` afterwards;
 * these actions can bring a plugin's worker back.
 */
const PLUGIN_START_ACTIONS: ReadonlySet<string> = new Set(["installed", "enabled", "upgraded"]);

/** What the wake needs from the heartbeat service: waking (and starting) waits. */
export type PluginResourceWaitWakeHeartbeat = Pick<ReturnType<typeof heartbeatService>, "wakeResourceWaitsNow">;

export interface PluginResourceWaitWakeOptions {
  /** Checked per event; false skips the wake (for example on a warm standby). */
  enabled?: () => boolean;
}

/**
 * Wakes a plugin's start waits on the lifecycle's `plugin.enabled` and
 * `plugin.loaded`, and on the plugin routes' `plugin.ui.updated` for an
 * install, enable or upgrade. A load emits both lifecycle events back to
 * back, so the events of one plugin in the same tick share one wake. A failed
 * wake is logged and never reaches the emitter. Returns the unsubscribe.
 */
export function registerPluginResourceWaitWakes(
  lifecycle: Pick<PluginLifecycleManager, "on" | "off">,
  heartbeat: PluginResourceWaitWakeHeartbeat,
  options: PluginResourceWaitWakeOptions = {},
): () => void {
  const pending = new Set<string>();
  let stopped = false;
  const wake = (pluginId: string) => {
    if (stopped || pending.has(pluginId)) return;
    if (options.enabled && !options.enabled()) return;
    pending.add(pluginId);
    queueMicrotask(() => {
      pending.delete(pluginId);
      if (stopped) return;
      heartbeat
        .wakeResourceWaitsNow({ pluginId, reasons: [...PLUGIN_START_WAIT_REASONS] })
        .catch((err) => logger.warn({ err, pluginId }, "failed to wake resource waits after a plugin start"));
    });
  };
  const onLifecycle = ({ pluginId }: { pluginId: string }) => wake(pluginId);
  const onLiveEvent = (event: LiveEvent) => {
    if (event.type !== "plugin.ui.updated") return;
    const { pluginId, action } = event.payload as { pluginId?: unknown; action?: unknown };
    if (typeof pluginId === "string" && typeof action === "string" && PLUGIN_START_ACTIONS.has(action)) wake(pluginId);
  };
  lifecycle.on("plugin.enabled", onLifecycle);
  lifecycle.on("plugin.loaded", onLifecycle);
  const unsubscribeLiveEvents = subscribeGlobalLiveEvents(onLiveEvent);
  return () => {
    stopped = true;
    lifecycle.off("plugin.enabled", onLifecycle);
    lifecycle.off("plugin.loaded", onLifecycle);
    unsubscribeLiveEvents();
  };
}
