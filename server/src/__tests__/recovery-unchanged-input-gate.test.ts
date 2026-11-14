import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
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
import {
  createUnchangedInputGate,
  loadRecoveryIssueChangeTokens,
} from "../services/recovery/unchanged-input-gate.ts";
import { recoveryService } from "../services/recovery/service.ts";

describe("createUnchangedInputGate", () => {
  it("evaluates a new or changed token at once and an unchanged one only after recheckMs", () => {
    let clock = 0;
    const gate = createUnchangedInputGate({ recheckMs: 300_000, now: () => clock });
    expect(gate.isDue("a", "t1")).toBe(true);
    gate.record("a", "t1");
    clock += 30_000;
    expect(gate.isDue("a", "t1")).toBe(false);
    expect(gate.isDue("a", "t2")).toBe(true);
    clock += 270_000;
    expect(gate.isDue("a", "t1")).toBe(true);
  });

  it("is always due without a token and when disabled", () => {
    const gate = createUnchangedInputGate({ recheckMs: 300_000, now: () => 0 });
    gate.record("a", "t1");
    expect(gate.isDue("a", undefined)).toBe(true);
    const off = createUnchangedInputGate({ recheckMs: 0, now: () => 0 });
    off.record("a", "t1");
    expect(off.enabled).toBe(false);
    expect(off.isDue("a", "t1")).toBe(true);
    expect(off.size()).toBe(0);
  });

  it("forgets keys that are no longer candidates", () => {
    const gate = createUnchangedInputGate({ recheckMs: 300_000, now: () => 0 });
    gate.record("a", "t");
    gate.record("b", "t");
    gate.retainOnly(["b"]);
    expect(gate.size()).toBe(1);
    expect(gate.isDue("a", "t")).toBe(true);
    expect(gate.isDue("b", "t")).toBe(false);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) console.warn(`EPG-SKIP: ${embeddedPostgresSupport.reason}`);

describeEmbeddedPostgres("recovery change tokens", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issueId = randomUUID();
  const otherIssueId = randomUUID();
  const childId = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recovery-unchanged-gate-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Gate Co", issuePrefix: "GAT", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Coder", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(issues).values([
      { id: issueId, companyId, title: "Watched", status: "in_review", priority: "medium", assigneeAgentId: agentId, issueNumber: 1, identifier: "GAT-1" },
      { id: otherIssueId, companyId, title: "Other", status: "todo", priority: "medium", assigneeAgentId: agentId, issueNumber: 2, identifier: "GAT-2" },
      { id: childId, companyId, title: "Child", status: "todo", priority: "medium", parentId: issueId, issueNumber: 3, identifier: "GAT-3" },
    ]);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const tokenOf = async (id = issueId) => (await loadRecoveryIssueChangeTokens(db, [id])).get(id);
  const later = () => new Date(Date.now() + 60_000);

  it("is stable while nothing changes and ignores other issues", async () => {
    const first = await tokenOf();
    expect(first).toBeTruthy();
    expect(await tokenOf()).toBe(first);
    await db.update(issues).set({ title: "Other edited", updatedAt: later() }).where(eq(issues.id, otherIssueId));
    expect(await tokenOf()).toBe(first);
  });

  it("changes when a comment, run, wake or child changes", async () => {
    let before = await tokenOf();
    await db.insert(issueComments).values({ companyId, issueId, body: "progress" });
    let after = await tokenOf();
    expect(after).not.toBe(before);

    before = after;
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, invocationSource: "manual", status: "running", contextSnapshot: { issueId },
    });
    after = await tokenOf();
    expect(after).not.toBe(before);

    before = after;
    await db.update(heartbeatRuns).set({ status: "succeeded", updatedAt: later() }).where(eq(heartbeatRuns.id, runId));
    after = await tokenOf();
    expect(after).not.toBe(before);

    before = after;
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", payload: { issueId } });
    after = await tokenOf();
    expect(after).not.toBe(before);

    before = after;
    await db.update(issues).set({ status: "in_progress", updatedAt: later() }).where(eq(issues.id, childId));
    after = await tokenOf();
    expect(after).not.toBe(before);
  });

  it("changes on every read while a monitor check is overdue", async () => {
    await db.update(issues).set({ monitorNextCheckAt: new Date(Date.now() - 60_000) }).where(eq(issues.id, otherIssueId));
    const a = await tokenOf(otherIssueId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const b = await tokenOf(otherIssueId);
    expect(a).not.toBe(b);
    await db.update(issues).set({ monitorNextCheckAt: null }).where(eq(issues.id, otherIssueId));
  });

  it("lets the stranded sweep skip unchanged candidates and re-evaluate a changed one", async () => {
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup, unchangedRecheckMs: 300_000 });
    const first = await recovery.reconcileStrandedAssignedIssues();
    expect(first.unchangedSkipped).toBe(0);
    const second = await recovery.reconcileStrandedAssignedIssues();
    expect(second.unchangedSkipped).toBeGreaterThanOrEqual(2);

    await db.insert(issueComments).values({ companyId, issueId, body: "new input" });
    const third = await recovery.reconcileStrandedAssignedIssues();
    expect(third.unchangedSkipped).toBe(second.unchangedSkipped - 1);

    const ungated = recoveryService(db, { enqueueWakeup });
    expect((await ungated.reconcileStrandedAssignedIssues()).unchangedSkipped).toBe(0);
    expect((await ungated.reconcileStrandedAssignedIssues()).unchangedSkipped).toBe(0);
  });
});
