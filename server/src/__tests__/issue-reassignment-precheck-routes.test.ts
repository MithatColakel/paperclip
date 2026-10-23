import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentSessionGoalActions,
  agentTaskSessions,
  agents,
  authUsers,
  caseHandoffs,
  cases,
  chatConversations,
  chatEndpoints,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  executionWorkspaces,
  issueComments,
  issueRelations,
  issues,
  labels,
  projectWorkspaces,
  projects,
  toolActionRequests,
  toolApplications,
  toolConnections,
  toolInvocations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { issueService } from "../services/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import {
  registerLiveRunnerGoalController,
  runnerGoalControlBrokerInternals,
} from "../services/runner-goal-control-broker.js";

const CONVERSATION_IDENTITY_ERROR =
  "Conversation identity is fixed; finish the reply instead of completing or reassigning the conversation";
const CONVERSATION_PARENT_ERROR =
  "Conversations cannot have new subtasks; create a task in a project instead";
const BOARD_USER_ID = "board-user";
// Background wakes stay off: no test here should start another run.
const NO_WAKE_RUNTIME_CONFIG = { heartbeat: { wakeOnDemand: false } };
// A runner agent whose session goal supports pause.
const RUNNER_AGENT = {
  adapterType: "paperclip_runner",
  adapterConfig: { provider: "codex" },
} as const;

