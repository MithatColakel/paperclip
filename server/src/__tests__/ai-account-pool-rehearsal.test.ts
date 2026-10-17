import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate as migrateLegacy } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { applyPendingMigrations, ensurePostgresDatabase, inspectMigrations } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  REHEARSAL_DATABASE_URL_ENV,
  runAiAccountPoolRehearsal,
  type AiAccountPoolRehearsalResult,
} from "../scripts/ai-account-pool-rehearsal.js";

// Fork: the snapshot rehearsal of the Claude account binding backfill (spec
// 15.1, 15.3 and 17 step 1): its refusals, go, no-go and error runs on a
// production-shaped snapshot (the 0308 schema with host-pool history), and the
// command line as the image runs it.

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);
const suffix = () => randomUUID().replaceAll("-", "").slice(0, 12);

async function rehearse(env: Record<string, string | undefined>, argv: string[] = ["--snapshot"]) {
  let stdout = "";
  let stderr = "";
  const code = await runAiAccountPoolRehearsal({
    argv,
    env,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr, output: stdout ? (JSON.parse(stdout) as AiAccountPoolRehearsalResult) : null };
}

describe("AI account pool rehearsal: refusals", () => {
  const password = "Rehearsal-Pa55word";
  const snapshotUrl = `postgres://operator:${password}@db.invalid:5432/paperclip_rehearsal`;

  it("requires --snapshot before it reads the database URL", async () => {
    const result = await rehearse({ [REHEARSAL_DATABASE_URL_ENV]: snapshotUrl }, []);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^Refused: --snapshot is required/);
    expect(result.stderr).not.toContain(password);
    expect(result.stderr).not.toContain("db.invalid");
  });

  it("never uses DATABASE_URL, even one that names a snapshot", async () => {
    const result = await rehearse({ DATABASE_URL: "postgres://paperclip:Live-Secret-1@live.invalid:5432/paperclip_snapshot" });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`Refused: ${REHEARSAL_DATABASE_URL_ENV} is not set.`);
    expect(result.stderr).not.toMatch(/Live-Secret-1|live\.invalid|Rehearsal target/);
  });

  it("refuses a database whose name does not mark it as a rehearsal copy, before it connects", async () => {
    const result = await rehearse({ [REHEARSAL_DATABASE_URL_ENV]: `postgres://operator:${password}@prod.invalid:5432/paperclip` });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('Refused: The database "paperclip" on host prod.invalid is not a rehearsal copy');
    expect(result.stderr).not.toContain(password);
    expect(result.stderr).not.toContain("Rehearsal target");
  });

  it.each([
    ["an invalid URL", `postgres://operator:${password}@db.invalid:99999/paperclip_rehearsal`, "is not a valid postgres:// URL."],
    ["another protocol", `mysql://operator:${password}@db.invalid/paperclip_rehearsal`, "must be a postgres:// or postgresql:// URL."],
    ["no database", `postgres://operator:${password}@db.invalid:5432`, "names no database."],
    ["several hosts", `postgres://operator:${password}@db-a.invalid,db-b.invalid:5432/paperclip_snapshot`, "names several hosts"],
  ])("refuses %s without printing its password", async (_label, url, message) => {
    const result = await rehearse({ [REHEARSAL_DATABASE_URL_ENV]: url });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
    expect(result.stderr).not.toContain(password);
  });

  it("takes no other argument and never echoes one", async () => {
    const result = await rehearse({}, ["--snapshot", snapshotUrl]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`Refused: This script takes only --snapshot; the database URL goes in ${REHEARSAL_DATABASE_URL_ENV}.`);
    expect(result.stderr).not.toContain(password);
  });

  it("prints its usage on --help", async () => {
    const result = await rehearse({}, ["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/scripts/ai-account-pool-rehearsal.js --snapshot",
    );
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping embedded Postgres rehearsal tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

type LegacyClient = ReturnType<typeof drizzle>;
type Ref = { id: string; name: string };

/** Rows as the previous image left them, written with the 0308 columns only. */
function legacySeeder(url: string) {
  const client: LegacyClient = drizzle({ connection: { url, max: 1, onnotice: () => {} } });
  const secrets: string[] = [];
  return {
    secrets,
    close: () => client.$client.end(),
    async company(name: string) {
      const id = randomUUID();
      await client.execute(sql`INSERT INTO companies (id, name, issue_prefix)
        VALUES (${id}, ${name}, ${`R${id.replaceAll("-", "").slice(0, 7).toUpperCase()}`})`);
      return id;
    },
    async user(id: string) {
      await client.execute(sql`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
        VALUES (${id}, ${`User ${id}`}, ${`${id}@example.com`}, true, now(), now())`);
    },
    async member(companyId: string, userId: string) {
      await client.execute(sql`INSERT INTO company_memberships (company_id, principal_type, principal_id, status, membership_role)
        VALUES (${companyId}, 'user', ${userId}, 'active', 'owner')`);
    },
    async agent(companyId: string, name: string, createdDaysAgo: number): Promise<Ref & { companyId: string }> {
      const id = randomUUID();
      await client.execute(sql`INSERT INTO agents (id, company_id, name, adapter_type, created_at)
        VALUES (${id}, ${companyId}, ${name}, 'claude_local', ${daysAgo(createdDaysAgo).toISOString()}::timestamptz)`);
      return { id, name, companyId };
    },
    /** The server's legacy host, mapped to the Local environment. */
    async serverHost(name: string): Promise<Ref> {
      const [local] = [...await client.execute(sql`SELECT id FROM environments WHERE driver = 'local' LIMIT 1`)] as Array<{ id: string }>;
      expect(local, "the migrations seed the Local environment").toBeDefined();
      const id = randomUUID();
      await client.execute(sql`INSERT INTO ai_account_hosts (id, name, kind) VALUES (${id}, ${name}, 'server')`);
      await client.execute(sql`INSERT INTO ai_account_host_environments (environment_id, host_id) VALUES (${local!.id}, ${id})`);
      return { id, name };
    },
    async account(hostId: string, label: string, creatorUserId: string): Promise<Ref> {
      const id = randomUUID();
      const ciphertext = `rehearsal-ciphertext-${randomUUID()}`;
      const fingerprint = `rehearsal-fingerprint-${randomUUID()}`;
      secrets.push(ciphertext, fingerprint);
      await client.execute(sql`INSERT INTO ai_accounts (id, host_id, credential_type, label, credential_material, credential_fingerprint, created_by_user_id)
        VALUES (${id}, ${hostId}, 'subscription', ${label}, ${JSON.stringify({ scheme: "local_encrypted_v1", ciphertext })}::jsonb, ${fingerprint}, ${creatorUserId})`);
      return { id, name: label };
    },
    /** Host-pool runs: the attribution the previous image's `selectForRun` wrote. */
    async hostPoolRuns(
      agent: Ref & { companyId: string },
      account: Ref,
      host: Ref,
      opts: { scope: "project" | "shared" | "overflow"; count: number; daysAgo: number },
    ) {
      for (let index = 0; index < opts.count; index += 1) {
        const attribution = {
          mode: "host_pool",
          provider: "anthropic",
          method: "subscription",
          accountId: account.id,
          accountName: account.name,
          hostId: host.id,
          hostName: host.name,
          scope: opts.scope,
        };
        await client.execute(sql`INSERT INTO heartbeat_runs (company_id, agent_id, status, created_at, context_snapshot)
          VALUES (${agent.companyId}, ${agent.id}, 'succeeded', ${new Date(daysAgo(opts.daysAgo).getTime() - index * 1000).toISOString()}::timestamptz,
            ${JSON.stringify({ aiConnection: attribution })}::jsonb)`);
      }
    },
  };
}

async function query<T>(url: string, statement: SQL): Promise<T[]> {
  const client = drizzle({ connection: { url, max: 1, onnotice: () => {} } });
  try {
    return [...await client.execute(statement)] as T[];
  } finally {
    await client.$client.end();
  }
}

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** The command line as the image runs it from /app, on the source instead of server/dist. */
function runCommandLine(env: Record<string, string>, argv: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const args = ["--import", "./server/node_modules/tsx/dist/loader.mjs", "server/src/scripts/ai-account-pool-rehearsal.ts", ...argv];
    const child = spawn(process.execPath, args, { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describeEmbeddedPostgres("AI account pool rehearsal on a restored snapshot", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let template = "";
  let releaseMigrations: string[] = [];

  const urlFor = (name: string) => {
    const url = new URL(database.connectionString);
    url.pathname = `/${name}`;
    return url.href;
  };
  const port = () => Number(new URL(database.connectionString).port);

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_DEPLOYMENT_MODE", "authenticated");
    database = await startEmbeddedPostgresTestDatabase("paperclip-ai-account-rehearsal-");

    // The snapshot template: every migration before the release's DDL, the state production runs today.
    type JournalEntry = { idx: number; tag: string; when: number; version: string; breakpoints: boolean };
    const migrationsDir = new URL("../../../packages/db/src/migrations/", import.meta.url);
    const journal = JSON.parse(await readFile(new URL("meta/_journal.json", migrationsDir), "utf8")) as { entries: JournalEntry[] };
    let ddlPosition = -1;
    for (let position = journal.entries.length - 1; position >= 0 && ddlPosition < 0; position -= 1) {
      const content = await readFile(new URL(`${journal.entries[position]!.tag}.sql`, migrationsDir), "utf8");
      if (content.includes('CREATE TABLE "ai_account_agent_bindings"')) ddlPosition = position;
    }
    expect(ddlPosition).toBeGreaterThan(0);
    releaseMigrations = journal.entries.slice(ddlPosition).map((entry) => `${entry.tag}.sql`);

    template = `rehearsal_template_${suffix()}`;
    expect(await ensurePostgresDatabase(database.connectionString, template)).toBe("created");
    const legacyDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-account-rehearsal-"));
    try {
      await mkdir(path.join(legacyDir, "meta"));
      const prior = journal.entries.slice(0, ddlPosition);
      for (const entry of prior) {
        await writeFile(path.join(legacyDir, `${entry.tag}.sql`), await readFile(new URL(`${entry.tag}.sql`, migrationsDir)));
      }
      await writeFile(path.join(legacyDir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: prior }));
      const migrator = drizzle({ connection: { url: urlFor(template), max: 1, onnotice: () => {} } });
      try {
        await migrateLegacy(migrator, { migrationsFolder: legacyDir });
      } finally {
        await migrator.$client.end();
      }
    } finally {
      await rm(legacyDir, { recursive: true, force: true });
    }
  }, 300_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await database?.cleanup();
  });

  /** A copy of the template, as a restored dump would be. */
  async function restoredSnapshot(name: string): Promise<string> {
    const admin = drizzle({ connection: { url: database.connectionString, max: 1, onnotice: () => {} } });
    try {
      await admin.$client.unsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${template}' AND pid <> pg_backend_pid()`,
      );
      await admin.$client.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
    } finally {
      await admin.$client.end();
    }
    return urlFor(name);
  }

  async function bindingsOf(url: string) {
    return query<{ agentId: string; accountId: string | null; source: string }>(
      url,
      sql`SELECT agent_id AS "agentId", account_id AS "accountId", source FROM ai_account_agent_bindings`,
    );
  }

  it("go: applies the release's migrations, binds the agents, exits 0, and a re-run changes nothing", async () => {
    const name = `paperclip_snapshot_go_${suffix()}`;
    const url = await restoredSnapshot(name);
    const seed = legacySeeder(url);
    const acme = await seed.company("Acme");
    await seed.user("owner");
    await seed.member(acme, "owner");
    const server = await seed.serverHost("Server");
    const max = await seed.account(server.id, "Max", "owner");
    // History older than the go/no-go window: bound, but not part of the go/no-go.
    const veteran = await seed.agent(acme, "Veteran", 30);
    await seed.hostPoolRuns(veteran, max, server, { scope: "project", count: 1, daysAgo: 20 });
    const builder = await seed.agent(acme, "Builder", 10);
    await seed.hostPoolRuns(builder, max, server, { scope: "shared", count: 2, daysAgo: 1 });
    await seed.close();

    const servers = () => process.getActiveResourcesInfo().filter((resource) => resource === "TCPServerWrap").length;
    const serversBefore = servers();
    const first = await rehearse({ [REHEARSAL_DATABASE_URL_ENV]: url });
    expect(first.code, first.stderr).toBe(0);
    expect(first.output).toMatchObject({
      target: { host: "127.0.0.1", port: port(), database: name },
      deploymentMode: "authenticated",
      migrations: { pending: releaseMigrations, repaired: [], applied: releaseMigrations },
      backfill: { status: "completed", added: 2, error: null },
      verdict: "go",
      error: null,
      exitCode: 0,
    });
    expect(first.output?.target.serverVersion).toEqual(expect.any(String));
    expect(first.output?.report).toMatchObject({
      status: "completed",
      attempts: 1,
      lastError: null,
      summary: { bound: 2, unassigned: 0, unbound: 0, overLimitDevices: [] },
    });
    expect(first.output?.report?.goNoGo).toEqual({
      go: true,
      agents: [{ agentId: builder.id, agentName: "Builder", companyId: acme, companyName: "Acme", plan: "use", reason: null }],
    });
    expect((await bindingsOf(url)).map((row) => [row.agentId, row.accountId, row.source]).sort()).toEqual(
      [[veteran.id, max.id, "migrated_host_pool"], [builder.id, max.id, "migrated_host_pool"]].sort(),
    );

    // The target comes first, then the run; the summary ends with the verdict.
    expect(first.stderr.indexOf(`Rehearsal target: host 127.0.0.1, port ${port()}, database ${name}\n`)).toBe(0);
    expect(first.stderr).toContain(`Migrations: ${releaseMigrations.length} applied`);
    expect(first.stderr).toContain("Outcomes: 2 bound, 0 unassigned (waiting for an account), 0 unbound");
    expect(first.stderr).toContain("Bound by rule: agent_history 2");
    expect(first.stderr).toContain("Go/no-go: 1 of 1 Claude agents with a host-pool run in the last 7 days would use their account.");
    expect(first.stderr).toMatch(/Result: GO \(exit code 0\)\. The JSON report is on stdout\.\n$/);
    for (const secret of [...seed.secrets, "paperclip:paperclip@"]) {
      expect(first.stdout).not.toContain(secret);
      expect(first.stderr).not.toContain(secret);
    }
    // No HTTP server was started.
    expect(servers()).toBe(serversBefore);

    const second = await rehearse({ [REHEARSAL_DATABASE_URL_ENV]: url });
    expect(second.code, second.stderr).toBe(0);
    expect(second.output).toMatchObject({
      migrations: { pending: [], repaired: [], applied: [] },
      backfill: { status: "completed", added: 0, error: null },
      verdict: "go",
    });
    expect(second.output?.report).toMatchObject({ status: "completed", attempts: 2, summary: { bound: 2, unassigned: 0, unbound: 0 } });
    expect(second.stderr).toContain("Migrations: none pending.");
    expect(await bindingsOf(url)).toHaveLength(2);
  }, 180_000);

  it("go: an agent whose own account is at its limit waits for the reset, which is a warning and not a blocker", async () => {
    const name = `paperclip_snapshot_limited_${suffix()}`;
    const url = await restoredSnapshot(name);
    const seed = legacySeeder(url);
    const acme = await seed.company("Acme");
    await seed.user("owner");
    await seed.member(acme, "owner");
    const server = await seed.serverHost("Server");
    const maxB = await seed.account(server.id, "Max B", "owner");
    const web = await seed.agent(acme, "Web dev", 10);
    await seed.hostPoolRuns(web, maxB, server, { scope: "shared", count: 2, daysAgo: 1 });
    await seed.close();
    // The backup was taken an hour after the account hit its 5-hour window.
    await query(url, sql`UPDATE ai_accounts SET exhausted_until = now() + interval '2 hours', limit_reason = 'provider_quota' WHERE id = ${maxB.id}`);

    const result = await rehearse({ [REHEARSAL_DATABASE_URL_ENV]: url });
    expect(result.code, result.stderr).toBe(0);
    expect(result.output).toMatchObject({ backfill: { status: "completed", added: 1 }, verdict: "go", exitCode: 0 });
    expect(result.output?.report?.goNoGo).toEqual({
      go: true,
      agents: [{ agentId: web.id, agentName: "Web dev", companyId: acme, companyName: "Acme", plan: "wait", reason: "usage_limit" }],
    });
    expect(result.stderr).toContain(
      "Go/no-go: 0 of 1 Claude agents with a host-pool run in the last 7 days would use their account.\n"
        + "At their account's limit, waiting for its reset on the same account; this does not block go (1):\n"
        + "  - Acme / Web dev: usage_limit",
    );
    expect(result.stderr).toMatch(/Result: GO \(exit code 0\)\. The JSON report is on stdout\.\n$/);
  }, 180_000);

  it("no-go: the command line names each agent that would not use its account, the full device and the unbound agent, and exits 2", async () => {
    const name = `paperclip_rehearsal_nogo_${suffix()}`;
    const url = await restoredSnapshot(name);
    const seed = legacySeeder(url);
    const acme = await seed.company("Acme");
    const beta = await seed.company("Beta");
    await seed.user("owner");
    await seed.user("outsider");
    await seed.member(acme, "owner");
    const server = await seed.serverHost("Server");
    const owned: Ref[] = [];
    for (const label of ["One", "Two", "Three", "Four"]) owned.push(await seed.account(server.id, label, "owner"));
    const foreign = await seed.account(server.id, "Foreign", "outsider");
    // Four agents on four accounts of one device: the fourth is over the cap of 3.
    const acmeAgents: Array<Ref & { companyId: string }> = [];
    for (const [index, agentName] of ["Builder", "Coder", "Designer", "Editor"].entries()) {
      const agent = await seed.agent(acme, agentName, 10 - index);
      await seed.hostPoolRuns(agent, owned[index]!, server, { scope: "shared", count: 2, daysAgo: 1 });
      acmeAgents.push(agent);
    }
    // Its account belongs to someone who is not a member of Acme.
    const writer = await seed.agent(acme, "Writer", 6);
    await seed.hostPoolRuns(writer, foreign, server, { scope: "project", count: 1, daysAgo: 2 });
    // No history, on a device with usable accounts, and no company history there: left unbound.
    const planner = await seed.agent(beta, "Planner", 5);
    await seed.close();

    const decoyPassword = "Decoy-Live-Pa55";
    const env: Record<string, string> = {
      NODE_ENV: "production",
      PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
      [REHEARSAL_DATABASE_URL_ENV]: url,
      // A live database the script must never use.
      DATABASE_URL: `postgres://paperclip:${decoyPassword}@127.0.0.1:9/paperclip`,
      LANG: "en_US.UTF-8",
    };
    for (const key of ["PATH", "HOME", "TMPDIR", "PAPERCLIP_HOME", "CODEX_HOME"]) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
    const run = await runCommandLine(env, ["--snapshot"]);
    expect(run.code, run.stderr).toBe(2);
    // stdout is exactly one JSON document: the server's logger writes elsewhere.
    const output = JSON.parse(run.stdout) as AiAccountPoolRehearsalResult;
    expect(output).toMatchObject({
      target: { host: "127.0.0.1", port: port(), database: name },
      deploymentMode: "authenticated",
      migrations: { pending: releaseMigrations, repaired: [], applied: releaseMigrations },
      backfill: { status: "completed", added: 5, error: null },
      verdict: "no-go",
      error: null,
      exitCode: 2,
    });
    const report = output.report!;
    expect(report).toMatchObject({ status: "completed", attempts: 1, lastError: null });
    expect(report.summary).toMatchObject({
      bound: 3,
      unassigned: 2,
      unbound: 1,
      overLimitDevices: [{ deviceId: server.id, deviceName: "Server", limit: 3, inUse: 3 }],
    });
    expect(report.summary!.agents.map((entry) => [entry.agentName, entry.companyName, entry.outcome, entry.rule]).sort()).toEqual([
      ["Builder", "Acme", "bound", "agent_history"],
      ["Coder", "Acme", "bound", "agent_history"],
      ["Designer", "Acme", "bound", "agent_history"],
      ["Editor", "Acme", "unassigned", "agent_history"],
      ["Planner", "Beta", "unbound", null],
      ["Writer", "Acme", "unassigned", "agent_history"],
    ]);
    const use = (agent: Ref) => ({ agentId: agent.id, agentName: agent.name, companyId: acme, companyName: "Acme", plan: "use", reason: null });
    const waiting = (agent: Ref) => ({ agentId: agent.id, agentName: agent.name, companyId: acme, companyName: "Acme", plan: "wait", reason: "unassigned" });
    expect(report.goNoGo).toEqual({
      go: false,
      agents: [use(acmeAgents[0]!), use(acmeAgents[1]!), use(acmeAgents[2]!), waiting(acmeAgents[3]!), waiting(writer)],
    });
    const bindings = new Map((await bindingsOf(url)).map((row) => [row.agentId, row.accountId]));
    expect(bindings.size).toBe(5);
    expect(bindings.get(acmeAgents[3]!.id)).toBeNull();
    expect(bindings.get(writer.id)).toBeNull();
    expect(bindings.has(planner.id)).toBe(false);

    const target = run.stderr.indexOf(`Rehearsal target: host 127.0.0.1, port ${port()}, database ${name}\n`);
    expect(target).toBeGreaterThanOrEqual(0);
    expect(target).toBeLessThan(run.stderr.indexOf("Migrations:"));
    for (const line of [
      "Outcomes: 3 bound, 2 unassigned (waiting for an account), 1 unbound",
      "Devices at or over their account cap (1):\n  - Server: 3 of 3 accounts in use",
      "Unassigned, waiting for an account (2):",
      "  - Acme / Editor: The Claude account this agent used most in the last 45 days cannot be added: Server already runs 3 of 3 Claude accounts.",
      "  - Acme / Writer: The Claude account this agent used most in the last 45 days",
      "Left unbound, with a review note (1):\n  - Beta / Planner: No reserved project, history of this agent, or company history on its devices points to a Claude account.",
      "Go/no-go: 3 of 5 Claude agents with a host-pool run in the last 7 days would use their account.\n"
        + "  - Acme / Editor: wait (unassigned)\n  - Acme / Writer: wait (unassigned)",
      "Result: NO-GO (exit code 2). The JSON report is on stdout.",
    ]) {
      expect(run.stderr).toContain(line);
    }
    for (const secret of [...seed.secrets, decoyPassword, "paperclip:paperclip@"]) {
      expect(run.stdout).not.toContain(secret);
      expect(run.stderr).not.toContain(secret);
    }
    // The other databases of the server were not touched.
    expect(await query<{ count: number }>(database.connectionString, sql`SELECT count(*)::int AS count FROM deferred_data_migrations`))
      .toEqual([{ count: 0 }]);
  }, 180_000);

  it("error: a failed backfill prints the report with its error and exits 1, whatever the go/no-go", async () => {
    const name = `paperclip_snapshot_failing_${suffix()}`;
    const url = await restoredSnapshot(name);
    const seed = legacySeeder(url);
    const acme = await seed.company("Acme");
    await seed.user("owner");
    await seed.member(acme, "owner");
    const server = await seed.serverHost("Server");
    const max = await seed.account(server.id, "Max", "owner");
    const builder = await seed.agent(acme, "Builder", 10);
    await seed.hostPoolRuns(builder, max, server, { scope: "shared", count: 1, daysAgo: 1 });
    await seed.close();
    // The release's schema is in place, and every binding insert fails.
    await applyPendingMigrations(url);
    await query(url, sql.raw(
      "CREATE FUNCTION rehearsal_refuse_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'binding inserts are switched off'; END $$",
    ));
    await query(url, sql.raw(
      "CREATE TRIGGER rehearsal_refuse_binding BEFORE INSERT ON ai_account_agent_bindings FOR EACH ROW EXECUTE FUNCTION rehearsal_refuse_binding()",
    ));

    const result = await rehearse({ [REHEARSAL_DATABASE_URL_ENV]: url });
    expect(result.code, result.stderr).toBe(1);
    expect(result.output).toMatchObject({
      migrations: { pending: [], repaired: [], applied: [] },
      backfill: { status: "failed", added: null, error: "binding inserts are switched off" },
      verdict: "error",
      error: "The binding backfill failed: binding inserts are switched off",
      exitCode: 1,
    });
    expect(result.output?.report).toMatchObject({ status: "failed", attempts: 1, lastError: "binding inserts are switched off", summary: null });
    expect(result.output?.report?.goNoGo).toEqual({
      go: false,
      agents: [{ agentId: builder.id, agentName: "Builder", companyId: acme, companyName: "Acme", plan: "none", reason: "no Claude account is assigned" }],
    });
    expect(result.stderr).toContain("Binding backfill: failed after");
    expect(result.stderr).toContain("Outcomes: none recorded; the binding backfill did not complete.");
    expect(result.stderr).toContain("  - Acme / Builder: none (no Claude account is assigned)");
    expect(result.stderr).toMatch(/Error: The binding backfill failed: binding inserts are switched off\nResult: ERROR \(exit code 1\)\. The JSON report is on stdout\.\n$/);
    expect(await bindingsOf(url)).toEqual([]);
  }, 120_000);

  it("error: a database with tables but no migration journal is left as it is, and the run exits 1", async () => {
    const name = `paperclip_rehearsal_unknown_${suffix()}`;
    expect(await ensurePostgresDatabase(database.connectionString, name)).toBe("created");
    await query(urlFor(name), sql.raw("CREATE TABLE unrelated (id integer)"));

    const result = await rehearse({ [REHEARSAL_DATABASE_URL_ENV]: urlFor(name) });
    expect(result.code, result.stderr).toBe(1);
    expect(result.output).toMatchObject({ migrations: null, backfill: null, report: null, verdict: "error", exitCode: 1 });
    expect(result.output?.error).toContain("no migration journal");
    expect(result.stderr).toMatch(/Migrations: \d+ pending migrations \(\S+, \S+, \S+ \(\+\d+ more\)\)\.\n/);
    expect(result.stderr).toMatch(/Result: ERROR \(exit code 1\)\. The JSON report is on stdout\.\n$/);
    expect(await inspectMigrations(urlFor(name))).toMatchObject({
      status: "needsMigrations",
      reason: "no-migration-journal-non-empty-db",
      tableCount: 1,
    });
  }, 60_000);

  it("refuses an empty database: nothing was restored into it", async () => {
    const name = `paperclip_rehearsal_empty_${suffix()}`;
    expect(await ensurePostgresDatabase(database.connectionString, name)).toBe("created");
    const result = await rehearse({ [REHEARSAL_DATABASE_URL_ENV]: urlFor(name) });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`Rehearsal target: host 127.0.0.1, port ${port()}, database ${name}`);
    expect(result.stderr).toContain("Refused: The database has no tables: restore the production dump into it first. Nothing was changed.");
    expect(await inspectMigrations(urlFor(name))).toMatchObject({ status: "needsMigrations", reason: "no-migration-journal-empty-db", tableCount: 0 });
  }, 60_000);

  it("refuses when the server reports another database than the URL names", async () => {
    const name = `paperclip_snapshot_redirect_${suffix()}`;
    expect(await ensurePostgresDatabase(database.connectionString, name)).toBe("created");
    // The driver sends query parameters to the server, so this one connects to `paperclip`.
    const result = await rehearse({ [REHEARSAL_DATABASE_URL_ENV]: `${urlFor(name)}?database=paperclip` });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`Refused: The server reports database "paperclip", not "${name}".`);
    expect(await query<{ count: number }>(database.connectionString, sql`SELECT count(*)::int AS count FROM deferred_data_migrations`))
      .toEqual([{ count: 0 }]);
    expect(await inspectMigrations(urlFor(name))).toMatchObject({ status: "needsMigrations", reason: "no-migration-journal-empty-db" });
  }, 60_000);
});
