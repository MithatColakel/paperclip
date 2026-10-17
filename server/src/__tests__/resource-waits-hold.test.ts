import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  aiAccountAgentBindings,
  aiAccountHostEnvironments,
  aiAccountHosts,
  aiAccountProjects,
  aiAccountRunSlots,
  aiAccounts,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  environmentAvailability,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
  issues,
  plugins,
  projects,
  resourceWaitEpisodes,
} from "@paperclipai/db";
import {
  RESOURCE_WAIT_LANE_BY_KIND,
  buildResourceWaitContext,
  readResourceWaitContext,
  type ResourceWaitKind,
  type ResourceWaitReason,
  type ResourceWaitScope,
} from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createRunDispatch, isNonAssigneeWorkspaceBusyRetry } from "../modules/run-dispatch/index.js";
import { environmentAvailabilityService } from "../services/environment-availability.js";
import { legacyExecutionNeedsReconciliation } from "../services/legacy-execution-recovery.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import {
  accountWaitDeferral,
  claimAccountProbe,
  createResourceWaits,
  environmentWaitDeferral,
  handOverOrAbandon,
  openEpisode,
  readScheduledRetryResourceWaits,
  readWakeEpochs,
  resourceWaitJitterMs,
  setEpisodeCurrentRun,
  wakeResourceWaits,
  type ResourceWaitDeferral,
  type ResourceWaitDeps,
  type ResourceWaitIssueNotice,
  type ResourceWaitScheduleOptions,
} from "../services/resource-waits/index.js";

