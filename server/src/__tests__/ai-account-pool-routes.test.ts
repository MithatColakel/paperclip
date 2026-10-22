import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agents,
  aiAccountAgentBindings,
  aiAccountHosts,
  aiAccounts,
  approvals,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  environments,
  heartbeatRuns,
  principalPermissionGrants,
  projects,
} from "@paperclipai/db";
import type { DeploymentMode } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { aiAccountPoolRoutes } from "../routes/ai-account-pool.js";
import { agentRoutes } from "../routes/agents.js";
import { approvalRoutes } from "../routes/approvals.js";
import { companyRoutes } from "../routes/companies.js";
import { instanceSettingsRoutes } from "../routes/instance-settings.js";
import { projectRoutes } from "../routes/projects.js";
import { errorHandler } from "../middleware/error-handler.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { aiConnectionPoolService } from "../services/ai-connection-pool.js";
import { recheckDeviceLimits } from "../services/ai-account-pool.js";
import { deviceForEnvironment } from "../services/execution-devices.js";
import { readWakeEpochs } from "../services/resource-waits/epochs.js";

type Actor = Express.Request["actor"];

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping embedded Postgres account pool route tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

const sub = (tag: string) => `sk-ant-oat01-${tag.padEnd(40, "x")}`;
const key = (tag: string) => `sk-ant-api03-${tag.padEnd(40, "y")}`;

