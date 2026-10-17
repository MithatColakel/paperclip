import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { asc, eq, sql } from "drizzle-orm";
import request from "supertest";
import {
  activityLog,
  agents,
  aiAccountAgentBindings,
  aiAccountHostEnvironments,
  aiAccountHosts,
  aiAccounts,
  authUsers,
  companies,
  companyMemberships,
  costEvents,
  createDb,
  environments,
  heartbeatRuns,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";

const hostsModule = await import("../services/ai-account-hosts.js");
const { aiAccountHostService, isCreditBalanceFailure } = hostsModule;
const { aiAccountHostRoutes } = await import("../routes/ai-account-hosts.js");
const { errorHandler } = await import("../middleware/error-handler.js");
const { heartbeatService } = await import("../services/heartbeat.js");
const { encryptCredential } = await import("../services/ai-account-credentials.js");
const { deviceForEnvironment } = await import("../services/execution-devices.js");

const sub = (n: number) => `sk-ant-oat01-${"a".repeat(30)}${n}`;
const key = (n: number) => `sk-ant-api03-${"b".repeat(30)}${n}`;

describe("isCreditBalanceFailure", () => {
  it("recognizes the API credit message only", () => {
    expect(isCreditBalanceFailure("Credit balance is too low to access the Anthropic API")).toBe(true);
    expect(isCreditBalanceFailure("You've hit your limit · resets 4pm (UTC)")).toBe(false);
    expect(isCreditBalanceFailure(null)).toBe(false);
  });
});

// Fork: P7. The host service administers devices and never picks, balances or
// moves accounts for a run; pool accounts are bound per agent instead.
describe("legacy host pool retirement", () => {
  it("offers no way to choose an account for a run", () => {
    for (const name of ["pickBalancedAccount", "pickAccountForRun", "HOST_POOL_AUTH_ENV_KEYS", "HOST_POOL_FORBIDDEN_ROUTING_ENV_KEYS", "HOST_POOL_DRIVERS"]) {
      expect(hostsModule).not.toHaveProperty(name);
    }
    const svc = aiAccountHostService({} as never);
    for (const name of ["selectForRun", "poolHostForEnvironment", "hasAvailableAccount", "countPoolAccounts", "addAccount", "setAccountProjects", "markLimited", "markAuthFailed"]) {
      expect(svc).not.toHaveProperty(name);
    }
  });
});

describe("execution devices on the legacy host routes (database)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const companyId = randomUUID();
  const companyA = randomUUID();
  const companyB = randomUUID();
  const agentId = randomUUID();
  let localEnvId: string;
  let sshEnvId: string;
  let sandboxEnvId: string;
  /** Shared SSH environments without a host, so only an explicit mapping gives them a device. */
  let sharedEnvId: string;
  let otherSharedEnvId: string;
  /** Company B's own SSH environment. */
  let companyBEnvId: string;

  beforeAll(async () => {
    home = await mkdtemp(path.join(process.env.PAPERCLIP_HOME ?? os.tmpdir(), "paperclip-ai-hosts-tests-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "ai-hosts-fixture");
    database = await startEmbeddedPostgresTestDatabase("paperclip-ai-hosts-db-");
    db = createDb(database.connectionString);
    await db.insert(companies).values([
      { id: companyId, name: "Hosts company", issuePrefix: "HST", defaultResponsibleUserId: "admin" },
      { id: companyA, name: "Alpha", issuePrefix: "ALP" },
      { id: companyB, name: "Bravo", issuePrefix: "BRV" },
    ]);
    const now = new Date();
    await db.insert(authUsers).values([
      { id: "admin", name: "Ada Admin", email: "ada@example.com", createdAt: now, updatedAt: now },
      { id: "owner", name: "Omar Owner", email: "omar@example.com", createdAt: now, updatedAt: now },
    ]);
    await db.insert(companyMemberships).values([
      { companyId, principalId: "admin", principalType: "user", status: "active", membershipRole: "owner" },
      { companyId: companyA, principalId: "owner", principalType: "user", status: "active", membershipRole: "owner" },
      { companyId: companyB, principalId: "owner", principalType: "user", status: "active", membershipRole: "owner" },
    ]);
    const [existingLocal] = await db.select().from(environments).where(eq(environments.driver, "local"));
    const [local] = existingLocal ? [existingLocal] : await db.insert(environments).values({ name: "Local", driver: "local" }).returning();
    const [ssh] = await db.insert(environments).values({ name: "runner: one", driver: "ssh" }).returning();
    const [sandbox] = await db.insert(environments).values({ name: "Plugin sandbox", driver: "sandbox" }).returning();
    const [shared] = await db.insert(environments).values({ name: "Build tunnel", driver: "ssh" }).returning();
    const [otherShared] = await db.insert(environments).values({ name: "Spare tunnel", driver: "ssh" }).returning();
    const [ownB] = await db.insert(environments).values({ name: "Bravo private tunnel", driver: "ssh", companyId: companyB }).returning();
    localEnvId = local!.id;
    sshEnvId = ssh!.id;
    sandboxEnvId = sandbox!.id;
    sharedEnvId = shared!.id;
    otherSharedEnvId = otherShared!.id;
    companyBEnvId = ownB!.id;
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await database?.cleanup();
    await rm(home, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Agents go with their runs, cost events and bindings; the fixture agent comes back.
    await db.execute(sql`truncate table agents, heartbeat_runs, cost_events cascade`);
    await db.insert(agents).values({ id: agentId, companyId, name: "Builder", adapterType: "claude_local" });
    await db.delete(aiAccounts);
    await db.delete(aiAccountHostEnvironments);
    await db.delete(aiAccountHosts);
    await db.delete(activityLog);
  });

  let accountCount = 0;
  async function account(input: { label: string; hostId?: string | null; ownerUserId?: string | null; createdByUserId?: string | null; credentialType?: "subscription" | "api_key"; value?: string; emailHint?: string | null }) {
    accountCount += 1;
    const value = input.value ?? sub(accountCount);
    const [row] = await db.insert(aiAccounts).values({
      hostId: input.hostId ?? null,
      credentialType: input.credentialType ?? "subscription",
      label: input.label,
      emailHint: input.emailHint ?? null,
      ownerUserId: input.ownerUserId === undefined ? "owner" : input.ownerUserId,
      createdByUserId: input.createdByUserId === undefined ? "owner" : input.createdByUserId,
      origin: input.hostId ? "legacy_host_pool" : "pool",
      credentialMaterial: await encryptCredential(value),
      credentialFingerprint: randomUUID(),
      credentialHint: `…${value.slice(-4)}`,
    }).returning();
    return row!;
  }

  /** A Claude agent pinned to an environment and bound to a pool account. */
  async function boundAgent(company: string, environmentId: string, accountId: string) {
    const [row] = await db.insert(agents).values({ companyId: company, name: `Agent ${randomUUID().slice(0, 8)}`, adapterType: "claude_local", defaultEnvironmentId: environmentId }).returning();
    await db.insert(aiAccountAgentBindings).values({ agentId: row!.id, companyId: company, mode: "pool_account", accountId });
    return row!;
  }

  async function mappedEnvironments(hostId: string) {
    return (await db.select({ id: aiAccountHostEnvironments.environmentId }).from(aiAccountHostEnvironments)
      .where(eq(aiAccountHostEnvironments.hostId, hostId))).map((row) => row.id).sort();
  }

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

  it("maps only environments the device kind can run, and lets a computer over SSH take plugin sandboxes too (spec 6.1)", async () => {
    const svc = aiAccountHostService(db);
    const server = await svc.createHost({ name: "Server", kind: "server" }, "admin");
    const runner = await svc.createHost({ name: "Runner", kind: "ssh_host" }, "admin");
    await expect(svc.setEnvironments(server.id, [sshEnvId])).rejects.toMatchObject({ status: 422 });
    await expect(svc.setEnvironments(runner.id, [sandboxEnvId])).rejects.toMatchObject({ status: 422, message: expect.stringContaining("takes ssh environments only") });
    await svc.setEnvironments(server.id, [localEnvId]);
    await svc.setEnvironments(runner.id, [sshEnvId]);
    const computer = await svc.createHost({ name: "Computer over SSH", kind: "mac" }, "admin");
    await svc.setEnvironments(computer.id, [sshEnvId, sandboxEnvId]);
    // A plugin device takes its plugin's sandboxes only; it comes from the plugin's reports, never from this route.
    const [pluginDevice] = await db.insert(aiAccountHosts).values({ name: "Plugin device", kind: "external" }).returning();
    await expect(svc.setEnvironments(pluginDevice!.id, [sshEnvId])).rejects.toMatchObject({ status: 422 });
    await svc.setEnvironments(pluginDevice!.id, [sandboxEnvId]);
    // The schema refuses the kind already; the service refuses it too. (`as never`: the schema may narrow the type.)
    await expect(svc.createHost({ name: "Hand-made plugin device", kind: "external" as never }, "admin")).rejects.toMatchObject({ status: 422 });
    const listed = await svc.list();
    expect(listed.hosts.find((host) => host.id === runner.id)?.environments).toEqual([]);
    expect(listed.hosts.find((host) => host.id === computer.id)?.environments.map((e) => e.id)).toEqual([sshEnvId]);
    expect(listed.hosts.find((host) => host.id === pluginDevice!.id)?.environments.map((e) => e.id)).toEqual([sandboxEnvId]);
    const unmapped = listed.unmappedEnvironments.map((e) => e.id);
    expect(unmapped).not.toContain(sandboxEnvId);
    expect(unmapped).not.toContain(localEnvId);
    expect(unmapped).not.toContain(sshEnvId);
    expect(unmapped).toContain(sharedEnvId);
  });

  it("refuses a mapping edit that would put more bound accounts on a device than its cap, and writes nothing", async () => {
    const svc = aiAccountHostService(db);
    const app = appFor(admin);
    const device = await svc.createHost({ name: "Studio", kind: "mac", maxAccounts: 1 }, "admin");
    const first = await account({ label: "Max one" });
    const second = await account({ label: "Max two" });
    await boundAgent(companyA, sharedEnvId, first.id);
    await boundAgent(companyB, otherSharedEnvId, second.id);
    await request(app).put(`/api/instance/ai-hosts/${device.id}/environments`).send({ environmentIds: [sharedEnvId] }).expect(200);
    await db.delete(activityLog);

    const refused = await request(app).put(`/api/instance/ai-hosts/${device.id}/environments`)
      .send({ environmentIds: [sharedEnvId, otherSharedEnvId] }).expect(409);
    expect(refused.body).toMatchObject({
      code: "device_account_limit",
      details: { code: "device_account_limit", deviceId: device.id, deviceName: "Studio", limit: 1, inUse: 2, accounts: ["Max one", "Max two"] },
    });
    expect(refused.body.error).toBe(
      "With these environments, agents that can run on Studio would use 2 Claude accounts, more than its limit of 1. " +
      "Move some of those agents to another device or give them other accounts first.",
    );
    expect(await mappedEnvironments(device.id)).toEqual([sharedEnvId]);
    expect(await db.select().from(activityLog)).toHaveLength(0);

    // A device already over its cap keeps its accounts and may still lose environments, but takes no new account.
    await boundAgent(companyA, sharedEnvId, second.id);
    await request(app).put(`/api/instance/ai-hosts/${device.id}/environments`).send({ environmentIds: [sharedEnvId] }).expect(200);
    const third = await account({ label: "Max three" });
    await boundAgent(companyB, otherSharedEnvId, third.id);
    await request(app).put(`/api/instance/ai-hosts/${device.id}/environments`).send({ environmentIds: [sharedEnvId, otherSharedEnvId] }).expect(409);
    await request(app).put(`/api/instance/ai-hosts/${device.id}/environments`).send({ environmentIds: [] }).expect(200);
    expect(await mappedEnvironments(device.id)).toEqual([]);
  });

  it("refuses to lower a device's cap below the accounts bound to agents that can run on it", async () => {
    const svc = aiAccountHostService(db);
    const app = appFor(admin);
    const device = await svc.createHost({ name: "Runner", kind: "ssh_host" }, "admin");
    await svc.setEnvironments(device.id, [sharedEnvId, otherSharedEnvId]);
    const first = await account({ label: "Max one" });
    const second = await account({ label: "Max two" });
    await boundAgent(companyA, sharedEnvId, first.id);
    await boundAgent(companyA, otherSharedEnvId, second.id);
    // An agent on a device-login binding takes no account slot.
    const [ownLogin] = await db.insert(agents).values({ companyId: companyA, name: "Own login", adapterType: "claude_local", defaultEnvironmentId: sharedEnvId }).returning();
    await db.insert(aiAccountAgentBindings).values({ agentId: ownLogin!.id, companyId: companyA, mode: "device_login" });

    const refused = await request(app).patch(`/api/instance/ai-hosts/${device.id}`).send({ maxAccounts: 1 }).expect(409);
    expect(refused.body).toMatchObject({ code: "device_account_limit", details: { deviceId: device.id, limit: 1, inUse: 2, accounts: ["Max one", "Max two"] } });
    expect(refused.body.error).toBe(
      "Agents that can run on Runner use 2 Claude accounts, more than 1. " +
      "Move some of those agents to another device or give them other accounts before lowering the limit.",
    );
    expect((await svc.getHost(device.id)).maxAccounts).toBe(3);

    expect((await request(app).patch(`/api/instance/ai-hosts/${device.id}`).send({ maxAccounts: 2 }).expect(200)).body).toMatchObject({ maxAccounts: 2 });
    await svc.createHost({ name: "Other", kind: "ssh_host" }, "admin");
    const taken = await request(app).patch(`/api/instance/ai-hosts/${device.id}`).send({ name: "Other" }).expect(409);
    expect(taken.body.error).toBe("A device with this name already exists");
  });

  it("logs a device change only in the companies whose agents use the device, never in every company", async () => {
    const svc = aiAccountHostService(db);
    const app = appFor(admin);
    const shared = await account({ label: "Max one" });
    // Alpha runs on the shared tunnel, Bravo on its own private tunnel; the fixture company runs on neither.
    await boundAgent(companyA, sharedEnvId, shared.id);
    await db.insert(agents).values({ companyId: companyB, name: "Bravo agent", adapterType: "claude_local", defaultEnvironmentId: companyBEnvId });
    const logged = async () => (await db.select().from(activityLog).orderBy(asc(activityLog.createdAt)))
      .map((row) => ({ companyId: row.companyId, action: row.action, details: row.details }));

    const device = (await request(app).post("/api/instance/ai-hosts").send({ name: "Build box", kind: "ssh_host" }).expect(201)).body;
    // No agent uses a new device, so no company hears of it.
    expect(await logged()).toEqual([]);

    await request(app).put(`/api/instance/ai-hosts/${device.id}/environments`).send({ environmentIds: [sharedEnvId] }).expect(200);
    expect(await logged()).toEqual([
      { companyId: companyA, action: "execution_device.updated", details: { deviceName: "Build box", changedKeys: ["environments"], environments: ["Build tunnel"] } },
    ]);
    await db.delete(activityLog);

    await request(app).patch(`/api/instance/ai-hosts/${device.id}`).send({ name: "Build box 2" }).expect(200);
    expect(await logged()).toEqual([
      { companyId: companyA, action: "execution_device.updated", details: { deviceName: "Build box 2", changedKeys: ["name"], maxAccounts: 3, previousName: "Build box" } },
    ]);
    await db.delete(activityLog);

    // Bravo starts using the device: both companies hear of it, and Alpha never sees Bravo's environment name.
    await request(app).put(`/api/instance/ai-hosts/${device.id}/environments`).send({ environmentIds: [sharedEnvId, companyBEnvId] }).expect(200);
    const both = await logged();
    expect(both.map((row) => row.companyId).sort()).toEqual([companyA, companyB].sort());
    expect(both.find((row) => row.companyId === companyA)?.details).toEqual({
      deviceName: "Build box 2", changedKeys: ["environments"], environments: ["Build tunnel"], otherEnvironments: 1,
    });
    expect(both.find((row) => row.companyId === companyB)?.details).toEqual({
      deviceName: "Build box 2", changedKeys: ["environments"], environments: expect.arrayContaining(["Build tunnel", "Bravo private tunnel"]),
    });
    expect(JSON.stringify(both.find((row) => row.companyId === companyA))).not.toContain("Bravo private tunnel");
    await db.delete(activityLog);

    await request(app).delete(`/api/instance/ai-hosts/${device.id}`).expect(200);
    expect((await logged()).map((row) => `${row.companyId}:${row.action}`).sort())
      .toEqual([`${companyA}:execution_device.deleted`, `${companyB}:execution_device.deleted`].sort());
    expect((await db.select().from(activityLog)).some((row) => row.companyId === companyId)).toBe(false);
  });

  it("answers 410 on the moved account routes and names the routes that replace them", async () => {
    const svc = aiAccountHostService(db);
    const app = appFor(admin);
    const host = await svc.createHost({ name: "Runner", kind: "ssh_host" }, "admin");
    const added = await request(app).post(`/api/instance/ai-hosts/${host.id}/accounts`)
      .send({ label: "S", credentialType: "subscription", value: sub(5) }).expect(410);
    expect(added.body).toMatchObject({
      code: "ai_account_route_moved",
      details: { code: "ai_account_route_moved", replacements: ["POST /api/me/ai-accounts", "PUT /api/agents/{agentId}/ai-account"] },
    });
    expect(added.body.error).toContain("POST /api/me/ai-accounts");
    expect(JSON.stringify(added.body)).not.toContain(sub(5));
    // Any body and any caller get the same answer; nothing is stored.
    await request(appFor(member)).post(`/api/instance/ai-hosts/${host.id}/accounts`).send({}).expect(410);
    expect(await db.select().from(aiAccounts)).toHaveLength(0);

    const existing = await account({ label: "Legacy", hostId: host.id });
    const reserved = await request(app).put(`/api/instance/ai-accounts/${existing.id}/projects`).send({ projectIds: [] }).expect(410);
    expect(reserved.body).toMatchObject({ code: "ai_account_route_moved", details: { replacements: ["PATCH /api/me/ai-accounts/{accountId}"] } });
    expect(reserved.body.error).toContain("clearProjectRestriction");

    // The account PATCH, clear-limit and DELETE routes belong to the account pool router now.
    await request(app).patch(`/api/instance/ai-accounts/${existing.id}`).send({ label: "Renamed" }).expect(404);
    await request(app).post(`/api/instance/ai-accounts/${existing.id}/clear-limit`).send({}).expect(404);
    await request(app).delete(`/api/instance/ai-accounts/${existing.id}`).expect(404);
    expect(await db.select().from(aiAccounts)).toEqual([expect.objectContaining({ id: existing.id, label: "Legacy" })]);
  });

  it("is for instance admins only, lists accounts with their owner and origin, and never returns a credential", async () => {
    const svc = aiAccountHostService(db);
    await request(appFor(member)).get("/api/instance/ai-hosts").expect(403);
    await request(appFor({ type: "agent", agentId, companyId })).get("/api/instance/ai-hosts").expect(403);
    await request(appFor(member)).patch(`/api/instance/ai-hosts/${randomUUID()}`).send({ name: "x" }).expect(403);
    // A plugin device comes only from its plugin's reports.
    await request(appFor(admin)).post("/api/instance/ai-hosts").send({ name: "Hand-made", kind: "external" }).expect(400);
    const host = await svc.createHost({ name: "Server", kind: "server" }, "admin");
    await account({ label: "Owned", hostId: host.id, ownerUserId: null, createdByUserId: "admin", value: sub(7), emailHint: "someone.private@example.com" });
    await account({ label: "Ownerless", hostId: host.id, ownerUserId: null, createdByUserId: null, credentialType: "api_key", value: key(8) });
    await account({ label: "Pool", hostId: null });
    const listed = await request(appFor(admin)).get("/api/instance/ai-hosts").expect(200);
    expect(JSON.stringify(listed.body)).not.toContain(sub(7));
    expect(JSON.stringify(listed.body)).not.toContain(key(8));
    expect(listed.body.maxAccountsPerHost).toBe(3);
    // Only accounts first added to a host are listed under it.
    expect(listed.body.hosts[0].accounts).toEqual([
      expect.objectContaining({ label: "Owned", origin: "legacy_host_pool", owner: { userId: "admin", name: "Ada Admin", email: "ada@example.com" } }),
      expect.objectContaining({ label: "Ownerless", origin: "legacy_host_pool", owner: null, credentialType: "api_key" }),
    ]);
    // Only the owner sees an account's e-mail hint unmasked; instance admins see it masked, as on /api/instance/ai-accounts.
    expect(listed.body.hosts[0].accounts[0].emailHint).toBe("so•••@example.com");
    expect(listed.body.hosts[0].accounts[1].emailHint).toBeNull();
    expect(JSON.stringify(listed.body)).not.toContain("someone.private");
  });

  it("counts running runs and Paperclip's own use of each account from pool runs and legacy host-pool runs alike", async () => {
    const svc = aiAccountHostService(db);
    const host = await svc.createHost({ name: "Server", kind: "server" }, "admin");
    const legacy = await account({ label: "S", hostId: host.id, credentialType: "api_key", value: key(7) });
    const realNow = Date.now();
    const hoursAgo = (hours: number) => new Date(realNow - hours * 60 * 60 * 1000);
    const runAt = async (when: Date, mode: "host_pool" | "pool_account", input: number, output: number, cents: number) => {
      const id = randomUUID();
      await db.insert(heartbeatRuns).values({
        id, companyId, agentId, invocationSource: "assignment", status: "succeeded", finishedAt: when,
        contextSnapshot: { aiConnection: { mode, accountId: legacy.id, hostId: host.id } },
      });
      await db.insert(costEvents).values({
        companyId, agentId, heartbeatRunId: id, provider: "anthropic", model: "claude-opus-5-5",
        inputTokens: input, cachedInputTokens: input * 10, outputTokens: output, costCents: cents, occurredAt: when,
      });
    };
    await runAt(hoursAgo(1), "host_pool", 1000, 100, 50);
    await runAt(hoursAgo(2), "pool_account", 2000, 200, 70);
    await runAt(hoursAgo(30), "pool_account", 4000, 400, 90);
    await runAt(hoursAgo(24 * 9), "host_pool", 8000, 800, 110);
    for (const mode of ["host_pool", "pool_account", "company_pool"]) {
      await db.insert(heartbeatRuns).values({
        companyId, agentId, invocationSource: "assignment", status: "running",
        contextSnapshot: { aiConnection: { mode, accountId: legacy.id } },
      });
    }
    await db.update(aiAccounts).set({ exhaustedUntil: new Date(realNow + 60 * 60_000), limitReason: "credit_balance", lastLimitedAt: new Date(realNow) })
      .where(eq(aiAccounts.id, legacy.id));
    const listed = (await svc.list()).hosts[0]!.accounts[0]!;
    expect(listed.usage.lastFiveHours).toEqual({ runs: 2, inputTokens: 3000, cachedInputTokens: 30000, outputTokens: 300, costCents: 120 });
    expect(listed.usage.lastSevenDays).toMatchObject({ runs: 3, inputTokens: 7000, outputTokens: 700, costCents: 210 });
    expect(listed.runningRuns).toBe(2);
    expect(listed.lastLimitedAt).not.toBeNull();
    expect(listed.limitReason).toBe("credit_balance");
  });

  it("lets an environment return to a device already over its cap when that device gains no account", async () => {
    const svc = aiAccountHostService(db);
    const app = appFor(admin);
    // Two SSH environments reach one machine, which Paperclip finds by its host.
    const ssh = { host: "studio.example.com", port: 22, username: "runner" };
    const [tunnel] = await db.insert(environments).values({ name: "F tunnel", driver: "ssh", config: ssh }).returning();
    const [second] = await db.insert(environments).values({ name: "E1 tunnel", driver: "ssh", config: ssh }).returning();
    const machine = (await deviceForEnvironment(db, tunnel!))!;
    expect(machine.name).toBe("SSH · F tunnel");
    // The machine already holds two accounts against a cap of one; the second environment's agent uses one of them.
    await db.update(aiAccountHosts).set({ maxAccounts: 1 }).where(eq(aiAccountHosts.id, machine.id));
    const first = await account({ label: "Max one" });
    const other = await account({ label: "Max two" });
    await boundAgent(companyA, tunnel!.id, first.id);
    await boundAgent(companyA, tunnel!.id, other.id);
    await boundAgent(companyA, second!.id, first.id);
    const desk = await svc.createHost({ name: "Studio desk", kind: "ssh_host" }, "admin");

    await request(app).put(`/api/instance/ai-hosts/${desk.id}/environments`).send({ environmentIds: [second!.id] }).expect(200);
    // Back to the machine: it keeps its accounts and gains none, so the edit stands.
    await request(app).put(`/api/instance/ai-hosts/${desk.id}/environments`).send({ environmentIds: [] }).expect(200);
    expect(await mappedEnvironments(desk.id)).toEqual([]);

    // A new account on the machine is still refused.
    await request(app).put(`/api/instance/ai-hosts/${desk.id}/environments`).send({ environmentIds: [second!.id] }).expect(200);
    await boundAgent(companyA, second!.id, (await account({ label: "Max three" })).id);
    const refused = await request(app).put(`/api/instance/ai-hosts/${desk.id}/environments`).send({ environmentIds: [] }).expect(409);
    expect(refused.body).toMatchObject({ code: "device_account_limit", details: { deviceId: machine.id, deviceName: "SSH · F tunnel", limit: 1, inUse: 3 } });
    expect(await mappedEnvironments(desk.id)).toEqual([second!.id]);
  });

  it("answers 404 for a malformed device id on every route that takes one", async () => {
    const app = appFor(admin);
    const patched = await request(app).patch("/api/instance/ai-hosts/not-a-uuid").send({ name: "x" });
    expect(patched.status).toBe(404);
    expect(patched.body).toEqual({ error: "Device not found" });
    expect((await request(app).delete("/api/instance/ai-hosts/not-a-uuid")).status).toBe(404);
    const mapped = await request(app).put("/api/instance/ai-hosts/not-a-uuid/environments").send({ environmentIds: [] });
    expect(mapped.status).toBe(404);
    expect(mapped.body).toEqual({ error: "Device not found" });
    // Still for instance admins first.
    expect((await request(appFor(member)).delete("/api/instance/ai-hosts/not-a-uuid")).status).toBe(403);
  });

  it("logs a device change only when something changed", async () => {
    const app = appFor(admin);
    const shared = await account({ label: "Max one" });
    await boundAgent(companyA, sharedEnvId, shared.id);
    const device = (await request(app).post("/api/instance/ai-hosts").send({ name: "Build box", kind: "ssh_host" }).expect(201)).body;
    await request(app).put(`/api/instance/ai-hosts/${device.id}/environments`).send({ environmentIds: [sharedEnvId] }).expect(200);
    await db.delete(activityLog);

    await request(app).patch(`/api/instance/ai-hosts/${device.id}`).send({}).expect(200);
    await request(app).patch(`/api/instance/ai-hosts/${device.id}`).send({ name: "Build box", maxAccounts: 3 }).expect(200);
    expect(await db.select().from(activityLog)).toHaveLength(0);

    await request(app).patch(`/api/instance/ai-hosts/${device.id}`).send({ name: "Build box", maxAccounts: 2 }).expect(200);
    expect((await db.select().from(activityLog)).map((row) => ({ companyId: row.companyId, details: row.details }))).toEqual([
      { companyId: companyA, details: { deviceName: "Build box", changedKeys: ["maxAccounts"], maxAccounts: 2 } },
    ]);
  });

  // Fork: P7 removed the host-pool failover. A legacy host-pool run that hits a
  // limit marks its own account and waits for that account's reset in the
  // account lane (spec 4.6); nothing moves it to the host's other account.
  describe("usage-limit wait", () => {
    async function setup() {
      const svc = aiAccountHostService(db);
      const host = await svc.createHost({ name: "Runner", kind: "ssh_host" }, "admin");
      const first = await account({ label: "M", hostId: host.id, ownerUserId: null, createdByUserId: "admin" });
      const second = await account({ label: "Y", hostId: host.id, ownerUserId: null, createdByUserId: "admin", credentialType: "api_key", value: key(2) });
      return { host, first, second };
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
          // A task that moved between accounts before the failover was removed.
          ...(input.failovers ? { aiConnectionFailovers: input.failovers } : {}),
        },
      });
      return id;
    }

    it("rests the account until its reset and waits for it instead of moving to the host's other account", async () => {
      const { host, first, second } = await setup();
      const reset = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
      const runId = await failedRun({ hostId: host.id, accountId: first.id, retryNotBefore: reset });
      expect(await heartbeatService(db).handleProviderLimit(runId)).toMatchObject({ handled: true, via: "pool_account" });
      const [rested] = await db.select().from(aiAccounts).where(eq(aiAccounts.id, first.id));
      expect(rested).toMatchObject({ limitReason: "provider_quota", limitRunId: runId, limitSource: "provider", limitStrikes: 1 });
      expect(rested!.exhaustedUntil?.toISOString()).toBe(reset);
      const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
      expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: "ai_account_wait" });
      expect(retry!.contextSnapshot).toMatchObject({ resourceWait: { kind: "ai_account", reason: "usage_limit", accountId: first.id } });
      expect(retry!.contextSnapshot).not.toHaveProperty("aiConnectionFailovers");
      // The host's other account is untouched.
      const [other] = await db.select().from(aiAccounts).where(eq(aiAccounts.id, second.id));
      expect(other).toMatchObject({ exhaustedUntil: null, limitStrikes: 0 });
      const logged = await db.select().from(activityLog).where(eq(activityLog.action, "ai_account.limit_reached"));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({ companyId, entityId: first.id, runId });
    });

    it("rests an API key without credit for a day", async () => {
      const { host, second } = await setup();
      const before = Date.now();
      const runId = await failedRun({ hostId: host.id, accountId: second.id, error: "Credit balance is too low to access the Anthropic API" });
      expect(await heartbeatService(db).handleProviderLimit(runId)).toMatchObject({ handled: true, reason: "credit_balance" });
      const [rested] = await db.select().from(aiAccounts).where(eq(aiAccounts.id, second.id));
      expect(rested!.limitReason).toBe("credit_balance");
      const hours = (rested!.exhaustedUntil!.getTime() - before) / 3_600_000;
      expect(hours).toBeGreaterThanOrEqual(23.9);
      expect(hours).toBeLessThanOrEqual(24.1);
    });

    it("waits on its own account however often the task moved before", async () => {
      const { host, first } = await setup();
      const runId = await failedRun({ hostId: host.id, accountId: first.id, failovers: 4 });
      expect(await heartbeatService(db).handleProviderLimit(runId)).toMatchObject({ handled: true });
      const retries = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
      expect(retries.map((retry) => retry.scheduledRetryReason)).toEqual(["ai_account_wait"]);
    });
  });
});