const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)(
  "issue reassignment precheck",
  () => {
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
    let db: ReturnType<typeof createDb>;

    beforeAll(async () => {
      database = await startEmbeddedPostgresTestDatabase(
        "paperclip-issue-reassignment-precheck-",
      );
      db = createDb(database.connectionString);
      await db.insert(authUsers).values({
        id: BOARD_USER_ID,
        name: "Board",
        email: "board@paperclip.test",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await instanceSettingsService(db).updateExperimental({
        enableAgentChat: true,
      });
    }, 90_000);

    afterEach(() => {
      runnerGoalControlBrokerInternals.resetForTests();
    });

    afterAll(async () => {
      await db?.$client.end({ timeout: 0 });
      await database?.cleanup();
    });

    async function seedCompany(
      agentOverrides: Partial<typeof agents.$inferInsert> = {},
    ) {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const otherAgentId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: "Precheck",
        // Long enough that the many companies seeded here never share a prefix.
        issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 10).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values([
        {
          id: agentId,
          companyId,
          name: "Assignee",
          role: "engineer",
          status: "running",
          adapterType: "process",
          runtimeConfig: NO_WAKE_RUNTIME_CONFIG,
          ...agentOverrides,
        },
        {
          id: otherAgentId,
          companyId,
          name: "Other",
          role: "engineer",
          status: "idle",
          adapterType: "process",
          runtimeConfig: NO_WAKE_RUNTIME_CONFIG,
        },
      ]);
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: BOARD_USER_ID,
        membershipRole: "owner",
        status: "active",
      });
      return { companyId, agentId, otherAgentId };
    }

    function boardApp(
      companyId: string,
      source: "local_implicit" | "mcp_oauth" = "local_implicit",
    ) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor = {
          type: "board",
          userId: BOARD_USER_ID,
          companyIds: [companyId],
          memberships: [
            { companyId, membershipRole: "owner", status: "active" },
          ],
          isInstanceAdmin: true,
          source,
        };
        next();
      });
      app.use("/api", issueRoutes(db, {} as never));
      app.use(errorHandler);
      return app;
    }

    function agentApp(companyId: string, agentId: string, runId: string) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor = {
          type: "agent",
          agentId,
          companyId,
          runId,
          source: "agent_jwt",
        };
        next();
      });
      app.use("/api", issueRoutes(db, {} as never));
      app.use(errorHandler);
      return app;
    }

    /** A running run that owns the issue, as the route resolves it. */
    async function startRun(companyId: string, agentId: string, issueId: string) {
      const [run] = await db
        .insert(heartbeatRuns)
        .values({
          companyId,
          agentId,
          status: "running",
          startedAt: new Date(),
          contextSnapshot: { issueId, taskKey: issueId },
        })
        .returning();
      await db
        .update(issues)
        .set({ executionRunId: run!.id, checkoutRunId: run!.id })
        .where(eq(issues.id, issueId));
      return run!;
    }

    /**
     * An active session goal on the run, and a live runner that pauses it when
     * asked. The route then stops the goal and goes on to cancel the run.
     * `beforePause` runs inside the runner, while the route waits for it.
     */
    async function startRunnerGoal(
      binding: { companyId: string; agentId: string; issueId: string; runId: string },
      beforePause?: () => Promise<void>,
    ) {
      await db
        .update(heartbeatRuns)
        .set({ nativeIssueId: binding.issueId })
        .where(eq(heartbeatRuns.id, binding.runId));
      const [session] = await db
        .insert(agentTaskSessions)
        .values({
          companyId: binding.companyId,
          agentId: binding.agentId,
          adapterType: RUNNER_AGENT.adapterType,
          taskKey: binding.issueId,
          goalJson: { objective: "Answer the question", status: "active", workingNow: true },
          goalRevision: 1,
        })
        .returning();
      registerLiveRunnerGoalController(binding, {
        control: async ({ requestId, action }) => {
          await beforePause?.();
          const [current] = await db
            .select()
            .from(agentTaskSessions)
            .where(eq(agentTaskSessions.id, session!.id));
          await db
            .update(agentTaskSessions)
            .set({
              goalJson: {
                ...(current!.goalJson as Record<string, unknown>),
                status: action === "pause" ? "paused" : "active",
                workingNow: false,
              },
            })
            .where(eq(agentTaskSessions.id, session!.id));
          await db
            .update(agentSessionGoalActions)
            .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
            .where(
              and(
                eq(agentSessionGoalActions.sessionId, session!.id),
                eq(agentSessionGoalActions.requestId, requestId),
              ),
            );
        },
      });
      return session!;
    }

    async function expectGoalUntouched(sessionId: string) {
      const [session] = await db
        .select()
        .from(agentTaskSessions)
        .where(eq(agentTaskSessions.id, sessionId));
      expect(session!.goalRevision).toBe(1);
      expect(session!.goalDesiredState).toBeNull();
      expect((session!.goalJson as Record<string, unknown>).status).toBe("active");
      expect(
        await db
          .select()
          .from(agentSessionGoalActions)
          .where(eq(agentSessionGoalActions.sessionId, sessionId)),
      ).toEqual([]);
    }

    async function createConversation(companyId: string, agentId: string) {
      return issueService(db).create(companyId, {
        title: "Conversation",
        conversationAgentId: agentId,
        conversationUserId: BOARD_USER_ID,
        assigneeAgentId: agentId,
        createdByUserId: BOARD_USER_ID,
        status: "in_review",
        conversationState: "waiting",
      });
    }

    async function createTask(
      companyId: string,
      agentId: string,
      overrides: Partial<Parameters<ReturnType<typeof issueService>["create"]>[1]> = {},
    ) {
      return issueService(db).create(companyId, {
        title: "Ordinary task",
        assigneeAgentId: agentId,
        status: "in_progress",
        ...overrides,
      });
    }

    async function readRun(runId: string) {
      const [run] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));
      return run!;
    }

    async function readIssue(issueId: string) {
      const [issue] = await db
        .select()
        .from(issues)
        .where(eq(issues.id, issueId));
      return issue!;
    }

    function expectRunStillRunning(run: typeof heartbeatRuns.$inferSelect) {
      expect({ status: run.status, errorCode: run.errorCode, finishedAt: run.finishedAt })
        .toEqual({ status: "running", errorCode: null, finishedAt: null });
    }

    /** A parked retry of the issue's run, which a human comment supersedes. */
    async function scheduleRetry(companyId: string, agentId: string, issueId: string) {
      const [retry] = await db
        .insert(heartbeatRuns)
        .values({
          companyId,
          agentId,
          status: "scheduled_retry",
          scheduledRetryAt: new Date(Date.now() + 60 * 60 * 1000),
          scheduledRetryAttempt: 1,
          scheduledRetryReason: "transient_failure",
          contextSnapshot: { issueId, taskKey: issueId },
        })
        .returning();
      return retry!;
    }

    async function expectRetryStillScheduled(retryId: string) {
      const retry = await readRun(retryId);
      expect({ status: retry.status, finishedAt: retry.finishedAt }).toEqual({
        status: "scheduled_retry",
        finishedAt: null,
      });
    }

    it("rejects reassigning a conversation before cancelling its run", async () => {
      const { companyId, agentId, otherAgentId } = await seedCompany();
      const conversation = await createConversation(companyId, agentId);
      const run = await startRun(companyId, agentId, conversation.id);
      const app = boardApp(companyId);

      for (const patch of [
        { assigneeAgentId: otherAgentId },
        { assigneeAgentId: null, assigneeUserId: BOARD_USER_ID },
      ]) {
        const res = await request(app)
          .patch(`/api/issues/${conversation.id}`)
          .send(patch);
        expect(res.status, JSON.stringify(res.body)).toBe(422);
        expect(res.body.error).toBe(CONVERSATION_IDENTITY_ERROR);
        expectRunStillRunning(await readRun(run.id));
      }

      const after = await readIssue(conversation.id);
      expect(after.assigneeAgentId).toBe(agentId);
      expect(after.assigneeUserId).toBeNull();
      expect(after.executionRunId).toBe(run.id);
    });

    it("rejects the conversation agent reassigning its own conversation without cancelling its own run", async () => {
      const { companyId, agentId, otherAgentId } = await seedCompany();
      const conversation = await createConversation(companyId, agentId);
      const run = await startRun(companyId, agentId, conversation.id);
      const app = agentApp(companyId, agentId, run.id);

      // A retry must meet the same rejection with its run still alive.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const res = await request(app)
          .patch(`/api/issues/${conversation.id}`)
          .send({ assigneeAgentId: otherAgentId });
        expect(res.status, JSON.stringify(res.body)).toBe(422);
        expect(res.body.error).toBe(CONVERSATION_IDENTITY_ERROR);
        expectRunStillRunning(await readRun(run.id));
      }
      expect((await readIssue(conversation.id)).assigneeAgentId).toBe(agentId);
    });

    it("rejects the conversation agent handing its conversation back to the user without stopping its goal or run", async () => {
      // The run hands its own task to a human, so the route keeps the run but
      // stops its runner goal first. A refused handoff must leave both alone.
      const { companyId, agentId } = await seedCompany(RUNNER_AGENT);
      const conversation = await createConversation(companyId, agentId);
      const run = await startRun(companyId, agentId, conversation.id);
      const session = await startRunnerGoal({
        companyId,
        agentId,
        issueId: conversation.id,
        runId: run.id,
      });
      const app = agentApp(companyId, agentId, run.id);

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const res = await request(app)
          .patch(`/api/issues/${conversation.id}`)
          .send({ assigneeAgentId: null, assigneeUserId: BOARD_USER_ID });
        expect(res.status, JSON.stringify(res.body)).toBe(422);
        expect(res.body.error).toBe(CONVERSATION_IDENTITY_ERROR);
        expectRunStillRunning(await readRun(run.id));
      }
      await expectGoalUntouched(session.id);
      const after = await readIssue(conversation.id);
      expect(after.assigneeAgentId).toBe(agentId);
      expect(after.assigneeUserId).toBeNull();
    });

    it("rejects completing a conversation before stopping its runner goal or run", async () => {
      const { companyId, agentId } = await seedCompany(RUNNER_AGENT);
      const conversation = await createConversation(companyId, agentId);
      const run = await startRun(companyId, agentId, conversation.id);
      const session = await startRunnerGoal({
        companyId,
        agentId,
        issueId: conversation.id,
        runId: run.id,
      });
      const app = boardApp(companyId);

      for (const status of ["done", "cancelled"]) {
        const res = await request(app)
          .patch(`/api/issues/${conversation.id}`)
          .send({ status });
        expect(res.status, JSON.stringify(res.body)).toBe(422);
        expect(res.body.error).toBe(CONVERSATION_IDENTITY_ERROR);
        expectRunStillRunning(await readRun(run.id));
      }
      await expectGoalUntouched(session.id);
      expect((await readIssue(conversation.id)).status).toBe("in_review");
    });

    it("rejects the conversation agent completing its own conversation before stopping its goal or run", async () => {
      const { companyId, agentId } = await seedCompany(RUNNER_AGENT);
      const conversation = await createConversation(companyId, agentId);
      const run = await startRun(companyId, agentId, conversation.id);
      const session = await startRunnerGoal({
        companyId,
        agentId,
        issueId: conversation.id,
        runId: run.id,
      });
      const app = agentApp(companyId, agentId, run.id);

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const res = await request(app)
          .patch(`/api/issues/${conversation.id}`)
          .send({ status: "done" });
        expect(res.status, JSON.stringify(res.body)).toBe(422);
        expect(res.body.error).toBe(CONVERSATION_IDENTITY_ERROR);
        expectRunStillRunning(await readRun(run.id));
      }
      await expectGoalUntouched(session.id);
      expect((await readIssue(conversation.id)).status).toBe("in_review");
    });

    it("rejects changing the agent of a task bound to an external channel before cancelling its run", async () => {
      const { companyId, agentId, otherAgentId } = await seedCompany();
      const issue = await createTask(companyId, agentId);
      const run = await startRun(companyId, agentId, issue.id);
      // The task is the conversation of an external chat channel.
      const [application] = await db
        .insert(toolApplications)
        .values({ companyId, applicationKey: `chat-${randomUUID()}`, name: "Chat", type: "mcp" })
        .returning();
      const [connection] = await db
        .insert(toolConnections)
        .values({
          companyId,
          applicationId: application!.id,
          name: "Chat",
          uid: `chat-${randomUUID()}`,
          transport: "mcp_remote",
        })
        .returning();
      const [endpoint] = await db
        .insert(chatEndpoints)
        .values({
          companyId,
          connectionId: connection!.id,
          provider: "slack",
          publicId: `chat-${randomUUID()}`,
          assignedAgentId: agentId,
        })
        .returning();
      const [binding] = await db
        .insert(chatConversations)
        .values({
          companyId,
          endpointId: endpoint!.id,
          issueId: issue.id,
          externalConversationId: `channel-${issue.id}`,
          externalLabel: "Channel",
        })
        .returning();

      const res = await request(boardApp(companyId))
        .patch(`/api/issues/${issue.id}`)
        .send({ assigneeAgentId: otherAgentId });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error).toBe(
        "Agent assignment cannot change while this task is bound to an external channel",
      );
      expect(res.body.code).toBe("chat_binding_agent_locked");
      expect(binding).toBeDefined();
      expectRunStillRunning(await readRun(run.id));
      expect((await readIssue(issue.id)).assigneeAgentId).toBe(agentId);
    });

    async function addFormerMember(companyId: string) {
      const formerUserId = `former-${randomUUID()}`;
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: formerUserId,
        membershipRole: "member",
        status: "suspended",
      });
      return formerUserId;
    }

    it("rejects handing a task to a user who is no longer a member before cancelling its run", async () => {
      const { companyId, agentId } = await seedCompany();
      const formerUserId = await addFormerMember(companyId);
      const issue = await createTask(companyId, agentId);
      const run = await startRun(companyId, agentId, issue.id);

      const res = await request(boardApp(companyId))
        .patch(`/api/issues/${issue.id}`)
        .send({ assigneeAgentId: null, assigneeUserId: formerUserId });
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(res.body.error).toBe("Assignee user not found");
      expectRunStillRunning(await readRun(run.id));
      expect((await readIssue(issue.id)).assigneeAgentId).toBe(agentId);
    });

    it("rejects a run handing its own task to a creator who is no longer a member before stopping its goal", async () => {
      // A legacy run that hands its own task to a human keeps running, but the
      // route still stops its runner goal first. A refused handoff must not.
      const { companyId, agentId } = await seedCompany(RUNNER_AGENT);
      const formerUserId = await addFormerMember(companyId);
      const issue = await createTask(companyId, agentId, {
        createdByUserId: formerUserId,
      });
      const run = await startRun(companyId, agentId, issue.id);
      const session = await startRunnerGoal({
        companyId,
        agentId,
        issueId: issue.id,
        runId: run.id,
      });
      const app = agentApp(companyId, agentId, run.id);

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const res = await request(app)
          .patch(`/api/issues/${issue.id}`)
          .send({ assigneeAgentId: null, assigneeUserId: formerUserId });
        expect(res.status, JSON.stringify(res.body)).toBe(404);
        expect(res.body.error).toBe("Assignee user not found");
        expectRunStillRunning(await readRun(run.id));
      }
      await expectGoalUntouched(session.id);
      expect((await readIssue(issue.id)).assigneeAgentId).toBe(agentId);
    });

    it("still stops the goal but keeps the run when a run hands its own task to a human", async () => {
      const { companyId, agentId } = await seedCompany(RUNNER_AGENT);
      const issue = await createTask(companyId, agentId, {
        createdByUserId: BOARD_USER_ID,
      });
      const run = await startRun(companyId, agentId, issue.id);
      const session = await startRunnerGoal({
        companyId,
        agentId,
        issueId: issue.id,
        runId: run.id,
      });

      const res = await request(agentApp(companyId, agentId, run.id))
        .patch(`/api/issues/${issue.id}`)
        .send({ assigneeAgentId: null, assigneeUserId: BOARD_USER_ID });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.assigneeUserId).toBe(BOARD_USER_ID);
      expectRunStillRunning(await readRun(run.id));
      const [sessionAfter] = await db
        .select()
        .from(agentTaskSessions)
        .where(eq(agentTaskSessions.id, session.id));
      expect((sessionAfter!.goalJson as Record<string, unknown>).status).toBe("paused");
    });

    it("leaves the goal alone when an MCP client reassigns a task", async () => {
      // MCP task changes never stop the agent's goal or run; the update decides.
      const { companyId, agentId, otherAgentId } = await seedCompany(RUNNER_AGENT);
      const issue = await createTask(companyId, agentId);
      const [finishedRun] = await db
        .insert(heartbeatRuns)
        .values({
          companyId,
          agentId,
          status: "succeeded",
          startedAt: new Date(),
          finishedAt: new Date(),
          contextSnapshot: { issueId: issue.id, taskKey: issue.id },
        })
        .returning();
      const session = await startRunnerGoal({
        companyId,
        agentId,
        issueId: issue.id,
        runId: finishedRun!.id,
      });

      const res = await request(boardApp(companyId, "mcp_oauth"))
        .patch(`/api/issues/${issue.id}`)
        .send({ assigneeAgentId: otherAgentId });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.assigneeAgentId).toBe(otherAgentId);
      await expectGoalUntouched(session.id);
    });

    it("rejects an agent completing a task its run handed off before stopping its goal or run", async () => {
      const { companyId, agentId, otherAgentId } = await seedCompany(RUNNER_AGENT);
      const issue = await createTask(companyId, agentId);
      const run = await startRun(companyId, agentId, issue.id);
      const session = await startRunnerGoal({
        companyId,
        agentId,
        issueId: issue.id,
        runId: run.id,
      });
      const caseId = randomUUID();
      await db.insert(cases).values({
        id: caseId,
        companyId,
        caseNumber: 1,
        identifier: `CASE-${caseId}`,
        caseType: "work",
        title: "Build",
        workIssueId: issue.id,
        handoffVersion: 1,
        phase: "implementation",
      });
      await db.insert(caseHandoffs).values({
        companyId,
        caseId,
        issueId: issue.id,
        version: 1,
        fromAgentId: agentId,
        toAgentId: otherAgentId,
        phase: "review",
        instructions: "Review the change",
        actorType: "agent",
        actorId: agentId,
        sourceRunId: run.id,
        wakeupRequestId: randomUUID(),
        idempotencyKey: "handoff",
        inputFingerprint: "fixture",
        state: "awaiting_release",
      });

      const res = await request(agentApp(companyId, agentId, run.id))
        .patch(`/api/issues/${issue.id}`)
        .send({ status: "done" });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.details).toMatchObject({ code: "case_handoff_run_yielded" });
      expectRunStillRunning(await readRun(run.id));
      await expectGoalUntouched(session.id);
      expect((await readIssue(issue.id)).status).toBe("in_progress");
    });

    it("refuses an expectedStatusVersion patch that is not a status-only promotion, as the update does", async () => {
      const { companyId, agentId } = await seedCompany();
      const issue = await createTask(companyId, agentId, { status: "backlog" });
      const svc = issueService(db);
      const stored = await svc.getById(issue.id);
      const refusal = {
        status: 422,
        message: "expectedStatusVersion requires a status-only backlog-to-todo promotion",
      };
      for (const patch of [
        { status: "todo", title: "Renamed", expectedStatusVersion: stored!.statusVersion },
        { status: "in_progress", expectedStatusVersion: stored!.statusVersion },
      ]) {
        await expect(svc.precheckUpdate(stored!, patch)).rejects.toMatchObject(refusal);
        await expect(svc.update(issue.id, patch)).rejects.toMatchObject(refusal);
      }
      await expect(svc.precheckUpdate(stored!, {
        status: "todo",
        expectedStatusVersion: stored!.statusVersion,
        actorAgentId: null,
        actorRunId: null,
        actorUserId: BOARD_USER_ID,
      })).resolves.toBeUndefined();
      expect((await readIssue(issue.id)).status).toBe("backlog");
    });

    it("refuses a stale execution policy snapshot and a missing project, as the update does", async () => {
      const { companyId, agentId } = await seedCompany();
      const issue = await createTask(companyId, agentId);
      const svc = issueService(db);
      const stored = await svc.getById(issue.id);

      const stalePolicy = {
        executionPolicy: null,
        expectedExecutionPolicy: { mode: "normal", commentRequired: true, stages: [] },
      } as Parameters<typeof svc.update>[1];
      const policyRefusal = { status: 409, details: { code: "execution_policy_changed" } };
      await expect(svc.precheckUpdate(stored!, stalePolicy)).rejects.toMatchObject(policyRefusal);
      await expect(svc.update(issue.id, stalePolicy)).rejects.toMatchObject(policyRefusal);

      // The missing project comes before the second assignee, as in the update.
      const missingProject = { projectId: randomUUID(), assigneeUserId: BOARD_USER_ID };
      const projectRefusal = { status: 404, message: "Project not found" };
      await expect(svc.precheckUpdate(stored!, missingProject)).rejects.toMatchObject(projectRefusal);
      await expect(svc.update(issue.id, missingProject)).rejects.toMatchObject(projectRefusal);
      const after = await readIssue(issue.id);
      expect(after.assigneeUserId).toBeNull();
      expect(after.projectId).toBeNull();
    });

    it("rejects starting a reassigned task that has unresolved blockers before cancelling its run", async () => {
      const { companyId, agentId, otherAgentId } = await seedCompany();
      const issue = await createTask(companyId, agentId);
      const blocker = await issueService(db).create(companyId, {
        title: "Blocker",
        status: "todo",
      });
      await db.insert(issueRelations).values({
        companyId,
        issueId: blocker.id,
        relatedIssueId: issue.id,
        type: "blocks",
      });
      const run = await startRun(companyId, agentId, issue.id);

      const res = await request(boardApp(companyId))
        .patch(`/api/issues/${issue.id}`)
        .send({ assigneeAgentId: otherAgentId, status: "in_progress" });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error).toBe("Issue is blocked by unresolved blockers");
      expectRunStillRunning(await readRun(run.id));
      expect((await readIssue(issue.id)).assigneeAgentId).toBe(agentId);
    });

    it("rejects an agent completing its task during a connection review before stopping its goal or run", async () => {
      const { companyId, agentId } = await seedCompany(RUNNER_AGENT);
      const issue = await createTask(companyId, agentId);
      const run = await startRun(companyId, agentId, issue.id);
      const session = await startRunnerGoal({
        companyId,
        agentId,
        issueId: issue.id,
        runId: run.id,
      });
      const [invocation] = await db
        .insert(toolInvocations)
        .values({ companyId, agentId, issueId: issue.id, toolName: "sheets:update_cell" })
        .returning();
      const [review] = await db
        .insert(toolActionRequests)
        .values({
          companyId,
          invocationId: invocation!.id,
          issueId: issue.id,
          status: "pending",
          canonicalArgumentsHash: "args-hash",
          canonicalArgumentsSummary: { summary: "{}", sha256: "args-hash", sizeBytes: 2 },
        })
        .returning();

      const res = await request(agentApp(companyId, agentId, run.id))
        .patch(`/api/issues/${issue.id}`)
        .send({ status: "done" });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.code).toBe("tool_review_pending");
      expect(review).toBeDefined();
      expectRunStillRunning(await readRun(run.id));
      await expectGoalUntouched(session.id);
      expect((await readIssue(issue.id)).status).toBe("in_progress");
    });

    it("rejects a second assignee before cancelling the current assignee's run", async () => {
      const { companyId, agentId } = await seedCompany();
      const issue = await createTask(companyId, agentId);
      const run = await startRun(companyId, agentId, issue.id);

      const res = await request(boardApp(companyId))
        .patch(`/api/issues/${issue.id}`)
        .send({ assigneeUserId: BOARD_USER_ID });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error).toBe("Issue can only have one assignee");
      expectRunStillRunning(await readRun(run.id));
      expect((await readIssue(issue.id)).assigneeAgentId).toBe(agentId);
    });

    it("rejects a second assignee before a board comment interrupts the run", async () => {
      const { companyId, agentId } = await seedCompany();
      const issue = await createTask(companyId, agentId);
      const run = await startRun(companyId, agentId, issue.id);

      const res = await request(boardApp(companyId))
        .patch(`/api/issues/${issue.id}`)
        .send({ comment: "Stop and hand this to me", interrupt: true, assigneeUserId: BOARD_USER_ID });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error).toBe("Issue can only have one assignee");
      expectRunStillRunning(await readRun(run.id));
      expect(
        await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id)),
      ).toEqual([]);
    });

    it("rejects a board comment's update before its interrupt cancels the run", async () => {
      const { companyId, agentId } = await seedCompany();
      const conversation = await createConversation(companyId, agentId);
      const issue = await createTask(companyId, agentId);
      const run = await startRun(companyId, agentId, issue.id);

      // Only the interrupt stops work here: the assignee and status stay.
      const res = await request(boardApp(companyId))
        .patch(`/api/issues/${issue.id}`)
        .send({ comment: "Stop and look at this", interrupt: true, parentId: conversation.id });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error).toBe(CONVERSATION_PARENT_ERROR);
      expectRunStillRunning(await readRun(run.id));
      expect(
        await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id)),
      ).toEqual([]);
      const after = await readIssue(issue.id);
      expect(after.parentId).toBeNull();
      expect(after.executionRunId).toBe(run.id);
    });

    it("rejects a human comment's update before it cancels the scheduled retry it supersedes", async () => {
      const { companyId, agentId } = await seedCompany();
      const conversation = await createConversation(companyId, agentId);
      const issue = await createTask(companyId, agentId);
      const retry = await scheduleRetry(companyId, agentId, issue.id);

      // The comment would move the task back to todo and cancel the retry;
      // only that cancel stops work here.
      const res = await request(boardApp(companyId))
        .patch(`/api/issues/${issue.id}`)
        .send({ comment: "Try it again with the new settings", parentId: conversation.id });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error).toBe(CONVERSATION_PARENT_ERROR);
      await expectRetryStillScheduled(retry.id);
      const after = await readIssue(issue.id);
      expect(after.status).toBe("in_progress");
      expect(after.parentId).toBeNull();
    });

    it("rejects starting a task whose agent's manager is terminated before a board comment interrupts its run", async () => {
      const { companyId, agentId } = await seedCompany();
      const issue = await createTask(companyId, agentId, { status: "todo" });
      const run = await startRun(companyId, agentId, issue.id);
      // The assignee's manager leaves after the task was assigned.
      const managerId = randomUUID();
      await db.insert(agents).values({
        id: managerId,
        companyId,
        name: "Former manager",
        role: "manager",
        status: "terminated",
        adapterType: "process",
        runtimeConfig: NO_WAKE_RUNTIME_CONFIG,
      });
      await db.update(agents).set({ reportsTo: managerId }).where(eq(agents.id, agentId));

      const res = await request(boardApp(companyId))
        .patch(`/api/issues/${issue.id}`)
        .send({ comment: "Start on this now", interrupt: true, status: "in_progress" });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.code, JSON.stringify(res.body)).toBe("agent_not_assignable");
      expect(res.body.details).toMatchObject({ reason: "ancestor_terminated" });
      expectRunStillRunning(await readRun(run.id));
      expect((await readIssue(issue.id)).status).toBe("todo");
    });

    it("checks the acting agent's run before the connection review, as the update does", async () => {
      const { companyId, agentId } = await seedCompany();
      const issue = await createTask(companyId, agentId);
      const run = await startRun(companyId, agentId, issue.id);
      const [invocation] = await db
        .insert(toolInvocations)
        .values({ companyId, agentId, issueId: issue.id, toolName: "sheets:update_cell" })
        .returning();
      await db.insert(toolActionRequests).values({
        companyId,
        invocationId: invocation!.id,
        issueId: issue.id,
        status: "pending",
        canonicalArgumentsHash: "args-hash",
        canonicalArgumentsSummary: { summary: "{}", sha256: "args-hash", sizeBytes: 2 },
      });
      // An operator stops the run while the agent's request is in flight.
      await db
        .update(heartbeatRuns)
        .set({ status: "cancelled", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, run.id));

      const svc = issueService(db);
      const stored = await svc.getById(issue.id);
      const patch = { status: "done", actorAgentId: agentId, actorRunId: run.id };
      const refusal = { status: 403, details: { code: "agent_run_cancelled" } };
      await expect(svc.precheckUpdate(stored!, patch)).rejects.toMatchObject(refusal);
      await expect(svc.update(issue.id, patch)).rejects.toMatchObject(refusal);
      expect((await readIssue(issue.id)).status).toBe("in_progress");
    });

    it("checks the update again after the runner goal stops, before cancelling the run", async () => {
      const { companyId, agentId, otherAgentId } = await seedCompany(RUNNER_AGENT);
      const issue = await createTask(companyId, agentId);
      const run = await startRun(companyId, agentId, issue.id);
      // Another writer hands the task to the user while the route waits for the
      // runner to pause the goal; the requested agent change is now refused.
      const session = await startRunnerGoal(
        { companyId, agentId, issueId: issue.id, runId: run.id },
        async () => {
          await db
            .update(issues)
            .set({ assigneeAgentId: null, assigneeUserId: BOARD_USER_ID })
            .where(eq(issues.id, issue.id));
        },
      );

      const res = await request(boardApp(companyId))
        .patch(`/api/issues/${issue.id}`)
        .send({ assigneeAgentId: otherAgentId });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error).toBe("Issue can only have one assignee");
      expectRunStillRunning(await readRun(run.id));
      // The goal stays paused: the task is no longer this agent's to resume.
      // The error says so.
      expect(res.body.details).toMatchObject({ runnerGoalStopped: "pause" });
      const [sessionAfter] = await db
        .select()
        .from(agentTaskSessions)
        .where(eq(agentTaskSessions.id, session.id));
      expect((sessionAfter!.goalJson as Record<string, unknown>).status).toBe("paused");
    });

    it("rejects a human comment's review request before it cancels the scheduled retry it supersedes", async () => {
      // The route refuses the review request after the policy transition. The
      // retry cancel waits for that check, so the task keeps its retry.
      const { companyId, agentId } = await seedCompany();
      const issue = await createTask(companyId, agentId);
      const retry = await scheduleRetry(companyId, agentId, issue.id);

      const res = await request(boardApp(companyId))
        .patch(`/api/issues/${issue.id}`)
        .send({
          comment: "Please look at the new settings",
          reviewRequest: { instructions: "Check the settings" },
        });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error).toBe("reviewRequest requires an active review or approval stage");
      await expectRetryStillScheduled(retry.id);
      expect((await readIssue(issue.id)).status).toBe("in_progress");
      expect(
        await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id)),
      ).toEqual([]);
    });

    it("still cancels the scheduled retry an allowed human comment supersedes", async () => {
      const { companyId, agentId } = await seedCompany();
      const issue = await createTask(companyId, agentId);
      const retry = await scheduleRetry(companyId, agentId, issue.id);

      const res = await request(boardApp(companyId))
        .patch(`/api/issues/${issue.id}`)
        .send({ comment: "Try it again with the new settings" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.status).toBe("todo");
      expect((await readRun(retry.id)).status).toBe("cancelled");
    });

    it("keeps the goal stopped and the run running when the check after the goal stop refuses a run's handoff to a human", async () => {
      const { companyId, agentId } = await seedCompany(RUNNER_AGENT);
      const issue = await createTask(companyId, agentId, {
        createdByUserId: BOARD_USER_ID,
      });
      const run = await startRun(companyId, agentId, issue.id);
      // The creator leaves the company while the route waits for the runner
      // to pause the goal, so the handoff is refused on the fresh read.
      const session = await startRunnerGoal(
        { companyId, agentId, issueId: issue.id, runId: run.id },
        async () => {
          await db
            .update(companyMemberships)
            .set({ status: "suspended" })
            .where(
              and(
                eq(companyMemberships.companyId, companyId),
                eq(companyMemberships.principalId, BOARD_USER_ID),
              ),
            );
        },
      );

      const res = await request(agentApp(companyId, agentId, run.id))
        .patch(`/api/issues/${issue.id}`)
        .send({ assigneeAgentId: null, assigneeUserId: BOARD_USER_ID });
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(res.body.error).toBe("Assignee user not found");
      expect(res.body.details).toMatchObject({ runnerGoalStopped: "pause" });
      expectRunStillRunning(await readRun(run.id));
      const [sessionAfter] = await db
        .select()
        .from(agentTaskSessions)
        .where(eq(agentTaskSessions.id, session.id));
      expect((sessionAfter!.goalJson as Record<string, unknown>).status).toBe("paused");
      const after = await readIssue(issue.id);
      expect({ assigneeAgentId: after.assigneeAgentId, assigneeUserId: after.assigneeUserId })
        .toEqual({ assigneeAgentId: agentId, assigneeUserId: null });
    });

    it("rejects a reassignment that blocks the task on itself before cancelling its run", async () => {
      const { companyId, agentId, otherAgentId } = await seedCompany();
      const issue = await createTask(companyId, agentId);
      const run = await startRun(companyId, agentId, issue.id);

      const res = await request(boardApp(companyId))
        .patch(`/api/issues/${issue.id}`)
        .send({ assigneeAgentId: otherAgentId, blockedByIssueIds: [issue.id] });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error).toBe("Issue cannot be blocked by itself");
      expectRunStillRunning(await readRun(run.id));
      expect((await readIssue(issue.id)).assigneeAgentId).toBe(agentId);
    });

    it("rejects completing a task with another company's label before stopping its goal or run", async () => {
      const { companyId, agentId } = await seedCompany(RUNNER_AGENT);
      const other = await seedCompany();
      const [foreignLabel] = await db
        .insert(labels)
        .values({ companyId: other.companyId, name: "Foreign", color: "#000000" })
        .returning();
      const issue = await createTask(companyId, agentId);
      const run = await startRun(companyId, agentId, issue.id);
      const session = await startRunnerGoal({
        companyId,
        agentId,
        issueId: issue.id,
        runId: run.id,
      });

      const res = await request(boardApp(companyId))
        .patch(`/api/issues/${issue.id}`)
        .send({ status: "done", labelIds: [foreignLabel!.id] });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error).toBe("One or more labels are invalid for this company");
      expectRunStillRunning(await readRun(run.id));
      await expectGoalUntouched(session.id);
      expect((await readIssue(issue.id)).status).toBe("in_progress");
    });

    it("refuses invalid blockers and labels, as the update does", async () => {
      const { companyId, agentId } = await seedCompany();
      const other = await seedCompany();
      const issue = await createTask(companyId, agentId);
      const blocked = await createTask(companyId, agentId, { title: "Blocked by the task" });
      // The task already blocks the other one; the reverse closes a cycle.
      await db.insert(issueRelations).values({
        companyId,
        issueId: issue.id,
        relatedIssueId: blocked.id,
        type: "blocks",
      });
      const foreignIssue = await createTask(other.companyId, other.agentId);
      const svc = issueService(db);
      const stored = await svc.getById(issue.id);

      for (const [patch, message] of [
        [{ blockedByIssueIds: [issue.id] }, "Issue cannot be blocked by itself"],
        [{ blockedByIssueIds: [foreignIssue.id] }, "Blocked-by issues must belong to the same company"],
        [{ blockedByIssueIds: [blocked.id] }, "Blocking relations cannot contain cycles"],
        [{ labelIds: [randomUUID()] }, "One or more labels are invalid for this company"],
      ] as const) {
        const refusal = { status: 422, message };
        await expect(svc.precheckUpdate(stored!, { ...patch })).rejects.toMatchObject(refusal);
        await expect(svc.update(issue.id, { ...patch })).rejects.toMatchObject(refusal);
      }
      await expect(svc.precheckUpdate(stored!, { blockedByIssueIds: [], labelIds: [] }))
        .resolves.toBeUndefined();
    });

    it("refuses unknown workspaces and a source change that leaves bound files behind, as the update does", async () => {
      const { companyId, agentId } = await seedCompany();
      const [project] = await db
        .insert(projects)
        .values({ companyId, name: "Workspace project" })
        .returning();
      const [source, otherSource] = await db
        .insert(projectWorkspaces)
        .values([
          { companyId, projectId: project!.id, name: "Source" },
          { companyId, projectId: project!.id, name: "Other source" },
        ])
        .returning();
      const [bound] = await db
        .insert(executionWorkspaces)
        .values({
          companyId,
          projectId: project!.id,
          projectWorkspaceId: source!.id,
          mode: "isolated_workspace",
          strategyType: "git_worktree",
          name: "Bound files",
        })
        .returning();
      const issue = await createTask(companyId, agentId, { projectId: project!.id });
      const svc = issueService(db);

      const unknownWorkspace = { projectWorkspaceId: randomUUID() };
      const unknownRefusal = { status: 404, message: "Project workspace not found" };
      const stored = await svc.getById(issue.id);
      await expect(svc.precheckUpdate(stored!, unknownWorkspace)).rejects.toMatchObject(unknownRefusal);
      await expect(svc.update(issue.id, unknownWorkspace)).rejects.toMatchObject(unknownRefusal);

      await db
        .update(issues)
        .set({ projectWorkspaceId: source!.id, executionWorkspaceId: bound!.id })
        .where(eq(issues.id, issue.id));
      const boundStored = await svc.getById(issue.id);
      const sourceChange = { projectWorkspaceId: otherSource!.id };
      const boundRefusal = {
        status: 409,
        message: "Task already has bound files; schedule a workspace selection or explicitly clear its binding when changing the source",
      };
      await expect(svc.precheckUpdate(boundStored!, sourceChange)).rejects.toMatchObject(boundRefusal);
      await expect(svc.update(issue.id, sourceChange)).rejects.toMatchObject(boundRefusal);
      expect((await readIssue(issue.id)).projectWorkspaceId).toBe(source!.id);
    });

    it("refuses making a task public under private access, as the update does", async () => {
      const { companyId, agentId } = await seedCompany();
      const svc = issueService(db);
      const [privateProject] = await db
        .insert(projects)
        .values({ companyId, name: "Private project", visibility: "private" })
        .returning();
      const privateParent = await createTask(companyId, agentId, { title: "Private parent" });
      await db
        .update(issues)
        .set({ visibility: "private", privacyRootIssueId: privateParent.id })
        .where(eq(issues.id, privateParent.id));
      const issue = await createTask(companyId, agentId);
      const stored = await svc.getById(issue.id);

      for (const [patch, message] of [
        [
          { visibility: "open", projectId: privateProject!.id },
          "Move this task out of its private project before making it public",
        ],
        [
          { visibility: "open", parentId: privateParent.id },
          "A task cannot be made public while it inherits private access",
        ],
      ] as const) {
        const refusal = { status: 422, message };
        await expect(svc.precheckUpdate(stored!, { ...patch })).rejects.toMatchObject(refusal);
        await expect(svc.update(issue.id, { ...patch })).rejects.toMatchObject(refusal);
      }
      const after = await readIssue(issue.id);
      expect({ projectId: after.projectId, parentId: after.parentId }).toEqual({
        projectId: null,
        parentId: null,
      });
    });

    it("refuses a guarded promotion that the policy transition would not keep status-only, as the update does", async () => {
      const { companyId, agentId, otherAgentId } = await seedCompany();
      const stageId = randomUUID();
      const issue = await createTask(companyId, agentId, { status: "backlog" });
      // A pending review whose recorded participant is not in the stage: the
      // transition hands the task to the stage's reviewer and moves it to
      // in_review, which a guarded promotion may not do.
      await db
        .update(issues)
        .set({
          executionPolicy: {
            mode: "normal",
            commentRequired: false,
            stages: [
              {
                id: stageId,
                type: "review",
                approvalsNeeded: 1,
                participants: [{ type: "agent", agentId: otherAgentId }],
              },
            ],
          },
          executionState: {
            status: "pending",
            currentStageId: stageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId },
            returnAssignee: null,
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        })
        .where(eq(issues.id, issue.id));
      const svc = issueService(db);
      const stored = await svc.getById(issue.id);
      const promotion = {
        status: "todo",
        expectedStatusVersion: stored!.statusVersion,
        actorAgentId: null,
        actorRunId: null,
        actorUserId: BOARD_USER_ID,
      };
      const refusal = {
        status: 422,
        message: "expectedStatusVersion requires a status-only backlog-to-todo promotion",
      };
      await expect(svc.precheckUpdate(stored!, promotion)).rejects.toMatchObject(refusal);
      await expect(svc.update(issue.id, promotion)).rejects.toMatchObject(refusal);
      expect((await readIssue(issue.id)).status).toBe("backlog");
    });

    it("still cancels the current run before an allowed reassignment", async () => {
      const { companyId, agentId } = await seedCompany();
      const issue = await createTask(companyId, agentId);
      const run = await startRun(companyId, agentId, issue.id);

      const res = await request(boardApp(companyId))
        .patch(`/api/issues/${issue.id}`)
        .send({ assigneeAgentId: null, assigneeUserId: BOARD_USER_ID });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.assigneeAgentId).toBeNull();
      expect(res.body.assigneeUserId).toBe(BOARD_USER_ID);

      const stopped = await readRun(run.id);
      expect(stopped.status).toBe("cancelled");
      expect(stopped.errorCode).toBe("issue_reassigned");
      expect(stopped.resultJson).toMatchObject({ reassignmentStopConfirmed: true });
      const after = await readIssue(issue.id);
      expect(after.assigneeUserId).toBe(BOARD_USER_ID);
      expect(after.executionRunId).toBeNull();
    });

    it("still stops the runner goal and cancels the run before an allowed completion", async () => {
      const { companyId, agentId } = await seedCompany(RUNNER_AGENT);
      const issue = await createTask(companyId, agentId);
      const run = await startRun(companyId, agentId, issue.id);
      const session = await startRunnerGoal({
        companyId,
        agentId,
        issueId: issue.id,
        runId: run.id,
      });

      const res = await request(boardApp(companyId))
        .patch(`/api/issues/${issue.id}`)
        .send({ status: "done" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.status).toBe("done");

      const stopped = await readRun(run.id);
      expect(stopped.status).toBe("cancelled");
      expect(stopped.errorCode).toBe("issue_terminalized");
      expect(stopped.resultJson).toMatchObject({ terminalizationStopConfirmed: true });
      const [sessionAfter] = await db
        .select()
        .from(agentTaskSessions)
        .where(eq(agentTaskSessions.id, session.id));
      expect((sessionAfter!.goalJson as Record<string, unknown>).status).toBe("paused");
    });
  },
);
