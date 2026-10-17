import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate as migrateLegacy } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  aiAccountAgentBindings,
  aiAccountHostEnvironments,
  aiAccountHosts,
  aiAccountProjects,
  aiAccounts,
  applyPendingMigrations,
  authUsers,
  closeRegisteredClients,
  companies,
  companyMemberships,
  createDb,
  deferredDataMigrations,
  ensurePostgresDatabase,
  environments,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import { AI_ACCOUNT_BINDING_MIGRATION_KEY } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { aiAccountPoolMigrationRoutes } from "../routes/ai-account-pool-migration.js";
import {
  aiAccountMigrationGoNoGo,
  previewPlan,
  readAiAccountMigrationReport,
  runDeferredAiAccountMigration,
  type AiAccountMigrationOptions,
} from "../services/ai-account-pool-migration.js";
import { aiConnectionPoolService } from "../services/ai-connection-pool.js";
import { aiConnectionService } from "../services/ai-connections.js";

// Fork: the Claude account binding backfill (spec 15.3, D7), its report and
// go/no-go, and the read-only pre-deploy report SQL (spec 15.1).

type Actor = Express.Request["actor"];

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const reportPath = new URL("../../../scripts/ai-account-pool-report.sql", import.meta.url);
const reportSql = await readFile(reportPath, "utf8");

/** The report's statements, comments removed. */
function reportStatements(text: string): string[] {
  const code = text.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
  return code.split(/;\s*(?:\n|$)/).map((statement) => statement.trim()).filter(Boolean);
}

/** Runs the report over one connection, as psql would, and returns each statement's rows. */
async function runReport(url: string): Promise<Array<Array<Record<string, unknown>>>> {
  const client = drizzle({ connection: { url, max: 1, onnotice: () => {} } });
  try {
    const results: Array<Array<Record<string, unknown>>> = [];
    for (const statement of reportStatements(reportSql)) {
      results.push([...(await client.$client.unsafe(statement))] as Array<Record<string, unknown>>);
    }
    return results;
  } finally {
    await client.$client.end();
  }
}

function sectionRows(results: Array<Array<Record<string, unknown>>>, prefix: string): Array<Record<string, unknown>> {
  return results.flat().filter((row) => typeof row.section === "string" && row.section.startsWith(prefix));
}