// SSH probes never leave this test: every probe is stubbed, and an unexpected one fails.
const probeStub = vi.hoisted(() => ({
  impl: null as null | ((environment: { id: string }, options: { companyId?: string | null }) => Promise<unknown>),
}));
vi.mock("../services/environment-probe.js", () => ({
  probeEnvironment: async (_db: unknown, environment: { id: string }, options: { companyId?: string | null }) => {
    if (!probeStub.impl) throw new Error("SSH probes are stubbed in this test file");
    return probeStub.impl(environment, options);
  },
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres resource-wait tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type AgentRow = typeof agents.$inferSelect;
type RunRow = typeof heartbeatRuns.$inferSelect;
type EnvironmentRow = typeof environments.$inferSelect;

describeEmbeddedPostgres("resource waits (database)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let localEnvironment: EnvironmentRow;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-resource-waits-hold-");
    db = createDb(database.connectionString);
  }, 120_000);

  afterAll(async () => {
    // A checkpoint now leaves the shutdown little to write, so the cluster
    // stops (and its data directory goes) within the cleanup's time bound.
    await db?.execute(sql`checkpoint`).catch(() => undefined);
    await database?.cleanup();
  });

  beforeEach(async () => {
    probeStub.impl = null;
    await db.execute(sql`truncate table companies, plugins, ai_account_hosts, ai_accounts, environments, "user" cascade`);
    [localEnvironment] = await db.insert(environments).values({ name: "Local", driver: "local" }).returning();
  });

  const tag = () => randomUUID().slice(0, 8);
  const seconds = (now: Date, n: number) => new Date(now.getTime() + n * 1000);

  async function company() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: `Company ${tag()}`, issuePrefix: `R${id.replaceAll("-", "").slice(0, 7).toUpperCase()}` });
    return id;
  }

  async function agent(companyId: string, overrides: Partial<typeof agents.$inferInsert> = {}): Promise<AgentRow> {
    const [row] = await db.insert(agents).values({
      companyId,
      name: `Agent ${tag()}`,
      adapterType: "claude_local",
      status: "active",
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      ...overrides,
    }).returning();
    return row!;
  }

  async function environment(driver: "ssh" | "sandbox", config: Record<string, unknown>): Promise<EnvironmentRow> {
    const [row] = await db.insert(environments).values({ name: `${driver} ${tag()}`, driver, config }).returning();
    return row!;
  }

  async function issue(companyId: string, assigneeAgentId: string, overrides: Partial<typeof issues.$inferInsert> = {}) {
    const [row] = await db.insert(issues).values({
      companyId,
      title: `Task ${tag()}`,
      status: "in_progress",
      priority: "medium",
      assigneeAgentId,
      ...overrides,
    }).returning();
    return row!;
  }

  async function member(companyId: string, userId: string) {
    const at = new Date();
    await db.insert(authUsers).values({ id: userId, name: userId, email: `${userId}@example.com`, emailVerified: true, createdAt: at, updatedAt: at }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
  }

  async function account(ownerUserId: string, overrides: Partial<typeof aiAccounts.$inferInsert> = {}) {
    const [row] = await db.insert(aiAccounts).values({
      credentialType: "subscription",
      label: `Max ${tag()}`,
      ownerUserId,
      createdByUserId: ownerUserId,
      credentialMaterial: { provider: "local_encrypted", ciphertext: tag() },
      credentialFingerprint: randomUUID(),
      ...overrides,
    }).returning();
    return row!;
  }

  async function bind(agentRow: AgentRow, accountId: string | null, mode: "pool_account" | "device_login" = "pool_account") {
    await db.insert(aiAccountAgentBindings).values({ agentId: agentRow.id, companyId: agentRow.companyId, mode, accountId })
      .onConflictDoUpdate({ target: aiAccountAgentBindings.agentId, set: { mode, accountId, updatedAt: new Date() } });
  }

  async function runRow(id: string): Promise<RunRow> {
    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
    return row!;
  }

  async function episodeRow(id: string) {
    const [row] = await db.select().from(resourceWaitEpisodes).where(eq(resourceWaitEpisodes.id, id));
    return row!;
  }

  /** A lane successor that is the current run of its episode, holding the issue lock. */
  async function waitingRun(input: {
    agent: AgentRow;
    kind: ResourceWaitKind;
    reason: ResourceWaitReason;
    scope: ResourceWaitScope;
    dueAt: Date;
    issueId?: string | null;
    environmentId?: string | null;
    deviceId?: string | null;
    accountId?: string | null;
    since?: Date;
    resumeAt?: Date | null;
  }) {
    const lane = RESOURCE_WAIT_LANE_BY_KIND[input.kind];
    const issueId = input.issueId ?? null;
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: input.agent.companyId,
      agentId: input.agent.id,
      invocationSource: "automation",
      status: "scheduled_retry",
      scheduledRetryReason: lane,
      scheduledRetryAt: input.dueAt,
      scheduledRetryAttempt: 1,
      contextSnapshot: { ...(issueId ? { issueId } : {}), retryReason: lane },
    }).returning();
    const resourceKey = input.kind === "environment" ? `environment:${input.environmentId}`
      : input.kind === "ai_account" ? `account:${input.accountId ?? "none"}` : `device:${input.deviceId}`;
    const [episode] = await db.insert(resourceWaitEpisodes).values({
      companyId: input.agent.companyId,
      agentId: input.agent.id,
      issueId,
      kind: input.kind,
      reason: input.reason,
      scope: input.scope,
      resourceKey,
      environmentId: input.environmentId ?? null,
      deviceId: input.deviceId ?? null,
      accountId: input.accountId ?? null,
      since: input.since ?? new Date(),
      resumeAt: input.resumeAt ?? null,
      currentRunId: run!.id,
    }).returning();
    const context = buildResourceWaitContext({
      episodeId: episode!.id,
      kind: input.kind,
      reason: input.reason,
      scope: input.scope,
      environmentId: input.environmentId ?? null,
      environmentName: null,
      deviceId: input.deviceId ?? null,
      deviceName: null,
      accountId: input.accountId ?? null,
      accountLabel: null,
      resumeAt: null,
      resumeAtSource: null,
      message: null,
    });
    await db.update(heartbeatRuns)
      .set({ contextSnapshot: { ...(issueId ? { issueId } : {}), retryReason: lane, resourceWait: context } })
      .where(eq(heartbeatRuns.id, run!.id));
    if (issueId) await db.update(issues).set({ executionRunId: run!.id }).where(eq(issues.id, issueId));
    return { run: await runRow(run!.id), episode: episode! };
  }

  function makeDeps(options: {
    gate?: ResourceWaitDeps["evaluateScheduledRetryGate"];
    refuseSchedule?: boolean;
    beforeSuccessorInsert?: (run: RunRow) => Promise<void>;
    afterSuccessorInsert?: (successor: RunRow) => Promise<void>;
    /** Check like heartbeat's scheduleBoundedRetryForRun does for the lanes (W8 H7): the gate on the run's row, then the lock recheck. */
    h7?: boolean;
  } = {}) {
    const calls = {
      events: [] as Array<{ runId: string; message?: string; level?: string }>,
      notices: [] as ResourceWaitIssueNotice[],
      wakes: [] as Array<{ agentId: string; contextSnapshot: Record<string, unknown>; payload: unknown }>,
      released: [] as string[],
      agentStatus: [] as string[],
      scheduled: [] as ResourceWaitScheduleOptions[],
    };
    const runDispatch = createRunDispatch(db);
    const deps: ResourceWaitDeps = {
      async setRunStatusIfRunning(runId, status, patch) {
        const [row] = await db.update(heartbeatRuns).set({ ...patch, status, updatedAt: new Date() })
          .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "running"))).returning();
        if (row) return { run: row, updated: true };
        const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        return { run: current ?? null, updated: false };
      },
      async setWakeupStatus() {},
      async getRun(runId) {
        const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        return row ?? null;
      },
      async getAgent(agentId) {
        const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
        return row ?? null;
      },
      async scheduleBoundedRetryForRun(run, _agent, opts) {
        calls.scheduled.push(opts);
        if (options.refuseSchedule) {
          return { outcome: "not_scheduled", reason: "Scheduled retry suppressed because issue reached terminal status (done)", errorCode: "issue_terminal_status", issueId: null };
        }
        const issueId = typeof run.contextSnapshot?.issueId === "string" ? run.contextSnapshot.issueId : null;
        if (options.h7) {
          const gate = await runDispatch.evaluateScheduledRetryGate({ runId: run.id, companyId: run.companyId, retryReasonOverride: opts.retryReason, now: opts.now });
          if (!gate.allowed) return { outcome: "not_scheduled", reason: gate.reason, errorCode: gate.errorCode, issueId: gate.issueId };
          if (issueId && !isNonAssigneeWorkspaceBusyRetry(opts.retryReason, run.contextSnapshot ?? {})) {
            const [locked] = await db.select({ executionRunId: issues.executionRunId }).from(issues).where(eq(issues.id, issueId));
            if (locked?.executionRunId !== run.id) {
              return { outcome: "not_scheduled", reason: "the task execution lock changed", errorCode: "issue_execution_lock_changed", issueId };
            }
          }
        }
        await options.beforeSuccessorInsert?.(run);
        const [successor] = await db.insert(heartbeatRuns).values({
          companyId: run.companyId,
          agentId: run.agentId,
          invocationSource: "automation",
          status: "scheduled_retry",
          retryOfRunId: run.id,
          scheduledRetryAt: new Date(opts.now.getTime() + opts.delayMs),
          scheduledRetryAttempt: opts.maxAttempts,
          scheduledRetryReason: opts.retryReason,
          contextSnapshot: { ...run.contextSnapshot, retryReason: opts.retryReason, wakeReason: opts.wakeReason, ...opts.contextPatch },
          // As heartbeat's insert: created in the scheduling transaction.
          createdAt: opts.now,
          updatedAt: opts.now,
        }).returning();
        if (issueId) {
          await db.update(issues).set({ executionRunId: successor!.id })
            .where(and(eq(issues.id, issueId), eq(issues.executionRunId, run.id)));
        }
        await options.afterSuccessorInsert?.(successor!);
        return { outcome: "scheduled", run: successor! };
      },
      async appendRunEvent(run, event) {
        calls.events.push({ runId: run.id, message: event.message, level: event.level });
      },
      async releaseIssueExecutionAndPromote(run) {
        calls.released.push(run.id);
        await db.update(issues).set({ executionRunId: null }).where(eq(issues.executionRunId, run.id));
      },
      async finalizeAgentStatus(agentId) {
        calls.agentStatus.push(agentId);
      },
      async enqueueWakeup(agentId, opts) {
        calls.wakes.push({ agentId, contextSnapshot: opts.contextSnapshot, payload: opts.payload });
        return null;
      },
      async addIssueSystemNotice(input) {
        calls.notices.push(input);
        return null;
      },
      evaluateScheduledRetryGate: options.gate ?? ((input) => runDispatch.evaluateScheduledRetryGate(input)),
    };
    return { deps, calls };
  }

  function waits(deps: ResourceWaitDeps, extra: Partial<Parameters<typeof createResourceWaits>[0]> = {}) {
    return createResourceWaits({ db, deps, environmentWaitsEnabled: true, random: () => 0.5, ...extra });
  }

  async function makeDue(runId: string, at: Date) {
    await db.update(heartbeatRuns).set({ scheduledRetryAt: at, updatedAt: at }).where(eq(heartbeatRuns.id, runId));
  }

  async function counts() {
    const [row] = await db.execute<{ runs: string; events: string; wakeups: string; episodes: string }>(sql`
      select (select count(*) from heartbeat_runs)::text as runs,
             (select count(*) from heartbeat_run_events)::text as events,
             (select count(*) from agent_wakeup_requests)::text as wakeups,
             (select count(*) from resource_wait_episodes)::text as episodes
    `);
    return row;
  }

  /** An agent pinned to an SSH environment with an in-progress issue. */
  async function envFixture() {
    const companyId = await company();
    const env = await environment("ssh", { host: "runner.invalid", port: 22, username: "runner" });
    const worker = await agent(companyId, { defaultEnvironmentId: env.id });
    const task = await issue(companyId, worker.id);
    return { companyId, env, worker, task };
  }

  describe("holdDueWaits", () => {
    it("re-arms a held run in place: no new rows, no events, bookkeeping in the episode", async () => {
      const { env, worker, task } = await envFixture();
      const now = new Date();
      await environmentAvailabilityService(db).markUnavailable(env.id, { reason: "offline", source: "lease_error", now });
      const { run, episode } = await waitingRun({
        agent: worker, kind: "environment", reason: "offline", scope: "target",
        dueAt: seconds(now, -1), issueId: task.id, environmentId: env.id,
      });
      const before = await counts();
      const { deps } = makeDeps();
      const result = await waits(deps).holdDueWaits({ now });
      expect(result).toMatchObject({ examined: 1, held: 1, proceeding: 0, gateSuppressed: 0, rearmLost: 0 });
      const after = await runRow(run.id);
      expect(after.status).toBe("scheduled_retry");
      expect(after.scheduledRetryAt!.getTime()).toBeGreaterThanOrEqual(now.getTime() + 30_000);
      expect(after.scheduledRetryAt!.getTime()).toBeLessThanOrEqual(now.getTime() + 5 * 60_000);
      expect(await counts()).toEqual(before);
      const bookkeeping = await episodeRow(episode.id);
      expect(bookkeeping.nextCheckAt?.getTime()).toBe(after.scheduledRetryAt!.getTime());
      expect(bookkeeping.gateCheckedAt?.getTime()).toBe(now.getTime());
      // The issue lock stays with the waiting run.
      expect((await db.select().from(issues).where(eq(issues.id, task.id)))[0]!.executionRunId).toBe(run.id);
    });

    it("loses the compare-and-set to a wake that lands between its read and its re-arm", async () => {
      const { env, worker, task } = await envFixture();
      const now = new Date();
      await environmentAvailabilityService(db).markUnavailable(env.id, { reason: "offline", source: "lease_error", now });
      const { run } = await waitingRun({
        agent: worker, kind: "environment", reason: "offline", scope: "target",
        dueAt: seconds(now, -1), issueId: task.id, environmentId: env.id,
      });
      const runDispatch = createRunDispatch(db);
      // The gate runs after the read and before the re-arm: wake there.
      const { deps } = makeDeps({
        gate: async (input) => {
          await wakeResourceWaits(db, { runIds: [input.runId] }, { now });
          return runDispatch.evaluateScheduledRetryGate(input);
        },
      });
      const result = await waits(deps).holdDueWaits({ now });
      expect(result).toMatchObject({ held: 0, rearmLost: 1 });
      expect((await runRow(run.id)).scheduledRetryAt!.getTime()).toBeLessThanOrEqual(now.getTime());

      // A wake after a re-arm makes the row due again.
      const { deps: plain } = makeDeps();
      const later = seconds(now, 1);
      expect((await waits(plain).holdDueWaits({ now: later })).held).toBe(1);
      expect((await runRow(run.id)).scheduledRetryAt!.getTime()).toBeGreaterThan(later.getTime());
      const woken = await wakeResourceWaits(db, { environmentIds: [env.id] }, { now: later });
      expect(woken.runIds).toEqual([run.id]);
      expect((await runRow(run.id)).scheduledRetryAt!.getTime()).toBe(later.getTime());
    });

    it("leaves a closed issue's run due so run-dispatch cancels it and releases the lock; the episode is abandoned", async () => {
      const { env, worker, task } = await envFixture();
      const now = new Date();
      await environmentAvailabilityService(db).markUnavailable(env.id, { reason: "offline", source: "lease_error", now });
      const { run, episode } = await waitingRun({
        agent: worker, kind: "environment", reason: "offline", scope: "target",
        dueAt: seconds(now, -1), issueId: task.id, environmentId: env.id,
      });
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, task.id));
      const { deps, calls } = makeDeps();
      const result = await waits(deps).holdDueWaits({ now });
      expect(result).toMatchObject({ gateSuppressed: 1, held: 0 });
      expect((await runRow(run.id)).scheduledRetryAt!.getTime()).toBeLessThanOrEqual(now.getTime());
      expect(await episodeRow(episode.id)).toMatchObject({ resolution: "abandoned" });
      // The last wait on the environment ended: its registry row goes.
      expect(await db.select().from(environmentAvailability).where(eq(environmentAvailability.environmentId, env.id))).toEqual([]);
      expect(calls.notices).toEqual([]);

      await createRunDispatch(db).promoteDueScheduledRetries({ now, cutoff: null });
      const cancelled = await runRow(run.id);
      expect(cancelled.status).toBe("cancelled");
      expect((await db.select().from(issues).where(eq(issues.id, task.id)))[0]!.executionRunId).toBeNull();
      // A lane run cancelled before it started needs no reconciliation.
      expect(legacyExecutionNeedsReconciliation(cancelled)).toBe(false);
    });

    it("cancels a waiting run on a task moved to blocked in the same tick, releases its lock and abandons the episode", async () => {
      const { env, worker, task } = await envFixture();
      const now = new Date();
      await environmentAvailabilityService(db).markUnavailable(env.id, { reason: "offline", source: "lease_error", now });
      const { run, episode } = await waitingRun({
        agent: worker, kind: "environment", reason: "offline", scope: "target",
        dueAt: seconds(now, -1), issueId: task.id, environmentId: env.id,
      });
      // As issueService.update records it: the block came after the wait began.
      await db.update(issues).set({ status: "blocked", blockedTransitionAt: new Date(run.createdAt.getTime() + 1_000) }).where(eq(issues.id, task.id));
      const { deps, calls } = makeDeps();
      expect(await waits(deps).holdDueWaits({ now })).toMatchObject({ gateSuppressed: 1, held: 0 });
      expect(await episodeRow(episode.id)).toMatchObject({ resolution: "abandoned" });
      expect(calls.notices).toEqual([]);
      await createRunDispatch(db).promoteDueScheduledRetries({ now, cutoff: null });
      expect(await runRow(run.id)).toMatchObject({ status: "cancelled", errorCode: "issue_blocked" });
      expect((await db.select().from(issues).where(eq(issues.id, task.id)))[0]!.executionRunId).toBeNull();
    });

    it("keeps the wait of a run woken on a task that was blocked an hour before (a reply to the blocked worker)", async () => {
      const { env, worker, task } = await envFixture();
      const now = new Date();
      await db.update(issues).set({ status: "blocked", blockedTransitionAt: seconds(now, -3600) }).where(eq(issues.id, task.id));
      await environmentAvailabilityService(db).markUnavailable(env.id, { reason: "offline", source: "lease_error", now });
      // The PM's reply wakes the worker while the task stays blocked; its device is offline.
      const [woken] = await db.insert(heartbeatRuns).values({
        companyId: worker.companyId, agentId: worker.id, status: "running", startedAt: now, contextSnapshot: { issueId: task.id },
      }).returning();
      await db.update(issues).set({ executionRunId: woken!.id }).where(eq(issues.id, task.id));
      const { deps, calls } = makeDeps({ h7: true });
      const service = waits(deps, { now: () => now });
      const result = await service.finalizeDeferral(woken!, environmentWaitDeferral({ reason: "offline", scope: "target", environment: { id: env.id, name: env.name } }));
      expect(result).toMatchObject({ outcome: "scheduled" });
      const successorId = ("successorRunId" in result && result.successorRunId) || "";
      expect(calls.released).toEqual([]);
      expect(await createRunDispatch(db).evaluateScheduledRetryGate({ runId: successorId, companyId: worker.companyId, retryReasonOverride: "environment_wait", now }))
        .toEqual({ allowed: true });
      const at = seconds(now, 60);
      await makeDue(successorId, at);
      expect(await service.holdDueWaits({ now: at })).toMatchObject({ examined: 1, held: 1, gateSuppressed: 0 });
      // The device is back: the wait proceeds and is promoted, not cancelled.
      await environmentAvailabilityService(db).markAvailable(env.id, { source: "check", now: at });
      const later = seconds(now, 120);
      await makeDue(successorId, later);
      expect(await service.holdDueWaits({ now: later })).toMatchObject({ examined: 1, proceeding: 1 });
      await createRunDispatch(db).promoteDueScheduledRetries({ now: later, cutoff: null });
      expect(await runRow(successorId)).toMatchObject({ status: "queued" });
      expect(await createRunDispatch(db).cancelStaleQueuedRun({ runId: successorId, companyId: worker.companyId, expectedStatus: "queued", now: later }))
        .toMatchObject({ outcome: "not_stale" });
      expect((await db.select().from(issues).where(eq(issues.id, task.id)))[0]!.executionRunId).toBe(successorId);
    });

    it("examines every due wait, a page at a time, so none past the first page is promoted unchecked", async () => {
      const { env, worker, task, companyId } = await envFixture();
      const now = new Date();
      await environmentAvailabilityService(db).markUnavailable(env.id, { reason: "offline", source: "lease_error", now });
      // The oldest wait's agent moved to the Local environment: it proceeds and stays due.
      await db.update(agents).set({ defaultEnvironmentId: localEnvironment.id }).where(eq(agents.id, worker.id));
      const moved = await waitingRun({
        agent: worker, kind: "environment", reason: "offline", scope: "target", dueAt: seconds(now, -10), issueId: task.id, environmentId: env.id,
      });
      const held: Array<Awaited<ReturnType<typeof waitingRun>>> = [];
      for (let index = 1; index < 5; index += 1) {
        const row = await agent(companyId, { defaultEnvironmentId: env.id });
        // The last two are due at the same moment: the page cursor breaks the tie.
        held.push(await waitingRun({
          agent: row, kind: "environment", reason: "offline", scope: "target",
          dueAt: seconds(now, -10 + Math.min(index, 3)), issueId: (await issue(companyId, row.id)).id, environmentId: env.id,
        }));
      }
      const { deps } = makeDeps();
      // Each row exactly once: the one that proceeds stays due but is not examined again.
      expect(await waits(deps).holdDueWaits({ now, limit: 2 })).toMatchObject({ examined: 5, held: 4, proceeding: 1 });
      // Only the checked one is left due for run-dispatch.
      await createRunDispatch(db).promoteDueScheduledRetries({ now, cutoff: null });
      expect((await runRow(moved.run.id)).status).toBe("queued");
      for (const { run } of held) {
        const row = await runRow(run.id);
        expect(row.status).toBe("scheduled_retry");
        expect(row.scheduledRetryAt!.getTime()).toBeGreaterThan(now.getTime());
      }
    });

    it("keeps the environment a wait recorded where the instance forces Kubernetes, instead of treating it as changed", async () => {
      const general = { executionMode: "kubernetes" };
      await db.insert(instanceSettings).values({ singletonKey: "default", general, experimental: {} })
        .onConflictDoUpdate({ target: instanceSettings.singletonKey, set: { general } });
      try {
        const { env, worker, task, companyId } = await envFixture();
        const now = new Date();
        await environmentAvailabilityService(db).markUnavailable(env.id, { reason: "offline", source: "lease_error", now });
        await waitingRun({ agent: worker, kind: "environment", reason: "offline", scope: "target", dueAt: seconds(now, -1), issueId: task.id, environmentId: env.id });
        const upgrading = await agent(companyId, { defaultEnvironmentId: env.id });
        const admission = await waitingRun({
          agent: upgrading, kind: "environment", reason: "plugin_upgrade_pending", scope: "admission",
          dueAt: seconds(now, -1), issueId: (await issue(companyId, upgrading.id)).id, environmentId: env.id,
        });
        await db.update(resourceWaitEpisodes).set({ nextCheckAt: seconds(now, 40 * 60) }).where(eq(resourceWaitEpisodes.id, admission.episode.id));
        const { deps } = makeDeps();
        // The target wait holds on its fresh registry row; the admission wait keeps its 40-minute backoff.
        expect(await waits(deps).holdDueWaits({ now })).toMatchObject({ examined: 2, held: 2, proceeding: 0 });
        expect((await runRow(admission.run.id)).scheduledRetryAt!.getTime()).toBe(now.getTime() + 5 * 60_000);
      } finally {
        await db.delete(instanceSettings);
      }
    });

    it("runs the gate at most every 5 minutes per row and never re-arms further than that", async () => {
      const { env, worker, task } = await envFixture();
      const now = new Date();
      await environmentAvailabilityService(db).markUnavailable(env.id, {
        reason: "maintenance", source: "lease_error", now, retryAfter: seconds(now, 3 * 3600),
      });
      const { run } = await waitingRun({
        agent: worker, kind: "environment", reason: "maintenance", scope: "target",
        dueAt: seconds(now, -1), issueId: task.id, environmentId: env.id,
      });
      let gateCalls = 0;
      const runDispatch = createRunDispatch(db);
      const { deps } = makeDeps({ gate: async (input) => { gateCalls += 1; return runDispatch.evaluateScheduledRetryGate(input); } });
      const service = waits(deps);
      await service.holdDueWaits({ now });
      expect((await runRow(run.id)).scheduledRetryAt!.getTime()).toBe(now.getTime() + 5 * 60_000);
      await makeDue(run.id, seconds(now, 60));
      await service.holdDueWaits({ now: seconds(now, 61) });
      expect(gateCalls).toBe(1);
      await makeDue(run.id, seconds(now, 300));
      await service.holdDueWaits({ now: seconds(now, 301) });
      expect(gateCalls).toBe(2);
    });
  });

  describe("canProceed matrix (spec 7.1)", () => {
    async function decideOnce(service: ReturnType<typeof waits>, runId: string, at: Date) {
      await makeDue(runId, seconds(at, -1));
      const result = await service.holdDueWaits({ now: at });
      expect(result.examined).toBe(1);
      return result.held === 1 ? "held" : "proceeding";
    }

    it.each(["offline", "paused", "maintenance", "updating", "unreachable"] as const)(
      "target %s holds while the registry says unavailable and proceeds when it clears, goes stale or moves",
      async (reason) => {
        const { env, worker, task } = await envFixture();
        const now = new Date();
        const registry = environmentAvailabilityService(db);
        await registry.markUnavailable(env.id, { reason, source: "lease_error", now });
        const { run } = await waitingRun({ agent: worker, kind: "environment", reason, scope: "target", dueAt: now, issueId: task.id, environmentId: env.id });
        const { deps } = makeDeps();
        const service = waits(deps);
        expect(await decideOnce(service, run.id, now)).toBe("held");
        await registry.markAvailable(env.id, { source: "check", now });
        expect(await decideOnce(service, run.id, now)).toBe("proceeding");
        await registry.markUnavailable(env.id, { reason, source: "lease_error", now });
        // Checked more than 10 minutes ago: a real attempt instead.
        expect(await decideOnce(service, run.id, new Date(now.getTime() + 11 * 60_000))).toBe("proceeding");
        await registry.markRetired([env.id], { now });
        expect(await decideOnce(service, run.id, now)).toBe("proceeding");
        await registry.markUnavailable(env.id, { reason, source: "lease_error", now });
        await db.update(agents).set({ defaultEnvironmentId: localEnvironment.id }).where(eq(agents.id, worker.id));
        expect(await decideOnce(service, run.id, now)).toBe("proceeding");
      },
    );

    it.each(["not_allowed", "not_serving", "stopped", "busy", "throttled", "restarting", "plugin_upgrade_pending", "other"] as const)(
      "admission %s holds until its backoff passes, then makes one real attempt",
      async (reason) => {
        const { env, worker, task } = await envFixture();
        const now = new Date();
        const { run, episode } = await waitingRun({ agent: worker, kind: "environment", reason, scope: "admission", dueAt: now, issueId: task.id, environmentId: env.id });
        await db.update(resourceWaitEpisodes).set({ nextCheckAt: seconds(now, 40 * 60) }).where(eq(resourceWaitEpisodes.id, episode.id));
        const { deps } = makeDeps();
        const service = waits(deps);
        expect(await decideOnce(service, run.id, now)).toBe("held");
        // Re-checked within the gate interval; the backoff itself stays in the episode.
        expect((await runRow(run.id)).scheduledRetryAt!.getTime()).toBe(now.getTime() + 5 * 60_000);
        expect((await episodeRow(episode.id)).nextCheckAt!.getTime()).toBe(seconds(now, 40 * 60).getTime());
        expect(await decideOnce(service, run.id, seconds(now, 40 * 60))).toBe("proceeding");
      },
    );

    it("spaces admission attempts 5, 10, 20, 40, 60 and 60 min apart, and a wake gives one at once", async () => {
      const { env, worker, task } = await envFixture();
      const t0 = new Date();
      let clock = t0;
      const { deps, calls } = makeDeps();
      const service = waits(deps, { now: () => clock });
      const deferral = () => environmentWaitDeferral({ reason: "not_serving", scope: "admission", environment: { id: env.id, name: env.name } });
      /** The run makes its attempt at `at`, and the driver refuses it again. */
      const attempt = async (runId: string, at: Date) => {
        clock = at;
        await db.update(heartbeatRuns).set({ status: "running", startedAt: at }).where(eq(heartbeatRuns.id, runId));
        const result = await service.finalizeDeferral(await runRow(runId), deferral());
        expect(result.outcome).toBe("scheduled");
        return ("successorRunId" in result && result.successorRunId) || "";
      };
      /** Runs the hold at each due time until the run proceeds; returns that time. */
      const nextAttemptAt = async (runId: string) => {
        for (let pass = 0; pass < 20; pass += 1) {
          const due = (await runRow(runId)).scheduledRetryAt!;
          const result = await service.holdDueWaits({ now: due });
          expect(result.examined).toBe(1);
          if (result.proceeding === 1) return due;
          // Held, but never further than the gate interval.
          expect((await runRow(runId)).scheduledRetryAt!.getTime() - due.getTime()).toBeLessThanOrEqual(5 * 60_000);
        }
        throw new Error("the wait never made an attempt");
      };
      const [first] = await db.insert(heartbeatRuns).values({
        companyId: worker.companyId, agentId: worker.id, status: "running", startedAt: t0, contextSnapshot: { issueId: task.id },
      }).returning();
      await db.update(issues).set({ executionRunId: first!.id }).where(eq(issues.id, task.id));
      let runId = await attempt(first!.id, t0);
      const spacing: number[] = [];
      let last = t0;
      for (let index = 0; index < 6; index += 1) {
        const at = await nextAttemptAt(runId);
        spacing.push((at.getTime() - last.getTime()) / 60_000);
        last = at;
        runId = await attempt(runId, at);
      }
      expect(spacing).toEqual([5, 10, 20, 40, 60, 60]);
      // One episode the whole time, and the deliberate wait was never reported on the issue.
      expect(await db.select().from(resourceWaitEpisodes)).toHaveLength(1);
      expect(calls.notices.filter((notice) => notice.body.includes("does not serve"))).toHaveLength(1);

      // The driver says the device serves the company again: one real attempt now.
      const wakeAt = seconds(last, 60);
      const woken = await wakeResourceWaits(db, { environmentIds: [env.id] }, { now: wakeAt });
      expect(woken.runIds).toEqual([runId]);
      expect(await service.holdDueWaits({ now: wakeAt })).toMatchObject({ examined: 1, proceeding: 1 });
    });

    it("kill switch: every environment wait proceeds", async () => {
      const { env, worker, task } = await envFixture();
      const now = new Date();
      await environmentAvailabilityService(db).markUnavailable(env.id, { reason: "offline", source: "lease_error", now });
      const { run } = await waitingRun({ agent: worker, kind: "environment", reason: "offline", scope: "target", dueAt: now, issueId: task.id, environmentId: env.id });
      const { deps } = makeDeps();
      expect(await decideOnce(waits(deps, { environmentWaitsEnabled: false }), run.id, now)).toBe("proceeding");
    });

    /** An agent bound to an owned account, pinned to the Local environment. */
    async function accountFixture(accountOverrides: Partial<typeof aiAccounts.$inferInsert> = {}) {
      const companyId = await company();
      await member(companyId, "owner-1");
      const worker = await agent(companyId, { defaultEnvironmentId: localEnvironment.id });
      const pool = await account("owner-1", accountOverrides);
      await bind(worker, pool.id);
      return { companyId, worker, pool };
    }

    it.each([
      ["usage_limit", "provider_quota"],
      ["credit_balance", "credit_balance"],
    ] as const)("%s holds until the reset and proceeds after a clear", async (reason, limitReason) => {
      const now = new Date();
      const { worker, pool } = await accountFixture({
        exhaustedUntil: seconds(now, 3600), limitReason, limitSource: "provider", limitStrikes: 1,
      });
      const { run } = await waitingRun({ agent: worker, kind: "ai_account", reason, scope: "account", dueAt: now, accountId: pool.id });
      const { deps } = makeDeps();
      const service = waits(deps);
      expect(await decideOnce(service, run.id, now)).toBe("held");
      // An hour away, but the hold re-checks within the gate interval.
      expect((await runRow(run.id)).scheduledRetryAt!.getTime()).toBe(now.getTime() + 5 * 60_000);
      // Shortly before the reset the hold aims at the reset plus this run's jitter.
      const nearReset = seconds(now, 3600 - 60);
      expect(await decideOnce(service, run.id, nearReset)).toBe("held");
      expect((await runRow(run.id)).scheduledRetryAt!.getTime()).toBe(seconds(now, 3600).getTime() + resourceWaitJitterMs(run.id));
      await db.update(aiAccounts).set({ exhaustedUntil: null, limitStrikes: 0, limitSource: null }).where(eq(aiAccounts.id, pool.id));
      expect(await decideOnce(service, run.id, now)).toBe("proceeding");
    });

    it("auth_unconfirmed waits out its 10 minutes, then proceeds; a confirmed sign-out re-plans", async () => {
      const now = new Date();
      const { worker, pool } = await accountFixture();
      const { run } = await waitingRun({
        agent: worker, kind: "ai_account", reason: "auth_unconfirmed", scope: "account", dueAt: now, accountId: pool.id, resumeAt: seconds(now, 600),
      });
      const { deps } = makeDeps();
      const service = waits(deps);
      expect(await decideOnce(service, run.id, now)).toBe("held");
      expect(await decideOnce(service, run.id, seconds(now, 601))).toBe("proceeding");
      await db.update(aiAccounts).set({ status: "auth_failed" }).where(eq(aiAccounts.id, pool.id));
      expect(await decideOnce(service, run.id, now)).toBe("proceeding");
    });

    it.each([
      ["signed_out", { status: "auth_failed" as const }, { status: "active" as const }],
      ["withdrawn", { status: "disabled" as const }, { status: "active" as const }],
      ["withdrawn", { adminDisabledAt: new Date() }, { adminDisabledAt: null }],
    ])("%s holds 60 s until the account is fixed", async (reason, broken, fixed) => {
      const now = new Date();
      const { worker, pool } = await accountFixture(broken);
      const { run } = await waitingRun({ agent: worker, kind: "ai_account", reason: reason as ResourceWaitReason, scope: "account", dueAt: now, accountId: pool.id });
      const { deps } = makeDeps();
      const service = waits(deps);
      expect(await decideOnce(service, run.id, now)).toBe("held");
      const heldUntil = (await runRow(run.id)).scheduledRetryAt!.getTime() - now.getTime();
      expect(heldUntil).toBeGreaterThanOrEqual(48_000);
      expect(heldUntil).toBeLessThanOrEqual(72_000);
      await db.update(aiAccounts).set(fixed).where(eq(aiAccounts.id, pool.id));
      expect(await decideOnce(service, run.id, now)).toBe("proceeding");
    });

    it("unassigned holds until the agent is bound; a rebind or device login proceeds", async () => {
      const now = new Date();
      const companyId = await company();
      await member(companyId, "owner-1");
      const worker = await agent(companyId, { defaultEnvironmentId: localEnvironment.id });
      await bind(worker, null);
      const { run } = await waitingRun({ agent: worker, kind: "ai_account", reason: "unassigned", scope: "account", dueAt: now, accountId: null });
      const { deps } = makeDeps();
      const service = waits(deps);
      expect(await decideOnce(service, run.id, now)).toBe("held");
      const pool = await account("owner-1");
      await bind(worker, pool.id);
      expect(await decideOnce(service, run.id, now)).toBe("proceeding");
      await bind(worker, null, "device_login");
      expect(await decideOnce(service, run.id, now)).toBe("proceeding");
    });

    it("owner_not_member and reserved_elsewhere hold until membership or the restriction changes", async () => {
      const now = new Date();
      const companyId = await company();
      const worker = await agent(companyId, { defaultEnvironmentId: localEnvironment.id });
      const pool = await account("owner-2");
      await db.insert(authUsers).values({ id: "owner-2", name: "owner-2", email: "owner-2@example.com", emailVerified: true, createdAt: now, updatedAt: now });
      await bind(worker, pool.id);
      const { run } = await waitingRun({ agent: worker, kind: "ai_account", reason: "owner_not_member", scope: "account", dueAt: now, accountId: pool.id });
      const { deps } = makeDeps();
      const service = waits(deps);
      expect(await decideOnce(service, run.id, now)).toBe("held");
      await db.insert(companyMemberships).values({ companyId, principalId: "owner-2", principalType: "user", status: "active", membershipRole: "member" });
      // The failing row changed (now it passes): proceed.
      expect(await decideOnce(service, run.id, now)).toBe("proceeding");

      const elsewhere = await company();
      const [project] = await db.insert(projects).values({ companyId: elsewhere, name: "Elsewhere" }).returning();
      await db.insert(aiAccountProjects).values({ accountId: pool.id, projectId: project!.id });
      await db.update(resourceWaitEpisodes).set({ reason: "reserved_elsewhere" }).where(eq(resourceWaitEpisodes.currentRunId, run.id));
      expect(await decideOnce(service, run.id, now)).toBe("held");
      await db.delete(aiAccountProjects).where(eq(aiAccountProjects.accountId, pool.id));
      expect(await decideOnce(service, run.id, now)).toBe("proceeding");
    });

    it("device_unknown and credential_type_unsupported hold until the placement accepts the account", async () => {
      const now = new Date();
      const companyId = await company();
      await member(companyId, "owner-1");
      const sandbox = await environment("sandbox", { provider: "box", deviceId: "d-1" });
      const worker = await agent(companyId, { defaultEnvironmentId: sandbox.id });
      const pool = await account("owner-1", { credentialType: "api_key" });
      await bind(worker, pool.id);
      const { run } = await waitingRun({ agent: worker, kind: "ai_account", reason: "device_unknown", scope: "account", dueAt: now, accountId: pool.id, environmentId: sandbox.id });
      const { deps } = makeDeps();
      const service = waits(deps);
      expect(await decideOnce(service, run.id, now)).toBe("held");
      // Mapped to a device whose report is stale: subscription only, so the reason changes and the run re-plans.
      const [device] = await db.insert(aiAccountHosts).values({ name: "Box", kind: "external" }).returning();
      await db.insert(aiAccountHostEnvironments).values({ environmentId: sandbox.id, hostId: device!.id });
      expect(await decideOnce(service, run.id, now)).toBe("proceeding");
      await db.update(resourceWaitEpisodes).set({ reason: "credential_type_unsupported" }).where(eq(resourceWaitEpisodes.currentRunId, run.id));
      expect(await decideOnce(service, run.id, now)).toBe("held");
      await db.update(aiAccountHosts).set({
        targetReportedAt: now,
        targetState: { state: "available", acceptedCredentialTypes: ["subscription", "api_key"] },
      }).where(eq(aiAccountHosts.id, device!.id));
      expect(await decideOnce(service, run.id, now)).toBe("proceeding");
    });

    it("slots_full holds while the device's slots are taken and proceeds when one frees", async () => {
      const now = new Date();
      const { worker, device, accounts: [a, b], busyRun } = await slotFixture(1, 2);
      await insertRunningSlot(busyRun, a!.id, device.id);
      const { run } = await waitingRun({ agent: worker[1]!, kind: "device_slots", reason: "slots_full", scope: "device", dueAt: now, deviceId: device.id, accountId: b!.id });
      const { deps } = makeDeps();
      const service = waits(deps);
      expect(await decideOnce(service, run.id, now)).toBe("held");
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, busyRun.id));
      expect(await decideOnce(service, run.id, now)).toBe("proceeding");
    });
  });

  /** A device with `cap` slots reached through one SSH environment, and agents bound to their own accounts. */
  async function slotFixture(cap: number, agentCount: number) {
    const companyId = await company();
    await member(companyId, "owner-1");
    const env = await environment("ssh", { host: "slots.invalid", port: 22, username: "runner" });
    const [device] = await db.insert(aiAccountHosts).values({ name: `Slots ${tag()}`, kind: "ssh_host", externalKey: "ssh:slots.invalid:22", maxAccounts: cap }).returning();
    const worker: AgentRow[] = [];
    const accounts: Array<typeof aiAccounts.$inferSelect> = [];
    for (let index = 0; index < agentCount; index += 1) {
      const row = await agent(companyId, { defaultEnvironmentId: env.id });
      const pool = await account("owner-1");
      await bind(row, pool.id);
      worker.push(row);
      accounts.push(pool);
    }
    const busyAgent = await agent(companyId, { defaultEnvironmentId: env.id });
    const [busyRun] = await db.insert(heartbeatRuns).values({ companyId, agentId: busyAgent.id, status: "running", startedAt: new Date() }).returning();
    return { companyId, env, device: device!, worker, accounts, busyRun: busyRun! };
  }

  async function insertRunningSlot(run: RunRow, accountId: string, deviceId: string) {
    await db.insert(aiAccountRunSlots).values({ runId: run.id, companyId: run.companyId, deviceId, accountId });
  }

  describe("slots and probes", () => {
    it("admits exactly one new account per pass into one free slot, first in first out", async () => {
      const now = new Date();
      const { worker, device, accounts, busyRun } = await slotFixture(2, 4);
      // Account 0 already runs on the device: one slot of two is free.
      await insertRunningSlot(busyRun, accounts[0]!.id, device.id);
      const waiting: Array<Awaited<ReturnType<typeof waitingRun>>> = [];
      for (const [index, row] of worker.entries()) {
        waiting.push(await waitingRun({
          agent: row, kind: "device_slots", reason: "slots_full", scope: "device",
          dueAt: seconds(now, -1), deviceId: device.id, accountId: accounts[index]!.id, since: seconds(now, -100 + index),
        }));
      }
      const { deps } = makeDeps();
      const result = await waits(deps).holdDueWaits({ now });
      expect(result).toMatchObject({ examined: 4, proceeding: 2, held: 2 });
      const due = async (index: number) => (await runRow(waiting[index]!.run.id)).scheduledRetryAt!.getTime() <= now.getTime();
      // The running account needs no slot; the oldest new account takes the free one.
      expect(await due(0)).toBe(true);
      expect(await due(1)).toBe(true);
      expect(await due(2)).toBe(false);
      expect(await due(3)).toBe(false);
    });

    it("wakes an older waiter that is not due yet instead of letting a newer one take the slot", async () => {
      const now = new Date();
      const { worker, device, accounts } = await slotFixture(1, 2);
      const older = await waitingRun({
        agent: worker[0]!, kind: "device_slots", reason: "slots_full", scope: "device",
        dueAt: seconds(now, 50), deviceId: device.id, accountId: accounts[0]!.id, since: seconds(now, -200),
      });
      const newer = await waitingRun({
        agent: worker[1]!, kind: "device_slots", reason: "slots_full", scope: "device",
        dueAt: seconds(now, -1), deviceId: device.id, accountId: accounts[1]!.id, since: seconds(now, -100),
      });
      const { deps } = makeDeps();
      const result = await waits(deps).holdDueWaits({ now });
      expect(result).toMatchObject({ held: 1, slotWakes: 1 });
      expect((await runRow(older.run.id)).scheduledRetryAt!.getTime()).toBeLessThanOrEqual(now.getTime());
      expect((await runRow(newer.run.id)).scheduledRetryAt!.getTime()).toBeGreaterThan(now.getTime());
    });

    it("releases exactly one probe per account after an estimated reset", async () => {
      const now = new Date();
      const companyId = await company();
      await member(companyId, "owner-1");
      const pool = await account("owner-1", {
        exhaustedUntil: seconds(now, -60), limitReason: "provider_quota", limitSource: "estimated", limitStrikes: 2,
      });
      const waiting: Array<Awaited<ReturnType<typeof waitingRun>>> = [];
      for (let index = 0; index < 3; index += 1) {
        const row = await agent(companyId, { defaultEnvironmentId: localEnvironment.id });
        await bind(row, pool.id);
        waiting.push(await waitingRun({
          agent: row, kind: "ai_account", reason: "usage_limit", scope: "account",
          dueAt: seconds(now, -1), accountId: pool.id, since: seconds(now, -3600 + index * 60),
        }));
      }
      const { deps } = makeDeps();
      const service = waits(deps);
      const first = await service.holdDueWaits({ now });
      expect(first).toMatchObject({ examined: 3, proceeding: 1, held: 2, probesClaimed: 1 });
      expect((await db.select().from(aiAccounts).where(eq(aiAccounts.id, pool.id)))[0]!.limitProbeRunId).toBe(waiting[0]!.run.id);

      // While the probe is claimed by a live run, nobody else gets one.
      for (const entry of waiting) await makeDue(entry.run.id, seconds(now, 1));
      await db.update(heartbeatRuns).set({ status: "running", startedAt: now }).where(eq(heartbeatRuns.id, waiting[0]!.run.id));
      const second = await service.holdDueWaits({ now: seconds(now, 2) });
      expect(second).toMatchObject({ examined: 2, proceeding: 0, held: 2, probesClaimed: 0 });

      // The probe failed and ended: the next waiter in line probes.
      await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, waiting[0]!.run.id));
      for (const entry of waiting.slice(1)) await makeDue(entry.run.id, seconds(now, 3));
      const third = await service.holdDueWaits({ now: seconds(now, 4) });
      expect(third).toMatchObject({ proceeding: 1, held: 1, probesClaimed: 1 });
      expect((await db.select().from(aiAccounts).where(eq(aiAccounts.id, pool.id)))[0]!.limitProbeRunId).toBe(waiting[1]!.run.id);
    });

    it("never lets an older wait on the account for another reason block the limit's probe", async () => {
      const now = new Date();
      const companyId = await company();
      await member(companyId, "owner-1");
      const pool = await account("owner-1", {
        exhaustedUntil: seconds(now, -60), limitReason: "provider_quota", limitSource: "estimated", limitStrikes: 1,
      });
      // Since long before the limit, an agent on an unmapped sandbox waits for a device on the same account.
      const sandbox = await environment("sandbox", { provider: "box", deviceId: "d-1" });
      const unplaced = await agent(companyId, { defaultEnvironmentId: sandbox.id });
      await bind(unplaced, pool.id);
      const older = await waitingRun({
        agent: unplaced, kind: "ai_account", reason: "device_unknown", scope: "account",
        dueAt: seconds(now, 240), accountId: pool.id, environmentId: sandbox.id, since: seconds(now, -7200),
      });
      const limited = await agent(companyId, { defaultEnvironmentId: localEnvironment.id });
      await bind(limited, pool.id);
      const limitWaiter = await waitingRun({
        agent: limited, kind: "ai_account", reason: "usage_limit", scope: "account",
        dueAt: seconds(now, -1), accountId: pool.id, since: seconds(now, -3600),
      });
      const { deps } = makeDeps();
      const service = waits(deps);
      expect(await service.holdDueWaits({ now })).toMatchObject({ examined: 1, proceeding: 1, probesClaimed: 1 });
      expect((await db.select().from(aiAccounts).where(eq(aiAccounts.id, pool.id)))[0]!.limitProbeRunId).toBe(limitWaiter.run.id);
      await db.update(heartbeatRuns).set({ status: "queued" }).where(eq(heartbeatRuns.id, limitWaiter.run.id));
      // The older wait still waits for its device, not for the probe.
      await makeDue(older.run.id, now);
      expect(await service.holdDueWaits({ now })).toMatchObject({ examined: 1, held: 1 });

      // A wait for another reason whose own row passes now proceeds without the probe gate.
      const returning = await agent(companyId, { defaultEnvironmentId: localEnvironment.id });
      await bind(returning, pool.id);
      await waitingRun({
        agent: returning, kind: "ai_account", reason: "withdrawn", scope: "account",
        dueAt: seconds(now, -1), accountId: pool.id, since: seconds(now, -9000),
      });
      expect(await service.holdDueWaits({ now })).toMatchObject({ examined: 1, proceeding: 1, probesClaimed: 0 });
    });

    it("keeps one episode and one notice while probes fail, and ends the wait only when a probe succeeds", async () => {
      const t0 = new Date();
      const companyId = await company();
      await member(companyId, "owner-1");
      const worker = await agent(companyId, { defaultEnvironmentId: localEnvironment.id });
      const task = await issue(companyId, worker.id);
      const pool = await account("owner-1");
      await bind(worker, pool.id);
      let clock = t0;
      const { deps, calls } = makeDeps();
      const service = waits(deps, { now: () => clock });
      /** What the account's limit handler does when a run hits an estimated limit (spec 4.6). */
      const hitLimit = async (runId: string, at: Date, strikes: number) => {
        clock = at;
        await db.update(heartbeatRuns).set({ status: "failed", finishedAt: at }).where(eq(heartbeatRuns.id, runId));
        const until = new Date(at.getTime() + 3_600_000 * 2 ** (strikes - 1));
        await db.update(aiAccounts).set({
          exhaustedUntil: until, limitReason: "provider_quota", limitSource: "estimated", limitStrikes: strikes, limitProbeRunId: null,
          ...(strikes === 1 ? { limitEpisodeStartedAt: at } : {}),
        }).where(eq(aiAccounts.id, pool.id));
        const result = await service.scheduleResourceWait({
          run: await runRow(runId),
          wait: accountWaitDeferral({
            reason: "usage_limit", accountId: pool.id, accountLabel: pool.label,
            resumeAt: new Date(until.getTime() + resourceWaitJitterMs(runId)), resumeAtSource: "estimated",
          }).wait,
        });
        expect(result).toMatchObject({ outcome: "scheduled", shared: false });
        return result.successorRunId!;
      };
      /** After the reset the probe is released, starts, and passes credentials and the lease. */
      const probe = async (runId: string) => {
        const [row] = await db.select().from(aiAccounts).where(eq(aiAccounts.id, pool.id));
        const at = new Date(row!.exhaustedUntil!.getTime() + 150_000);
        clock = at;
        await makeDue(runId, at);
        expect(await service.holdDueWaits({ now: at })).toMatchObject({ proceeding: 1, probesClaimed: 1 });
        await db.update(heartbeatRuns).set({ status: "running", startedAt: at }).where(eq(heartbeatRuns.id, runId));
        const running = await runRow(runId);
        expect(await service.noteRunPassed({ run: running, step: "credentials" })).toMatchObject({ resolved: false });
        expect(await service.noteRunPassed({ run: running, step: "lease" })).toMatchObject({ resolved: false });
        return at;
      };
      const [first] = await db.insert(heartbeatRuns).values({
        companyId, agentId: worker.id, status: "running", startedAt: t0, contextSnapshot: { issueId: task.id },
      }).returning();
      await db.update(issues).set({ executionRunId: first!.id }).where(eq(issues.id, task.id));
      let waiting = await hitLimit(first!.id, t0, 1);
      const [episode] = await db.select().from(resourceWaitEpisodes);
      for (const strikes of [2, 3]) {
        const at = await probe(waiting);
        waiting = await hitLimit(waiting, at, strikes);
      }
      // Two failed probes later: the same episode, one started entry, one notice.
      expect(await db.select().from(resourceWaitEpisodes)).toEqual([
        expect.objectContaining({ id: episode!.id, since: episode!.since, resolvedAt: null, currentRunId: waiting }),
      ]);
      expect(await db.select().from(activityLog).where(eq(activityLog.action, "resource_wait.started"))).toHaveLength(1);
      expect(calls.notices.map((notice) => notice.body)).toEqual([expect.stringContaining("usage limit reached")]);

      // The next probe succeeds; the account's success hook ends the wait.
      await probe(waiting);
      await db.update(aiAccounts).set({ limitStrikes: 0, exhaustedUntil: null, limitEpisodeStartedAt: null, limitProbeRunId: null })
        .where(eq(aiAccounts.id, pool.id));
      expect(await service.noteRunPassed({ run: await runRow(waiting), step: "succeeded" })).toMatchObject({ resolved: true, episodeId: episode!.id });
      expect(calls.notices.map((notice) => notice.body)).toEqual([
        expect.stringContaining("usage limit reached"),
        expect.stringMatching(/^Started after waiting/),
      ]);
    });

    it("lets exactly one concurrent claim win the probe", async () => {
      const companyId = await company();
      await member(companyId, "owner-1");
      const pool = await account("owner-1");
      const worker = await agent(companyId);
      const runs = await db.insert(heartbeatRuns).values(
        Array.from({ length: 5 }, () => ({ companyId, agentId: worker.id, status: "scheduled_retry", scheduledRetryAt: new Date() })),
      ).returning();
      const results = await Promise.all(runs.map((run) => claimAccountProbe(db, pool.id, run.id)));
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = runs[results.indexOf(true)]!;
      expect(await claimAccountProbe(db, pool.id, winner.id)).toBe(true);
    });
  });

  describe("episodes", () => {
    it("reuses the open episode for the same resource and supersedes it for another", async () => {
      const { env, worker, task, companyId } = await envFixture();
      const now = new Date();
      const chain = { companyId, issueId: task.id, agentId: worker.id };
      const offline = environmentWaitDeferral({ reason: "offline", scope: "target", environment: { id: env.id, name: env.name } }).wait;
      const first = await openEpisode(db, { chain, wait: offline, now });
      expect(first).toMatchObject({ created: true, superseded: null });
      const again = await openEpisode(db, { chain, wait: offline, now: seconds(now, 120) });
      expect(again).toMatchObject({ created: false, reasonChanged: false });
      expect(again.episode.id).toBe(first.episode.id);
      expect(again.episode.since.getTime()).toBe(now.getTime());
      expect(again.episode.checks).toBe(1);
      const admission = await openEpisode(db, { chain, wait: { ...offline, reason: "not_serving", scope: "admission" }, now: seconds(now, 240) });
      expect(admission).toMatchObject({ created: false, reasonChanged: true });
      expect(admission.episode.checks).toBe(0);

      const limit = accountWaitDeferral({ reason: "usage_limit", accountId: randomUUID(), accountLabel: "Max-2" }).wait;
      const other = await openEpisode(db, { chain, wait: limit, now: seconds(now, 300) });
      expect(other.created).toBe(true);
      expect(other.superseded?.id).toBe(first.episode.id);
      expect(other.episode.since.getTime()).toBe(seconds(now, 300).getTime());
      expect(await episodeRow(first.episode.id)).toMatchObject({ resolution: "superseded" });
      const open = await db.select().from(resourceWaitEpisodes).where(sql`${resourceWaitEpisodes.resolvedAt} is null`);
      expect(open.map((row) => row.id)).toEqual([other.episode.id]);
    });

    it("posts a new notice and PM wake when a wait's reason changes to one a person must fix, and none for another limit", async () => {
      const now = new Date();
      const companyId = await company();
      await member(companyId, "owner-1");
      const lead = await agent(companyId);
      const worker = await agent(companyId, { defaultEnvironmentId: localEnvironment.id, reportsTo: lead.id });
      const task = await issue(companyId, worker.id);
      const pool = await account("owner-1", { limitEpisodeStartedAt: now });
      await bind(worker, pool.id);
      const { deps, calls } = makeDeps();
      const service = waits(deps, { now: () => now });
      const [first] = await db.insert(heartbeatRuns).values({
        companyId, agentId: worker.id, status: "failed", startedAt: now, finishedAt: now, contextSnapshot: { issueId: task.id },
      }).returning();
      await db.update(issues).set({ executionRunId: first!.id }).where(eq(issues.id, task.id));
      let runId = first!.id;
      // The limit turns into a credit limit (the same limit), then the token expires, then the owner switches it off.
      for (const reason of ["usage_limit", "credit_balance", "signed_out", "withdrawn"] as const) {
        const limit = reason === "usage_limit" || reason === "credit_balance";
        const result = await service.scheduleResourceWait({
          run: await runRow(runId),
          wait: accountWaitDeferral({
            reason, accountId: pool.id, accountLabel: pool.label,
            resumeAt: limit ? seconds(now, 3600) : null, resumeAtSource: limit ? "provider" : null,
          }).wait,
        });
        expect(result).toMatchObject({ outcome: "scheduled", shared: false });
        runId = result.successorRunId!;
        await db.update(heartbeatRuns).set({ status: "failed", finishedAt: now }).where(eq(heartbeatRuns.id, runId));
      }
      const episodes = await db.select().from(resourceWaitEpisodes);
      expect(episodes).toEqual([expect.objectContaining({ reason: "withdrawn", resolvedAt: null, since: now })]);
      expect(episodes[0]!.notifiedAt).not.toBeNull();
      expect(calls.notices.map((notice) => notice.body)).toEqual([
        expect.stringContaining("usage limit reached"),
        expect.stringContaining("it is signed out"),
        expect.stringContaining("it is switched off"),
      ]);
      expect(calls.wakes.map((wake) => (wake.contextSnapshot.resourceWait as { reason: string }).reason))
        .toEqual(["usage_limit", "signed_out", "withdrawn"]);
      expect(calls.wakes.every((wake) => wake.agentId === lead.id)).toBe(true);
    });

    it("clears the notice time when a reused wait's reason becomes one a person must fix, so the notify pass retries its notice", async () => {
      const { worker, task, companyId } = await envFixture();
      const now = new Date();
      const chain = { companyId, issueId: task.id, agentId: worker.id };
      const accountId = randomUUID();
      const wait = (reason: "usage_limit" | "credit_balance" | "signed_out" | "auth_unconfirmed") =>
        accountWaitDeferral({ reason, accountId, accountLabel: "Max-2" }).wait;
      const { episode } = await openEpisode(db, { chain, wait: wait("usage_limit"), now });
      await db.update(resourceWaitEpisodes).set({ notifiedAt: now }).where(eq(resourceWaitEpisodes.id, episode.id));
      // Another limit is the same limit; a reason without a notice changes nothing either.
      expect((await openEpisode(db, { chain, wait: wait("credit_balance"), now })).episode.notifiedAt).toEqual(now);
      expect((await openEpisode(db, { chain, wait: wait("auth_unconfirmed"), now })).episode.notifiedAt).toEqual(now);
      const signedOut = await openEpisode(db, { chain, wait: wait("signed_out"), now });
      expect(signedOut).toMatchObject({ created: false, reasonChanged: true });
      expect(signedOut.episode).toMatchObject({ id: episode.id, notifiedAt: null });
    });

    it("keeps one open episode per chain when two deferrals race", async () => {
      const { env, worker, task, companyId } = await envFixture();
      const now = new Date();
      const chain = { companyId, issueId: task.id, agentId: worker.id };
      const offline = environmentWaitDeferral({ reason: "offline", scope: "target", environment: { id: env.id, name: env.name } }).wait;
      const results = await Promise.all([openEpisode(db, { chain, wait: offline, now }), openEpisode(db, { chain, wait: offline, now })]);
      expect(new Set(results.map((result) => result.episode.id)).size).toBe(1);
      expect(results.filter((result) => result.created)).toHaveLength(1);
    });
  });

  describe("two agents waiting on one issue", () => {
    /** A run that started on the task: the assignee's (holding the lock) or one a comment mention woke. */
    async function startedRun(worker: AgentRow, issueId: string, options: { mentioned?: boolean } = {}) {
      const [run] = await db.insert(heartbeatRuns).values({
        companyId: worker.companyId,
        agentId: worker.id,
        status: "running",
        startedAt: new Date(),
        contextSnapshot: { issueId },
        ...(options.mentioned ? { runnerProfileJson: { aiConnectionNonAssigneeCommentWake: true } } : {}),
      }).returning();
      if (!options.mentioned) await db.update(issues).set({ executionRunId: run!.id }).where(eq(issues.id, issueId));
      return run!;
    }

    function successorOf(result: { outcome: string }): string {
      expect(result.outcome).toBe("scheduled");
      return ("successorRunId" in result && typeof result.successorRunId === "string" && result.successorRunId) || "";
    }

    /** Both waits are due at each check; the registry stays fresh. Returns each pass's result. */
    async function checkBoth(service: ReturnType<typeof waits>, runIds: string[], start: Date) {
      const results = [];
      for (const minutes of [1, 3, 6]) {
        const at = seconds(start, minutes * 60);
        for (const runId of runIds) await makeDue(runId, at);
        results.push(await service.holdDueWaits({ now: at }));
      }
      return results;
    }

    const offline = (env: EnvironmentRow) => environmentWaitDeferral({ reason: "offline", scope: "target", environment: { id: env.id, name: env.name } });

    it("hold together on the same environment: one episode, no new attempts, no new notices", async () => {
      const { env, worker, task, companyId } = await envFixture();
      const mentioned = await agent(companyId, { defaultEnvironmentId: env.id });
      const now = new Date();
      await environmentAvailabilityService(db).markUnavailable(env.id, { reason: "offline", source: "lease_error", now });
      const { deps, calls } = makeDeps();
      const service = waits(deps, { now: () => now });
      const assigneeWait = successorOf(await service.finalizeDeferral(await startedRun(worker, task.id), offline(env)));
      const joined = await service.finalizeDeferral(await startedRun(mentioned, task.id, { mentioned: true }), offline(env));
      expect(joined).toMatchObject({ outcome: "scheduled", shared: true });
      const mentionedWait = successorOf(joined);
      const [episode] = await db.select().from(resourceWaitEpisodes);
      expect(episode).toMatchObject({ currentRunId: assigneeWait, agentId: worker.id, resolvedAt: null });
      expect(readResourceWaitContext((await runRow(mentionedWait)).contextSnapshot?.resourceWait)?.episodeId).toBe(episode!.id);
      // The issue lock stays with the assignee's wait.
      expect((await db.select().from(issues).where(eq(issues.id, task.id)))[0]!.executionRunId).toBe(assigneeWait);

      const before = await counts();
      for (const pass of await checkBoth(service, [assigneeWait, mentionedWait], now)) {
        expect(pass).toMatchObject({ examined: 2, held: 2, proceeding: 0, gateSuppressed: 0 });
      }
      expect(await counts()).toEqual(before);
      expect(await episodeRow(episode!.id)).toMatchObject({ currentRunId: assigneeWait, resolvedAt: null });
      expect(await db.select().from(activityLog).where(eq(activityLog.action, "resource_wait.started"))).toHaveLength(1);
      expect(calls.notices).toEqual([]);

      // A wake for the environment reaches both.
      const woken = await wakeResourceWaits(db, { environmentIds: [env.id] }, { now: seconds(now, 400) });
      expect([...woken.runIds].sort()).toEqual([assigneeWait, mentionedWait].sort());
    });

    it("hold together on different resources: the mentioned agent's wait joins without taking the episode or notifying", async () => {
      const { env, worker, task, companyId } = await envFixture();
      await member(companyId, "owner-1");
      const now = new Date();
      const pool = await account("owner-1", {
        exhaustedUntil: seconds(now, 3600), limitReason: "provider_quota", limitSource: "provider", limitStrikes: 1, limitEpisodeStartedAt: now,
      });
      const mentioned = await agent(companyId, { defaultEnvironmentId: localEnvironment.id });
      await bind(mentioned, pool.id);
      await environmentAvailabilityService(db).markUnavailable(env.id, { reason: "offline", source: "lease_error", now });
      const { deps, calls } = makeDeps();
      const service = waits(deps, { now: () => now });
      const assigneeWait = successorOf(await service.finalizeDeferral(await startedRun(worker, task.id), offline(env)));
      const limit = accountWaitDeferral({
        reason: "usage_limit", accountId: pool.id, accountLabel: pool.label, resumeAt: seconds(now, 3600), resumeAtSource: "provider",
      });
      const joined = await service.finalizeDeferral(await startedRun(mentioned, task.id, { mentioned: true }), limit);
      expect(joined).toMatchObject({ outcome: "scheduled", shared: true });
      const mentionedWait = successorOf(joined);
      const [episode] = await db.select().from(resourceWaitEpisodes);
      expect(episode).toMatchObject({ kind: "environment", currentRunId: assigneeWait, agentId: worker.id, resolvedAt: null });
      expect(readResourceWaitContext((await runRow(mentionedWait)).contextSnapshot?.resourceWait))
        .toMatchObject({ kind: "ai_account", reason: "usage_limit", accountId: pool.id, episodeId: episode!.id });
      // The joined wait takes neither a start time nor a notice time from the other resource's episode.
      expect((await readScheduledRetryResourceWaits(db, [await runRow(mentionedWait)])).get(mentionedWait)).toMatchObject({ since: null, notifiedAt: null });

      const before = await counts();
      for (const pass of await checkBoth(service, [assigneeWait, mentionedWait], now)) {
        expect(pass).toMatchObject({ examined: 2, held: 2, proceeding: 0 });
      }
      expect(await counts()).toEqual(before);
      expect(await db.select().from(resourceWaitEpisodes)).toEqual([expect.objectContaining({ id: episode!.id, resolvedAt: null })]);
      expect(await db.select().from(activityLog).where(eq(activityLog.action, "resource_wait.started"))).toHaveLength(1);
      expect(calls.notices).toEqual([]);

      // A wake for its own resource reaches it.
      expect((await wakeResourceWaits(db, { accountIds: [pool.id] }, { now: seconds(now, 400) })).runIds).toEqual([mentionedWait]);
    });

    it("a joined admission wait on another resource backs off in its own due time, and a wake still reaches it", async () => {
      const { env, worker, task, companyId } = await envFixture();
      const sandbox = await environment("sandbox", { provider: "box", deviceId: "d-7" });
      const mentioned = await agent(companyId, { defaultEnvironmentId: sandbox.id });
      const now = new Date();
      let clock = now;
      await environmentAvailabilityService(db).markUnavailable(env.id, { reason: "offline", source: "lease_error", now });
      const { deps } = makeDeps();
      const service = waits(deps, { now: () => clock });
      successorOf(await service.finalizeDeferral(await startedRun(worker, task.id), offline(env)));
      const notServing = () => environmentWaitDeferral({ reason: "not_serving", scope: "admission", environment: { id: sandbox.id, name: sandbox.name } });
      const firstWait = successorOf(await service.finalizeDeferral(await startedRun(mentioned, task.id, { mentioned: true }), notServing()));
      expect((await runRow(firstWait)).scheduledRetryAt!.getTime()).toBe(now.getTime() + 5 * 60_000);
      // Its attempt is refused again: the next one is 10 minutes out, past the gate interval.
      clock = seconds(now, 300);
      await db.update(heartbeatRuns).set({ status: "running", startedAt: clock }).where(eq(heartbeatRuns.id, firstWait));
      const secondWait = successorOf(await service.finalizeDeferral(await runRow(firstWait), notServing()));
      expect((await runRow(secondWait)).scheduledRetryAt!.getTime()).toBe(clock.getTime() + 10 * 60_000);
      expect(await db.select().from(resourceWaitEpisodes)).toEqual([expect.objectContaining({ kind: "environment", environmentId: env.id, resolvedAt: null })]);
      // The driver serves the company again: the wake reaches the joined wait, which makes its attempt.
      const wakeAt = seconds(clock, 60);
      expect((await wakeResourceWaits(db, { environmentIds: [sandbox.id] }, { now: wakeAt })).runIds).toEqual([secondWait]);
      // The assignee's wait is due too, and still held by its own outage.
      expect(await service.holdDueWaits({ now: wakeAt })).toMatchObject({ examined: 2, proceeding: 1, held: 1 });
      expect((await runRow(secondWait)).scheduledRetryAt!.getTime()).toBeLessThanOrEqual(wakeAt.getTime());
    });

    it("ends both waits in the same tick when the task is closed, however far out the joined wait's next check is", async () => {
      const { env, worker, task, companyId } = await envFixture();
      const sandbox = await environment("sandbox", { provider: "box", deviceId: "d-8" });
      const mentioned = await agent(companyId, { defaultEnvironmentId: sandbox.id });
      const now = new Date();
      await environmentAvailabilityService(db).markUnavailable(env.id, { reason: "offline", source: "lease_error", now });
      const { deps, calls } = makeDeps();
      const service = waits(deps, { now: () => now });
      const assigneeWait = successorOf(await service.finalizeDeferral(await startedRun(worker, task.id), offline(env)));
      const mentionedWait = successorOf(await service.finalizeDeferral(
        await startedRun(mentioned, task.id, { mentioned: true }),
        environmentWaitDeferral({ reason: "stopped", scope: "admission", environment: { id: sandbox.id, name: sandbox.name } }),
      ));
      await db.update(heartbeatRuns).set({ scheduledRetryAt: seconds(now, 3600) }).where(eq(heartbeatRuns.id, mentionedWait));
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, task.id));
      const at = seconds(now, 60);
      await makeDue(assigneeWait, at);
      expect(await service.holdDueWaits({ now: at })).toMatchObject({ examined: 1, gateSuppressed: 1 });
      expect(await db.select().from(resourceWaitEpisodes)).toEqual([expect.objectContaining({ resolution: "abandoned" })]);
      await createRunDispatch(db).promoteDueScheduledRetries({ now: at, cutoff: null });
      expect((await runRow(assigneeWait)).status).toBe("cancelled");
      expect((await runRow(mentionedWait)).status).toBe("cancelled");
      expect(calls.notices).toEqual([]);
    });

    it("the assignee's wait takes the episode over, and it passes back when the assignee's wait is suppressed", async () => {
      const { env, worker, task, companyId } = await envFixture();
      const mentioned = await agent(companyId, { defaultEnvironmentId: env.id });
      const now = new Date();
      await environmentAvailabilityService(db).markUnavailable(env.id, { reason: "offline", source: "lease_error", now });
      const { deps } = makeDeps();
      const service = waits(deps, { now: () => now });
      const mentionedWait = successorOf(await service.finalizeDeferral(await startedRun(mentioned, task.id, { mentioned: true }), offline(env)));
      const [first] = await db.select().from(resourceWaitEpisodes);
      expect(first).toMatchObject({ currentRunId: mentionedWait, agentId: mentioned.id });
      const takeover = await service.finalizeDeferral(await startedRun(worker, task.id), offline(env));
      expect(takeover).toMatchObject({ outcome: "scheduled", shared: false });
      const assigneeWait = successorOf(takeover);
      expect(await episodeRow(first!.id)).toMatchObject({ currentRunId: assigneeWait, agentId: worker.id, resolvedAt: null, since: first!.since });

      // The task goes to another agent: the assignee's wait is suppressed, the mentioned agent keeps the episode.
      const other = await agent(companyId);
      await db.update(issues).set({ assigneeAgentId: other.id }).where(eq(issues.id, task.id));
      const at = seconds(now, 60);
      await makeDue(assigneeWait, at);
      await makeDue(mentionedWait, at);
      expect(await service.holdDueWaits({ now: at })).toMatchObject({ examined: 2, gateSuppressed: 1, held: 1 });
      expect(await episodeRow(first!.id)).toMatchObject({ currentRunId: mentionedWait, agentId: mentioned.id, resolvedAt: null, gateCheckedAt: null });
    });

    it("a mentioned agent's run that ended on a usage limit gets a wait the gate keeps (it never held the task)", async () => {
      const { worker, task, companyId } = await envFixture();
      await member(companyId, "owner-1");
      const now = new Date();
      const pool = await account("owner-1", {
        exhaustedUntil: seconds(now, 3600), limitReason: "provider_quota", limitSource: "provider", limitStrikes: 1, limitEpisodeStartedAt: now,
      });
      const mentioned = await agent(companyId, { defaultEnvironmentId: localEnvironment.id });
      await bind(mentioned, pool.id);
      // The assignee's own run holds the task.
      await startedRun(worker, task.id);
      const [limited] = await db.insert(heartbeatRuns).values({
        companyId, agentId: mentioned.id, status: "failed", startedAt: now, finishedAt: now,
        contextSnapshot: { issueId: task.id }, runnerProfileJson: { aiConnectionNonAssigneeCommentWake: true },
      }).returning();
      const { deps } = makeDeps({ h7: true });
      const service = waits(deps, { now: () => now });
      // What the account's limit handler does for a run that ended (spec 4.6).
      const result = await service.scheduleResourceWait({
        run: limited!,
        wait: accountWaitDeferral({ reason: "usage_limit", accountId: pool.id, accountLabel: pool.label, resumeAt: seconds(now, 3600), resumeAtSource: "provider" }).wait,
      });
      expect(result).toMatchObject({ outcome: "scheduled" });
      // The authority is on the run's row (the gate before scheduling read it) and on its successor.
      expect((await runRow(limited!.id)).contextSnapshot?.resourceWaitDeferredWhileAssignee).toBe(false);
      const successor = await runRow(result.successorRunId!);
      expect(successor.contextSnapshot?.resourceWaitDeferredWhileAssignee).toBe(false);
      expect(await createRunDispatch(db).evaluateScheduledRetryGate({ runId: successor.id, companyId, retryReasonOverride: "ai_account_wait", now }))
        .toEqual({ allowed: true });
      const at = seconds(now, 60);
      await makeDue(successor.id, at);
      expect(await service.holdDueWaits({ now: at })).toMatchObject({ examined: 1, held: 1, gateSuppressed: 0 });
      expect((await db.select().from(issues).where(eq(issues.id, task.id)))[0]!.executionRunId).not.toBe(successor.id);
    });

    it("never ends a wait the assignee took over while the hold checked the wait it replaced", async () => {
      const { env, worker, task, companyId } = await envFixture();
      const mentioned = await agent(companyId, { defaultEnvironmentId: env.id });
      const now = new Date();
      await environmentAvailabilityService(db).markUnavailable(env.id, { reason: "offline", source: "lease_error", now });
      const runDispatch = createRunDispatch(db);
      let mentionedWait = "";
      let assigneeWait = "";
      let service: ReturnType<typeof waits> | null = null;
      const { deps } = makeDeps({
        gate: async (input) => {
          if (input.runId === mentionedWait && !assigneeWait) {
            // The assignee's run defers for the same device while the hold checks the mentioned agent's wait, which the gate then suppresses.
            assigneeWait = successorOf(await service!.finalizeDeferral(await startedRun(worker, task.id), offline(env)));
            return { allowed: false, reason: "Scheduled retry suppressed because the agent is not invokable", errorCode: "agent_not_invokable", issueId: task.id, details: {} };
          }
          return runDispatch.evaluateScheduledRetryGate(input);
        },
      });
      service = waits(deps, { now: () => now });
      mentionedWait = successorOf(await service.finalizeDeferral(await startedRun(mentioned, task.id, { mentioned: true }), offline(env)));
      const [episode] = await db.select().from(resourceWaitEpisodes);
      expect(episode).toMatchObject({ currentRunId: mentionedWait });
      const at = seconds(now, 60);
      await makeDue(mentionedWait, at);
      expect(await service.holdDueWaits({ now: at })).toMatchObject({ examined: 1, gateSuppressed: 1 });
      // The assignee's wait keeps the episode, its start and the device's registry row.
      expect(await episodeRow(episode!.id)).toMatchObject({ resolvedAt: null, currentRunId: assigneeWait, since: episode!.since });
      expect(await db.select().from(environmentAvailability).where(eq(environmentAvailability.environmentId, env.id))).toHaveLength(1);
      // Its next check holds it: the device is still down.
      const later = seconds(now, 120);
      await makeDue(assigneeWait, later);
      await makeDue(mentionedWait, later);
      expect(await service.holdDueWaits({ now: later })).toMatchObject({ examined: 2, held: 2, proceeding: 0, gateSuppressed: 0 });
      expect(await db.select().from(resourceWaitEpisodes)).toHaveLength(1);
    });

    it("a takeover holds the episode from the moment it is reused, so a check that saw the replaced run cannot end it", async () => {
      const { env, worker, task, companyId } = await envFixture();
      const mentioned = await agent(companyId, { defaultEnvironmentId: env.id });
      const now = new Date();
      await environmentAvailabilityService(db).markUnavailable(env.id, { reason: "offline", source: "lease_error", now });
      let stale: typeof resourceWaitEpisodes.$inferSelect | null = null;
      let staleResult: Awaited<ReturnType<typeof handOverOrAbandon>> | null = null;
      const { deps } = makeDeps({
        // While the assignee's deferral schedules its successor, a check that read the
        // episode earlier (the mentioned agent's wait as current run) ends that wait.
        beforeSuccessorInsert: async (run) => {
          if (stale && run.agentId === worker.id) staleResult = await handOverOrAbandon(db, stale, [stale.currentRunId!], now);
        },
      });
      const service = waits(deps, { now: () => now });
      const mentionedWait = successorOf(await service.finalizeDeferral(await startedRun(mentioned, task.id, { mentioned: true }), offline(env)));
      [stale] = await db.select().from(resourceWaitEpisodes);
      expect(stale).toMatchObject({ currentRunId: mentionedWait });
      const assigneeWait = successorOf(await service.finalizeDeferral(await startedRun(worker, task.id), offline(env)));
      expect(staleResult).toEqual({ handedOverTo: null, abandoned: null });
      expect(await episodeRow(stale!.id)).toMatchObject({ resolvedAt: null, currentRunId: assigneeWait });
    });

    it("hands over or abandons an episode only while it has the current run the caller saw", async () => {
      const { env, worker, task } = await envFixture();
      const now = new Date();
      const { run, episode } = await waitingRun({ agent: worker, kind: "environment", reason: "offline", scope: "target", dueAt: now, issueId: task.id, environmentId: env.id });
      // A stale snapshot: another run took the episode over since. Neither the
      // hand-over (to the run that waits in it) nor the abandonment happens.
      const stale = { ...episode, currentRunId: randomUUID() };
      expect(await handOverOrAbandon(db, stale, [], now)).toEqual({ handedOverTo: null, abandoned: null });
      expect(await handOverOrAbandon(db, stale, [run.id], now)).toEqual({ handedOverTo: null, abandoned: null });
      expect(await episodeRow(episode.id)).toMatchObject({ resolvedAt: null, currentRunId: run.id });
      // With the current run it saw, the caller abandons it.
      expect((await handOverOrAbandon(db, episode, [run.id], now)).abandoned).toMatchObject({ id: episode.id, resolution: "abandoned" });
      // An ended episode never gets a current run again.
      expect(await setEpisodeCurrentRun(db, episode.id, randomUUID(), now)).toBe(false);
      expect(await episodeRow(episode.id)).toMatchObject({ currentRunId: run.id });
    });

    it("a joined admission wait for the same device keeps its own backoff while the owner's attempt is in flight", async () => {
      const { env, worker, task, companyId } = await envFixture();
      const mentioned = await agent(companyId, { defaultEnvironmentId: env.id });
      const t0 = new Date();
      let clock = t0;
      const { deps } = makeDeps();
      const service = waits(deps, { now: () => clock });
      const notServing = () => environmentWaitDeferral({ reason: "not_serving", scope: "admission", environment: { id: env.id, name: env.name } });
      const ownerWait = successorOf(await service.finalizeDeferral(await startedRun(worker, task.id), notServing()));
      const joined = await service.finalizeDeferral(await startedRun(mentioned, task.id, { mentioned: true }), notServing());
      expect(joined).toMatchObject({ outcome: "scheduled", shared: true });
      // Both attempt at +5 min; the owner's attempt then waits in the queue (its agent is busy elsewhere).
      const firstAt = seconds(t0, 300);
      expect(await service.holdDueWaits({ now: firstAt })).toMatchObject({ examined: 2, proceeding: 2 });
      await db.update(heartbeatRuns).set({ status: "queued" }).where(eq(heartbeatRuns.id, ownerWait));
      expect((await db.select().from(resourceWaitEpisodes))[0]!.nextCheckAt).toBeNull();
      let runId = successorOf(joined);
      const attempts = [firstAt];
      for (let index = 0; index < 3; index += 1) {
        clock = attempts[attempts.length - 1]!;
        // The joined wait's attempt is refused again.
        await db.update(heartbeatRuns).set({ status: "running", startedAt: clock }).where(eq(heartbeatRuns.id, runId));
        runId = successorOf(await service.finalizeDeferral(await runRow(runId), notServing()));
        if (index === 2) break;
        for (let pass = 0; pass < 20; pass += 1) {
          const due = (await runRow(runId)).scheduledRetryAt!;
          const result = await service.holdDueWaits({ now: due });
          expect(result.examined).toBe(1);
          if (result.proceeding === 1) {
            attempts.push(due);
            break;
          }
          // Held, but its gate still runs every 5 minutes.
          expect((await runRow(runId)).scheduledRetryAt!.getTime() - due.getTime()).toBeLessThanOrEqual(5 * 60_000);
        }
      }
      expect(attempts.map((at) => (at.getTime() - t0.getTime()) / 60_000)).toEqual([5, 15, 35]);
      expect(await db.select().from(resourceWaitEpisodes)).toEqual([expect.objectContaining({ currentRunId: ownerWait, resolvedAt: null })]);
    });

    it("a joined wait for another resource takes the task's wait over, with its notice, when the owner's wait ends", async () => {
      const { env, worker, task, companyId } = await envFixture();
      await member(companyId, "owner-1");
      const now = new Date();
      const pool = await account("owner-1", { status: "auth_failed" });
      const mentioned = await agent(companyId, { defaultEnvironmentId: localEnvironment.id });
      await bind(mentioned, pool.id);
      await environmentAvailabilityService(db).markUnavailable(env.id, { reason: "offline", source: "lease_error", now });
      const { deps, calls } = makeDeps();
      const service = waits(deps, { now: () => now });
      const assigneeWait = successorOf(await service.finalizeDeferral(await startedRun(worker, task.id), offline(env)));
      const signedOut = accountWaitDeferral({ reason: "signed_out", accountId: pool.id, accountLabel: pool.label });
      const riderWait = successorOf(await service.finalizeDeferral(await startedRun(mentioned, task.id, { mentioned: true }), signedOut));
      // While the assignee's wait owns the task, the joined wait is quiet.
      expect(calls.notices).toEqual([]);
      const [first] = await db.select().from(resourceWaitEpisodes);

      // The device is back: the assignee's run passes its lease, and its wait ends.
      await db.update(heartbeatRuns).set({ status: "running", startedAt: now }).where(eq(heartbeatRuns.id, assigneeWait));
      expect(await service.noteRunPassed({ run: await runRow(assigneeWait), step: "lease" })).toMatchObject({ resolved: true, episodeId: first!.id });
      const open = await db.select().from(resourceWaitEpisodes).where(isNull(resourceWaitEpisodes.resolvedAt));
      expect(open).toEqual([expect.objectContaining({ kind: "ai_account", reason: "signed_out", accountId: pool.id, currentRunId: riderWait, agentId: mentioned.id })]);
      expect(calls.notices.map((notice) => notice.body)).toEqual([expect.stringContaining("it is signed out")]);
      expect(await db.select().from(activityLog).where(eq(activityLog.action, "resource_wait.started"))).toHaveLength(2);
      expect((await readScheduledRetryResourceWaits(db, [await runRow(riderWait)])).get(riderWait))
        .toMatchObject({ episodeId: open[0]!.id, since: open[0]!.since.toISOString() });
      // It is that episode's wait now: held on its own account, with the gate on the owner's cadence.
      const at = seconds(now, 60);
      await makeDue(riderWait, at);
      expect(await service.holdDueWaits({ now: at })).toMatchObject({ examined: 1, held: 1 });
      expect(await episodeRow(open[0]!.id)).toMatchObject({ gateCheckedAt: at });
    });

    it("passes the task's wait from one joined wait to the next as each one ends", async () => {
      const { env, worker, task, companyId } = await envFixture();
      await member(companyId, "owner-1");
      const now = new Date();
      let clock = now;
      const signedOutPool = await account("owner-1", { status: "auth_failed" });
      const withdrawnPool = await account("owner-1", { status: "disabled" });
      const firstAgent = await agent(companyId, { defaultEnvironmentId: localEnvironment.id });
      await bind(firstAgent, signedOutPool.id);
      const secondAgent = await agent(companyId, { defaultEnvironmentId: localEnvironment.id });
      await bind(secondAgent, withdrawnPool.id);
      await environmentAvailabilityService(db).markUnavailable(env.id, { reason: "offline", source: "lease_error", now });
      const { deps, calls } = makeDeps();
      const service = waits(deps, { now: () => clock });
      const assigneeWait = successorOf(await service.finalizeDeferral(await startedRun(worker, task.id), offline(env)));
      const firstWait = successorOf(await service.finalizeDeferral(
        await startedRun(firstAgent, task.id, { mentioned: true }),
        accountWaitDeferral({ reason: "signed_out", accountId: signedOutPool.id, accountLabel: signedOutPool.label }),
      ));
      clock = seconds(now, 1);
      const secondWait = successorOf(await service.finalizeDeferral(
        await startedRun(secondAgent, task.id, { mentioned: true }),
        accountWaitDeferral({ reason: "withdrawn", accountId: withdrawnPool.id, accountLabel: withdrawnPool.label }),
      ));
      const openEpisodes = () => db.select().from(resourceWaitEpisodes).where(isNull(resourceWaitEpisodes.resolvedAt));

      // The device is back for the assignee: the oldest joined wait takes the task's wait over.
      clock = seconds(now, 2);
      await db.update(heartbeatRuns).set({ status: "running", startedAt: clock }).where(eq(heartbeatRuns.id, assigneeWait));
      expect(await service.noteRunPassed({ run: await runRow(assigneeWait), step: "lease" })).toMatchObject({ resolved: true });
      expect(await openEpisodes()).toEqual([expect.objectContaining({ reason: "signed_out", currentRunId: firstWait })]);

      // Its token is replaced and its run passes credentials: the other joined wait takes over next.
      clock = seconds(now, 3);
      await db.update(aiAccounts).set({ status: "active" }).where(eq(aiAccounts.id, signedOutPool.id));
      await db.update(heartbeatRuns).set({ status: "running", startedAt: clock }).where(eq(heartbeatRuns.id, firstWait));
      expect(await service.noteRunPassed({ run: await runRow(firstWait), step: "credentials" })).toMatchObject({ resolved: true });
      expect(await openEpisodes()).toEqual([expect.objectContaining({ reason: "withdrawn", currentRunId: secondWait, agentId: secondAgent.id })]);
      expect(calls.notices.map((notice) => notice.body)).toEqual([
        expect.stringContaining("it is signed out"),
        expect.stringMatching(/^Started after waiting/),
        expect.stringContaining("it is switched off"),
      ]);
    });

    it("cancels a joined wait in the same tick when the owner's wait is abandoned on a closed task, however far out its next check is", async () => {
      const { env, worker, task, companyId } = await envFixture();
      const sandbox = await environment("sandbox", { provider: "box", deviceId: "d-5" });
      const mentioned = await agent(companyId, { defaultEnvironmentId: sandbox.id });
      const now = new Date();
      await environmentAvailabilityService(db).markUnavailable(env.id, { reason: "offline", source: "lease_error", now });
      const { deps, calls } = makeDeps();
      const service = waits(deps, { now: () => now });
      const assigneeWait = successorOf(await service.finalizeDeferral(await startedRun(worker, task.id), offline(env)));
      const riderWait = successorOf(await service.finalizeDeferral(
        await startedRun(mentioned, task.id, { mentioned: true }),
        environmentWaitDeferral({ reason: "stopped", scope: "admission", environment: { id: sandbox.id, name: sandbox.name } }),
      ));
      await db.update(heartbeatRuns).set({ scheduledRetryAt: seconds(now, 3600) }).where(eq(heartbeatRuns.id, riderWait));
      // The task was closed and the assignee's wait was cancelled more than 10 minutes ago, without a newer run.
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, task.id));
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: seconds(now, -660) }).where(eq(heartbeatRuns.id, assigneeWait));
      expect(await service.sweepResourceWaits({ now })).toMatchObject({ episodesAbandoned: 1 });
      expect(await db.select().from(resourceWaitEpisodes).where(isNull(resourceWaitEpisodes.resolvedAt))).toEqual([]);
      expect((await runRow(riderWait)).scheduledRetryAt!.getTime()).toBeLessThanOrEqual(now.getTime());
      await createRunDispatch(db).promoteDueScheduledRetries({ now, cutoff: null });
      expect(await runRow(riderWait)).toMatchObject({ status: "cancelled", errorCode: "issue_terminal_status" });
      expect(calls.notices).toEqual([]);
    });
  });

  describe("stale registry rows", () => {
    /** An outage checked 10.5 minutes ago whose backoff (10 min ± 20 %) put the next check at 11.5 minutes. */
    async function staleFixture(waiterCount: number) {
      const { env, worker, task, companyId } = await envFixture();
      const now = new Date();
      const checkedAt = seconds(now, -630);
      await environmentAvailabilityService(db).markUnavailable(env.id, { reason: "offline", source: "lease_error", now: checkedAt });
      await db.update(environmentAvailability)
        .set({ checkFailures: 6, nextCheckAt: seconds(checkedAt, 690) })
        .where(eq(environmentAvailability.environmentId, env.id));
      const waiting: Array<Awaited<ReturnType<typeof waitingRun>>> = [];
      for (let index = 0; index < waiterCount; index += 1) {
        const row = index === 0 ? worker : await agent(companyId, { defaultEnvironmentId: env.id });
        const rowTask = index === 0 ? task : await issue(companyId, row.id);
        waiting.push(await waitingRun({
          agent: row, kind: "environment", reason: "offline", scope: "target",
          dueAt: seconds(now, -1), issueId: rowTask.id, environmentId: env.id, since: seconds(now, -3600 + index * 60),
        }));
      }
      return { env, now, waiting };
    }

    it("lets only the oldest waiter make the attempt that refreshes the row; the others re-check in a minute", async () => {
      const { now, waiting } = await staleFixture(3);
      const { deps } = makeDeps();
      expect(await waits(deps).holdDueWaits({ now })).toMatchObject({ examined: 3, proceeding: 1, held: 2 });
      expect((await runRow(waiting[0]!.run.id)).scheduledRetryAt!.getTime()).toBeLessThanOrEqual(now.getTime());
      for (const entry of waiting.slice(1)) {
        const heldFor = (await runRow(entry.run.id)).scheduledRetryAt!.getTime() - now.getTime();
        expect(heldFor).toBeGreaterThanOrEqual(48_000);
        expect(heldFor).toBeLessThanOrEqual(72_000);
      }
    });

    it("wakes the oldest waiter when it is held, instead of letting a newer one attempt", async () => {
      const { now, waiting } = await staleFixture(3);
      await db.update(heartbeatRuns).set({ scheduledRetryAt: seconds(now, 240) }).where(eq(heartbeatRuns.id, waiting[0]!.run.id));
      const { deps } = makeDeps();
      expect(await waits(deps).holdDueWaits({ now })).toMatchObject({ examined: 2, proceeding: 0, held: 2 });
      expect((await runRow(waiting[0]!.run.id)).scheduledRetryAt!.getTime()).toBeLessThanOrEqual(now.getTime());
    });

    it("holds every waiter until a target's retry_after", async () => {
      const { env, now, waiting } = await staleFixture(2);
      await db.update(environmentAvailability).set({ retryAfter: seconds(now, 3 * 3600) }).where(eq(environmentAvailability.environmentId, env.id));
      const { deps } = makeDeps();
      expect(await waits(deps).holdDueWaits({ now })).toMatchObject({ examined: 2, proceeding: 0, held: 2 });
      for (const entry of waiting) expect((await runRow(entry.run.id)).scheduledRetryAt!.getTime()).toBe(now.getTime() + 5 * 60_000);
    });

    it("the sweep checks a row a minute before its backoff would let it go stale", async () => {
      const { env, worker, task } = await envFixture();
      const now = new Date();
      const checkedAt = seconds(now, -570);
      const registry = environmentAvailabilityService(db);
      await registry.markUnavailable(env.id, { reason: "unreachable", source: "lease_error", now: checkedAt });
      await db.update(environmentAvailability).set({ checkFailures: 6, nextCheckAt: seconds(checkedAt, 690) })
        .where(eq(environmentAvailability.environmentId, env.id));
      await waitingRun({ agent: worker, kind: "environment", reason: "unreachable", scope: "target", dueAt: seconds(now, 120), issueId: task.id, environmentId: env.id });
      const probed: string[] = [];
      probeStub.impl = async (environment) => {
        probed.push(environment.id);
        return { ok: false, driver: "ssh", summary: "SSH probe failed", details: { code: 255, error: "ssh: connect to host runner.invalid port 22: Connection refused" } };
      };
      const { deps } = makeDeps();
      const service = waits(deps);
      // A target that asked for a later retry is left alone.
      await db.update(environmentAvailability).set({ retryAfter: seconds(now, 600) }).where(eq(environmentAvailability.environmentId, env.id));
      expect((await service.sweepResourceWaits({ now })).checks).toEqual([]);
      // So is a row whose last check told nothing: its next check is the moment it goes stale.
      await db.update(environmentAvailability).set({ retryAfter: null, nextCheckAt: seconds(checkedAt, 600) })
        .where(eq(environmentAvailability.environmentId, env.id));
      expect((await service.sweepResourceWaits({ now })).checks).toEqual([]);
      await db.update(environmentAvailability).set({ nextCheckAt: seconds(checkedAt, 690) }).where(eq(environmentAvailability.environmentId, env.id));
      const result = await service.sweepResourceWaits({ now });
      expect(result.checks).toEqual([expect.objectContaining({ environmentId: env.id, state: "unavailable" })]);
      expect(probed).toEqual([env.id]);
      const [row] = await db.select().from(environmentAvailability).where(eq(environmentAvailability.environmentId, env.id));
      expect(row!.checkedAt!.getTime()).toBe(now.getTime());
    });
  });

  describe("finalizeDeferral", () => {
    async function runningRun(worker: AgentRow, issueId: string) {
      const [run] = await db.insert(heartbeatRuns).values({
        companyId: worker.companyId,
        agentId: worker.id,
        status: "running",
        startedAt: new Date(),
        scheduledRetryAttempt: 2,
        scheduledRetryReason: "transient_failure",
        contextSnapshot: { issueId },
      }).returning();
      await db.update(issues).set({ executionRunId: run!.id }).where(eq(issues.id, issueId));
      return run!;
    }

    it("writes an expected cancellation, moves the lock to a lane successor and keeps the failure count", async () => {
      const { env, worker, task } = await envFixture();
      const run = await runningRun(worker, task.id);
      const { deps, calls } = makeDeps();
      const service = waits(deps);
      const epochs = await readWakeEpochs(db, { environmentId: env.id, agentId: worker.id });
      const deferral = await service.toDeferral(
        Object.assign(new Error("ssh failed"), { code: 255, stderr: "ssh: connect to host runner.invalid port 22: Connection refused" }),
        { run, agent: worker, environment: env, epochs },
      );
      expect(deferral).toMatchObject({ wait: { kind: "environment", reason: "unreachable", scope: "target", message: null } });
      const result = await service.finalizeDeferral(run, deferral as ResourceWaitDeferral);
      expect(result.outcome).toBe("scheduled");
      const cancelled = await runRow(run.id);
      expect(cancelled).toMatchObject({ status: "cancelled", errorCode: "environment_unavailable" });
      expect(cancelled.resultJson).toMatchObject({
        executionRecovery: { kind: "resource_wait", providerWorkStarted: false },
        cancellation: { source: "control_plane", expected: true, initiator: { type: "system" } },
      });
      const context = readResourceWaitContext(cancelled.resultJson?.resourceWait);
      expect(context).toMatchObject({ kind: "environment", reason: "unreachable", environmentId: env.id, message: null });
      expect(cancelled.contextSnapshot?.resourceWaitDeferredWhileAssignee).toBe(true);
      expect(legacyExecutionNeedsReconciliation(cancelled)).toBe(false);

      const successorId = "successorRunId" in result ? result.successorRunId! : "";
      const successor = await runRow(successorId);
      expect(successor).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: "environment_wait", retryOfRunId: run.id });
      expect(readResourceWaitContext(successor.contextSnapshot?.resourceWait)?.episodeId).toBe(context!.episodeId);
      expect(successor.contextSnapshot?.failureRetriesBeforeResourceWait).toBe(2);
      expect((await db.select().from(issues).where(eq(issues.id, task.id)))[0]!.executionRunId).toBe(successorId);
      expect(await episodeRow(context!.episodeId)).toMatchObject({ currentRunId: successorId, kind: "environment", reason: "unreachable" });
      expect(calls.agentStatus).toEqual([worker.id]);
      expect(calls.events.some((event) => event.message?.startsWith("Waiting for device"))).toBe(true);
      expect(calls.released).toEqual([]);
      // The outage is recorded (target scope) and due for a prompt check.
      const [registry] = await db.select().from(environmentAvailability).where(eq(environmentAvailability.environmentId, env.id));
      expect(registry).toMatchObject({ state: "unavailable", reason: "unreachable", message: null });
      expect(registry!.nextCheckAt!.getTime()).toBeLessThanOrEqual(Date.now());
      const started = await db.select().from(activityLog).where(eq(activityLog.action, "resource_wait.started"));
      expect(started).toHaveLength(1);
      expect(started[0]!.details).toMatchObject({ kind: "environment", reason: "unreachable" });
      // A device wait notifies only after the threshold.
      expect(calls.notices).toEqual([]);
    });

    it("makes the successor due now when a report raced the attempt", async () => {
      const { env, worker, task } = await envFixture();
      const run = await runningRun(worker, task.id);
      const registry = environmentAvailabilityService(db);
      await registry.markUnavailable(env.id, { reason: "offline", source: "plugin_report", now: new Date() });
      const epochs = await readWakeEpochs(db, { environmentId: env.id, agentId: worker.id });
      const { deps } = makeDeps({
        // The target came back between the attempt and the successor insert.
        afterSuccessorInsert: async () => {
          await registry.applyTargetState([env.id], { state: "available" });
        },
      });
      const service = waits(deps);
      const deferral = environmentWaitDeferral({ reason: "offline", scope: "target", environment: { id: env.id, name: env.name }, epochs });
      const result = await service.finalizeDeferral(run, deferral);
      expect(result).toMatchObject({ outcome: "scheduled", dueNow: true });
      const successor = await runRow(("successorRunId" in result && result.successorRunId) || "");
      expect(successor.scheduledRetryAt!.getTime()).toBeLessThanOrEqual(Date.now());

      // Without a race the successor waits.
      const quiet = await runningRun(await agent(worker.companyId, { defaultEnvironmentId: env.id }), (await issue(worker.companyId, worker.id)).id);
      const { deps: plain } = makeDeps();
      const calm = await waits(plain).finalizeDeferral(quiet, environmentWaitDeferral({
        reason: "offline", scope: "target", environment: { id: env.id, name: env.name },
        epochs: await readWakeEpochs(db, { environmentId: env.id, agentId: quiet.agentId }),
      }));
      expect(calm).toMatchObject({ outcome: "scheduled", dueNow: false });
    });

    it("does not count its own outage record as a race: without a concurrent report the successor waits", async () => {
      const { env, worker, task, companyId } = await envFixture();
      const sshError = () => Object.assign(new Error("ssh failed"), { code: 255, stderr: "ssh: connect to host runner.invalid port 22: Connection refused" });
      const { deps } = makeDeps();
      const service = waits(deps);
      const deferOnce = async (agentRow: AgentRow, issueId: string, between?: () => Promise<unknown>) => {
        const run = await runningRun(agentRow, issueId);
        const epochs = await readWakeEpochs(db, { environmentId: env.id, agentId: agentRow.id });
        await between?.();
        const deferral = await service.toDeferral(sshError(), { run, agent: agentRow, environment: env, epochs });
        return service.finalizeDeferral(run, deferral as ResourceWaitDeferral);
      };
      // The first outage creates the registry row; the second finds it in place.
      expect(await deferOnce(worker, task.id)).toMatchObject({ outcome: "scheduled", dueNow: false });
      const second = await agent(companyId, { defaultEnvironmentId: env.id });
      expect(await deferOnce(second, (await issue(companyId, second.id)).id)).toMatchObject({ outcome: "scheduled", dueNow: false });
      // A report that the target is back lands between the attempt and the record: a real race.
      const third = await agent(companyId, { defaultEnvironmentId: env.id });
      const raced = await deferOnce(third, (await issue(companyId, third.id)).id, () =>
        environmentAvailabilityService(db).applyTargetState([env.id], { state: "available" }));
      expect(raced).toMatchObject({ outcome: "scheduled", dueNow: true });
    });

    it("releases the issue lock and abandons the episode when no successor can be scheduled", async () => {
      const { env, worker, task } = await envFixture();
      const run = await runningRun(worker, task.id);
      const { deps, calls } = makeDeps({ refuseSchedule: true });
      const result = await waits(deps).finalizeDeferral(run, environmentWaitDeferral({
        reason: "offline", scope: "target", environment: { id: env.id, name: env.name },
      }));
      expect(result.outcome).toBe("not_scheduled");
      expect(calls.released).toEqual([run.id]);
      expect((await db.select().from(issues).where(eq(issues.id, task.id)))[0]!.executionRunId).toBeNull();
      expect(await episodeRow(result.episodeId!)).toMatchObject({ resolution: "abandoned" });
      expect((await runRow(run.id)).status).toBe("cancelled");
      expect(calls.agentStatus).toEqual([worker.id]);
    });

    it("skips a run that already left running", async () => {
      const { env, worker, task } = await envFixture();
      const run = await runningRun(worker, task.id);
      await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, run.id));
      const { deps, calls } = makeDeps();
      const result = await waits(deps).finalizeDeferral(run, environmentWaitDeferral({
        reason: "offline", scope: "target", environment: { id: env.id, name: env.name },
      }));
      expect(result.outcome).toBe("skipped");
      expect(calls.scheduled).toEqual([]);
      expect(await db.select().from(resourceWaitEpisodes)).toEqual([]);
    });
  });

  describe("run-path hooks", () => {
    it("preflight refuses a retired environment and waits on a fresh outage only", async () => {
      const { env, worker } = await envFixture();
      const now = new Date();
      const registry = environmentAvailabilityService(db);
      const { deps } = makeDeps();
      const service = waits(deps, { now: () => now });
      const run = { id: randomUUID(), companyId: worker.companyId, agentId: worker.id };
      expect((await service.preflightEnvironment({ run, agent: worker, environment: env })).action).toBe("continue");
      await registry.markUnavailable(env.id, { reason: "offline", source: "lease_error", now });
      const waiting = await service.preflightEnvironment({ run, agent: worker, environment: env });
      expect(waiting).toMatchObject({ action: "wait", deferral: { wait: { kind: "environment", reason: "offline", scope: "target" } } });
      expect((await service.preflightEnvironment({ run, agent: worker, environment: env, skip: true })).action).toBe("continue");
      const stale = waits(deps, { now: () => new Date(now.getTime() + 11 * 60_000) });
      expect((await stale.preflightEnvironment({ run, agent: worker, environment: env })).action).toBe("continue");
      await registry.markRetired([env.id], { now });
      const refused = await service.preflightEnvironment({ run, agent: worker, environment: env });
      expect(refused.action).toBe("refuse");
      expect(refused.action === "refuse" && refused.refusal.message).toContain(`move ${worker.name} to another device`);
      expect(refused.action === "refuse" && refused.refusal.resultJson).toMatchObject({ configurationIncomplete: { reason: "environment_refused" } });
    });

    it("ends a waiting run's episode as refused when its environment was retired", async () => {
      const { env, worker, task } = await envFixture();
      const now = new Date();
      const { run, episode } = await waitingRun({ agent: worker, kind: "environment", reason: "offline", scope: "target", dueAt: now, issueId: task.id, environmentId: env.id });
      await environmentAvailabilityService(db).markRetired([env.id], { now });
      const { deps } = makeDeps();
      const result = await waits(deps).preflightEnvironment({ run, agent: worker, environment: env });
      expect(result.action).toBe("refuse");
      expect(await episodeRow(episode.id)).toMatchObject({ resolution: "refused" });
      // A retired row stays: new runs keep refusing.
      expect(await db.select().from(environmentAvailability).where(eq(environmentAvailability.environmentId, env.id))).toHaveLength(1);
    });

    it("keeps admission refusals out of the registry", async () => {
      const { env, worker } = await envFixture();
      const { deps } = makeDeps();
      const service = waits(deps);
      const run = { id: randomUUID(), companyId: worker.companyId, agentId: worker.id };
      const sandbox = await environment("sandbox", { provider: "box", deviceId: "d-9" });
      const refusal = Object.assign(new Error("not serving"), {
        data: { schema: "paperclip/environment-unavailable/v1", unavailable: { scope: "admission", reason: "other", retryable: true, message: "Membership lookup failed." } },
      });
      const deferral = await service.toDeferral(refusal, { run, environment: sandbox });
      expect(deferral).toMatchObject({ wait: { scope: "admission", reason: "other", message: "Membership lookup failed." } });
      expect(await db.select().from(environmentAvailability)).toEqual([]);
      const throttled = Object.assign(new Error("ssh"), { code: 255, stderr: "kex_exchange_identification: Connection closed by remote host" });
      expect(await service.toDeferral(throttled, { run, environment: env })).toMatchObject({ wait: { scope: "admission", reason: "throttled" } });
      expect(await db.select().from(environmentAvailability)).toEqual([]);
    });

    it("noteAcquired wakes target-scope waits only; noteRunPassed resolves after the lease", async () => {
      const { env, worker, task, companyId } = await envFixture();
      const now = new Date();
      const registry = environmentAvailabilityService(db);
      await registry.markUnavailable(env.id, { reason: "offline", source: "lease_error", now });
      const target = await waitingRun({ agent: worker, kind: "environment", reason: "offline", scope: "target", dueAt: seconds(now, 300), issueId: task.id, environmentId: env.id });
      const otherAgent = await agent(companyId, { defaultEnvironmentId: env.id });
      const admission = await waitingRun({ agent: otherAgent, kind: "environment", reason: "not_serving", scope: "admission", dueAt: seconds(now, 300), environmentId: env.id });
      const { deps, calls } = makeDeps();
      const service = waits(deps);
      expect(await service.noteAcquired(env.id)).toEqual({ changed: true, woken: 1 });
      expect((await runRow(target.run.id)).scheduledRetryAt!.getTime()).toBeLessThanOrEqual(Date.now());
      expect((await runRow(admission.run.id)).scheduledRetryAt!.getTime()).toBe(seconds(now, 300).getTime());
      expect(await service.noteAcquired(env.id)).toEqual({ changed: false, woken: 0 });

      // The run passes credentials first: an environment wait is not over yet.
      const promoted = await runRow(target.run.id);
      expect(await service.noteRunPassed({ run: promoted, step: "credentials" })).toMatchObject({ resolved: false });
      expect(await service.noteRunPassed({ run: promoted, step: "lease" })).toMatchObject({ resolved: true, episodeId: target.episode.id });
      expect(await episodeRow(target.episode.id)).toMatchObject({ resolution: "resolved" });
      expect(calls.events.some((event) => event.message?.startsWith("Resumed after waiting"))).toBe(true);
      expect(await db.select().from(activityLog).where(eq(activityLog.action, "resource_wait.resolved"))).toHaveLength(1);
      expect(await service.noteRunPassed({ run: promoted, step: "lease" })).toMatchObject({ resolved: false });
    });
  });

  describe("sweep and check now", () => {
    function fakeWorkers(answer: () => unknown, supportedMethods = ["environmentCheckAvailability"]) {
      const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
      const manager = {
        isRunning: () => true,
        getWorker: () => ({ supportedMethods }),
        call: async (_pluginId: string, method: string, params: Record<string, unknown>) => {
          calls.push({ method, params });
          return answer();
        },
      } as unknown as PluginWorkerManager;
      return { manager, calls };
    }

    async function sandboxFixture() {
      const companyId = await company();
      await db.insert(plugins).values({
        pluginKey: `test.box.${tag()}`,
        packageName: "test-box",
        version: "1.0.0",
        status: "ready",
        manifestJson: { id: "test.box", displayName: "Box", environmentDrivers: [{ driverKey: "box", kind: "sandbox_provider", displayName: "Box" }] } as never,
      });
      const sandbox = await environment("sandbox", { provider: "box", deviceId: "d-1" });
      const worker = await agent(companyId, { defaultEnvironmentId: sandbox.id });
      const task = await issue(companyId, worker.id);
      return { companyId, sandbox, worker, task };
    }

    it("checks a plugin target and wakes its waits when it is back", async () => {
      const { sandbox, worker, task } = await sandboxFixture();
      const now = new Date();
      const registry = environmentAvailabilityService(db);
      await registry.markUnavailable(sandbox.id, { reason: "offline", source: "lease_error", now: new Date(now.getTime() - 60_000) });
      await registry.setDueNow([sandbox.id], { now: new Date(now.getTime() - 1000) });
      const { run } = await waitingRun({ agent: worker, kind: "environment", reason: "offline", scope: "target", dueAt: seconds(now, 120), issueId: task.id, environmentId: sandbox.id });
      const { manager, calls } = fakeWorkers(() => ({ state: "available" }));
      const { deps } = makeDeps();
      const result = await waits(deps, { pluginWorkerManager: manager }).sweepResourceWaits({ now });
      expect(result.skipped).toBe(false);
      expect(result.checks).toEqual([expect.objectContaining({ environmentId: sandbox.id, state: "available", becameAvailable: true, woken: 1 })]);
      expect(calls).toEqual([expect.objectContaining({ method: "environmentCheckAvailability" })]);
      expect(calls[0]!.params).not.toHaveProperty("projectId");
      expect((await runRow(run.id)).scheduledRetryAt!.getTime()).toBeLessThanOrEqual(now.getTime());
    });

    it("never calls a plugin without the check method and leaves the row to go stale", async () => {
      const { sandbox, worker, task } = await sandboxFixture();
      const now = new Date();
      const registry = environmentAvailabilityService(db);
      const checkedAt = new Date(now.getTime() - 60_000);
      await registry.markUnavailable(sandbox.id, { reason: "offline", source: "lease_error", now: checkedAt });
      await registry.setDueNow([sandbox.id], { now: checkedAt });
      await waitingRun({ agent: worker, kind: "environment", reason: "offline", scope: "target", dueAt: seconds(now, 120), issueId: task.id, environmentId: sandbox.id });
      const { manager, calls } = fakeWorkers(() => ({ state: "available" }), []);
      const { deps } = makeDeps();
      const result = await waits(deps, { pluginWorkerManager: manager }).sweepResourceWaits({ now });
      expect(result.checks).toEqual([expect.objectContaining({ state: "unknown", detail: "plugin:unsupported" })]);
      expect(calls).toEqual([]);
      const [row] = await db.select().from(environmentAvailability).where(eq(environmentAvailability.environmentId, sandbox.id));
      expect(row!.checkedAt!.getTime()).toBe(checkedAt.getTime());
      expect(row!.nextCheckAt!.getTime()).toBe(checkedAt.getTime() + 10 * 60_000);
    });

    it("answers still unavailable to Check now while the target is down, once a minute", async () => {
      const { sandbox, worker, task } = await sandboxFixture();
      const now = new Date();
      await environmentAvailabilityService(db).markUnavailable(sandbox.id, { reason: "offline", source: "lease_error", now });
      const { run } = await waitingRun({ agent: worker, kind: "environment", reason: "offline", scope: "target", dueAt: seconds(now, 120), issueId: task.id, environmentId: sandbox.id });
      let state: unknown = { state: "unavailable", unavailable: { scope: "target", reason: "offline", retryable: true, message: "Asleep." } };
      const { manager } = fakeWorkers(() => state);
      const { deps } = makeDeps();
      const service = waits(deps, { pluginWorkerManager: manager });
      const first = await service.checkRunNow({ runId: run.id, now });
      expect(first).toMatchObject({ outcome: "still_unavailable", details: { code: "resource_still_unavailable", resourceWait: { kind: "environment", reason: "offline" } } });
      expect((await service.checkRunNow({ runId: run.id, now: seconds(now, 30) })).outcome).toBe("rate_limited");
      state = { state: "available" };
      const later = await service.checkRunNow({ runId: run.id, now: seconds(now, 61) });
      expect(later.outcome).toBe("proceed");
      expect((await runRow(run.id)).scheduledRetryAt!.getTime()).toBeLessThanOrEqual(seconds(now, 61).getTime());
    });

    it("abandons an episode whose run ended, clears a stale probe and prunes registry rows without waits", async () => {
      const { env, worker, task } = await envFixture();
      const now = new Date();
      const registry = environmentAvailabilityService(db);
      await registry.markUnavailable(env.id, { reason: "offline", source: "lease_error", now: new Date(now.getTime() - 30 * 60_000) });
      const { run, episode } = await waitingRun({ agent: worker, kind: "environment", reason: "offline", scope: "target", dueAt: now, issueId: task.id, environmentId: env.id });
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(now.getTime() - 11 * 60_000) }).where(eq(heartbeatRuns.id, run.id));
      await db.update(environmentAvailability).set({ updatedAt: new Date(now.getTime() - 30 * 60_000) }).where(eq(environmentAvailability.environmentId, env.id));
      await member(worker.companyId, "owner-1");
      const pool = await account("owner-1", { limitProbeRunId: run.id });
      const { deps } = makeDeps();
      const result = await waits(deps).sweepResourceWaits({ now });
      expect(result).toMatchObject({ episodesAbandoned: 1, probesCleared: 1 });
      expect(await episodeRow(episode.id)).toMatchObject({ resolution: "abandoned" });
      expect((await db.select().from(aiAccounts).where(eq(aiAccounts.id, pool.id)))[0]!.limitProbeRunId).toBeNull();
      expect(await db.select().from(environmentAvailability)).toEqual([]);
    });

    async function sshWaitFixture() {
      const { env, worker, task, companyId } = await envFixture();
      await db.insert(aiAccountHosts).values({ name: "SSH · Runner", kind: "ssh_host", externalKey: "ssh:runner.invalid:22" });
      const now = new Date();
      const registry = environmentAvailabilityService(db);
      await registry.markUnavailable(env.id, { reason: "unreachable", source: "lease_error", now: new Date(now.getTime() - 60_000) });
      await registry.setDueNow([env.id], { now: new Date(now.getTime() - 1000) });
      const waitingRow = await waitingRun({ agent: worker, kind: "environment", reason: "unreachable", scope: "target", dueAt: seconds(now, 120), issueId: task.id, environmentId: env.id });
      return { env, worker, task, companyId, now, waitingRow };
    }

    it("probes an SSH wait in the waiting run's company and wakes it when the host answers", async () => {
      const { env, companyId, now, waitingRow } = await sshWaitFixture();
      const probed: Array<string | null | undefined> = [];
      probeStub.impl = async (_environment, options) => {
        probed.push(options.companyId);
        return { ok: true, driver: "ssh", summary: "Connected", details: {} };
      };
      const { deps } = makeDeps();
      const result = await waits(deps).sweepResourceWaits({ now });
      expect(result.checks).toEqual([expect.objectContaining({ environmentId: env.id, state: "available", detail: "probe", woken: 1 })]);
      expect(probed).toEqual([companyId]);
      expect((await runRow(waitingRow.run.id)).scheduledRetryAt!.getTime()).toBeLessThanOrEqual(now.getTime());
    });

    it.each([
      ["still unreachable", { code: 255, error: "ssh: connect to host runner.invalid port 22: Connection refused" }, "unavailable"],
      ["login refused (the host answered)", { code: 255, error: "runner@runner.invalid: Permission denied (publickey)." }, "available"],
      ["remote command failed (the host answered)", { code: 1, error: "mkdir: cannot create directory" }, "available"],
      ["sshd throttling", { code: 255, error: "kex_exchange_identification: Connection closed by remote host" }, "unknown"],
      ["probe killed", { code: null, error: "" }, "unknown"],
    ] as const)("classifies an SSH probe that failed: %s", async (_label, details, expected) => {
      const { env, now } = await sshWaitFixture();
      probeStub.impl = async () => ({ ok: false, driver: "ssh", summary: "SSH probe failed", details: { host: "runner.invalid", port: 22, ...details } });
      const { deps } = makeDeps();
      const result = await waits(deps).sweepResourceWaits({ now });
      expect(result.checks).toEqual([expect.objectContaining({ environmentId: env.id, state: expected })]);
      const [row] = await db.select().from(environmentAvailability).where(eq(environmentAvailability.environmentId, env.id));
      expect(row!.state).toBe(expected === "available" ? "available" : "unavailable");
      // Never stderr, a host or a port in the registry.
      expect(JSON.stringify([row!.label, row!.message])).not.toContain("runner.invalid");
      if (expected === "unavailable") expect(row).toMatchObject({ reason: "unreachable", label: "SSH · Runner", message: null, checkFailures: 1 });
    });

    it("checks a device's environments for its page's Check now and wakes the company's waits", async () => {
      const { env, companyId, now, waitingRow } = await sshWaitFixture();
      const [device] = await db.select().from(aiAccountHosts).where(eq(aiAccountHosts.externalKey, "ssh:runner.invalid:22"));
      probeStub.impl = async () => ({ ok: true, driver: "ssh", summary: "Connected", details: {} });
      const { deps } = makeDeps();
      const result = await waits(deps).checkDeviceNow({ companyId, deviceId: device!.id, now });
      expect(result.checks).toEqual([expect.objectContaining({ environmentId: env.id, state: "available" })]);
      expect(result.woken).toBeGreaterThanOrEqual(1);
      expect((await runRow(waitingRow.run.id)).scheduledRetryAt!.getTime()).toBeLessThanOrEqual(now.getTime());
      // Another company sees none of this device's environments here.
      const elsewhere = await waits(deps).checkDeviceNow({ companyId: await company(), deviceId: randomUUID(), now });
      expect(elsewhere.checks).toEqual([]);
    });

    it("answers 409 details to Check now on an SSH wait while the host is down", async () => {
      const { now, waitingRow } = await sshWaitFixture();
      probeStub.impl = async () => ({ ok: false, driver: "ssh", summary: "SSH probe failed", details: { code: 255, error: "ssh: connect to host runner.invalid port 22: Operation timed out" } });
      const { deps } = makeDeps();
      const result = await waits(deps).checkRunNow({ runId: waitingRow.run.id, source: "retry_now", now });
      expect(result).toMatchObject({
        outcome: "still_unavailable",
        check: { state: "unavailable" },
        details: { code: "resource_still_unavailable", resourceWait: { reason: "unreachable", since: waitingRow.episode.since.toISOString() } },
      });
      // A comment only re-evaluates, and the minute's slot is taken anyway.
      expect((await waits(deps).checkRunNow({ runId: waitingRow.run.id, source: "comment", now: seconds(now, 10) })).outcome).toBe("rate_limited");
    });

    it("with the kill switch set only wakes environment waits", async () => {
      const { env, worker, task } = await envFixture();
      const now = new Date();
      const { run } = await waitingRun({ agent: worker, kind: "environment", reason: "offline", scope: "target", dueAt: seconds(now, 300), issueId: task.id, environmentId: env.id });
      const { deps } = makeDeps();
      const result = await waits(deps, { environmentWaitsEnabled: false }).sweepResourceWaits({ now });
      expect(result).toMatchObject({ killSwitchWoken: 1, checks: [] });
      expect((await runRow(run.id)).scheduledRetryAt!.getTime()).toBeLessThanOrEqual(now.getTime());
    });
  });

  it("wakes by account, agent and plugin, and staggers with jitter", async () => {
    const companyId = await company();
    await member(companyId, "owner-1");
    const pool = await account("owner-1");
    const now = new Date();
    const runs: Array<Awaited<ReturnType<typeof waitingRun>>> = [];
    for (let index = 0; index < 4; index += 1) {
      const row = await agent(companyId, { defaultEnvironmentId: localEnvironment.id });
      await bind(row, pool.id);
      runs.push(await waitingRun({ agent: row, kind: "ai_account", reason: "usage_limit", scope: "account", dueAt: seconds(now, 3600), accountId: pool.id }));
    }
    const woken = await wakeResourceWaits(db, { accountIds: [pool.id] }, { now, jitterMs: 120_000 });
    expect(woken.runIds).toHaveLength(4);
    for (const { run } of runs) {
      const at = (await runRow(run.id)).scheduledRetryAt!.getTime();
      expect(at).toBeGreaterThanOrEqual(now.getTime());
      expect(at).toBeLessThanOrEqual(now.getTime() + 120_000);
    }
    expect((await wakeResourceWaits(db, { agentIds: [runs[0]!.run.agentId], kinds: ["environment"] }, { now })).runIds).toEqual([]);
    expect((await wakeResourceWaits(db, {}, { now })).runIds).toEqual([]);
    expect(await db.select().from(agentWakeupRequests)).toEqual([]);
    expect(await db.select().from(heartbeatRunEvents)).toEqual([]);
  });
});
