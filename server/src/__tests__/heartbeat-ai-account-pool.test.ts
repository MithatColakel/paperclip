import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  aiAccountAgentBindings,
  aiAccountRunSlots,
  aiAccounts,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  resourceWaitEpisodes,
} from "@paperclipai/db";
import { AI_CREDENTIAL_REF_ENV_KEY } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../adapters/index.js";
import { logger } from "../middleware/logger.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { credentialRefForAccount } from "../services/ai-account-credentials.js";
import { aiAccountPoolService } from "../services/ai-account-pool.js";
import { aiConnectionPoolService } from "../services/ai-connection-pool.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { heartbeatService } from "../services/heartbeat.js";

// claude_local is the adapter pool accounts serve; its execute is the mock.
const adapterExecute = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.js")>("../adapters/index.js");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: adapterExecute })) };
});

// A test can make the run path's limit or sign-in handler fail; otherwise they pass through.
const poolFaults = vi.hoisted(() => ({ handleProviderLimit: null as Error | null, handleRunAuthFailure: null as Error | null }));
vi.mock("../services/heartbeat-ai-accounts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat-ai-accounts.js")>();
  return {
    ...actual,
    createHeartbeatAiAccounts: (...args: Parameters<typeof actual.createHeartbeatAiAccounts>) => {
      const service = actual.createHeartbeatAiAccounts(...args);
      return {
        ...service,
        handleProviderLimit: async (input: Parameters<typeof service.handleProviderLimit>[0]) => {
          if (poolFaults.handleProviderLimit) throw poolFaults.handleProviderLimit;
          return service.handleProviderLimit(input);
        },
        handleRunAuthFailure: async (input: Parameters<typeof service.handleRunAuthFailure>[0]) => {
          if (poolFaults.handleRunAuthFailure) throw poolFaults.handleRunAuthFailure;
          return service.handleRunAuthFailure(input);
        },
      };
    },
  };
});

// SSH computers: the lease reaches the host through this call.
vi.mock("@paperclipai/adapter-utils/ssh", async (importOriginal) => ({
  ...await importOriginal<typeof import("@paperclipai/adapter-utils/ssh")>(),
  ensureSshWorkspaceReady: async (config: { remoteWorkspacePath: string }) => ({ remoteCwd: config.remoteWorkspacePath }),
}));

