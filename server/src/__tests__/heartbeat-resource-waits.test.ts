import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  environmentAvailability,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
  plugins,
  projects,
  resourceWaitEpisodes,
} from "@paperclipai/db";
import {
  ENVIRONMENT_PROJECT_ID_FEATURE,
  JsonRpcCallError,
  PluginEnvironmentUnavailableError,
  environmentUnavailableErrorData,
} from "@paperclipai/plugin-sdk";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { registerServerAdapter, unregisterServerAdapter, type AdapterExecutionContext } from "../adapters/index.js";
import { HttpError } from "../errors.js";
import { isResolvedInteractionContinuationWakeContext } from "../modules/run-dispatch/index.js";
import { executionFailureRetryCount } from "../services/execution-recovery-attempt.js";
import { heartbeatService } from "../services/heartbeat.js";
import { scheduledIssueMonitorWait } from "../services/issue-monitors.js";
import { pluginEnvironmentTargetsService } from "../services/plugin-environment-targets.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

// The agents' adapter is a test adapter: a waiting run must never reach it.
// It is not a remote-managed adapter, so a run on an SSH or plugin computer
// takes the computer's lease (where every wait starts) and then executes
// without remote preparation commands, as in heartbeat-workspace-busy.
const RESOURCE_WAIT_TEST_ADAPTER = "resource_wait_test";
const adapterExecute = vi.fn();

// The SSH lease and the sweep's SSH probe both reach the host through this
// call; a test sets `fail` to make the host unreachable.
const sshStub = vi.hoisted(() => ({ fail: null as (() => Error) | null, calls: 0 }));
vi.mock("@paperclipai/adapter-utils/ssh", async (importOriginal) => ({
  ...await importOriginal<typeof import("@paperclipai/adapter-utils/ssh")>(),
  ensureSshWorkspaceReady: async (config: { remoteWorkspacePath: string }) => {
    sshStub.calls += 1;
    if (sshStub.fail) throw sshStub.fail();
    return { remoteCwd: config.remoteWorkspacePath };
  },
}));

