import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { SnapshotCache, buildSnapshot, loadTaskVersion, parseSnapshotParams } from "./snapshot.ts";

export const DATA_KEYS = {
  snapshot: "roadmap.snapshot",
  taskVersion: "roadmap.taskVersion",
} as const;

const plugin = definePlugin({
  async setup(ctx) {
    const cache = new SnapshotCache();

    ctx.data.register(DATA_KEYS.snapshot, async (params) => {
      const request = parseSnapshotParams(params);
      return cache.get(request, async () => {
        const snapshot = await buildSnapshot(ctx, request);
        ctx.logger.debug("roadmap snapshot built", {
          companyId: request.companyId,
          projectId: request.projectId,
          tasks: snapshot.stats.tasksScanned,
          buildMs: snapshot.stats.buildMs,
          truncated: snapshot.truncatedStatuses.join(","),
        });
        return snapshot;
      });
    });

    ctx.data.register(DATA_KEYS.taskVersion, async (params) => loadTaskVersion(ctx, params));
  },

  async onHealth() {
    return { status: "ok", message: "Roadmap worker is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
