import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, approvals, companies, createDb, environments } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentRoutes } from "../routes/agents.js";
import { approvalRoutes } from "../routes/approvals.js";
import { errorHandler } from "../middleware/error-handler.js";

// Fork: the board's device pick at hire approval re-resolves the hire's runner
// (routes/approvals.ts). SSH hosts answer the runner's platform probe from this
// table; a host without an entry cannot be reached.
const ssh = vi.hoisted(() => ({ platforms: new Map<string, string>(), probed: [] as string[] }));
vi.mock("@paperclipai/adapter-utils/ssh", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@paperclipai/adapter-utils/ssh")>()),
  runSshCommand: async (config: { host?: string }) => {
    const host = String(config.host);
    ssh.probed.push(host);
    const stdout = ssh.platforms.get(host);
    if (stdout === undefined) throw new Error(`ssh: connect to host ${host}: Connection refused`);
    return { stdout, stderr: "" };
  },
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping embedded Postgres hire approval runner tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

describeEmbeddedPostgres("hire approval device pick and runner", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let server: express.Express;
  let companyId: string;
  /** Paperclip Runner qualifies on glibc Linux x64; not on musl Linux, nor on a host it cannot reach. */
  let devices: Record<"glibc" | "glibc2" | "musl" | "offline", typeof environments.$inferSelect>;

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "c".repeat(64));
    database = await startEmbeddedPostgresTestDatabase("paperclip-hire-approval-runner-");
    db = createDb(database.connectionString);
    server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.actor = { type: "board", source: "local_implicit", userId: "local-board", isInstanceAdmin: true };
      next();
    });
    server.use("/api", agentRoutes(db, { deploymentMode: "local_trusted" }));
    server.use("/api", approvalRoutes(db));
    server.use(errorHandler);
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await database?.cleanup();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate table companies, environments cascade`);
    ssh.platforms.clear();
    ssh.probed.length = 0;
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Hiring",
      issuePrefix: `H${companyId.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: true,
    });
    const device = async (name: string, platform?: string) => {
      const host = `${name}-${randomUUID().slice(0, 8)}.example.com`;
      if (platform !== undefined) ssh.platforms.set(host, platform);
      const [row] = await db.insert(environments).values({ name, driver: "ssh", config: { host, port: 22, username: "runner", remoteWorkspacePath: "/home/runner/work" } }).returning();
      return row!;
    };
    devices = {
      glibc: await device("glibc", "Linux\nx86_64\nglibc\n2.41\n"),
      glibc2: await device("glibc2", "Linux\nx86_64\nglibc\n2.41\n"),
      musl: await device("musl", "Linux\nx86_64\nmusl\n"),
      offline: await device("offline"),
    };
  });

  async function hire(body: Record<string, unknown>) {
    const response = await request(server).post(`/api/companies/${companyId}/agent-hires`)
      .send({ name: `Hire ${randomUUID().slice(0, 6)}`, role: "engineer", ...body });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.approval, "the company requires approval").toBeTruthy();
    return { agentId: response.body.agent.id as string, approvalId: response.body.approval.id as string, payload: response.body.approval.payload as Record<string, unknown> };
  }

  const codexHire = (extra: Record<string, unknown> = {}) =>
    hire({ adapterType: "codex_local", adapterConfig: { model: "gpt-5.6-sol" }, defaultEnvironmentId: devices.glibc.id, ...extra });

  const approve = (approvalId: string, body: Record<string, unknown>) =>
    request(server).post(`/api/approvals/${approvalId}/approve`).send(body);

  async function agentRow(agentId: string) {
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    return row!;
  }

  async function approvalStatus(approvalId: string) {
    const [row] = await db.select({ status: approvals.status }).from(approvals).where(eq(approvals.id, approvalId));
    return row!.status;
  }

  it("records the runner each hire asked for in its approval", async () => {
    const auto = await codexHire();
    expect(auto.payload).toMatchObject({ adapterType: "paperclip_runner", runner: "auto", defaultEnvironmentId: devices.glibc.id });
    expect((await codexHire({ runner: "paperclip" })).payload).toMatchObject({ adapterType: "paperclip_runner", runner: "paperclip" });
    expect((await codexHire({ runner: "legacy" })).payload).toMatchObject({ adapterType: "codex_local", runner: "legacy" });
    // A paperclip_runner config without a runner choice is kept as requested: an explicit choice.
    const native = await hire({ adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-sol" }, defaultEnvironmentId: devices.glibc.id });
    expect(native.payload).toMatchObject({ adapterType: "paperclip_runner", runner: "paperclip" });
    // New Claude agents stay on Legacy unless Paperclip Runner is chosen explicitly.
    expect((await hire({ adapterType: "claude_local", adapterConfig: {} })).payload).toMatchObject({ adapterType: "claude_local", runner: "auto" });
  });

  it("falls back to Legacy when the board picks a device the automatic runner cannot use, and keeps it where it can", async () => {
    const moved = await codexHire();
    const approved = await approve(moved.approvalId, { defaultEnvironmentId: devices.musl.id });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.payload).toMatchObject({ adapterType: "codex_local", runner: "auto", defaultEnvironmentId: devices.musl.id });
    const legacy = await agentRow(moved.agentId);
    expect(legacy).toMatchObject({ adapterType: "codex_local", defaultEnvironmentId: devices.musl.id, status: "paused" });
    expect(legacy.adapterConfig).toMatchObject({ model: "gpt-5.6-sol", dangerouslyBypassApprovalsAndSandbox: true });
    expect(legacy.adapterConfig).not.toHaveProperty("provider");
    expect(legacy.adapterConfig).not.toHaveProperty("codexPermissionMode");

    const kept = await codexHire();
    const keptApproval = await approve(kept.approvalId, { defaultEnvironmentId: devices.glibc2.id });
    expect(keptApproval.status, JSON.stringify(keptApproval.body)).toBe(200);
    expect(await agentRow(kept.agentId)).toMatchObject({ adapterType: "paperclip_runner", adapterConfig: expect.objectContaining({ provider: "codex" }), defaultEnvironmentId: devices.glibc2.id });
    expect(ssh.probed).toContain(String(devices.glibc2.config.host));
  });

  it("refuses an explicit Paperclip Runner hire on a device that cannot run it, before anything is written", async () => {
    const explicit = await codexHire({ runner: "paperclip" });
    // An approval recorded before the runner was (no runner): its paperclip_runner was asked for.
    const [unrecorded] = await db.insert(approvals).values({
      companyId,
      type: "hire_agent",
      status: "pending",
      payload: { ...explicit.payload, runner: undefined },
    }).returning();
    for (const approvalId of [explicit.approvalId, unrecorded!.id]) {
      const refused = await approve(approvalId, { defaultEnvironmentId: devices.musl.id });
      expect(refused.status, JSON.stringify(refused.body)).toBe(422);
      expect(refused.body.code).toBe("agent_runner_unavailable");
      expect(await approvalStatus(approvalId)).toBe("pending");
    }
    expect(await agentRow(explicit.agentId)).toMatchObject({ status: "pending_approval", adapterType: "paperclip_runner", defaultEnvironmentId: devices.glibc.id });

    const approved = await approve(explicit.approvalId, { defaultEnvironmentId: devices.glibc2.id });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await agentRow(explicit.agentId)).toMatchObject({ adapterType: "paperclip_runner", defaultEnvironmentId: devices.glibc2.id });
  });

  it("treats a device it cannot reach as unknown: an automatic runner falls back to Legacy, an explicit one is refused", async () => {
    const auto = await codexHire();
    const approved = await approve(auto.approvalId, { defaultEnvironmentId: devices.offline.id });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await agentRow(auto.agentId)).toMatchObject({ adapterType: "codex_local", defaultEnvironmentId: devices.offline.id });

    const explicit = await codexHire({ runner: "paperclip" });
    const refused = await approve(explicit.approvalId, { defaultEnvironmentId: devices.offline.id });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.code).toBe("agent_runner_platform_probe_failed");
    expect(refused.body.error).not.toMatch(/Advanced/);
    expect(await approvalStatus(explicit.approvalId)).toBe("pending");
  });

  it("resolves a null pick for the company's default device", async () => {
    await db.update(companies).set({ defaultEnvironmentId: devices.musl.id }).where(eq(companies.id, companyId));
    const unpinned = await codexHire();
    const approved = await approve(unpinned.approvalId, { defaultEnvironmentId: null });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await agentRow(unpinned.agentId)).toMatchObject({ adapterType: "codex_local", defaultEnvironmentId: null });
    expect(ssh.probed).toContain(String(devices.musl.config.host));
  });

  it("leaves Claude hires, hires approved without a pick and decided approvals alone", async () => {
    const claude = await hire({ adapterType: "claude_local", adapterConfig: {} });
    const unpicked = await codexHire();
    ssh.probed.length = 0;
    expect((await approve(claude.approvalId, { defaultEnvironmentId: devices.musl.id })).status).toBe(200);
    expect(await agentRow(claude.agentId)).toMatchObject({ adapterType: "claude_local", defaultEnvironmentId: devices.musl.id });
    expect((await approve(unpicked.approvalId, {})).status).toBe(200);
    expect(await agentRow(unpicked.agentId)).toMatchObject({ adapterType: "paperclip_runner", defaultEnvironmentId: devices.glibc.id });
    // An approve retried with a pick is idempotent and checks nothing.
    const retried = await approve(unpicked.approvalId, { defaultEnvironmentId: devices.musl.id });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(await agentRow(unpicked.agentId)).toMatchObject({ adapterType: "paperclip_runner", defaultEnvironmentId: devices.glibc.id });
    expect(ssh.probed).toEqual([]);
  });
});