// Commands on a remote target never leave this test. The routing guard's
// settings scans find nothing, and the target's GitHub setup is out of scope.
const targetStub = vi.hoisted(() => ({ processes: [] as Array<{ command: string; args: string[]; env: unknown }> }));
vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>();
  return {
    ...actual,
    runAdapterExecutionTargetProcess: async (_runId: string, _target: unknown, command: string, args: string[], options?: { env?: unknown }) => {
      targetStub.processes.push({ command, args, env: options?.env });
      return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
    },
    prepareGitHubExecutionEnvironment: async (input: Parameters<typeof actual.prepareGitHubExecutionEnvironment>[0]) =>
      input.target?.kind === "remote"
        ? {
          ...input.env,
          PAPERCLIP_GIT_METADATA_ROOTS: "[]",
          PAPERCLIP_RUNNER_NETWORK_ROOTS: "[]",
          PAPERCLIP_GITHUB_AUTH_MODE: input.hostCredentials ? "host" : "managed",
          PAPERCLIP_RUNNER_NETWORK_ACCESS: input.networkAccess ? "enabled" : "disabled",
        }
        : actual.prepareGitHubExecutionEnvironment(input),
    prepareGitHubOperationLaunchers: async (input: Parameters<typeof actual.prepareGitHubOperationLaunchers>[0]) =>
      input.target?.kind === "remote" ? { ...input.env } : actual.prepareGitHubOperationLaunchers(input),
    cleanupGitHubOperationLaunchers: async (input: Parameters<typeof actual.cleanupGitHubOperationLaunchers>[0]) =>
      input.target?.kind === "remote" ? undefined : actual.cleanupGitHubOperationLaunchers(input),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat account pool tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type RunRow = typeof heartbeatRuns.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type Behaviour = (input: AdapterExecutionContext) => Promise<AdapterExecutionResult>;

const HOUR = 60 * 60 * 1000;
const TEST_MASTER_KEY = "cd".repeat(32);

/** What the adapter saw for one run: the child process environment and the task context. */
interface Invocation {
  runId: string;
  agentId: string;
  env: Record<string, unknown>;
  context: Record<string, unknown>;
}

describeEmbeddedPostgres("heartbeat Claude account pool (integration)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService> | null = null;
  let previousMasterKey: string | undefined;
  const invocations: Invocation[] = [];
  const scripts = new Map<string, Behaviour[]>();
  const logLines: string[] = [];
  let restoreLogStream: (() => void) | null = null;

  beforeAll(async () => {
    previousMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = TEST_MASTER_KEY;
    database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-ai-account-pool-");
    db = createDb(database.connectionString);
    // Every server log line (any level, any child logger) passes this stream.
    const stream = (logger as unknown as Record<symbol, { write: (chunk: string) => unknown }>)[pino.symbols.streamSym]!;
    const write = stream.write;
    stream.write = function capture(this: unknown, chunk: string) {
      logLines.push(String(chunk));
      return write.call(this, chunk);
    };
    restoreLogStream = () => {
      stream.write = write;
    };
    adapterExecute.mockImplementation(async (input: AdapterExecutionContext) => {
      const env = { ...(input.config.env as Record<string, unknown> | undefined ?? {}) };
      invocations.push({ runId: input.runId, agentId: input.agent.id, env, context: structuredClone(input.context) });
      // As claude-local does: the invocation meta (with the environment) goes to the run's events.
      await input.onMeta?.({ adapterType: "claude_local", command: "claude", cwd: "/workspace", commandArgs: [], env: { ...env } as Record<string, string> });
      const behaviour = scripts.get(input.agent.id)?.shift() ?? finishTask;
      return behaviour(input);
    });
  }, 60_000);

  afterEach(async () => {
    if (heartbeat) await drainHeartbeatRunsToQuiescence(db, heartbeat);
    heartbeat = null;
    poolFaults.handleProviderLimit = null;
    poolFaults.handleRunAuthFailure = null;
    invocations.length = 0;
    scripts.clear();
    logLines.length = 0;
    targetStub.processes.length = 0;
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table companies, plugins, ai_account_hosts, ai_accounts, environments, "user" cascade`);
    });
  });

  afterAll(async () => {
    restoreLogStream?.();
    if (previousMasterKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY = previousMasterKey;
    // A checkpoint leaves the shutdown little to write, so the data directory goes in time.
    await db?.execute(sql`checkpoint`).catch(() => undefined);
    await database?.cleanup();
  });

  const tag = () => randomUUID().slice(0, 8);

  /** The agent reports on its task and closes it, as a real agent does, so no follow-up run starts. */
  async function finishTask(input: AdapterExecutionContext): Promise<AdapterExecutionResult> {
    const issueId = typeof input.context.issueId === "string" ? input.context.issueId : null;
    if (issueId) {
      const [task] = await db.select({ companyId: issues.companyId }).from(issues).where(eq(issues.id, issueId));
      await db.insert(issueComments).values({
        companyId: task!.companyId,
        issueId,
        authorType: "agent",
        authorAgentId: input.agent.id,
        createdByRunId: input.runId,
        body: "Done.",
      });
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
    }
    return { exitCode: 0, signal: null, timedOut: false, resultJson: {}, usage: { inputTokens: 120, outputTokens: 40 } };
  }

  /** The CLI's own result: the account's usage limit, with the provider's reset time when one is given. */
  function usageLimit(reset?: Date): Behaviour {
    return async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "provider_quota",
      errorFamily: "provider_quota",
      classificationSource: "terminal",
      errorMessage: "Claude usage limit reached.",
      ...(reset ? { retryNotBefore: reset.toISOString(), retryNotBeforeSource: "provider_terminal" as const } : {}),
      resultJson: { errorFamily: "provider_quota" },
    });
  }

  /** The CLI's own sign-in failure; `typed` carries the API's 401. */
  function signInFailure(typed = false): Behaviour {
    return async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "claude_auth_required",
      classificationSource: "terminal",
      errorMessage: "Invalid API key. Please run /login.",
      resultJson: typed ? { api_error_status: 401 } : {},
    });
  }

  function script(agentId: string, ...behaviours: Behaviour[]) {
    scripts.set(agentId, behaviours);
  }

  async function company() {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: `Company ${tag()}`,
      issuePrefix: `P${id.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    return id;
  }

  async function owner(companyId: string) {
    const userId = `owner-${tag()}`;
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: userId, email: `${userId}@example.com`, emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "owner" });
    return userId;
  }

  async function account(ownerUserId: string, label: string) {
    const token = `sk-ant-oat01-${randomUUID().replaceAll("-", "")}`;
    const prepared = await localEncryptedProvider.createSecret({ value: token });
    const [row] = await db.insert(aiAccounts).values({
      credentialType: "subscription",
      label,
      ownerUserId,
      createdByUserId: ownerUserId,
      credentialMaterial: prepared.material as Record<string, unknown>,
      credentialFingerprint: randomUUID(),
    }).returning();
    return { ...row!, token };
  }

  async function agent(companyId: string, overrides: Partial<typeof agents.$inferInsert> = {}): Promise<AgentRow> {
    const [row] = await db.insert(agents).values({
      companyId,
      name: `Agent ${tag()}`,
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
      ...overrides,
    }).returning();
    return row!;
  }

  async function bind(worker: AgentRow, accountId: string) {
    await db.insert(aiAccountAgentBindings).values({ agentId: worker.id, companyId: worker.companyId, mode: "pool_account", accountId });
  }

  async function issue(companyId: string, assigneeAgentId: string, overrides: Partial<typeof issues.$inferInsert> = {}) {
    const [prefix] = await db.select({ issuePrefix: companies.issuePrefix }).from(companies).where(eq(companies.id, companyId));
    const [counter] = await db.select({ count: sql<number>`count(*)::int` }).from(issues).where(eq(issues.companyId, companyId));
    const number = (counter?.count ?? 0) + 1;
    const [row] = await db.insert(issues).values({
      companyId,
      title: `Task ${number}`,
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId,
      issueNumber: number,
      identifier: `${prefix!.issuePrefix}-${number}`,
      ...overrides,
    }).returning();
    return row!;
  }

  async function sshEnvironment(companyId: string) {
    const [row] = await db.insert(environments).values({
      companyId,
      name: `SSH box ${tag()}`,
      driver: "ssh",
      status: "active",
      config: { host: `box-${tag()}.invalid`, port: 22, username: "runner", remoteWorkspacePath: "/home/runner/work" },
    }).returning();
    return row!;
  }

  async function runRow(id: string): Promise<RunRow> {
    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
    return row!;
  }

  async function accountRow(id: string) {
    const [row] = await db.select().from(aiAccounts).where(eq(aiAccounts.id, id));
    return row!;
  }

  async function waitFor<T>(read: () => Promise<T | null | undefined | false>, timeoutMs = 15_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await read();
      if (value) return value;
      if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function finishedRun(id: string) {
    return waitFor(async () => {
      const row = await runRow(id);
      return row && ["succeeded", "failed", "cancelled", "timed_out"].includes(row.status) ? row : null;
    });
  }

  async function successorOf(id: string) {
    return waitFor(async () => {
      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, id));
      return row ?? null;
    });
  }

  async function assign(agentId: string, issueId: string) {
    const run = await heartbeat!.invoke(agentId, "assignment", { issueId, taskId: issueId, wakeReason: "issue_assigned" }, "system");
    expect(run).not.toBeNull();
    return run!;
  }

  async function systemNotices(issueId: string) {
    return db.select().from(issueComments)
      .where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system")))
      .orderBy(asc(issueComments.createdAt));
  }

  async function episodeOf(issueId: string) {
    const [row] = await db.select().from(resourceWaitEpisodes).where(eq(resourceWaitEpisodes.issueId, issueId));
    return row!;
  }

  /** Time passes until an account's limit resets: its reset moves into the past and its waits are due. */
  async function limitResets(companyId: string, accountId: string) {
    const past = new Date(Date.now() - 1_000);
    await db.update(aiAccounts).set({ exhaustedUntil: past }).where(eq(aiAccounts.id, accountId));
    await db.update(heartbeatRuns).set({ scheduledRetryAt: past })
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "scheduled_retry")));
  }

  /** One scheduler tick: due waits are held or promoted, then queued runs start. */
  async function tick(now?: Date) {
    const promotion = await heartbeat!.promoteDueScheduledRetries(now);
    await heartbeat!.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat!);
    return promotion;
  }

  /** The pool token appears nowhere but in the child process environment. */
  async function expectTokenNowhere(token: string) {
    const tables = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const leaking: string[] = [];
    for (const { table_name: table } of tables) {
      const rows = await db.execute(sql`select 1 from ${sql.identifier(table)} t where t::text like ${`%${token}%`} limit 1`);
      if (rows.length > 0) leaking.push(table);
    }
    expect(leaking).toEqual([]);
    for (const { id } of await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)) {
      const log = await heartbeat!.readLog(id).catch(() => null);
      expect(log?.content ?? "").not.toContain(token);
    }
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.filter((line) => line.includes(token))).toEqual([]);
    for (const process of targetStub.processes) expect(JSON.stringify(process)).not.toContain(token);
  }

  describe("a pool-bound agent's run", () => {
    it("gets its account's token and the marker in the child environment on an SSH computer, and the token goes nowhere else", async () => {
      const companyId = await company();
      const ownerId = await owner(companyId);
      const pool = await account(ownerId, "Max A");
      const environment = await sshEnvironment(companyId);
      const worker = await agent(companyId, { defaultEnvironmentId: environment.id });
      await bind(worker, pool.id);
      const task = await issue(companyId, worker.id);
      heartbeat = heartbeatService(db);

      const run = await assign(worker.id, task.id);
      expect(await finishedRun(run.id)).toMatchObject({ status: "succeeded" });
      await drainHeartbeatRunsToQuiescence(db, heartbeat);

      expect(invocations).toHaveLength(1);
      const [invocation] = invocations;
      expect(invocation!.env).toMatchObject({
        CLAUDE_CODE_OAUTH_TOKEN: pool.token,
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
        [AI_CREDENTIAL_REF_ENV_KEY]: credentialRefForAccount(pool.id),
      });
      expect(invocation!.context.aiConnection).toMatchObject({ mode: "pool_account", accountId: pool.id, runId: run.id });
      const finished = await runRow(run.id);
      expect(finished.contextSnapshot).toMatchObject({ aiConnection: { mode: "pool_account", accountId: pool.id, runId: run.id } });
      const [slot] = await db.select().from(aiAccountRunSlots).where(eq(aiAccountRunSlots.runId, run.id));
      expect(slot).toMatchObject({ accountId: pool.id, companyId });
      // The run's events say which account it used, and the invocation meta is redacted.
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id));
      expect(events.map((event) => event.message)).toEqual(expect.arrayContaining([expect.stringContaining(`Using Claude account "Max A"`)]));
      const invoke = events.find((event) => event.eventType === "adapter.invoke");
      expect(invoke?.payload).toMatchObject({ env: { CLAUDE_CODE_OAUTH_TOKEN: "***REDACTED***" } });
      // The routing guard scanned the project's Claude settings on the computer.
      expect(targetStub.processes.length).toBeGreaterThan(0);

      await expectTokenNowhere(pool.token);
    }, 60_000);

    it("on the Local environment runs with its pool token and the marker, on the server device", async () => {
      const companyId = await company();
      const ownerId = await owner(companyId);
      const pool = await account(ownerId, "Max L");
      const worker = await agent(companyId);
      await bind(worker, pool.id);
      const task = await issue(companyId, worker.id);
      heartbeat = heartbeatService(db);

      const run = await assign(worker.id, task.id);
      expect(await finishedRun(run.id)).toMatchObject({ status: "succeeded" });
      expect(invocations).toHaveLength(1);
      expect(invocations[0]!.env).toMatchObject({
        CLAUDE_CODE_OAUTH_TOKEN: pool.token,
        ANTHROPIC_API_KEY: "",
        [AI_CREDENTIAL_REF_ENV_KEY]: credentialRefForAccount(pool.id),
      });
      const [slot] = await db.select().from(aiAccountRunSlots).where(eq(aiAccountRunSlots.runId, run.id));
      const [device] = await db.execute<{ kind: string; external_key: string }>(
        sql`select kind, external_key from ai_account_hosts where id = ${slot!.deviceId}`,
      );
      expect(device).toMatchObject({ kind: "server", external_key: "local" });
      expect((await accountRow(pool.id)).lastUsedAt).not.toBeNull();
      // The scan sees every write the run's finalization makes.
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      await expectTokenNowhere(pool.token);
    }, 60_000);

    it("keeps the account it started with when the binding moves while it runs; the next run uses the new account", async () => {
      const companyId = await company();
      const ownerId = await owner(companyId);
      const first = await account(ownerId, "Max 1");
      const second = await account(ownerId, "Max 2");
      const worker = await agent(companyId);
      await bind(worker, first.id);
      const task = await issue(companyId, worker.id);
      heartbeat = heartbeatService(db);
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      script(worker.id, async (input) => {
        await released;
        return finishTask(input);
      });

      const run = await assign(worker.id, task.id);
      await waitFor(async () => invocations.length === 1);
      const moved = await aiAccountPoolService(db, { deploymentMode: "authenticated" }).setBinding(
        {
          actor: { type: "board", userId: ownerId, memberships: [{ companyId, membershipRole: "owner", status: "active" }] },
          audit: { actorType: "user", actorId: ownerId },
        },
        worker.id,
        { mode: "pool_account", accountId: second.id },
      );
      expect(moved).toMatchObject({ appliesFrom: "next_run", runningRunIds: [run.id] });
      // The running run is not touched: same attribution, same slot.
      expect((await runRow(run.id)).contextSnapshot).toMatchObject({ aiConnection: { accountId: first.id } });
      expect(await db.select({ accountId: aiAccountRunSlots.accountId }).from(aiAccountRunSlots).where(eq(aiAccountRunSlots.runId, run.id)))
        .toEqual([{ accountId: first.id }]);
      release();
      expect(await finishedRun(run.id)).toMatchObject({ status: "succeeded" });
      expect(invocations[0]!.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(first.token);
      expect((await runRow(run.id)).contextSnapshot).toMatchObject({ aiConnection: { accountId: first.id } });

      const next = await issue(companyId, worker.id);
      const nextRun = await assign(worker.id, next.id);
      expect(await finishedRun(nextRun.id)).toMatchObject({ status: "succeeded" });
      expect(invocations[1]).toMatchObject({ runId: nextRun.id, env: { CLAUDE_CODE_OAUTH_TOKEN: second.token } });
      expect((await runRow(nextRun.id)).contextSnapshot).toMatchObject({ aiConnection: { accountId: second.id } });
    }, 60_000);
  });

  describe("a usage limit", () => {
    it("with an estimated reset: one probe attempt per interval, one notice per task and one PM summary without an issue", async () => {
      const companyId = await company();
      const ownerId = await owner(companyId);
      const pool = await account(ownerId, "Max E");
      const pm = await agent(companyId, { name: "Planner" });
      const worker = await agent(companyId, { name: "Builder", reportsTo: pm.id });
      await bind(worker, pool.id);
      const first = await issue(companyId, worker.id, { createdByAgentId: pm.id });
      const second = await issue(companyId, worker.id, { createdByAgentId: pm.id });
      heartbeat = heartbeatService(db);
      const workerCalls = () => invocations.filter((call) => call.agentId === worker.id);
      // The first run and the first probe hit the limit; the second probe goes through.
      script(worker.id, usageLimit(), usageLimit(), finishTask);

      const run = await assign(worker.id, first.id);
      const limited = await finishedRun(run.id);
      expect(limited).toMatchObject({ status: "failed", errorCode: "provider_quota" });
      const firstWait = await successorOf(run.id);
      expect(firstWait).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: "ai_account_wait" });
      expect(firstWait.contextSnapshot).toMatchObject({
        resourceWait: { kind: "ai_account", reason: "usage_limit", accountId: pool.id, resumeAtSource: "estimated" },
      });
      let state = await accountRow(pool.id);
      expect(state).toMatchObject({ limitStrikes: 1, limitSource: "estimated", limitProbeRunId: null });
      expect(state.exhaustedUntil!.getTime() - state.lastLimitedAt!.getTime()).toBe(HOUR);
      await drainHeartbeatRunsToQuiescence(db, heartbeat);

      // A second task of the agent waits for the same limit without a provider attempt.
      const secondRun = await assign(worker.id, second.id);
      const secondDeferred = await finishedRun(secondRun.id);
      expect(secondDeferred).toMatchObject({ status: "cancelled", errorCode: "ai_account_unavailable" });
      const secondWait = await successorOf(secondRun.id);
      expect(secondWait).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: "ai_account_wait" });
      expect(workerCalls()).toHaveLength(1);

      // Scheduler ticks before the reset make no attempt.
      for (const minutes of [6, 12, 30]) {
        await tick(new Date(Date.now() + minutes * 60_000));
        expect(workerCalls()).toHaveLength(1);
      }
      const firstEpisode = await episodeOf(first.id);

      // Interval 1: exactly one waiting run probes the account, and fails.
      await limitResets(companyId, pool.id);
      await tick();
      expect(workerCalls()).toHaveLength(2);
      state = await accountRow(pool.id);
      expect(state).toMatchObject({ limitStrikes: 2, limitSource: "estimated" });
      expect(state.exhaustedUntil!.getTime() - state.lastLimitedAt!.getTime()).toBe(2 * HOUR);
      // The failed probe kept its task's episode (same start), so nothing is announced again.
      expect(await episodeOf(first.id)).toMatchObject({ id: firstEpisode.id, resolvedAt: null });
      expect((await episodeOf(first.id)).since.toISOString()).toBe(firstEpisode.since.toISOString());

      // Interval 2: again one probe; this time the provider serves it, which ends the limit for every waiter.
      await limitResets(companyId, pool.id);
      await tick();
      expect(workerCalls()).toHaveLength(3);
      state = await accountRow(pool.id);
      expect(state).toMatchObject({ limitStrikes: 0, exhaustedUntil: null, limitEpisodeStartedAt: null, limitProbeRunId: null });
      // The second task's wait was woken (staggered by up to 2 minutes) and now runs.
      await tick(new Date(Date.now() + 3 * 60_000));
      expect(workerCalls()).toHaveLength(4);
      expect(workerCalls().every((call) => call.env.CLAUDE_CODE_OAUTH_TOKEN === pool.token)).toBe(true);
      expect((await db.select().from(issues).where(eq(issues.companyId, companyId))).map((row) => row.status).sort())
        .toEqual(["done", "done"]);

      // One limit notice per task, then one "started after waiting" each.
      for (const task of [first, second]) {
        const notices = await systemNotices(task.id);
        expect(notices.filter((notice) => notice.body.includes("usage limit reached"))).toHaveLength(1);
        expect(notices.filter((notice) => notice.body.startsWith("Started after waiting"))).toHaveLength(1);
        expect(await episodeOf(task.id)).toMatchObject({ resolution: "resolved" });
      }
      const limitEntries = await db.select().from(activityLog).where(eq(activityLog.action, "ai_account.limit_reached"));
      expect(limitEntries).toHaveLength(1);

      // The PM heard about it once, with no issue on the wake, and its run shows the notice.
      const pmWakes = await db.select().from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.agentId, pm.id), eq(agentWakeupRequests.reason, "resource_wait_notice")));
      expect(pmWakes).toHaveLength(1);
      expect(pmWakes[0]!.payload ?? {}).not.toHaveProperty("issueId");
      const pmCalls = invocations.filter((call) => call.agentId === pm.id);
      expect(pmCalls).toHaveLength(1);
      expect(pmCalls[0]!.context).not.toHaveProperty("issueId");
      expect(pmCalls[0]!.context).toMatchObject({
        wakeReason: "resource_wait_notice",
        resourceWaitNotice: { kind: "ai_account", reason: "usage_limit", resourceLabel: "Max E", issueIds: [first.id] },
      });
      // `resourceWait` stays a lane run's own wait.
      expect(pmCalls[0]!.context).not.toHaveProperty("resourceWait");
      expect(String(pmCalls[0]!.context.paperclipTaskMarkdown)).toContain("Paperclip resource wait notice:");
      expect(String(pmCalls[0]!.context.paperclipTaskMarkdown)).toContain(`the Claude account "Max E" (usage limit)`);
    }, 120_000);

    it("reaches a PM whose own turn is running: the summary waits for a run of its own, and a later wake merged into that run keeps it", async () => {
      const companyId = await company();
      const ownerId = await owner(companyId);
      const pool = await account(ownerId, "Max N");
      const pm = await agent(companyId, {
        name: "Planner",
        runtimeConfig: { heartbeat: { enabled: true, intervalSec: 86_400, wakeOnDemand: true, maxConcurrentRuns: 1 } },
      });
      const worker = await agent(companyId, { name: "Builder", reportsTo: pm.id });
      await bind(worker, pool.id);
      const task = await issue(companyId, worker.id, { createdByAgentId: pm.id });
      heartbeat = heartbeatService(db);
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      // The PM's timer turn (no issue) runs until the test lets it finish.
      script(pm.id, async (input) => {
        await released;
        return finishTask(input);
      });
      script(worker.id, usageLimit());
      const timerWake = () => heartbeat!.wakeup(pm.id, {
        source: "timer",
        triggerDetail: "system",
        reason: "heartbeat_timer",
        requestedByActorType: "system",
        requestedByActorId: "heartbeat_scheduler",
        contextSnapshot: { source: "scheduler", reason: "interval_elapsed" },
      });

      const turn = await timerWake();
      expect(turn).not.toBeNull();
      await waitFor(async () => invocations.some((call) => call.runId === turn!.id));

      // The worker hits its limit while the PM's turn runs.
      const run = await assign(worker.id, task.id);
      expect(await finishedRun(run.id)).toMatchObject({ status: "failed", errorCode: "provider_quota" });
      await successorOf(run.id);
      const summaryRun = await waitFor(async () => {
        const [row] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, pm.id), eq(heartbeatRuns.status, "queued")));
        return row ?? null;
      });
      expect(summaryRun.id).not.toBe(turn!.id);
      expect(summaryRun.contextSnapshot).toMatchObject({
        wakeReason: "resource_wait_notice",
        resourceWaitNotice: { kind: "ai_account", reason: "usage_limit", resourceLabel: "Max N", issueIds: [task.id] },
      });
      // The running turn took nothing in.
      expect((await runRow(turn!.id)).contextSnapshot).not.toHaveProperty("resourceWaitNotice");

      // The next timer wake joins the queued summary run and takes over its wake reason; the summary stays.
      const merged = await timerWake();
      expect(merged?.id).toBe(summaryRun.id);
      expect((await runRow(summaryRun.id)).contextSnapshot).toMatchObject({ wakeReason: "heartbeat_timer", resourceWaitNotice: { issueIds: [task.id] } });

      release();
      expect(await finishedRun(turn!.id)).toMatchObject({ status: "succeeded" });
      expect(await finishedRun(summaryRun.id)).toMatchObject({ status: "succeeded" });
      const turnCall = invocations.find((call) => call.runId === turn!.id)!;
      const summaryCall = invocations.find((call) => call.runId === summaryRun.id)!;
      expect(String(turnCall.context.paperclipTaskMarkdown ?? "")).not.toContain("Paperclip resource wait notice:");
      expect(summaryCall.context).not.toHaveProperty("issueId");
      expect(String(summaryCall.context.paperclipTaskMarkdown)).toContain("Paperclip resource wait notice:");
      expect(String(summaryCall.context.paperclipTaskMarkdown)).toContain(`the Claude account "Max N" (usage limit)`);
      const pmWakes = await db.select().from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.agentId, pm.id), eq(agentWakeupRequests.reason, "resource_wait_notice")));
      expect(pmWakes).toHaveLength(1);
    }, 60_000);

    it("never moves the task to another account of the owner (P7): it waits for its own account's reset", async () => {
      const companyId = await company();
      const ownerId = await owner(companyId);
      const limitedAccount = await account(ownerId, "Max P");
      const spare = await account(ownerId, "Max Spare");
      const worker = await agent(companyId);
      await bind(worker, limitedAccount.id);
      const task = await issue(companyId, worker.id);
      const other = await issue(companyId, worker.id);
      heartbeat = heartbeatService(db);
      const reset = new Date(Date.now() + 2 * HOUR);
      script(worker.id, usageLimit(reset));

      const run = await assign(worker.id, task.id);
      expect(await finishedRun(run.id)).toMatchObject({ status: "failed", errorCode: "provider_quota" });
      const wait = await successorOf(run.id);
      expect(wait).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: "ai_account_wait" });
      expect(wait.contextSnapshot).toMatchObject({
        resourceWait: { kind: "ai_account", reason: "usage_limit", accountId: limitedAccount.id, resumeAtSource: "provider" },
      });
      expect(await accountRow(limitedAccount.id)).toMatchObject({ limitSource: "provider", exhaustedUntil: reset });
      await drainHeartbeatRunsToQuiescence(db, heartbeat);

      // Another task of the agent waits for the same account too.
      const otherRun = await assign(worker.id, other.id);
      expect(await finishedRun(otherRun.id)).toMatchObject({ status: "cancelled", errorCode: "ai_account_unavailable" });
      expect((await successorOf(otherRun.id)).contextSnapshot).toMatchObject({ resourceWait: { accountId: limitedAccount.id } });

      // Ticks and "Check now" before the reset change nothing.
      for (const minutes of [6, 30, 90]) await tick(new Date(Date.now() + minutes * 60_000));
      const refused = await heartbeat.retryScheduledRetryNow({ issueId: task.id }).then(() => null, (error: unknown) => error);
      expect(refused).toMatchObject({ status: 409, details: { code: "resource_still_unavailable", resourceWait: { accountId: limitedAccount.id } } });
      expect(invocations).toHaveLength(1);

      // The spare account was never selected, charged or used.
      expect(await accountRow(spare.id)).toMatchObject({ lastSelectedAt: null, lastUsedAt: null, exhaustedUntil: null, limitStrikes: 0 });
      expect(await db.select().from(aiAccountRunSlots).where(eq(aiAccountRunSlots.accountId, spare.id))).toHaveLength(0);
      const charged = await db.execute(sql`select id from heartbeat_runs where context_snapshot -> 'aiConnection' ->> 'accountId' = ${spare.id}`);
      expect(charged).toHaveLength(0);

      // After the reset the tasks run on their own account.
      await limitResets(companyId, limitedAccount.id);
      await tick();
      await tick(new Date(Date.now() + 3 * 60_000));
      expect(invocations.length).toBeGreaterThanOrEqual(2);
      expect(invocations.every((call) => call.env.CLAUDE_CODE_OAUTH_TOKEN === limitedAccount.token)).toBe(true);
      expect(invocations.some((call) => call.env.CLAUDE_CODE_OAUTH_TOKEN === spare.token)).toBe(false);
    }, 120_000);
  });

  describe("a sign-in failure", () => {
    it("follows the two-strike rule: an untyped failure only waits for this run, a second on another run signs the account out, a typed 401 at once", async () => {
      const companyId = await company();
      const ownerId = await owner(companyId);
      const pool = await account(ownerId, "Max S");
      const worker = await agent(companyId);
      await bind(worker, pool.id);
      const task = await issue(companyId, worker.id);
      heartbeat = heartbeatService(db);
      script(worker.id, signInFailure(), signInFailure());
      const before = await accountRow(pool.id);

      const run = await assign(worker.id, task.id);
      expect(await finishedRun(run.id)).toMatchObject({ status: "failed", errorCode: "claude_auth_required" });
      const unconfirmed = await successorOf(run.id);
      expect(unconfirmed).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: "ai_account_wait" });
      expect(unconfirmed.contextSnapshot).toMatchObject({ resourceWait: { kind: "ai_account", reason: "auth_unconfirmed", accountId: pool.id } });
      // First strike: the account itself is unchanged.
      let state = await accountRow(pool.id);
      expect(state).toMatchObject({ status: "active", authSuspectRunId: run.id });
      expect(state.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
      expect(await systemNotices(task.id)).toHaveLength(0);
      await drainHeartbeatRunsToQuiescence(db, heartbeat);

      // The run-scoped check ends after 10 minutes: one more attempt, which fails too.
      await db.update(resourceWaitEpisodes).set({ resumeAt: new Date(Date.now() - 1_000) }).where(eq(resourceWaitEpisodes.issueId, task.id));
      await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(Date.now() - 1_000) }).where(eq(heartbeatRuns.id, unconfirmed.id));
      await tick();
      expect(await runRow(unconfirmed.id)).toMatchObject({ status: "failed", errorCode: "claude_auth_required" });
      state = await accountRow(pool.id);
      expect(state).toMatchObject({ status: "auth_failed", authSuspectAt: null, authSuspectRunId: null });
      expect(state.statusMessage).not.toContain(pool.token);
      const signedOut = await successorOf(unconfirmed.id);
      expect(signedOut.contextSnapshot).toMatchObject({ resourceWait: { kind: "ai_account", reason: "signed_out", accountId: pool.id } });
      const notices = await systemNotices(task.id);
      expect(notices).toHaveLength(1);
      expect(notices[0]!.body).toContain("it is signed out");
      expect(await db.select().from(activityLog).where(eq(activityLog.action, "ai_account.signed_out"))).toHaveLength(1);
      // It waits for the owner; nothing more is attempted.
      await tick(new Date(Date.now() + 6 * 60_000));
      expect(invocations).toHaveLength(2);

      // A typed 401 signs the account out at once.
      const typedAccount = await account(ownerId, "Max T");
      const typedWorker = await agent(companyId);
      await bind(typedWorker, typedAccount.id);
      const typedTask = await issue(companyId, typedWorker.id);
      script(typedWorker.id, signInFailure(true));
      const typedRun = await assign(typedWorker.id, typedTask.id);
      expect(await finishedRun(typedRun.id)).toMatchObject({ status: "failed", errorCode: "claude_auth_required" });
      // The run's row turns failed before its finalization marks the account; the
      // wait is scheduled after that write, so the account is read once it exists.
      expect((await successorOf(typedRun.id)).contextSnapshot).toMatchObject({ resourceWait: { reason: "signed_out", accountId: typedAccount.id } });
      expect(await accountRow(typedAccount.id)).toMatchObject({ status: "auth_failed" });
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      await expectTokenNowhere(pool.token);
    }, 120_000);
  });

  describe("a failing pool handler", () => {
    /** The run's finalization went on: the agent left running, and the finished run no longer holds its task. */
    async function expectFinalized(run: RunRow, worker: AgentRow, taskId: string) {
      await drainHeartbeatRunsToQuiescence(db, heartbeat!);
      const [agentRow] = await db.select({ status: agents.status }).from(agents).where(eq(agents.id, worker.id));
      expect(agentRow?.status).not.toBe("running");
      const [task] = await db.select({ executionRunId: issues.executionRunId }).from(issues).where(eq(issues.id, taskId));
      expect(task?.executionRunId).not.toBe(run.id);
    }

    it("never stops the run's finalization after a usage limit", async () => {
      const companyId = await company();
      const ownerId = await owner(companyId);
      const pool = await account(ownerId, "Max F");
      const worker = await agent(companyId);
      await bind(worker, pool.id);
      const task = await issue(companyId, worker.id);
      heartbeat = heartbeatService(db);
      script(worker.id, usageLimit());
      poolFaults.handleProviderLimit = new Error("limit handler fault");

      const run = await assign(worker.id, task.id);
      const finished = await finishedRun(run.id);
      expect(finished).toMatchObject({ status: "failed", errorCode: "provider_quota" });
      await expectFinalized(finished, worker, task.id);
      expect(logLines.some((line) => line.includes("failed to handle a pool account limit"))).toBe(true);
      // Nothing moved the task to another account.
      expect(invocations.every((call) => call.env.CLAUDE_CODE_OAUTH_TOKEN === pool.token)).toBe(true);
    }, 60_000);

    it("never stops the run's finalization after a sign-in failure", async () => {
      const companyId = await company();
      const ownerId = await owner(companyId);
      const pool = await account(ownerId, "Max G");
      const worker = await agent(companyId);
      await bind(worker, pool.id);
      const task = await issue(companyId, worker.id);
      heartbeat = heartbeatService(db);
      script(worker.id, signInFailure(true));
      poolFaults.handleRunAuthFailure = new Error("sign-in handler fault");

      const run = await assign(worker.id, task.id);
      const finished = await finishedRun(run.id);
      expect(finished).toMatchObject({ status: "failed", errorCode: "claude_auth_required" });
      await expectFinalized(finished, worker, task.id);
      expect(logLines.some((line) => line.includes("failed to handle a pool sign-in failure"))).toBe(true);
    }, 60_000);
  });

  // Fork: spec 15.5 and P7. A legacy company-pool agent is pinned to one pool
  // account; when that account is limited, its run waits for that reset.
  describe("a legacy company-pool agent", () => {
    it("waits for the reset of its own pool account, and says so", async () => {
      const companyId = await company();
      const ownerId = await owner(companyId);
      const connections = aiConnectionService(db);
      const shared = (name: string) => connections.save(
        companyId,
        ownerId,
        { provider: "anthropic", method: "subscription", ownership: "shared", name, loginSessionId: "fixture", allAgents: true, agentIds: [] },
        `sk-ant-oat01-${randomUUID().replaceAll("-", "")}`,
      );
      const first = await shared("Max one");
      const second = await shared("Max two");
      await aiConnectionPoolService(db).replace(companyId, ownerId, { provider: "anthropic", members: [first, second] });
      const reset = new Date(Date.now() + 2 * HOUR);
      await aiConnectionPoolService(db).markExhausted({ companyId, connectionId: first.connectionId, until: reset, reason: "provider_quota", source: "run_failure" });
      const worker = await agent(companyId, {
        runtimeConfig: {
          heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
          aiConnection: { provider: "anthropic", method: "subscription", mode: "company_pool" },
        },
      });
      // The pool's accounts serve on behalf of the task's responsible user, a member here.
      const task = await issue(companyId, worker.id, { responsibleUserId: ownerId });
      heartbeat = heartbeatService(db);

      const run = await assign(worker.id, task.id);
      expect(await finishedRun(run.id)).toMatchObject({ status: "cancelled" });
      const successor = await successorOf(run.id);
      expect(successor).toMatchObject({ status: "scheduled_retry" });
      expect(Math.abs(successor.scheduledRetryAt!.getTime() - reset.getTime())).toBeLessThan(60_000);
      const messages = (await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id))).map((event) => event.message);
      expect(messages).toContain(
        `This agent's account in the company AI pool is at its usage limit. Paperclip never moves a task to another account; this task resumes at ${reset.toISOString()}.`,
      );
      expect(messages.join("\n")).not.toContain("Every account");
      // No provider work ran, on this account or the pool's other one.
      expect(invocations).toHaveLength(0);
    }, 60_000);
  });
});
