import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  aiAccountAgentBindings,
  aiAccountHosts,
  aiAccounts,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  environments,
  executionWaitSettings,
  heartbeatRuns,
  issues,
  plugins,
  resourceWaitEpisodes,
  resourceWaitNotices,
} from "@paperclipai/db";
import type { PluginEnvironmentTargetReport } from "@paperclipai/plugin-sdk";
import { buildResourceWaitContext } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { executionDeviceRoutes, type ExecutionDeviceRoutesHeartbeat } from "../routes/execution-devices.js";
import { deviceOverLimitNoticeKey, resourceWaitAttentionInputs } from "../services/attention-resource-waits.js";
import {
  candidateDevicesForAgent,
  deviceForEnvironment,
  markOverLimitIfNeeded,
  upsertPluginTargetByTargetKey,
} from "../services/execution-devices.js";
import { heartbeatService } from "../services/heartbeat.js";
import { openEpisode, readScheduledRetryResourceWaits } from "../services/resource-waits/index.js";

type Actor = Express.Request["actor"];

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping embedded Postgres device route tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

describeEmbeddedPostgres("execution device routes", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let localEnvironment: typeof environments.$inferSelect;
  let heartbeat: ExecutionDeviceRoutesHeartbeat & { wakeResourceWaitsNow: ReturnType<typeof vi.fn> };
  const actors: Record<string, Actor> = {};

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_RESOURCE_WAIT_NOTIFY_HOURS", "");
    database = await startEmbeddedPostgresTestDatabase("paperclip-execution-device-routes-");
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
    // The real forced checks; the wake that would also start runs only makes them due here.
    const real = heartbeatService(db).resourceWaits;
    heartbeat = {
      resourceWaits: real,
      wakeResourceWaitsNow: vi.fn(async (filter: Parameters<typeof real.wakeResourceWaits>[0]) => real.wakeResourceWaits(filter)),
    } as unknown as typeof heartbeat;
  });

  const tag = () => randomUUID().slice(0, 8);

  function app() {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.actor = actors[req.header("x-actor") ?? ""] ?? { type: "none", source: "none" };
      next();
    });
    server.use("/api", executionDeviceRoutes(db, { deploymentMode: "authenticated", heartbeat }));
    server.use(errorHandler);
    return server;
  }

  async function company(name: string) {
    const id = randomUUID();
    await db.insert(companies).values({ id, name, issuePrefix: `C${id.replaceAll("-", "").slice(0, 7).toUpperCase()}` });
    return id;
  }

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

  async function account(ownerUserId: string, label: string) {
    const [row] = await db.insert(aiAccounts).values({
      credentialType: "subscription",
      label,
      ownerUserId,
      createdByUserId: ownerUserId,
      credentialMaterial: { provider: "local_encrypted", ciphertext: tag() },
      credentialFingerprint: randomUUID(),
    }).returning();
    return row!;
  }

  async function bind(agentRow: { id: string; companyId: string }, accountId: string) {
    await db.insert(aiAccountAgentBindings).values({ agentId: agentRow.id, companyId: agentRow.companyId, mode: "pool_account", accountId });
  }

  async function plugin(provider: string) {
    const pluginKey = `test.${provider}.${tag()}`;
    const [row] = await db.insert(plugins).values({
      pluginKey,
      packageName: pluginKey,
      version: "1.0.0",
      status: "ready",
      manifestJson: {
        id: pluginKey,
        displayName: `Plugin ${provider}`,
        environmentDrivers: [{ driverKey: provider, kind: "sandbox_provider", displayName: provider }],
      } as never,
    }).returning();
    return row!;
  }

  function report(overrides: Partial<PluginEnvironmentTargetReport> = {}): PluginEnvironmentTargetReport {
    return { targetKey: "d-1", label: "Build box", configMatch: { deviceId: "d-1" }, state: "available", ...overrides };
  }

  /** A waiting run of `agentRow` on `environmentId`, with its open episode; due in an hour. */
  async function waitOn(agentRow: { id: string; companyId: string }, environmentId: string, deviceId: string, reason = "busy") {
    const [task] = await db.insert(issues).values({ companyId: agentRow.companyId, title: `Waiting ${tag()}`, status: "in_progress", assigneeAgentId: agentRow.id }).returning();
    const due = new Date(Date.now() + 3_600_000);
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: agentRow.companyId,
      agentId: agentRow.id,
      status: "scheduled_retry",
      invocationSource: "automation",
      triggerDetail: "system",
      scheduledRetryReason: "environment_wait",
      scheduledRetryAt: due,
      contextSnapshot: { issueId: task!.id },
    }).returning();
    await db.insert(resourceWaitEpisodes).values({
      companyId: agentRow.companyId,
      agentId: agentRow.id,
      issueId: task!.id,
      kind: "environment",
      reason,
      scope: "admission",
      resourceKey: `environment:${environmentId}`,
      environmentId,
      deviceId,
      since: new Date(Date.now() - 600_000),
      currentRunId: run!.id,
    });
    return { run: run!, due, task: task! };
  }

  async function dueAt(runId: string) {
    const [row] = await db.select({ scheduledRetryAt: heartbeatRuns.scheduledRetryAt }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    return row!.scheduledRetryAt!;
  }

  async function actions(companyId: string) {
    return (await db.select({ action: activityLog.action }).from(activityLog).where(eq(activityLog.companyId, companyId))).map((row) => row.action);
  }

  /** Alpha and Bravo share the server; Bravo also runs on an SSH host and is served by a plugin device. */
  async function world() {
    const a = await company("Alpha");
    const b = await company("Bravo");
    await person("alpha-admin", [[a, "owner"]]);
    await person("alpha-member", [[a, "operator"]]);
    await person("alpha-viewer", [[a, "viewer"]]);
    await person("ia-viewer", [[a, "viewer"]], { instanceAdmin: true });
    await person("ia-outsider", [[b, "operator"]], { instanceAdmin: true });
    await person("bravo-member", [[b, "operator"]]);
    const alpha = await account("alpha-member", "Alpha secret label");
    const bravo = await account("bravo-member", "Bravo private label");
    const a1 = await agent(a, { name: "Alpha builder" });
    const b1 = await agent(b, { name: "Bravo builder" });
    await bind(a1, alpha.id);
    await bind(b1, bravo.id);
    const server = (await deviceForEnvironment(db, localEnvironment))!;
    const [bravoHost] = await db.insert(environments).values({ name: "Bravo host", driver: "ssh", companyId: b, config: { host: "bravo.example.com", port: 22, username: "runner" } }).returning();
    await agent(b, { name: "Bravo remote", defaultEnvironmentId: bravoHost!.id });
    const sshDevice = (await deviceForEnvironment(db, bravoHost!))!;
    const provider = await plugin("box");
    const served = (await upsertPluginTargetByTargetKey(db, { pluginId: provider.id, provider: "box", target: report({ servedCompanyIds: [b] }) })).device;
    return { a, b, alpha, bravo, a1, b1, server, sshDevice, served, provider, server_: app() };
  }

  it("lists only the devices a company can see, with other companies' accounts as counts", async () => {
    const { a, b, alpha, bravo, a1, server, sshDevice, served, server_ } = await world();

    const listed = await request(server_).get(`/api/companies/${a}/devices`).set("x-actor", "alpha-viewer");
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.limitPerDevice).toBe(3);
    expect(listed.body.devices.map((device: { id: string }) => device.id)).toEqual([server.id]);
    expect(listed.body.devices[0]).toMatchObject({
      kind: "server",
      inUse: 2,
      otherCompaniesAccounts: 1,
      accounts: [{ id: alpha.id, label: "Alpha secret label" }],
    });
    expect(JSON.stringify(listed.body)).not.toContain("Bravo private label");
    expect(JSON.stringify(listed.body)).not.toContain(bravo.id);
    // Every device of an agent's placement is listed, so its card can show the availability.
    const placement = await candidateDevicesForAgent(db, a1);
    for (const candidate of placement) expect(listed.body.devices.map((device: { id: string }) => device.id)).toContain(candidate.device!.id);

    const detail = await request(server_).get(`/api/companies/${a}/devices/${server.id}`).set("x-actor", "alpha-viewer");
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ id: server.id, waits: [] });
    // Devices the company cannot see answer exactly like unknown ones.
    for (const hidden of [sshDevice.id, served.id, randomUUID(), "not-a-uuid"]) {
      const response = await request(server_).get(`/api/companies/${a}/devices/${hidden}`).set("x-actor", "alpha-viewer");
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: "Device not found" });
    }

    // Bravo sees the server, its SSH host and the device its plugin serves it from.
    const forB = await request(server_).get(`/api/companies/${b}/devices`).set("x-actor", "bravo-member");
    expect(forB.body.devices.map((device: { id: string }) => device.id).sort()).toEqual([server.id, sshDevice.id, served.id].sort());
    expect(JSON.stringify(forB.body)).not.toContain("Alpha secret label");
    expect(JSON.stringify(forB.body)).not.toContain("bravo.example.com");

    // Another company's devices, agents and anonymous callers are refused.
    expect((await request(server_).get(`/api/companies/${b}/devices`).set("x-actor", "alpha-member")).status).toBe(403);
    actors.agent = { type: "agent", agentId: a1.id, companyId: a, source: "agent_key" };
    expect((await request(server_).get(`/api/companies/${a}/devices`).set("x-actor", "agent")).status).toBe(403);
    expect((await request(server_).get(`/api/companies/${a}/devices`)).status).toBe(401);
  });

  it("checks a device in the caller's company once a minute and wakes that company's waits", async () => {
    const { a, b, a1, b1, server, served, server_ } = await world();
    const alphaWait = await waitOn(a1, localEnvironment.id, server.id);
    const bravoWait = await waitOn(b1, localEnvironment.id, server.id);

    // Viewers may look but not check; invisible devices are 404 and spend no slot.
    expect((await request(server_).post(`/api/companies/${a}/devices/${server.id}/check-now`).set("x-actor", "alpha-viewer")).status).toBe(403);
    expect((await request(server_).post(`/api/companies/${a}/devices/${served.id}/check-now`).set("x-actor", "alpha-member")).status).toBe(404);

    // Bravo's check wakes Bravo's wait only.
    const bravoCheck = await request(server_).post(`/api/companies/${b}/devices/${server.id}/check-now`).set("x-actor", "bravo-member");
    expect(bravoCheck.status, JSON.stringify(bravoCheck.body)).toBe(200);
    expect((await dueAt(bravoWait.run.id)).getTime()).toBeLessThan(bravoWait.due.getTime());
    expect((await dueAt(alphaWait.run.id)).getTime()).toBe(alphaWait.due.getTime());

    const checked = await request(server_).post(`/api/companies/${a}/devices/${server.id}/check-now`).set("x-actor", "alpha-member");
    expect(checked.status, JSON.stringify(checked.body)).toBe(200);
    expect(checked.body).toMatchObject({ device: { id: server.id, waits: [expect.objectContaining({ runId: alphaWait.run.id })] } });
    expect(checked.body.woken).toBeGreaterThanOrEqual(1);
    expect(Date.parse(checked.body.checkedAt)).not.toBeNaN();
    expect((await dueAt(alphaWait.run.id)).getTime()).toBeLessThan(alphaWait.due.getTime());
    expect(heartbeat.wakeResourceWaitsNow).toHaveBeenCalledWith({ environmentIds: [localEnvironment.id], companyId: a });
    expect(await actions(a)).toContain("execution_device.checked");

    // Once a minute per device and company.
    const again = await request(server_).post(`/api/companies/${a}/devices/${server.id}/check-now`).set("x-actor", "alpha-admin");
    expect(again.status).toBe(429);
    expect(again.body).toMatchObject({ code: "check_now_rate_limited", details: { retryAfterMs: 60_000 } });
    expect(again.headers["retry-after"]).toBe("60");
    // An instance admin who is a viewer here is a company admin (D4) and may check.
    await db.delete(resourceWaitNotices).where(eq(resourceWaitNotices.companyId, a));
    expect((await request(server_).post(`/api/companies/${a}/devices/${server.id}/check-now`).set("x-actor", "ia-viewer")).status).toBe(200);
  });

  it("names a waiting private task only to members who may read it, and still counts its wait", async () => {
    const { a, a1, server, server_ } = await world();
    // alpha-member's private task waits on the server, next to an open task (doc/ISSUE-PRIVACY.md).
    const secret = await waitOn(a1, localEnvironment.id, server.id);
    await db.update(issues)
      .set({ title: "Acquisition of X", visibility: "private", privacyRootIssueId: secret.task.id, createdByUserId: "alpha-member", responsibleUserId: "alpha-member" })
      .where(eq(issues.id, secret.task.id));
    const open = await waitOn(a1, localEnvironment.id, server.id);
    type Waits = { waits: Array<{ runId: string }> };
    const waitOf = (body: Waits, runId: string) => body.waits.find((wait) => wait.runId === runId);
    const redacted = { runId: secret.run.id, agentId: a1.id, agentName: a1.name, issueId: null, issueIdentifier: null, issueTitle: null, kind: "environment", reason: "busy" };
    const expectNoSecret = (body: unknown) => {
      expect(JSON.stringify(body)).not.toContain("Acquisition of X");
      expect(JSON.stringify(body)).not.toContain(secret.task.id);
    };

    // A viewer and the company owner are not participants: the wait shows under its agent, and still counts.
    for (const viewer of ["alpha-viewer", "alpha-admin"]) {
      const listed = await request(server_).get(`/api/companies/${a}/devices`).set("x-actor", viewer);
      expect(listed.status, JSON.stringify(listed.body)).toBe(200);
      const device = listed.body.devices.find((entry: { id: string }) => entry.id === server.id);
      expect(device.waitingCount).toBe(2);
      expect(waitOf(device, secret.run.id)).toMatchObject(redacted);
      expect(waitOf(device, open.run.id)).toMatchObject({ issueId: open.task.id, issueTitle: open.task.title });
      expectNoSecret(listed.body);
      const detail = await request(server_).get(`/api/companies/${a}/devices/${server.id}`).set("x-actor", viewer);
      expect(detail.status).toBe(200);
      expect(detail.body.waitingCount).toBe(2);
      expect(waitOf(detail.body, secret.run.id)).toMatchObject(redacted);
      expectNoSecret(detail.body);
    }

    // Its creator, and an instance admin, see the task.
    for (const reader of ["alpha-member", "ia-viewer"]) {
      const detail = await request(server_).get(`/api/companies/${a}/devices/${server.id}`).set("x-actor", reader);
      expect(detail.status).toBe(200);
      expect(waitOf(detail.body, secret.run.id)).toMatchObject({ issueId: secret.task.id, issueTitle: "Acquisition of X" });
    }

    // "Check now" answers with the device as the caller may see it.
    const checked = await request(server_).post(`/api/companies/${a}/devices/${server.id}/check-now`).set("x-actor", "alpha-admin");
    expect(checked.status, JSON.stringify(checked.body)).toBe(200);
    expect(waitOf(checked.body.device, secret.run.id)).toMatchObject(redacted);
    expectNoSecret(checked.body);
  });

  it("reads wait settings for members and lets only company admins change them", async () => {
    const { a, server_ } = await world();
    const read = await request(server_).get(`/api/companies/${a}/execution-wait-settings`).set("x-actor", "alpha-viewer");
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      companyId: a,
      notifyAfterHours: null,
      notifyPmOnDeviceWait: false,
      notifyPmOnAccountWait: true,
      instanceDefaultHours: 24,
      updatedAt: null,
    });

    const put = (actor: string, body: Record<string, unknown>) =>
      request(server_).put(`/api/companies/${a}/execution-wait-settings`).set("x-actor", actor).send(body);
    for (const actor of ["alpha-member", "alpha-viewer", "ia-outsider"]) expect((await put(actor, { notifyAfterHours: 6 })).status).toBe(403);
    for (const body of [{ notifyAfterHours: 169 }, { notifyAfterHours: -1 }, { notifyAfterHours: 1.5 }, { notifyPmOnDeviceWait: "yes" }, { unknown: true }]) {
      expect((await put("alpha-admin", body)).status).toBe(400);
    }

    const six = await put("alpha-admin", { notifyAfterHours: 6 });
    expect(six.status, JSON.stringify(six.body)).toBe(200);
    expect(six.body).toMatchObject({ companyId: a, notifyAfterHours: 6, notifyPmOnDeviceWait: false, notifyPmOnAccountWait: true, instanceDefaultHours: 24 });
    // A partial body keeps the other fields.
    const devicePm = await put("ia-viewer", { notifyPmOnDeviceWait: true });
    expect(devicePm.status).toBe(200);
    expect(devicePm.body).toMatchObject({ notifyAfterHours: 6, notifyPmOnDeviceWait: true });
    expect((await put("alpha-admin", { notifyAfterHours: 0 })).body.notifyAfterHours).toBe(0);
    expect((await put("alpha-admin", { notifyAfterHours: null })).body.notifyAfterHours).toBeNull();
    const [row] = await db.select().from(executionWaitSettings).where(eq(executionWaitSettings.companyId, a));
    expect(row).toMatchObject({ notifyAfterHours: null, notifyPmOnDeviceWait: true, updatedByUserId: "alpha-admin" });
    expect((await actions(a)).filter((action) => action === "company.execution_wait_settings_updated")).toHaveLength(4);
  });

  it("lists every device for instance admins and refuses a cap below the bound accounts", async () => {
    const { a, b, server, sshDevice, server_ } = await world();
    await person("instance-admin", [], { instanceAdmin: true });
    expect((await request(server_).get("/api/instance/devices").set("x-actor", "alpha-admin")).status).toBe(403);
    const listed = await request(server_).get("/api/instance/devices").set("x-actor", "instance-admin");
    expect(listed.status).toBe(200);
    const serverRow = listed.body.devices.find((device: { id: string }) => device.id === server.id);
    expect(serverRow.accounts.map((entry: { label: string }) => entry.label)).toEqual(["Alpha secret label", "Bravo private label"]);
    expect(serverRow).toMatchObject({ externalKey: "local", maxAccounts: 3, inUse: 2 });

    const patch = (id: string, body: Record<string, unknown>) =>
      request(server_).patch(`/api/instance/devices/${id}`).set("x-actor", "instance-admin").send(body);
    const tooLow = await patch(server.id, { maxAccounts: 1 });
    expect(tooLow.status).toBe(409);
    expect(tooLow.body).toMatchObject({
      code: "device_account_limit",
      details: { deviceId: server.id, limit: 1, inUse: 2, accounts: ["Alpha secret label", "Bravo private label"], otherCompaniesAccounts: 0 },
    });
    expect(tooLow.body.error).toContain("before lowering its limit to 1");
    expect((await db.select().from(aiAccountHosts).where(eq(aiAccountHosts.id, server.id)))[0]!.maxAccounts).toBe(3);

    // A device already over its limit is cleared by a higher cap, and its slot waits wake.
    await db.update(aiAccountHosts).set({ maxAccounts: 1 }).where(eq(aiAccountHosts.id, server.id));
    expect((await markOverLimitIfNeeded(db, [server.id]))[0]).toMatchObject({ change: "flagged" });
    const raised = await patch(server.id, { maxAccounts: 2, name: "Main server" });
    expect(raised.status, JSON.stringify(raised.body)).toBe(200);
    expect(raised.body).toMatchObject({ id: server.id, name: "Main server", maxAccounts: 2, limit: 2, overLimit: false, overLimitSince: null });
    expect(heartbeat.wakeResourceWaitsNow).toHaveBeenCalledWith({ deviceIds: [server.id], kinds: ["device_slots"] });
    for (const companyId of [a, b]) expect(await actions(companyId)).toContain("execution_device.updated");

    expect((await patch(server.id, { name: sshDevice.name })).status).toBe(409);
    expect((await patch(server.id, { name: sshDevice.name })).body.error).toBe("A device with this name already exists.");
    expect((await patch(server.id, { maxAccounts: 4 })).status).toBe(400);
    expect((await patch(randomUUID(), { maxAccounts: 2 })).status).toBe(404);
    expect((await request(server_).patch(`/api/instance/devices/${server.id}`).set("x-actor", "alpha-admin").send({ maxAccounts: 3 })).status).toBe(403);
  });

  it("lets an instance admin raise the limit of a device over its limit, which stays flagged until the accounts fit", async () => {
    const { a, server, server_ } = await world();
    await person("instance-admin", [], { instanceAdmin: true });
    // A third account on the server, which then gets a limit of one: three accounts, flagged.
    await bind(await agent(a, { name: "Alpha third" }), (await account("alpha-member", "Alpha third label")).id);
    await db.update(aiAccountHosts).set({ maxAccounts: 1 }).where(eq(aiAccountHosts.id, server.id));
    expect((await markOverLimitIfNeeded(db, [server.id]))[0]).toMatchObject({ change: "flagged" });
    const patch = (body: Record<string, unknown>) =>
      request(server_).patch(`/api/instance/devices/${server.id}`).set("x-actor", "instance-admin").send(body);

    // Two is still below the three bound accounts, but a higher limit is never refused (spec 6.2).
    const raised = await patch({ maxAccounts: 2 });
    expect(raised.status, JSON.stringify(raised.body)).toBe(200);
    expect(raised.body).toMatchObject({ id: server.id, maxAccounts: 2, limit: 2, inUse: 3, overLimit: true });
    expect(heartbeat.wakeResourceWaitsNow).toHaveBeenCalledWith({ deviceIds: [server.id], kinds: ["device_slots"] });
    expect(await actions(a)).toContain("execution_device.updated");

    // Lowering it again is refused while the accounts do not fit.
    const lowered = await patch({ maxAccounts: 1 });
    expect(lowered.status).toBe(409);
    expect(lowered.body).toMatchObject({ code: "device_account_limit", details: { limit: 1, inUse: 3 } });
    expect((await patch({ maxAccounts: 3 })).body).toMatchObject({ maxAccounts: 3, overLimit: false });
  });

  it("links a device to a plugin target, merging the external row and its waits", async () => {
    const a = await company("Alpha");
    await person("owner", [[a, "operator"]]);
    await person("instance-admin", [], { instanceAdmin: true });
    const provider = await plugin("box");
    const [studio] = await db.insert(aiAccountHosts).values({ name: "Studio", kind: "ssh_host", externalKey: "ssh:studio.example.com:22", maxAccounts: 1 }).returning();
    const [tunnel] = await db.insert(environments).values({ name: "Studio tunnel", driver: "ssh", companyId: a, config: { host: "studio.example.com", port: 22, username: "runner" } }).returning();
    const [sandbox] = await db.insert(environments).values({ name: "Box", driver: "sandbox", companyId: a, config: { provider: "box", deviceId: "d-1" } }).returning();
    const external = (await upsertPluginTargetByTargetKey(db, { pluginId: provider.id, provider: "box", target: report() })).device;
    expect((await deviceForEnvironment(db, sandbox!))!.id).toBe(external.id);
    // One account bound on each row: within each cap until the rows become one machine.
    const viaSsh = await agent(a, { defaultEnvironmentId: tunnel!.id });
    const viaPlugin = await agent(a, { defaultEnvironmentId: sandbox!.id });
    await bind(viaSsh, (await account("owner", "Over SSH")).id);
    await bind(viaPlugin, (await account("owner", "Over plugin")).id);
    const waiting = await waitOn(viaPlugin, sandbox!.id, external.id, "offline");
    // A task of the same agent waits for a free account slot on the plugin's row.
    const pluginAccount = (await db.select({ accountId: aiAccountAgentBindings.accountId }).from(aiAccountAgentBindings)
      .where(eq(aiAccountAgentBindings.agentId, viaPlugin.id)))[0]!.accountId!;
    const [slotTask] = await db.insert(issues).values({ companyId: a, title: "Waiting for a slot", status: "in_progress", assigneeAgentId: viaPlugin.id }).returning();
    const slotEpisodeId = randomUUID();
    const slotContext = buildResourceWaitContext({
      episodeId: slotEpisodeId,
      kind: "device_slots",
      reason: "slots_full",
      scope: "device",
      environmentId: sandbox!.id,
      environmentName: sandbox!.name,
      deviceId: external.id,
      deviceName: external.name,
      accountId: pluginAccount,
      accountLabel: "Over plugin",
      resumeAt: null,
      resumeAtSource: null,
      message: null,
    });
    const [slotRun] = await db.insert(heartbeatRuns).values({
      companyId: a,
      agentId: viaPlugin.id,
      status: "scheduled_retry",
      invocationSource: "automation",
      triggerDetail: "system",
      scheduledRetryReason: "device_slot_wait",
      scheduledRetryAt: new Date(Date.now() + 3_600_000),
      contextSnapshot: { issueId: slotTask!.id, resourceWait: slotContext },
    }).returning();
    const slotSince = new Date(Date.now() - 900_000);
    await db.insert(resourceWaitEpisodes).values({
      id: slotEpisodeId,
      companyId: a,
      agentId: viaPlugin.id,
      issueId: slotTask!.id,
      kind: "device_slots",
      reason: "slots_full",
      scope: "device",
      resourceKey: `device:${external.id}`,
      environmentId: sandbox!.id,
      deviceId: external.id,
      accountId: pluginAccount,
      since: slotSince,
      notifiedAt: slotSince,
      currentRunId: slotRun!.id,
    });
    const server_ = app();

    const link = (id: string, body: Record<string, unknown>, actor = "instance-admin") =>
      request(server_).post(`/api/instance/devices/${id}/link-target`).set("x-actor", actor).send(body);
    expect((await link(studio!.id, { pluginId: provider.id, provider: "box", targetKey: "d-1" }, "owner")).status).toBe(403);
    expect((await link(studio!.id, { pluginId: provider.id, provider: "box" })).status).toBe(400);
    expect((await link(randomUUID(), { pluginId: provider.id, provider: "box", targetKey: "d-1" })).status).toBe(404);
    const unknownPlugin = await link(studio!.id, { pluginId: randomUUID(), provider: "box", targetKey: "d-1" });
    expect(unknownPlugin.status).toBe(404);
    expect(unknownPlugin.body.error).toBe("No installed plugin provides this target");
    const local = (await deviceForEnvironment(db, localEnvironment))!;
    const notLinkable = await link(local.id, { pluginId: provider.id, provider: "box", targetKey: "d-1" });
    expect(notLinkable.status).toBe(409);
    expect(notLinkable.body.error).toContain("cannot be linked to a plugin target");

    // Waking the moved waits fails this time: the link stands, and its notice is never lost.
    heartbeat.wakeResourceWaitsNow.mockRejectedValueOnce(new Error("wake failed"));
    const linked = await link(studio!.id, { pluginId: provider.id, provider: "box", targetKey: "d-1" });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    expect(linked.body).toMatchObject({ id: studio!.id, kind: "ssh_host", targetProvider: "box", managedByPluginId: provider.id, inUse: 2, overLimit: true });
    expect(await db.select().from(aiAccountHosts).where(eq(aiAccountHosts.id, external.id))).toEqual([]);
    const [episode] = await db.select().from(resourceWaitEpisodes).where(eq(resourceWaitEpisodes.currentRunId, waiting.run.id));
    expect(episode).toMatchObject({ deviceId: studio!.id, resourceKey: `environment:${sandbox!.id}` });
    // A slot wait is keyed by its device: it moved with the merge and stays one episode on this machine.
    const [slotEpisode] = await db.select().from(resourceWaitEpisodes).where(eq(resourceWaitEpisodes.id, slotEpisodeId));
    expect(slotEpisode).toMatchObject({ deviceId: studio!.id, resourceKey: `device:${studio!.id}`, resolvedAt: null });
    // Its banner keeps the wait's start, though the run's written-once context names the merged row.
    expect((await readScheduledRetryResourceWaits(db, [slotRun!])).get(slotRun!.id))
      .toMatchObject({ episodeId: slotEpisodeId, since: slotSince.toISOString() });
    expect(heartbeat.wakeResourceWaitsNow).toHaveBeenCalledWith({ deviceIds: [studio!.id] });
    // The merge put two accounts on a one-account machine: the over-limit notice of spec 5.6.
    const [flagged] = await db.select({ overLimitAt: aiAccountHosts.overLimitAt }).from(aiAccountHosts).where(eq(aiAccountHosts.id, studio!.id));
    expect(await db.select().from(resourceWaitNotices).where(and(
      eq(resourceWaitNotices.companyId, a),
      eq(resourceWaitNotices.noticeKey, deviceOverLimitNoticeKey(studio!.id, flagged!.overLimitAt!)),
    ))).toHaveLength(1);
    expect(await actions(a)).toEqual(expect.arrayContaining(["execution_device.over_limit", "execution_device.linked"]));
    // The slot wait shares the machine's over-limit item in the inbox.
    const inbox = await resourceWaitAttentionInputs(db, a, { prefix: "ALP", env: {}, deploymentMode: "authenticated" });
    expect(inbox.filter((item) => item.dedupKey.startsWith("resource_wait:device_slots:")).map((item) => item.dedupKey))
      .toEqual([`resource_wait:device_slots:device:${studio!.id}:${flagged!.overLimitAt!.toISOString()}`]);
    // When the run finds no free slot on this machine again, its episode carries on: same start, no new notice.
    const deferredAgain = await openEpisode(db, {
      chain: { companyId: a, issueId: slotTask!.id, agentId: viaPlugin.id },
      wait: { ...slotContext, deviceId: studio!.id, deviceName: studio!.name, resumeAt: null, retryAfter: null },
      now: new Date(),
    });
    expect(deferredAgain).toMatchObject({ created: false, superseded: null, episode: { id: slotEpisodeId } });
    expect(deferredAgain.episode.since.toISOString()).toBe(slotSince.toISOString());

    // Linking again changes nothing.
    const again = await link(studio!.id, { pluginId: provider.id, provider: "box", targetKey: "d-1" });
    expect(again.status).toBe(200);
    expect((await actions(a)).filter((action) => action === "execution_device.linked")).toHaveLength(1);
  });
});
