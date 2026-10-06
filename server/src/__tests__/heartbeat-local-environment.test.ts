import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { environmentService } from "../services/environments.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat environment tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

async function waitForRunLeasesToRelease(
  db: ReturnType<typeof createDb>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const leases = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.heartbeatRunId, runId));
    if (leases.length > 0 && leases.every((lease) => lease.status !== "active")) return leases;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await db
    .select()
    .from(environmentLeases)
    .where(eq(environmentLeases.heartbeatRunId, runId));
}

describeEmbeddedPostgres("heartbeat local environment lifecycle", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let previousAgentJwtSecret: string | undefined;

  beforeAll(async () => {
    previousAgentJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "heartbeat-local-environment-test-secret";
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-local-environment-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    // A run reaches its terminal status before finalizeRun finishes writing
    // its trailing lifecycle events and side effects (see the comment on
    // drainActiveRunExecutions in heartbeat.ts). Drain those in-flight writes
    // before the TRUNCATE below, or a write that lands after the company row
    // is gone violates heartbeat_run_events' foreign key.
    await heartbeat.drainActiveRunExecutions();
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "environment_leases",
        "environments",
        "activity_log",
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "company_skills",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    // Same reasoning as the afterEach drain: closing the embedded database
    // while a run's finalize work is still in flight lets a queued write hit
    // a socket that cleanup() already tore down.
    await heartbeat.drainActiveRunExecutions();
    await tempDb?.cleanup();
    if (previousAgentJwtSecret === undefined) {
      delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    } else {
      process.env.PAPERCLIP_AGENT_JWT_SECRET = previousAgentJwtSecret;
    }
  });

  it("runs work through the default Local environment lease", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ProcessAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
      runtimeConfig: {},
      permissions: {},
    });

    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();

    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");

    const localRows = await db
      .select()
      .from(environments)
      .where(eq(environments.driver, "local"));
    expect(localRows).toHaveLength(1);
    expect(localRows[0]?.name).toBe("Local");

    const leases = await waitForRunLeasesToRelease(db, queued!.id);
    expect(leases).toHaveLength(1);
    expect(leases[0]?.environmentId).toBe(localRows[0]?.id);
    expect(leases[0]?.status).toBe("released");
    expect(leases[0]?.provider).toBe("local");
    expect(leases[0]?.releasedAt).not.toBeNull();

    const context = finished?.contextSnapshot as Record<string, unknown>;
    expect(context.paperclipEnvironment).toMatchObject({
      id: localRows[0]?.id,
      name: "Local",
      driver: "local",
      leaseId: leases[0]?.id,
    });
  });

  it("injects run-scoped Paperclip env into process agents", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const tempDir = await mkdtemp(join(tmpdir(), "paperclip-process-env-"));
    const envPath = join(tempDir, "env.json");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ProcessAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: [
          "-e",
          [
            "const fs = require('node:fs');",
            `fs.writeFileSync(${JSON.stringify(envPath)}, JSON.stringify({`,
            "agentId: process.env.PAPERCLIP_AGENT_ID ?? null,",
            "companyId: process.env.PAPERCLIP_COMPANY_ID ?? null,",
            "apiUrl: process.env.PAPERCLIP_API_URL ?? null,",
            "runId: process.env.PAPERCLIP_RUN_ID ?? null,",
            "apiKeyPresent: Boolean(process.env.PAPERCLIP_API_KEY),",
            "}));",
          ].join(" "),
        ],
      },
      runtimeConfig: {},
      permissions: {},
    });

    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();

    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");

    const captured = JSON.parse(await readFile(envPath, "utf8")) as Record<string, unknown>;
    expect(captured).toMatchObject({
      agentId,
      companyId,
      runId: queued!.id,
      apiKeyPresent: true,
    });
    expect(captured.apiUrl).toEqual(expect.stringMatching(/^https?:\/\//));
  });
  async function seedProcessAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ProcessAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function seedUnreachableSshEnvironment() {
    const id = randomUUID();
    await db.insert(environments).values({
      id,
      name: "Unreachable SSH runner",
      driver: "ssh",
      status: "active",
      config: { host: "127.0.0.1", port: 1, username: "nobody", remoteWorkspacePath: "/tmp" },
    });
    return id;
  }

  it("runs on the project default ahead of the instance default", async () => {
    const companyId = randomUUID();
    const agentId = await seedProcessAgent(companyId);
    const local = await environmentService(db).ensureLocalEnvironment(companyId);
    // Without the project default the run would land on this SSH runner.
    await instanceSettingsService(db).update({ defaultEnvironmentId: await seedUnreachableSshEnvironment() });
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Local work", defaultEnvironmentId: local.id });

    const queued = await heartbeat.invoke(agentId, "on_demand", { projectId }, "manual");
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");
    const leases = await waitForRunLeasesToRelease(db, queued!.id);
    expect(leases[0]?.environmentId).toBe(local.id);
  });

  it("skips a company default the agent's adapter cannot run in", async () => {
    const companyId = randomUUID();
    const agentId = await seedProcessAgent(companyId);
    // The process adapter runs only on the local host, so an SSH company
    // default is skipped instead of failing the run.
    await db
      .update(companies)
      .set({ defaultEnvironmentId: await seedUnreachableSshEnvironment() })
      .where(eq(companies.id, companyId));

    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");
    const local = await environmentService(db).ensureLocalEnvironment(companyId);
    const leases = await waitForRunLeasesToRelease(db, queued!.id);
    expect(leases[0]?.environmentId).toBe(local.id);
  });
});
