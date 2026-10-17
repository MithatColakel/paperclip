import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  environments,
  heartbeatRuns,
  instanceUserRoles,
  plugins,
  resourceWaitEpisodes,
} from "@paperclipai/db";
import {
  PLUGIN_RESERVED_COMPANY_SETTINGS_ROUTE_SEGMENTS,
  RESOURCE_WAIT_LANE_BY_KIND,
  buildResourceWaitContext,
  pluginUiSlotDeclarationSchema,
  type ResourceWaitReason,
} from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createApp } from "../app.js";
import { isSecretSensitiveHttpRequest } from "../middleware/http-log-policy.js";
import { logger } from "../middleware/logger.js";
import { publishGlobalLiveEvent } from "../services/live-events.js";
import { PLUGIN_START_WAIT_REASONS, registerPluginResourceWaitWakes } from "../services/plugin-resource-wait-wakes.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";

// Every lifecycle manager the app builds, with the listeners registered on
// it, so a test can emit a fake lifecycle event on the app's own manager.
const lifecycles = vi.hoisted(() => [] as Array<{ withLoader: boolean; listeners: Map<string, Array<(payload: unknown) => void>> }>);
vi.mock("../services/plugin-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/plugin-lifecycle.js")>();
  const create = ((...args: Parameters<typeof actual.pluginLifecycleManager>) => {
    const manager = actual.pluginLifecycleManager(...args);
    const options = args[1] as { loader?: unknown } | undefined;
    const entry = { withLoader: Boolean(options && typeof options === "object" && "loader" in options && options.loader), listeners: new Map() };
    lifecycles.push(entry);
    const on = manager.on.bind(manager);
    manager.on = ((event: string, listener: (payload: unknown) => void) => {
      entry.listeners.set(event, [...(entry.listeners.get(event) ?? []), listener]);
      on(event as never, listener as never);
    }) as typeof manager.on;
    return manager;
  }) as typeof actual.pluginLifecycleManager;
  return { ...actual, pluginLifecycleManager: create };
});

// The credential store can be made to fail with an error that echoes the
// token, as provider and driver errors sometimes do.
const credentialFaults = vi.hoisted(() => ({ encrypt: null as null | ((value: string) => Promise<Record<string, unknown>>) }));
vi.mock("../services/ai-account-credentials.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/ai-account-credentials.js")>();
  return {
    ...actual,
    encryptCredential: (value: string) => (credentialFaults.encrypt ?? actual.encryptCredential)(value),
  };
});

