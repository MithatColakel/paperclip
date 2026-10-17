import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import {
  agents,
  aiConnectionQuotaStates,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  toolConnections,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";

const fetchClaudeQuota = vi.hoisted(() => vi.fn());
vi.mock("@paperclipai/adapter-claude-local/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@paperclipai/adapter-claude-local/server")>()),
  fetchClaudeQuota,
}));

const { aiConnectionService } = await import("../services/ai-connections.js");
const { prepareManagedAiRuntime } = await import("../services/ai-connection-runtime.js");
const { aiConnectionPoolService, isAiConnectionPoolExhausted, aiConnectionPoolRetryAt } = await import("../services/ai-connection-pool.js");

/**
 * Fork: spec 15.5 and P7. A `company_pool` agent stays on the member it used
 * last (or the first member while it has used none), waits for that member's
 * own reset when it is limited, and never moves to another member. Usage
 * readings never drive the choice.
 */
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
const companyId = randomUUID();
const agentId = randomUUID();
const otherAgentId = randomUUID();
const userId = "pool-owner";
const binding = { provider: "anthropic", method: "subscription", mode: "company_pool" } as const;
const input = { companyId, agentId, userId, adapterType: "claude_local", model: "claude-opus-5-5", binding };
type Account = { connectionId: string; grantId: string };
let accounts: Record<"first" | "second" | "third", Account>;

const now = new Date("2026-10-17T12:00:00.000Z");
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

async function setPool(...names: Array<keyof typeof accounts>) {
  await aiConnectionPoolService(db).replace(companyId, userId, { provider: "anthropic", members: names.map((name) => accounts[name]) });
}

/** A started run of `agent` that used `account` through the company pool. */
async function usedPool(account: Account, startedAt: Date, agent = agentId) {
  await db.insert(heartbeatRuns).values({
    companyId,
    agentId: agent,
    invocationSource: "assignment",
    status: "succeeded",
    startedAt,
    finishedAt: startedAt,
    contextSnapshot: { aiConnection: { mode: "company_pool", provider: "anthropic", method: "subscription", ...account, poolPriority: 0 } },
  });
}

type SelectInput = Parameters<ReturnType<typeof aiConnectionService>["select"]>[0];

async function selectedConnection(overrides: Partial<SelectInput> = {}) {
  return (await aiConnectionService(db).select({ ...input, now, ...overrides })).attribution.connectionId;
}

beforeAll(async () => {
  home = await mkdtemp(path.join(process.env.PAPERCLIP_HOME ?? os.tmpdir(), "paperclip-ai-pool-pinned-"));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "ai-pool-pinned-fixture");
  database = await startEmbeddedPostgresTestDatabase("paperclip-ai-pool-pinned-db-");
  db = createDb(database.connectionString);
  await db.insert(companies).values({ id: companyId, name: "Pinned pool company", issuePrefix: "PIN" });
  await db.insert(agents).values([
    { id: agentId, companyId, name: "Builder", adapterType: "claude_local" },
    { id: otherAgentId, companyId, name: "Reviewer", adapterType: "claude_local" },
  ]);
  await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "owner" });
  const service = aiConnectionService(db);
  const subscription = (name: string, token: string) =>
    service.save(companyId, userId, { provider: "anthropic", method: "subscription", ownership: "shared", name, loginSessionId: "fixture", allAgents: true, agentIds: [] }, token);
  accounts = {
    first: await subscription("Max one", "token-first"),
    second: await subscription("Max two", "token-second"),
    third: await subscription("Max three", "token-third"),
  };
}, 90_000);

afterAll(async () => {
  await database?.cleanup();
  vi.unstubAllEnvs();
  if (home) await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  fetchClaudeQuota.mockReset();
  fetchClaudeQuota.mockResolvedValue([]);
  await db.execute(sql`truncate table heartbeat_runs cascade`);
  await db.delete(aiConnectionQuotaStates);
  await db.update(toolConnections).set({ enabled: true }).where(eq(toolConnections.companyId, companyId));
  await setPool("first", "second", "third");
});

