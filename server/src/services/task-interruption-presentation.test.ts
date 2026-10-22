import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issues,
  type Db } from "@paperclipai/db";
import { RESOURCE_WAIT_RETRY_REASONS } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { projectTaskInterruption, taskInterruptionPresentation } from "./task-interruption-presentation.js";

type ProjectionIssue = Parameters<typeof projectTaskInterruption>[0];
type ProjectionRun = NonNullable<Parameters<typeof projectTaskInterruption>[1]["run"]>;

const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const waitingIssue: ProjectionIssue = { id: "issue-1", companyId: "company-1", status: "in_progress",
  assigneeAgentId: "agent-1", projectId: null };
function successor(patch: Partial<ProjectionRun> = {}): ProjectionRun {
  return { id: "run-successor", status: "scheduled_retry", scheduledRetryAt: new Date(NOW + 5 * 60_000),
    scheduledRetryReason: null, errorCode: null, livenessState: null, resultJson: null, ...patch };
}

// Fork: the device, Claude account and account-slot waits own their surfaces.
describe("task interruption projection of fork waits", () => {
  it.each(RESOURCE_WAIT_RETRY_REASONS)("leaves a %s successor to the wait surfaces", lane => {
    const input = { paused: false, approval: false };
    expect(projectTaskInterruption(waitingIssue, { ...input, run: successor({ scheduledRetryReason: lane }) }, NOW)).toBeNull();
    // Due, but the hold has not re-armed it yet: still a wait, not a failed attempt.
    expect(projectTaskInterruption(waitingIssue, { ...input,
      run: successor({ scheduledRetryReason: lane, scheduledRetryAt: new Date(NOW - 10_000) }) }, NOW)).toBeNull();
  });

  it("keeps an ordinary scheduled retry and a real user gate", () => {
    expect(projectTaskInterruption(waitingIssue, { run: successor({ scheduledRetryReason: "transient_failure" }),
      paused: false, approval: false }, NOW))
      .toMatchObject({ responsibility: "system", state: "retry_scheduled", canRetry: true });
    expect(projectTaskInterruption(waitingIssue, { run: successor({ scheduledRetryReason: "ai_account_wait" }),
      agent: { status: "paused", pauseReason: null }, paused: false, approval: false }, NOW))
      .toMatchObject({ responsibility: "user", state: "waiting_for_user", userAction: "resume" });
    // An admission attempt the hold promoted is real work.
    expect(projectTaskInterruption(waitingIssue, { run: successor({ status: "running", scheduledRetryReason: "device_slot_wait" }),
      paused: false, approval: false }, NOW))
      .toMatchObject({ responsibility: "system", state: "working" });
  });
});

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping task interruption database tests: ${support.reason}`);
describe.skipIf(!support.supported)("task interruption presentation reads", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-task-interruption-presentation");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });
  beforeEach(async () => {
    await db.execute(sql`truncate table companies restart identity cascade`);
  });

  async function seed() {
    const [company] = await db.insert(companies).values({ name: "Interruptions", issuePrefix: "TIP" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Coder", role: "engineer",
      status: "idle", adapterType: "process", adapterConfig: {} }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Waiting task", status: "in_progress",
      assigneeAgentId: agent.id }).returning();
    return { company, agent, issue };
  }

  it("reads a resource-wait lane from the issue's latest run", async () => {
    const { company, agent, issue } = await seed();
    // A deferral and its lane successor, as resource-waits/deferral.ts writes them.
    const [deferral] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id,
      status: "cancelled", errorCode: "device_slots_full", contextSnapshot: { issueId: issue.id },
      createdAt: new Date(Date.now() - 60_000), finishedAt: new Date(Date.now() - 60_000) }).returning();
    const [waiting] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id,
      status: "scheduled_retry", retryOfRunId: deferral.id, scheduledRetryReason: "device_slot_wait", scheduledRetryAttempt: 1,
      scheduledRetryAt: new Date(Date.now() + 5 * 60_000), contextSnapshot: { issueId: issue.id } }).returning();
    expect(await taskInterruptionPresentation(db, issue)).toBeNull();
    await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(Date.now() - 10_000) }).where(eq(heartbeatRuns.id, waiting.id));
    expect(await taskInterruptionPresentation(db, issue)).toBeNull();
    // Upstream's own scheduled retries keep their countdown.
    await db.update(heartbeatRuns).set({ scheduledRetryReason: "transient_failure", scheduledRetryAt: new Date(Date.now() + 60_000) })
      .where(eq(heartbeatRuns.id, waiting.id));
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ state: "retry_scheduled", canRetry: true });
  });

  it("does not show work held by the daily cap as an interrupted attempt", async () => {
    const { company, agent, issue } = await seed();
    await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id, status: "succeeded",
      contextSnapshot: { issueId: issue.id }, startedAt: new Date(Date.now() - 120_000), finishedAt: new Date(Date.now() - 90_000) });
    const requestedAt = new Date(Date.now() - 60_000);
    const savedMessage = { companyId: company.id, agentId: agent.id, source: "automation", triggerDetail: "system",
      reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "board",
      requestedAt } as const;
    // A board comment that met the agent's daily cap is held for the next window.
    await db.insert(agentWakeupRequests).values({ ...savedMessage, payload: { issueId: issue.id,
      dailyCapDeferral: { reason: "heartbeat.daily_run_limit", observed: 1, limit: 1, heldAt: requestedAt.toISOString() } } });
    expect(await taskInterruptionPresentation(db, issue))
      .toMatchObject({ responsibility: "system", state: "resolved", canRetry: false, intentId: null });
    // A saved message that is not held still reads as upstream's unfinished attempt.
    const [saved] = await db.insert(agentWakeupRequests).values({ ...savedMessage, payload: { issueId: issue.id } }).returning();
    expect(await taskInterruptionPresentation(db, issue))
      .toMatchObject({ responsibility: "system", state: "failed", canRetry: true, intentId: saved.id });
  });
});
