import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  aiAccountAgentBindings,
  aiAccountHosts,
  aiAccounts,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  environmentAvailability,
  environments,
  heartbeatRuns,
  instanceUserRoles,
  plugins,
  resourceWaitEpisodes,
} from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  RESOURCE_WAIT_LANE_BY_KIND,
  buildResourceWaitContext,
  type ResourceWaitKind,
  type ResourceWaitReason,
  type ResourceWaitScope,
} from "@paperclipai/shared";
import {
  PLUGIN_RPC_ERROR_CODES,
  createHostClientHandlers,
  type HostServices,
  type HostToWorkerMethods,
  type PluginEnvironmentTargetReport,
  type WorkerHostCallContext,
} from "@paperclipai/plugin-sdk";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { AI_ACCOUNT_POOL_SYSTEM_ACTOR_ID } from "../services/ai-account-pool.js";
import { environmentsMatchingTarget, pluginTargetKey, upsertPluginTargetByTargetKey } from "../services/execution-devices.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import {
  canonicalTargetMatch,
  companyEnvironmentLockKey,
  environmentNameCandidate,
  pluginEnvironmentTargetsService,
} from "../services/plugin-environment-targets.js";
import { invocationBoardUser, withHostInvocationFacts } from "../services/plugin-invocation-facts.js";
import { createPluginWorkerHandle } from "../services/plugin-worker-manager.js";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "plugin-worker-environment-scope.cjs",
);

const TEST_MANIFEST: PaperclipPluginManifestV1 = {
  id: "test.environment-plugin",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test environment plugin",
  description: "Test environment plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: { worker: "dist/worker.js" },
};

describe("host-derived invocation facts", () => {
  it("adds the method to every scope and the actor to performAction only", () => {
    expect(withHostInvocationFacts(null, "getData", { companyId: "c-1" })).toBeNull();
    expect(withHostInvocationFacts({ companyId: "c-1" }, "getData", { companyId: "c-1" })).toEqual({ companyId: "c-1", method: "getData" });
    expect(withHostInvocationFacts({ companyId: "c-1" }, "performAction", {
      actorContext: { type: "user", userId: " user-1 ", agentId: null, runId: null, companyId: "c-1", isInstanceAdmin: true },
    })).toEqual({ companyId: "c-1", method: "performAction", actor: { type: "user", userId: "user-1" } });
    expect(withHostInvocationFacts({ companyId: "c-1" }, "performAction", {
      actorContext: { type: "agent", userId: "smuggled", agentId: "agent-1", runId: null, companyId: "c-1" },
    })).toEqual({ companyId: "c-1", method: "performAction", actor: { type: "agent", userId: null } });
    // An actor the host did not build (unknown type) gives no actor at all.
    expect(withHostInvocationFacts({ companyId: "c-1" }, "performAction", { actorContext: { type: "admin", userId: "u" } }))
      .toEqual({ companyId: "c-1", method: "performAction" });
    // Only performAction carries an actor, whatever its params say.
    expect(withHostInvocationFacts({ companyId: "c-1" }, "onEvent", { actorContext: { type: "user", userId: "u" } }))
      .toEqual({ companyId: "c-1", method: "onEvent" });
  });

  it("names the board user only for a valid performAction invocation by a user", () => {
    const scope = { companyId: "c-1", method: "performAction" as const, actor: { type: "user" as const, userId: "user-1" } };
    expect(invocationBoardUser({ invocationScope: scope })).toEqual({ companyId: "c-1", userId: "user-1" });
    expect(invocationBoardUser({ invocationScope: scope, invalidInvocationScope: true })).toBeNull();
    expect(invocationBoardUser({ invocationScope: { ...scope, method: "getData" } })).toBeNull();
    expect(invocationBoardUser({ invocationScope: { ...scope, actor: { type: "agent", userId: null } } })).toBeNull();
    expect(invocationBoardUser({ invocationScope: { companyId: "c-1" } })).toBeNull();
    expect(invocationBoardUser(undefined)).toBeNull();
  });

  it("keeps names unique within 100 characters and canonicalizes match rules", () => {
    expect(environmentNameCandidate("Box", 1)).toBe("Box");
    expect(environmentNameCandidate("Box", 3)).toBe("Box (3)");
    const long = "x".repeat(100);
    expect(environmentNameCandidate(long, 12)).toHaveLength(100);
    expect(environmentNameCandidate(long, 12).endsWith(" (12)")).toBe(true);
    expect(JSON.stringify(canonicalTargetMatch({ pool: "a", deviceId: "d-1" }))).toBe('{"deviceId":"d-1","pool":"a"}');
    expect(companyEnvironmentLockKey("c-1", "box", { pool: "a", deviceId: "d-1" }))
      .toBe(companyEnvironmentLockKey("c-1", "box", { deviceId: "d-1", pool: "a" }));
  });
});