describe("pre-deploy report SQL (spec 15.1)", () => {
  it("is one read-only transaction of SELECT statements", () => {
    const statements = reportStatements(reportSql);
    expect(statements[0]).toBe("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    expect(statements.at(-1)).toBe("ROLLBACK");
    for (const statement of statements.slice(1, -1)) expect(statement).toMatch(/^(SELECT|WITH)\s/);
    const code = reportStatements(reportSql).join("\n");
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|CALL|COMMIT|VACUUM|LOCK)\b/i);
    expect(code).not.toMatch(/credential_material/);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping embedded Postgres account migration job tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

describeEmbeddedPostgres("Claude account binding backfill (spec 15.3)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let localEnvironment: typeof environments.$inferSelect;
  const actors: Record<string, Actor> = {};

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "c".repeat(64));
    database = await startEmbeddedPostgresTestDatabase("paperclip-ai-account-migration-job-");
    db = createDb(database.connectionString);
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await database?.cleanup();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate table companies, plugins, ai_account_hosts, ai_accounts, environments, deferred_data_migrations, "user" cascade`);
    [localEnvironment] = await db.insert(environments).values({ name: "Local", driver: "local" }).returning();
    for (const name of Object.keys(actors)) delete actors[name];
  });

  const tag = () => randomUUID().slice(0, 8);

  async function company(name = `Company ${tag()}`) {
    const id = randomUUID();
    await db.insert(companies).values({ id, name, issuePrefix: `C${id.replaceAll("-", "").slice(0, 7).toUpperCase()}` });
    return id;
  }

  async function user(id: string) {
    const at = new Date();
    await db.insert(authUsers).values({ id, name: `User ${id}`, email: `${id}@example.com`, emailVerified: true, createdAt: at, updatedAt: at });
    return id;
  }

  async function member(companyId: string, userId: string, membershipRole = "operator") {
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole });
  }

  async function agent(companyId: string, overrides: Partial<typeof agents.$inferInsert> = {}) {
    const [row] = await db.insert(agents).values({ companyId, name: `Agent ${tag()}`, adapterType: "claude_local", ...overrides }).returning();
    return row!;
  }

  async function host(name: string, kind: "server" | "ssh_host" = "server") {
    const [row] = await db.insert(aiAccountHosts).values({ name, kind }).returning();
    return row!;
  }

  async function mapHost(hostId: string, environmentId: string) {
    await db.insert(aiAccountHostEnvironments).values({ hostId, environmentId });
  }

  async function sshEnvironment() {
    const [row] = await db.insert(environments).values({ name: `ssh ${tag()}`, driver: "ssh", config: { host: `${tag()}.example.com`, port: 22, username: "runner" } }).returning();
    return row!;
  }

  /** An account as the host pool left it: owned by its creator, on a legacy host. */
  async function account(ownerUserId: string | null, overrides: Partial<typeof aiAccounts.$inferInsert> = {}) {
    const [row] = await db.insert(aiAccounts).values({
      credentialType: "subscription",
      label: `Account ${tag()}`,
      ownerUserId,
      createdByUserId: ownerUserId,
      origin: "legacy_host_pool",
      credentialMaterial: { scheme: "local_encrypted_v1", ciphertext: `cipher-${tag()}` },
      credentialFingerprint: randomUUID(),
      ...overrides,
    }).returning();
    return row!;
  }

  async function project(companyId: string, name = `Project ${tag()}`) {
    const [row] = await db.insert(projects).values({ companyId, name }).returning();
    return row!.id;
  }

  async function issue(companyId: string, projectId: string) {
    const [row] = await db.insert(issues).values({ companyId, projectId, title: `Task ${tag()}` }).returning();
    return row!.id;
  }

  async function reserve(accountId: string, projectId: string) {
    await db.insert(aiAccountProjects).values({ accountId, projectId });
  }

  /** Host-pool runs of the previous image: the attribution `selectForRun` wrote. */
  async function hostPoolRuns(
    agentRow: { id: string; companyId: string },
    accountRow: { id: string; label: string; credentialType: string },
    hostRow: { id: string; name: string },
    scope: "project" | "shared" | "overflow",
    count: number,
    opts: { days?: number } = {},
  ) {
    for (let index = 0; index < count; index += 1) {
      await db.insert(heartbeatRuns).values({
        companyId: agentRow.companyId,
        agentId: agentRow.id,
        status: "succeeded",
        createdAt: new Date(daysAgo(opts.days ?? 3).getTime() - index * 1000),
        contextSnapshot: {
          aiConnection: {
            mode: "host_pool",
            provider: "anthropic",
            method: accountRow.credentialType,
            accountId: accountRow.id,
            accountName: accountRow.label,
            hostId: hostRow.id,
            hostName: hostRow.name,
            scope,
          },
        },
      });
    }
  }

  /** A run on an issue or project, without any pool attribution. */
  async function workRun(agentRow: { id: string; companyId: string }, context: { issueId?: string; projectId?: string }) {
    await db.insert(heartbeatRuns).values({
      companyId: agentRow.companyId,
      agentId: agentRow.id,
      status: "succeeded",
      createdAt: daysAgo(5),
      contextSnapshot: { ...context },
    });
  }

  async function bindingOf(agentId: string) {
    const [row] = await db.select().from(aiAccountAgentBindings).where(eq(aiAccountAgentBindings.agentId, agentId));
    return row ?? null;
  }

  async function allBindings() {
    return db.select().from(aiAccountAgentBindings).orderBy(asc(aiAccountAgentBindings.agentId));
  }

  async function marker() {
    const [row] = await db.select().from(deferredDataMigrations).where(eq(deferredDataMigrations.key, AI_ACCOUNT_BINDING_MIGRATION_KEY));
    return row ?? null;
  }

  function migrate(opts: AiAccountMigrationOptions = {}) {
    return runDeferredAiAccountMigration(db, { deploymentMode: "authenticated", ...opts });
  }

  async function summaryOf() {
    return (await readAiAccountMigrationReport(db, { deploymentMode: "authenticated" })).summary;
  }

  /** A company whose owner is a member, and the server's legacy host mapped to the Local environment. */
  async function serverWorld() {
    const companyId = await company("Acme");
    await user("owner");
    await member(companyId, "owner");
    const server = await host("Server");
    await mapHost(server.id, localEnvironment.id);
    return { companyId, server };
  }

  describe("account choice (D7)", () => {
    it("binds the only account reserved for the agent's projects before its own history", async () => {
      const { companyId, server } = await serverWorld();
      const reservedProject = await project(companyId, "Reserved");
      const otherProject = await project(companyId, "Other reserved");
      const reserved = await account("owner", { hostId: server.id, label: "Reserved one" });
      const usedMost = await account("owner", { hostId: server.id, label: "Used most" });
      const alsoReserved = await account("owner", { hostId: server.id, label: "Reserved two" });
      await reserve(reserved.id, reservedProject);
      await reserve(alsoReserved.id, otherProject);

      const single = await agent(companyId, { name: "Single" });
      await workRun(single, { issueId: await issue(companyId, reservedProject) });
      await hostPoolRuns(single, usedMost, server, "shared", 3);
      // Its projects map to two reserved accounts: the reservation rule does not apply.
      const both = await agent(companyId, { name: "Both" });
      await workRun(both, { issueId: await issue(companyId, reservedProject) });
      await workRun(both, { projectId: otherProject });
      await hostPoolRuns(both, usedMost, server, "project", 2);

      expect(await migrate()).toMatchObject({ status: "completed", added: 2 });
      expect(await bindingOf(single.id)).toMatchObject({
        mode: "pool_account",
        accountId: reserved.id,
        source: "migrated_host_pool",
        reviewedAt: null,
        migrationNote: "Chosen because it is the only Claude account reserved for this agent's projects.",
      });
      expect(await bindingOf(both.id)).toMatchObject({
        accountId: usedMost.id,
        migrationNote: "Chosen because this agent used it most in the last 45 days (2 runs).",
      });
      const summary = await summaryOf();
      expect(summary).toMatchObject({ bound: 2, unassigned: 0, unbound: 0, overLimitDevices: [] });
      expect(summary?.agents.map((entry) => [entry.agentName, entry.outcome, entry.rule, entry.accountLabel])).toEqual([
        ["Single", "bound", "reservation", "Reserved one"],
        ["Both", "bound", "agent_history", "Used most"],
      ]);
    });

    it("binds the agent's most-used account, the oldest on a tie, ignoring overflow and older runs", async () => {
      const { companyId, server } = await serverWorld();
      const older = await account("owner", { hostId: server.id, label: "Older", createdAt: daysAgo(30) });
      const newer = await account("owner", { hostId: server.id, label: "Newer", createdAt: daysAgo(20) });
      const borrowed = await account("owner", { hostId: server.id, label: "Borrowed", createdAt: daysAgo(40) });
      const builder = await agent(companyId, { name: "Builder" });
      await hostPoolRuns(builder, older, server, "shared", 2);
      await hostPoolRuns(builder, newer, server, "project", 2);
      await hostPoolRuns(builder, borrowed, server, "overflow", 5);
      await hostPoolRuns(builder, newer, server, "shared", 4, { days: 50 });

      await migrate();
      expect(await bindingOf(builder.id)).toMatchObject({ accountId: older.id, source: "migrated_host_pool" });
      expect((await summaryOf())?.agents).toEqual([expect.objectContaining({
        agentId: builder.id,
        outcome: "bound",
        rule: "agent_history",
        accountId: older.id,
        note: "Chosen because this agent used it most in the last 45 days (2 runs).",
      })]);
    });

    it("falls back to the company's most-used account on the agent's devices, never another company's", async () => {
      const { companyId, server } = await serverWorld();
      const light = await account("owner", { hostId: server.id, label: "Light" });
      const heavy = await account("owner", { hostId: server.id, label: "Heavy" });
      const otherCompany = await company("Other");
      await user("other-owner");
      await member(otherCompany, "other-owner");
      const foreign = await account("other-owner", { hostId: server.id, label: "Foreign" });

      await hostPoolRuns(await agent(companyId, { name: "Heavy user" }), heavy, server, "shared", 3);
      await hostPoolRuns(await agent(companyId, { name: "Light user" }), light, server, "project", 2);
      await hostPoolRuns(await agent(otherCompany, { name: "Other user" }), foreign, server, "shared", 10);
      // Only borrowed through overflow, so it has no history of its own.
      const borrower = await agent(companyId, { name: "Borrower" });
      await hostPoolRuns(borrower, light, server, "overflow", 6);
      // Never ran, but runs on the server, whose legacy accounts are usable.
      const newcomer = await agent(companyId, { name: "Newcomer" });

      await migrate();
      const note = "Chosen because this company's agents used it most on this agent's devices in the last 45 days (3 runs).";
      expect(await bindingOf(borrower.id)).toMatchObject({ accountId: heavy.id, migrationNote: note });
      expect(await bindingOf(newcomer.id)).toMatchObject({ accountId: heavy.id, migrationNote: note });
      const rules = new Map((await summaryOf())?.agents.map((entry) => [entry.agentName, entry.rule]));
      expect(rules.get("Borrower")).toBe("company_history");
      expect(rules.get("Other user")).toBe("agent_history");
    });

    it("leaves an agent without a choice unbound with a review note, and lists only candidates", async () => {
      const { companyId } = await serverWorld();
      const ssh = await sshEnvironment();
      const runner = await host("Runner", "ssh_host");
      await mapHost(runner.id, ssh.id);
      await account("owner", { hostId: runner.id, label: "Idle" });
      const idle = await agent(companyId, { name: "Idle runner", defaultEnvironmentId: ssh.id });
      // Not candidates: another AI connection, a device without pool accounts, another adapter.
      await agent(companyId, {
        name: "Connected",
        defaultEnvironmentId: ssh.id,
        runtimeConfig: { aiConnection: { mode: "responsible_user", provider: "anthropic", method: "subscription" } },
      });
      await agent(companyId, { name: "Plain", defaultEnvironmentId: (await sshEnvironment()).id });
      await agent(companyId, { name: "Codex", adapterType: "codex_local" });

      expect(await migrate()).toMatchObject({ status: "completed", added: 0 });
      expect(await allBindings()).toEqual([]);
      expect(await summaryOf()).toEqual({
        bound: 0,
        unassigned: 0,
        unbound: 1,
        agents: [{
          agentId: idle.id,
          agentName: "Idle runner",
          companyId,
          companyName: "Acme",
          outcome: "unbound",
          accountId: null,
          accountLabel: null,
          rule: null,
          note: "No reserved project, history of this agent, or company history on its devices points to a Claude account. Choose one for this agent.",
        }],
        overLimitDevices: [],
      });
    });

    it("binds company pool agents to the pool account with the same credential", async () => {
      const companyId = await company("Pool company");
      await user("owner");
      await member(companyId, "owner", "owner");
      const connections = aiConnectionService(db);
      const save = (name: string, token: string) => connections.save(companyId, "owner", {
        provider: "anthropic", method: "subscription", ownership: "shared", name, loginSessionId: "fixture", allAgents: true, agentIds: [],
      }, token);
      const first = await save("Max one", "token-first-member");
      const second = await save("Max two", "token-second-member");
      await aiConnectionPoolService(db).replace(companyId, "owner", { provider: "anthropic", members: [first, second] });
      const firstAccount = await account("owner", { label: "First", origin: "pool", credentialFingerprint: sha256("token-first-member") });
      const secondAccount = await account("owner", { label: "Second", origin: "pool", credentialFingerprint: sha256("token-second-member") });
      const poolBinding = { mode: "company_pool", provider: "anthropic", method: "subscription" };

      const usedSecond = await agent(companyId, { name: "Used second", runtimeConfig: { aiConnection: poolBinding } });
      await db.insert(heartbeatRuns).values({
        companyId,
        agentId: usedSecond.id,
        status: "succeeded",
        createdAt: daysAgo(2),
        contextSnapshot: {
          aiConnection: { mode: "company_pool", provider: "anthropic", method: "subscription", connectionId: second.connectionId, grantId: second.grantId, responsibleUserId: null, poolPriority: 1 },
        },
      });
      const fresh = await agent(companyId, { name: "Fresh", runtimeConfig: { aiConnection: poolBinding } });

      expect(await migrate()).toMatchObject({ status: "completed", added: 2 });
      expect(await bindingOf(usedSecond.id)).toMatchObject({
        accountId: secondAccount.id,
        source: "migrated_company_pool",
        migrationNote: "Chosen because it holds the credential of the company pool account this agent used last.",
      });
      expect(await bindingOf(fresh.id)).toMatchObject({
        accountId: firstAccount.id,
        source: "migrated_company_pool",
        migrationNote: "Chosen because it holds the credential of the first account in this company's pool.",
      });
      // runtime_config is never rewritten; the binding row simply wins.
      const [row] = await db.select({ runtimeConfig: agents.runtimeConfig }).from(agents).where(eq(agents.id, usedSecond.id));
      expect(row!.runtimeConfig).toEqual({ aiConnection: poolBinding });
      expect((await summaryOf())?.agents.map((entry) => entry.rule)).toEqual(["company_pool_fingerprint", "company_pool_fingerprint"]);

      // The report SQL finds the same matches, without printing any hash.
      const results = await runReport(database.connectionString);
      const pool = sectionRows(results, "6 ");
      expect(pool.map((entry) => [entry.agent, entry.priority, entry.matching_pool_account])).toEqual([
        ["Fresh", 0, "First"],
        ["Fresh", 1, "Second"],
        ["Used second", 0, "First"],
        ["Used second", 1, "Second"],
      ]);
      expect(JSON.stringify(results)).not.toContain(sha256("token-first-member"));
      expect(JSON.stringify(results)).not.toContain("token-first-member");
    });

    it("keeps a company pool agent on its pool when no account matches or the match fails a check", async () => {
      const companyId = await company("Pool company");
      await user("pool-admin");
      await user("outsider");
      await member(companyId, "pool-admin", "owner");
      const connection = await aiConnectionService(db).save(companyId, "pool-admin", {
        provider: "anthropic", method: "subscription", ownership: "shared", name: "Max", loginSessionId: "fixture", allAgents: true, agentIds: [],
      }, "token-of-outsider");
      await aiConnectionPoolService(db).replace(companyId, "pool-admin", { provider: "anthropic", members: [connection] });
      await account("outsider", { label: "Outsider's", origin: "pool", credentialFingerprint: sha256("token-of-outsider") });
      const poolBinding = { mode: "company_pool", provider: "anthropic", method: "subscription" };
      const pinned = await agent(companyId, { name: "Pinned", runtimeConfig: { aiConnection: poolBinding } });
      const emptyCompany = await company("Empty pool");
      const lonely = await agent(emptyCompany, { name: "Lonely", runtimeConfig: { aiConnection: poolBinding } });

      expect(await migrate()).toMatchObject({ status: "completed", added: 0 });
      expect(await bindingOf(pinned.id)).toBeNull();
      expect(await bindingOf(lonely.id)).toBeNull();
      const notes = new Map((await summaryOf())?.agents.map((entry) => [entry.agentName, [entry.outcome, entry.rule, entry.note]]));
      expect(notes.get("Pinned")).toEqual([
        "unbound",
        "company_pool_fingerprint",
        "The Claude account with this agent's company pool credential belongs to someone who is not a member of this company. The agent keeps its company pool connection.",
      ]);
      expect(notes.get("Lonely")).toEqual([
        "unbound",
        "company_pool_fingerprint",
        "Its company pool has no Claude account. The agent keeps its company pool connection.",
      ]);
    });
  });

  describe("checks (spec 5.3 steps 3-7 for a migration actor)", () => {
    it("respects reservations and the other checks: history agents wait unassigned, others stay unbound", async () => {
      const { companyId, server } = await serverWorld();
      const elsewhere = await project(await company("Elsewhere"), "Their project");
      const reservedElsewhere = await account("owner", { hostId: server.id, label: "Reserved elsewhere", createdAt: daysAgo(30) });
      await reserve(reservedElsewhere.id, elsewhere);
      const switchedOff = await account("owner", { hostId: server.id, label: "Switched off", status: "disabled", createdAt: daysAgo(20) });
      await user("stranger");
      const strangers = await account("stranger", { hostId: server.id, label: "Stranger's" });
      const reservedUser = await agent(companyId, { name: "Reserved user" });
      await hostPoolRuns(reservedUser, reservedElsewhere, server, "shared", 2);
      const offUser = await agent(companyId, { name: "Off user" });
      await hostPoolRuns(offUser, switchedOff, server, "shared", 2);
      const strangerUser = await agent(companyId, { name: "Stranger user" });
      await hostPoolRuns(strangerUser, strangers, server, "shared", 1);
      // Moved to an environment that maps to no device: the device is unknown.
      const healthy = await account("owner", { hostId: server.id, label: "Healthy" });
      const [orphan] = await db.insert(environments).values({ name: "Orphan sandbox", driver: "sandbox", config: { provider: "nobody" } }).returning();
      const sandboxed = await agent(companyId, { name: "Sandboxed", defaultEnvironmentId: orphan!.id });
      await hostPoolRuns(sandboxed, healthy, server, "shared", 1);
      // No history: the company's most-used account on its device is reserved elsewhere.
      const newcomer = await agent(companyId, { name: "Newcomer" });

      expect(await migrate()).toMatchObject({ status: "completed", added: 4 });
      expect(await bindingOf(reservedUser.id)).toMatchObject({
        mode: "pool_account",
        accountId: null,
        source: "migrated_host_pool",
        migrationNote: "The Claude account this agent used most in the last 45 days is reserved for another company's projects. No account was assigned: choose one for this agent.",
      });
      expect(await bindingOf(offUser.id)).toMatchObject({
        accountId: null,
        migrationNote: "The Claude account this agent used most in the last 45 days is switched off. No account was assigned: choose one for this agent.",
      });
      expect(await bindingOf(strangerUser.id)).toMatchObject({
        accountId: null,
        migrationNote: expect.stringContaining("belongs to someone who is not a member of this company"),
      });
      expect(await bindingOf(sandboxed.id)).toMatchObject({
        accountId: null,
        migrationNote: "The Claude account this agent used most in the last 45 days cannot be checked: Paperclip cannot tell which device the environment \"Orphan sandbox\" runs on. No account was assigned: choose one for this agent.",
      });
      // Notes never name the account.
      for (const row of await allBindings()) expect(row.migrationNote).not.toMatch(/Reserved elsewhere|Switched off|Stranger's|Healthy/);
      expect(await bindingOf(newcomer.id)).toBeNull();
      const summary = await summaryOf();
      expect(summary).toMatchObject({ bound: 0, unassigned: 4, unbound: 1 });
      expect(summary?.agents.find((entry) => entry.agentId === newcomer.id)).toMatchObject({
        outcome: "unbound",
        rule: "company_history",
        accountId: reservedElsewhere.id,
        note: "The Claude account this company's agents used most on this agent's devices is reserved for another company's projects. The agent was left without a Claude account.",
      });
    });

    it("respects the device cap in processing order and binds a Local candidate like any other", async () => {
      const { companyId, server } = await serverWorld();
      const [first, second, third, fourth] = [
        await account("owner", { hostId: server.id, label: "One" }),
        await account("owner", { hostId: server.id, label: "Two" }),
        await account("owner", { hostId: server.id, label: "Three" }),
        await account("owner", { hostId: server.id, label: "Four" }),
      ];
      // Two accounts are already bound by hand on the server.
      for (const [name, accountRow] of [["Manual one", first], ["Manual two", second]] as const) {
        const row = await agent(companyId, { name, createdAt: daysAgo(10) });
        await db.insert(aiAccountAgentBindings).values({ agentId: row.id, companyId, mode: "pool_account", accountId: accountRow!.id });
      }
      const pinnedLocal = await agent(companyId, { name: "Pinned local", createdAt: daysAgo(9), defaultEnvironmentId: localEnvironment.id });
      await hostPoolRuns(pinnedLocal, third!, server, "shared", 1);
      const overCap = await agent(companyId, { name: "Over cap", createdAt: daysAgo(8) });
      await hostPoolRuns(overCap, fourth!, server, "shared", 1);
      const sharesThird = await agent(companyId, { name: "Shares three", createdAt: daysAgo(7) });
      await hostPoolRuns(sharesThird, third!, server, "shared", 1);

      expect(await migrate()).toMatchObject({ status: "completed", added: 3 });
      expect(await bindingOf(pinnedLocal.id)).toMatchObject({ accountId: third!.id });
      expect(await bindingOf(overCap.id)).toMatchObject({
        mode: "pool_account",
        accountId: null,
        migrationNote: "The Claude account this agent used most in the last 45 days cannot be added: Server already runs 3 of 3 Claude accounts. No account was assigned: choose one already on that device, or free a slot.",
      });
      expect(await bindingOf(sharesThird.id)).toMatchObject({ accountId: third!.id });
      const summary = await summaryOf();
      expect(summary?.agents.map((entry) => [entry.agentName, entry.outcome])).toEqual([
        ["Pinned local", "bound"],
        ["Over cap", "unassigned"],
        ["Shares three", "bound"],
      ]);
      expect(summary?.overLimitDevices).toEqual([{ deviceId: server.id, deviceName: "Server", limit: 3, inUse: 3 }]);
      // The manual bindings are untouched.
      expect((await allBindings()).filter((row) => row.source === "manual").map((row) => row.accountId).sort())
        .toEqual([first!.id, second!.id].sort());
    });
  });

  describe("re-runs and failures", () => {
    it("is idempotent: a re-run adds only missing bindings, and boot skips a completed job", async () => {
      const { companyId, server } = await serverWorld();
      const used = await account("owner", { hostId: server.id, label: "Used" });
      const off = await account("owner", { hostId: server.id, label: "Off", status: "disabled" });
      const bound = await agent(companyId, { name: "Bound", createdAt: daysAgo(6) });
      await hostPoolRuns(bound, used, server, "shared", 2);
      const waiting = await agent(companyId, { name: "Waiting", createdAt: daysAgo(5) });
      await hostPoolRuns(waiting, off, server, "shared", 1);
      const manual = await agent(companyId, { name: "Manual", createdAt: daysAgo(4) });
      await db.insert(aiAccountAgentBindings).values({ agentId: manual.id, companyId, mode: "device_login" });

      const first = await migrate();
      expect(first).toMatchObject({ status: "completed", added: 2 });
      const rows = await allBindings();
      const second = await migrate({ force: true });
      expect(second).toMatchObject({ status: "completed", added: 0 });
      if (first.status !== "completed" || second.status !== "completed") throw new Error("both runs should complete");
      expect(await allBindings()).toEqual(rows);
      expect(second.summary).toEqual(first.summary);
      expect(await migrate()).toEqual({ status: "skipped", reason: "completed" });
      expect(await marker()).toMatchObject({ status: "completed", attempts: 2, lastError: null });
      expect(await bindingOf(manual.id)).toMatchObject({ mode: "device_login", source: "manual" });

      // An admin cleared one binding and a new agent appeared: a re-run adds exactly those.
      await db.delete(aiAccountAgentBindings).where(eq(aiAccountAgentBindings.agentId, bound.id));
      const late = await agent(companyId, { name: "Late", createdAt: daysAgo(3) });
      await hostPoolRuns(late, used, server, "project", 1);
      expect(await migrate({ force: true })).toMatchObject({ status: "completed", added: 2 });
      expect(await bindingOf(bound.id)).toMatchObject({ accountId: used.id, source: "migrated_host_pool" });
      expect((await summaryOf())?.agents.map((entry) => [entry.agentName, entry.outcome])).toEqual([
        ["Bound", "bound"],
        ["Waiting", "unassigned"],
        ["Late", "bound"],
      ]);

      // A migrated row an admin changed by hand leaves the report.
      await db.update(aiAccountAgentBindings).set({ source: "manual", accountId: used.id }).where(eq(aiAccountAgentBindings.agentId, waiting.id));
      expect(await migrate({ force: true })).toMatchObject({ status: "completed", added: 0 });
      expect((await summaryOf())?.agents.map((entry) => entry.agentName)).toEqual(["Bound", "Late"]);
    });

    it("marks a failed run and never throws, so boot continues; the next boot completes", async () => {
      const { companyId, server } = await serverWorld();
      const used = await account("owner", { hostId: server.id, label: "Used" });
      const builder = await agent(companyId, { name: "Builder" });
      await hostPoolRuns(builder, used, server, "shared", 1);

      const failing = new Proxy(db, {
        get(target, property, receiver) {
          if (property === "transaction") return async () => { throw new Error("simulated database failure"); };
          return Reflect.get(target, property, receiver);
        },
      });
      expect(await runDeferredAiAccountMigration(failing, { deploymentMode: "authenticated" }))
        .toEqual({ status: "failed", error: "simulated database failure" });
      expect(await marker()).toMatchObject({ status: "failed", attempts: 1, lastError: "simulated database failure", summary: null });
      expect(await allBindings()).toEqual([]);
      const report = await readAiAccountMigrationReport(db, { deploymentMode: "authenticated" });
      expect(report).toMatchObject({ status: "failed", attempts: 1, lastError: "simulated database failure", summary: null });

      // Even a database that answers nothing leaves boot running.
      const unreachable = new Proxy(db, { get() { throw new Error("database unreachable"); } });
      expect(await runDeferredAiAccountMigration(unreachable, { deploymentMode: "authenticated" }))
        .toEqual({ status: "failed", error: "database unreachable" });

      expect(await migrate()).toMatchObject({ status: "completed", added: 1 });
      expect(await marker()).toMatchObject({ status: "completed", attempts: 2, lastError: null });
      expect(await bindingOf(builder.id)).toMatchObject({ accountId: used.id });
    });
  });

  describe("report and go/no-go", () => {
    function app() {
      const server = express();
      server.use(express.json());
      server.use((req, _res, next) => {
        req.actor = actors[req.header("x-actor") ?? ""] ?? { type: "none", source: "none" };
        next();
      });
      server.use("/api", aiAccountPoolMigrationRoutes(db, { deploymentMode: "authenticated" }));
      server.use(errorHandler);
      return server;
    }

    it("serves the report with previews and the re-run to instance admins only", async () => {
      const { companyId, server } = await serverWorld();
      await user("admin");
      actors.admin = { type: "board", source: "session", userId: "admin", isInstanceAdmin: true, companyIds: [], memberships: [] };
      actors.member = {
        type: "board",
        source: "session",
        userId: "owner",
        isInstanceAdmin: false,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      };
      const used = await account("owner", { hostId: server.id, label: "Used" });
      const off = await account("owner", { hostId: server.id, label: "Off", status: "disabled" });
      const ready = await agent(companyId, { name: "Ready", createdAt: daysAgo(6) });
      await hostPoolRuns(ready, used, server, "shared", 2, { days: 2 });
      const waiting = await agent(companyId, { name: "Waiting", createdAt: daysAgo(5) });
      await hostPoolRuns(waiting, off, server, "shared", 1, { days: 1 });
      // History older than the go/no-go window: bound, but not part of the go/no-go.
      const older = await agent(companyId, { name: "Older", createdAt: daysAgo(4) });
      await hostPoolRuns(older, used, server, "shared", 1, { days: 20 });
      actors.agent = { type: "agent", agentId: ready.id, companyId, source: "agent_key" };
      const routes = app();

      const pending = await request(routes).get("/api/instance/ai-accounts/migration").set("x-actor", "admin");
      expect(pending.status, JSON.stringify(pending.body)).toBe(200);
      expect(pending.body).toEqual({
        key: AI_ACCOUNT_BINDING_MIGRATION_KEY,
        status: "pending",
        attempts: 0,
        lastError: null,
        completedAt: null,
        summary: null,
        goNoGo: {
          go: false,
          // Before the job ran, their runs would use the device's own login, which is no go.
          agents: [ready, waiting].map((row) => ({
            agentId: row.id,
            agentName: row.name,
            companyId,
            companyName: "Acme",
            plan: "none",
            reason: "no Claude account is assigned",
          })),
        },
      });

      for (const actor of ["member", "agent", "nobody"]) {
        expect((await request(routes).get("/api/instance/ai-accounts/migration").set("x-actor", actor)).status).toBe(403);
        expect((await request(routes).post("/api/instance/ai-accounts/migration/run").set("x-actor", actor).send({})).status).toBe(403);
      }
      expect(await marker()).toBeNull();

      const run = await request(routes).post("/api/instance/ai-accounts/migration/run").set("x-actor", "admin").send({});
      expect(run.status, JSON.stringify(run.body)).toBe(200);
      expect(run.body).toMatchObject({ status: "completed", attempts: 1, lastError: null, summary: { bound: 2, unassigned: 1, unbound: 0 } });
      expect(run.body.goNoGo).toEqual({
        go: false,
        agents: [
          { agentId: ready.id, agentName: "Ready", companyId, companyName: "Acme", plan: "use", reason: null },
          { agentId: waiting.id, agentName: "Waiting", companyId, companyName: "Acme", plan: "wait", reason: "unassigned" },
        ],
      });
      // The re-run's bindings are audited in each agent's company, by the admin who ran it.
      const entries = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "ai_account.binding_updated")));
      expect(entries.map((entry) => [entry.entityId, entry.actorType, entry.actorId]).sort()).toEqual(
        [[ready.id, "user", "admin"], [waiting.id, "user", "admin"], [older.id, "user", "admin"]].sort(),
      );
      expect(entries.find((entry) => entry.entityId === ready.id)?.details).toMatchObject({ source: "migrated_host_pool", rule: "agent_history", accountLabel: "Used" });
      expect(await bindingOf(ready.id)).toMatchObject({ updatedByUserId: "admin" });

      const preview = await previewPlan(db, ready.id, { deploymentMode: "authenticated" });
      expect(preview).toEqual({
        agentId: ready.id,
        agentName: "Ready",
        companyId,
        outcome: "use",
        reason: null,
        environments: [{
          environmentId: localEnvironment.id,
          environmentName: "Local",
          preview: { outcome: "use", accountId: used.id, deviceId: server.id, deviceName: "Server" },
        }],
      });
      expect(await previewPlan(db, randomUUID())).toBeNull();
      expect(await previewPlan(db, "not-an-id")).toBeNull();

      // Once the waiting agent has an account, the go/no-go passes.
      await db.update(aiAccountAgentBindings).set({ accountId: used.id, source: "manual" }).where(eq(aiAccountAgentBindings.agentId, waiting.id));
      const after = await request(routes).get("/api/instance/ai-accounts/migration").set("x-actor", "admin");
      expect(after.body.goNoGo.go).toBe(true);
      expect(after.body.summary.agents.map((entry: { agentName: string }) => entry.agentName)).toEqual(["Ready", "Waiting", "Older"]);
    });

    it("leaves agents that now run on their own AI connection out of the go/no-go", async () => {
      const { companyId, server } = await serverWorld();
      const used = await account("owner", { hostId: server.id, label: "Used" });
      const unassigned = await agent(companyId, { name: "Unassigned", createdAt: daysAgo(6) });
      await hostPoolRuns(unassigned, used, server, "shared", 1, { days: 1 });
      // Since its last host-pool run it got a connection of its own: its runs use that, never the device's login.
      const personal = await agent(companyId, {
        name: "Personal",
        createdAt: daysAgo(5),
        runtimeConfig: { aiConnection: { provider: "anthropic", method: "subscription", mode: "responsible_user" } },
      });
      await hostPoolRuns(personal, used, server, "shared", 1, { days: 1 });
      const pooled = await agent(companyId, {
        name: "Pooled",
        createdAt: daysAgo(4),
        runtimeConfig: { aiConnection: { provider: "anthropic", method: "subscription", mode: "company_pool" } },
      });
      await hostPoolRuns(pooled, used, server, "shared", 1, { days: 1 });
      // A binding row wins over the agent's own connection, so such an agent stays in.
      const bound = await agent(companyId, {
        name: "Bound",
        createdAt: daysAgo(3),
        runtimeConfig: { aiConnection: { provider: "anthropic", method: "subscription", mode: "responsible_user" } },
      });
      await hostPoolRuns(bound, used, server, "shared", 1, { days: 1 });
      await db.insert(aiAccountAgentBindings).values({ agentId: bound.id, companyId, mode: "pool_account", accountId: null, source: "manual" });

      expect(await aiAccountMigrationGoNoGo(db, { deploymentMode: "authenticated" })).toEqual({
        go: false,
        agents: [
          { agentId: unassigned.id, agentName: "Unassigned", companyId, companyName: "Acme", plan: "none", reason: "no Claude account is assigned" },
          { agentId: bound.id, agentName: "Bound", companyId, companyName: "Acme", plan: "wait", reason: "unassigned" },
        ],
      });
      await db.insert(aiAccountAgentBindings).values({ agentId: unassigned.id, companyId, mode: "pool_account", accountId: used.id, source: "manual" });
      await db.update(aiAccountAgentBindings).set({ accountId: used.id }).where(eq(aiAccountAgentBindings.agentId, bound.id));
      expect(await aiAccountMigrationGoNoGo(db, { deploymentMode: "authenticated" })).toMatchObject({
        go: true,
        agents: [{ agentId: unassigned.id, plan: "use" }, { agentId: bound.id, plan: "use" }],
      });
    });

    it("lists an agent set to its device's own login as none, never as go, and names every agent's company", async () => {
      const { companyId, server } = await serverWorld();
      const used = await account("owner", { hostId: server.id, label: "Used" });
      const own = await agent(companyId, { name: "Own login", createdAt: daysAgo(6) });
      await hostPoolRuns(own, used, server, "shared", 1, { days: 1 });
      await db.insert(aiAccountAgentBindings).values({ agentId: own.id, companyId, mode: "device_login", accountId: null, source: "manual" });
      // An agent of another company, unbound: its entry carries its own company's name.
      const otherCompanyId = await company("Beta");
      const elsewhere = await agent(otherCompanyId, { name: "Elsewhere", createdAt: daysAgo(5) });
      await hostPoolRuns(elsewhere, used, server, "shared", 1, { days: 1 });

      const goNoGo = await aiAccountMigrationGoNoGo(db, { deploymentMode: "authenticated" });
      expect(goNoGo.go).toBe(false);
      expect(goNoGo.agents).toHaveLength(2);
      expect(goNoGo.agents).toEqual(expect.arrayContaining([
        { agentId: own.id, agentName: "Own login", companyId, companyName: "Acme", plan: "none", reason: "set explicitly in its Claude account selection" },
        { agentId: elsewhere.id, agentName: "Elsewhere", companyId: otherCompanyId, companyName: "Beta", plan: "none", reason: "no Claude account is assigned" },
      ]));
    });
  });

  describe("pre-deploy report on a production-shaped database", () => {
    it("runs read-only on the 0308 schema and again after the upgrade", async () => {
      type JournalEntry = { idx: number; tag: string; when: number; version: string; breakpoints: boolean };
      const migrationsDir = new URL("../../../packages/db/src/migrations/", import.meta.url);
      const journal = JSON.parse(await readFile(new URL("meta/_journal.json", migrationsDir), "utf8")) as { entries: JournalEntry[] };
      let ddlPosition = -1;
      for (let position = journal.entries.length - 1; position >= 0 && ddlPosition < 0; position -= 1) {
        const content = await readFile(new URL(`${journal.entries[position]!.tag}.sql`, migrationsDir), "utf8");
        if (content.includes('CREATE TABLE "ai_account_agent_bindings"')) ddlPosition = position;
      }
      expect(ddlPosition).toBeGreaterThan(0);

      const name = `pool_report_${randomUUID().replaceAll("-", "")}`;
      expect(await ensurePostgresDatabase(database.connectionString, name)).toBe("created");
      const url = new URL(database.connectionString);
      url.pathname = `/${name}`;
      const legacyUrl = url.href;
      const legacyMigrationsDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-account-report-0308-"));
      try {
        await mkdir(path.join(legacyMigrationsDir, "meta"));
        const priorEntries = journal.entries.slice(0, ddlPosition);
        for (const entry of priorEntries) {
          await writeFile(path.join(legacyMigrationsDir, `${entry.tag}.sql`), await readFile(new URL(`${entry.tag}.sql`, migrationsDir)));
        }
        await writeFile(path.join(legacyMigrationsDir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: priorEntries }));
        const migrator = drizzle({ connection: { url: legacyUrl, max: 1, onnotice: () => {} } });
        try {
          await migrateLegacy(migrator, { migrationsFolder: legacyMigrationsDir });
        } finally {
          await migrator.$client.end();
        }

        // Production-shaped rows, written with the 0308 columns only.
        const legacy = createDb(legacyUrl);
        const companyId = randomUUID();
        const agentId = randomUUID();
        const hostId = randomUUID();
        const twinA = randomUUID();
        const twinB = randomUUID();
        const accountId = randomUUID();
        const projectId = randomUUID();
        await legacy.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Acme', ${`A${companyId.slice(0, 5)}`})`);
        await legacy.execute(sql`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ('creator', 'Creator', 'creator@example.com', true, now(), now())`);
        await legacy.execute(sql`INSERT INTO agents (id, company_id, name, adapter_type) VALUES (${agentId}, ${companyId}, 'Builder', 'claude_local')`);
        await legacy.execute(sql`INSERT INTO projects (id, company_id, name) VALUES (${projectId}, ${companyId}, 'Reserved project')`);
        const [local] = [...await legacy.execute(sql`SELECT id FROM environments WHERE driver = 'local' LIMIT 1`)] as Array<{ id: string }>;
        await legacy.execute(sql`INSERT INTO ai_account_hosts (id, name, kind) VALUES
          (${hostId}, 'Server', 'server'), (${twinA}, 'Twin A', 'ssh_host'), (${twinB}, 'Twin B', 'ssh_host')`);
        if (local) await legacy.execute(sql`INSERT INTO ai_account_host_environments (environment_id, host_id) VALUES (${local.id}, ${hostId})`);
        for (const [twin, hostName] of [[twinA, "twin.example.com"], [twinB, "TWIN.example.com"]] as const) {
          const environmentId = randomUUID();
          await legacy.execute(sql`INSERT INTO environments (id, name, driver, config)
            VALUES (${environmentId}, ${`ssh ${hostName}`}, 'ssh', ${JSON.stringify({ host: hostName, port: 22, username: "runner" })}::jsonb)`);
          await legacy.execute(sql`INSERT INTO ai_account_host_environments (environment_id, host_id) VALUES (${environmentId}, ${twin})`);
        }
        await legacy.execute(sql`INSERT INTO ai_accounts (id, host_id, credential_type, label, email_hint, credential_material, credential_fingerprint, created_by_user_id)
          VALUES (${accountId}, ${hostId}, 'subscription', 'Max', 'Shared@Example.com', ${JSON.stringify({ ciphertext: "legacy-cipher-text" })}::jsonb, 'legacy-fingerprint', 'creator')`);
        await legacy.execute(sql`INSERT INTO ai_account_projects (account_id, project_id) VALUES (${accountId}, ${projectId})`);
        for (const scope of ["project", "shared", "overflow"]) {
          await legacy.execute(sql`INSERT INTO heartbeat_runs (company_id, agent_id, status, created_at, context_snapshot)
            VALUES (${companyId}, ${agentId}, 'succeeded', now() - interval '2 days',
              ${JSON.stringify({ aiConnection: { mode: "host_pool", provider: "anthropic", method: "subscription", accountId, accountName: "Max", hostId, hostName: "Server", scope } })}::jsonb)`);
        }

        const before = await runReport(legacyUrl);
        expect(sectionRows(before, "1 ")).toEqual([expect.objectContaining({
          account_id: accountId,
          creator_user_id: "creator",
          email_hint_masked: "Sh***@Example.com",
          host: "Server",
          reserved_for_projects: "Reserved project (Acme)",
        })]);
        expect(sectionRows(before, "3 ").map((row) => [row.host, row.conflict]).sort()).toEqual([
          ["Twin A", "another host claims the same host:port"],
          ["Twin B", "another host claims the same host:port"],
        ]);
        expect(sectionRows(before, "4 ")).toEqual([expect.objectContaining({ agent: "Builder", project_runs: 1, shared_runs: 1, overflow_runs: 1, devices: "Server" })]);
        expect(sectionRows(before, "5 ")).toEqual([expect.objectContaining({ agent: "Builder", account: "Max", runs: 2 })]);
        // The creator is a member of no company, so the agents using the account would wait.
        expect(sectionRows(before, "8 ")).toEqual([expect.objectContaining({ company: "Acme", account: "Max", problem: "its owner is not an active member of this company" })]);
        expect(sectionRows(before, "10 ")).toEqual([expect.objectContaining({ agent: "Builder", host_pool_runs: 3 })]);
        expect(JSON.stringify(before)).not.toMatch(/legacy-cipher-text|legacy-fingerprint/);
        // Nothing was written.
        const [{ count }] = [...await legacy.execute(sql`SELECT count(*)::int AS count FROM ai_accounts`)] as Array<{ count: number }>;
        expect(count).toBe(1);

        await closeRegisteredClients(legacyUrl);
        await applyPendingMigrations(legacyUrl);
        const after = await runReport(legacyUrl);
        expect(sectionRows(after, "1 ")).toEqual([expect.objectContaining({ account_id: accountId, email_hint_masked: "Sh***@Example.com" })]);
        expect(sectionRows(after, "10 ")).toHaveLength(1);
      } finally {
        await closeRegisteredClients(legacyUrl);
        await rm(legacyMigrationsDir, { recursive: true, force: true });
      }
    }, 240_000);
  });
});
