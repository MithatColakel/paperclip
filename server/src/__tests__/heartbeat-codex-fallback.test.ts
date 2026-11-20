import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  aiAccountAgentBindings,
  aiAccounts,
  companies,
  createDb,
  deviceLoginLimits,
  environments,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createRunDispatch } from "../modules/run-dispatch/index.js";
import {
  CODEX_FALLBACK_TIMINGS,
  buildCodexFallbackAdapterConfig,
  codexBlockUntil,
  evaluateCodexFallback,
  readCodexFallbackAttribution,
} from "../services/codex-fallback-policy.js";
import { createHeartbeatAiAccounts } from "../services/heartbeat-ai-accounts.js";
import { createHeartbeatCodexFallback } from "../services/heartbeat-codex-fallback.js";
import { createHeartbeatDeviceLogin } from "../services/heartbeat-device-login.js";
import {
  createResourceWaits,
  deviceLoginWaitDeferral,
  type ResourceWaitDeps,
  type ResourceWaitScheduleOptions,
} from "../services/resource-waits/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Codex fallback tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type AgentRow = typeof agents.$inferSelect;
type RunRow = typeof heartbeatRuns.$inferSelect;
type EnvironmentRow = typeof environments.$inferSelect;

const HOUR = 60 * 60 * 1000;

describe("Codex fallback adapter config", () => {
  it("keeps instructions, workspace and plain env, drops Claude-only settings and foreign credentials", () => {
    const config = buildCodexFallbackAdapterConfig({
      model: "claude-opus-5-5",
      effort: "high",
      engine: "acp",
      command: "claude",
      extraArgs: ["--verbose"],
      maxTurnsPerRun: 300,
      dangerouslySkipPermissions: true,
      instructionsFilePath: "/agents/ios/AGENTS.md",
      promptTemplate: "Do {{task}}",
      cwd: "/work/ios",
      timeoutSec: 5400,
      graceSec: 30,
      workspaceStrategy: { type: "git_worktree" },
      env: {
        BASH_MAX_TIMEOUT_MS: { type: "plain", value: "5400000" },
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: { type: "plain", value: "1" },
        ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "s1" },
        OPENAI_API_KEY: { type: "secret_ref", secretId: "s2" },
        CODEX_HOME: { type: "plain", value: "/srv/codex" },
        GH_TOKEN: { type: "secret_ref", secretId: "s3" },
      },
    }, { model: "gpt-6-sol", modelReasoningEffort: "high" });
    expect(config).toEqual({
      instructionsFilePath: "/agents/ios/AGENTS.md",
      promptTemplate: "Do {{task}}",
      cwd: "/work/ios",
      timeoutSec: 5400,
      graceSec: 30,
      workspaceStrategy: { type: "git_worktree" },
      env: {
        BASH_MAX_TIMEOUT_MS: { type: "plain", value: "5400000" },
        GH_TOKEN: { type: "secret_ref", secretId: "s3" },
      },
      engine: "cli",
      dangerouslyBypassApprovalsAndSandbox: true,
      deviceCodexLogin: true,
      model: "gpt-6-sol",
      modelReasoningEffort: "high",
    });
    // Without a model Codex keeps its own default; a Claude agent that asked for approvals keeps them.
    expect(buildCodexFallbackAdapterConfig({ dangerouslySkipPermissions: false }, { model: null, modelReasoningEffort: null }))
      .toEqual({ engine: "cli", dangerouslyBypassApprovalsAndSandbox: false, deviceCodexLogin: true });
  });

  it("blocks Codex until its typed reset (capped), five hours for an untyped limit, an hour for a failure", () => {
    const now = new Date("2026-11-20T10:00:00Z");
    const reset = new Date("2026-11-20T15:30:00Z");
    expect(codexBlockUntil({ now, reason: "codex_limit", typedReset: reset })).toEqual(reset);
    expect(codexBlockUntil({ now, reason: "codex_limit", typedReset: null }).getTime()).toBe(now.getTime() + CODEX_FALLBACK_TIMINGS.limitEstimateMs);
    expect(codexBlockUntil({ now, reason: "codex_limit", typedReset: new Date(now.getTime() + 30 * 24 * HOUR) }).getTime())
      .toBe(now.getTime() + CODEX_FALLBACK_TIMINGS.maxBlockMs);
    expect(codexBlockUntil({ now, reason: "codex_failed", typedReset: reset }).getTime()).toBe(now.getTime() + HOUR);
  });
});

