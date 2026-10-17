import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issueRecoveryActions, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recoveryService, resourceWaitRefusalNextAction } from "../services/recovery/service.js";

/*
 * Fork (spec 7.1): a device or Claude account refusal blocks its task with a
 * board recovery action whose next action names the refusal's own fix, as its
 * blocked-task notice does, never the missing-secret text of other
 * configuration failures.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres refusal recovery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("recovery actions for device and Claude account refusals", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recovery-resource-wait-refusal-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function waitingTask() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const prefix = `RW${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Refusal Co", issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Builder",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Build the release",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    return { agentId, issue: issue! };
  }

  /** A run the account pool refused, as its configuration-incomplete failure leaves it. */
  function refusedRun(agentId: string, issueId: string, configurationIncomplete: Record<string, unknown>) {
    const at = new Date();
    return {
      id: randomUUID(),
      agentId,
      status: "failed",
      error: "Configuration incomplete",
      errorCode: "configuration_incomplete",
      contextSnapshot: { issueId },
      livenessState: "needs_followup" as const,
      startedAt: null,
      createdAt: at,
      finishedAt: at,
      resultJson: { configurationIncomplete },
    };
  }

  it.each([
    ["environment_refused", { reason: "environment_refused", deviceName: "Studio", environmentName: "SSH · Studio", fingerprint: "environment_refused:env-1" }],
    ["ai_connection_incompatible", { reason: "ai_connection_incompatible", fingerprint: "ai_connection_incompatible:agent-1" }],
    ["ai_connection_changed", { reason: "ai_connection_changed", fingerprint: "ai_connection_changed:run-1" }],
  ] as const)("names the fix of %s in the board recovery action", async (reason, configurationIncomplete) => {
    const { agentId, issue } = await waitingTask();
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    await recovery.escalateStrandedAssignedIssue({
      issue,
      previousStatus: "in_progress",
      latestRun: refusedRun(agentId, issue.id, configurationIncomplete),
      recoveryCause: "configuration_incomplete",
    });

    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issue.id));
    expect(action).toMatchObject({ cause: "configuration_incomplete", status: "active", ownerType: "board" });
    expect(action!.nextAction).toBe(resourceWaitRefusalNextAction(reason));
    expect(action!.nextAction).not.toContain("missing secret");
  });
});
