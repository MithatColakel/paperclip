import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import express from "express";
import request from "supertest";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  aiAccountAgentBindings,
  companies,
  companyMemberships,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issueTreeHolds,
  issues,
  resourceWaitEpisodes,
  resourceWaitNotices,
} from "@paperclipai/db";
import { buildResourceWaitContext } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { captureQueries, explainAnalyze, rowsExamined, scansOf } from "./helpers/query-plan.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";
import { runningProcesses } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres scheduled retry route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("issue scheduled retry routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-scheduled-retry-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(environmentLeases);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueTreeHolds);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  function boardActor(companyId: string, source: "session" | "local_implicit" = "session"): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
      source,
    };
  }

  function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId: randomUUID(),
      source: "agent_jwt",
    };
  }

  async function seedIssueWithRetry(input: {
    agentStatus?: "active" | "paused";
    retryStatus?: "scheduled_retry" | "queued" | "running";
    issueStatus?: "in_progress" | "todo" | "done" | "cancelled";
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();
    const retryRunId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = new Date("2026-05-06T18:00:00.000Z");
    const scheduledRetryAt = new Date("2026-05-06T19:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: input.agentStatus ?? "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "transient upstream error",
      errorCode: "adapter_failed",
      finishedAt: now,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "bounded_transient_heartbeat_retry",
      payload: {
        issueId,
        retryOfRunId: sourceRunId,
        scheduledRetryAt: scheduledRetryAt.toISOString(),
      },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: retryRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: input.retryStatus ?? "scheduled_retry",
      wakeupRequestId,
      retryOfRunId: sourceRunId,
      scheduledRetryAt,
      scheduledRetryAttempt: 2,
      scheduledRetryReason: "transient_failure",
      contextSnapshot: {
        issueId,
        wakeReason: "bounded_transient_heartbeat_retry",
        retryOfRunId: sourceRunId,
        scheduledRetryAt: scheduledRetryAt.toISOString(),
        scheduledRetryAttempt: 2,
        retryReason: "transient_failure",
      },
      updatedAt: now,
      createdAt: now,
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: retryRunId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retryable issue",
      status: input.issueStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: retryRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId, sourceRunId, retryRunId, scheduledRetryAt };
  }

  it("finishes a parked retry cancellation after its owner loses the final database write", async () => {
    const f = await seedIssueWithRetry({ agentStatus: "paused" });
    const unrelated = await seedIssueWithRetry({ agentStatus: "paused" });
    await db.execute(sql`ALTER TABLE heartbeat_runs ADD CONSTRAINT reject_retry_cancellation CHECK (status <> 'cancelled') NOT VALID`);
    try {
      await expect(heartbeatService(db).cancelRun(f.retryRunId, "Superseded by a human comment", {
        expectedStatus: "scheduled_retry",
      })).rejects.toThrow();
      // A failed sweep leaves the same durable intent available for a later one.
      await heartbeatService(db).reapOrphanedRuns();
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.retryRunId)))
        .toEqual([expect.objectContaining({ status: "scheduled_retry" })]);
    } finally {
      await db.execute(sql`ALTER TABLE heartbeat_runs DROP CONSTRAINT reject_retry_cancellation`);
    }
    const [interrupted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.retryRunId));
    expect(interrupted).toMatchObject({ status: "scheduled_retry", resultJson: {
      startupCancellation: expect.any(Object), cancellation: { reason: "Superseded by a human comment" },
    } });

    // A fresh service has no process-local cancellation owner or settlement promise.
    await heartbeatService(db).reapOrphanedRuns();
    const [cancelled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.retryRunId));
    expect(cancelled).toMatchObject({ status: "cancelled", error: "Superseded by a human comment" });
    expect(cancelled!.resultJson!.cancellation).toEqual(interrupted!.resultJson!.cancellation);
    expect(await db.select().from(issues).where(eq(issues.id, f.issueId)))
      .toEqual([expect.objectContaining({ executionRunId: null, assigneeAgentId: f.agentId })]);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, f.retryRunId)))
      .toEqual([expect.objectContaining({ status: "cancelled" })]);
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.retryRunId));
    await heartbeatService(db).reapOrphanedRuns();
    expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.retryRunId))).toEqual(events);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, unrelated.retryRunId)))
      .toEqual([expect.objectContaining({ status: "scheduled_retry", resultJson: null })]);
  });

  it.each(["post", "patch"] as const)("keeps a retry's live process and saved work owner when a %s comment arrives", async method => {
    const f = await seedIssueWithRetry({ retryStatus: "running" });
    await db.insert(companyMemberships).values({
      companyId: f.companyId, principalType: "user", principalId: "board-user",
      membershipRole: "admin", status: "active",
    });
    const child = spawn(process.execPath, ["-e", `
      process.on('message', message => {
        if (message === 'continue-work') process.send('work-continues');
      });
      process.send('ready');
    `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const exited = once(child, "exit");
    const heartbeat = heartbeatService(db);
    try {
      await once(child, "message", { signal: AbortSignal.timeout(5_000) });
      runningProcesses.set(f.retryRunId, { child, graceSec: 1, processGroupId: null });
      await db.update(heartbeatRuns).set({
        startedAt: new Date(), runtimeModeResolvedAt: new Date(), processPid: child.pid,
      }).where(eq(heartbeatRuns.id, f.retryRunId));
      const app = createApp(boardActor(f.companyId));

      const res = method === "post"
        ? await request(app).post(`/api/issues/${f.issueId}/comments`).send({ body: "Verified source recovery; continue the original work." })
        : await request(app).patch(`/api/issues/${f.issueId}`).send({ comment: "Verified source recovery; continue the original work." });

      expect(res.status, JSON.stringify(res.body)).toBe(method === "post" ? 201 : 200);
      await heartbeat.drainActiveRunExecutions();
      const progress = once(child, "message", { signal: AbortSignal.timeout(5_000) });
      child.send("continue-work");
      expect((await progress)[0]).toBe("work-continues");
      const [savedIssue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      const [savedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.retryRunId));
      expect(savedIssue).toMatchObject({ status: "in_progress", executionRunId: f.retryRunId });
      expect(savedRun).toMatchObject({ status: "running", processPid: child.pid });
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId)))
        .toHaveLength(1);
      expect(await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "running"),
      ))).toHaveLength(1);
    } finally {
      await heartbeat.drainActiveRunExecutions();
      runningProcesses.delete(f.retryRunId);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
  });

  it("surfaces the current scheduled retry in the issue read model", async () => {
    const { companyId, issueId, agentId, sourceRunId, retryRunId, scheduledRetryAt } = await seedIssueWithRetry();

    const res = await request(createApp(boardActor(companyId, "local_implicit"))).get(`/api/issues/${issueId}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.scheduledRetry).toMatchObject({
      runId: retryRunId,
      status: "scheduled_retry",
      agentId,
      agentName: "CodexCoder",
      retryOfRunId: sourceRunId,
      scheduledRetryAttempt: 2,
      scheduledRetryReason: "transient_failure",
    });
    expect(res.body.scheduledRetry.scheduledRetryAt).toBe(scheduledRetryAt.toISOString());
  });

  it.each(["queued", "running"] as const)(
    "surfaces a %s retry with its real live status",
    async (retryStatus) => {
      const { companyId, issueId, retryRunId } = await seedIssueWithRetry({ retryStatus });

      const res = await request(createApp(boardActor(companyId, "local_implicit"))).get(`/api/issues/${issueId}`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.scheduledRetry).toMatchObject({
        runId: retryRunId,
        status: retryStatus,
        scheduledRetryReason: "transient_failure",
      });
    },
  );

  it("includes a blocker's live retry in relation summaries", async () => {
    const { companyId, issueId: blockerId, retryRunId } = await seedIssueWithRetry({ retryStatus: "running" });
    const blockedId = randomUUID();
    await db.insert(issues).values({
      id: blockedId,
      companyId,
      title: "Waiting for recovery",
      status: "blocked",
      priority: "medium",
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedId,
      type: "blocks",
    });

    const res = await request(createApp(boardActor(companyId, "local_implicit"))).get(`/api/issues/${blockedId}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.blockedBy).toHaveLength(1);
    expect(res.body.blockedBy[0]).toMatchObject({
      id: blockerId,
      scheduledRetry: {
        runId: retryRunId,
        status: "running",
        scheduledRetryReason: "transient_failure",
      },
    });
  });

  it("promotes the existing scheduled retry and treats duplicate clicks as idempotent", async () => {
    const { companyId, issueId, retryRunId } = await seedIssueWithRetry();
    const app = createApp(boardActor(companyId));

    const first = await request(app).post(`/api/issues/${issueId}/scheduled-retry/retry-now`).send({});

    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({
      outcome: "promoted",
      scheduledRetry: {
        runId: retryRunId,
        status: "queued",
      },
    });

    const second = await request(app).post(`/api/issues/${issueId}/scheduled-retry/retry-now`).send({});

    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body).toMatchObject({
      outcome: "already_promoted",
      scheduledRetry: {
        runId: retryRunId,
        status: "queued",
      },
    });

    const retryRuns = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.retryOfRunId, first.body.scheduledRetry.retryOfRunId), eq(heartbeatRuns.companyId, companyId)));
    expect(retryRuns).toHaveLength(1);
    expect(retryRuns[0]).toMatchObject({ id: retryRunId, status: "queued" });
  });

  it("reports cleanup waits with the saved schedule and promotes the same retry after release", async () => {
    const f = await seedIssueWithRetry();
    await db.update(heartbeatRuns)
      .set({ resultJson: { conversationContinuation: "continue_conversation_v1" } })
      .where(inArray(heartbeatRuns.id, [f.sourceRunId, f.retryRunId]));
    const [lease] = await db.insert(environmentLeases).values({
      companyId: f.companyId, issueId: f.issueId, heartbeatRunId: f.sourceRunId,
      status: "pending_cleanup", cleanupStatus: "failed",
    }).returning();
    const app = createApp(boardActor(f.companyId));
    for (let click = 0; click < 2; click++) {
      const before = Date.now();
      const res = await request(app).post(`/api/issues/${f.issueId}/scheduled-retry/retry-now`).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ outcome: "waiting", scheduledRetry: {
        runId: f.retryRunId, status: "scheduled_retry", scheduledRetryAttempt: 2,
      } });
      expect(res.body.message).toContain("Waiting for execution cleanup");
      const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.retryRunId));
      expect(res.body.scheduledRetry.scheduledRetryAt).toBe(saved!.scheduledRetryAt!.toISOString());
      expect(saved!.scheduledRetryAt!.getTime()).toBeGreaterThanOrEqual(before + 30_000);
    }
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.sourceRunId))).toHaveLength(1);
    await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date() })
      .where(eq(environmentLeases.id, lease!.id));
    const resumed = await request(app).post(`/api/issues/${f.issueId}/scheduled-retry/retry-now`).send({});
    expect(resumed.body).toMatchObject({ outcome: "promoted", scheduledRetry: {
      runId: f.retryRunId, status: "queued", scheduledRetryAttempt: 2,
    } });
  });

  it("returns a clear no-op response when there is no scheduled retry", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "NONE",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "No retry",
      status: "todo",
      priority: "medium",
      issueNumber: 1,
      identifier: "NONE-1",
    });

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      outcome: "no_scheduled_retry",
      scheduledRetry: null,
    });
  });

  it("reports already-promoted retries without creating another run", async () => {
    const { companyId, issueId, retryRunId } = await seedIssueWithRetry({ retryStatus: "queued" });

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      outcome: "already_promoted",
      scheduledRetry: {
        runId: retryRunId,
        status: "queued",
      },
    });
  });

  it("uses normal promotion gates and records gate-suppressed retries", async () => {
    const { companyId, issueId, retryRunId } = await seedIssueWithRetry({ agentStatus: "paused" });

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      outcome: "gate_suppressed",
      scheduledRetry: {
        runId: retryRunId,
        status: "cancelled",
        errorCode: "agent_not_invokable",
      },
    });

    const [run] = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, retryRunId));
    expect(run).toEqual({ status: "cancelled", errorCode: "agent_not_invokable" });

    const [activity] = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId, runId: activityLog.runId })
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(activity).toEqual({
      action: "issue.scheduled_retry_retry_now",
      entityId: issueId,
      runId: retryRunId,
    });
  });

  it("requires board access for retry-now", async () => {
    const { companyId, agentId, issueId } = await seedIssueWithRetry();

    const res = await request(createApp(agentActor(companyId, agentId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status).toBe(403);
  });

  it("enforces company scoping for retry-now with a uniform 404", async () => {
    const { issueId } = await seedIssueWithRetry();

    const res = await request(createApp(boardActor(randomUUID())))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status).toBe(404);
  });

  /**
   * Fork (spec 7.5, 7.7): the task's assignee A finished waiting; agent B's run
   * took the task's wait over (the open episode's current run, the older run),
   * while agent C's reply run joined that wait for another resource and was
   * re-armed later (newer, due sooner). The banner and "Check now" both act on
   * B's wait.
   */
  async function seedSharedWait() {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = new Date();
    const minutes = (n: number) => new Date(now.getTime() + n * 60_000);
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix, requireBoardApprovalForNewAgents: false });
    const agentRow = async (name: string) => (await db.insert(agents).values({
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    }).returning())[0]!;
    const assignee = await agentRow("Assignee");
    const builder = await agentRow("Builder");
    const replier = await agentRow("Replier");
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Shared wait",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: assignee.id,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    // Builder waits for a Claude account: it is in pool mode without one.
    await db.insert(aiAccountAgentBindings).values({ agentId: builder.id, companyId, mode: "pool_account", accountId: null });
    const episodeId = randomUUID();
    const laneRun = async (input: { agent: { id: string }; lane: string; context: ReturnType<typeof buildResourceWaitContext>; updatedAt: Date; scheduledRetryAt: Date }) => {
      const [source] = await db.insert(heartbeatRuns).values({
        companyId,
        agentId: input.agent.id,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "cancelled",
        errorCode: input.lane === "ai_account_wait" ? "ai_account_unavailable" : "environment_unavailable",
        contextSnapshot: { issueId },
        createdAt: minutes(-90),
        updatedAt: minutes(-90),
      }).returning();
      const [run] = await db.insert(heartbeatRuns).values({
        companyId,
        agentId: input.agent.id,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "scheduled_retry",
        retryOfRunId: source!.id,
        scheduledRetryAt: input.scheduledRetryAt,
        scheduledRetryAttempt: 1,
        scheduledRetryReason: input.lane,
        contextSnapshot: { issueId, resourceWait: input.context },
        createdAt: input.updatedAt,
        updatedAt: input.updatedAt,
      }).returning();
      return run!;
    };
    const builderWait = buildResourceWaitContext({
      episodeId,
      kind: "ai_account",
      reason: "unassigned",
      scope: "account",
      environmentId: null,
      environmentName: null,
      deviceId: null,
      deviceName: null,
      accountId: null,
      accountLabel: null,
      resumeAt: null,
      resumeAtSource: null,
      message: null,
    });
    const builderRun = await laneRun({ agent: builder, lane: "ai_account_wait", context: builderWait, updatedAt: minutes(-30), scheduledRetryAt: minutes(60) });
    const replierRun = await laneRun({
      agent: replier,
      lane: "environment_wait",
      context: buildResourceWaitContext({
        ...builderWait,
        kind: "environment",
        reason: "busy",
        scope: "admission",
        environmentId: randomUUID(),
        environmentName: "Busy box",
      }),
      updatedAt: minutes(-1),
      scheduledRetryAt: minutes(10),
    });
    const since = minutes(-60);
    const notifiedAt = minutes(-59);
    await db.insert(resourceWaitEpisodes).values({
      id: episodeId,
      companyId,
      agentId: builder.id,
      issueId,
      kind: "ai_account",
      reason: "unassigned",
      scope: "account",
      resourceKey: "account:none",
      since,
      notifiedAt,
      currentRunId: builderRun.id,
    });
    return { companyId, issueId, builder, replier, builderRun, replierRun, episodeId, since, notifiedAt, builderWait };
  }

  it("surfaces the task's own wait with its episode's start, even when a later run waits too", async () => {
    const { companyId, issueId, builder, builderRun, since, notifiedAt, builderWait } = await seedSharedWait();

    const res = await request(createApp(boardActor(companyId, "local_implicit"))).get(`/api/issues/${issueId}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.scheduledRetry).toMatchObject({
      runId: builderRun.id,
      status: "scheduled_retry",
      agentId: builder.id,
      agentName: "Builder",
      scheduledRetryReason: "ai_account_wait",
      resourceWait: { ...builderWait, since: since.toISOString(), notifiedAt: notifiedAt.toISOString() },
    });
    // The raw run context never leaves the server.
    expect(res.body.scheduledRetry).not.toHaveProperty("resourceWaitContext");
    expect(res.body.scheduledRetry).not.toHaveProperty("contextSnapshot");
  });

  it("ranks a task's waiting runs without reading the company's other tasks once per run", async () => {
    const { companyId, issueId, builderRun } = await seedSharedWait();
    await db.execute(sql`
      insert into issues (company_id, title, status, priority)
      select ${companyId}, 'Other task ' || n, 'todo', 'medium' from generate_series(1, 300) n
    `);
    await db.execute(sql`analyze issues`);
    const capture = captureQueries(db);
    let current: Awaited<ReturnType<ReturnType<typeof issueService>["getCurrentScheduledRetry"]>>;
    try {
      current = await issueService(db).getCurrentScheduledRetry(issueId);
    } finally {
      capture.restore();
    }
    expect(current).toMatchObject({ runId: builderRun.id });
    const ranked = capture.queries.find((entry) => entry.query.includes('"execution_run_id"') && entry.query.includes('from "heartbeat_runs"'));
    expect(ranked).toBeDefined();
    // Index paths only, as on a large table: the task's own row is read by its key, not found among 300.
    const plan = await explainAnalyze(db, ranked!, ["enable_seqscan = off"]);
    expect(scansOf(plan, "issues").length).toBeGreaterThan(0);
    expect(rowsExamined(plan, "issues")).toBeLessThan(20);
  });

  it("leaves since and notifiedAt empty for a wait joined for another resource", async () => {
    const { companyId, issueId, replierRun } = await seedSharedWait();
    // Only the replier waits now: the builder's wait ended.
    await db.delete(resourceWaitEpisodes).where(eq(resourceWaitEpisodes.issueId, issueId));
    await db.update(heartbeatRuns).set({ status: "succeeded", scheduledRetryReason: null }).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "scheduled_retry"), eq(heartbeatRuns.scheduledRetryReason, "ai_account_wait")));

    const res = await request(createApp(boardActor(companyId, "local_implicit"))).get(`/api/issues/${issueId}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.scheduledRetry).toMatchObject({
      runId: replierRun.id,
      scheduledRetryReason: "environment_wait",
      resourceWait: { kind: "environment", reason: "busy", since: null, notifiedAt: null },
    });
  });

  it("checks the same wait the banner shows, answers 409 while it lasts and 429 within a minute", async () => {
    const { companyId, issueId, builderRun, replierRun, episodeId } = await seedSharedWait();
    const app = createApp(boardActor(companyId));

    const res = await request(app).post(`/api/issues/${issueId}/scheduled-retry/retry-now`).send({});

    // The replier's admission wait would have been promoted at once; the builder's account wait holds.
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toMatchObject({
      code: "resource_still_unavailable",
      details: {
        code: "resource_still_unavailable",
        resourceWait: { episodeId, kind: "ai_account", reason: "unassigned" },
      },
    });
    expect(Date.parse(res.body.details.checkedAt)).not.toBeNaN();
    const statuses = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "scheduled_retry")));
    expect(statuses.map((row) => row.id).sort()).toEqual([builderRun.id, replierRun.id].sort());

    const again = await request(app).post(`/api/issues/${issueId}/scheduled-retry/retry-now`).send({});
    expect(again.status).toBe(429);
    expect(again.body).toMatchObject({ code: "check_now_rate_limited", details: { retryAfterMs: 60_000 } });
  });

  /**
   * Fork (spec 7.6, 18 "Comment"): the assignee's own wait for a Claude
   * account (it is in pool mode without one) as the run path leaves it: the
   * waiting run holds the task's lock and owns the open episode.
   */
  async function seedAssigneeWait() {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = new Date();
    const minutes = (n: number) => new Date(now.getTime() + n * 60_000);
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix, requireBoardApprovalForNewAgents: false });
    const [builder] = await db.insert(agents).values({
      companyId,
      name: "Builder",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    }).returning();
    await db.insert(aiAccountAgentBindings).values({ agentId: builder!.id, companyId, mode: "pool_account", accountId: null });
    const [deferral] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId: builder!.id,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "cancelled",
      errorCode: "ai_account_unavailable",
      contextSnapshot: { issueId },
      finishedAt: minutes(-10),
      createdAt: minutes(-10),
      updatedAt: minutes(-10),
    }).returning();
    const episodeId = randomUUID();
    const [waiting] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId: builder!.id,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      retryOfRunId: deferral!.id,
      scheduledRetryAt: minutes(60),
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "ai_account_wait",
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
        resourceWait: buildResourceWaitContext({
          episodeId,
          kind: "ai_account",
          reason: "unassigned",
          scope: "account",
          environmentId: null,
          environmentName: null,
          deviceId: null,
          deviceName: null,
          accountId: null,
          accountLabel: null,
          resumeAt: null,
          resumeAtSource: null,
          message: null,
        }),
      },
      createdAt: minutes(-10),
      updatedAt: minutes(-10),
    }).returning();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Waiting for a Claude account",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: builder!.id,
      executionRunId: waiting!.id,
      executionAgentNameKey: "builder",
      executionLockedAt: minutes(-10),
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    await db.insert(resourceWaitEpisodes).values({
      id: episodeId,
      companyId,
      agentId: builder!.id,
      issueId,
      kind: "ai_account",
      reason: "unassigned",
      scope: "account",
      resourceKey: "account:none",
      since: minutes(-10),
      notifiedAt: minutes(-10),
      currentRunId: waiting!.id,
    });
    return { companyId, issueId, builder: builder!, waiting: waiting!, episodeId };
  }

  it("keeps a waiting task, its waiting run and its episode on a board comment, and leaves Check now its own minute", async () => {
    const { companyId, issueId, builder, waiting, episodeId } = await seedAssigneeWait();
    // Fork: back the session actor's admin claim with its membership row, as auth derives it in
    // production; since upstream #10633 a comment first checks issue:read against that row.
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: "board-user",
      membershipRole: "admin", status: "active",
    });
    const app = createApp(boardActor(companyId));

    const posted = await request(app).post(`/api/issues/${issueId}/comments`).send({ body: "Is the account sorted out?" });
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);

    // The comment's wake joins the waiting run, and the comment's own check takes its slot in the background.
    await vi.waitFor(async () => {
      const joined = await db.select({ runId: agentWakeupRequests.runId }).from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.agentId, builder.id), eq(agentWakeupRequests.status, "coalesced")));
      expect(joined).toEqual([{ runId: waiting.id }]);
      const slots = await db.select().from(resourceWaitNotices)
        .where(and(eq(resourceWaitNotices.companyId, companyId), like(resourceWaitNotices.noticeKey, `check-now:%issue:${issueId}`)));
      expect(slots).toHaveLength(1);
    }, { timeout: 15_000, interval: 100 });

    const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(task).toMatchObject({ status: "in_progress", executionRunId: waiting.id });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, waiting.id));
    expect(run).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: "ai_account_wait" });
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["queued", "running"])))).toEqual([]);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toEqual([]);
    const [episode] = await db.select().from(resourceWaitEpisodes).where(eq(resourceWaitEpisodes.id, episodeId));
    expect(episode).toMatchObject({ currentRunId: waiting.id, resolvedAt: null });

    // The comment's check never spends the minute of "Check now".
    const checked = await request(app).post(`/api/issues/${issueId}/scheduled-retry/retry-now`).send({});
    expect(checked.status, JSON.stringify(checked.body)).toBe(409);
    expect(checked.body).toMatchObject({ code: "resource_still_unavailable", details: { resourceWait: { episodeId, reason: "unassigned" } } });
  });

});
