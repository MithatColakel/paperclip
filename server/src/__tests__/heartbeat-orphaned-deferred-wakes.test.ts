import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentTaskRun = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentTaskRun: mockTrackAgentTaskRun,
  };
});

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres orphaned deferred wake tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("orphaned deferred wake promotion", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-orphaned-deferred-wakes-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    // Promoted runs execute and write attribution rows; each case owns the
    // whole disposable database.
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // The previous holder was stopped by a reassignment while the new
  // assignee's wake was deferred behind it. The stop is acknowledged, so its
  // release drained nothing, and the issue is left with no lock and no run.
  async function seedReassignedIssueWithDeferredWake(opts: {
    deferredAgeMs?: number;
    newAssigneeStatus?: "idle" | "paused";
    withReassignmentComment?: boolean;
  } = {}) {
    const companyId = randomUUID();
    const previousAgentId = randomUUID();
    const newAssigneeId = randomUUID();
    const issueId = randomUUID();
    const stoppedRunId = randomUUID();
    const deferredWakeId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const deferredAt = new Date(Date.now() - (opts.deferredAgeMs ?? 10 * 60 * 1000));

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values([
      {
        id: previousAgentId,
        companyId,
        name: "Project Manager",
        role: "pm",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: newAssigneeId,
        companyId,
        name: "QA",
        role: "qa",
        status: opts.newAssigneeStatus ?? "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: stoppedRunId,
      companyId,
      agentId: previousAgentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "cancelled",
      errorCode: "issue_reassigned",
      error: "Cancelled because the issue was reassigned",
      runtimeMode: "legacy",
      resultJson: { executionCancellation: { state: "acknowledged" } },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_execution_promoted" },
      createdAt: new Date(deferredAt.getTime() - 60_000),
      startedAt: new Date(deferredAt.getTime() - 60_000),
      finishedAt: deferredAt,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Hand-off to QA",
      status: "todo",
      priority: "medium",
      assigneeAgentId: newAssigneeId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    // The reassignment usually carries a hand-off comment written by the
    // stopped run, and the wake records the run it interrupted.
    const commentId = randomUUID();
    if (opts.withReassignmentComment) {
      await db.insert(issueComments).values({
        id: commentId,
        companyId,
        issueId,
        authorAgentId: previousAgentId,
        createdByRunId: stoppedRunId,
        body: "Reassigning to QA for the code-level check.",
        createdAt: deferredAt,
      });
    }
    const commentFields = opts.withReassignmentComment
      ? { commentId, interruptedRunId: stoppedRunId, mutation: "update" }
      : {};
    const contextCommentFields = opts.withReassignmentComment
      ? {
          commentId,
          wakeCommentId: commentId,
          wakeCommentIds: [commentId],
          interruptedRunId: stoppedRunId,
          source: "issue.update",
          wakeSource: "assignment",
          wakeTriggerDetail: "system",
        }
      : {};
    await db.insert(agentWakeupRequests).values({
      id: deferredWakeId,
      companyId,
      agentId: newAssigneeId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      status: "deferred_issue_execution",
      requestedByActorType: "agent",
      requestedByActorId: previousAgentId,
      payload: {
        issueId,
        ...commentFields,
        _paperclipWakeContext: { issueId, taskId: issueId, wakeReason: "issue_assigned", ...contextCommentFields },
        executionWait: {
          reason: "execution_recovery",
          message: "Waiting for execution recovery. Your message is saved.",
          recoveryActionId: null,
        },
      },
      requestedAt: deferredAt,
      createdAt: deferredAt,
      updatedAt: deferredAt,
    });
    return { companyId, previousAgentId, newAssigneeId, issueId, stoppedRunId, deferredWakeId };
  }

  async function readWake(id: string) {
    return db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)).then((rows) => rows[0] ?? null);
  }

  async function runsFor(agentId: string, issueId: string) {
    const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    return rows.filter((row) => row.contextSnapshot?.issueId === issueId);
  }

  it("promotes a new assignee's wake that an acknowledged reassignment stop left deferred", async () => {
    const { newAssigneeId, issueId, deferredWakeId } = await seedReassignedIssueWithDeferredWake();

    await heartbeat.resumeQueuedRuns();

    expect((await readWake(deferredWakeId))?.status).not.toBe("deferred_issue_execution");
    const promoted = await runsFor(newAssigneeId, issueId);
    expect(promoted).toHaveLength(1);
    expect(promoted[0]?.wakeupRequestId).toBe(deferredWakeId);
  });

  it("promotes a reassignment wake that carries the stopped run's hand-off comment", async () => {
    const { newAssigneeId, issueId, deferredWakeId } =
      await seedReassignedIssueWithDeferredWake({ withReassignmentComment: true });
    // The stranded comment sweep rewrites updatedAt on every tick; the grace
    // period must not depend on it.
    await db.update(agentWakeupRequests).set({ updatedAt: new Date() }).where(eq(agentWakeupRequests.id, deferredWakeId));

    await heartbeat.resumeQueuedRuns();

    expect((await readWake(deferredWakeId))?.status).not.toBe("deferred_issue_execution");
    expect(await runsFor(newAssigneeId, issueId)).toHaveLength(1);
  });

  it("leaves the queue to a live run on the issue", async () => {
    const { companyId, previousAgentId, newAssigneeId, issueId, deferredWakeId } =
      await seedReassignedIssueWithDeferredWake();
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: previousAgentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      runtimeMode: "legacy",
      scheduledRetryAt: new Date(Date.now() + 60 * 60 * 1000),
      contextSnapshot: { issueId, taskId: issueId },
    });

    await heartbeat.resumeQueuedRuns();

    expect((await readWake(deferredWakeId))?.status).toBe("deferred_issue_execution");
    expect(await runsFor(newAssigneeId, issueId)).toHaveLength(0);
  });

  it("gives normal release paths a grace period and leaves old wakes alone", async () => {
    const recent = await seedReassignedIssueWithDeferredWake({ deferredAgeMs: 30_000 });
    await heartbeat.resumeQueuedRuns();
    expect((await readWake(recent.deferredWakeId))?.status).toBe("deferred_issue_execution");

    const stale = await seedReassignedIssueWithDeferredWake({ deferredAgeMs: 4 * 24 * 60 * 60 * 1000 });
    await heartbeat.resumeQueuedRuns();
    expect((await readWake(stale.deferredWakeId))?.status).toBe("deferred_issue_execution");
    expect(await runsFor(stale.newAssigneeId, stale.issueId)).toHaveLength(0);
  });

  it("keeps a paused assignee's wake saved instead of failing it", async () => {
    const { newAssigneeId, issueId, deferredWakeId } =
      await seedReassignedIssueWithDeferredWake({ newAssigneeStatus: "paused" });

    await heartbeat.resumeQueuedRuns();

    expect((await readWake(deferredWakeId))?.status).toBe("deferred_issue_execution");
    expect(await runsFor(newAssigneeId, issueId)).toHaveLength(0);
  });

  it("does not revive work on a terminal issue", async () => {
    const { issueId, newAssigneeId, deferredWakeId } = await seedReassignedIssueWithDeferredWake();
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, issueId));

    await heartbeat.resumeQueuedRuns();

    const wake = await readWake(deferredWakeId);
    expect(wake?.status).toBe("deferred_issue_execution");
    expect(
      await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, newAssigneeId))),
    ).toHaveLength(0);
  });
});
