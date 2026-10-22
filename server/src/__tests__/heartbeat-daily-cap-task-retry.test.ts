import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { requestTaskRetry } from "../services/task-retry.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping embedded Postgres daily-cap task Retry tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

// Fork: the daily-cap hold keeps issue work for the next window, but a board
// task Retry is a one-run receipt. It keeps upstream's skip at dispatch, and a
// Retry clicked at the cap waits on its receipt instead of adding rows.
describeEmbeddedPostgres("task Retry at the daily cap", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-daily-cap-task-retry-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  async function seed(heartbeatConfig: Record<string, unknown>) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sourceRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Capped company",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", status: "idle",
      adapterType: "process", adapterConfig: {}, runtimeConfig: { heartbeat: heartbeatConfig } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Retry at the cap", status: "in_progress",
      assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId, issueId, status: "failed",
      contextSnapshot: { issueId }, finishedAt: new Date() });
    // Occupies the agent's only slot, so an admitted Retry stays queued and no adapter runs.
    const [slot] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running",
      startedAt: new Date() }).returning();
    return { companyId, agentId, issueId, sourceRunId, slotRunId: slot.id };
  }

  function clickRetry(f: Awaited<ReturnType<typeof seed>>) {
    return requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "local-board",
      actorSource: "local_implicit", observedRunId: f.sourceRunId, idempotencyKey: randomUUID() });
  }
  const wakeRows = (companyId: string) =>
    db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
  const queuedRuns = (companyId: string) => db.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "queued")));

  it("keeps a Retry clicked at the cap on its one receipt until the cap clears", async () => {
    const f = await seed({ maxConcurrentRuns: 1, maxDailyRuns: 0 });
    const receipt = await clickRetry(f);
    expect(receipt).toMatchObject({ accepted: true });
    // The route's nudge, then scheduler ticks while the agent stays capped.
    await heartbeat.resumeTaskRetry(f.companyId, receipt.requestId!);
    for (let tick = 0; tick < 3; tick++) await heartbeat.resumeExecutionWaitComments();
    expect(await wakeRows(f.companyId)).toEqual([expect.objectContaining({
      id: receipt.requestId, status: "deferred_issue_execution", runId: null,
      payload: expect.objectContaining({ executionWait: expect.objectContaining({ reason: "heartbeat.daily_run_limit" }) }),
    })]);
    expect(await queuedRuns(f.companyId)).toHaveLength(0);

    // The window rolls over (here, the cap is lifted). The same receipt admits the Retry once, with its identity.
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, f.agentId));
    await heartbeat.resumeExecutionWaitComments();
    const queued = await queuedRuns(f.companyId);
    expect(queued).toHaveLength(1);
    expect(queued[0].contextSnapshot).toMatchObject({ issueId: f.issueId, wakeReason: "task_retry",
      taskRetryRequestId: receipt.requestId, previousRunId: f.sourceRunId, forceFreshSession: true });
    expect((await wakeRows(f.companyId)).find(row => row.id === receipt.requestId))
      .toMatchObject({ status: "coalesced", runId: queued[0].id });
  });

  it("skips a queued task Retry that meets the cap at dispatch instead of holding it", async () => {
    const f = await seed({ maxConcurrentRuns: 1 });
    const receipt = await clickRetry(f);
    await heartbeat.resumeTaskRetry(f.companyId, receipt.requestId!);
    const [queued] = await queuedRuns(f.companyId);
    expect(queued?.contextSnapshot).toMatchObject({ wakeReason: "task_retry", taskRetryRequestId: receipt.requestId });

    // The run that held the slot used up the day's last run while the Retry waited.
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1, maxDailyRuns: 1 } } })
      .where(eq(agents.id, f.agentId));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.slotRunId));
    await heartbeat.resumeQueuedRuns();

    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.id)))[0])
      .toMatchObject({ status: "cancelled", errorCode: "heartbeat.daily_run_limit" });
    const wakes = await wakeRows(f.companyId);
    expect(wakes.find(row => row.id === queued.wakeupRequestId)).toMatchObject({ status: "skipped" });
    // Nothing is held for a later replay without the Retry's receipt.
    expect(wakes.filter(row => row.status === "deferred_issue_execution" || row.payload?.dailyCapDeferral)).toEqual([]);
    expect(await queuedRuns(f.companyId)).toHaveLength(0);
  });
});
