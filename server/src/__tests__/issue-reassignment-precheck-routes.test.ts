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
  chatConversations,
  chatEndpoints,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
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
        issuePrefix: `P${companyId.slice(0, 4).toUpperCase()}`,
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

    function boardApp(companyId: string) {
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
          source: "local_implicit",
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

    it("rejects the conversation agent handing its conversation back to the user without cancelling its own run", async () => {
      const { companyId, agentId } = await seedCompany();
      const conversation = await createConversation(companyId, agentId);
      const run = await startRun(companyId, agentId, conversation.id);
      const app = agentApp(companyId, agentId, run.id);

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const res = await request(app)
          .patch(`/api/issues/${conversation.id}`)
          .send({ assigneeAgentId: null, assigneeUserId: BOARD_USER_ID });
        expect(res.status, JSON.stringify(res.body)).toBe(422);
        expect(res.body.error).toBe(CONVERSATION_IDENTITY_ERROR);
        expectRunStillRunning(await readRun(run.id));
      }
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

    it("rejects an agent handing a task to a creator who is no longer a member without cancelling its own run", async () => {
      const { companyId, agentId } = await seedCompany();
      const formerUserId = `former-${randomUUID()}`;
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: formerUserId,
        membershipRole: "member",
        status: "suspended",
      });
      const issue = await createTask(companyId, agentId, {
        createdByUserId: formerUserId,
      });
      const run = await startRun(companyId, agentId, issue.id);

      const res = await request(agentApp(companyId, agentId, run.id))
        .patch(`/api/issues/${issue.id}`)
        .send({ assigneeAgentId: null, assigneeUserId: formerUserId });
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(res.body.error).toBe("Assignee user not found");
      expectRunStillRunning(await readRun(run.id));
      expect((await readIssue(issue.id)).assigneeAgentId).toBe(agentId);
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

    it("checks the update again after the runner goal stops, before cancelling the run", async () => {
      const { companyId, agentId, otherAgentId } = await seedCompany(RUNNER_AGENT);
      const issue = await createTask(companyId, agentId);
      const run = await startRun(companyId, agentId, issue.id);
      // Another writer hands the task to the user while the route waits for the
      // runner to pause the goal; the requested agent change is now refused.
      await startRunnerGoal(
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
