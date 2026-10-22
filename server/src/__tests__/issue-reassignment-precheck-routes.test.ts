import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentSessionGoalActions,
  agentTaskSessions,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { issueService } from "../services/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const CONVERSATION_IDENTITY_ERROR =
  "Conversation identity is fixed; finish the reply instead of completing or reassigning the conversation";
const BOARD_USER_ID = "board-user";
// Background wakes stay off: no test here should start another run.
const NO_WAKE_RUNTIME_CONFIG = { heartbeat: { wakeOnDemand: false } };

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

    async function createConversation(companyId: string, agentId: string) {
      return issueService(db).create(companyId, {
        title: "Conversation",
        conversationAgentId: agentId,
        conversationUserId: BOARD_USER_ID,
        assigneeAgentId: agentId,
        status: "in_review",
        conversationState: "waiting",
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
      expect(run.status).toBe("running");
      expect(run.errorCode).toBeNull();
      expect(run.finishedAt).toBeNull();
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

    it("rejects completing a conversation before stopping its runner goal or run", async () => {
      // A runner agent whose session goal can be paused, so the route would
      // stop the goal and then cancel the run before terminalizing the issue.
      const { companyId, agentId } = await seedCompany({
        adapterType: "paperclip_runner",
        adapterConfig: { provider: "codex" },
      });
      const conversation = await createConversation(companyId, agentId);
      const run = await startRun(companyId, agentId, conversation.id);
      const [session] = await db
        .insert(agentTaskSessions)
        .values({
          companyId,
          agentId,
          adapterType: "paperclip_runner",
          taskKey: conversation.id,
          goalJson: { objective: "Answer the question", status: "active", workingNow: true },
          goalRevision: 1,
        })
        .returning();
      const app = boardApp(companyId);

      for (const status of ["done", "cancelled"]) {
        const res = await request(app)
          .patch(`/api/issues/${conversation.id}`)
          .send({ status });
        expect(res.status, JSON.stringify(res.body)).toBe(422);
        expect(res.body.error).toBe(CONVERSATION_IDENTITY_ERROR);
      }

      expectRunStillRunning(await readRun(run.id));
      const [sessionAfter] = await db
        .select()
        .from(agentTaskSessions)
        .where(eq(agentTaskSessions.id, session!.id));
      expect(sessionAfter!.goalRevision).toBe(1);
      expect(sessionAfter!.goalDesiredState).toBeNull();
      expect(
        await db
          .select()
          .from(agentSessionGoalActions)
          .where(eq(agentSessionGoalActions.sessionId, session!.id)),
      ).toEqual([]);
      expect((await readIssue(conversation.id)).status).toBe("in_review");
    });

    it("rejects a second assignee before cancelling the current assignee's run", async () => {
      const { companyId, agentId } = await seedCompany();
      const issue = await issueService(db).create(companyId, {
        title: "Ordinary task",
        assigneeAgentId: agentId,
        status: "in_progress",
      });
      const run = await startRun(companyId, agentId, issue.id);

      const res = await request(boardApp(companyId))
        .patch(`/api/issues/${issue.id}`)
        .send({ assigneeUserId: BOARD_USER_ID });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error).toBe("Issue can only have one assignee");
      expectRunStillRunning(await readRun(run.id));
      expect((await readIssue(issue.id)).assigneeAgentId).toBe(agentId);
    });

    it("still cancels the current run before an allowed reassignment", async () => {
      const { companyId, agentId } = await seedCompany();
      const issue = await issueService(db).create(companyId, {
        title: "Ordinary task",
        assigneeAgentId: agentId,
        status: "in_progress",
      });
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
  },
);