describe("pinned company pool", () => {
  it("starts an agent that has used no pool account on the first member", async () => {
    const selected = await aiConnectionService(db).select({ ...input, now });
    expect(selected.attribution).toMatchObject({ connectionId: accounts.first.connectionId, mode: "company_pool", poolPriority: 0 });
  });

  it("keeps the member this agent used last, whatever the pool order", async () => {
    await usedPool(accounts.first, at(-120));
    await usedPool(accounts.second, at(-60));
    // A run that never started used nothing, and another agent's runs never move this one.
    await db.insert(heartbeatRuns).values({
      companyId, agentId, invocationSource: "assignment", status: "queued",
      contextSnapshot: { aiConnection: { mode: "company_pool", provider: "anthropic", ...accounts.third } },
    });
    await usedPool(accounts.third, at(-1), otherAgentId);
    expect(await selectedConnection()).toBe(accounts.second.connectionId);
    await setPool("third", "first", "second");
    expect((await aiConnectionService(db).select({ ...input, now })).attribution)
      .toMatchObject({ connectionId: accounts.second.connectionId, poolPriority: 2 });
    expect(await selectedConnection({ agentId: otherAgentId })).toBe(accounts.third.connectionId);
  });

  it("waits for its own member's reset when that member is limited, and never moves to another member", async () => {
    await usedPool(accounts.second, at(-30));
    await aiConnectionPoolService(db).markExhausted({ companyId, connectionId: accounts.second.connectionId, until: at(90), reason: "provider_quota", source: "run_failure" });
    // An earlier reset elsewhere in the pool changes nothing: the wait is for this member.
    await aiConnectionPoolService(db).markExhausted({ companyId, connectionId: accounts.third.connectionId, until: at(10), reason: "provider_quota", source: "run_failure" });
    const error = await aiConnectionService(db).select({ ...input, now }).catch((e: unknown) => e);
    expect(isAiConnectionPoolExhausted(error)).toBe(true);
    expect(aiConnectionPoolRetryAt(error as never)?.toISOString()).toBe(at(90).toISOString());
    expect((await aiConnectionPoolService(db).hasAvailableMember(companyId, "anthropic", now))).toBe(true);
    // Still waiting just before the reset, back on the same member after it.
    await expect(aiConnectionService(db).select({ ...input, now: at(89) })).rejects.toMatchObject({ details: { code: "ai_connection_pool_exhausted" } });
    expect(await selectedConnection({ now: at(91) })).toBe(accounts.second.connectionId);
  });

  it("never waits for a mark the retired usage probe left; a limit a run meets holds for its own reset", async () => {
    await usedPool(accounts.second, at(-30));
    // An older release's usage probe marked the account at 95 % of its weekly window, until the reset days away.
    await aiConnectionPoolService(db).markExhausted({ companyId, connectionId: accounts.second.connectionId, until: at(5 * 24 * 60), reason: "usage_threshold", source: "usage_probe" });
    expect(await selectedConnection()).toBe(accounts.second.connectionId);
    // The account then really hits its limit: the run waits for that reset, which the old mark never extends.
    await aiConnectionPoolService(db).markExhausted({ companyId, connectionId: accounts.second.connectionId, until: at(90), reason: "provider_quota", source: "run_failure" });
    const error = await aiConnectionService(db).select({ ...input, now }).catch((e: unknown) => e);
    expect(isAiConnectionPoolExhausted(error)).toBe(true);
    expect(aiConnectionPoolRetryAt(error as never)?.toISOString()).toBe(at(90).toISOString());
    expect(await selectedConnection({ now: at(91) })).toBe(accounts.second.connectionId);
  });

  it("fails on its own member when that account cannot serve the agent, instead of moving on", async () => {
    await usedPool(accounts.second, at(-30));
    await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, accounts.second.connectionId));
    await expect(aiConnectionService(db).select({ ...input, now })).rejects.toMatchObject({
      status: 422,
      details: { code: "ai_connection_unavailable", connectionId: accounts.second.connectionId },
    });
  });

  it("takes the first member when the account it used last left the pool", async () => {
    await usedPool(accounts.second, at(-30));
    await setPool("third", "first");
    expect(await selectedConnection()).toBe(accounts.third.connectionId);
  });

  it("never reads usage to choose: an account near its limit is still used and nothing is marked", async () => {
    fetchClaudeQuota.mockResolvedValue([
      { label: "Current session", usedPercent: 99, resetsAt: at(45).toISOString(), valueLabel: null, detail: null },
      { label: "Current week (all models)", usedPercent: 98, resetsAt: at(5000).toISOString(), valueLabel: null, detail: null },
    ]);
    expect(await selectedConnection()).toBe(accounts.first.connectionId);
    expect(await selectedConnection({ probeUsage: true, now: at(10) })).toBe(accounts.first.connectionId);
    expect(fetchClaudeQuota).not.toHaveBeenCalled();
    expect(await db.select().from(aiConnectionQuotaStates)).toHaveLength(0);
  });

  it("re-validates only the account a preparation already chose", async () => {
    await usedPool(accounts.first, at(-30));
    expect(await selectedConnection({ pinnedGrantId: accounts.third.grantId })).toBe(accounts.third.connectionId);
    await expect(aiConnectionService(db).select({ ...input, now, pinnedGrantId: randomUUID() }))
      .rejects.toMatchObject({ details: { code: "ai_connection_unavailable" } });
  });

  it("injects only the pinned account into a run, and refuses with that account's reset while it is limited", async () => {
    await usedPool(accounts.second, new Date(Date.now() - 60_000));
    const prepare = () => prepareManagedAiRuntime(db, {
      companyId, agentId, responsibleUserId: userId, adapterType: "claude_local", binding,
      config: { model: "claude-opus-5-5", env: { CLAUDE_CODE_OAUTH_TOKEN: "ambient" } },
    });
    const runtime = await prepare();
    try {
      expect(runtime.attribution).toMatchObject({ connectionId: accounts.second.connectionId, mode: "company_pool", poolPriority: 1 });
      expect((runtime.config.env as Record<string, string>).CLAUDE_CODE_OAUTH_TOKEN).toBe("token-second");
    } finally {
      await runtime.cleanup();
    }
    const reset = new Date(Date.now() + 2 * 60 * 60_000);
    await aiConnectionPoolService(db).markExhausted({ companyId, connectionId: accounts.second.connectionId, until: reset, reason: "provider_quota", source: "run_failure" });
    const error = await prepare().catch((e: unknown) => e);
    expect(isAiConnectionPoolExhausted(error)).toBe(true);
    expect(aiConnectionPoolRetryAt(error as never)?.toISOString()).toBe(reset.toISOString());
  });
});