describeEmbeddedPostgres("account pool routes", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let localEnvironment: typeof environments.$inferSelect;
  const actors: Record<string, Actor> = {};

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "b".repeat(64));
    database = await startEmbeddedPostgresTestDatabase("paperclip-ai-account-pool-routes-");
    db = createDb(database.connectionString);
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await database?.cleanup();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate table companies, plugins, ai_account_hosts, ai_accounts, environments, "user" cascade`);
    [localEnvironment] = await db.insert(environments).values({ name: "Local", driver: "local" }).returning();
    for (const name of Object.keys(actors)) delete actors[name];
  });

  const tag = () => randomUUID().slice(0, 8);

  function app(deploymentMode: DeploymentMode = "authenticated") {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.actor = actors[req.header("x-actor") ?? ""] ?? { type: "none", source: "none" };
      next();
    });
    server.use("/api", aiAccountPoolRoutes(db, { deploymentMode }));
    server.use(errorHandler);
    return server;
  }

  async function company(name: string) {
    const id = randomUUID();
    await db.insert(companies).values({ id, name, issuePrefix: `C${id.replaceAll("-", "").slice(0, 7).toUpperCase()}` });
    return id;
  }

  /** A signed-in user with active memberships; the actor mirrors them as the auth middleware does. */
  async function person(name: string, memberships: Array<[string, string]>, opts: { instanceAdmin?: boolean } = {}) {
    const at = new Date();
    await db.insert(authUsers).values({ id: name, name: `User ${name}`, email: `${name}@example.com`, emailVerified: true, createdAt: at, updatedAt: at });
    for (const [companyId, membershipRole] of memberships) {
      await db.insert(companyMemberships).values({ companyId, principalId: name, principalType: "user", status: "active", membershipRole });
    }
    actors[name] = {
      type: "board",
      source: "session",
      userId: name,
      companyIds: memberships.map(([companyId]) => companyId),
      memberships: memberships.map(([companyId, membershipRole]) => ({ companyId, membershipRole, status: "active" })),
      isInstanceAdmin: opts.instanceAdmin === true,
    };
    return name;
  }

  async function agent(companyId: string, overrides: Partial<typeof agents.$inferInsert> = {}) {
    const [row] = await db.insert(agents).values({ companyId, name: `Agent ${tag()}`, adapterType: "claude_local", ...overrides }).returning();
    return row!;
  }

  async function sshEnvironment(name = `ssh ${tag()}`) {
    const [row] = await db.insert(environments).values({ name, driver: "ssh", config: { host: `${tag()}.example.com`, port: 22, username: "runner" } }).returning();
    return row!;
  }

  async function addAccount(server: express.Express, actor: string, label: string, value = sub(`${label}-${tag()}`), extra: Record<string, unknown> = {}) {
    const response = await request(server).post("/api/me/ai-accounts").set("x-actor", actor)
      .send({ label, credentialType: value.startsWith("sk-ant-api") ? "api_key" : "subscription", value, ...extra });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return { id: response.body.id as string, value };
  }

  /** Every base table whose rows contain `needle` as text. */
  async function tablesContaining(needle: string): Promise<string[]> {
    const tables = await db.execute<{ table_name: string }>(sql`
      select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'
    `);
    const hits: string[] = [];
    for (const { table_name } of tables) {
      const [row] = await db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table_name)} t where t::text like ${`%${needle}%`}`);
      if (Number(row?.n ?? 0) > 0) hits.push(table_name);
    }
    return hits;
  }

  /** Two companies; A has every kind of actor, B has its own owner and accounts. */
  async function world() {
    const a = await company("Alpha");
    const b = await company("Bravo");
    await person("owner", [[a, "operator"]]);
    await person("other", [[a, "operator"]]);
    await person("cowner", [[a, "owner"]]);
    await person("admin", [[a, "admin"]]);
    await person("viewer", [[a, "viewer"]]);
    await person("ia-viewer", [[a, "viewer"]], { instanceAdmin: true });
    await person("ia-outsider", [[b, "operator"]], { instanceAdmin: true });
    await person("bowner", [[b, "owner"]]);
    const server = app();
    const x = await addAccount(server, "owner", "Xray");
    const y = await addAccount(server, "other", "Yankee");
    const zeta = await addAccount(server, "bowner", "Zeta-B-1");
    const zeta2 = await addAccount(server, "bowner", "Zeta-B-2");
    return { a, b, server, x, y, zeta, zeta2 };
  }

  const put = (server: express.Express, actor: string, agentId: string, body: Record<string, unknown>) =>
    request(server).put(`/api/agents/${agentId}/ai-account`).set("x-actor", actor).send(body);

  it("applies the binding rules of spec 5.1 to every kind of actor", async () => {
    const { a, server, x, y } = await world();
    const target = await agent(a, { defaultEnvironmentId: localEnvironment.id });
    actors.agent = { type: "agent", agentId: target.id, companyId: a, source: "agent_key" };

    // The account owner binds their own account to an unbound agent.
    const bound = await put(server, "owner", target.id, { mode: "pool_account", accountId: x.id });
    expect(bound.status, JSON.stringify(bound.body)).toBe(200);
    expect(bound.body).toMatchObject({ state: "pool_account", appliesFrom: "next_run", runningRunIds: [], warnings: [], account: { id: x.id, ownedByMe: true } });
    expect(bound.body.devices).toEqual([expect.objectContaining({ kind: "server", name: "Paperclip server" })]);

    // Another owner cannot replace or clear it, nor set the device login.
    for (const body of [{ mode: "pool_account", accountId: y.id }, { mode: "device_login" }]) {
      const refused = await put(server, "other", target.id, body);
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe("ai_account_binding_forbidden");
    }
    expect((await request(server).delete(`/api/agents/${target.id}/ai-account`).set("x-actor", "other")).status).toBe(403);

    // Viewers, agents and instance admins outside the company change nothing.
    expect((await put(server, "viewer", target.id, { mode: "device_login" })).status).toBe(403);
    const asAgent = await put(server, "agent", target.id, { mode: "device_login" });
    expect(asAgent.status).toBe(403);
    expect(asAgent.body.code).toBe("ai_account_binding_forbidden");
    const outsider = await put(server, "ia-outsider", target.id, { mode: "device_login" });
    expect(outsider.status).toBe(403);
    expect(outsider.body.code).toBe("ai_account_binding_forbidden");

    // Company admins change any binding, including an instance admin who is a viewer here (D4).
    expect((await put(server, "ia-viewer", target.id, { mode: "pool_account", accountId: y.id })).status).toBe(200);
    expect((await put(server, "cowner", target.id, { mode: "pool_account", accountId: x.id })).status).toBe(200);
    expect((await put(server, "admin", target.id, { mode: "device_login" })).status).toBe(200);

    // On the device login, another owner may bind their own account, then switch it back.
    expect((await put(server, "other", target.id, { mode: "pool_account", accountId: y.id })).status).toBe(200);
    expect((await put(server, "other", target.id, { mode: "device_login" })).status).toBe(200);
    expect((await request(server).delete(`/api/agents/${target.id}/ai-account`).set("x-actor", "owner")).status).toBe(403);

    // Reads follow company access; canChange follows spec 5.1.
    const viewed = await request(server).get(`/api/agents/${target.id}/ai-account`).set("x-actor", "viewer");
    expect(viewed.status).toBe(200);
    expect(viewed.body).toMatchObject({ mode: "device_login", canChange: false, canBindAny: false });
    expect((await request(server).get(`/api/agents/${target.id}/ai-account`).set("x-actor", "admin")).body).toMatchObject({ canChange: true, canBindAny: true });
    expect((await request(server).get(`/api/agents/${target.id}/ai-account`).set("x-actor", "agent")).body).toMatchObject({ options: [], canChange: false });
    expect((await request(server).get(`/api/agents/${target.id}/ai-account`).set("x-actor", "ia-outsider")).status).toBe(404);

    expect((await request(server).delete(`/api/agents/${target.id}/ai-account`).set("x-actor", "admin")).status).toBe(204);
    const activity = await db.select().from(activityLog).where(and(eq(activityLog.entityId, target.id), eq(activityLog.companyId, a)));
    expect(activity.map((entry) => entry.action)).toContain("ai_account.binding_cleared");
  });

  it("lets the local board bind in local_trusted mode", async () => {
    const companyId = await company("Local");
    actors.local = { type: "board", source: "local_implicit", userId: "local-board", isInstanceAdmin: true };
    const server = app("local_trusted");
    const account = await addAccount(server, "local", "Mine");
    const target = await agent(companyId, { defaultEnvironmentId: localEnvironment.id });
    const bound = await put(server, "local", target.id, { mode: "pool_account", accountId: account.id });
    expect(bound.status, JSON.stringify(bound.body)).toBe(200);
    expect(bound.body.account).toMatchObject({ id: account.id, ownedByMe: true });
  });

  it("refuses unknown devices and unaccepted credential types, and binds on the server and on another user's device", async () => {
    const { a, server, x } = await world();
    const apiKey = await addAccount(server, "owner", "Key", key(`k-${tag()}`));
    const [orphan] = await db.insert(environments).values({ name: "Orphan sandbox", driver: "sandbox", config: { provider: "nobody" } }).returning();
    const unmapped = await agent(a, { defaultEnvironmentId: orphan!.id });
    const unknown = await put(server, "owner", unmapped.id, { mode: "pool_account", accountId: x.id });
    expect(unknown.status).toBe(422);
    expect(unknown.body).toMatchObject({ code: "ai_account_incompatible", details: { reason: "device_unknown", environmentName: "Orphan sandbox" } });

    // A sandbox target that takes subscriptions only, on a device another user owns (display only).
    const pluginKey = `test.box.${tag()}`;
    const [plugin] = await db.execute<{ id: string }>(sql`
      insert into plugins (plugin_key, package_name, version, status, manifest_json)
      values (${pluginKey}, ${pluginKey}, '1.0.0', 'ready', ${JSON.stringify({ id: pluginKey, displayName: "Box", environmentDrivers: [{ driverKey: "box", kind: "sandbox_provider", displayName: "Box" }] })}::jsonb)
      returning id
    `);
    const { upsertPluginTargetByTargetKey } = await import("../services/execution-devices.js");
    await upsertPluginTargetByTargetKey(db, {
      pluginId: plugin!.id,
      provider: "box",
      target: { targetKey: "d-1", label: "Build box", configMatch: { deviceId: "d-1" }, state: "available", acceptedCredentialTypes: ["subscription"], ownerUserId: "bowner" } as never,
    });
    const [boxEnvironment] = await db.insert(environments).values({ name: "Box", driver: "sandbox", config: { provider: "box", deviceId: "d-1" } }).returning();
    const boxed = await agent(a, { defaultEnvironmentId: boxEnvironment!.id });
    const typeRefused = await put(server, "owner", boxed.id, { mode: "pool_account", accountId: apiKey.id });
    expect(typeRefused.status).toBe(422);
    expect(typeRefused.body).toMatchObject({ code: "ai_account_incompatible", details: { reason: "credential_type_unsupported", deviceName: "Build box" } });
    const onOwnedDevice = await put(server, "owner", boxed.id, { mode: "pool_account", accountId: x.id });
    expect(onOwnedDevice.status, JSON.stringify(onOwnedDevice.body)).toBe(200);
    expect(onOwnedDevice.body.devices).toEqual([expect.objectContaining({ name: "Build box", owner: expect.objectContaining({ userId: "bowner" }) })]);

    // A Claude account cannot go on another adapter, but a left-over selection can always be removed.
    const codex = await agent(a, { adapterType: "codex_local" });
    const adapterRefused = await put(server, "admin", codex.id, { mode: "pool_account", accountId: x.id });
    expect(adapterRefused.status).toBe(422);
    expect(adapterRefused.body).toMatchObject({ code: "ai_account_incompatible", details: { reason: "adapter_unsupported" } });
    await db.insert(aiAccountAgentBindings).values({ agentId: codex.id, companyId: a, mode: "pool_account", accountId: x.id });
    const listed = await request(server).get(`/api/companies/${a}/ai-account-bindings`).set("x-actor", "admin");
    expect(listed.body.bindings.find((entry: { agentId: string }) => entry.agentId === codex.id)).toMatchObject({ supported: false, mode: "pool_account", canChange: true });
    expect((await request(server).get(`/api/agents/${codex.id}/ai-account`).set("x-actor", "admin")).body).toMatchObject({ supported: false, mode: "pool_account" });
    expect((await request(server).delete(`/api/agents/${codex.id}/ai-account`).set("x-actor", "owner")).status).toBe(204);
  });

  it("names only the company's own accounts when a device is full, and never another company's labels", async () => {
    const { a, b, server, x, y, zeta, zeta2 } = await world();
    const shared = await sshEnvironment("shared runner");
    const bravo1 = await agent(b, { defaultEnvironmentId: shared.id });
    const bravo2 = await agent(b, { defaultEnvironmentId: shared.id });
    expect((await put(server, "bowner", bravo1.id, { mode: "pool_account", accountId: zeta.id })).status).toBe(200);
    expect((await put(server, "bowner", bravo2.id, { mode: "pool_account", accountId: zeta2.id })).status).toBe(200);
    // A's admin cannot reach B's agents, and B's accounts are not eligible in A.
    expect((await put(server, "admin", bravo1.id, { mode: "pool_account", accountId: x.id })).status).toBe(404);
    const alpha1 = await agent(a, { defaultEnvironmentId: shared.id });
    const foreign = await put(server, "admin", alpha1.id, { mode: "pool_account", accountId: zeta.id });
    expect(foreign.status).toBe(422);
    expect(foreign.body).toMatchObject({ code: "ai_account_not_eligible" });
    expect(JSON.stringify(foreign.body)).not.toContain("Zeta");
    // A missing account answers exactly like another company's account.
    const missing = await put(server, "admin", alpha1.id, { mode: "pool_account", accountId: randomUUID() });
    expect({ status: missing.status, body: missing.body }).toEqual({ status: foreign.status, body: foreign.body });
    expect((await put(server, "owner", alpha1.id, { mode: "pool_account", accountId: x.id })).status).toBe(200);
    const alpha2 = await agent(a, { defaultEnvironmentId: shared.id });
    const full = await put(server, "other", alpha2.id, { mode: "pool_account", accountId: y.id });
    expect(full.status).toBe(409);
    expect(full.body).toMatchObject({
      code: "device_account_limit",
      details: { code: "device_account_limit", limit: 3, inUse: 3, accounts: ["Xray"], otherCompaniesAccounts: 2 },
    });
    expect(JSON.stringify(full.body)).not.toContain("Zeta");

    const options = await request(server).get(`/api/companies/${a}/ai-accounts?agentId=${alpha2.id}`).set("x-actor", "other");
    expect(options.status).toBe(200);
    expect(JSON.stringify(options.body)).not.toContain("Zeta");
    expect(options.body.canBindAny).toBe(false);
    const byLabel = new Map(options.body.accounts.map((option: { label: string }) => [option.label, option]));
    expect(byLabel.get("Xray")).toMatchObject({ canBind: false, selectable: false, reason: "not_permitted", onAgentDevice: true, owner: { email: "ow•••@example.com" } });
    expect(byLabel.get("Yankee")).toMatchObject({ canBind: true, ownedByMe: true, selectable: false, reason: "device_account_limit", onAgentDevice: false, owner: { email: "other@example.com" } });
    const detail = await request(server).get(`/api/agents/${alpha2.id}/ai-account`).set("x-actor", "other");
    expect(detail.body.options.find((option: { id: string }) => option.id === y.id)).toMatchObject({ selectable: false, reason: "device_account_limit" });
    for (const path of [`/api/companies/${a}/ai-accounts`, `/api/companies/${a}/ai-account-bindings`, "/api/me/ai-accounts"]) {
      const response = await request(server).get(path).set("x-actor", "admin");
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toContain("Zeta");
    }
    // Agents never list a company's accounts.
    actors.agent = { type: "agent", agentId: alpha1.id, companyId: a, source: "agent_key" };
    expect((await request(server).get(`/api/companies/${a}/ai-accounts`).set("x-actor", "agent")).status).toBe(403);
  });

  it("imports the server's token for instance admins only, and a personal Claude connection for its owner only", async () => {
    const { a, server } = await world();
    const envToken = sub(`server-env-${tag()}`);
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", envToken);
    try {
      const refused = await request(server).post("/api/me/ai-accounts").set("x-actor", "owner")
        .send({ label: "Server", credentialType: "subscription", importFrom: { kind: "server_env" } });
      expect(refused.status).toBe(403);
      const imported = await request(server).post("/api/me/ai-accounts").set("x-actor", "ia-viewer")
        .send({ label: "Server", credentialType: "subscription", importFrom: { kind: "server_env" } });
      expect(imported.status, JSON.stringify(imported.body)).toBe(201);
      expect(JSON.stringify(imported.body)).not.toContain(envToken);
      const [row] = await db.select().from(aiAccounts).where(eq(aiAccounts.id, imported.body.id));
      expect(row).toMatchObject({ ownerUserId: "ia-viewer", createdByUserId: "ia-viewer", hostId: null });
    } finally {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    }

    const personalToken = sub(`personal-${tag()}`);
    const connection = await aiConnectionService(db).save(a, "owner", {
      provider: "anthropic", method: "subscription", ownership: "personal", name: "Owner's Claude", loginSessionId: "fixture", agentIds: [], allAgents: true,
    }, personalToken);
    const body = { label: "Imported", credentialType: "subscription", importFrom: { kind: "ai_connection", companyId: a, connectionId: connection.connectionId } };
    expect((await request(server).post("/api/me/ai-accounts").set("x-actor", "other").send(body)).status).toBe(403);
    const mine = await request(server).post("/api/me/ai-accounts").set("x-actor", "owner").send(body);
    expect(mine.status, JSON.stringify(mine.body)).toBe(201);
    expect(JSON.stringify(mine.body)).not.toContain(personalToken);
    const [importedRow] = await db.select().from(aiAccounts).where(eq(aiAccounts.id, mine.body.id));
    expect(importedRow).toMatchObject({ ownerUserId: "owner" });
    expect(await tablesContaining(envToken)).toEqual([]);
    expect(await tablesContaining(personalToken)).toEqual([]);
  });

  it("keeps every token out of the database, responses and activity, and audits accounts only in the owner's companies", async () => {
    const { a, b, server, x } = await world();
    const replaced = sub(`replacement-${tag()}`);
    const replacedResponse = await request(server).put(`/api/me/ai-accounts/${x.id}/credential`).set("x-actor", "owner").send({ value: replaced });
    expect(replacedResponse.status).toBe(200);
    expect(JSON.stringify(replacedResponse.body)).not.toContain(replaced);
    expect((await request(server).put(`/api/me/ai-accounts/${x.id}/credential`).set("x-actor", "owner").send({ value: key(`wrong-${tag()}`) })).status).toBe(422);
    for (const token of [x.value, replaced]) {
      expect(await tablesContaining(token)).toEqual([]);
    }
    const listed = await request(server).get("/api/me/ai-accounts").set("x-actor", "owner");
    expect(listed.body.accounts).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(replaced);
    const created = await db.select().from(activityLog).where(and(eq(activityLog.entityId, x.id), eq(activityLog.action, "ai_account.created")));
    expect(created.map((entry) => entry.companyId)).toEqual([a]);
    expect((await db.select().from(activityLog).where(and(eq(activityLog.entityId, x.id), eq(activityLog.companyId, b))))).toHaveLength(0);
    // Non-owners do not see the account at all.
    expect((await request(server).patch(`/api/me/ai-accounts/${x.id}`).set("x-actor", "other").send({ label: "Mine now" })).status).toBe(404);
    expect((await request(server).post(`/api/me/ai-accounts/${x.id}/clear-limit`).set("x-actor", "admin")).status).toBe(404);
    // Agents have no `/me`.
    actors.agent = { type: "agent", agentId: randomUUID(), companyId: a, source: "agent_key" };
    expect((await request(server).get("/api/me/ai-accounts").set("x-actor", "agent")).status).toBe(403);
  });

  it("removes an account only after release, and lets owners pause, resume and rename", async () => {
    const { a, server, x } = await world();
    const target = await agent(a, { defaultEnvironmentId: localEnvironment.id });
    expect((await put(server, "owner", target.id, { mode: "pool_account", accountId: x.id })).status).toBe(200);
    const paused = await request(server).patch(`/api/me/ai-accounts/${x.id}`).set("x-actor", "owner").send({ status: "disabled", label: "Xray two" });
    expect(paused.body).toMatchObject({ status: "disabled", state: "withdrawn", label: "Xray two" });
    const resumed = await request(server).patch(`/api/me/ai-accounts/${x.id}`).set("x-actor", "owner").send({ status: "active" });
    expect(resumed.body).toMatchObject({ status: "active", state: "active", usedBy: [{ companyId: a, agents: [{ agentId: target.id }] }], otherCompanies: 0 });
    const inUse = await request(server).delete(`/api/me/ai-accounts/${x.id}`).set("x-actor", "owner");
    expect(inUse.status).toBe(409);
    expect(inUse.body).toMatchObject({ code: "ai_account_in_use", details: { bindings: [{ agentId: target.id, agentName: target.name, companyId: a, companyName: "Alpha" }], otherCompanies: 0 } });
    expect((await request(server).delete(`/api/me/ai-accounts/${x.id}?release=true`).set("x-actor", "owner")).status).toBe(204);
    expect((await request(server).get(`/api/agents/${target.id}/ai-account`).set("x-actor", "owner")).body).toMatchObject({ state: "unassigned", mode: "pool_account", account: null });
  });

  it("gives instance admins every account: disable, enable, transfer, clear and remove", async () => {
    const { a, server, x } = await world();
    expect((await request(server).get("/api/instance/ai-accounts").set("x-actor", "admin")).status).toBe(403);
    const all = await request(server).get("/api/instance/ai-accounts").set("x-actor", "ia-viewer");
    expect(all.status).toBe(200);
    expect(all.body.accounts.map((account: { label: string }) => account.label).sort()).toEqual(["Xray", "Yankee", "Zeta-B-1", "Zeta-B-2"]);

    const disabled = await request(server).patch(`/api/instance/ai-accounts/${x.id}`).set("x-actor", "ia-viewer").send({ adminDisabled: true, reason: "Audit" });
    expect(disabled.body).toMatchObject({ adminDisabled: true, adminDisabledReason: "Audit", state: "admin_disabled" });
    const [row] = await db.select().from(aiAccounts).where(eq(aiAccounts.id, x.id));
    expect(row!.poolEnabled).toBe(false);
    expect((await request(server).patch(`/api/instance/ai-accounts/${x.id}`).set("x-actor", "ia-viewer").send({ adminDisabled: false })).body)
      .toMatchObject({ adminDisabled: false, adminDisabledReason: null, state: "active" });

    const unknown = await request(server).patch(`/api/instance/ai-accounts/${x.id}`).set("x-actor", "ia-viewer").send({ ownerUserId: "nobody" });
    expect(unknown.status).toBe(422);
    const target = await agent(a, { defaultEnvironmentId: localEnvironment.id });
    expect((await put(server, "owner", target.id, { mode: "pool_account", accountId: x.id })).status).toBe(200);
    const transferred = await request(server).patch(`/api/instance/ai-accounts/${x.id}`).set("x-actor", "ia-viewer").send({ ownerUserId: "other" });
    expect(transferred.status).toBe(200);
    expect(transferred.body.owner).toMatchObject({ userId: "other" });
    expect(transferred.body.companies).toEqual([{ companyId: a, companyName: "Alpha", agentCount: 1 }]);
    expect((await request(server).post(`/api/instance/ai-accounts/${x.id}/clear-limit`).set("x-actor", "ia-viewer")).status).toBe(200);
    const inUse = await request(server).delete(`/api/instance/ai-accounts/${x.id}`).set("x-actor", "ia-viewer");
    expect(inUse.status).toBe(409);
    expect(inUse.body.code).toBe("ai_account_in_use");
    expect((await request(server).delete(`/api/instance/ai-accounts/${x.id}?release=true`).set("x-actor", "ia-viewer")).status).toBe(204);
    expect((await request(server).delete(`/api/instance/ai-accounts/not-a-uuid`).set("x-actor", "ia-viewer")).status).toBe(404);
  });

  describe("agent routes hooks", () => {
    function agentsApp() {
      const server = express();
      server.use(express.json());
      server.use((req, _res, next) => {
        req.actor = actors[req.header("x-actor") ?? ""] ?? { type: "none", source: "none" };
        next();
      });
      server.use("/api", agentRoutes(db, { deploymentMode: "local_trusted" }));
      server.use("/api", aiAccountPoolRoutes(db, { deploymentMode: "local_trusted" }));
      server.use(errorHandler);
      return server;
    }

    it("refuses an agent moving itself while pool-bound, and saves a board move with its config revision", async () => {
      const companyId = await company("Hooks");
      actors.local = { type: "board", source: "local_implicit", userId: "local-board", isInstanceAdmin: true };
      const server = agentsApp();
      const account = await addAccount(server, "local", "Pool");
      const target = await agent(companyId, { defaultEnvironmentId: localEnvironment.id });
      actors.self = { type: "agent", agentId: target.id, companyId, source: "agent_key" };
      expect((await put(server, "local", target.id, { mode: "pool_account", accountId: account.id })).status).toBe(200);
      const ssh = await sshEnvironment();
      const [waiting] = await db.insert(heartbeatRuns).values({
        companyId,
        agentId: target.id,
        status: "scheduled_retry",
        scheduledRetryReason: "environment_wait",
        scheduledRetryAt: new Date(Date.now() + 60 * 60_000),
        contextSnapshot: { resourceWait: { version: 1, episodeId: randomUUID(), kind: "environment", reason: "offline" } },
      }).returning();
      const selfMove = await request(server).patch(`/api/agents/${target.id}`).set("x-actor", "self").send({ defaultEnvironmentId: ssh.id });
      expect(selfMove.status, JSON.stringify(selfMove.body)).toBe(403);
      expect(selfMove.body.code).toBe("ai_account_binding_forbidden");

      const moved = await request(server).patch(`/api/agents/${target.id}`).set("x-actor", "local").send({ defaultEnvironmentId: ssh.id });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      expect(moved.body.defaultEnvironmentId).toBe(ssh.id);
      const [revision] = await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, target.id)).orderBy(desc(agentConfigRevisions.createdAt)).limit(1);
      expect(revision?.changedKeys).toContain("defaultEnvironmentId");
      // The binding stays, and the move woke the agent's waits.
      const [binding] = await db.select().from(aiAccountAgentBindings).where(eq(aiAccountAgentBindings.agentId, target.id));
      expect(binding).toMatchObject({ mode: "pool_account", accountId: account.id });
      const [woken] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, waiting!.id));
      expect(woken!.scheduledRetryAt!.getTime()).toBeLessThanOrEqual(Date.now());

      // A revision rollback that moves the agent passes the same placement hook.
      expect((await request(server).patch(`/api/agents/${target.id}`).set("x-actor", "local").send({ defaultEnvironmentId: localEnvironment.id })).status).toBe(200);
      const rollbackUrl = `/api/agents/${target.id}/config-revisions/${revision!.id}/rollback`;
      const selfRollback = await request(server).post(rollbackUrl).set("x-actor", "self").send({});
      expect(selfRollback.status, JSON.stringify(selfRollback.body)).toBe(403);
      expect(selfRollback.body.code).toBe("ai_account_binding_forbidden");
      const rolledBack = await request(server).post(rollbackUrl).set("x-actor", "local").send({});
      expect(rolledBack.status, JSON.stringify(rolledBack.body)).toBe(200);
      expect(rolledBack.body.defaultEnvironmentId).toBe(ssh.id);
    });

    it("clears the over-limit flag of the device a PATCH or a rollback moves a bound agent off, once the move commits", async () => {
      const companyId = await company("Crowded");
      actors.local = { type: "board", source: "local_implicit", userId: "local-board", isInstanceAdmin: true };
      const server = agentsApp();
      const ssh = await sshEnvironment();
      const [mover, stayer] = [await agent(companyId, { defaultEnvironmentId: ssh.id }), await agent(companyId, { defaultEnvironmentId: ssh.id })];
      for (const [label, pinned] of [["Mover", mover], ["Stayer", stayer]] as const) {
        expect((await put(server, "local", pinned.id, { mode: "pool_account", accountId: (await addAccount(server, "local", label)).id })).status).toBe(200);
      }
      const device = (await deviceForEnvironment(db, ssh))!;
      const overLimitAt = async () =>
        (await db.select({ overLimitAt: aiAccountHosts.overLimitAt }).from(aiAccountHosts).where(eq(aiAccountHosts.id, device.id)))[0]!.overLimitAt;
      /** Both bound agents on the runner, lowered to one account: flagged over its limit, with a wait of the mover's to wake. */
      async function crowd() {
        await db.update(agents).set({ defaultEnvironmentId: ssh.id }).where(eq(agents.id, mover.id));
        await db.update(aiAccountHosts).set({ maxAccounts: 1 }).where(eq(aiAccountHosts.id, device.id));
        expect(await recheckDeviceLimits(db, { deviceIds: [device.id] })).toEqual([expect.objectContaining({ inUse: 2, limit: 1, change: "flagged" })]);
        const [waiting] = await db.insert(heartbeatRuns).values({
          companyId,
          agentId: mover.id,
          status: "scheduled_retry",
          scheduledRetryReason: "environment_wait",
          scheduledRetryAt: new Date(Date.now() + 60 * 60_000),
          contextSnapshot: { resourceWait: { version: 1, episodeId: randomUUID(), kind: "environment", reason: "offline" } },
        }).returning();
        return { waiting: waiting!, before: await readWakeEpochs(db, { environmentId: ssh.id, agentId: mover.id }) };
      }
      async function expectMovedOff(response: { status: number; body: { defaultEnvironmentId?: unknown } }, crowded: Awaited<ReturnType<typeof crowd>>) {
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(response.body.defaultEnvironmentId).toBe(localEnvironment.id);
        // The re-check read the committed move: the runner fits its limit again.
        expect(await overLimitAt()).toBeNull();
        const [woken] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, crowded.waiting.id));
        expect(woken!.scheduledRetryAt!.getTime()).toBeLessThanOrEqual(Date.now());
        const after = await readWakeEpochs(db, { environmentId: ssh.id, agentId: mover.id });
        expect(after.bindingUpdatedAt! > crowded.before.bindingUpdatedAt!).toBe(true);
        expect(after.environmentEpoch!).toBeGreaterThan(crowded.before.environmentEpoch!);
      }

      const patched = await crowd();
      await expectMovedOff(await request(server).patch(`/api/agents/${mover.id}`).set("x-actor", "local").send({ defaultEnvironmentId: localEnvironment.id }), patched);
      const [revision] = await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, mover.id)).orderBy(desc(agentConfigRevisions.createdAt)).limit(1);
      expect(revision!.afterConfig).toMatchObject({ defaultEnvironmentId: localEnvironment.id });

      // A rollback to that revision moves the agent off the runner again.
      const rolledBack = await crowd();
      await expectMovedOff(await request(server).post(`/api/agents/${mover.id}/config-revisions/${revision!.id}/rollback`).set("x-actor", "local").send({}), rolledBack);
    });

    it("refuses new company pool bindings and routers for Claude agents", async () => {
      const companyId = await company("Retired");
      actors.local = { type: "board", source: "local_implicit", userId: "local-board", isInstanceAdmin: true };
      const server = agentsApp();
      const target = await agent(companyId);
      const pooled = await request(server).patch(`/api/agents/${target.id}`).set("x-actor", "local")
        .send({ runtimeConfig: { aiConnection: { provider: "anthropic", method: "subscription", mode: "company_pool" } } });
      expect(pooled.status, JSON.stringify(pooled.body)).toBe(422);
      expect(pooled.body.code).toBe("ai_connection_company_pool_retired");
      const routed = await request(server).patch(`/api/agents/${target.id}`).set("x-actor", "local")
        .send({ runtimeConfig: { aiConnection: { mode: "router", connectionId: randomUUID() } } });
      expect(routed.status, JSON.stringify(routed.body)).toBe(422);
      expect(routed.body.code).toBe("ai_connection_router_unsupported");
      // Switching another binding to the company pool is a change too.
      const personal = await agent(companyId, { runtimeConfig: { aiConnection: { provider: "anthropic", method: "subscription", mode: "responsible_user" } } });
      const switched = await request(server).patch(`/api/agents/${personal.id}`).set("x-actor", "local")
        .send({ runtimeConfig: { aiConnection: { provider: "anthropic", method: "subscription", mode: "company_pool" } } });
      expect(switched.status, JSON.stringify(switched.body)).toBe(422);
      expect(switched.body.code).toBe("ai_connection_company_pool_retired");
    });

    it("keeps an existing company pool agent editable and movable, with or without a migrated binding", async () => {
      const companyId = await company("Pooled");
      await person("local-board", [[companyId, "owner"]]);
      actors.local = { type: "board", source: "local_implicit", userId: "local-board", isInstanceAdmin: true };
      const server = agentsApp();
      // A company pool whose only member is at its limit: upstream accepts such a pool without calling the provider.
      const member = await aiConnectionService(db).save(companyId, "local-board", {
        provider: "anthropic", method: "subscription", ownership: "shared", name: "Pool member", loginSessionId: "fixture", allAgents: true, agentIds: [],
      }, sub(`member-${tag()}`));
      await aiConnectionPoolService(db).replace(companyId, "local-board", { provider: "anthropic", members: [member] });
      await aiConnectionPoolService(db).markExhausted({ companyId, connectionId: member.connectionId, until: new Date(Date.now() + 60 * 60_000), reason: "provider_quota", source: "manual" });
      const poolBinding = { provider: "anthropic", method: "subscription", mode: "company_pool" };
      const patch = (agentId: string, body: Record<string, unknown>) => request(server).patch(`/api/agents/${agentId}`).set("x-actor", "local").send(body);

      // Stored in jsonb, the binding comes back with its keys in another order; it is still unchanged.
      const plain = await agent(companyId, { runtimeConfig: { aiConnection: poolBinding } });
      const renamed = await patch(plain.id, { name: "Renamed pool agent" });
      expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
      const pinned = await patch(plain.id, { defaultEnvironmentId: localEnvironment.id });
      expect(pinned.status, JSON.stringify(pinned.body)).toBe(200);
      expect(pinned.body.defaultEnvironmentId).toBe(localEnvironment.id);
      const resent = await patch(plain.id, { runtimeConfig: { aiConnection: poolBinding } });
      expect(resent.status, JSON.stringify(resent.body)).toBe(200);

      // A migrated binding row wins at run time; a move passes the placement hook instead.
      const account = await addAccount(server, "local", "Migrated");
      const migrated = await agent(companyId, { runtimeConfig: { aiConnection: poolBinding } });
      await db.insert(aiAccountAgentBindings).values({ agentId: migrated.id, companyId, mode: "pool_account", accountId: account.id, source: "migrated_company_pool", migrationNote: "fixture" });
      expect((await patch(migrated.id, { name: "Renamed migrated agent" })).status).toBe(200);
      const ssh = await sshEnvironment();
      const moved = await patch(migrated.id, { defaultEnvironmentId: ssh.id });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      expect(moved.body.defaultEnvironmentId).toBe(ssh.id);
      const full = await sshEnvironment("full runner");
      for (const label of ["Full-1", "Full-2", "Full-3"]) {
        const occupant = await agent(companyId, { defaultEnvironmentId: full.id });
        expect((await put(server, "local", occupant.id, { mode: "pool_account", accountId: (await addAccount(server, "local", label)).id })).status).toBe(200);
      }
      const refused = await patch(migrated.id, { defaultEnvironmentId: full.id });
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.code).toBe("device_account_limit");
      const [row] = await db.select({ defaultEnvironmentId: agents.defaultEnvironmentId }).from(agents).where(eq(agents.id, migrated.id));
      expect(row!.defaultEnvironmentId).toBe(ssh.id);
    });

    it("refuses moving an existing router agent onto the Claude adapter", async () => {
      const companyId = await company("Routed");
      actors.local = { type: "board", source: "local_implicit", userId: "local-board", isInstanceAdmin: true };
      const server = agentsApp();
      const routed = await agent(companyId, { adapterType: "codex_local", runtimeConfig: { aiConnection: { mode: "router", connectionId: randomUUID() } } });
      const moved = await request(server).patch(`/api/agents/${routed.id}`).set("x-actor", "local")
        .send({ adapterType: "claude_local", adapterConfig: { model: "claude-sonnet-5" } });
      expect(moved.status, JSON.stringify(moved.body)).toBe(422);
      expect(moved.body.code).toBe("ai_connection_router_unsupported");
      const [row] = await db.select({ adapterType: agents.adapterType }).from(agents).where(eq(agents.id, routed.id));
      expect(row!.adapterType).toBe("codex_local");
    });

    it("gives a hire of a company pool manager its responsible user's connection instead of the retired pool", async () => {
      const companyId = await company("Hiring");
      const userId = await person("hiring-owner", [[companyId, "owner"]]);
      await db.update(companies).set({ defaultResponsibleUserId: userId }).where(eq(companies.id, companyId));
      await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:create" });
      const manager = await agent(companyId, { name: "Manager", role: "ceo", runtimeConfig: { aiConnection: { provider: "anthropic", method: "subscription", mode: "company_pool" } } });
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: manager.id, status: "running", responsibleUserId: userId }).returning();
      const server = express();
      server.use(express.json());
      server.use((req, _res, next) => {
        req.actor = { type: "agent", agentId: manager.id, companyId, runId: run!.id, source: "agent_jwt", onBehalfOfUserId: userId, onBehalfOfMemberships: [{ companyId, membershipRole: "owner", status: "active" }] };
        next();
      });
      server.use("/api", agentRoutes(db));
      server.use(errorHandler);
      const hired = await request(server).post(`/api/companies/${companyId}/agent-hires`).send({ name: "Pool teammate", role: "engineer", adapterType: "claude_local" });
      expect(hired.status, JSON.stringify(hired.body)).toBe(201);
      const hire = hired.body.agent ?? hired.body;
      expect(hire.runtimeConfig.aiConnection).toEqual({ provider: "anthropic", method: "subscription", mode: "responsible_user" });
      // Naming the retired pool explicitly is still refused.
      const named = await request(server).post(`/api/companies/${companyId}/agent-hires`)
        .send({ name: "Named pool teammate", role: "engineer", adapterType: "claude_local", runtimeConfig: { aiConnection: { provider: "anthropic", method: "subscription", mode: "company_pool" } } });
      expect(named.status, JSON.stringify(named.body)).toBe(422);
      expect(named.body.code).toBe("ai_connection_company_pool_retired");
    });
  });

  describe("hire approval hook", () => {
    function approvalsApp() {
      const server = express();
      server.use(express.json());
      server.use((req, _res, next) => {
        req.actor = actors[req.header("x-actor") ?? ""] ?? { type: "none", source: "none" };
        next();
      });
      server.use("/api", approvalRoutes(db));
      server.use("/api", aiAccountPoolRoutes(db));
      server.use(errorHandler);
      return server;
    }

    async function hireApproval(companyId: string, pending: typeof agents.$inferSelect, payload: Record<string, unknown> = {}) {
      const [row] = await db.insert(approvals).values({
        companyId,
        type: "hire_agent",
        status: "pending",
        payload: { agentId: pending.id, name: pending.name, role: "engineer", adapterType: "claude_local", ...payload },
      }).returning();
      return row!;
    }

    const environmentOf = async (agentId: string) =>
      (await db.select({ defaultEnvironmentId: agents.defaultEnvironmentId, status: agents.status }).from(agents).where(eq(agents.id, agentId)))[0]!;

    it("checks a pool-bound hire's environment on approval, and leaves other hires to activation", async () => {
      const { a, x } = await world();
      const server = approvalsApp();
      const poolServer = app();
      const full = await sshEnvironment("full runner");
      for (const [owner, label] of [["other", "Occupant-1"], ["cowner", "Occupant-2"], ["admin", "Occupant-3"]] as const) {
        const occupant = await agent(a, { defaultEnvironmentId: full.id });
        expect((await put(poolServer, owner, occupant.id, { mode: "pool_account", accountId: (await addAccount(poolServer, owner, label)).id })).status).toBe(200);
      }
      const approve = (approvalId: string, body: Record<string, unknown>) =>
        request(server).post(`/api/approvals/${approvalId}/approve`).set("x-actor", "admin").send(body);

      // A pool-bound hire cannot be approved onto a full device; nothing changes.
      const bound = await agent(a, { status: "pending_approval" });
      expect((await put(poolServer, "owner", bound.id, { mode: "pool_account", accountId: x.id })).status).toBe(200);
      const boundApproval = await hireApproval(a, bound);
      const refused = await approve(boundApproval.id, { defaultEnvironmentId: full.id });
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.code).toBe("device_account_limit");
      expect(await environmentOf(bound.id)).toEqual({ defaultEnvironmentId: null, status: "pending_approval" });
      const approved = await approve(boundApproval.id, { defaultEnvironmentId: localEnvironment.id });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect(await environmentOf(bound.id)).toEqual({ defaultEnvironmentId: localEnvironment.id, status: "paused" });

      // Upstream leaves an approved hire paused while it prepares.
      // A hire without a pool account takes its environment at activation, as upstream does.
      const unbound = await agent(a, { status: "pending_approval" });
      const unboundApproval = await hireApproval(a, unbound);
      const activated = await approve(unboundApproval.id, { defaultEnvironmentId: full.id });
      expect(activated.status, JSON.stringify(activated.body)).toBe(200);
      expect(await environmentOf(unbound.id)).toEqual({ defaultEnvironmentId: full.id, status: "paused" });

      // An approval that fails leaves such a hire where it was.
      const broken = await agent(a, { status: "pending_approval" });
      const brokenApproval = await hireApproval(a, broken, { appearance: { schemaVersion: 2 } });
      const failed = await approve(brokenApproval.id, { defaultEnvironmentId: full.id });
      expect(failed.status).toBeGreaterThanOrEqual(400);
      expect(await environmentOf(broken.id)).toEqual({ defaultEnvironmentId: null, status: "pending_approval" });
      const [stillPending] = await db.select({ status: approvals.status }).from(approvals).where(eq(approvals.id, brokenApproval.id));
      expect(stillPending!.status).toBe("pending");

      // A pool-bound hire too: only the activation writes its checked move.
      const brokenBound = await agent(a, { status: "pending_approval" });
      expect((await put(poolServer, "owner", brokenBound.id, { mode: "pool_account", accountId: x.id })).status).toBe(200);
      const brokenBoundApproval = await hireApproval(a, brokenBound, { appearance: { schemaVersion: 2 } });
      const failedBound = await approve(brokenBoundApproval.id, { defaultEnvironmentId: localEnvironment.id });
      expect(failedBound.status).toBeGreaterThanOrEqual(400);
      expect(await environmentOf(brokenBound.id)).toEqual({ defaultEnvironmentId: null, status: "pending_approval" });
      const [boundStillPending] = await db.select({ status: approvals.status }).from(approvals).where(eq(approvals.id, brokenBoundApproval.id));
      expect(boundStillPending!.status).toBe("pending");
    });

    it("clears the over-limit flag of the device an approved pool-bound hire leaves, once its activation commits", async () => {
      const { a, x, y } = await world();
      const server = approvalsApp();
      const poolServer = app();
      const ssh = await sshEnvironment("crowded runner");
      const hired = await agent(a, { status: "pending_approval", defaultEnvironmentId: ssh.id });
      expect((await put(poolServer, "owner", hired.id, { mode: "pool_account", accountId: x.id })).status).toBe(200);
      expect((await put(poolServer, "other", (await agent(a, { defaultEnvironmentId: ssh.id })).id, { mode: "pool_account", accountId: y.id })).status).toBe(200);
      // Lowered to one account, the runner is over its limit until the hire leaves it.
      const device = (await deviceForEnvironment(db, ssh))!;
      await db.update(aiAccountHosts).set({ maxAccounts: 1 }).where(eq(aiAccountHosts.id, device.id));
      expect(await recheckDeviceLimits(db, { deviceIds: [device.id] })).toEqual([expect.objectContaining({ inUse: 2, limit: 1, change: "flagged" })]);
      const before = await readWakeEpochs(db, { environmentId: ssh.id, agentId: hired.id });

      const approval = await hireApproval(a, hired);
      const approved = await request(server).post(`/api/approvals/${approval.id}/approve`).set("x-actor", "admin").send({ defaultEnvironmentId: localEnvironment.id });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect(await environmentOf(hired.id)).toEqual({ defaultEnvironmentId: localEnvironment.id, status: "paused" });
      // The re-check read the committed activation: the runner fits its limit again.
      const [runner] = await db.select({ overLimitAt: aiAccountHosts.overLimitAt }).from(aiAccountHosts).where(eq(aiAccountHosts.id, device.id));
      expect(runner!.overLimitAt).toBeNull();
      const after = await readWakeEpochs(db, { environmentId: ssh.id, agentId: hired.id });
      expect(after.bindingUpdatedAt! > before.bindingUpdatedAt!).toBe(true);
      expect(after.environmentEpoch!).toBeGreaterThan(before.environmentEpoch!);
    });
  });

  describe("default environment edits (spec 5.6)", () => {
    it("flags a device that a project default pushes over its limit and tells the company once", async () => {
      const companyId = await company("Defaults");
      actors.local = { type: "board", source: "local_implicit", userId: "local-board", isInstanceAdmin: true };
      const owners = ["d1", "d2", "d3", "d4"];
      for (const owner of owners) await person(owner, [[companyId, "operator"]]);
      const poolServer = app();
      const shared = await sshEnvironment("shared runner");
      for (const owner of owners.slice(0, 3)) {
        const pinned = await agent(companyId, { defaultEnvironmentId: shared.id });
        expect((await put(poolServer, owner, pinned.id, { mode: "pool_account", accountId: (await addAccount(poolServer, owner, `Pinned-${owner}`)).id })).status).toBe(200);
      }
      // An unpinned agent runs on the Local server today; a project default puts the shared runner among its candidates.
      const follower = await agent(companyId);
      expect((await put(poolServer, "d4", follower.id, { mode: "pool_account", accountId: (await addAccount(poolServer, "d4", "Follower")).id })).status).toBe(200);
      const device = (await deviceForEnvironment(db, shared))!;
      const [project] = await db.insert(projects).values({ companyId, name: "Moved project" }).returning();

      const server = express();
      server.use(express.json());
      server.use((req, _res, next) => {
        req.actor = actors[req.header("x-actor") ?? ""] ?? { type: "none", source: "none" };
        next();
      });
      server.use("/api", projectRoutes(db));
      server.use(errorHandler);
      const notices = () => db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "execution_device.over_limit")));

      const renamed = await request(server).patch(`/api/projects/${project!.id}`).set("x-actor", "local").send({ name: "Renamed project" });
      expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
      const moved = await request(server).patch(`/api/projects/${project!.id}`).set("x-actor", "local").send({ defaultEnvironmentId: shared.id });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      await vi.waitFor(async () => {
        const [row] = await db.select({ overLimitAt: aiAccountHosts.overLimitAt }).from(aiAccountHosts).where(eq(aiAccountHosts.id, device.id));
        expect(row!.overLimitAt).not.toBeNull();
        expect(await notices()).toHaveLength(1);
      }, { timeout: 10_000, interval: 50 });
      const [notice] = await notices();
      expect(notice).toMatchObject({ actorType: "system", entityType: "execution_device", entityId: device.id, details: { limit: 3, inUse: 4 } });

      // Saving the same default again flags nothing new.
      expect((await request(server).patch(`/api/projects/${project!.id}`).set("x-actor", "local").send({ defaultEnvironmentId: shared.id })).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await notices()).toHaveLength(1);
    });

    it("flags devices that a company default or the instance default pushes over their limits", async () => {
      actors.local = { type: "board", source: "local_implicit", userId: "local-board", isInstanceAdmin: true };
      const poolServer = app();
      /** Three agents pinned to a new runner, each on its own account, and one unpinned agent on a fourth. */
      async function crowdedRunner(companyName: string) {
        const companyId = await company(companyName);
        const owners = [1, 2, 3, 4].map((index) => `${companyName.toLowerCase()}-${index}`);
        for (const owner of owners) await person(owner, [[companyId, "operator"]]);
        const runner = await sshEnvironment(`${companyName} runner`);
        for (const owner of owners.slice(0, 3)) {
          const pinned = await agent(companyId, { defaultEnvironmentId: runner.id });
          expect((await put(poolServer, owner, pinned.id, { mode: "pool_account", accountId: (await addAccount(poolServer, owner, `Pinned-${owner}`)).id })).status).toBe(200);
        }
        const follower = await agent(companyId);
        expect((await put(poolServer, owners[3]!, follower.id, { mode: "pool_account", accountId: (await addAccount(poolServer, owners[3]!, `Follower-${owners[3]}`)).id })).status).toBe(200);
        return { companyId, device: (await deviceForEnvironment(db, runner))!, runner };
      }
      const byCompany = await crowdedRunner("Company");
      const byInstance = await crowdedRunner("Instance");
      // A company default wins over the instance default, so the instance default reaches only the second company.
      const server = express();
      server.use(express.json());
      server.use((req, _res, next) => {
        req.actor = actors[req.header("x-actor") ?? ""] ?? { type: "none", source: "none" };
        next();
      });
      server.use("/api/companies", companyRoutes(db));
      server.use("/api", instanceSettingsRoutes(db));
      server.use(errorHandler);
      const flagged = async (deviceId: string, companyId: string) => {
        const [row] = await db.select({ overLimitAt: aiAccountHosts.overLimitAt }).from(aiAccountHosts).where(eq(aiAccountHosts.id, deviceId));
        const notices = await db.select().from(activityLog).where(and(eq(activityLog.action, "execution_device.over_limit"), eq(activityLog.entityId, deviceId)));
        return { flagged: row!.overLimitAt !== null, noticeCompanies: notices.map((entry) => entry.companyId) };
      };

      const companyPatch = await request(server).patch(`/api/companies/${byCompany.companyId}`).set("x-actor", "local").send({ defaultEnvironmentId: byCompany.runner.id });
      expect(companyPatch.status, JSON.stringify(companyPatch.body)).toBe(200);
      await vi.waitFor(async () => {
        expect(await flagged(byCompany.device.id, byCompany.companyId)).toEqual({ flagged: true, noticeCompanies: [byCompany.companyId] });
      }, { timeout: 10_000, interval: 50 });
      expect(await flagged(byInstance.device.id, byInstance.companyId)).toEqual({ flagged: false, noticeCompanies: [] });

      const instancePatch = await request(server).patch("/api/instance/settings").set("x-actor", "local").send({ defaultEnvironmentId: byInstance.runner.id });
      expect(instancePatch.status, JSON.stringify(instancePatch.body)).toBe(200);
      await vi.waitFor(async () => {
        expect(await flagged(byInstance.device.id, byInstance.companyId)).toEqual({ flagged: true, noticeCompanies: [byInstance.companyId] });
      }, { timeout: 10_000, interval: 50 });
      expect((await flagged(byCompany.device.id, byCompany.companyId)).noticeCompanies).toEqual([byCompany.companyId]);
    });
  });
});
