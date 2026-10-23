/**
 * Unloading or disabling a plugin whose worker is not running right now.
 *
 * A fail-closed retirement leaves the worker handle in crash-recovery backoff
 * (or `crashed`, when it is not restarted). The loader used to stop the worker
 * only when it was running, so such a handle survived the unload: its backoff
 * timer brought the worker back after the plugin was unloaded or disabled, and
 * the next load failed with "Worker already registered".
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  list: vi.fn(),
  listInstalled: vi.fn(),
  listByStatus: vi.fn(),
  update: vi.fn(),
  updateStatus: vi.fn(),
  upsertConfig: vi.fn(),
  getConfig: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import { pluginLoader, type PluginRuntimeServices } from "../services/plugin-loader.js";
import {
  createPluginWorkerManager,
  type PluginWorkerHandle,
  type PluginWorkerManager,
  type WorkerStartOptions,
} from "../services/plugin-worker-manager.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const DUPLEX_CHANNEL_WORKER_ENTRYPOINT = path.join(FIXTURES_DIR, "plugin-worker-duplex-channel.cjs");

const PLUGIN_ID = "plugin-1";
const PLUGIN_KEY = "test.plugin";

const TEST_MANIFEST: PaperclipPluginManifestV1 = {
  id: PLUGIN_KEY,
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test plugin",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [],
  entrypoints: { worker: "dist/worker.js" },
};

const WORKER_OPTIONS: WorkerStartOptions = {
  entrypointPath: DUPLEX_CHANNEL_WORKER_ENTRYPOINT,
  manifest: TEST_MANIFEST,
  config: {},
  instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
  apiVersion: 1,
  hostHandlers: {},
  duplexChannelLimits: { closeTimeoutMs: 200 },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function duplexOpenInput(directive: unknown) {
  return {
    driverKey: "sandbox",
    companyId: "company-1",
    environmentId: "env-1",
    providerLeaseId: JSON.stringify(directive),
    command: ["bridge-callback"],
  };
}

async function retire(handle: PluginWorkerHandle, directive: unknown): Promise<void> {
  const exited = new Promise<void>((resolve) => handle.on("exit", () => resolve()));
  const session = await handle.openDuplexChannel(duplexOpenInput(directive));
  await session.close();
  await exited;
}

function createLoader(workerManager: PluginWorkerManager) {
  const runtimeServices = {
    workerManager,
    eventBus: { clearPlugin: vi.fn() },
    jobScheduler: { unregisterPlugin: vi.fn(async () => undefined) },
    jobStore: {},
    toolDispatcher: { unregisterPluginTools: vi.fn() },
    lifecycleManager: {},
    buildHostHandlers: vi.fn(() => ({})),
    instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
  } as unknown as PluginRuntimeServices;
  return pluginLoader(
    {} as unknown as Db,
    { localPluginDir: "/nonexistent/local-plugins", enableLocalFilesystem: false, enableNpmDiscovery: false },
    runtimeServices,
  );
}

describe("plugin loader unload of a worker that is not running", () => {
  let manager: PluginWorkerManager | null = null;

  afterEach(async () => {
    await manager?.stopAll();
    manager = null;
    vi.clearAllMocks();
  });

  it("stops a worker in restart backoff for good, and a later load starts a fresh one", async () => {
    manager = createPluginWorkerManager();
    const handle = await manager.startWorker(PLUGIN_ID, WORKER_OPTIONS);
    await retire(handle, { closeMode: "bad-ack" });
    expect(handle.status).toBe("backoff");

    await createLoader(manager).unloadSingle(PLUGIN_ID, PLUGIN_KEY);

    expect(manager.getWorker(PLUGIN_ID)).toBeUndefined();
    expect(handle.status).toBe("stopped");
    // The backoff timer would have restarted the worker by now.
    await sleep(2_000);
    expect(handle.status).toBe("stopped");
    expect(handle.diagnostics().pid).toBeNull();

    const fresh = await manager.startWorker(PLUGIN_ID, WORKER_OPTIONS);
    expect(fresh).not.toBe(handle);
    expect(fresh.status).toBe("running");
  }, 15_000);

  it("removes a worker left crashed by an ownership violation, so a later load starts a fresh one", async () => {
    manager = createPluginWorkerManager();
    const handle = await manager.startWorker(PLUGIN_ID, WORKER_OPTIONS);
    await retire(handle, { workerSessionId: "ws-A", data: [{ chunk: "forged", sid: "ws-EVIL" }] });
    expect(handle.status).toBe("crashed");

    await createLoader(manager).unloadSingle(PLUGIN_ID, PLUGIN_KEY);

    expect(manager.getWorker(PLUGIN_ID)).toBeUndefined();
    const fresh = await manager.startWorker(PLUGIN_ID, WORKER_OPTIONS);
    expect(fresh.status).toBe("running");
  }, 15_000);

  it("keeps the worker stopped when the plugin is disabled during the restart backoff", async () => {
    manager = createPluginWorkerManager();
    const handle = await manager.startWorker(PLUGIN_ID, WORKER_OPTIONS);
    await retire(handle, { closeMode: "bad-ack" });
    expect(handle.status).toBe("backoff");

    const pluginRecord = {
      id: PLUGIN_ID,
      pluginKey: PLUGIN_KEY,
      status: "ready",
      manifestJson: TEST_MANIFEST,
    };
    mockRegistry.getById.mockResolvedValue(pluginRecord);
    mockRegistry.updateStatus.mockResolvedValue({ ...pluginRecord, status: "disabled" });
    const lifecycle = pluginLifecycleManager(
      {} as never,
      { loader: createLoader(manager), workerManager: manager },
    );

    await lifecycle.disable(PLUGIN_ID);

    expect(manager.getWorker(PLUGIN_ID)).toBeUndefined();
    await sleep(2_000);
    expect(handle.status).toBe("stopped");
    expect(handle.diagnostics().pid).toBeNull();
  }, 15_000);
});
