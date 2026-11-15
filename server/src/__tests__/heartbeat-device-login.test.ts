import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  aiAccountAgentBindings,
  companies,
  createDb,
  deviceLoginLimits,
  environments,
  heartbeatRuns,
  issues,
  resourceWaitEpisodes,
} from "@paperclipai/db";
import { readResourceWaitContext } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createRunDispatch } from "../modules/run-dispatch/index.js";
import { createHeartbeatAiAccounts } from "../services/heartbeat-ai-accounts.js";
import { createHeartbeatDeviceLogin, readDeviceLoginAttribution } from "../services/heartbeat-device-login.js";
import {
  ResourceWaitDeferral,
  createResourceWaits,
  deviceLoginWaitDeferral,
  resourceWaitJitterMs,
  type ResourceWaitDeps,
  type ResourceWaitScheduleOptions,
} from "../services/resource-waits/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres device login limit tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type AgentRow = typeof agents.$inferSelect;
type RunRow = typeof heartbeatRuns.$inferSelect;
type EnvironmentRow = typeof environments.$inferSelect;

const HOUR = 60 * 60 * 1000;

describeEmbeddedPostgres("device login limits (database)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-device-login-limits-");
    db = createDb(database.connectionString);
  }, 120_000);

  afterAll(async () => {
    await db?.execute(sql`checkpoint`).catch(() => undefined);
    await database?.cleanup();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate table companies, ai_account_hosts, ai_accounts, environments cascade`);
  });

  const tag = () => randomUUID().slice(0, 8);
  const at = (base: Date, ms: number) => new Date(base.getTime() + ms);

  async function company() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: `Company ${tag()}`, issuePrefix: `D${id.replaceAll("-", "").slice(0, 7).toUpperCase()}` });
    return id;
  }

  async function sshEnvironment(companyId: string): Promise<EnvironmentRow> {
    const [row] = await db.insert(environments).values({
      companyId,
      name: `Mac ${tag()}`,
      driver: "ssh",
      config: { host: `mac-${tag()}.invalid`, port: 22, username: "mac" },
    }).returning();
    return row!;
  }

  async function agent(companyId: string, env: EnvironmentRow, overrides: Partial<typeof agents.$inferInsert> = {}): Promise<AgentRow> {
    const [row] = await db.insert(agents).values({
      companyId,
      name: `iOS ${tag()}`,
      adapterType: "claude_local",
      status: "active",
      defaultEnvironmentId: env.id,
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      ...overrides,
    }).returning();
    return row!;
  }

  async function issue(companyId: string, assignee: AgentRow) {
    const [row] = await db.insert(issues).values({
      companyId,
      title: `Task ${tag()}`,
      status: "in_progress",
      assigneeAgentId: assignee.id,
    }).returning();
    return row!;
  }

  async function run(agentRow: AgentRow, overrides: Partial<typeof heartbeatRuns.$inferInsert> = {}): Promise<RunRow> {
    const [row] = await db.insert(heartbeatRuns).values({
      companyId: agentRow.companyId,
      agentId: agentRow.id,
      invocationSource: "automation",
      status: "running",
      startedAt: new Date(),
      contextSnapshot: {},
      ...overrides,
    }).returning();
    return row!;
  }

  async function runRow(id: string): Promise<RunRow> {
    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
    return row!;
  }

  async function limitRow(environmentId: string) {
    const [row] = await db.select().from(deviceLoginLimits).where(eq(deviceLoginLimits.environmentId, environmentId));
    return row ?? null;
  }

  function attributionOf(env: EnvironmentRow) {
    return { environmentId: env.id, environmentName: env.name, deviceId: null, deviceName: null };
  }

  /** A device-login run that ended on a limit (the CLI's own result). */
  async function limitedRun(worker: AgentRow, env: EnvironmentRow, input: { reset?: Date | null; issueId?: string; error?: string } = {}) {
    return run(worker, {
      status: "failed",
      finishedAt: new Date(),
      errorCode: "provider_quota",
      error: input.error ?? "Claude run failed: subtype=success: You've hit your weekly limit · resets 7am (Europe/Istanbul)",
      resultJson: {
        errorFamily: "provider_quota",
        ...(input.reset ? { providerQuotaRetryNotBefore: input.reset.toISOString() } : {}),
      },
      contextSnapshot: { ...(input.issueId ? { issueId: input.issueId } : {}), deviceLogin: attributionOf(env) },
    });
  }

  function service() {
    const scheduled: ResourceWaitScheduleOptions[] = [];
    const runDispatch = createRunDispatch(db);
    const scheduleBoundedRetryForRun = async (source: RunRow, _agent: AgentRow, opts: ResourceWaitScheduleOptions) => {
      scheduled.push(opts);
      const issueId = typeof source.contextSnapshot?.issueId === "string" ? source.contextSnapshot.issueId : null;
      const [successor] = await db.insert(heartbeatRuns).values({
        companyId: source.companyId,
        agentId: source.agentId,
        invocationSource: "automation",
        status: "scheduled_retry",
        retryOfRunId: source.id,
        scheduledRetryAt: new Date(opts.now.getTime() + opts.delayMs),
        scheduledRetryAttempt: opts.maxAttempts,
        scheduledRetryReason: opts.retryReason,
        contextSnapshot: { ...source.contextSnapshot, retryReason: opts.retryReason, wakeReason: opts.wakeReason, ...opts.contextPatch },
      }).returning();
      if (issueId) {
        await db.update(issues).set({ executionRunId: successor!.id })
          .where(and(eq(issues.id, issueId), eq(issues.executionRunId, source.id)));
      }
      return { outcome: "scheduled" as const, run: successor! };
    };
    const appendRunEvent = async () => {};
    const waitDeps: ResourceWaitDeps = {
      async setRunStatusIfRunning(runId, status, patch) {
        const [row] = await db.update(heartbeatRuns).set({ ...patch, status, updatedAt: new Date() })
          .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "running"))).returning();
        return { run: row ?? null, updated: Boolean(row) };
      },
      async setWakeupStatus() {},
      async getRun(runId) {
        const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        return row ?? null;
      },
      async getAgent(agentId) {
        const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
        return row ?? null;
      },
      scheduleBoundedRetryForRun,
      appendRunEvent,
      async releaseIssueExecutionAndPromote() {},
      async finalizeAgentStatus() {},
      async enqueueWakeup() {
        return null;
      },
      async addIssueSystemNotice() {
        return null;
      },
      evaluateScheduledRetryGate: (input) => runDispatch.evaluateScheduledRetryGate(input),
    };
    const resourceWaits = createResourceWaits({
      db,
      deps: waitDeps,
      environmentWaitsEnabled: true,
      random: () => 0.5,
      deploymentMode: "authenticated",
    });
    const deviceLogin = createHeartbeatDeviceLogin({ db, resourceWaits });
    const accounts = createHeartbeatAiAccounts({
      db,
      resourceWaits,
      deviceLogin,
      deps: { appendRunEvent, scheduleBoundedRetryForRun },
      deploymentMode: "authenticated",
    });
    return { accounts, deviceLogin, resourceWaits, scheduled };
  }

  async function plan(
    accounts: ReturnType<typeof service>["accounts"],
    input: { worker: AgentRow; env: EnvironmentRow | null; target?: RunRow; resolvedEnv?: Record<string, unknown>; managedAiConnection?: boolean; now?: Date },
  ) {
    const target = input.target ?? await run(input.worker);
    const binding = await accounts.readBinding({ agent: input.worker, run: target });
    const context: Record<string, unknown> = { ...(target.contextSnapshot ?? {}) };
    const attribution = await accounts.planDeviceLogin({
      run: target,
      agent: input.worker,
      binding,
      environment: input.env,
      resolvedEnv: input.resolvedEnv ?? {},
      managedAiConnection: input.managedAiConnection ?? false,
      persisted: false,
      context,
      now: input.now,
    });
    return { attribution, context, target };
  }

  async function expectWait(promise: Promise<unknown>) {
    const error = await promise.then(() => null, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ResourceWaitDeferral);
    return error as ResourceWaitDeferral;
  }

  it("attributes an unbound or device_login run to its environment's own login, and nothing else", async () => {
    const { accounts } = service();
    const companyId = await company();
    const env = await sshEnvironment(companyId);
    const worker = await agent(companyId, env);

    const first = await plan(accounts, { worker, env });
    expect(first.attribution).toMatchObject({ environmentId: env.id, environmentName: env.name });
    expect(readDeviceLoginAttribution((await runRow(first.target.id)).contextSnapshot)).toMatchObject({ environmentId: env.id });

    await db.insert(aiAccountAgentBindings).values({ agentId: worker.id, companyId, mode: "device_login", accountId: null });
    expect((await plan(accounts, { worker, env })).attribution).toMatchObject({ environmentId: env.id });

    // An env credential, an upstream connection or another adapter is not the device login;
    // a retried run drops the attribution it copied.
    const copied = await run(worker, { contextSnapshot: { deviceLogin: attributionOf(env) } });
    const withToken = await plan(accounts, { worker, env, target: copied, resolvedEnv: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" } });
    expect(withToken.attribution).toBeNull();
    expect(withToken.context.deviceLogin).toBeUndefined();
    expect(readDeviceLoginAttribution((await runRow(copied.id)).contextSnapshot)).toBeNull();
    expect((await plan(accounts, { worker, env, managedAiConnection: true })).attribution).toBeNull();
    expect((await plan(accounts, { worker, env: null })).attribution).toBeNull();
    const codex = await agent(companyId, env, { adapterType: "codex_local" });
    expect((await plan(accounts, { worker: codex, env })).attribution).toBeNull();
  });

  it("records a typed weekly reset, makes the task wait in the device-login lane, and counts one strike per limit", async () => {
    const { accounts, scheduled } = service();
    const companyId = await company();
    const env = await sshEnvironment(companyId);
    const worker = await agent(companyId, env);
    const task = await issue(companyId, worker);
    const now = new Date();
    const reset = at(now, 20 * HOUR);
    const failed = await limitedRun(worker, env, { reset, issueId: task.id });
    await db.update(issues).set({ executionRunId: failed.id }).where(eq(issues.id, task.id));

    const outcome = await accounts.handleProviderLimit({ run: failed, agent: worker, now });
    expect(outcome).toMatchObject({ handled: true, reason: "usage_limit", via: "device_login" });
    expect(await limitRow(env.id)).toMatchObject({
      companyId,
      exhaustedUntil: reset,
      limitSource: "provider",
      limitStrikes: 1,
      limitReason: "provider_quota",
      limitRunId: failed.id,
    });
    expect(scheduled[0]).toMatchObject({ retryReason: "device_login_wait" });
    const [successor] = await db.select().from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.retryOfRunId, failed.id), eq(heartbeatRuns.status, "scheduled_retry")));
    const context = readResourceWaitContext(successor!.contextSnapshot?.resourceWait);
    expect(context).toMatchObject({ kind: "device_login", reason: "usage_limit", scope: "account", environmentId: env.id, accountId: null, resumeAtSource: "provider" });
    expect(new Date(context!.resumeAt!).getTime()).toBe(reset.getTime() + resourceWaitJitterMs(failed.id));
    const [episode] = await db.select().from(resourceWaitEpisodes).where(eq(resourceWaitEpisodes.issueId, task.id));
    expect(episode).toMatchObject({ kind: "device_login", resourceKey: `device_login:${env.id}`, currentRunId: successor!.id });
    const logged = await db.select().from(activityLog).where(eq(activityLog.action, "device_login.limit_reached"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ companyId, entityType: "environment", entityId: env.id });

    // Another run that was already running hits the same limit: no new strike, no second entry.
    const other = await agent(companyId, env);
    const second = await limitedRun(other, env, { reset });
    expect(await accounts.handleProviderLimit({ run: second, agent: other, now: at(now, 60_000) })).toMatchObject({ handled: true });
    expect(await limitRow(env.id)).toMatchObject({ limitStrikes: 1, exhaustedUntil: reset });
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "device_login.limit_reached"))).toHaveLength(1);
  });

  it("estimates an untyped limit at an hour and leaves a transcript-only match alone", async () => {
    const { accounts } = service();
    const companyId = await company();
    const env = await sshEnvironment(companyId);
    const worker = await agent(companyId, env);
    const now = new Date();
    const transcript = await limitedRun(worker, env);
    expect(await accounts.handleProviderLimit({ run: transcript, agent: worker, now, provenance: { classificationSource: "transcript" } }))
      .toMatchObject({ handled: false, reason: "transcript_only", via: "device_login" });
    expect(await limitRow(env.id)).toBeNull();

    const untyped = await limitedRun(worker, env, { error: "Claude run failed: 5-hour limit reached" });
    expect(await accounts.handleProviderLimit({ run: untyped, agent: worker, now })).toMatchObject({ handled: true });
    expect(await limitRow(env.id)).toMatchObject({ limitSource: "estimated", limitStrikes: 1, exhaustedUntil: at(now, HOUR) });

    // A run without the attribution is no device-login run.
    const plain = await run(worker, { status: "failed", errorCode: "provider_quota", resultJson: { errorFamily: "provider_quota" } });
    expect(await accounts.handleProviderLimit({ run: plain, agent: worker, now })).toMatchObject({ handled: false, reason: "not_pool_run", via: null });
  });

  it("makes every later run on that login wait until the reset, then lets one probe through", async () => {
    const { accounts } = service();
    const companyId = await company();
    const env = await sshEnvironment(companyId);
    const otherEnv = await sshEnvironment(companyId);
    const worker = await agent(companyId, env);
    const now = new Date();
    const reset = at(now, 5 * HOUR);
    await accounts.handleProviderLimit({ run: await limitedRun(worker, env, { reset }), agent: worker, now });

    const waiting = await expectWait(plan(accounts, { worker, env, now: at(now, HOUR) }));
    expect(waiting.wait).toMatchObject({ kind: "device_login", reason: "usage_limit", environmentId: env.id, resumeAtSource: "provider" });
    expect(waiting.wait.resumeAt!.getTime()).toBeGreaterThanOrEqual(reset.getTime());
    // Another environment's login is not limited.
    expect((await plan(accounts, { worker: await agent(companyId, otherEnv), env: otherEnv, now })).attribution).not.toBeNull();

    // After the reset one run tests the login; the next waits while that probe is live.
    const after = at(reset, 60_000);
    const probe = await plan(accounts, { worker, env, now: after });
    expect(probe.attribution).not.toBeNull();
    expect((await limitRow(env.id))!.limitProbeRunId).toBe(probe.target.id);
    const blocked = await expectWait(plan(accounts, { worker: await agent(companyId, env), env, now: after }));
    expect(blocked.wait).toMatchObject({ kind: "device_login", resumeAt: null });
  });

  it("clears the limit after a served run and wakes the login's waiting runs", async () => {
    const { accounts, resourceWaits } = service();
    const companyId = await company();
    const env = await sshEnvironment(companyId);
    const worker = await agent(companyId, env);
    const now = new Date();
    await db.insert(deviceLoginLimits).values({
      environmentId: env.id,
      companyId,
      exhaustedUntil: at(now, -60_000),
      limitSource: "provider",
      limitReason: "provider_quota",
      limitStrikes: 1,
      limitEpisodeStartedAt: at(now, -6 * HOUR),
    });
    const other = await agent(companyId, env);
    const held = await resourceWaits.scheduleResourceWait({
      run: await limitedRun(other, env),
      wait: deviceLoginWaitDeferral({ reason: "usage_limit", environment: { id: env.id, name: env.name }, resumeAt: at(now, HOUR) }).wait,
      now,
      releaseIfUnscheduled: false,
    });
    expect((await runRow(held.successorRunId!)).scheduledRetryAt!.getTime()).toBeGreaterThan(now.getTime());

    const served = await run(worker, {
      status: "succeeded",
      finishedAt: now,
      usageJson: { inputTokens: 120, outputTokens: 40 },
      contextSnapshot: { deviceLogin: attributionOf(env) },
    });
    const outcome = await accounts.noteAccountRunSucceeded({ run: served, now });
    expect(outcome.cleared).toBe(true);
    expect(outcome.woken).toBeGreaterThanOrEqual(1);
    expect(await limitRow(env.id)).toMatchObject({ exhaustedUntil: null, limitSource: null, limitStrikes: 0, limitEpisodeStartedAt: null, limitProbeRunId: null });
    expect((await runRow(held.successorRunId!)).scheduledRetryAt!.getTime()).toBeLessThanOrEqual(at(now, 120_000).getTime());

    // A run that never reached the provider says nothing about the login.
    await db.update(deviceLoginLimits).set({ limitStrikes: 2 }).where(eq(deviceLoginLimits.environmentId, env.id));
    const unserved = await run(worker, { status: "failed", errorCode: "adapter_failed", contextSnapshot: { deviceLogin: attributionOf(env) } });
    expect((await accounts.noteAccountRunSucceeded({ run: unserved, now })).cleared).toBe(false);
    expect((await limitRow(env.id))!.limitStrikes).toBe(2);
  });

  it("holds a waiting run until the reset, admits the oldest waiter as the probe, and lets Check now take it over", async () => {
    const { resourceWaits } = service();
    const companyId = await company();
    const env = await sshEnvironment(companyId);
    const now = new Date();
    const reset = at(now, 2 * HOUR);
    await db.insert(deviceLoginLimits).values({
      environmentId: env.id,
      companyId,
      exhaustedUntil: reset,
      limitSource: "provider",
      limitReason: "provider_quota",
      limitStrikes: 1,
      limitEpisodeStartedAt: now,
    });
    const schedule = async (worker: AgentRow, since: Date) => {
      const task = await issue(companyId, worker);
      const source = await limitedRun(worker, env, { issueId: task.id });
      await db.update(issues).set({ executionRunId: source.id }).where(eq(issues.id, task.id));
      const scheduledWait = await resourceWaits.scheduleResourceWait({
        run: source,
        wait: deviceLoginWaitDeferral({ reason: "usage_limit", environment: { id: env.id, name: env.name }, resumeAt: reset, resumeAtSource: "provider" }).wait,
        now: since,
        releaseIfUnscheduled: false,
      });
      return scheduledWait.successorRunId!;
    };
    const firstId = await schedule(await agent(companyId, env), now);
    const secondId = await schedule(await agent(companyId, env), at(now, 1_000));

    // Due before the reset: both are held until it.
    await db.update(heartbeatRuns).set({ scheduledRetryAt: at(now, 1_000) }).where(eq(heartbeatRuns.status, "scheduled_retry"));
    const before = await resourceWaits.holdDueWaits({ now: at(now, 5_000) });
    expect(before.held).toBe(2);
    expect((await runRow(firstId)).scheduledRetryAt!.getTime()).toBeGreaterThan(at(now, 5_000).getTime());

    // After the reset, only the oldest waiter goes, as the probe.
    const after = at(reset, 5_000);
    await db.update(heartbeatRuns).set({ scheduledRetryAt: at(reset, 1_000) }).where(eq(heartbeatRuns.status, "scheduled_retry"));
    const pass = await resourceWaits.holdDueWaits({ now: after });
    expect(pass).toMatchObject({ proceeding: 1, held: 1, probesClaimed: 1 });
    expect((await limitRow(env.id))!.limitProbeRunId).toBe(firstId);

    // Check now on the other task hands it the probe and an attempt, even before the reset.
    await db.update(deviceLoginLimits).set({ exhaustedUntil: at(after, HOUR), limitProbeRunId: null }).where(eq(deviceLoginLimits.environmentId, env.id));
    const checked = await resourceWaits.checkRunNow({ runId: secondId, companyId, now: after });
    expect(checked.outcome).toBe("proceed");
    expect(await limitRow(env.id)).toMatchObject({ limitProbeRunId: secondId, exhaustedUntil: after });
    expect((await runRow(secondId)).scheduledRetryAt!.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});
