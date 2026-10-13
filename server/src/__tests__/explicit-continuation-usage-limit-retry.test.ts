import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PROVIDER_QUOTA_MONITOR_SERVICE_NAME } from "@paperclipai/shared";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { adapterExecutionControls, createAdapterExecutionControl } from "../services/adapter-execution-control.js";
import { aiConnectionPoolService } from "../services/ai-connection-pool.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { buildExecutionContinuation } from "../services/execution-continuation.js";
import { heartbeatService } from "../services/heartbeat.js";

const mockAdapterExecute = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })) };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres explicit continuation usage-limit tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// A turn the user continued on a held task, failed on the Claude usage limit.
// The fork's quota-recovery and company-pool failover lanes must renew the
// user's authorization the same way upstream's transient retry does.
describeEmbeddedPostgres("explicit continuation through usage-limit retry lanes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home = "";
  const userId = "board-user";
  const failedAt = new Date("2026-10-10T08:10:00.000Z");
  const firstCheckAt = new Date("2026-10-10T13:00:00.000Z");
  const firstTickAt = new Date("2026-10-10T13:01:00.000Z");

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "paperclip-explicit-usage-limit-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "explicit-usage-limit-fixture");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-explicit-usage-limit-");
    db = createDb(tempDb.connectionString);
    await db.insert(authUsers).values({ id: userId, name: "Board User", email: "board-user@example.test",
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  async function armQuotaMonitor(issueId: string, sourceRunId: string, nextCheckAt: Date) {
    const monitor = {
      nextCheckAt: nextCheckAt.toISOString(),
      notes: "Wait for the AI provider usage limit to reset",
      scheduledBy: "assignee",
      serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME,
      externalRef: sourceRunId,
      recoveryPolicy: "wake_owner",
    };
    await db.update(issues).set({
      executionPolicy: { mode: "normal", commentRequired: true, stages: [], monitor },
      executionState: {
        status: "idle", currentStageId: null, currentStageIndex: null, currentStageType: null,
        currentParticipant: null, returnAssignee: null, completedStageIds: [], lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: {
          status: "scheduled", nextCheckAt: monitor.nextCheckAt, lastTriggeredAt: null, attemptCount: 0,
          notes: monitor.notes, scheduledBy: "assignee", serviceName: monitor.serviceName,
          externalRef: sourceRunId, timeoutAt: null, maxAttempts: null, recoveryPolicy: "wake_owner",
          clearedAt: null, clearReason: null,
        },
      },
      monitorNextCheckAt: nextCheckAt,
      monitorAttemptCount: 0,
      monitorNotes: monitor.notes,
      monitorScheduledBy: "assignee",
      // The quota wait released the failed run's task claim.
      executionRunId: null,
    }).where(eq(issues.id, issueId));
  }

  async function seedUserContinuedQuotaFailure(input: {
    claim: "released" | "parent";
    pool?: boolean;
    quotaMonitor?: boolean;
    errorFamily?: string;
    /** Seed the turn queued, before it runs, instead of already failed. */
    queued?: boolean;
  }) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const sourceRunId = randomUUID(), runId = randomUUID(), commentId = randomUUID();
    const issuePrefix = `U${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Usage limit", issuePrefix,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user",
      status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Builder", role: "engineer", status: "active",
      adapterType: "claude_local", runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Ship the release", status: "in_progress",
      priority: "medium", assigneeAgentId: agentId, issueNumber: 1, identifier: `${issuePrefix}-1` });
    // The run that stopped and left the task held for reconciliation.
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId, runtimeMode: "legacy",
      status: "failed", createdAt: new Date("2026-10-10T07:00:00.000Z"),
      finishedAt: new Date("2026-10-10T07:05:00.000Z"), contextSnapshot: { issueId } });
    const [comment] = await db.insert(issueComments).values({ id: commentId, companyId, issueId,
      authorType: "user", authorUserId: userId, body: "Continue the release.",
      createdAt: new Date("2026-10-10T08:00:00.000Z") }).returning();
    const [receipt] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: sourceRunId,
      status: "resolved", outcome: "cancelled", nextAction: "The user continued the task.",
      evidence: { runId: sourceRunId, explicitUserContinuation: {
        runId, previousRunId: sourceRunId, commentId, actorId: userId, recordedAt: comment!.createdAt.toISOString(),
        commentUpdatedAt: comment!.updatedAt.toISOString(),
        commentBodyHash: createHash("sha256").update(comment!.body).digest("hex"),
      } } }).returning();
    let accounts: Array<{ connectionId: string; grantId: string }> = [];
    if (input.pool) {
      const service = aiConnectionService(db);
      const subscription = (name: string, token: string) => service.save(companyId, userId, {
        provider: "anthropic", method: "subscription", ownership: "shared", name, loginSessionId: "fixture",
        allAgents: true, agentIds: [] }, token);
      accounts = [await subscription("Max one", "token-one"), await subscription("Max two", "token-two")];
      await aiConnectionPoolService(db).replace(companyId, userId, { provider: "anthropic", members: accounts });
    }
    // The user-continued turn, failed on the usage limit.
    const wakeupRequestId = randomUUID();
    if (input.queued) await db.insert(agentWakeupRequests).values({ id: wakeupRequestId, companyId, agentId,
      source: "on_demand", triggerDetail: "manual", reason: "issue_commented", payload: { issueId, commentId },
      status: "queued", runId, requestedByActorType: "user", requestedByActorId: userId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, runtimeMode: "legacy",
      invocationSource: "on_demand", createdAt: new Date(failedAt.getTime() - 5 * 60_000),
      ...(input.queued ? { status: "queued", wakeupRequestId } : {
        status: "failed", error: "You've hit your session limit", errorCode: "provider_quota",
        startedAt: new Date(failedAt.getTime() - 5 * 60_000), finishedAt: failedAt,
        resultJson: { conversationContinuation: "continue_conversation_v1", errorFamily: input.errorFamily ?? "provider_quota",
          executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      }),
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented", wakeCommentId: commentId,
        previousRunId: sourceRunId, forceFreshSession: true,
        explicitUserContinuation: { previousRunId: sourceRunId, commentId },
        ...(input.pool ? { aiConnection: { connectionId: accounts[0]!.connectionId, provider: "anthropic",
          mode: "company_pool", poolPriority: 0 } } : {}) } });
    if (input.quotaMonitor) await armQuotaMonitor(issueId, runId, firstCheckAt);
    await db.update(issues).set({ executionRunId: input.claim === "parent" ? runId : null })
      .where(eq(issues.id, issueId));
    return { companyId, agentId, issueId, sourceRunId, runId, commentId, receipt: receipt! };
  }
  type Fixture = Awaited<ReturnType<typeof seedUserContinuedQuotaFailure>>;

  const successorsOf = (runId: string) =>
    db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
  const renewedReceipts = (issueId: string) => db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.sourceIssueId, issueId), eq(issueRecoveryActions.cause, "explicit_user_continuation_retry")));
  const taskClaim = async (issueId: string) =>
    (await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.executionRunId;
  // Dispatch revalidates the successor's own receipt before the adapter starts.
  const dispatch = (f: Fixture, run: typeof heartbeatRuns.$inferSelect) => buildExecutionContinuation({
    db, companyId: f.companyId, issueId: f.issueId, agentId: f.agentId, runId: run.id,
    context: run.contextSnapshot!, summary: null, exposeLowTrustRaw: false,
  });

  async function expectRenewedSuccessor(f: Fixture, parentId: string, retryReason: string) {
    const [successor, ...others] = await successorsOf(parentId);
    expect(others).toHaveLength(0);
    expect(successor).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: retryReason,
      contextSnapshot: { previousRunId: parentId, retryReason } });
    expect(successor!.contextSnapshot?.explicitUserContinuation).toEqual({ previousRunId: parentId, commentId: f.commentId });
    expect(await taskClaim(f.issueId)).toBe(successor!.id);
    const receipt = (await renewedReceipts(f.issueId)).find(row =>
      (row.evidence.explicitUserContinuation as Record<string, unknown>).runId === successor!.id);
    expect(receipt?.evidence.explicitUserContinuation).toMatchObject({ previousRunId: parentId, commentId: f.commentId,
      actorId: userId, automaticRetry: { sourceRunId: parentId } });
    // The original admission receipt stays intact.
    const [original] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.receipt.id));
    expect(original!.evidence).toEqual(f.receipt.evidence);
    await expect(dispatch(f, successor!)).resolves.toMatchObject({ interruptedRunId: parentId });
    return successor!;
  }

  it("renews the user's authorization when the provider-quota monitor replaces the turn, across repeated waits", async () => {
    const f = await seedUserContinuedQuotaFailure({ claim: "released", quotaMonitor: true });
    const heartbeat = heartbeatService(db);

    expect(await heartbeat.tickTimers(firstTickAt)).toMatchObject({ enqueued: 1 });
    const first = await expectRenewedSuccessor(f, f.runId, "provider_quota_recovery");
    expect(first.contextSnapshot).toMatchObject({ providerQuotaWaitStartedAt: new Date(failedAt.getTime() - 5 * 60_000).toISOString() });

    // The replacement still hits the limit (late reset); the next wait resumes
    // from that replacement and renews the authorization once more.
    const secondFailedAt = new Date("2026-10-10T13:05:00.000Z");
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "provider_quota", startedAt: firstTickAt,
      finishedAt: secondFailedAt, resultJson: { conversationContinuation: "continue_conversation_v1",
        errorFamily: "provider_quota", executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } })
      .where(eq(heartbeatRuns.id, first.id));
    await armQuotaMonitor(f.issueId, first.id, new Date("2026-10-10T14:00:00.000Z"));
    expect(await heartbeat.tickTimers(new Date("2026-10-10T14:01:00.000Z"))).toMatchObject({ enqueued: 1 });
    const second = await expectRenewedSuccessor(f, first.id, "provider_quota_recovery");
    expect(second.scheduledRetryAttempt).toBe(2);
    expect(await renewedReceipts(f.issueId)).toHaveLength(2);
  });

  it.each(["parent", "released"] as const)(
    "fails a user-continued turn over to the next company-pool account (task claim %s)", async claim => {
      const f = await seedUserContinuedQuotaFailure({ claim, pool: true });
      expect(await heartbeatService(db).scheduleAiConnectionPoolFailover(f.runId)).toBe(true);
      const successor = await expectRenewedSuccessor(f, f.runId, "ai_connection_failover");
      expect(successor.contextSnapshot).toMatchObject({ aiConnectionFailovers: 1 });
    },
  );

  it("does not fail over while the finished executor still owns its adapter controller", async () => {
    const f = await seedUserContinuedQuotaFailure({ claim: "released", pool: true });
    const heartbeat = heartbeatService(db);
    const control = createAdapterExecutionControl();
    adapterExecutionControls.set(f.runId, control);
    try {
      expect(await heartbeat.scheduleAiConnectionPoolFailover(f.runId)).toBe(false);
      expect(await successorsOf(f.runId)).toHaveLength(0);
      expect(await renewedReceipts(f.issueId)).toHaveLength(0);
      // The lent claim is taken back when admission refuses.
      expect(await taskClaim(f.issueId)).toBeNull();
    } finally {
      adapterExecutionControls.delete(f.runId);
      control.finish();
    }
    // This is why finalization defers the failover until after cleanup.
    expect(await heartbeat.scheduleAiConnectionPoolFailover(f.runId)).toBe(true);
    await expectRenewedSuccessor(f, f.runId, "ai_connection_failover");
  });

  it("fails over through the real executor once its controller and lease are released", async () => {
    const f = await seedUserContinuedQuotaFailure({ claim: "parent", pool: true, queued: true });
    mockAdapterExecute.mockImplementationOnce(async (input?: unknown) => {
      const invocation = input as { onCancellationReady: () => Promise<void>; onDispatch: () => void };
      // Like the ACP lane: the executor owns a joinable controller until cleanup.
      await invocation.onCancellationReady();
      invocation.onDispatch();
      expect(adapterExecutionControls.has(f.runId)).toBe(true);
      return { exitCode: 1, signal: null, timedOut: false, errorMessage: "You've hit your session limit",
        errorCode: "provider_quota", resultJson: { errorFamily: "provider_quota" },
        summary: null, provider: "test", model: "test-model" };
    });
    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    expect(adapterExecutionControls.has(f.runId)).toBe(false);
    expect(await heartbeat.getRun(f.runId)).toMatchObject({ status: "failed" });
    const successor = await expectRenewedSuccessor(f, f.runId, "ai_connection_failover");
    expect(successor.contextSnapshot).toMatchObject({ aiConnectionFailovers: 1 });
    // Finalization deferred the hand-off, so the account is marked only once.
    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId),
      eq(activityLog.action, "ai_connection.pool_limit_reached")))).toHaveLength(1);
  });

  it.each(["edited", "deleted", "reassigned", "new_input", "claimed_by_other"] as const)(
    "still refuses both lanes when the user's authorization is gone: %s", async kind => {
      const f = await seedUserContinuedQuotaFailure({ claim: "released", pool: true, quotaMonitor: true });
      let expectedClaim: string | null = null;
      if (kind === "edited") await db.update(issueComments).set({ body: "Actually, stop the release." })
        .where(eq(issueComments.id, f.commentId));
      if (kind === "deleted") await db.update(issueComments).set({ deletedAt: new Date() })
        .where(eq(issueComments.id, f.commentId));
      if (kind === "reassigned") {
        const [other] = await db.insert(agents).values({ companyId: f.companyId, name: "Reviewer", role: "engineer",
          adapterType: "claude_local", runtimeConfig: { heartbeat: { enabled: false } } }).returning();
        await db.update(issues).set({ assigneeAgentId: other!.id }).where(eq(issues.id, f.issueId));
      }
      // Newer input started another turn on the task.
      if (kind === "new_input") await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
        runtimeMode: "legacy", status: "succeeded", createdAt: new Date(failedAt.getTime() + 60_000),
        finishedAt: new Date(failedAt.getTime() + 120_000), contextSnapshot: { issueId: f.issueId } });
      // Another live run owns the task; the lane must never take its claim.
      if (kind === "claimed_by_other") {
        const [owner] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
          runtimeMode: "legacy", status: "running", createdAt: new Date("2026-10-10T06:00:00.000Z"),
          startedAt: new Date("2026-10-10T06:00:00.000Z"), contextSnapshot: { issueId: f.issueId } }).returning();
        await db.update(issues).set({ executionRunId: owner!.id }).where(eq(issues.id, f.issueId));
        expectedClaim = owner!.id;
      }
      const heartbeat = heartbeatService(db);

      expect(await heartbeat.scheduleAiConnectionPoolFailover(f.runId)).toBe(false);
      expect(await taskClaim(f.issueId)).toBe(expectedClaim);
      expect(await heartbeat.scheduleBoundedRetry(f.runId, { now: firstTickAt,
        retryReason: "provider_quota_recovery", wakeReason: "provider_quota_recovery", delayMs: 0, maxAttempts: 40 }))
        .toMatchObject({ outcome: "not_scheduled" });
      expect(await taskClaim(f.issueId)).toBe(expectedClaim);
      await heartbeat.tickTimers(firstTickAt);

      expect(await successorsOf(f.runId)).toHaveLength(0);
      expect(await renewedReceipts(f.issueId)).toHaveLength(0);
      if (kind === "edited" || kind === "deleted") {
        // The quota monitor hands the task to the board instead of looping.
        expect(await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, f.issueId),
          eq(issueRecoveryActions.cause, "provider_quota_exhausted")))).toMatchObject([{ ownerType: "board", status: "active" }]);
      }
    },
  );

  it("keeps upstream's exact-owner rule for the transient lane", async () => {
    const f = await seedUserContinuedQuotaFailure({ claim: "released", errorFamily: "transient_upstream" });
    expect(await heartbeatService(db).scheduleBoundedRetry(f.runId, { now: firstTickAt, delayMs: 0 }))
      .toMatchObject({ outcome: "not_scheduled", errorCode: "continuation_user_authorization_missing" });
    expect(await successorsOf(f.runId)).toHaveLength(0);
    expect(await taskClaim(f.issueId)).toBeNull();
  });
});
