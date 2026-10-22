import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  environments,
  heartbeatRuns,
  issues,
  resourceWaitEpisodes,
} from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET, RESOURCE_WAIT_LANE_BY_KIND, buildResourceWaitContext } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { environmentAvailabilityService } from "../services/environment-availability.js";
import { createResourceWaits, resolveRunEnvironment, type ResourceWaitDeps } from "../services/resource-waits/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres resource-wait environment tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/** The issue-scoped low-trust boundary a guest intake task carries. */
function lowTrustPolicy(companyId: string, issueId: string) {
  return {
    mode: "normal",
    commentRequired: true,
    stages: [],
    authorizationPolicy: {
      trustPreset: LOW_TRUST_REVIEW_PRESET,
      trustBoundary: { mode: LOW_TRUST_REVIEW_PRESET, companyId, rootIssueId: issueId, issueIds: [issueId] },
    },
  };
}

describeEmbeddedPostgres("resource waits: the environment a waiting run resolves to", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-resource-waits-run-environment-");
    db = createDb(database.connectionString);
  }, 120_000);

  afterAll(async () => {
    await db?.execute(sql`checkpoint`).catch(() => undefined);
    await database?.cleanup();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate table companies, environments cascade`);
    await db.insert(environments).values({ name: "Local", driver: "local" });
  });

  /** An agent pinned to an SSH computer, and a sandbox its company's tasks can select. */
  async function fixture() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Guests", issuePrefix: `G${companyId.replaceAll("-", "").slice(0, 7).toUpperCase()}` });
    const [pinned] = await db.insert(environments).values({ companyId, name: "SSH box", driver: "ssh",
      config: { host: "runner.invalid", port: 22, username: "runner" } }).returning();
    const [sandbox] = await db.insert(environments).values({ companyId, name: "Guest sandbox", driver: "sandbox",
      config: { provider: "guest-sandbox" } }).returning();
    const [worker] = await db.insert(agents).values({ companyId, name: "Receptionist", adapterType: "claude_local", status: "active",
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, defaultEnvironmentId: pinned!.id }).returning();
    const task = async (input: { lowTrust: boolean }) => {
      const id = randomUUID();
      const [row] = await db.insert(issues).values({
        id, companyId, title: "Incoming phone conversation", status: "in_progress", priority: "medium", assigneeAgentId: worker!.id,
        executionWorkspaceSettings: { mode: "isolated_workspace", environmentId: sandbox!.id },
        ...(input.lowTrust ? { executionPolicy: lowTrustPolicy(companyId, id) } : {}),
      }).returning();
      return row!;
    };
    return { companyId, pinned: pinned!, sandbox: sandbox!, worker: worker!, task };
  }

  it("resolves a low-trust review run to the sandbox its issue selects, and any other run to its usual environment", async () => {
    const { companyId, pinned, sandbox, worker, task } = await fixture();
    const guest = await task({ lowTrust: true });
    const ordinary = await task({ lowTrust: false });

    expect(await resolveRunEnvironment(db, { companyId, agent: worker, issueId: guest.id }))
      .toMatchObject({ environment: { id: sandbox.id }, source: "issue" });
    // The issue's selection alone does not override the agent's computer.
    expect(await resolveRunEnvironment(db, { companyId, agent: worker, issueId: ordinary.id }))
      .toMatchObject({ environment: { id: pinned.id }, source: "agent" });
    // A boundary the run retained stays with it.
    expect(await resolveRunEnvironment(db, { companyId, agent: worker, issueId: ordinary.id, executionPolicy: lowTrustPolicy(companyId, ordinary.id) }))
      .toMatchObject({ environment: { id: sandbox.id }, source: "issue" });
  });

  it.each([
    { boundary: "its issue's policy", issueLowTrust: true },
    // The issue no longer carries the boundary; the run that waits retained it.
    { boundary: "the policy its run retained", issueLowTrust: false },
  ])("holds a low-trust review run that waits for its issue's sandbox instead of letting it attempt again ($boundary)", async ({ issueLowTrust }) => {
    const { companyId, sandbox, worker, task } = await fixture();
    const guest = await task({ lowTrust: issueLowTrust });
    const retained = issueLowTrust ? {} : { executionPolicy: lowTrustPolicy(companyId, guest.id) };
    const now = new Date();
    await environmentAvailabilityService(db).markUnavailable(sandbox.id, { reason: "offline", source: "lease_error", now });

    // The lane successor the deferral left, as the current run of the issue's wait.
    const lane = RESOURCE_WAIT_LANE_BY_KIND.environment;
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId: worker.id, invocationSource: "automation", status: "scheduled_retry",
      scheduledRetryReason: lane, scheduledRetryAt: new Date(now.getTime() - 1_000), scheduledRetryAttempt: 1,
      contextSnapshot: { issueId: guest.id, retryReason: lane, ...retained },
    }).returning();
    const [episode] = await db.insert(resourceWaitEpisodes).values({
      companyId, agentId: worker.id, issueId: guest.id, kind: "environment", reason: "offline", scope: "target",
      resourceKey: `environment:${sandbox.id}`, environmentId: sandbox.id, since: now, currentRunId: run!.id,
    }).returning();
    const resourceWait = buildResourceWaitContext({
      episodeId: episode!.id, kind: "environment", reason: "offline", scope: "target",
      environmentId: sandbox.id, environmentName: sandbox.name, deviceId: null, deviceName: null,
      accountId: null, accountLabel: null, resumeAt: null, resumeAtSource: null, message: null,
    });
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: guest.id, retryReason: lane, resourceWait, ...retained } })
      .where(eq(heartbeatRuns.id, run!.id));
    await db.update(issues).set({ executionRunId: run!.id }).where(eq(issues.id, guest.id));

    const unexpected = (name: string) => vi.fn(async () => { throw new Error(`Unexpected ${name}`); });
    const deps: ResourceWaitDeps = {
      setRunStatusIfRunning: unexpected("setRunStatusIfRunning"),
      setWakeupStatus: unexpected("setWakeupStatus"),
      getRun: unexpected("getRun"),
      getAgent: unexpected("getAgent"),
      scheduleBoundedRetryForRun: unexpected("scheduleBoundedRetryForRun"),
      appendRunEvent: unexpected("appendRunEvent"),
      releaseIssueExecutionAndPromote: unexpected("releaseIssueExecutionAndPromote"),
      finalizeAgentStatus: unexpected("finalizeAgentStatus"),
      enqueueWakeup: unexpected("enqueueWakeup"),
      addIssueSystemNotice: unexpected("addIssueSystemNotice"),
      evaluateScheduledRetryGate: vi.fn(async () => ({ allowed: true as const })),
    };
    const waits = createResourceWaits({ db, deps, environmentWaitsEnabled: true, random: () => 0.5 });

    expect(await waits.holdDueWaits({ now })).toMatchObject({ examined: 1, held: 1, proceeding: 0 });
    const [held] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    expect(held).toMatchObject({ status: "scheduled_retry" });
    expect(held!.scheduledRetryAt!.getTime()).toBeGreaterThan(now.getTime());
    const [kept] = await db.select().from(resourceWaitEpisodes).where(eq(resourceWaitEpisodes.id, episode!.id));
    expect(kept).toMatchObject({ resolvedAt: null, currentRunId: run!.id });
  });
});