const tag = () => randomUUID().slice(0, 8);
const subscriptionToken = () => `sk-ant-oat01-${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;

describe("plugin start wakes", () => {
  type LifecycleListener = (payload: { pluginId: string; pluginKey: string }) => void;
  function fakeLifecycle() {
    const emitter = new EventEmitter();
    return {
      on: (event: string, listener: LifecycleListener) => void emitter.on(event, listener),
      off: (event: string, listener: LifecycleListener) => void emitter.off(event, listener),
      emit: (event: string, pluginId: string) => emitter.emit(event, { pluginId, pluginKey: `key.${pluginId}` }),
      count: (event: string) => emitter.listenerCount(event),
    };
  }

  type WakeFilter = { pluginId?: string; reasons?: readonly string[] };
  function fakeHeartbeat(wake: (filter: WakeFilter) => Promise<unknown> = async () => ({ runIds: [], agentIds: [], companyIds: [] })) {
    return { wakeResourceWaitsNow: vi.fn(wake) };
  }

  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  it("wakes the plugin's restarting and upgrade waits once per plugin and tick", async () => {
    const lifecycle = fakeLifecycle();
    const heartbeat = fakeHeartbeat();
    const stop = registerPluginResourceWaitWakes(lifecycle as never, heartbeat as never);
    // A load emits both events back to back.
    lifecycle.emit("plugin.loaded", "plugin-a");
    lifecycle.emit("plugin.enabled", "plugin-a");
    lifecycle.emit("plugin.enabled", "plugin-b");
    await flush();
    expect(heartbeat.wakeResourceWaitsNow.mock.calls).toEqual([
      [{ pluginId: "plugin-a", reasons: ["restarting", "plugin_upgrade_pending"] }],
      [{ pluginId: "plugin-b", reasons: ["restarting", "plugin_upgrade_pending"] }],
    ]);
    // A later event is a new wake.
    lifecycle.emit("plugin.enabled", "plugin-a");
    await flush();
    expect(heartbeat.wakeResourceWaitsNow).toHaveBeenCalledTimes(3);
    expect(PLUGIN_START_WAIT_REASONS).toEqual(["restarting", "plugin_upgrade_pending"]);
    stop();
  });

  it("wakes on the plugin routes' install, enable and upgrade notices, and on nothing else", async () => {
    const lifecycle = fakeLifecycle();
    const heartbeat = fakeHeartbeat();
    const stop = registerPluginResourceWaitWakes(lifecycle as never, heartbeat as never);
    for (const action of ["installed", "enabled", "upgraded", "disabled", "uninstalled"]) {
      publishGlobalLiveEvent({ type: "plugin.ui.updated", payload: { pluginId: `plugin-${action}`, action } });
    }
    publishGlobalLiveEvent({ type: "plugin.worker.crashed", payload: { pluginId: "plugin-crashed" } });
    publishGlobalLiveEvent({ type: "plugin.ui.updated", payload: { action: "enabled" } });
    await flush();
    expect(heartbeat.wakeResourceWaitsNow.mock.calls.map(([filter]) => filter.pluginId)).toEqual([
      "plugin-installed",
      "plugin-enabled",
      "plugin-upgraded",
    ]);
    stop();
  });

  it("skips wakes while disabled, never throws a failed wake, and stops", async () => {
    const lifecycle = fakeLifecycle();
    let enabled = false;
    const failing = fakeHeartbeat(async () => {
      throw new Error("database is gone");
    });
    const warn = vi.spyOn(logger, "warn");
    const stop = registerPluginResourceWaitWakes(lifecycle as never, failing as never, { enabled: () => enabled });
    lifecycle.emit("plugin.enabled", "plugin-a");
    await flush();
    expect(failing.wakeResourceWaitsNow).not.toHaveBeenCalled();
    enabled = true;
    lifecycle.emit("plugin.enabled", "plugin-a");
    await flush();
    expect(failing.wakeResourceWaitsNow).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ pluginId: "plugin-a" }), "failed to wake resource waits after a plugin start");
    warn.mockRestore();

    // An event queued before the stop does not wake either.
    lifecycle.emit("plugin.enabled", "plugin-b");
    stop();
    lifecycle.emit("plugin.loaded", "plugin-c");
    publishGlobalLiveEvent({ type: "plugin.ui.updated", payload: { pluginId: "plugin-d", action: "enabled" } });
    await flush();
    expect(failing.wakeResourceWaitsNow).toHaveBeenCalledTimes(1);
    expect(lifecycle.count("plugin.enabled") + lifecycle.count("plugin.loaded")).toBe(0);
  });
});

describe("the host's Claude account and device settings pages", () => {
  it("cannot be claimed by a plugin's company settings page", () => {
    for (const routePath of ["claude-accounts", "devices"]) {
      expect(PLUGIN_RESERVED_COMPANY_SETTINGS_ROUTE_SEGMENTS).toContain(routePath);
      const parsed = pluginUiSlotDeclarationSchema.safeParse({
        type: "companySettingsPage",
        id: `${routePath}-page`,
        displayName: routePath,
        exportName: "SettingsPage",
        routePath,
      });
      expect(parsed.success, routePath).toBe(false);
      expect(parsed.error?.issues.some((issue) => issue.message.includes("reserved by the host"))).toBe(true);
    }
  });
});

describe("the account pool routes' log policy", () => {
  it("treats the account pool and the retired add-account route as secret-sensitive", () => {
    const id = randomUUID();
    for (const [method, url] of [
      ["POST", "/api/me/ai-accounts"],
      ["POST", "/api/me/ai-accounts?source=paste"],
      ["PATCH", `/api/me/ai-accounts/${id}`],
      ["PUT", `/api/me/ai-accounts/${id}/credential`],
      ["POST", `/api/me/ai-accounts/${id}/clear-limit`],
      ["PATCH", `/api/instance/ai-accounts/${id}`],
      ["POST", `/api/instance/ai-accounts/${id}/clear-limit`],
      ["POST", "/api/instance/ai-accounts/migration/run"],
      ["POST", `/api/instance/ai-hosts/${id}/accounts`],
      // Routes match without case, and so does the policy.
      ["POST", "/API/ME/AI-ACCOUNTS"],
      ["put", `/Api/Me/Ai-Accounts/${id}/Credential`],
      ["POST", `/api/INSTANCE/ai-hosts/${id}/accounts/`],
    ] as const) {
      expect(isSecretSensitiveHttpRequest(method, url), `${method} ${url}`).toBe(true);
    }
  });

  it("leaves reads, deletes and neighbouring routes alone", () => {
    const id = randomUUID();
    for (const [method, url] of [
      ["GET", "/api/me/ai-accounts"],
      ["DELETE", `/api/me/ai-accounts/${id}`],
      ["POST", "/api/me/ai-accounts-export"],
      ["POST", "/api/instance/ai-hosts"],
      ["PATCH", `/api/instance/ai-hosts/${id}`],
      ["PUT", `/api/instance/ai-hosts/${id}/environments`],
      ["PUT", `/api/agents/${id}/ai-account`],
      ["PATCH", `/api/instance/devices/${id}`],
      ["POST", `/api/companies/${id}/ai-accounts`],
    ] as const) {
      expect(isSecretSensitiveHttpRequest(method, url), `${method} ${url}`).toBe(false);
    }
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping embedded Postgres app account pool tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

describeEmbeddedPostgres("the app's account pool, device and wait wiring", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let app!: Awaited<ReturnType<typeof createApp>>;
  // Requests reach the app on 127.0.0.1, a hostname the private hostname guard allows.
  let server: Server | undefined;
  let root: string | null = null;
  const signedIn = new Map<string, { id: string; name: string; email: string }>();
  const logLines: string[] = [];
  let restoreLogStream: (() => void) | null = null;

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "b".repeat(64));
    // Woken waits are made due, but no run starts: there is no agent to run.
    vi.stubEnv("PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS", "true");
    root = await mkdtemp(path.join(process.env.PAPERCLIP_HOME ?? os.tmpdir(), "app-ai-account-pool-"));
    database = await startEmbeddedPostgresTestDatabase("paperclip-app-ai-account-pool-");
    db = createDb(database.connectionString);
    app = await createApp(db, {
      uiMode: "none",
      serverPort: 0,
      storageService: createStorageService(createLocalDiskStorageProvider(path.join(root, "storage"))),
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      allowedHostnames: ["127.0.0.1"],
      bindHost: "127.0.0.1",
      authReady: true,
      companyDeletionEnabled: false,
      instanceId: `app-ai-account-pool-${tag()}`,
      localPluginDir: path.join(root, "plugins"),
      managedPluginAutoInstall: [],
      decisionServiceOptions: { wakeOriginAgent: async () => undefined },
      resolveSession: async (req) => {
        const user = signedIn.get(req.header("x-test-user") ?? "");
        return user ? { session: { id: `session-${user.id}`, userId: user.id }, user } : null;
      },
    });
    await app.locals.bundledPluginsStartup;
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    // Every server log line (any level, any child logger) passes this stream.
    const stream = (logger as unknown as Record<symbol, { write: (chunk: string) => unknown }>)[pino.symbols.streamSym]!;
    const write = stream.write;
    stream.write = function capture(this: unknown, chunk: string) {
      logLines.push(String(chunk));
      return write.call(this, chunk);
    };
    restoreLogStream = () => {
      stream.write = write;
    };
  }, 120_000);

  afterAll(async () => {
    restoreLogStream?.();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await app?.locals.paperclipShutdown?.();
    await database?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function company(name = `Company ${tag()}`) {
    const id = randomUUID();
    await db.insert(companies).values({ id, name, issuePrefix: `A${id.replaceAll("-", "").slice(0, 7).toUpperCase()}` });
    return id;
  }

  /** A signed-in board user with active memberships. */
  async function person(memberships: Array<[companyId: string, role: string]>, opts: { instanceAdmin?: boolean } = {}) {
    const id = `user-${tag()}`;
    const at = new Date();
    const user = { id, name: `User ${id}`, email: `${id}@example.com` };
    await db.insert(authUsers).values({ ...user, emailVerified: true, createdAt: at, updatedAt: at });
    for (const [companyId, membershipRole] of memberships) {
      await db.insert(companyMemberships).values({ companyId, principalId: id, principalType: "user", status: "active", membershipRole });
    }
    if (opts.instanceAdmin) await db.insert(instanceUserRoles).values({ userId: id, role: "instance_admin" });
    signedIn.set(id, user);
    return id;
  }

  async function claudeAgent(companyId: string) {
    const [row] = await db.insert(agents).values({
      companyId,
      name: `Agent ${tag()}`,
      adapterType: "claude_local",
      status: "active",
      runtimeConfig: { heartbeat: { enabled: false } },
    }).returning();
    return row!;
  }

  /** An agent API key for a new Claude agent of the company, acting for a member. */
  async function agentKey(companyId: string, responsibleUserId: string) {
    const agent = await claudeAgent(companyId);
    const token = `pcp_test_${randomUUID().replaceAll("-", "")}`;
    await db.insert(agentApiKeys).values({
      agentId: agent.id,
      companyId,
      name: "test",
      keyHash: createHash("sha256").update(token).digest("hex"),
      responsibleUserId,
    });
    return { agent, token };
  }

  /** A board session request; mutations carry a trusted browser origin. */
  function as(userId: string, test: request.Test) {
    return test.set("x-test-user", userId).set("Origin", "http://localhost:3100");
  }

  async function addAccount(ownerId: string, value = subscriptionToken()) {
    const response = await as(ownerId, request(server!).post("/api/me/ai-accounts"))
      .send({ label: `Max ${tag()}`, credentialType: "subscription", value });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return { id: response.body.id as string, value };
  }

  it("serves PATCH /api/instance/ai-accounts/:id from the account pool router", async () => {
    const companyId = await company();
    const owner = await person([[companyId, "operator"]]);
    const admin = await person([[companyId, "owner"]], { instanceAdmin: true });
    const account = await addAccount(owner);

    const disabled = await as(admin, request(server!).patch(`/api/instance/ai-accounts/${account.id}`))
      .send({ adminDisabled: true, reason: "Checking the subscription" });
    expect(disabled.status, JSON.stringify(disabled.body)).toBe(200);
    expect(disabled.body).toMatchObject({
      id: account.id,
      adminDisabled: true,
      adminDisabledReason: "Checking the subscription",
      state: "admin_disabled",
      owner: { userId: owner },
    });
    const [entry] = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.action, "ai_account.admin_disabled"),
      eq(activityLog.entityId, account.id),
    ));
    expect(entry).toMatchObject({ actorId: admin, entityType: "ai_account" });

    // Its strict schema answers; the legacy account fields are gone.
    const legacy = await as(admin, request(server!).patch(`/api/instance/ai-accounts/${account.id}`)).send({ label: "Renamed" });
    expect(legacy.status).toBe(400);
    // Only instance admins reach it.
    const member = await as(owner, request(server!).patch(`/api/instance/ai-accounts/${account.id}`)).send({ adminDisabled: false });
    expect(member.status).toBe(403);
    const missing = await as(admin, request(server!).patch(`/api/instance/ai-accounts/${randomUUID()}`)).send({ adminDisabled: true });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("Claude account not found");

    expect(JSON.stringify([disabled.body, legacy.body, member.body])).not.toContain(account.value);
  });

  it("answers 410 on the retired account routes, without echoing a posted token", async () => {
    const companyId = await company();
    const admin = await person([[companyId, "owner"]], { instanceAdmin: true });
    const token = subscriptionToken();
    const moved = await as(admin, request(server!).post(`/api/instance/ai-hosts/${randomUUID()}/accounts`))
      .send({ label: "Old client", credentialType: "subscription", value: token });
    expect(moved.status).toBe(410);
    expect(moved.body).toMatchObject({
      code: "ai_account_route_moved",
      details: { code: "ai_account_route_moved", replacements: ["POST /api/me/ai-accounts", "PUT /api/agents/{agentId}/ai-account"] },
    });
    // Any caller gets the same answer.
    const anonymous = await request(server!).post(`/api/instance/ai-hosts/${randomUUID()}/accounts`)
      .send({ label: "Old client", credentialType: "subscription", value: token });
    expect(anonymous.status).toBe(410);
    // The pool router has no project route, so the legacy router still answers it.
    const projects = await as(admin, request(server!).put(`/api/instance/ai-accounts/${randomUUID()}/projects`)).send({ projectIds: [] });
    expect(projects.status).toBe(410);
    expect(projects.body.details.replacements).toEqual(["PATCH /api/me/ai-accounts/{accountId}"]);

    expect(JSON.stringify([moved.body, anonymous.body])).not.toContain(token);
    await vi.waitFor(() => expect(logLines.some((line) => line.includes("/accounts") && line.includes("410"))).toBe(true));
    expect(logLines.filter((line) => line.includes(token))).toEqual([]);
  });

  it("keeps a token echoed by a failed account add out of the response and the log", async () => {
    const companyId = await company();
    const owner = await person([[companyId, "operator"]]);
    const token = subscriptionToken();
    credentialFaults.encrypt = async (value) => {
      throw new Error(`could not store ${value}`);
    };
    try {
      const failed = await as(owner, request(server!).post("/api/me/ai-accounts")).send({ label: "Echo", credentialType: "subscription", value: token });
      expect(failed.status).toBe(500);
      expect(failed.body).toEqual({ error: "Internal server error" });
    } finally {
      credentialFaults.encrypt = null;
    }
    await vi.waitFor(() => expect(logLines.some((line) => /POST \S*\/me\/ai-accounts 500 — request failed/.test(line))).toBe(true));
    expect(logLines.filter((line) => line.includes(token) || line.includes("could not store"))).toEqual([]);
  });

  it("refuses agents on the board routes and lets an agent read its own binding", async () => {
    const companyId = await company();
    const member = await person([[companyId, "operator"]]);
    const { agent, token } = await agentKey(companyId, member);
    const bearer = { Authorization: `Bearer ${token}` };

    // The routes themselves refuse the agent: the key itself is valid.
    const boardOnly = { status: 403, body: { error: "Board access required" } };
    const mine = await request(server!).get("/api/me/ai-accounts").set(bearer);
    expect({ status: mine.status, body: mine.body }).toEqual(boardOnly);
    const added = await request(server!).post("/api/me/ai-accounts").set(bearer)
      .send({ label: "Mine", credentialType: "subscription", value: subscriptionToken() });
    expect({ status: added.status, body: added.body }).toEqual(boardOnly);
    const devices = await request(server!).get(`/api/companies/${companyId}/devices`).set(bearer);
    expect({ status: devices.status, body: devices.body }).toEqual(boardOnly);
    const accounts = await request(server!).get(`/api/companies/${companyId}/ai-accounts`).set(bearer);
    expect({ status: accounts.status, body: accounts.body }).toEqual(boardOnly);
    const bind = await request(server!).put(`/api/agents/${agent.id}/ai-account`).set(bearer).send({ mode: "device_login" });
    expect(bind.status).toBe(403);
    expect(bind.body.code).toBe("ai_account_binding_forbidden");
    const own = await request(server!).get(`/api/agents/${agent.id}/ai-account`).set(bearer);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body).toMatchObject({ agentId: agent.id, options: [], canBindAny: false });

    // The same routes answer a member of the company.
    const listed = await as(member, request(server!).get("/api/me/ai-accounts"));
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({ accounts: [] });
    const memberDevices = await as(member, request(server!).get(`/api/companies/${companyId}/devices`));
    expect(memberDevices.status).toBe(200);
    expect(memberDevices.body).toMatchObject({ limitPerDevice: 3, devices: expect.any(Array) });
    expect((await as(member, request(server!).get(`/api/companies/${companyId}/execution-wait-settings`))).body).toMatchObject({ companyId });
    expect((await as(member, request(server!).get("/api/instance/ai-accounts/migration"))).status).toBe(403);
  });

  it("mounts the binding backfill report and the instance device list for instance admins", async () => {
    const companyId = await company();
    const admin = await person([[companyId, "owner"]], { instanceAdmin: true });
    const report = await as(admin, request(server!).get("/api/instance/ai-accounts/migration"));
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    expect(report.body).toMatchObject({ key: "ai-account-bindings-v1", goNoGo: { go: expect.any(Boolean), agents: expect.any(Array) } });
    const devices = await as(admin, request(server!).get("/api/instance/devices"));
    expect(devices.status).toBe(200);
    expect(devices.body).toMatchObject({ limitPerDevice: 3, devices: expect.any(Array) });
  });

  describe("plugin start wakes in the app", () => {
    async function sandboxPlugin(provider: string) {
      const pluginKey = `test.${provider}`;
      const [row] = await db.insert(plugins).values({
        pluginKey,
        packageName: pluginKey,
        version: "1.0.0",
        status: "ready",
        manifestJson: {
          id: pluginKey,
          displayName: `Plugin ${provider}`,
          environmentDrivers: [{ driverKey: provider, kind: "sandbox_provider", displayName: provider }],
        } as never,
      }).returning();
      const [environment] = await db.insert(environments).values({ name: `Sandbox ${provider}`, driver: "sandbox", config: { provider } }).returning();
      return { plugin: row!, environment: environment! };
    }

    /** A waiting run of a new agent on the environment, due in an hour, with its open episode. */
    async function waitOn(companyId: string, environmentId: string, reason: ResourceWaitReason) {
      const agent = await claudeAgent(companyId);
      const lane = RESOURCE_WAIT_LANE_BY_KIND.environment;
      const dueAt = new Date(Date.now() + 3_600_000);
      const [run] = await db.insert(heartbeatRuns).values({
        companyId,
        agentId: agent.id,
        invocationSource: "automation",
        status: "scheduled_retry",
        scheduledRetryReason: lane,
        scheduledRetryAt: dueAt,
        scheduledRetryAttempt: 1,
        contextSnapshot: { retryReason: lane },
      }).returning();
      const [episode] = await db.insert(resourceWaitEpisodes).values({
        companyId,
        agentId: agent.id,
        kind: "environment",
        reason,
        scope: "admission",
        resourceKey: `environment:${environmentId}`,
        environmentId,
        since: new Date(),
        currentRunId: run!.id,
      }).returning();
      const resourceWait = buildResourceWaitContext({
        episodeId: episode!.id,
        kind: "environment",
        reason,
        scope: "admission",
        environmentId,
        environmentName: null,
        deviceId: null,
        deviceName: null,
        accountId: null,
        accountLabel: null,
        resumeAt: null,
        resumeAtSource: null,
        message: null,
      });
      await db.update(heartbeatRuns).set({ contextSnapshot: { retryReason: lane, resourceWait } }).where(eq(heartbeatRuns.id, run!.id));
      return { runId: run!.id, dueAt };
    }

    async function dueAt(runId: string) {
      const [row] = await db.select({ scheduledRetryAt: heartbeatRuns.scheduledRetryAt }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      return row!.scheduledRetryAt!.getTime();
    }

    async function waitWorld() {
      const companyId = await company();
      const { plugin, environment } = await sandboxPlugin(`sandbox-${tag()}`);
      const other = await sandboxPlugin(`sandbox-${tag()}`);
      return {
        plugin,
        restarting: await waitOn(companyId, environment.id, "restarting"),
        upgrading: await waitOn(companyId, environment.id, "plugin_upgrade_pending"),
        offline: await waitOn(companyId, environment.id, "offline"),
        otherPlugin: await waitOn(companyId, other.environment.id, "restarting"),
      };
    }

    async function expectWoken(world: Awaited<ReturnType<typeof waitWorld>>, before: number) {
      await vi.waitFor(async () => {
        expect(await dueAt(world.restarting.runId)).toBeLessThanOrEqual(Date.now());
        expect(await dueAt(world.upgrading.runId)).toBeLessThanOrEqual(Date.now());
      }, { timeout: 10_000, interval: 50 });
      expect(await dueAt(world.restarting.runId)).toBeGreaterThanOrEqual(before);
      // Another reason, or another plugin's environment, keeps its time.
      expect(await dueAt(world.offline.runId)).toBe(world.offline.dueAt.getTime());
      expect(await dueAt(world.otherPlugin.runId)).toBe(world.otherPlugin.dueAt.getTime());
    }

    it("wakes the plugin's restarting and upgrade waits on a fake plugin.enabled event", async () => {
      const world = await waitWorld();
      const appLifecycles = lifecycles.filter((entry) => !entry.withLoader);
      expect(appLifecycles).toHaveLength(1);
      const listeners = appLifecycles[0]!.listeners.get("plugin.enabled") ?? [];
      expect(listeners.length).toBeGreaterThan(0);
      const before = Date.now();
      for (const listener of listeners) listener({ pluginId: world.plugin.id, pluginKey: world.plugin.pluginKey });
      await expectWoken(world, before - 1);
    });

    it("wakes them when the plugin routes enable the plugin", async () => {
      const world = await waitWorld();
      const before = Date.now();
      // What POST /api/plugins/:pluginId/enable publishes after its own lifecycle enabled the plugin.
      publishGlobalLiveEvent({ type: "plugin.ui.updated", payload: { pluginId: world.plugin.id, action: "enabled" } });
      await expectWoken(world, before - 1);
    });
  });
});
