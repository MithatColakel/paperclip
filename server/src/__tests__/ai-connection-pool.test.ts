import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import {
  createDb,
  companies,
  agents,
  companyMemberships,
  aiConnectionPoolMembers,
  aiConnectionQuotaStates,
  activityLog,
  heartbeatRuns,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { aiConnectionBindingSchema, isAiConnectionCompatible } from "@paperclipai/shared";

const fetchClaudeQuota = vi.hoisted(() => vi.fn());
vi.mock("@paperclipai/adapter-claude-local/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@paperclipai/adapter-claude-local/server")>()),
  fetchClaudeQuota,
}));

const { aiConnectionService } = await import("../services/ai-connections.js");
const { prepareManagedAiRuntime } = await import("../services/ai-connection-runtime.js");
const { aiConnectionRoutes } = await import("../routes/ai-connections.js");
const { errorHandler } = await import("../middleware/error-handler.js");
const { heartbeatService } = await import("../services/heartbeat.js");
const {
  aiConnectionPoolService,
  claudeUsageToPoolWindows,
  usageBlockedUntil,
  isAiConnectionPoolExhausted,
  aiConnectionPoolRetryAt,
} = await import("../services/ai-connection-pool.js");

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
const companyId = randomUUID();
const otherCompanyId = randomUUID();
const agentId = randomUUID();
const userId = "pool-owner";
const binding = { provider: "anthropic", method: "subscription", mode: "company_pool" } as const;
const input = { companyId, agentId, userId, adapterType: "claude_local", model: "claude-opus-5-5", binding };
let accounts: Record<"first" | "second" | "api" | "foreign", { connectionId: string; grantId: string }>;

const now = new Date("2026-10-05T12:00:00.000Z");
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

async function setPool(...names: Array<keyof typeof accounts>) {
  await aiConnectionPoolService(db).replace(companyId, userId, {
    provider: "anthropic",
    members: names.map((name) => accounts[name]),
  });
}

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-pool-tests-"));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "ai-pool-fixture");
  database = await startEmbeddedPostgresTestDatabase("paperclip-ai-pool-db-");
  db = createDb(database.connectionString);
  await db.insert(companies).values([
    { id: companyId, name: "Pool company", issuePrefix: "POL" },
    { id: otherCompanyId, name: "Other company", issuePrefix: "POO" },
  ]);
  await db.insert(agents).values({ id: agentId, companyId, name: "Builder", adapterType: "claude_local" });
  await db.insert(companyMemberships).values([
    { companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "owner" },
    { companyId, principalId: "pool-member", principalType: "user", status: "active", membershipRole: "member" },
    { companyId: otherCompanyId, principalId: userId, principalType: "user", status: "active", membershipRole: "owner" },
  ]);
  const service = aiConnectionService(db);
  const subscription = (company: string, name: string, token: string) =>
    service.save(company, userId, { provider: "anthropic", method: "subscription", ownership: "shared", name, loginSessionId: "fixture", allAgents: true, agentIds: [] }, token);
  accounts = {
    first: await subscription(companyId, "Max one", "token-first"),
    second: await subscription(companyId, "Max two", "token-second"),
    api: await service.save(companyId, userId, { provider: "anthropic", method: "api_key", ownership: "shared", name: "API fallback", apiKey: "fixture", allAgents: true, agentIds: [] }, "key-api"),
    foreign: await subscription(otherCompanyId, "Other company Max", "token-foreign"),
  };
}, 90000);

afterAll(async () => {
  await database?.cleanup();
  vi.unstubAllEnvs();
  if (home) await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  fetchClaudeQuota.mockReset();
  fetchClaudeQuota.mockResolvedValue([]);
  await db.delete(aiConnectionQuotaStates);
  await setPool("first", "second", "api");
});