describeEmbeddedPostgres("Codex fallback (database)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-codex-fallback-");
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
    await db.insert(companies).values({ id, name: `Company ${tag()}`, issuePrefix: `C${id.replaceAll("-", "").slice(0, 7).toUpperCase()}` });
    return id;
  }

  async function macEnvironment(companyId: string, driver: "sandbox" | "ssh" = "sandbox"): Promise<EnvironmentRow> {
    const [row] = await db.insert(environments).values({
      companyId,
      name: `Mac ${tag()}`,
      driver,
      config: driver === "sandbox"
        ? { provider: "mac-fleet", deviceId: randomUUID(), reuseLease: true }
        : { host: `mac-${tag()}.invalid`, port: 22, username: "mac" },
    }).returning();
    return row!;
  }

  async function agent(companyId: string, env: EnvironmentRow | null, overrides: Partial<typeof agents.$inferInsert> = {}): Promise<AgentRow> {
    const [row] = await db.insert(agents).values({
      companyId,
      name: `iOS ${tag()}`,
      adapterType: "claude_local",
      adapterConfig: { model: "claude-opus-5-5", dangerouslySkipPermissions: true, cwd: "/work/ios" },
      status: "active",
      defaultEnvironmentId: env?.id ?? null,
      runtimeConfig: { heartbeat: { wakeOnDemand: true }, codexFallback: { enabled: true, model: "gpt-6-sol" } },
      ...overrides,
    }).returning();
    return row!;
  }

  async function issue(companyId: string, assignee: AgentRow) {
    const [row] = await db.insert(issues).values({ companyId, title: `Task ${tag()}`, status: "in_progress", assigneeAgentId: assignee.id }).returning();
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
      runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } },
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

  async function limitLogin(companyId: string, env: EnvironmentRow, until: Date) {
    await db.insert(deviceLoginLimits).values({
      environmentId: env.id,
      companyId,
      exhaustedUntil: until,
      limitSource: "provider",
      limitReason: "provider_quota",
      limitStrikes: 1,
      limitEpisodeStartedAt: new Date(),
    }).onConflictDoUpdate({ target: deviceLoginLimits.environmentId, set: { exhaustedUntil: until } });
  }

  async function poolAccount(label: string, exhaustedUntil: Date | null) {
    const [row] = await db.insert(aiAccounts).values({
      hostId: null,
      credentialType: "subscription",
      label,
      status: "active",
      poolEnabled: true,
      credentialMaterial: {},
      credentialFingerprint: `fp-${tag()}`,
      credentialHint: "…abcd",
      exhaustedUntil,
      limitSource: exhaustedUntil ? "provider" : null,
    } as typeof aiAccounts.$inferInsert).returning();
    return row!;
  }

  function service() {
    const scheduled: ResourceWaitScheduleOptions[] = [];
    const events: string[] = [];
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
    const appendRunEvent = async (_run: RunRow, event: { message?: string }) => {
      if (event.message) events.push(event.message);
    };
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
    const codexFallback = createHeartbeatCodexFallback({
      db,
      wakeResourceWaits: (filter, options) => resourceWaits.wakeResourceWaits(filter, options),
      appendRunEvent,
    });
    const accounts = createHeartbeatAiAccounts({
      db,
      resourceWaits,
      deviceLogin: createHeartbeatDeviceLogin({ db, resourceWaits }),
      codexFallback,
      deps: { appendRunEvent, scheduleBoundedRetryForRun },
      deploymentMode: "authenticated",
    });
    return { accounts, codexFallback, resourceWaits, scheduled, events };
  }

  it("applies only to an opted-in Claude agent on a device whose Claude account is at its limit", async () => {
    const companyId = await company();
    const mac = await macEnvironment(companyId);
    const now = new Date();
    const worker = await agent(companyId, mac);
    expect(await evaluateCodexFallback(db, { agent: worker, now })).toMatchObject({ eligible: false, reason: "claude_available" });

    await limitLogin(companyId, mac, at(now, 20 * HOUR));
    const decision = await evaluateCodexFallback(db, { agent: worker, now });
    expect(decision).toMatchObject({
      eligible: true,
      attribution: { environmentId: mac.id, environmentName: mac.name, claudeSource: "device_login", model: "gpt-6-sol" },
    });

    // Off, another adapter, an SSH or missing environment, an upstream connection, or a passed reset: no fallback.
    const off = await agent(companyId, mac, { runtimeConfig: { codexFallback: { enabled: false } } });
    expect(await evaluateCodexFallback(db, { agent: off, now })).toMatchObject({ reason: "disabled" });
    const codex = await agent(companyId, mac, { adapterType: "codex_local" });
    expect(await evaluateCodexFallback(db, { agent: codex, now })).toMatchObject({ reason: "adapter" });
    const sshAgent = await agent(companyId, await macEnvironment(companyId, "ssh"));
    expect(await evaluateCodexFallback(db, { agent: sshAgent, now })).toMatchObject({ reason: "no_device_environment" });
    const noEnv = await agent(companyId, null);
    expect(await evaluateCodexFallback(db, { agent: noEnv, now })).toMatchObject({ reason: "no_device_environment" });
    const routed = await agent(companyId, mac, {
      runtimeConfig: { codexFallback: { enabled: true }, aiConnection: { mode: "shared", connectionId: randomUUID() } },
    });
    expect(await evaluateCodexFallback(db, { agent: routed, now })).toMatchObject({ reason: "upstream_connection" });
    expect(await evaluateCodexFallback(db, { agent: worker, now: at(now, 21 * HOUR) })).toMatchObject({ reason: "claude_available" });

    // A Codex block on the device holds it off until it passes.
    await db.update(deviceLoginLimits).set({ codexFallbackBlockedUntil: at(now, HOUR), codexFallbackBlockReason: "codex_failed" })
      .where(eq(deviceLoginLimits.environmentId, mac.id));
    expect(await evaluateCodexFallback(db, { agent: worker, now })).toMatchObject({ eligible: false, reason: "codex_blocked" });
    expect(await evaluateCodexFallback(db, { agent: worker, now: at(now, 2 * HOUR) })).toMatchObject({ eligible: true });
  });

  it("follows a pool account's limit for a pool-bound agent on a device", async () => {
    const companyId = await company();
    const mac = await macEnvironment(companyId);
    const now = new Date();
    const limited = await poolAccount("S (server token)", at(now, 3 * HOUR));
    const worker = await agent(companyId, mac);
    await db.insert(aiAccountAgentBindings).values({ agentId: worker.id, companyId, mode: "pool_account", accountId: limited.id });
    expect(await evaluateCodexFallback(db, { agent: worker, now })).toMatchObject({
      eligible: true,
      attribution: { claudeSource: "pool_account", accountId: limited.id, accountLabel: "S (server token)" },
    });
    // The device's own login limit does not matter to a pool-bound agent.
    const fresh = await poolAccount("K", null);
    await db.update(aiAccountAgentBindings).set({ accountId: fresh.id }).where(eq(aiAccountAgentBindings.agentId, worker.id));
    await limitLogin(companyId, mac, at(now, 3 * HOUR));
    expect(await evaluateCodexFallback(db, { agent: worker, now })).toMatchObject({ eligible: false, reason: "claude_available" });
  });

  it("moves a claimed Claude run to Codex once, dropping the Claude attributions it copied", async () => {
    const { codexFallback, events } = service();
    const companyId = await company();
    const mac = await macEnvironment(companyId);
    const now = new Date();
    const worker = await agent(companyId, mac);
    await limitLogin(companyId, mac, at(now, 5 * HOUR));
    const target = await run(worker, {
      contextSnapshot: {
        issueId: randomUUID(),
        deviceLogin: { environmentId: mac.id },
        aiConnection: { mode: "pool_account", accountId: randomUUID(), runId: randomUUID() },
      },
    });

    const applied = await codexFallback.applyToRun({ run: target, agent: worker, now });
    expect(applied.fallback?.agent).toMatchObject({
      id: worker.id,
      adapterType: "codex_local",
      adapterConfig: { engine: "cli", deviceCodexLogin: true, model: "gpt-6-sol", cwd: "/work/ios", dangerouslyBypassApprovalsAndSandbox: true },
    });
    expect((applied.fallback?.agent.adapterConfig as Record<string, unknown>).dangerouslySkipPermissions).toBeUndefined();
    const stored = await runRow(target.id);
    expect(stored.runnerProfileJson).toMatchObject({ adapterDispatch: { adapterType: "codex_local" } });
    expect(stored.contextSnapshot?.deviceLogin).toBeUndefined();
    expect(stored.contextSnapshot?.aiConnection).toBeUndefined();
    expect(stored.contextSnapshot?.issueId).toBe(target.contextSnapshot?.issueId);
    expect(readCodexFallbackAttribution(stored.contextSnapshot)).toMatchObject({ environmentId: mac.id, claudeSource: "device_login" });
    expect(applied.run.id).toBe(target.id);
    expect(events.some((message) => message.includes("uses the Codex login"))).toBe(true);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "agent.codex_fallback_started"))).toHaveLength(1);

    // A resumed execution keeps Codex even after the reset; a second run in the episode logs nothing new.
    const resumed = await codexFallback.applyToRun({ run: stored, agent: worker, now: at(now, 6 * HOUR) });
    expect(resumed.fallback?.agent.adapterType).toBe("codex_local");
    const second = await run(worker);
    expect((await codexFallback.applyToRun({ run: second, agent: worker, now })).fallback).not.toBeNull();
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "agent.codex_fallback_started"))).toHaveLength(1);

    // A retry of a fallback run after the reset goes back to Claude and drops the Codex attribution.
    const retry = await run(worker, { contextSnapshot: { codexFallback: stored.contextSnapshot?.codexFallback } });
    const back = await codexFallback.applyToRun({ run: retry, agent: worker, now: at(now, 6 * HOUR) });
    expect(back.fallback).toBeNull();
    expect(back.run.contextSnapshot?.codexFallback).toBeUndefined();
    expect((await runRow(retry.id)).runnerProfileJson).toMatchObject({ adapterDispatch: { adapterType: "claude_local" } });

    // A run that is no longer running is never claimed for Codex.
    const finished = await run(worker, { status: "cancelled" });
    expect((await codexFallback.applyToRun({ run: finished, agent: worker, now })).fallback).toBeNull();
  });

  it("starts the waiting task on Codex as soon as the Claude limit is recorded", async () => {
    const { accounts, resourceWaits } = service();
    const now = new Date();
    const reset = at(now, 20 * HOUR);
    const limitHit = async (runtimeConfig: Record<string, unknown>) => {
      const companyId = await company();
      const mac = await macEnvironment(companyId);
      const worker = await agent(companyId, mac, { runtimeConfig });
      const task = await issue(companyId, worker);
      const failed = await run(worker, {
        status: "failed",
        finishedAt: now,
        errorCode: "provider_quota",
        error: "Claude run failed: You've hit your weekly limit · resets 7am (Europe/Istanbul)",
        resultJson: { errorFamily: "provider_quota", providerQuotaRetryNotBefore: reset.toISOString() },
        contextSnapshot: { issueId: task.id, deviceLogin: { environmentId: mac.id, environmentName: mac.name, deviceId: null, deviceName: null } },
      });
      await db.update(issues).set({ executionRunId: failed.id }).where(eq(issues.id, task.id));
      expect(await accounts.handleProviderLimit({ run: failed, agent: worker, now })).toMatchObject({ handled: true, via: "device_login" });
      const [successor] = await db.select().from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.retryOfRunId, failed.id), eq(heartbeatRuns.status, "scheduled_retry")));
      return successor!;
    };

    const withFallback = await limitHit({ codexFallback: { enabled: true } });
    // Woken at once instead of waiting for its next check.
    expect(withFallback.scheduledRetryAt!.getTime()).toBeLessThanOrEqual(at(now, 60_000).getTime());
    const without = await limitHit({});
    await db.update(heartbeatRuns).set({ scheduledRetryAt: at(now, 1_000) }).where(eq(heartbeatRuns.id, without.id));

    // The hold lets the fallback agent's wait through and keeps the other until the reset.
    expect(await resourceWaits.holdDueWaits({ now: at(now, 2 * 60_000) })).toMatchObject({ proceeding: 1, held: 1 });
    // A proceeding run stays due for promotion; a held one is re-armed for the reset.
    expect((await runRow(withFallback.id)).scheduledRetryAt!.getTime()).toBeLessThanOrEqual(at(now, 2 * 60_000).getTime());
    expect((await runRow(without.id)).scheduledRetryAt!.getTime()).toBeGreaterThan(at(now, 2 * 60_000).getTime());
  });

  it("holds a Claude limit wait while Codex is blocked on the device, and lets it through when the fallback applies", async () => {
    const { resourceWaits } = service();
    const companyId = await company();
    const mac = await macEnvironment(companyId);
    const now = new Date();
    const reset = at(now, 10 * HOUR);
    await limitLogin(companyId, mac, reset);
    await db.update(deviceLoginLimits).set({ codexFallbackBlockedUntil: at(now, HOUR), codexFallbackBlockReason: "codex_limit" })
      .where(eq(deviceLoginLimits.environmentId, mac.id));
    const worker = await agent(companyId, mac);
    const task = await issue(companyId, worker);
    const source = await run(worker, { status: "failed", contextSnapshot: { issueId: task.id } });
    await db.update(issues).set({ executionRunId: source.id }).where(eq(issues.id, task.id));
    const scheduled = await resourceWaits.scheduleResourceWait({
      run: source,
      wait: deviceLoginWaitDeferral({ reason: "usage_limit", environment: { id: mac.id, name: mac.name }, resumeAt: reset, resumeAtSource: "provider" }).wait,
      now,
      releaseIfUnscheduled: false,
    });
    const waitId = scheduled.successorRunId!;
    await db.update(heartbeatRuns).set({ scheduledRetryAt: at(now, 1_000) }).where(eq(heartbeatRuns.id, waitId));
    expect(await resourceWaits.holdDueWaits({ now: at(now, 5_000) })).toMatchObject({ held: 1, proceeding: 0 });

    // Once the block has passed, the wait proceeds (to run on Codex) long before the Claude reset.
    const later = at(now, 2 * HOUR);
    await db.update(heartbeatRuns).set({ scheduledRetryAt: at(later, -1_000) }).where(eq(heartbeatRuns.id, waitId));
    expect(await resourceWaits.holdDueWaits({ now: later })).toMatchObject({ held: 0, proceeding: 1 });
  });

  it("clears the device's block when Codex served a run, and blocks it after a Codex limit or an early failure", async () => {
    const { codexFallback, events } = service();
    const companyId = await company();
    const mac = await macEnvironment(companyId);
    const worker = await agent(companyId, mac);
    const now = new Date();
    const attribution = {
      environmentId: mac.id,
      environmentName: mac.name,
      claudeSource: "device_login",
      accountId: null,
      accountLabel: null,
      claudeUntil: at(now, 10 * HOUR).toISOString(),
      model: null,
      modelReasoningEffort: null,
    };
    const fallbackRun = (overrides: Partial<typeof heartbeatRuns.$inferInsert>) => run(worker, {
      runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } },
      contextSnapshot: { codexFallback: attribution },
      finishedAt: now,
      ...overrides,
    });

    const limited = await fallbackRun({
      status: "failed",
      errorCode: "provider_quota",
      error: "You've hit your usage limit.",
      resultJson: { errorFamily: "provider_quota", retryNotBefore: at(now, 3 * HOUR).toISOString(), retryNotBeforeSource: "provider_terminal" },
    });
    expect(await codexFallback.noteRunEnded({ run: limited, now })).toMatchObject({ fallback: true, blocked: true, reason: "codex_limit" });
    expect(await limitRow(mac.id)).toMatchObject({ codexFallbackBlockedUntil: at(now, 3 * HOUR), codexFallbackBlockReason: "codex_limit", codexFallbackBlockRunId: limited.id });
    expect(events.some((message) => message.includes("its own usage limit"))).toBe(true);

    const served = await fallbackRun({ status: "succeeded", usageJson: { inputTokens: 120, outputTokens: 40 } });
    expect(await codexFallback.noteRunEnded({ run: served, now })).toMatchObject({ fallback: true, blocked: false, reason: "served" });
    expect(await limitRow(mac.id)).toMatchObject({ codexFallbackBlockedUntil: null, codexFallbackBlockReason: null });

    const noLogin = await fallbackRun({ status: "failed", errorCode: "adapter_failed", error: "This device has no Codex login" });
    expect(await codexFallback.noteRunEnded({ run: noLogin, now })).toMatchObject({ blocked: true, reason: "codex_failed" });
    expect((await limitRow(mac.id))!.codexFallbackBlockedUntil!.getTime()).toBe(now.getTime() + HOUR);

    // A failure after Codex served tokens is an ordinary failure; cancelled and Claude runs change nothing.
    const servedFailure = await fallbackRun({ status: "failed", errorCode: "adapter_failed", usageJson: { outputTokens: 10 } });
    expect(await codexFallback.noteRunEnded({ run: servedFailure, now })).toMatchObject({ blocked: false, reason: "served" });
    const cancelled = await fallbackRun({ status: "cancelled" });
    expect(await codexFallback.noteRunEnded({ run: cancelled, now })).toMatchObject({ blocked: false, reason: "other_end" });
    const claudeRun = await run(worker, { status: "failed", errorCode: "provider_quota", contextSnapshot: { codexFallback: attribution } });
    expect(await codexFallback.noteRunEnded({ run: claudeRun, now })).toMatchObject({ fallback: false, reason: "not_fallback" });
  });
});