// A test can make the device preflight (H2) fail; otherwise the module passes through.
const waitFaults = vi.hoisted(() => ({ preflight: null as Error | null }));
vi.mock("../services/resource-waits/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/resource-waits/index.js")>();
  return {
    ...actual,
    createResourceWaits: (...args: Parameters<typeof actual.createResourceWaits>) => {
      const waits = actual.createResourceWaits(...args);
      return {
        ...waits,
        preflightEnvironment: async (input: Parameters<typeof waits.preflightEnvironment>[0]) => {
          if (waitFaults.preflight) throw waitFaults.preflight;
          return waits.preflightEnvironment(input);
        },
      };
    },
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat resource-wait tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type RunRow = typeof heartbeatRuns.$inferSelect;

const MINUTE = 60_000;
const TARGET_KEY = "box-1";

/** What `ssh` prints for a computer that accepts the connection but never sends its banner (a sleeping machine behind a tunnel). */
function silentPortFailure() {
  return Object.assign(new Error("ssh exited with code 255"), {
    code: 255,
    stderr: "Connection timed out during banner exchange\nConnection to box.invalid port 22 timed out\n",
  });
}

function offlineError(message = "The computer is offline.") {
  return new JsonRpcCallError({
    code: -32603,
    message,
    data: environmentUnavailableErrorData(new PluginEnvironmentUnavailableError({
      scope: "target",
      reason: "offline",
      retryable: true,
      targetKey: TARGET_KEY,
      targetLabel: "Build box",
    })),
  });
}

/** The computer is up but does not take this run (an admission refusal, which notifies at once). */
function notAllowedError() {
  return new JsonRpcCallError({
    code: -32603,
    message: "The project is not enabled on this computer.",
    data: environmentUnavailableErrorData(new PluginEnvironmentUnavailableError({ scope: "admission", reason: "not_allowed", retryable: true })),
  });
}

describeEmbeddedPostgres("heartbeat resource waits (integration)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService> | null = null;
  /** The task context each run handed the adapter, as it was at that moment. */
  const adapterContexts = new Map<string, Record<string, unknown>>();

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-resource-waits-");
    db = createDb(database.connectionString);
    registerServerAdapter({
      type: RESOURCE_WAIT_TEST_ADAPTER,
      execute: (input) => adapterExecute(input),
      testEnvironment: async () => ({
        adapterType: RESOURCE_WAIT_TEST_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 60_000);

  afterEach(async () => {
    if (heartbeat) await drainHeartbeatRunsToQuiescence(db, heartbeat);
    heartbeat = null;
    adapterExecute.mockReset();
    adapterContexts.clear();
    sshStub.fail = null;
    sshStub.calls = 0;
    waitFaults.preflight = null;
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table companies, plugins, ai_account_hosts, environments cascade`);
    });
  });

  afterAll(async () => {
    unregisterServerAdapter(RESOURCE_WAIT_TEST_ADAPTER);
    // A checkpoint leaves the shutdown little to write, so the data directory goes in time.
    await db?.execute(sql`checkpoint`).catch(() => undefined);
    await database?.cleanup();
  });

  const tag = () => randomUUID().slice(0, 8);
  const later = (base: Date | null | undefined, ms: number) => new Date((base ?? new Date()).getTime() + ms);

  /**
   * The agent does its work as a real agent does: it reports on its task and
   * closes it, so no follow-up (missing comment, disposition repair) runs.
   */
  function succeed() {
    adapterExecute.mockImplementation(async (input: AdapterExecutionContext) => {
      adapterContexts.set(input.runId, structuredClone(input.context));
      const issueId = typeof input.context.issueId === "string" ? input.context.issueId : null;
      if (issueId) {
        const [task] = await db.select({ companyId: issues.companyId }).from(issues).where(eq(issues.id, issueId));
        await db.insert(issueComments).values({
          companyId: task!.companyId,
          issueId,
          authorType: "agent",
          authorAgentId: input.agent.id,
          createdByRunId: input.runId,
          body: "Done.",
        });
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      }
      return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
    });
  }

  async function company() {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: `Company ${tag()}`,
      issuePrefix: `W${id.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    // A run acts for its responsible user, who must be an active member of the company.
    const now = new Date();
    await db.insert(authUsers).values({
      id: "responsible-user", name: "Responsible user", email: "resource-waits@example.test", createdAt: now, updatedAt: now,
    }).onConflictDoNothing();
    await db.insert(companyMemberships).values({
      companyId: id, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member",
    });
    return id;
  }

  async function plugin(provider: string, driver: Record<string, unknown> = {}) {
    const pluginKey = `test.${provider}`;
    const [row] = await db.insert(plugins).values({
      pluginKey,
      packageName: `@test/${provider}`,
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: pluginKey,
        apiVersion: 1,
        version: "1.0.0",
        displayName: `Test ${provider}`,
        description: "Test environment driver plugin",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: provider, kind: "sandbox_provider", displayName: provider, configSchema: { type: "object" }, ...driver }],
      },
      status: "ready",
      installOrder: 1,
    } as never).returning();
    return row!;
  }

  /**
   * A fake worker of an environment driver plugin. While `offline`, a lease
   * fails with the typed envelope; a resume fails with `resumeError` when set.
   * The host calls `environmentCheckAvailability` only when it is advertised.
   */
  function fakeWorker(pluginId: string, options: { supportedMethods?: string[] } = {}) {
    const state = {
      offline: true,
      resumeError: null as Error | null,
      /** While set, a lease fails with it, online or not. */
      leaseError: null as (() => Error) | null,
      /** While set, a lease waits for it before answering. */
      acquireGate: null as Promise<void> | null,
      calls: [] as Array<{ method: string; params: Record<string, unknown> }>,
    };
    const manager = {
      isRunning: (id: string) => id === pluginId,
      getWorker: (id: string) => (id === pluginId ? { supportedMethods: options.supportedMethods ?? [] } : null),
      call: vi.fn(async (_id: string, method: string, params: Record<string, unknown>) => {
        state.calls.push({ method, params });
        if (method === "environmentAcquireLease") {
          if (state.acquireGate) await state.acquireGate;
          if (state.leaseError) throw state.leaseError();
          if (state.offline) throw offlineError();
          return { providerLeaseId: `lease-${tag()}`, metadata: { remoteCwd: "/workspace" } };
        }
        if (method === "environmentResumeLease") {
          if (state.resumeError) throw state.resumeError;
          return { providerLeaseId: params.providerLeaseId, metadata: { remoteCwd: "/workspace" } };
        }
        if (method === "environmentRealizeWorkspace") return { cwd: "/workspace" };
        if (method === "environmentReleaseLease" || method === "environmentDestroyLease") return undefined;
        if (method === "environmentCheckAvailability") {
          return state.offline
            ? { state: "unavailable", unavailable: { scope: "target", reason: "offline", retryable: true, targetKey: TARGET_KEY } }
            : { state: "available" };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const callsOf = (method: string) => state.calls.filter((call) => call.method === method);
    return { state, manager, callsOf };
  }

  async function sandboxEnvironment(companyId: string, provider: string, config: Record<string, unknown> = {}) {
    const [row] = await db.insert(environments).values({
      companyId,
      name: `Build box ${tag()}`,
      driver: "sandbox",
      status: "active",
      config: { provider, deviceId: TARGET_KEY, reuseLease: false, ...config },
    }).returning();
    return row!;
  }

  async function sshEnvironment(companyId: string) {
    const [row] = await db.insert(environments).values({
      companyId,
      name: `SSH box ${tag()}`,
      driver: "ssh",
      status: "active",
      config: { host: "box.invalid", port: 22, username: "runner", remoteWorkspacePath: "/home/runner/work" },
    }).returning();
    return row!;
  }

  async function agent(companyId: string, environmentId: string | null, heartbeatPolicy: Record<string, unknown> = {}) {
    const [row] = await db.insert(agents).values({
      companyId,
      name: `Builder ${tag()}`,
      role: "engineer",
      status: "idle",
      adapterType: RESOURCE_WAIT_TEST_ADAPTER,
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1, ...heartbeatPolicy } },
      defaultEnvironmentId: environmentId,
      permissions: {},
    }).returning();
    return row!;
  }

  async function issue(companyId: string, agentId: string, overrides: Partial<typeof issues.$inferInsert> = {}) {
    const [prefix] = await db.select({ issuePrefix: companies.issuePrefix }).from(companies).where(eq(companies.id, companyId));
    const [counter] = await db.select({ count: sql<number>`count(*)::int` }).from(issues).where(eq(issues.companyId, companyId));
    const number = (counter?.count ?? 0) + 1;
    const [row] = await db.insert(issues).values({
      companyId,
      title: `Task ${number}`,
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      issueNumber: number,
      identifier: `${prefix!.issuePrefix}-${number}`,
      ...overrides,
    }).returning();
    return row!;
  }

  async function runRow(id: string): Promise<RunRow> {
    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
    return row!;
  }

  async function issueRow(id: string) {
    const [row] = await db.select().from(issues).where(eq(issues.id, id));
    return row!;
  }

  async function waitFor<T>(read: () => Promise<T | null | undefined | false>, timeoutMs = 15_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await read();
      if (value) return value;
      if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** The run left queued and running (a deferral is cancelled, its successor waits). */
  async function settledRun(id: string, timeoutMs?: number) {
    return waitFor(async () => {
      const row = await runRow(id);
      return row && !["queued", "running"].includes(row.status) ? row : null;
    }, timeoutMs);
  }

  /** The run reached a terminal status (a waiting successor is not one yet). */
  async function finishedRun(id: string, timeoutMs?: number) {
    return waitFor(async () => {
      const row = await runRow(id);
      return row && ["succeeded", "failed", "cancelled", "timed_out"].includes(row.status) ? row : null;
    }, timeoutMs);
  }

  async function successorOf(id: string) {
    return waitFor(async () => {
      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, id));
      return row ?? null;
    });
  }

  async function runCount(companyId: string) {
    const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    return row!.count;
  }

  async function eventCount(companyId: string) {
    const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, companyId));
    return row!.count;
  }

  async function episodesOf(companyId: string) {
    return db.select().from(resourceWaitEpisodes).where(eq(resourceWaitEpisodes.companyId, companyId));
  }

  async function systemNotices(issueId: string) {
    return db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system")));
  }

  async function assign(agentId: string, issueId: string) {
    const run = await heartbeat!.invoke(agentId, "assignment", { issueId, taskId: issueId, wakeReason: "issue_assigned" }, "system");
    expect(run).not.toBeNull();
    return run!;
  }

  /** A task whose agent is pinned to a plugin computer that is offline: its first run waits. */
  async function offlineDevice(input: { supportedMethods?: string[]; heartbeatPolicy?: Record<string, unknown> } = {}) {
    succeed();
    const provider = `box${tag()}`;
    const companyId = await company();
    const driver = await plugin(provider);
    const worker = fakeWorker(driver.id, { supportedMethods: input.supportedMethods });
    const environment = await sandboxEnvironment(companyId, provider);
    const builder = await agent(companyId, environment.id, input.heartbeatPolicy);
    const task = await issue(companyId, builder.id);
    heartbeat = heartbeatService(db, { pluginWorkerManager: worker.manager });
    const run = await assign(builder.id, task.id);
    const deferred = await settledRun(run.id);
    const successor = await successorOf(run.id);
    // The deferral is settled: its episode, waiting event and agent status are written.
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    return { provider, companyId, driver, worker, environment, builder, task, run, deferred, successor };
  }

  describe("an offline device", () => {
    it("defers the run as an expected cancellation; the waiting run keeps the task, the agent stays idle and no retry is spent", async () => {
      succeed();
      const provider = `box${tag()}`;
      const companyId = await company();
      const driver = await plugin(provider);
      const worker = fakeWorker(driver.id);
      const environment = await sandboxEnvironment(companyId, provider);
      const builder = await agent(companyId, environment.id);
      const task = await issue(companyId, builder.id);
      heartbeat = heartbeatService(db, { pluginWorkerManager: worker.manager });
      // The run is already the first bounded retry of an earlier failure.
      const [queued] = await db.insert(heartbeatRuns).values({
        companyId,
        agentId: builder.id,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        scheduledRetryAttempt: 1,
        scheduledRetryReason: "transient_failure",
        contextSnapshot: {
          issueId: task.id,
          taskId: task.id,
          wakeReason: "issue_assigned",
          executionRetryAccounting: { version: 1, failureRetries: 1, maxTurnContinuations: 0 },
        },
      }).returning();
      await db.update(issues).set({ executionRunId: queued!.id, executionLockedAt: new Date() }).where(eq(issues.id, task.id));
      await heartbeat.resumeQueuedRuns();

      const deferred = await settledRun(queued!.id);
      expect(deferred).toMatchObject({ status: "cancelled", errorCode: "environment_unavailable" });
      expect(deferred.resultJson).toMatchObject({
        executionRecovery: { kind: "resource_wait", providerWorkStarted: false },
        resourceWait: { kind: "environment", reason: "offline", scope: "target", environmentId: environment.id },
        cancellation: { source: "control_plane", expected: true },
      });
      expect(adapterExecute).not.toHaveBeenCalled();
      expect(worker.callsOf("environmentAcquireLease")).toHaveLength(1);

      const successor = await successorOf(deferred.id);
      expect(successor).toMatchObject({
        status: "scheduled_retry",
        scheduledRetryReason: "environment_wait",
        scheduledRetryAttempt: 1,
        agentId: builder.id,
      });
      expect(successor.contextSnapshot).toMatchObject({
        issueId: task.id,
        resourceWait: { kind: "environment", reason: "offline", environmentId: environment.id },
        failureRetriesBeforeResourceWait: 1,
      });
      // The wait spent no failure retry: the count is the one from before it.
      expect(executionFailureRetryCount(successor)).toBe(1);
      // The waiting run holds the task, and nothing asks the board to reconcile it.
      expect(await issueRow(task.id)).toMatchObject({ status: "in_progress", executionRunId: successor.id });
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId))).toHaveLength(0);
      await expect.poll(async () => (await db.select({ status: agents.status }).from(agents).where(eq(agents.id, builder.id)))[0]?.status,
        { timeout: 5_000, interval: 50 }).toBe("idle");

      const [episode] = await episodesOf(companyId);
      expect(episode).toMatchObject({ kind: "environment", reason: "offline", scope: "target", currentRunId: successor.id, resolvedAt: null });
      const [registry] = await db.select().from(environmentAvailability).where(eq(environmentAvailability.environmentId, environment.id));
      expect(registry).toMatchObject({ state: "unavailable", reason: "offline" });
      const events = await db.select({ message: heartbeatRunEvents.message }).from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, deferred.id));
      expect(events.map((event) => event.message)).toContain(
        `Waiting for device ${environment.name} (offline). This task starts automatically when it is available.`,
      );
      // An offline device notifies only after the company's threshold (24 h).
      expect(await systemNotices(task.id)).toHaveLength(0);
    }, 30_000);

    it("holds the waiting runs without new rows or lease attempts while the device stays offline", async () => {
      const fixture = await offlineDevice({ supportedMethods: ["environmentCheckAvailability"] });
      const { companyId, worker, successor, builder, environment } = fixture;
      // A second task for the same computer waits at preflight (H2): the
      // registry saw it offline a moment ago, so no lease is attempted.
      const second = await issue(companyId, builder.id);
      const secondRun = await assign(builder.id, second.id);
      const secondDeferred = await settledRun(secondRun.id);
      expect(secondDeferred).toMatchObject({ status: "cancelled", errorCode: "environment_unavailable" });
      expect(secondDeferred.resultJson).toMatchObject({ resourceWait: { kind: "environment", scope: "target", environmentId: environment.id } });
      const secondSuccessor = await successorOf(secondRun.id);
      expect(worker.callsOf("environmentAcquireLease")).toHaveLength(1);
      // The second deferral writes its waiting event after the successor: count from a settled state.
      await drainHeartbeatRunsToQuiescence(db, heartbeat!);

      const runsBefore = await runCount(companyId);
      const eventsBefore = await eventCount(companyId);
      // Half an hour of outage, one scheduler tick a minute: the sweep checks
      // the computer (still offline) and the hold re-arms both waiting runs.
      const start = new Date();
      for (let minute = 1; minute <= 30; minute += 1) {
        const now = later(start, minute * MINUTE);
        await heartbeat!.sweepResourceWaits({ now });
        const promotion = await heartbeat!.promoteDueScheduledRetries(now);
        expect(promotion.runIds).not.toContain(successor.id);
        expect(promotion.runIds).not.toContain(secondSuccessor.id);
      }
      for (const id of [successor.id, secondSuccessor.id]) {
        const held = await runRow(id);
        expect(held.status).toBe("scheduled_retry");
        expect(held.scheduledRetryAt!.getTime()).toBeGreaterThan(later(start, 30 * MINUTE).getTime());
      }
      expect(await runCount(companyId)).toBe(runsBefore);
      expect(await eventCount(companyId)).toBe(eventsBefore);
      expect(worker.callsOf("environmentAcquireLease")).toHaveLength(1);
      expect(worker.callsOf("environmentCheckAvailability").length).toBeGreaterThan(0);
      expect(adapterExecute).not.toHaveBeenCalled();
      expect((await episodesOf(companyId)).map((episode) => episode.resolvedAt)).toEqual([null, null]);
    }, 60_000);

    it("a plugin report that the computer is back starts the waiting run at once, and it completes within the agent's daily cap", async () => {
      // One run a day: the deferral did no work, so it must not use up the cap.
      const fixture = await offlineDevice({ heartbeatPolicy: { maxDailyRuns: 1 } });
      const { worker, driver, provider, successor, task, companyId, builder } = fixture;
      worker.state.offline = false;
      const targets = pluginEnvironmentTargetsService(db, {
        pluginId: driver.id,
        pluginKey: driver.pluginKey,
        // As plugin-host-services wires it: woken runs start without waiting for the next tick.
        wakeWaits: (filter, now) => heartbeat!.wakeResourceWaitsNow(filter, { now }),
      });
      await expect(targets.reportTargets({
        driverKey: provider,
        targets: [{ targetKey: TARGET_KEY, label: "Build box", configMatch: { deviceId: TARGET_KEY }, state: "available" }],
      })).resolves.toEqual({ accepted: 1 });

      const finished = await finishedRun(successor.id);
      expect(finished).toMatchObject({ status: "succeeded" });
      expect(adapterExecute).toHaveBeenCalledTimes(1);
      expect(adapterExecute.mock.calls[0]![0]).toMatchObject({ runId: successor.id });
      expect(worker.callsOf("environmentAcquireLease")).toHaveLength(2);
      // No second wait, and the task's wait ended with the lease.
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, successor.id))).toHaveLength(0);
      const [episode] = await episodesOf(companyId);
      expect(episode).toMatchObject({ resolution: "resolved", currentRunId: successor.id });
      const events = await db.select({ message: heartbeatRunEvents.message }).from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, successor.id));
      expect(events.some((event) => event.message?.startsWith("Resumed after waiting"))).toBe(true);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId))).toHaveLength(0);
      await expect.poll(async () => (await db.select({ status: agents.status }).from(agents).where(eq(agents.id, builder.id)))[0]?.status,
        { timeout: 5_000, interval: 50 }).toBe("idle");
      expect((await issueRow(task.id)).executionRunId).not.toBe(successor.id);
    }, 30_000);

    it("pausing the agent while it waits: the next tick's gate ends the wait with no recovery action", async () => {
      const { companyId, builder, successor, task, worker } = await offlineDevice();
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, builder.id));

      const promotion = await heartbeat!.promoteDueScheduledRetries(later(successor.scheduledRetryAt, 1_000));
      expect(promotion.runIds).not.toContain(successor.id);
      expect(await runRow(successor.id)).toMatchObject({ status: "cancelled", errorCode: "agent_not_invokable" });
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId))).toHaveLength(0);
      expect(await issueRow(task.id)).toMatchObject({ status: "in_progress", executionRunId: null });
      const [episode] = await episodesOf(companyId);
      expect(episode).toMatchObject({ resolution: "abandoned" });
      expect(worker.callsOf("environmentAcquireLease")).toHaveLength(1);
      expect(adapterExecute).not.toHaveBeenCalled();
    }, 30_000);

    it("pausing the agent through the pause route cancels the wait without a legacy reconciliation hold", async () => {
      const { companyId, builder, successor, worker } = await offlineDevice();
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, builder.id));
      await heartbeat!.cancelActiveForAgent(builder.id);

      const cancelled = await runRow(successor.id);
      expect(cancelled).toMatchObject({ status: "cancelled", errorCode: "agent_paused", startedAt: null });
      // A never-started wait is no failed provider session: no active-run watchdog hold.
      const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId));
      expect(actions.filter((action) => action.kind === "active_run_watchdog" || action.cause === "legacy_execution_requires_reconciliation"))
        .toHaveLength(0);
      expect(worker.callsOf("environmentAcquireLease")).toHaveLength(1);
      expect(adapterExecute).not.toHaveBeenCalled();
    }, 30_000);

    it("a board comment while it waits leaves the waiting run and the task status as they are", async () => {
      const { companyId, builder, successor, task, worker } = await offlineDevice({ supportedMethods: ["environmentCheckAvailability"] });
      const [comment] = await db.insert(issueComments).values({
        companyId,
        issueId: task.id,
        authorType: "user",
        authorUserId: "board-user",
        body: "Is this still waiting for the build box?",
      }).returning();
      const runsBefore = await runCount(companyId);

      // What the comment route does for the assignee: a comment wake, then a check.
      await heartbeat!.wakeup(builder.id, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId: task.id, commentId: comment!.id },
        contextSnapshot: {
          issueId: task.id,
          taskId: task.id,
          commentId: comment!.id,
          wakeCommentId: comment!.id,
          wakeReason: "issue_commented",
          source: "issue.comment",
        },
        requestedByActorType: "user",
        requestedByActorId: "board-user",
      });
      const check = await heartbeat!.checkResourceWaitNow({ runId: successor.id, companyId, source: "comment" });
      expect(check).toMatchObject({ outcome: "still_unavailable", promoted: false, details: { code: "resource_still_unavailable" } });

      expect(await runRow(successor.id)).toMatchObject({ status: "scheduled_retry" });
      expect(await issueRow(task.id)).toMatchObject({ status: "in_progress", executionRunId: successor.id });
      expect(await runCount(companyId)).toBe(runsBefore);
      const [episode] = await episodesOf(companyId);
      expect(episode).toMatchObject({ currentRunId: successor.id, resolvedAt: null });
      // The comment wake joined the waiting run instead of starting another one.
      const coalesced = await db.select().from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.runId, successor.id), eq(agentWakeupRequests.status, "coalesced")));
      expect(coalesced).toHaveLength(1);
      expect(coalesced[0]!.payload).toMatchObject({ commentId: comment!.id });
      expect(worker.callsOf("environmentAcquireLease")).toHaveLength(1);
      expect(adapterExecute).not.toHaveBeenCalled();
    }, 30_000);

    it("closing the task while it waits ends the wait within one tick and releases the task", async () => {
      const { companyId, successor, task, worker } = await offlineDevice();
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, task.id));

      const promotion = await heartbeat!.promoteDueScheduledRetries(later(successor.scheduledRetryAt, 1_000));
      expect(promotion.runIds).not.toContain(successor.id);
      expect(await runRow(successor.id)).toMatchObject({ status: "cancelled", errorCode: "issue_terminal_status" });
      expect((await issueRow(task.id)).executionRunId).toBeNull();
      const [episode] = await episodesOf(companyId);
      expect(episode).toMatchObject({ resolution: "abandoned" });
      expect(await systemNotices(task.id)).toHaveLength(0);
      expect(worker.callsOf("environmentAcquireLease")).toHaveLength(1);
      expect(adapterExecute).not.toHaveBeenCalled();
    }, 30_000);

    it("a task closed while its run waits for the lease gets no waiting run, and its lock is released", async () => {
      succeed();
      const provider = `box${tag()}`;
      const companyId = await company();
      const driver = await plugin(provider);
      const worker = fakeWorker(driver.id);
      let answer!: () => void;
      worker.state.acquireGate = new Promise<void>((resolve) => {
        answer = resolve;
      });
      const environment = await sandboxEnvironment(companyId, provider);
      const builder = await agent(companyId, environment.id);
      const task = await issue(companyId, builder.id);
      heartbeat = heartbeatService(db, { pluginWorkerManager: worker.manager });

      const run = await assign(builder.id, task.id);
      await waitFor(async () => worker.callsOf("environmentAcquireLease").length === 1);
      await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, task.id));
      answer();

      const deferred = await settledRun(run.id);
      expect(deferred).toMatchObject({ status: "cancelled", errorCode: "environment_unavailable" });
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run.id))).toHaveLength(0);
      expect((await issueRow(task.id)).executionRunId).toBeNull();
      expect((await episodesOf(companyId)).map((episode) => episode.resolution)).toEqual(["abandoned"]);
      expect(await systemNotices(task.id)).toHaveLength(0);
      expect(adapterExecute).not.toHaveBeenCalled();
    }, 30_000);

    it("an issue monitor that falls due while its task waits moves past the wait and counts no attempt", async () => {
      const { task, successor } = await offlineDevice();
      await db.update(issues).set({ monitorNextCheckAt: new Date(Date.now() - MINUTE), monitorAttemptCount: 0 }).where(eq(issues.id, task.id));
      const now = new Date();
      await heartbeat!.tickTimers(now);

      const row = await issueRow(task.id);
      expect(row.monitorNextCheckAt!.getTime()).toBeGreaterThanOrEqual(now.getTime() + 15 * MINUTE);
      expect(row).toMatchObject({ monitorAttemptCount: 0, monitorWakeRequestedAt: null, executionRunId: successor.id });
      expect(await runRow(successor.id)).toMatchObject({ status: "scheduled_retry" });
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.reason, "issue_monitor_due"))).toHaveLength(0);
    }, 30_000);

    it("moves the saved monitor policy with the monitor, so the moved monitor stays the task's scheduled wait", async () => {
      const { task, builder, successor } = await offlineDevice();
      const due = new Date(Date.now() - MINUTE);
      const policy = {
        mode: "normal",
        commentRequired: true,
        stages: [],
        monitor: { nextCheckAt: due.toISOString(), notes: "Check the deploy", scheduledBy: "assignee", maxAttempts: 3 },
      };
      await db.update(issues).set({ monitorNextCheckAt: due, monitorAttemptCount: 0, executionPolicy: policy }).where(eq(issues.id, task.id));
      const now = new Date();
      await heartbeat!.tickTimers(now);

      const row = await issueRow(task.id);
      expect(row.monitorNextCheckAt!.getTime()).toBeGreaterThanOrEqual(now.getTime() + 15 * MINUTE);
      expect(row).toMatchObject({ monitorAttemptCount: 0, monitorWakeRequestedAt: null, executionRunId: successor.id });
      // Only the monitor's time moved; the rest of the policy is as it was.
      expect(row.executionPolicy).toEqual({ ...policy, monitor: { ...policy.monitor, nextCheckAt: row.monitorNextCheckAt!.toISOString() } });
      expect(scheduledIssueMonitorWait(row, builder.id)).toBe(row.monitorNextCheckAt!.toISOString());
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.reason, "issue_monitor_due"))).toHaveLength(0);
    }, 30_000);

    it("retry-now during the outage answers 409 resource_still_unavailable and starts no run", async () => {
      const { companyId, successor, task, worker, environment } = await offlineDevice({ supportedMethods: ["environmentCheckAvailability"] });
      const runsBefore = await runCount(companyId);
      const actor = { actorType: "user" as const, actorId: "board-user" };

      const refused = await heartbeat!.retryScheduledRetryNow({ issueId: task.id, actor }).then(() => null, (error: unknown) => error);
      expect(refused).toBeInstanceOf(HttpError);
      expect(refused).toMatchObject({
        status: 409,
        details: {
          code: "resource_still_unavailable",
          resourceWait: { kind: "environment", reason: "offline", environmentId: environment.id },
        },
      });
      // The check asked the computer; nothing was attempted or cancelled.
      expect(worker.callsOf("environmentCheckAvailability")).toHaveLength(1);
      expect(worker.callsOf("environmentAcquireLease")).toHaveLength(1);
      expect(await runCount(companyId)).toBe(runsBefore);
      const cancelled = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "cancelled")));
      expect(cancelled).toHaveLength(1);
      expect(await runRow(successor.id)).toMatchObject({ status: "scheduled_retry" });

      // Check now works once a minute per task.
      const limited = await heartbeat!.retryScheduledRetryNow({ issueId: task.id, actor }).then(() => null, (error: unknown) => error);
      expect(limited).toMatchObject({ status: 429, details: { code: "check_now_rate_limited" } });
      expect(adapterExecute).not.toHaveBeenCalled();
    }, 30_000);
  });

  describe("an SSH computer", () => {
    it("a port that never sends its banner makes the run wait; retry-now probes and answers 409; the sweep's probe resumes it", async () => {
      succeed();
      const companyId = await company();
      const environment = await sshEnvironment(companyId);
      const builder = await agent(companyId, environment.id);
      const task = await issue(companyId, builder.id);
      heartbeat = heartbeatService(db);
      sshStub.fail = silentPortFailure;

      const run = await assign(builder.id, task.id);
      const deferred = await settledRun(run.id);
      expect(deferred).toMatchObject({ status: "cancelled", errorCode: "environment_unavailable" });
      expect(deferred.resultJson).toMatchObject({
        executionRecovery: { kind: "resource_wait", providerWorkStarted: false },
        resourceWait: { kind: "environment", reason: "unreachable", scope: "target", environmentId: environment.id, message: null },
        cancellation: { expected: true },
      });
      // ssh's own output is matched, never kept.
      expect(JSON.stringify(deferred.resultJson)).not.toContain("banner");
      const [registry] = await db.select().from(environmentAvailability).where(eq(environmentAvailability.environmentId, environment.id));
      expect(registry).toMatchObject({ state: "unavailable", reason: "unreachable", message: null });
      const successor = await successorOf(run.id);
      expect(successor).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: "environment_wait" });
      expect(await issueRow(task.id)).toMatchObject({ executionRunId: successor.id });
      expect(adapterExecute).not.toHaveBeenCalled();

      // Retry-now while the computer still sleeps: a probe, then 409.
      const probesBefore = sshStub.calls;
      const refused = await heartbeat.retryScheduledRetryNow({ issueId: task.id }).then(() => null, (error: unknown) => error);
      expect(refused).toMatchObject({ status: 409, details: { code: "resource_still_unavailable", resourceWait: { reason: "unreachable" } } });
      expect(sshStub.calls).toBe(probesBefore + 1);
      expect(await runRow(successor.id)).toMatchObject({ status: "scheduled_retry" });

      // The computer wakes up: the sweep's probe ends the outage and wakes the wait.
      sshStub.fail = null;
      const sweep = await heartbeat.sweepResourceWaits({ force: true });
      expect(sweep.checks).toEqual([
        expect.objectContaining({ environmentId: environment.id, state: "available", becameAvailable: true, woken: 1 }),
      ]);
      const promotion = await heartbeat.promoteDueScheduledRetries();
      expect(promotion.runIds).toContain(successor.id);
      await heartbeat.resumeQueuedRuns();
      expect(await finishedRun(successor.id)).toMatchObject({ status: "succeeded" });
      expect(adapterExecute).toHaveBeenCalledTimes(1);
      expect(adapterExecute.mock.calls[0]![0]).toMatchObject({ runId: successor.id });
      const [episode] = await episodesOf(companyId);
      expect(episode).toMatchObject({ resolution: "resolved" });
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId))).toHaveLength(0);
    }, 60_000);
  });

  describe("environment driver plugins", () => {
    it("sends projectId on a run lease only to a worker that advertises the feature", async () => {
      succeed();
      const companyId = await company();
      const [project] = await db.insert(projects).values({ companyId, name: "Website", status: "active" }).returning();
      const plainProvider = `plain${tag()}`;
      const awareProvider = `aware${tag()}`;
      const plain = await plugin(plainProvider);
      const aware = await plugin(awareProvider);
      const supported: Record<string, string[]> = { [plain.id]: [], [aware.id]: [ENVIRONMENT_PROJECT_ID_FEATURE] };
      const acquires: Array<{ pluginId: string; params: Record<string, unknown> }> = [];
      const manager = {
        isRunning: (id: string) => id in supported,
        getWorker: (id: string) => (id in supported ? { supportedMethods: supported[id] } : null),
        call: vi.fn(async (id: string, method: string, params: Record<string, unknown>) => {
          if (method === "environmentAcquireLease") {
            acquires.push({ pluginId: id, params });
            return { providerLeaseId: `lease-${tag()}`, metadata: { remoteCwd: "/workspace" } };
          }
          if (method === "environmentRealizeWorkspace") return { cwd: "/workspace" };
          if (method === "environmentReleaseLease") return undefined;
          throw new Error(`Unexpected plugin method: ${method}`);
        }),
      } as unknown as PluginWorkerManager;
      heartbeat = heartbeatService(db, { pluginWorkerManager: manager });
      const plainAgent = await agent(companyId, (await sandboxEnvironment(companyId, plainProvider)).id);
      const awareAgent = await agent(companyId, (await sandboxEnvironment(companyId, awareProvider)).id);
      const plainTask = await issue(companyId, plainAgent.id, { projectId: project!.id });
      const awareTask = await issue(companyId, awareAgent.id, { projectId: project!.id });
      const awareLoose = await issue(companyId, awareAgent.id);

      for (const [worker, task] of [[plainAgent, plainTask], [awareAgent, awareTask], [awareAgent, awareLoose]] as const) {
        const run = await assign(worker.id, task.id);
        expect(await finishedRun(run.id)).toMatchObject({ status: "succeeded" });
      }
      expect(acquires).toHaveLength(3);
      const [plainLease, awareLease, looseLease] = acquires;
      expect(plainLease).toMatchObject({ pluginId: plain.id, params: { issueId: plainTask.id } });
      expect(plainLease!.params).not.toHaveProperty("projectId");
      expect(awareLease).toMatchObject({ pluginId: aware.id, params: { issueId: awareTask.id, projectId: project!.id } });
      expect(looseLease).toMatchObject({ pluginId: aware.id, params: { issueId: awareLoose.id } });
      expect(looseLease!.params).toHaveProperty("projectId", null);
    }, 60_000);

    it("a typed refusal while resuming a kept lease ends the 60 s resume loop at once and the run waits", async () => {
      succeed();
      const provider = `reuse${tag()}`;
      const companyId = await company();
      const driver = await plugin(provider, { supportsReusableLeases: true });
      const worker = fakeWorker(driver.id, {
        supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"],
      });
      worker.state.offline = false;
      const environment = await sandboxEnvironment(companyId, provider, { reuseLease: true });
      const builder = await agent(companyId, environment.id);
      const task = await issue(companyId, builder.id);
      heartbeat = heartbeatService(db, { pluginWorkerManager: worker.manager });

      // The first run leaves a lease the next run of the task resumes.
      const first = await assign(builder.id, task.id);
      expect(await finishedRun(first.id)).toMatchObject({ status: "succeeded" });
      expect(worker.callsOf("environmentAcquireLease")).toHaveLength(1);
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      // The task is reopened for more work.
      await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, task.id));

      // The computer went offline meanwhile. The refusal's text reads like a
      // transient failure, which the resume loop would retry for 60 s.
      worker.state.resumeError = offlineError("Timed out: the computer is offline.");
      const startedAt = Date.now();
      const second = await assign(builder.id, task.id);
      const deferred = await settledRun(second.id, 30_000);
      expect(Date.now() - startedAt).toBeLessThan(15_000);
      expect(worker.callsOf("environmentResumeLease")).toHaveLength(1);
      expect(deferred).toMatchObject({ status: "cancelled", errorCode: "environment_unavailable" });
      expect(deferred.resultJson).toMatchObject({ resourceWait: { kind: "environment", reason: "offline", scope: "target", environmentId: environment.id } });
      expect(await successorOf(second.id)).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: "environment_wait" });
      expect(worker.callsOf("environmentAcquireLease")).toHaveLength(1);
      expect(adapterExecute).toHaveBeenCalledTimes(1);
    }, 120_000);
  });

  describe("the kill switch", () => {
    it("with PAPERCLIP_ENVIRONMENT_WAITS=off, existing waits are promoted on the next tick and fail as setup failures while the computer is offline", async () => {
      const fixture = await offlineDevice();
      await drainHeartbeatRunsToQuiescence(db, heartbeat!);
      heartbeat = heartbeatService(db, {
        pluginWorkerManager: fixture.worker.manager,
        runtimeEnv: { ...process.env, PAPERCLIP_ENVIRONMENT_WAITS: "off" },
      });

      const sweep = await heartbeat.sweepResourceWaits();
      expect(sweep.killSwitchWoken).toBe(1);
      const promotion = await heartbeat.promoteDueScheduledRetries();
      expect(promotion.runIds).toContain(fixture.successor.id);
      await heartbeat.resumeQueuedRuns();

      const failed = await finishedRun(fixture.successor.id);
      expect(failed).toMatchObject({ status: "failed", errorCode: "setup_failed" });
      expect(fixture.worker.callsOf("environmentAcquireLease")).toHaveLength(2);
      const waits = await db.select().from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, fixture.companyId), inArray(heartbeatRuns.scheduledRetryReason, ["environment_wait"])));
      expect(waits.map((row) => row.id)).toEqual([fixture.successor.id]);
      expect(adapterExecute).not.toHaveBeenCalled();
    }, 60_000);
  });

  describe("a failing device preflight", () => {
    it("never fails the run: the lease decides", async () => {
      succeed();
      const provider = `box${tag()}`;
      const companyId = await company();
      const driver = await plugin(provider);
      const worker = fakeWorker(driver.id);
      worker.state.offline = false;
      const environment = await sandboxEnvironment(companyId, provider);
      const builder = await agent(companyId, environment.id);
      const task = await issue(companyId, builder.id);
      heartbeat = heartbeatService(db, { pluginWorkerManager: worker.manager });
      waitFaults.preflight = new Error("availability registry read failed");

      const run = await assign(builder.id, task.id);
      expect(await finishedRun(run.id)).toMatchObject({ status: "succeeded" });
      expect(adapterExecute).toHaveBeenCalledTimes(1);
      expect(worker.callsOf("environmentAcquireLease")).toHaveLength(1);
    }, 30_000);
  });

  describe("a resolved interaction continuation", () => {
    /** The board accepted what the assignee asked; the continuation starts on a computer that is offline, and waits. */
    async function waitingContinuation() {
      succeed();
      const provider = `box${tag()}`;
      const companyId = await company();
      const driver = await plugin(provider);
      const worker = fakeWorker(driver.id, { supportedMethods: ["environmentCheckAvailability"] });
      const environment = await sandboxEnvironment(companyId, provider);
      const builder = await agent(companyId, environment.id);
      const task = await issue(companyId, builder.id);
      const [interaction] = await db.insert(issueThreadInteractions).values({
        companyId,
        issueId: task.id,
        kind: "request_confirmation",
        status: "accepted",
        continuationPolicy: "wake_assignee_on_accept",
        createdByAgentId: builder.id,
        resolvedByUserId: "responsible-user",
        resolvedAt: new Date(),
        payload: { version: 1, prompt: "Go ahead with the migration?" },
        result: { version: 1, outcome: "accepted" },
      } as never).returning();
      heartbeat = heartbeatService(db, { pluginWorkerManager: worker.manager });
      const [queued] = await db.insert(heartbeatRuns).values({
        companyId,
        agentId: builder.id,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: {
          issueId: task.id,
          taskId: task.id,
          wakeReason: "issue_commented",
          mutation: "interaction",
          interactionId: interaction!.id,
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        },
      }).returning();
      await db.update(issues).set({ executionRunId: queued!.id, executionLockedAt: new Date() }).where(eq(issues.id, task.id));
      await heartbeat.resumeQueuedRuns();
      expect(await settledRun(queued!.id)).toMatchObject({ status: "cancelled", errorCode: "environment_unavailable" });
      const successor = await successorOf(queued!.id);
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      return { worker, task, interactionId: interaction!.id, successor: await runRow(successor.id) };
    }

    /** The computer is back: the sweep's check wakes the wait, and the next tick promotes and claims it. */
    async function computerBack(worker: ReturnType<typeof fakeWorker>) {
      worker.state.offline = false;
      await heartbeat!.sweepResourceWaits({ force: true });
      await heartbeat!.promoteDueScheduledRetries();
      await heartbeat!.resumeQueuedRuns();
    }

    it("stays one while it waits, and starts as one when the computer is back", async () => {
      const { worker, task, interactionId, successor } = await waitingContinuation();
      expect(successor).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: "environment_wait" });
      expect(successor.contextSnapshot).toMatchObject({ interactionId, interactionStatus: "accepted", resourceWaitResolvedInteraction: true });
      expect(isResolvedInteractionContinuationWakeContext(successor.contextSnapshot)).toBe(true);
      expect(await issueRow(task.id)).toMatchObject({ status: "in_progress", executionRunId: successor.id });

      await computerBack(worker);
      expect(await finishedRun(successor.id)).toMatchObject({ status: "succeeded" });
      expect(adapterExecute).toHaveBeenCalledTimes(1);
      // The continuation's own checkout claimed the task before the provider turn.
      expect(adapterContexts.get(successor.id)).toMatchObject({ interactionId, paperclipHarnessCheckedOut: true });
    }, 60_000);

    it("is cancelled at its claim when the task left in_progress while it waited", async () => {
      const { worker, task, successor } = await waitingContinuation();
      // The board moved the task back to todo; the waiting run still holds it.
      await db.update(issues).set({ status: "todo" }).where(eq(issues.id, task.id));

      await computerBack(worker);
      expect(await finishedRun(successor.id)).toMatchObject({ status: "cancelled", errorCode: "issue_not_in_progress" });
      expect(adapterExecute).not.toHaveBeenCalled();
      expect(worker.callsOf("environmentAcquireLease")).toHaveLength(1);
    }, 60_000);
  });

  describe("a PM's summary wake", () => {
    it("reaches a PM whose own run waits for its computer: that wait is untouched, and the summary waits too and shows when the PM runs", async () => {
      succeed();
      const companyId = await company();
      // The PM runs on an SSH computer that sleeps.
      sshStub.fail = silentPortFailure;
      const pmBox = await sshEnvironment(companyId);
      const pm = await agent(companyId, pmBox.id, { enabled: true, intervalSec: 86_400 });
      // Its worker's computer is up but does not take the task's project.
      const provider = `box${tag()}`;
      const driver = await plugin(provider);
      const worker = fakeWorker(driver.id);
      worker.state.leaseError = notAllowedError;
      const builder = await agent(companyId, (await sandboxEnvironment(companyId, provider)).id);
      heartbeat = heartbeatService(db, { pluginWorkerManager: worker.manager });

      // The PM's timer run (no issue) waits for its computer.
      const turn = await heartbeat.wakeup(pm.id, {
        source: "timer",
        triggerDetail: "system",
        reason: "heartbeat_timer",
        requestedByActorType: "system",
        requestedByActorId: "heartbeat_scheduler",
        contextSnapshot: { source: "scheduler", reason: "interval_elapsed" },
      });
      expect(turn).not.toBeNull();
      expect(await settledRun(turn!.id)).toMatchObject({ status: "cancelled", errorCode: "environment_unavailable" });
      const pmWait = await successorOf(turn!.id);
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      const pmWaitContext = (await runRow(pmWait.id)).contextSnapshot;
      expect(pmWaitContext).toMatchObject({ resourceWait: { version: 1, kind: "environment", reason: "unreachable", environmentId: pmBox.id } });

      // A task the PM created waits at once for an admission refusal, which tells the PM.
      const task = await issue(companyId, builder.id, { createdByAgentId: pm.id });
      const run = await assign(builder.id, task.id);
      expect(await settledRun(run.id)).toMatchObject({ status: "cancelled", errorCode: "environment_unavailable" });
      await successorOf(run.id);
      await drainHeartbeatRunsToQuiescence(db, heartbeat);

      // The PM's own wait is as it was; the summary got a run of its own, which waits for the PM's computer too.
      expect(await runRow(pmWait.id)).toMatchObject({ status: "scheduled_retry", contextSnapshot: pmWaitContext });
      const summaryRuns = await db.select().from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, pm.id), sql`${heartbeatRuns.contextSnapshot} -> 'resourceWaitNotice' is not null`));
      const summaryWait = summaryRuns.find((row) => row.status === "scheduled_retry");
      expect(summaryWait).toBeDefined();
      expect(summaryWait!.contextSnapshot).toMatchObject({
        resourceWaitNotice: { kind: "environment", reason: "not_allowed", issueIds: [task.id] },
        resourceWait: { version: 1, kind: "environment", environmentId: pmBox.id },
      });
      expect(adapterExecute).not.toHaveBeenCalled();

      // The PM's computer wakes up: both PM runs start, and the summary shows in its run.
      sshStub.fail = null;
      await heartbeat.sweepResourceWaits({ force: true });
      const promotion = await heartbeat.promoteDueScheduledRetries();
      expect(promotion.runIds).toEqual(expect.arrayContaining([pmWait.id, summaryWait!.id]));
      await heartbeat.resumeQueuedRuns();
      expect(await finishedRun(pmWait.id)).toMatchObject({ status: "succeeded" });
      expect(await finishedRun(summaryWait!.id)).toMatchObject({ status: "succeeded" });
      const summaryContext = adapterContexts.get(summaryWait!.id);
      const turnContext = adapterContexts.get(pmWait.id);
      expect(summaryContext).not.toHaveProperty("issueId");
      expect(String(summaryContext?.paperclipTaskMarkdown)).toContain("Paperclip resource wait notice:");
      expect(String(summaryContext?.paperclipTaskMarkdown)).toContain("(project not enabled on the device)");
      expect(turnContext).toBeDefined();
      expect(String(turnContext?.paperclipTaskMarkdown ?? "")).not.toContain("Paperclip resource wait notice:");
      const [pmEpisode] = await db.select().from(resourceWaitEpisodes)
        .where(and(eq(resourceWaitEpisodes.agentId, pm.id), eq(resourceWaitEpisodes.environmentId, pmBox.id)));
      expect(pmEpisode).toMatchObject({ resolution: "resolved" });
    }, 90_000);
  });
});