describe("invocation facts through a worker", () => {
  type Seen = { method: string; params: unknown; context: WorkerHostCallContext | undefined; outcome: "resolved" | "rejected"; code?: unknown };

  function startWorker() {
    const reportTargets = vi.fn(async () => ({ accepted: 0 }));
    const ensureCompanyEnvironment = vi.fn(async () => ({ environmentId: "env-1", name: "Box", created: true }));
    const handlers = createHostClientHandlers({
      pluginId: "test.environment-plugin",
      capabilities: ["environment.drivers.register"],
      services: { environments: { reportTargets, ensureCompanyEnvironment } } as unknown as HostServices,
    });
    const seen: Seen[] = [];
    for (const method of ["environments.reportTargets", "environments.ensureCompanyEnvironment"] as const) {
      const handler = handlers[method] as (params: unknown, context?: WorkerHostCallContext) => Promise<unknown>;
      (handlers as Record<string, unknown>)[method] = async (params: unknown, context?: WorkerHostCallContext) => {
        try {
          const result = await handler(params, context);
          seen.push({ method, params, context, outcome: "resolved" });
          return result;
        } catch (error) {
          seen.push({ method, params, context, outcome: "rejected", code: (error as { code?: unknown }).code });
          throw error;
        }
      };
    }
    const handle = createPluginWorkerHandle("test.environment-plugin", {
      entrypointPath: FIXTURE,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: handlers,
      autoRestart: false,
    });
    return { handle, seen, reportTargets, ensureCompanyEnvironment };
  }

  const ensureParams = {
    companyId: "company-a",
    driverKey: "box",
    name: "Box",
    config: { deviceId: "d-1" },
    match: { deviceId: "d-1" },
  };

  function performAction(actorContext: Record<string, unknown>, probe: Record<string, unknown>) {
    return {
      key: "probe",
      params: { probe },
      actorContext: { agentId: null, runId: null, companyId: "company-a", ...actorContext },
      renderEnvironment: null,
    } as unknown as HostToWorkerMethods["performAction"][0];
  }

  it("gives a board user's performAction the host's method and actor, and lets it ensure an environment", async () => {
    const { handle, seen, ensureCompanyEnvironment } = startWorker();
    try {
      await handle.start();
      await expect(handle.call("performAction", performAction(
        { type: "user", userId: "user-1", isInstanceAdmin: false },
        { hostParams: ensureParams },
      ))).resolves.toEqual({ environmentId: "env-1", name: "Box", created: true });
      expect(ensureCompanyEnvironment).toHaveBeenCalledTimes(1);
      expect(seen[0]!.context?.invocationScope).toEqual({
        companyId: "company-a",
        method: "performAction",
        actor: { type: "user", userId: "user-1" },
      });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("denies ensureCompanyEnvironment to agents, getData and onEvent, and ignores a scope the worker writes itself", async () => {
    const { handle, seen, ensureCompanyEnvironment, reportTargets } = startWorker();
    const forged = { companyId: "company-a", method: "performAction", actor: { type: "user", userId: "forged-user" } };
    try {
      await handle.start();

      // An agent's action: the host-derived actor is the agent.
      await expect(handle.call("performAction", performAction(
        { type: "agent", userId: null, agentId: "agent-1" },
        { hostParams: ensureParams, forge: forged },
      ))).rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED });

      // getData, with a made-up performAction scope on the worker's own message.
      await expect(handle.call("getData", {
        key: "probe",
        companyId: "company-a",
        params: { probe: { hostParams: ensureParams, forge: forged } },
      } as HostToWorkerMethods["getData"][0])).rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED });

      // A report from the same getData sees the host's facts, not the forged ones.
      await expect(handle.call("getData", {
        key: "probe",
        companyId: "company-a",
        params: { probe: { hostMethod: "environments.reportTargets", hostParams: { driverKey: "box", targets: [] }, forge: forged } },
      } as HostToWorkerMethods["getData"][0])).resolves.toEqual({ accepted: 0 });
      expect(reportTargets).toHaveBeenCalledTimes(1);
      const report = seen.find((entry) => entry.method === "environments.reportTargets")!;
      expect(report.context?.invocationScope).toEqual({ companyId: "company-a", method: "getData" });

      // onEvent is a notification: the nested call is denied all the same.
      handle.notify("onEvent", {
        event: {
          eventId: "event-1",
          eventType: "issue.updated",
          companyId: "company-a",
          occurredAt: new Date().toISOString(),
          payload: { probe: { hostParams: ensureParams, forge: forged } },
        },
      });
      await vi.waitFor(() => {
        expect(seen.filter((entry) => entry.method === "environments.ensureCompanyEnvironment")).toHaveLength(3);
      }, { timeout: 5_000 });
      const ensures = seen.filter((entry) => entry.method === "environments.ensureCompanyEnvironment");
      expect(ensures.map((entry) => [entry.outcome, entry.code])).toEqual([
        ["rejected", PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED],
        ["rejected", PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED],
        ["rejected", PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED],
      ]);
      expect(ensures.map((entry) => entry.context?.invocationScope)).toEqual([
        { companyId: "company-a", method: "performAction", actor: { type: "agent", userId: null } },
        { companyId: "company-a", method: "getData" },
        { companyId: "company-a", method: "onEvent" },
      ]);
      expect(ensureCompanyEnvironment).not.toHaveBeenCalled();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin environment target tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("plugin environment targets (database)", () => {
  type TestDb = ReturnType<typeof createDb>;
  type Tx = Parameters<Parameters<TestDb["transaction"]>[0]>[0];
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: TestDb;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-env-targets-");
    db = createDb(database.connectionString);
  }, 120_000);

  afterAll(async () => {
    // A checkpoint leaves the shutdown little to write, so the data directory goes within the cleanup's bound.
    await db?.execute(sql`checkpoint`).catch(() => undefined);
    await database?.cleanup();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate table companies, plugins, ai_account_hosts, ai_accounts, environments, instance_user_roles, "user" cascade`);
  });

  const tag = () => randomUUID().slice(0, 8);
  const hourFromNow = () => new Date(Date.now() + 60 * 60 * 1000);
  const SECRET_ID = "11111111-1111-4111-8111-111111111111";

  async function company() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: `Company ${tag()}`, issuePrefix: `T${id.replaceAll("-", "").slice(0, 7).toUpperCase()}` });
    return id;
  }

  async function user(id = `user-${tag()}`) {
    const at = new Date();
    await db.insert(authUsers).values({ id, name: id, email: `${id}@example.com`, emailVerified: true, createdAt: at, updatedAt: at }).onConflictDoNothing();
    return id;
  }

  async function member(companyId: string, userId: string, membershipRole = "member") {
    await user(userId);
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole });
  }

  async function plugin(provider: string, options: { configSchema?: Record<string, unknown>; status?: string } = {}) {
    const pluginKey = `test.${provider}.${tag()}`;
    const [row] = await db.insert(plugins).values({
      pluginKey,
      packageName: pluginKey,
      version: "1.0.0",
      status: (options.status ?? "ready") as never,
      manifestJson: {
        id: pluginKey,
        displayName: `Plugin ${provider}`,
        environmentDrivers: [{ driverKey: provider, kind: "sandbox_provider", displayName: provider, configSchema: options.configSchema }],
      } as never,
    }).returning();
    return row!;
  }

  async function environment(config: Record<string, unknown>, overrides: Partial<typeof environments.$inferInsert> = {}) {
    const [row] = await db.insert(environments).values({ name: `sandbox ${tag()}`, driver: "sandbox", config, ...overrides }).returning();
    return row!;
  }

  async function agent(companyId: string, overrides: Partial<typeof agents.$inferInsert> = {}) {
    const [row] = await db.insert(agents).values({ companyId, name: `Agent ${tag()}`, adapterType: "claude_local", ...overrides }).returning();
    return row!;
  }

  async function account(ownerUserId: string) {
    const [row] = await db.insert(aiAccounts).values({
      credentialType: "subscription",
      label: `Account ${tag()}`,
      ownerUserId,
      createdByUserId: ownerUserId,
      credentialMaterial: { provider: "local_encrypted", ciphertext: tag() },
      credentialFingerprint: randomUUID(),
    }).returning();
    return row!;
  }

  function service(pluginRow: { id: string; pluginKey: string }, options: { deploymentMode?: "local_trusted" | "authenticated" } = {}) {
    return pluginEnvironmentTargetsService(db, {
      pluginId: pluginRow.id,
      pluginKey: pluginRow.pluginKey,
      deploymentMode: options.deploymentMode ?? "authenticated",
    });
  }

  function report(overrides: Partial<PluginEnvironmentTargetReport> = {}): PluginEnvironmentTargetReport {
    return {
      targetKey: "d-1",
      label: "Build box",
      configMatch: { deviceId: "d-1" },
      state: "available",
      acceptedCredentialTypes: ["subscription"],
      ...overrides,
    };
  }

  async function deviceOf(pluginId: string, provider: string, targetKey: string) {
    const [row] = await db.select().from(aiAccountHosts).where(eq(aiAccountHosts.targetKey, pluginTargetKey(pluginId, provider, targetKey)));
    return row ?? null;
  }

  async function availabilityOf(environmentId: string) {
    const [row] = await db.select().from(environmentAvailability).where(eq(environmentAvailability.environmentId, environmentId));
    return row ?? null;
  }

  /** A lane successor that is the current run of its own episode, due in an hour. */
  async function waitingRun(input: {
    companyId: string;
    kind: ResourceWaitKind;
    reason: ResourceWaitReason;
    scope: ResourceWaitScope;
    environmentId: string;
    accountId?: string | null;
  }) {
    const owner = await agent(input.companyId);
    const lane = RESOURCE_WAIT_LANE_BY_KIND[input.kind];
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: input.companyId,
      agentId: owner.id,
      invocationSource: "automation",
      status: "scheduled_retry",
      scheduledRetryReason: lane,
      scheduledRetryAt: hourFromNow(),
      scheduledRetryAttempt: 1,
      contextSnapshot: { retryReason: lane },
    }).returning();
    const resourceKey = input.kind === "environment" ? `environment:${input.environmentId}` : `account:${input.accountId}`;
    const [episode] = await db.insert(resourceWaitEpisodes).values({
      companyId: input.companyId,
      agentId: owner.id,
      kind: input.kind,
      reason: input.reason,
      scope: input.scope,
      resourceKey,
      environmentId: input.environmentId,
      accountId: input.accountId ?? null,
      since: new Date(),
      currentRunId: run!.id,
    }).returning();
    const context = buildResourceWaitContext({
      episodeId: episode!.id,
      kind: input.kind,
      reason: input.reason,
      scope: input.scope,
      environmentId: input.environmentId,
      environmentName: null,
      deviceId: null,
      deviceName: null,
      accountId: input.accountId ?? null,
      accountLabel: null,
      resumeAt: null,
      resumeAtSource: null,
      message: null,
    });
    await db.update(heartbeatRuns)
      .set({ contextSnapshot: { retryReason: lane, resourceWait: context } })
      .where(eq(heartbeatRuns.id, run!.id));
    return run!.id;
  }

  /** The waiting runs that are due now (a wake moved them), in the order given. */
  async function dueNow(runIds: string[]) {
    const rows = await db.select({ id: heartbeatRuns.id, at: heartbeatRuns.scheduledRetryAt }).from(heartbeatRuns).where(inArray(heartbeatRuns.id, runIds));
    const due = new Set(rows.filter((row) => row.at && row.at.getTime() <= Date.now()).map((row) => row.id));
    return runIds.filter((id) => due.has(id));
  }

  async function holdAgain(runIds: string[]) {
    await db.update(heartbeatRuns).set({ scheduledRetryAt: hourFromNow() }).where(inArray(heartbeatRuns.id, runIds));
  }

  function actionContext(companyId: string, userId: string): WorkerHostCallContext {
    return { invocationScope: { companyId, method: "performAction", actor: { type: "user", userId } } };
  }

  function ensureParams(companyId: string, overrides: Record<string, unknown> = {}) {
    return {
      companyId,
      driverKey: "box",
      name: "Box: d-1",
      description: "Runs agents on the build box.",
      config: { deviceId: "d-1", reuseLease: true },
      match: { deviceId: "d-1" },
      ...overrides,
    } as never;
  }

  /** Runs `work` in a transaction that stays open, with its locks, until `release()`. `pid` is its backend once `work` is done. */
  function openTransaction(work: (tx: Tx) => Promise<void>) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let ready!: (pid: number) => void;
    const backend = new Promise<number>((resolve) => { ready = resolve; });
    const done = db.transaction(async (tx) => {
      await work(tx);
      const [row] = (await tx.execute(sql`select pg_backend_pid() as pid`)) as unknown as Array<{ pid: number }>;
      ready(row!.pid);
      await released;
    });
    // A failing `work` rejects `pid` instead of leaving it pending.
    return { pid: Promise.race([backend, done.then(() => Number.NaN)]), release, done };
  }

  /** Backends that wait on a lock `pid` holds (optionally only for this wait event). */
  async function backendsBlockedBy(pid: number, waitEvent?: string): Promise<number> {
    const [row] = (await db.execute(sql`
      select count(*)::int as n from pg_stat_activity
      where ${pid} = any(pg_blocking_pids(pid))${waitEvent ? sql` and wait_event = ${waitEvent}` : sql``}
    `)) as unknown as Array<{ n: number }>;
    return row?.n ?? 0;
  }

  /** Counts the calls that have settled, without leaving a rejection unhandled. */
  function settledCount(calls: ReadonlyArray<Promise<unknown>>): () => number {
    let settled = 0;
    for (const call of calls) call.then(() => { settled += 1; }, () => { settled += 1; });
    return () => settled;
  }

  describe("reportTargets", () => {
    it("refuses a provider the plugin does not declare alone", async () => {
      const box = await plugin("box");
      await expect(service(box).reportTargets({ driverKey: "elsewhere", targets: [report()] }))
        .rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED });
      expect(await service(box).reportTargets({ driverKey: "box", targets: [report()] })).toEqual({ accepted: 1 });

      // A second installed plugin declaring the same provider: neither may report.
      const rival = await plugin("box", { status: "disabled" });
      await expect(service(box).reportTargets({ driverKey: "box", targets: [report({ targetKey: "d-2", configMatch: { deviceId: "d-2" } })] }))
        .rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED });
      await expect(service(rival).reportTargets({ driverKey: "box", targets: [report()] }))
        .rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED });
      expect(await deviceOf(box.id, "box", "d-2")).toBeNull();
      expect(await deviceOf(rival.id, "box", "d-1")).toBeNull();

      // A built-in provider's key is never a plugin's, even when only that plugin declares it:
      // no device, and nothing written onto the built-in provider's environments.
      const fake = await plugin("fake");
      const builtin = await environment({ provider: "fake", deviceId: "d-1" });
      await expect(service(fake).reportTargets({ driverKey: "fake", targets: [report()] }))
        .rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED });
      expect(await deviceOf(fake.id, "fake", "d-1")).toBeNull();
      expect(await availabilityOf(builtin.id)).toBeNull();
      const companyId = await company();
      await member(companyId, "user-1");
      await expect(service(fake).ensureCompanyEnvironment(ensureParams(companyId, { driverKey: "fake" }), actionContext(companyId, "user-1")))
        .rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED });
      expect(await db.select().from(environments).where(eq(environments.companyId, companyId))).toHaveLength(0);
    });

    it("keeps an unknown owner unowned and drops only invalid targets", async () => {
      const box = await plugin("box");
      const ownerId = await user();
      const result = await service(box).reportTargets({
        driverKey: "box",
        targets: [
          report({ ownerUserId: "nobody-by-this-id" }),
          report({ targetKey: "d-2", label: "Second box", configMatch: { deviceId: "d-2" }, ownerUserId: ownerId }),
          report({ targetKey: "d-3", configMatch: { deviceId: "d-3" }, reason: "not_serving" as never, state: "unavailable" }),
          report({ targetKey: "d-4", configMatch: { provider: "box" } }),
          report({ targetKey: "d-2", label: "Repeated", configMatch: { deviceId: "d-2" } }),
          "not a target",
        ],
      });
      expect(result).toEqual({ accepted: 2 });
      expect(await deviceOf(box.id, "box", "d-1")).toMatchObject({ ownerUserId: null, ownerSource: null, kind: "external" });
      expect(await deviceOf(box.id, "box", "d-2")).toMatchObject({ ownerUserId: ownerId, ownerSource: "plugin", name: "Second box" });
      expect(await deviceOf(box.id, "box", "d-3")).toBeNull();
      expect(await deviceOf(box.id, "box", "d-4")).toBeNull();
    });

    it("accepts 500 targets and refuses 501", async () => {
      const box = await plugin("box");
      const targets = (count: number) => Array.from({ length: count }, (_, index) =>
        report({ targetKey: `d-${index}`, label: `Box ${index}`, configMatch: { deviceId: `d-${index}` } }));
      await expect(service(box).reportTargets({ driverKey: "box", targets: targets(501) })).rejects.toThrow(/at most 500 targets/);
      expect(await db.select({ id: aiAccountHosts.id }).from(aiAccountHosts)).toHaveLength(0);
      expect(await service(box).reportTargets({ driverKey: "box", targets: targets(500) })).toEqual({ accepted: 500 });
      expect(await db.select({ id: aiAccountHosts.id }).from(aiAccountHosts)).toHaveLength(500);
    }, 120_000);

    it("writes the state onto matching environments and wakes only the waits each change affects", async () => {
      const box = await plugin("box");
      const companyId = await company();
      const mine = await environment({ provider: "box", deviceId: "d-1" });
      const other = await environment({ provider: "box", deviceId: "d-2" });
      const svc = service(box);
      await svc.reportTargets({ driverKey: "box", targets: [report(), report({ targetKey: "d-2", label: "Other", configMatch: { deviceId: "d-2" } })] });
      expect(await availabilityOf(mine.id)).toMatchObject({ state: "available", source: "plugin_report", acceptedCredentialTypes: ["subscription"] });

      const accountId = randomUUID();
      const runs = {
        offline: await waitingRun({ companyId, kind: "environment", reason: "offline", scope: "target", environmentId: mine.id }),
        notServing: await waitingRun({ companyId, kind: "environment", reason: "not_serving", scope: "admission", environmentId: mine.id }),
        credentialType: await waitingRun({ companyId, kind: "ai_account", reason: "credential_type_unsupported", scope: "account", environmentId: mine.id, accountId }),
        usageLimit: await waitingRun({ companyId, kind: "ai_account", reason: "usage_limit", scope: "account", environmentId: mine.id, accountId }),
        otherDevice: await waitingRun({ companyId, kind: "environment", reason: "offline", scope: "target", environmentId: other.id }),
      };
      const all = Object.values(runs);

      // Going offline wakes nothing.
      await svc.reportTargets({ driverKey: "box", targets: [report({ state: "unavailable", reason: "offline", message: "Asleep" })] });
      expect(await availabilityOf(mine.id)).toMatchObject({ state: "unavailable", reason: "offline", message: "Asleep" });
      expect(await dueNow(all)).toEqual([]);

      // Back: the target-scope wait on that environment only.
      await svc.reportTargets({ driverKey: "box", targets: [report()] });
      expect(await availabilityOf(mine.id)).toMatchObject({ state: "available" });
      expect(await dueNow(all)).toEqual([runs.offline]);
      await holdAgain(all);

      // Another credential type: the credential-type account wait (and the cheap target-scope re-check).
      await svc.reportTargets({ driverKey: "box", targets: [report({ acceptedCredentialTypes: ["subscription", "api_key"] })] });
      expect(await availabilityOf(mine.id)).toMatchObject({ acceptedCredentialTypes: ["subscription", "api_key"] });
      expect(await dueNow(all)).toEqual([runs.offline, runs.credentialType]);
      await holdAgain(all);

      // `wake`: every wait on the target's environments.
      await svc.reportTargets({ driverKey: "box", targets: [report({ acceptedCredentialTypes: ["subscription", "api_key"], wake: true })] });
      expect(await dueNow(all)).toEqual([runs.offline, runs.notServing, runs.credentialType, runs.usageLimit]);
      await holdAgain(all);

      // An owner change alone updates the device and wakes nothing.
      const ownerId = await user();
      await svc.reportTargets({ driverKey: "box", targets: [report({ acceptedCredentialTypes: ["subscription", "api_key"], ownerUserId: ownerId })] });
      expect(await deviceOf(box.id, "box", "d-1")).toMatchObject({ ownerUserId: ownerId });
      expect(await dueNow(all)).toEqual([]);

      // Retired: the environment refuses from now on, and its waits wake to find out.
      await svc.reportTargets({ driverKey: "box", targets: [report({ state: "unavailable", reason: "other", message: "Removed from the fleet", retired: true })] });
      expect(await availabilityOf(mine.id)).toMatchObject({ state: "retired", message: "Removed from the fleet" });
      expect(await availabilityOf(other.id)).toMatchObject({ state: "available" });
      expect(await dueNow(all)).toEqual([runs.offline, runs.notServing, runs.credentialType, runs.usageLimit]);
    });

    it("re-checks the device cap when a new target picks up bound agents", async () => {
      const box = await plugin("box");
      const companyId = await company();
      const ownerId = await user();
      const sandbox = await environment({ provider: "box", deviceId: "d-1" });
      for (let index = 0; index < 4; index += 1) {
        const row = await agent(companyId, { defaultEnvironmentId: sandbox.id });
        const pool = await account(ownerId);
        await db.insert(aiAccountAgentBindings).values({ agentId: row.id, companyId, mode: "pool_account", accountId: pool.id });
      }
      await service(box).reportTargets({ driverKey: "box", targets: [report()] });
      const device = await deviceOf(box.id, "box", "d-1");
      expect(device!.overLimitAt).not.toBeNull();
      // The account pool's notice, the one entry every path that flags a device writes.
      const logged = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "execution_device.over_limit")));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({ actorType: "system", actorId: AI_ACCOUNT_POOL_SYSTEM_ACTOR_ID, entityType: "execution_device", entityId: device!.id });
      expect(logged[0]!.details).toMatchObject({ deviceName: device!.name, limit: 3, inUse: 4 });
      expect(await db.select().from(activityLog).where(eq(activityLog.action, "execution_device.updated"))).toHaveLength(0);

      // The same report again changes nothing and logs nothing more.
      await service(box).reportTargets({ driverKey: "box", targets: [report()] });
      expect(await db.select().from(activityLog).where(eq(activityLog.action, "execution_device.over_limit"))).toHaveLength(1);
    });
  });

  describe("ensureCompanyEnvironment", () => {
    it("creates the company's environment from a board user's action, once, seeded from its device", async () => {
      const box = await plugin("box");
      const companyId = await company();
      await member(companyId, "user-1");
      const svc = service(box);
      await svc.reportTargets({ driverKey: "box", targets: [report({ state: "unavailable", reason: "offline", message: "Asleep" })] });
      const device = await deviceOf(box.id, "box", "d-1");

      const first = await svc.ensureCompanyEnvironment(ensureParams(companyId, {
        config: { provider: "something-else", deviceId: "d-1", reuseLease: true, bridgeRequestTimeoutMs: 1_800_000 },
      }), actionContext(companyId, "user-1"));
      expect(first).toMatchObject({ name: "Box: d-1", created: true });
      const [row] = await db.select().from(environments).where(eq(environments.id, first.environmentId));
      expect(row).toMatchObject({
        companyId,
        driver: "sandbox",
        status: "active",
        name: "Box: d-1",
        description: "Runs agents on the build box.",
        envVars: {},
      });
      expect(row!.config).toMatchObject({ provider: "box", deviceId: "d-1", reuseLease: true, bridgeRequestTimeoutMs: 1_800_000 });
      // The new environment starts from its device's last report.
      expect(await availabilityOf(first.environmentId)).toMatchObject({
        state: "unavailable",
        reason: "offline",
        targetKey: device!.targetKey,
        checkedAt: device!.targetReportedAt,
      });
      const logged = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "environment.created")));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({ actorType: "plugin", actorId: box.id, entityType: "environment", entityId: first.environmentId, responsibleUserId: "user-1" });
      expect(logged[0]!.details).toMatchObject({ name: "Box: d-1", driver: "sandbox", companyId, provider: "box", sourcePluginKey: box.pluginKey, initiatingUserId: "user-1" });

      // Again: the same environment, nothing new.
      expect(await svc.ensureCompanyEnvironment(ensureParams(companyId), actionContext(companyId, "user-1")))
        .toEqual({ environmentId: first.environmentId, name: "Box: d-1", created: false });
      expect(await db.select().from(environments).where(eq(environments.companyId, companyId))).toHaveLength(1);
      expect(await db.select().from(activityLog).where(eq(activityLog.action, "environment.created"))).toHaveLength(1);
    });

    it("seeds a new environment from a stale report as subscription only, trusted no longer than any report", async () => {
      const box = await plugin("box");
      const companyId = await company();
      await member(companyId, "user-1");
      const reportedAt = new Date(Date.now() - 20 * 60 * 1000);
      await pluginEnvironmentTargetsService(db, { pluginId: box.id, pluginKey: box.pluginKey, deploymentMode: "authenticated", now: () => reportedAt })
        .reportTargets({ driverKey: "box", targets: [report({ acceptedCredentialTypes: ["subscription", "api_key"] })] });
      const created = await service(box).ensureCompanyEnvironment(ensureParams(companyId), actionContext(companyId, "user-1"));
      expect(await availabilityOf(created.environmentId)).toMatchObject({
        state: "available",
        acceptedCredentialTypes: ["subscription"],
        checkedAt: reportedAt,
      });
    });

    it("is denied outside a board user's performAction and to callers without write access", async () => {
      const box = await plugin("box");
      const companyId = await company();
      const otherCompanyId = await company();
      await member(companyId, "user-1");
      await member(companyId, "viewer-1", "viewer");
      await member(otherCompanyId, "outsider");
      const svc = service(box);
      const denied = { code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED };
      const userScope = { companyId, method: "performAction" as const, actor: { type: "user" as const, userId: "user-1" } };
      for (const context of [
        undefined,
        { invocationScope: { ...userScope, method: "getData" as const } },
        { invocationScope: { ...userScope, method: "onEvent" as const } },
        { invocationScope: { ...userScope, method: "executeTool" as const } },
        { invocationScope: { ...userScope, actor: { type: "agent" as const, userId: null } } },
        { invocationScope: userScope, invalidInvocationScope: true },
        // Another company than the invocation's.
        actionContext(otherCompanyId, "user-1"),
        // No write access: a viewer, or someone who is not a member.
        actionContext(companyId, "viewer-1"),
        actionContext(companyId, "outsider"),
        actionContext(companyId, "local-board"),
      ] as Array<WorkerHostCallContext | undefined>) {
        await expect(svc.ensureCompanyEnvironment(ensureParams(companyId), context)).rejects.toMatchObject(denied);
      }
      expect(await db.select().from(environments)).toHaveLength(0);

      // An instance admin writes even with a viewer membership; local_trusted's board user writes everywhere.
      await db.insert(instanceUserRoles).values({ userId: "viewer-1", role: "instance_admin" });
      expect(await svc.ensureCompanyEnvironment(ensureParams(companyId), actionContext(companyId, "viewer-1"))).toMatchObject({ created: true });
      expect(await service(box, { deploymentMode: "local_trusted" }).ensureCompanyEnvironment(
        ensureParams(otherCompanyId),
        actionContext(otherCompanyId, "local-board"),
      )).toMatchObject({ created: true });
    });

    it("creates exactly one environment for concurrent calls, which queue on the advisory lock", async () => {
      const box = await plugin("box");
      const companyId = await company();
      await member(companyId, "user-1");
      const svc = service(box);
      // Hold the calls' lock, so all three are inside their transactions at once
      // instead of being serialized by chance (opening connections, timing).
      const holder = openTransaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${companyEnvironmentLockKey(companyId, "box", { deviceId: "d-1" })}))`);
      });
      const calls: Array<ReturnType<typeof svc.ensureCompanyEnvironment>> = [];
      try {
        const holderPid = await holder.pid;
        for (let index = 0; index < 3; index += 1) {
          calls.push(svc.ensureCompanyEnvironment(ensureParams(companyId), actionContext(companyId, "user-1")));
        }
        const settled = settledCount(calls);
        // Without the service's own lock the calls never wait here (and each creates an environment).
        await vi.waitFor(async () => {
          expect(await backendsBlockedBy(holderPid, "advisory")).toBe(3);
        }, { timeout: 10_000, interval: 20 });
        expect(settled()).toBe(0);
      } finally {
        holder.release();
        await holder.done;
        await Promise.allSettled(calls);
      }
      const results = await Promise.all(calls);
      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(new Set(results.map((result) => result.environmentId)).size).toBe(1);
      expect(await db.select().from(environments)).toHaveLength(1);
    });

    it("seeds a new environment from a report of its target that is still in flight", async () => {
      const box = await plugin("box");
      const companyId = await company();
      await member(companyId, "user-1");
      const svc = service(box);
      await svc.reportTargets({ driverKey: "box", targets: [report({ state: "unavailable", reason: "offline", message: "Asleep" })] });
      // A report that says the target is back: its device row is written and its
      // environments looked up (none yet), but it has not committed.
      const inFlight = openTransaction(async (tx) => {
        const upserted = await upsertPluginTargetByTargetKey(tx, { pluginId: box.id, provider: "box", target: report(), now: new Date() });
        await environmentsMatchingTarget(tx, { provider: "box", match: { deviceId: "d-1" }, deviceId: upserted.device.id });
      });
      let ensuring: ReturnType<typeof svc.ensureCompanyEnvironment> | null = null;
      try {
        const reportPid = await inFlight.pid;
        ensuring = svc.ensureCompanyEnvironment(ensureParams(companyId), actionContext(companyId, "user-1"));
        const settled = settledCount([ensuring]);
        await vi.waitFor(async () => {
          expect(settled() > 0 || (await backendsBlockedBy(reportPid)) > 0).toBe(true);
        }, { timeout: 10_000, interval: 20 });
        // The seed waits for the report (an unlocked read would have seeded the old state and finished).
        expect(settled()).toBe(0);
      } finally {
        inFlight.release();
        await inFlight.done;
        if (ensuring) await Promise.allSettled([ensuring]);
      }
      const created = await ensuring!;
      expect(created).toMatchObject({ created: true });
      expect(await availabilityOf(created.environmentId)).toMatchObject({ state: "available", reason: null, source: "plugin_report" });
    });

    it("refuses env vars, secret references, secret fields and other providers", async () => {
      const box = await plugin("box", {
        configSchema: { type: "object", properties: { deviceId: { type: "string" }, apiKey: { type: "string", format: "secret-ref" } } },
      });
      const companyId = await company();
      await member(companyId, "user-1");
      const svc = service(box);
      const context = actionContext(companyId, "user-1");
      await expect(svc.ensureCompanyEnvironment(ensureParams(companyId, { envVars: { TOKEN: "x" } }), context)).rejects.toThrow(/envVars|unrecognized/i);
      await expect(svc.ensureCompanyEnvironment(ensureParams(companyId, {
        config: { deviceId: "d-1", token: { type: "secret_ref", secretId: SECRET_ID } },
      }), context)).rejects.toThrow(/secret references/);
      await expect(svc.ensureCompanyEnvironment(ensureParams(companyId, {
        config: { deviceId: "d-1", apiKey: SECRET_ID },
      }), context)).rejects.toThrow(/config\.apiKey is a secret field/);
      await expect(svc.ensureCompanyEnvironment(ensureParams(companyId, {
        config: { deviceId: "d-1", apiKey: "plain-text" },
      }), context)).rejects.toThrow(/config\.apiKey is a secret field/);
      await expect(svc.ensureCompanyEnvironment(ensureParams(companyId, {
        config: { deviceId: "d-1", blob: "x".repeat(5_000) },
      }), context)).rejects.toThrow(/4 KB/);
      await expect(svc.ensureCompanyEnvironment(ensureParams(companyId, { driverKey: "elsewhere" }), context))
        .rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED });
      await expect(svc.ensureCompanyEnvironment(ensureParams(companyId, { config: { deviceId: "d-2" } }), context))
        .rejects.toThrow(/config\.deviceId must equal match\.deviceId/);
      expect(await db.select().from(environments)).toHaveLength(0);
      // An empty secret field is fine.
      expect(await svc.ensureCompanyEnvironment(ensureParams(companyId, { config: { deviceId: "d-1", apiKey: "" } }), context))
        .toMatchObject({ created: true });
    });

    it("works end to end: a worker's nested calls reach the host services with the host's facts", async () => {
      const box = await plugin("box");
      const companyId = await company();
      await member(companyId, "user-1");
      const services = buildHostServices(db, box.id, box.pluginKey, {
        forPlugin: () => ({ emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() }),
      } as never);
      const handle = createPluginWorkerHandle(box.id, {
        entrypointPath: FIXTURE,
        manifest: { ...TEST_MANIFEST, id: box.pluginKey },
        config: {},
        instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
        apiVersion: 1,
        hostHandlers: createHostClientHandlers({ pluginId: box.id, capabilities: ["environment.drivers.register"], services }),
        autoRestart: false,
      });
      try {
        await handle.start();
        await expect(handle.call("getData", {
          key: "probe",
          companyId,
          params: { probe: { hostMethod: "environments.reportTargets", hostParams: { driverKey: "box", targets: [report()] } } },
        } as HostToWorkerMethods["getData"][0])).resolves.toEqual({ accepted: 1 });
        const created = await handle.call("performAction", {
          key: "probe",
          params: { probe: { hostParams: { companyId, driverKey: "box", name: "Box: d-1", config: { deviceId: "d-1" }, match: { deviceId: "d-1" } } } },
          actorContext: { type: "user", userId: "user-1", agentId: null, runId: null, companyId, isInstanceAdmin: false },
          renderEnvironment: null,
        }) as unknown as { environmentId: string; created: boolean };
        expect(created).toMatchObject({ created: true });
        expect(await availabilityOf(created.environmentId)).toMatchObject({ state: "available", source: "plugin_report" });
        // The same worker, in an agent's action, may not.
        await expect(handle.call("performAction", {
          key: "probe",
          params: { probe: { hostParams: { companyId, driverKey: "box", name: "Box: d-2", config: { deviceId: "d-2" }, match: { deviceId: "d-2" } } } },
          actorContext: { type: "agent", userId: null, agentId: randomUUID(), runId: null, companyId },
          renderEnvironment: null,
        })).rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED });
        expect(await db.select().from(environments)).toHaveLength(1);
      } finally {
        await handle.stop().catch(() => undefined);
        services.dispose();
      }
    });

    it("makes the name unique across the instance", async () => {
      const box = await plugin("box");
      const companyId = await company();
      await member(companyId, "user-1");
      await environment({ provider: "box", deviceId: "d-9" }, { name: "Box: d-1" });
      await environment({ provider: "box", deviceId: "d-8" }, { name: "Box: d-1 (2)", status: "archived" });
      const created = await service(box).ensureCompanyEnvironment(ensureParams(companyId), actionContext(companyId, "user-1"));
      expect(created).toMatchObject({ name: "Box: d-1 (3)", created: true });
    });
  });
});