describe("company AI account pool", () => {
  it("accepts the company_pool binding for any Claude method", () => {
    expect(aiConnectionBindingSchema.parse(binding)).toEqual(binding);
    expect(isAiConnectionCompatible({ ...binding, method: "api_key" }, "claude_local")).toBe(true);
    expect(isAiConnectionCompatible(binding, "codex_local")).toBe(false);
  });

  // Fork: P7. The pool is pinned (spec 15.5); ai-connection-pool-pinned.test.ts covers the pin itself.
  it("uses the first account and waits for its reset instead of moving down the list", async () => {
    const service = aiConnectionService(db);
    const pool = aiConnectionPoolService(db);
    expect((await service.select({ ...input, now })).attribution).toMatchObject({ connectionId: accounts.first.connectionId, mode: "company_pool", poolPriority: 0 });
    await pool.markExhausted({ companyId, connectionId: accounts.first.connectionId, until: at(60), reason: "provider_quota", source: "run_failure" });
    const error = await service.select({ ...input, now }).catch((e: unknown) => e);
    expect(isAiConnectionPoolExhausted(error)).toBe(true);
    expect(aiConnectionPoolRetryAt(error as never)?.toISOString()).toBe(at(60).toISOString());
    expect((await service.select({ ...input, now: at(61) })).attribution.connectionId).toBe(accounts.first.connectionId);
  });

  it("keeps the later reset when a shorter estimate arrives", async () => {
    const pool = aiConnectionPoolService(db);
    await pool.markExhausted({ companyId, connectionId: accounts.first.connectionId, until: at(300), reason: "provider_quota", source: "run_failure" });
    await pool.markExhausted({ companyId, connectionId: accounts.first.connectionId, until: at(60), reason: "provider_quota", source: "run_failure" });
    const [state] = await db.select().from(aiConnectionQuotaStates).where(eq(aiConnectionQuotaStates.connectionId, accounts.first.connectionId));
    expect(state.exhaustedUntil?.toISOString()).toBe(at(300).toISOString());
  });

  it("reports its own account's reset when every account is limited, not the earliest one", async () => {
    const pool = aiConnectionPoolService(db);
    await pool.markExhausted({ companyId, connectionId: accounts.first.connectionId, until: at(120), reason: "provider_quota", source: "run_failure" });
    await pool.markExhausted({ companyId, connectionId: accounts.second.connectionId, until: at(30), reason: "provider_quota", source: "run_failure" });
    await pool.markExhausted({ companyId, connectionId: accounts.api.connectionId, until: at(90), reason: "provider_quota", source: "run_failure" });
    const error = await aiConnectionService(db).select({ ...input, now }).catch((e: unknown) => e);
    expect(isAiConnectionPoolExhausted(error)).toBe(true);
    expect(aiConnectionPoolRetryAt(error as never)?.toISOString()).toBe(at(120).toISOString());
    expect(await pool.hasAvailableMember(companyId, "anthropic", now)).toBe(false);
    expect(await pool.hasAvailableMember(companyId, "anthropic", at(31))).toBe(true);
    await expect(aiConnectionService(db).select({ ...input, now: at(31) })).rejects.toMatchObject({ details: { code: "ai_connection_pool_exhausted" } });
  });

  it("never reads provider usage before a run, for subscriptions or API keys", async () => {
    fetchClaudeQuota.mockResolvedValue([
      { label: "Current session", usedPercent: 97, resetsAt: at(45).toISOString(), valueLabel: null, detail: null },
    ]);
    const service = aiConnectionService(db);
    expect((await service.select({ ...input, now })).attribution.connectionId).toBe(accounts.first.connectionId);
    await setPool("api");
    expect((await service.select({ ...input, now: at(10) })).attribution).toMatchObject({ connectionId: accounts.api.connectionId, method: "api_key" });
    expect(fetchClaudeQuota).not.toHaveBeenCalled();
    expect(await db.select().from(aiConnectionQuotaStates)).toHaveLength(0);
  });

  it("injects only the selected pool account into the run, and none while it is limited", async () => {
    const prepare = () => prepareManagedAiRuntime(db, { companyId, agentId, responsibleUserId: userId, adapterType: "claude_local", binding, config: { model: "claude-opus-5-5", env: { CLAUDE_CODE_OAUTH_TOKEN: "ambient" } } });
    const runtime = await prepare();
    try {
      expect(runtime.attribution).toMatchObject({ connectionId: accounts.first.connectionId, mode: "company_pool", poolPriority: 0 });
      expect((runtime.config.env as Record<string, string>).CLAUDE_CODE_OAUTH_TOKEN).toBe("token-first");
    } finally {
      await runtime.cleanup();
    }
    await aiConnectionPoolService(db).markExhausted({ companyId, connectionId: accounts.first.connectionId, until: at(60 * 24 * 365), reason: "provider_quota", source: "run_failure" });
    expect(isAiConnectionPoolExhausted(await prepare().catch((e: unknown) => e))).toBe(true);
  });

  it("keeps every pool inside its own company", async () => {
    await expect(aiConnectionPoolService(db).replace(companyId, userId, { provider: "anthropic", members: [accounts.foreign] }))
      .rejects.toMatchObject({ status: 422 });
    await expect(db.insert(aiConnectionPoolMembers).values({ companyId, provider: "anthropic", ...accounts.foreign, priority: 9 }))
      .rejects.toThrow();
    const summary = await aiConnectionPoolService(db).summary(companyId, "anthropic");
    expect(summary.members.map((m) => m.connectionId)).toEqual([accounts.first.connectionId, accounts.second.connectionId, accounts.api.connectionId]);
    expect(summary.candidates.some((c) => c.connectionId === accounts.foreign.connectionId)).toBe(false);
  });

  it("maps provider usage windows and applies the threshold per model", () => {
    const windows = claudeUsageToPoolWindows([
      { label: "Current session", usedPercent: 20, resetsAt: at(30).toISOString() },
      { label: "Current week (Opus only)", usedPercent: 96, resetsAt: at(900).toISOString() },
      { label: "Extra usage", usedPercent: 99, resetsAt: null },
    ]);
    expect(windows.map((w) => w.key)).toEqual(["five_hour", "seven_day_opus"]);
    expect(usageBlockedUntil(windows, "claude-opus-5-5", now)?.toISOString()).toBe(at(900).toISOString());
    expect(usageBlockedUntil(windows, "claude-sonnet-5-5", now)).toBeNull();
    expect(usageBlockedUntil([{ key: "five_hour", usedPercent: 99, resetsAt: null }], null, now)?.toISOString()).toBe(at(60).toISOString());
  });

  it("lets only connection managers reorder the pool or clear a limit, and logs both", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const role = String(req.headers["x-test-role"] ?? "owner");
      req.actor = { type: "board", source: "session", userId: String(req.headers["x-test-user"] ?? userId), companyIds: [companyId], memberships: [{ companyId, membershipRole: role, status: "active" }] } as never;
      next();
    });
    app.use("/api", aiConnectionRoutes(db));
    app.use(errorHandler);
    const base = `/api/companies/${companyId}/ai-connections/pool`;
    const body = { provider: "anthropic", members: [accounts.second, accounts.first] };
    expect((await request(app).get(base)).body.members).toHaveLength(3);
    expect((await request(app).get(`/api/companies/${otherCompanyId}/ai-connections/pool`)).status).toBe(403);
    expect((await request(app).put(base).set("x-test-role", "viewer").send(body)).status).toBe(403);
    expect((await request(app).put(base).set("x-test-user", "pool-member").set("x-test-role", "member").send(body)).status).toBe(403);
    const updated = await request(app).put(base).send(body);
    expect(updated.status).toBe(200);
    expect(updated.body.members.map((m: { connectionId: string }) => m.connectionId)).toEqual([accounts.second.connectionId, accounts.first.connectionId]);
    expect((await request(app).put(base).send({ provider: "anthropic", members: [accounts.first, accounts.first] })).status).toBe(400);
    await aiConnectionPoolService(db).markExhausted({ companyId, connectionId: accounts.first.connectionId, until: at(60 * 24 * 365), reason: "provider_quota", source: "run_failure" });
    expect((await request(app).post(`${base}/${accounts.first.connectionId}/clear-limit`)).status).toBe(200);
    const [state] = await db.select().from(aiConnectionQuotaStates).where(eq(aiConnectionQuotaStates.connectionId, accounts.first.connectionId));
    expect(state).toMatchObject({ exhaustedUntil: null, source: "manual" });
    const actions = (await db.select({ action: activityLog.action }).from(activityLog).where(eq(activityLog.companyId, companyId))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["ai_connection.pool_updated", "ai_connection.pool_limit_cleared"]));
  });

  // Fork: P7 removed the usage-limit failover. A limited member is marked until
  // its reset and the task waits in the company-pool lane for that reset;
  // nothing moves it to another account.
  describe("usage-limit wait", () => {
    async function failedPoolRun(input: { connectionId: string; failovers?: number; errorCode?: string; retryNotBefore?: string | null }) {
      const id = randomUUID();
      await db.insert(heartbeatRuns).values({
        id,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "failed",
        error: "You've hit your session limit",
        errorCode: input.errorCode ?? "provider_quota",
        finishedAt: new Date(),
        resultJson: {
          executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
          errorFamily: "provider_quota",
          ...(input.retryNotBefore ? { retryNotBefore: input.retryNotBefore, providerQuotaRetryNotBefore: input.retryNotBefore } : {}),
        },
        contextSnapshot: {
          wakeReason: "issue_assigned",
          aiConnection: { connectionId: input.connectionId, provider: "anthropic", mode: "company_pool", poolPriority: 0 },
          // A task that moved between accounts before the failover was removed.
          ...(input.failovers ? { aiConnectionFailovers: input.failovers } : {}),
        },
      });
      return id;
    }

    it("marks the account limited until its reset and waits for that reset without spending the failure budget", async () => {
      const reset = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
      const runId = await failedPoolRun({ connectionId: accounts.first.connectionId, retryNotBefore: reset });
      expect(await heartbeatService(db).handleProviderLimit(runId)).toMatchObject({ handled: true, via: "company_pool" });
      const [state] = await db.select().from(aiConnectionQuotaStates).where(eq(aiConnectionQuotaStates.connectionId, accounts.first.connectionId));
      expect(state).toMatchObject({ reason: "provider_quota", source: "run_failure", lastRunId: runId });
      expect(state.exhaustedUntil?.toISOString()).toBe(reset);
      const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
      expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: "ai_connection_pool_wait" });
      // Due at the member's reset plus at most 120 s of per-run spread, never at once.
      expect(retry.scheduledRetryAt!.getTime()).toBeGreaterThanOrEqual(Date.parse(reset));
      expect(retry.scheduledRetryAt!.getTime()).toBeLessThanOrEqual(Date.parse(reset) + 121_000);
      expect(retry.contextSnapshot).toMatchObject({ failureRetriesBeforeAiConnectionWait: 0 });
      expect(retry.contextSnapshot).not.toHaveProperty("aiConnectionFailovers");
      expect(await db.select().from(activityLog).where(eq(activityLog.entityId, accounts.first.connectionId)))
        .toEqual(expect.arrayContaining([expect.objectContaining({ action: "ai_connection.pool_limit_reached", runId })]));
    });

    it("falls back to a 60 minute limit without a provider reset time", async () => {
      const runId = await failedPoolRun({ connectionId: accounts.second.connectionId });
      const before = Date.now();
      expect(await heartbeatService(db).handleProviderLimit(runId)).toMatchObject({ handled: true });
      const [state] = await db.select().from(aiConnectionQuotaStates).where(eq(aiConnectionQuotaStates.connectionId, accounts.second.connectionId));
      const minutes = (state.exhaustedUntil!.getTime() - before) / 60_000;
      expect(minutes).toBeGreaterThanOrEqual(59.9);
      expect(minutes).toBeLessThanOrEqual(60.5);
    });

    it("waits on its own account however often the task moved before, and leaves other failures to the bounded retry", async () => {
      const moved = await failedPoolRun({ connectionId: accounts.first.connectionId, failovers: 6 });
      expect(await heartbeatService(db).handleProviderLimit(moved)).toMatchObject({ handled: true });
      const retries = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, moved));
      expect(retries.map((retry) => retry.scheduledRetryReason)).toEqual(["ai_connection_pool_wait"]);
      const overloaded = await failedPoolRun({ connectionId: accounts.first.connectionId, errorCode: "claude_transient_upstream" });
      await db.update(heartbeatRuns).set({ resultJson: { errorFamily: "transient_upstream" } }).where(eq(heartbeatRuns.id, overloaded));
      expect(await heartbeatService(db).handleProviderLimit(overloaded)).toMatchObject({ handled: false, reason: "not_a_limit" });
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, overloaded))).toHaveLength(0);
    });
  });
});
