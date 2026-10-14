import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { eq, sql } from "drizzle-orm";
import request from "supertest";
import {
  activityLog,
  agents,
  aiAccountHostEnvironments,
  aiAccountHosts,
  aiAccounts,
  companies,
  companyMemberships,
  costEvents,
  createDb,
  environments,
  heartbeatRuns,
  projects,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";

const { aiAccountHostService, pickBalancedAccount, pickAccountForRun, isCreditBalanceFailure } = await import("../services/ai-account-hosts.js");
const { aiAccountHostRoutes } = await import("../routes/ai-account-hosts.js");
const { errorHandler } = await import("../middleware/error-handler.js");
const { isAiConnectionPoolExhausted, aiConnectionPoolRetryAt } = await import("../services/ai-connection-pool.js");
const { heartbeatService } = await import("../services/heartbeat.js");

const sub = (n: number) => `sk-ant-oat01-${"a".repeat(30)}${n}`;
const key = (n: number) => `sk-ant-api03-${"b".repeat(30)}${n}`;
const now = new Date("2026-10-14T12:00:00.000Z");
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

describe("pickBalancedAccount", () => {
  const base = { poolEnabled: true, status: "active" as const, exhaustedUntil: null, lastSelectedAt: null, createdAt: at(-60) };
  it("prefers the account with the fewest running runs, then the least recently picked", () => {
    const accounts = [
      { ...base, id: "a", lastSelectedAt: at(-1) },
      { ...base, id: "b", lastSelectedAt: at(-5) },
      { ...base, id: "c", lastSelectedAt: at(-10) },
    ];
    expect(pickBalancedAccount(accounts, new Map([["c", 2], ["b", 1]]), now).account?.id).toBe("a");
    expect(pickBalancedAccount(accounts, new Map(), now).account?.id).toBe("c");
  });

  it("skips switched-off, signed-out and limited accounts and reports the earliest reset", () => {
    const accounts = [
      { ...base, id: "off", poolEnabled: false },
      { ...base, id: "signed-out", status: "auth_failed" as const },
      { ...base, id: "later", exhaustedUntil: at(90) },
      { ...base, id: "sooner", exhaustedUntil: at(30) },
    ];
    const choice = pickBalancedAccount(accounts, new Map(), now);
    expect(choice.account).toBeNull();
    expect(choice.limitedUntil?.toISOString()).toBe(at(30).toISOString());
    expect(choice.usable).toBe(2);
  });

  it("treats a passed limit as available again", () => {
    const choice = pickBalancedAccount([{ ...base, id: "rested", exhaustedUntil: at(-1) }], new Map(), now);
    expect(choice.account?.id).toBe("rested");
  });
});

describe("pickAccountForRun", () => {
  const base = { poolEnabled: true, status: "active" as const, exhaustedUntil: null, lastSelectedAt: null, createdAt: at(-60) };
  const vpn = "project-vpn";
  const arc = "project-arc";
  const accounts = [
    { ...base, id: "m" },
    { ...base, id: "y" },
    { ...base, id: "t" },
  ];
  const reservations = new Map([["m", new Set([vpn])], ["y", new Set([arc])]]);
  const pick = (projectId: string | null, overrides: Partial<Parameters<typeof pickAccountForRun>[0]> = {}) =>
    pickAccountForRun({ accounts, reservations, projectId, overflow: true, running: new Map(), now, ...overrides });

  it("uses the project's own account first, and shared accounts for other runs", () => {
    expect(pick(vpn)).toMatchObject({ account: { id: "m" }, scope: "project" });
    expect(pick(arc)).toMatchObject({ account: { id: "y" }, scope: "project" });
    expect(pick("project-without-account")).toMatchObject({ account: { id: "t" }, scope: "shared" });
    expect(pick(null)).toMatchObject({ account: { id: "t" }, scope: "shared" });
  });

  it("moves on to shared, then another project's account, when the project's own accounts rest", () => {
    const limited = accounts.map((a) => (a.id === "m" ? { ...a, exhaustedUntil: at(30) } : a));
    expect(pick(vpn, { accounts: limited })).toMatchObject({ account: { id: "t" }, scope: "shared" });
    const onlyOthers = limited.map((a) => (a.id === "t" ? { ...a, exhaustedUntil: at(45) } : a));
    expect(pick(vpn, { accounts: onlyOthers })).toMatchObject({ account: { id: "y" }, scope: "overflow" });
  });

  it("waits for the project's own reset when the host does not allow overflow", () => {
    const limited = accounts.map((a) => (a.id === "m" ? { ...a, exhaustedUntil: at(30) } : a));
    const choice = pick(vpn, { accounts: limited, overflow: false });
    expect(choice.account).toBeNull();
    expect(choice.limitedUntil?.toISOString()).toBe(at(30).toISOString());
    expect(pick(null, { overflow: false, accounts: accounts.filter((a) => a.id !== "t") }).account).toBeNull();
  });
});

describe("isCreditBalanceFailure", () => {
  it("recognizes the API credit message only", () => {
    expect(isCreditBalanceFailure("Credit balance is too low to access the Anthropic API")).toBe(true);
    expect(isCreditBalanceFailure("You've hit your limit · resets 4pm (UTC)")).toBe(false);
    expect(isCreditBalanceFailure(null)).toBe(false);
  });
});

describe("host AI account pools (database)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const companyId = randomUUID();
  const agentId = randomUUID();
  let localEnvId: string;
  let sshEnvId: string;
  let sandboxEnvId: string;

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-hosts-tests-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "ai-hosts-fixture");
    database = await startEmbeddedPostgresTestDatabase("paperclip-ai-hosts-db-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Hosts company", issuePrefix: "HST", defaultResponsibleUserId: "admin" });
    await db.insert(companyMemberships).values({ companyId, principalId: "admin", principalType: "user", status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Builder", adapterType: "claude_local" });
    const [existingLocal] = await db.select().from(environments).where(eq(environments.driver, "local"));
    const [local] = existingLocal ? [existingLocal] : await db.insert(environments).values({ name: "Local", driver: "local" }).returning();
    const [ssh] = await db.insert(environments).values({ name: "runner: one", driver: "ssh" }).returning();
    const [sandbox] = await db.insert(environments).values({ name: "Mac sandbox", driver: "sandbox" }).returning();
    localEnvId = local!.id;
    sshEnvId = ssh!.id;
    sandboxEnvId = sandbox!.id;
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await database?.cleanup();
    await rm(home, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db.execute(sql`truncate table heartbeat_runs, cost_events cascade`);
    await db.delete(aiAccounts);
    await db.delete(aiAccountHostEnvironments);
    await db.delete(aiAccountHosts);
    await db.delete(activityLog);
  });

  it("limits a host to three accounts and a credential or email to one host", async () => {
    const svc = aiAccountHostService(db);
    const server = await svc.createHost({ name: "Server", kind: "server" }, "admin");
    const runner = await svc.createHost({ name: "Runner", kind: "ssh_host" }, "admin");
    for (const n of [1, 2, 3]) {
      await svc.addAccount(server.id, { label: `S${n}`, credentialType: "subscription", value: sub(n) }, "admin");
    }
    await expect(svc.addAccount(server.id, { label: "S4", credentialType: "subscription", value: sub(4) }, "admin"))
      .rejects.toMatchObject({ status: 409 });
    await expect(svc.addAccount(runner.id, { label: "copy", credentialType: "subscription", value: sub(1) }, "admin"))
      .rejects.toMatchObject({ status: 409 });
    await svc.addAccount(runner.id, { label: "R1", emailHint: "one@example.com", credentialType: "api_key", value: key(1) }, "admin");
    await expect(svc.addAccount(runner.id, { label: "R2", emailHint: "ONE@example.com", credentialType: "api_key", value: key(2) }, "admin"))
      .rejects.toMatchObject({ status: 409 });
  });

  it("rejects a credential of the wrong kind", async () => {
    const svc = aiAccountHostService(db);
    const host = await svc.createHost({ name: "Server", kind: "server" }, "admin");
    await expect(svc.addAccount(host.id, { label: "x", credentialType: "subscription", value: key(1) }, "admin"))
      .rejects.toMatchObject({ status: 422 });
  });

  it("maps only environments the host kind can run, and moves an environment between hosts", async () => {
    const svc = aiAccountHostService(db);
    const server = await svc.createHost({ name: "Server", kind: "server" }, "admin");
    const runner = await svc.createHost({ name: "Runner", kind: "ssh_host" }, "admin");
    await expect(svc.setEnvironments(server.id, [sshEnvId])).rejects.toMatchObject({ status: 422 });
    await expect(svc.setEnvironments(runner.id, [sandboxEnvId])).rejects.toMatchObject({ status: 422 });
    await svc.setEnvironments(server.id, [localEnvId]);
    await svc.setEnvironments(runner.id, [sshEnvId]);
    const mac = await svc.createHost({ name: "Mac over SSH", kind: "mac" }, "admin");
    await svc.setEnvironments(mac.id, [sshEnvId]);
    const listed = await svc.list();
    expect(listed.hosts.find((host) => host.id === runner.id)?.environments).toEqual([]);
    expect(listed.hosts.find((host) => host.id === mac.id)?.environments.map((e) => e.id)).toEqual([sshEnvId]);
    const unmapped = listed.unmappedEnvironments.map((e) => e.id);
    expect(unmapped).toContain(sandboxEnvId);
    expect(unmapped).not.toContain(localEnvId);
    expect(unmapped).not.toContain(sshEnvId);
  });

  it("serves a run only on a mapped host with a pool account, never on Mac Fleet sandboxes", async () => {
    const svc = aiAccountHostService(db);
    const server = await svc.createHost({ name: "Server", kind: "server" }, "admin");
    await svc.setEnvironments(server.id, [localEnvId]);
    expect(await svc.poolHostForEnvironment({ id: localEnvId, driver: "local" })).toBeNull();
    await svc.addAccount(server.id, { label: "S", credentialType: "subscription", value: sub(1), poolEnabled: false }, "admin");
    expect(await svc.poolHostForEnvironment({ id: localEnvId, driver: "local" })).toBeNull();
    const [account] = await db.select().from(aiAccounts);
    await svc.updateAccount(account!.id, { poolEnabled: true });
    expect((await svc.poolHostForEnvironment({ id: localEnvId, driver: "local" }))?.id).toBe(server.id);
    expect(await svc.poolHostForEnvironment({ id: sandboxEnvId, driver: "sandbox" })).toBeNull();
    expect(await svc.poolHostForEnvironment(null)).toBeNull();
  });

  it("spreads runs across accounts, decrypts the chosen credential and rests a limited account", async () => {
    const svc = aiAccountHostService(db);
    const host = await svc.createHost({ name: "Runner", kind: "ssh_host" }, "admin");
    const { account: first } = await svc.addAccount(host.id, { label: "M", credentialType: "subscription", value: sub(1) }, "admin");
    const { account: second } = await svc.addAccount(host.id, { label: "Y", credentialType: "api_key", value: key(2) }, "admin");
    expect(first.credentialMaterial).not.toHaveProperty("value");
    expect(JSON.stringify(first.credentialMaterial)).not.toContain(sub(1));

    const one = await svc.selectForRun({ host, runId: randomUUID(), now: at(0) });
    const two = await svc.selectForRun({ host, runId: randomUUID(), now: at(1) });
    expect(new Set([one.account.id, two.account.id])).toEqual(new Set([first.id, second.id]));
    const byId = new Map([[one.account.id, one], [two.account.id, two]]);
    expect(byId.get(first.id)?.value).toBe(sub(1));
    expect(byId.get(first.id)?.envKey).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(byId.get(second.id)?.value).toBe(key(2));
    expect(byId.get(second.id)?.envKey).toBe("ANTHROPIC_API_KEY");
    expect(one.attribution).toMatchObject({ mode: "host_pool", hostId: host.id, hostName: "Runner" });

    await svc.markLimited({ accountId: first.id, until: at(120), reason: "provider_quota", runId: null });
    await svc.markLimited({ accountId: first.id, until: at(30), reason: "provider_quota", runId: null });
    const [rested] = await db.select().from(aiAccounts).where(eq(aiAccounts.id, first.id));
    expect(rested!.exhaustedUntil?.toISOString()).toBe(at(120).toISOString());
    for (let i = 0; i < 3; i += 1) {
      expect((await svc.selectForRun({ host, runId: randomUUID(), now: at(2 + i) })).account.id).toBe(second.id);
    }

    await svc.markLimited({ accountId: second.id, until: at(60), reason: "credit_balance", runId: null });
    const error = await svc.selectForRun({ host, runId: randomUUID(), now: at(10) }).catch((e: unknown) => e);
    expect(isAiConnectionPoolExhausted(error)).toBe(true);
    expect(aiConnectionPoolRetryAt(error as never)?.toISOString()).toBe(at(60).toISOString());
    expect(await svc.hasAvailableAccount(host.id, at(10))).toBe(false);
    expect(await svc.hasAvailableAccount(host.id, at(61))).toBe(true);
  });

  it("reserves accounts for projects across companies and serves each project its own account", async () => {
    const svc = aiAccountHostService(db);
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Other company", issuePrefix: "OTH" }).onConflictDoNothing();
    const [vpn] = await db.insert(projects).values({ companyId, name: "VPN Platform" }).returning();
    const [arc] = await db.insert(projects).values({ companyId: otherCompanyId, name: "Arch AI" }).returning();
    const host = await svc.createHost({ name: "Runner", kind: "ssh_host" }, "admin");
    const { account: m } = await svc.addAccount(host.id, { label: "M", credentialType: "subscription", value: sub(1) }, "admin");
    const { account: y } = await svc.addAccount(host.id, { label: "Y", credentialType: "subscription", value: sub(2) }, "admin");
    const { account: t } = await svc.addAccount(host.id, { label: "T", credentialType: "subscription", value: sub(3) }, "admin");
    await svc.setAccountProjects(m.id, [vpn!.id]);
    await svc.setAccountProjects(y.id, [arc!.id]);
    await expect(svc.setAccountProjects(t.id, [randomUUID()])).rejects.toMatchObject({ status: 422 });
    for (let i = 0; i < 3; i += 1) {
      expect((await svc.selectForRun({ host, runId: randomUUID(), projectId: vpn!.id, now: at(i) })).account.id).toBe(m.id);
      expect((await svc.selectForRun({ host, runId: randomUUID(), projectId: arc!.id, now: at(i) })).account.id).toBe(y.id);
      expect((await svc.selectForRun({ host, runId: randomUUID(), projectId: null, now: at(i) })).account.id).toBe(t.id);
    }
    const listed = await svc.list();
    const accountsById = new Map(listed.hosts[0]!.accounts.map((account) => [account.id, account]));
    expect(accountsById.get(m.id)?.projects).toEqual([expect.objectContaining({ id: vpn!.id, name: "VPN Platform", companyName: "Hosts company", issuePrefix: "HST" })]);
    expect(accountsById.get(t.id)?.projects).toEqual([]);
    expect(listed.projects.map((project) => project.id)).toEqual(expect.arrayContaining([vpn!.id, arc!.id]));

    await svc.markLimited({ accountId: m.id, until: at(120), reason: "provider_quota", runId: null });
    const borrowed = await svc.selectForRun({ host, runId: randomUUID(), projectId: vpn!.id, now: at(5) });
    expect(borrowed.account.id).toBe(t.id);
    expect(borrowed.attribution.scope).toBe("shared");
    await svc.updateHost(host.id, { overflowToOtherAccounts: false });
    const refreshed = await svc.getHost(host.id);
    const waiting = await svc.selectForRun({ host: refreshed, runId: randomUUID(), projectId: vpn!.id, now: at(6) }).catch((e: unknown) => e);
    expect(isAiConnectionPoolExhausted(waiting)).toBe(true);
    await svc.setAccountProjects(m.id, []);
    expect((await svc.list()).hosts[0]!.accounts.find((account) => account.id === m.id)?.projects).toEqual([]);
  });

  it("reports Paperclip's own use of each account per window and the last limit", async () => {
    const svc = aiAccountHostService(db);
    const host = await svc.createHost({ name: "Server", kind: "server" }, "admin");
    const { account } = await svc.addAccount(host.id, { label: "S", credentialType: "api_key", value: key(7) }, "admin");
    const realNow = Date.now();
    const hoursAgo = (hours: number) => new Date(realNow - hours * 60 * 60 * 1000);
    const runAt = async (when: Date, input: number, output: number, cents: number) => {
      const id = randomUUID();
      await db.insert(heartbeatRuns).values({
        id, companyId, agentId, invocationSource: "assignment", status: "succeeded", finishedAt: when,
        contextSnapshot: { aiConnection: { mode: "host_pool", accountId: account.id, hostId: host.id } },
      });
      await db.insert(costEvents).values({
        companyId, agentId, heartbeatRunId: id, provider: "anthropic", model: "claude-opus-5-5",
        inputTokens: input, cachedInputTokens: input * 10, outputTokens: output, costCents: cents, occurredAt: when,
      });
    };
    await runAt(hoursAgo(1), 1000, 100, 50);
    await runAt(hoursAgo(2), 2000, 200, 70);
    await runAt(hoursAgo(30), 4000, 400, 90);
    await runAt(hoursAgo(24 * 9), 8000, 800, 110);
    await svc.markLimited({ accountId: account.id, until: at(60), reason: "credit_balance", runId: null });
    const listed = (await svc.list()).hosts[0]!.accounts[0]!;
    expect(listed.usage.lastFiveHours).toEqual({ runs: 2, inputTokens: 3000, cachedInputTokens: 30000, outputTokens: 300, costCents: 120 });
    expect(listed.usage.lastSevenDays).toMatchObject({ runs: 3, inputTokens: 7000, outputTokens: 700, costCents: 210 });
    expect(listed.lastLimitedAt).not.toBeNull();
    expect(listed.limitReason).toBe("credit_balance");
  });

  it("takes a signed-out account out of the pool until it is set active again", async () => {
    const svc = aiAccountHostService(db);
    const host = await svc.createHost({ name: "Server", kind: "server" }, "admin");
    const { account } = await svc.addAccount(host.id, { label: "S", credentialType: "subscription", value: sub(1) }, "admin");
    await svc.markAuthFailed({ accountId: account.id, message: "Invalid bearer token" });
    const error = await svc.selectForRun({ host, runId: randomUUID(), now }).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 422, details: { code: "ai_account_host_unavailable" } });
    await svc.updateAccount(account.id, { status: "active" });
    expect((await svc.selectForRun({ host, runId: randomUUID(), now })).account.id).toBe(account.id);
  });

  it("imports the server's own token without returning it", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", sub(9));
    const svc = aiAccountHostService(db);
    const host = await svc.createHost({ name: "Server", kind: "server" }, "admin");
    const { account } = await svc.addAccount(host.id, { label: "S", credentialType: "subscription", importFrom: { kind: "server_env" } }, "admin");
    expect(account.credentialHint).toBe(`…${sub(9).slice(-4)}`);
    expect((await svc.selectForRun({ host, runId: randomUUID(), now })).value).toBe(sub(9));
    vi.unstubAllEnvs();
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "ai-hosts-fixture");
  });

  describe("usage-limit failover", () => {
    async function setup() {
      const svc = aiAccountHostService(db);
      const host = await svc.createHost({ name: "Runner", kind: "ssh_host" }, "admin");
      const { account: first } = await svc.addAccount(host.id, { label: "M", credentialType: "subscription", value: sub(1) }, "admin");
      const { account: second } = await svc.addAccount(host.id, { label: "Y", credentialType: "api_key", value: key(2) }, "admin");
      return { svc, host, first, second };
    }
    async function failedRun(input: { hostId: string; accountId: string; error?: string; errorCode?: string; retryNotBefore?: string; failovers?: number }) {
      const id = randomUUID();
      await db.insert(heartbeatRuns).values({
        id,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "failed",
        error: input.error ?? "You've hit your session limit",
        errorCode: input.errorCode ?? "provider_quota",
        finishedAt: new Date(),
        resultJson: {
          executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
          errorFamily: "provider_quota",
          ...(input.retryNotBefore ? { retryNotBefore: input.retryNotBefore, providerQuotaRetryNotBefore: input.retryNotBefore } : {}),
        },
        contextSnapshot: {
          wakeReason: "issue_assigned",
          aiConnection: { mode: "host_pool", provider: "anthropic", method: "subscription", accountId: input.accountId, accountName: "M", hostId: input.hostId, hostName: "Runner" },
          ...(input.failovers ? { aiConnectionFailovers: input.failovers } : {}),
        },
      });
      return id;
    }

    it("rests the account until its reset and retries at once on the host's other account", async () => {
      const { svc, host, first, second } = await setup();
      const reset = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
      const runId = await failedRun({ hostId: host.id, accountId: first.id, retryNotBefore: reset });
      expect(await heartbeatService(db).scheduleAiConnectionPoolFailover(runId)).toBe(true);
      const [rested] = await db.select().from(aiAccounts).where(eq(aiAccounts.id, first.id));
      expect(rested).toMatchObject({ limitReason: "provider_quota", limitRunId: runId });
      expect(rested!.exhaustedUntil?.toISOString()).toBe(reset);
      const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
      expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: "ai_connection_failover" });
      expect(retry!.contextSnapshot).toMatchObject({ aiConnectionFailovers: 1 });
      expect((await svc.selectForRun({ host, runId: randomUUID() })).account.id).toBe(second.id);
      const logged = await db.select().from(activityLog).where(eq(activityLog.action, "ai_account.limit_reached"));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({ companyId, entityId: first.id, runId });
    });

    it("rests an API key without credit for a day", async () => {
      const { host, second } = await setup();
      const before = Date.now();
      const runId = await failedRun({ hostId: host.id, accountId: second.id, error: "Credit balance is too low to access the Anthropic API" });
      expect(await heartbeatService(db).scheduleAiConnectionPoolFailover(runId)).toBe(true);
      const [rested] = await db.select().from(aiAccounts).where(eq(aiAccounts.id, second.id));
      expect(rested!.limitReason).toBe("credit_balance");
      const hours = (rested!.exhaustedUntil!.getTime() - before) / 3_600_000;
      expect(hours).toBeGreaterThanOrEqual(23.9);
      expect(hours).toBeLessThanOrEqual(24.1);
    });

    it("stops moving after twice the host's account count", async () => {
      const { host, first } = await setup();
      const runId = await failedRun({ hostId: host.id, accountId: first.id, failovers: 4 });
      expect(await heartbeatService(db).scheduleAiConnectionPoolFailover(runId)).toBe(false);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId))).toHaveLength(0);
    });
  });

  describe("routes", () => {
    function appFor(actor: Record<string, unknown>) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as unknown as { actor: unknown }).actor = actor;
        next();
      });
      app.use("/api", aiAccountHostRoutes(db));
      app.use(errorHandler);
      return app;
    }
    const admin = { type: "board", source: "session", userId: "admin", isInstanceAdmin: true, companyIds: [companyId] };
    const member = { type: "board", source: "session", userId: "member", isInstanceAdmin: false, companyIds: [companyId] };

    it("is for instance admins only and never returns a credential", async () => {
      await request(appFor(member)).get("/api/instance/ai-hosts").expect(403);
      await request(appFor({ type: "agent", agentId, companyId })).get("/api/instance/ai-hosts").expect(403);
      const app = appFor(admin);
      const host = (await request(app).post("/api/instance/ai-hosts").send({ name: "Server", kind: "server" }).expect(201)).body;
      await request(app).put(`/api/instance/ai-hosts/${host.id}/environments`).send({ environmentIds: [localEnvId] }).expect(200);
      const created = await request(app).post(`/api/instance/ai-hosts/${host.id}/accounts`)
        .send({ label: "S", credentialType: "subscription", value: sub(5) }).expect(201);
      expect(JSON.stringify(created.body)).not.toContain(sub(5));
      const listed = await request(app).get("/api/instance/ai-hosts").expect(200);
      expect(JSON.stringify(listed.body)).not.toContain(sub(5));
      expect(listed.body.hosts[0].accounts[0]).toMatchObject({ label: "S", credentialType: "subscription", status: "active", poolEnabled: true });
      expect(listed.body.maxAccountsPerHost).toBe(3);
      await request(app).post(`/api/instance/ai-hosts/${host.id}/accounts`)
        .send({ label: "bad", credentialType: "subscription" }).expect(400);
      const logged = await db.select().from(activityLog);
      expect(logged.map((row) => row.action)).toEqual(expect.arrayContaining(["ai_account_host.created", "ai_account.created"]));
      expect(JSON.stringify(logged)).not.toContain(sub(5));
    });
  });
});
