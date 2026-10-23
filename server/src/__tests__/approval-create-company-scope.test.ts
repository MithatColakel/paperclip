import { randomUUID } from "node:crypto";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { activityLog, agents, approvals, issueApprovals, issues } from "@paperclipai/db";
import { approvalRoutes } from "../routes/approvals.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("approval creation stays inside the company", () => {
  const ctx = useEmbeddedPostgres("paperclip-approval-company-scope-", {
    resetEach: async (db) => {
      await db.delete(issueApprovals);
      await db.delete(approvals);
      await db.delete(activityLog);
      await db.delete(agents);
      await resetCompanyIssueFixtures(db);
    },
  });

  async function seed() {
    const home = await seedCompanyWithBoardAccess(ctx.db, "Home");
    const other = await seedCompanyWithBoardAccess(ctx.db, "Other");
    const agentRow = (companyId: string, name: string) => ({
      companyId,
      name,
      role: "general",
      adapterType: "process",
      adapterConfig: {},
    });
    const [homeAgent, homePeer, otherAgent] = await ctx.db
      .insert(agents)
      .values([
        agentRow(home.companyId, "Home manager"),
        agentRow(home.companyId, "Home engineer"),
        agentRow(other.companyId, "Other manager"),
      ])
      .returning();
    const [homeIssue, otherIssue] = await ctx.db
      .insert(issues)
      .values([
        { companyId: home.companyId, title: "Home task", status: "todo", priority: "medium" },
        { companyId: other.companyId, title: "Other task", status: "blocked", priority: "high" },
      ])
      .returning();
    return { home, other, homeAgent: homeAgent!, homePeer: homePeer!, otherAgent: otherAgent!, homeIssue: homeIssue!, otherIssue: otherIssue! };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  function agentApp(seeded: Seeded) {
    const actor = {
      type: "agent",
      agentId: seeded.homeAgent.id,
      companyId: seeded.home.companyId,
      runId: null,
      source: "agent_key",
      isInstanceAdmin: false,
    };
    return routeApp(ctx.db, actor as never, approvalRoutes);
  }

  function boardApp(seeded: Seeded) {
    return routeApp(ctx.db, seeded.home.actor, approvalRoutes);
  }

  function postApproval(app: ReturnType<typeof routeApp>, seeded: Seeded, body: Record<string, unknown>) {
    return request(app)
      .post(`/api/companies/${seeded.home.companyId}/approvals`)
      .send({ type: "request_board_approval", payload: { title: "Approve the check" }, ...body });
  }

  async function homeApprovals(seeded: Seeded) {
    return ctx.db.select().from(approvals).where(eq(approvals.companyId, seeded.home.companyId));
  }

  async function createdActivity(seeded: Seeded) {
    return ctx.db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, seeded.home.companyId), eq(activityLog.action, "approval.created")));
  }

  it("refuses an agent that names another company's agent and issue", async () => {
    const seeded = await seed();

    const res = await postApproval(agentApp(seeded), seeded, {
      requestedByAgentId: seeded.otherAgent.id,
      issueIds: [seeded.otherIssue.id],
    });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Agents can request approvals only as themselves");
    expect(await homeApprovals(seeded)).toEqual([]);
    expect(await ctx.db.select().from(approvals)).toEqual([]);
  });

  it("refuses an agent that names a peer agent of its own company", async () => {
    const seeded = await seed();

    const res = await postApproval(agentApp(seeded), seeded, { requestedByAgentId: seeded.homePeer.id });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(await homeApprovals(seeded)).toEqual([]);
  });

  it("refuses a board user that names another company's agent", async () => {
    const seeded = await seed();

    const res = await postApproval(boardApp(seeded), seeded, { requestedByAgentId: seeded.otherAgent.id });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toBe("The requesting agent must belong to this company");
    expect(await homeApprovals(seeded)).toEqual([]);
  });

  it("creates nothing when a linked issue belongs to another company", async () => {
    const seeded = await seed();

    const res = await postApproval(agentApp(seeded), seeded, {
      requestedByAgentId: seeded.homeAgent.id,
      issueIds: [seeded.homeIssue.id, seeded.otherIssue.id],
    });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toBe("Issue and approval must belong to the same company");
    expect(await homeApprovals(seeded)).toEqual([]);
    expect(await ctx.db.select().from(issueApprovals)).toEqual([]);
    expect(await createdActivity(seeded)).toEqual([]);
  });

  it("creates nothing when a linked issue does not exist", async () => {
    const seeded = await seed();

    const res = await postApproval(boardApp(seeded), seeded, { issueIds: [randomUUID()] });

    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(await homeApprovals(seeded)).toEqual([]);
  });

  it("records the approval, its issue link and the activity row together", async () => {
    const seeded = await seed();

    const agentRes = await postApproval(agentApp(seeded), seeded, { issueIds: [seeded.homeIssue.id] });
    const boardRes = await postApproval(boardApp(seeded), seeded, { requestedByAgentId: seeded.homePeer.id });

    expect(agentRes.status, JSON.stringify(agentRes.body)).toBe(201);
    expect(agentRes.body).toMatchObject({
      companyId: seeded.home.companyId,
      requestedByAgentId: seeded.homeAgent.id,
      requestedByUserId: null,
      status: "pending",
    });
    expect(boardRes.status, JSON.stringify(boardRes.body)).toBe(201);
    expect(boardRes.body).toMatchObject({
      requestedByAgentId: seeded.homePeer.id,
      requestedByUserId: seeded.home.userId,
    });
    const links = await ctx.db.select().from(issueApprovals);
    expect(links).toEqual([
      expect.objectContaining({ approvalId: agentRes.body.id, issueId: seeded.homeIssue.id, companyId: seeded.home.companyId }),
    ]);
    expect((await createdActivity(seeded)).map((row) => row.entityId).sort()).toEqual(
      [agentRes.body.id, boardRes.body.id].sort(),
    );
  });
});
