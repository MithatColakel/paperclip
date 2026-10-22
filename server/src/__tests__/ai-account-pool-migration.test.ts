import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { boolean, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  aiAccountAgentBindings,
  aiAccountHostEnvironments,
  aiAccountHosts,
  aiAccountProjects,
  aiAccounts,
  applyPendingMigrations,
  closeRegisteredClients,
  createDb,
  ensurePostgresDatabase,
  inspectMigrations,
  resourceWaitEpisodes,
} from "@paperclipai/db";
import { LOCAL_EXECUTION_DEVICE_KEY, sshExecutionDeviceKey } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Fork: the Claude account pool migrations. The DDL migration is the one that
// creates the bindings table and the data migration follows it, so this suite
// keeps working when both files are renumbered behind upstream.

type JournalEntry = { idx: number; tag: string; when: number; version: string; breakpoints: boolean };
type Journal = { version: string; dialect: string; entries: JournalEntry[] };

const migrationsDir = new URL("../../../packages/db/src/migrations/", import.meta.url);
const journal = JSON.parse(await readFile(new URL("meta/_journal.json", migrationsDir), "utf8")) as Journal;
const ddlPosition = await (async () => {
  for (let position = journal.entries.length - 1; position >= 0; position -= 1) {
    const content = await readFile(new URL(`${journal.entries[position]!.tag}.sql`, migrationsDir), "utf8");
    if (content.includes('CREATE TABLE "ai_account_agent_bindings"')) return position;
  }
  throw new Error("The account pool DDL migration is missing from the journal");
})();
const ddlEntry = journal.entries[ddlPosition]!;
const dataEntry = journal.entries[ddlPosition + 1]!;
const ddlSql = await readFile(new URL(`${ddlEntry.tag}.sql`, migrationsDir), "utf8");
const dataSql = await readFile(new URL(`${dataEntry.tag}.sql`, migrationsDir), "utf8");

// Production reached the fork's 0308 as upstream's 0000–0305 followed by the
// fork's first pool migrations, the ones right before the DDL. The upstream
// files the 2026-10 sync numbered ahead of them are not on such a database, and
// Drizzle's stock migrate() could not build them anyway: it runs one
// transaction, which their CONCURRENTLY and batch-committing statements refuse.
const forkBasePosition = journal.entries.findIndex((entry) => entry.tag === "0305_chubby_vin_gonzales") + 1;
if (forkBasePosition === 0) throw new Error("The fork's base migration is missing from the journal");
const forkStartPosition = await (async () => {
  for (let position = forkBasePosition; position < ddlPosition; position += 1) {
    const content = await readFile(new URL(`${journal.entries[position]!.tag}.sql`, migrationsDir), "utf8");
    if (content.includes('CREATE TABLE "ai_connection_pool_members"')) return position;
  }
  throw new Error("The fork's first account pool migration is missing from the journal");
})();
const priorEntries = [...journal.entries.slice(0, forkBasePosition), ...journal.entries.slice(forkStartPosition, ddlPosition)];
// Pending on that database: upstream's files from the sync, the DDL, the data migration and later files.
const upgradeMigrations = journal.entries.filter((entry) => !priorEntries.includes(entry)).map((entry) => `${entry.tag}.sql`);

/** The public schema, ordered by name. Column order is left out: where upstream
 * and the fork both added columns to one table, it follows the order the
 * migrations ran in, and nothing reads columns by position. */
async function publicSchemaOf(target: ReturnType<typeof createDb>) {
  return {
    columns: [...await target.execute(sql`SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
      FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, column_name`)],
    indexes: [...await target.execute(sql`SELECT tablename, indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' ORDER BY tablename, indexname`)],
    constraints: [...await target.execute(sql`SELECT c.relname, k.conname, pg_get_constraintdef(k.oid) AS definition
      FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' ORDER BY c.relname, k.conname`)],
    triggers: [...await target.execute(sql`SELECT c.relname, t.tgname, pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal ORDER BY c.relname, t.tgname`)],
    functions: [...await target.execute(sql`SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS arguments,
        md5(pg_get_functiondef(p.oid)) AS definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p') ORDER BY 1, 2`)],
  };
}

// What the d6f6d1cad image knows about `ai_accounts`: exactly the columns of the fork's 0308.
// Drizzle names every one of them in its inserts and selects.
const oldImageAiAccounts = pgTable("ai_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  hostId: uuid("host_id").notNull(),
  provider: text("provider").notNull().default("anthropic"),
  credentialType: text("credential_type").notNull(),
  label: text("label").notNull(),
  emailHint: text("email_hint"),
  plan: text("plan"),
  poolEnabled: boolean("pool_enabled").notNull().default(true),
  status: text("status").notNull().default("active"),
  statusMessage: text("status_message"),
  credentialMaterial: jsonb("credential_material").$type<Record<string, unknown>>().notNull(),
  credentialFingerprint: text("credential_fingerprint").notNull(),
  credentialHint: text("credential_hint"),
  exhaustedUntil: timestamp("exhausted_until", { withTimezone: true }),
  limitReason: text("limit_reason"),
  limitRunId: uuid("limit_run_id"),
  lastLimitedAt: timestamp("last_limited_at", { withTimezone: true }),
  lastSelectedAt: timestamp("last_selected_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdByUserId: text("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

const material = (n: number) => ({ provider: "local_encrypted", ciphertext: `cipher-${n}` });

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres account pool migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("account pool migration files", () => {
  it("the DDL migration frees credentials from devices and scopes e-mail hints per owner", () => {
    expect(ddlEntry.idx).toBe(dataEntry.idx - 1);
    expect(ddlSql).toContain('ALTER TABLE "ai_accounts" DROP CONSTRAINT "ai_accounts_host_id_ai_account_hosts_id_fk"');
    expect(ddlSql).toContain('ALTER TABLE "ai_accounts" ALTER COLUMN "host_id" DROP NOT NULL');
    expect(ddlSql).toContain(
      'ADD CONSTRAINT "ai_accounts_host_id_ai_account_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."ai_account_hosts"("id") ON DELETE set null',
    );
    expect(ddlSql).toContain('ALTER TABLE "ai_account_hosts" DROP CONSTRAINT "ai_account_hosts_kind_check"');
    expect(ddlSql).toContain(`CHECK ("ai_account_hosts"."kind" in ('server','ssh_host','mac','external'))`);
    expect(ddlSql).toContain('DROP INDEX "ai_accounts_email_hint_uq"');
    expect(ddlSql).toContain(
      'CREATE UNIQUE INDEX "ai_accounts_owner_email_hint_uq" ON "ai_accounts" USING btree (coalesce("owner_user_id", "created_by_user_id"),lower("email_hint")) WHERE "ai_accounts"."email_hint" is not null',
    );
    for (const table of [
      "ai_account_agent_bindings",
      "ai_account_run_slots",
      "environment_availability",
      "resource_wait_episodes",
      "resource_wait_notices",
      "execution_wait_settings",
      "deferred_data_migrations",
    ]) {
      expect(ddlSql).toContain(`CREATE TABLE "${table}"`);
    }
    for (const index of [
      "ai_account_hosts_external_key_uq",
      "ai_account_hosts_target_key_uq",
      "ai_accounts_owner_idx",
      "ai_account_agent_bindings_account_idx",
      "ai_account_agent_bindings_company_account_idx",
      "ai_account_run_slots_device_idx",
      "environment_availability_state_next_check_idx",
      "resource_wait_episodes_open_uq",
      "resource_wait_episodes_company_open_idx",
      "resource_wait_episodes_current_run_idx",
      // The cascading composite foreign keys to agents and issues.
      "resource_wait_episodes_company_issue_idx",
      "resource_wait_episodes_company_agent_idx",
    ]) {
      expect(ddlSql).toContain(`INDEX "${index}"`);
    }
    for (const statement of ddlSql.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
      expect(statement).toMatch(/^(CREATE|ALTER|DROP) /);
    }
  });

  it("the data migration holds only the four backfills, schema-qualified, and inserts no bindings", () => {
    const statements = dataSql.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean);
    expect(statements).toHaveLength(5);
    for (const statement of statements) {
      expect(statement).toMatch(/^(--[^\n]*\n)*UPDATE "public"\."ai_account(s|_hosts)"/);
    }
    expect(statements.map((statement) => statement.match(/SET "(\w+)"/)?.[1])).toEqual([
      "owner_user_id",
      "origin",
      "status",
      "external_key",
      "external_key",
    ]);
    expect(dataSql).not.toMatch(/ai_account_agent_bindings|INSERT\s+INTO|DELETE\s+FROM|\b(CREATE|ALTER|DROP)\b/i);
  });
});

describeEmbeddedPostgres("account pool migration on a database at the fork's 0308", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let legacyUrl: string;
  let legacyMigrationsDir: string;
  let db: ReturnType<typeof createDb>;

  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const agentId = randomUUID();
  const secondAgentId = randomUUID();
  const issueId = randomUUID();
  const otherIssueId = randomUUID();
  const projectId = randomUUID();
  const host = {
    runner: randomUUID(),
    computer: randomUUID(),
    split: randomUUID(),
    twinA: randomUUID(),
    twinB: randomUUID(),
    server: randomUUID(),
    unmapped: randomUUID(),
  };
  const account = {
    owned: randomUUID(),
    unowned: randomUUID(),
    outOfPool: randomUUID(),
    signedOutOutOfPool: randomUUID(),
  };
  let reservationsBefore: Array<{ accountId: string; projectId: string }> = [];

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-ai-account-pool-migration-");
    const name = `pool_0308_${randomUUID().replaceAll("-", "")}`;
    expect(await ensurePostgresDatabase(database.connectionString, name)).toBe("created");
    const url = new URL(database.connectionString);
    url.pathname = `/${name}`;
    legacyUrl = url.href;

    // Build the fork's 0308 schema with the migration engine, from a journal of
    // upstream's base and the fork's files before the pool DDL.
    legacyMigrationsDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-account-pool-0308-"));
    await mkdir(path.join(legacyMigrationsDir, "meta"));
    for (const entry of priorEntries) {
      await writeFile(
        path.join(legacyMigrationsDir, `${entry.tag}.sql`),
        await readFile(new URL(`${entry.tag}.sql`, migrationsDir)),
      );
    }
    await writeFile(
      path.join(legacyMigrationsDir, "meta", "_journal.json"),
      JSON.stringify({ ...journal, entries: priorEntries }),
    );
    const migrator = drizzle({ connection: { url: legacyUrl, max: 1, onnotice: () => {} } });
    try {
      await migrate(migrator, { migrationsFolder: legacyMigrationsDir });
    } finally {
      await migrator.$client.end();
    }
    db = createDb(legacyUrl);

    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES
      (${companyId}, 'Pool migration', ${`P${companyId.slice(0, 5)}`}),
      (${otherCompanyId}, 'Other company', ${`O${otherCompanyId.slice(0, 5)}`})`);
    await db.execute(sql`INSERT INTO agents (id, company_id, name, adapter_type) VALUES
      (${agentId}, ${companyId}, 'Builder', 'claude_local'),
      (${secondAgentId}, ${companyId}, 'Reviewer', 'claude_local')`);
    await db.execute(sql`INSERT INTO issues (id, company_id, title) VALUES
      (${issueId}, ${companyId}, 'Waiting task'),
      (${otherIssueId}, ${otherCompanyId}, 'Another company task')`);
    await db.execute(sql`INSERT INTO projects (id, company_id, name) VALUES (${projectId}, ${companyId}, 'Reserved project')`);

    const rows = await db.execute(sql`SELECT id FROM environments WHERE driver = 'local'`);
    const localEnvironmentId = String((rows as unknown as Array<{ id: string }>)[0]!.id);
    const ssh = async (environmentName: string, config: Record<string, unknown>) => {
      const id = randomUUID();
      await db.execute(sql`INSERT INTO environments (id, name, driver, config)
        VALUES (${id}, ${environmentName}, 'ssh', ${JSON.stringify({ username: "runner", remoteWorkspacePath: "/srv/work", ...config })}::jsonb)`);
      return id;
    };
    const sandboxEnvironmentId = randomUUID();
    await db.execute(sql`INSERT INTO environments (id, name, driver, config)
      VALUES (${sandboxEnvironmentId}, 'Sandbox device', 'sandbox', ${JSON.stringify({ provider: "fake", deviceId: "d-1" })}::jsonb)`);

    await db.execute(sql`INSERT INTO ai_account_hosts (id, name, kind) VALUES
      (${host.runner}, 'Runner', 'ssh_host'),
      (${host.computer}, 'Tower', 'mac'),
      (${host.split}, 'Split runner', 'ssh_host'),
      (${host.twinA}, 'Twin A', 'ssh_host'),
      (${host.twinB}, 'Twin B', 'mac'),
      (${host.server}, 'Server', 'server'),
      (${host.unmapped}, 'Unmapped', 'ssh_host')`);
    const mappings: Array<[string, string]> = [
      // One machine reached twice: case, whitespace and an unset port agree.
      [await ssh("runner one", { host: "Runner.Example.COM", port: 22 }), host.runner],
      [await ssh("runner two", { host: " runner.example.com " }), host.runner],
      // A port stored as a string; the sandbox mapping does not count.
      [await ssh("tower over ssh", { host: "tower.example.com", port: "2222" }), host.computer],
      [sandboxEnvironmentId, host.computer],
      // Two different ports on one device: ambiguous, skipped.
      [await ssh("split one", { host: "alpha.example.com", port: 22 }), host.split],
      [await ssh("split two", { host: "alpha.example.com", port: 2200 }), host.split],
      // Two devices that would claim the same key: both skipped.
      [await ssh("twin one", { host: "twin.example.com", port: 22 }), host.twinA],
      [await ssh("twin two", { host: "TWIN.example.com", port: 22 }), host.twinB],
      [localEnvironmentId, host.server],
    ];
    for (const [environmentId, hostId] of mappings) {
      await db.execute(sql`INSERT INTO ai_account_host_environments (environment_id, host_id) VALUES (${environmentId}, ${hostId})`);
    }

    // Accounts as the old image inserts them.
    await db.insert(oldImageAiAccounts).values([
      { id: account.owned, hostId: host.runner, credentialType: "subscription", label: "Max 1", emailHint: "Shared@Example.com", credentialMaterial: material(1), credentialFingerprint: "fp-1", createdByUserId: "user-a" },
      { id: account.unowned, hostId: host.computer, credentialType: "api_key", label: "Key", credentialMaterial: material(2), credentialFingerprint: "fp-2" },
      { id: account.outOfPool, hostId: host.runner, credentialType: "subscription", label: "Not in pool", poolEnabled: false, credentialMaterial: material(3), credentialFingerprint: "fp-3", createdByUserId: "user-b" },
      { id: account.signedOutOutOfPool, hostId: host.server, credentialType: "subscription", label: "Signed out", poolEnabled: false, status: "auth_failed", credentialMaterial: material(4), credentialFingerprint: "fp-4", createdByUserId: "user-b" },
    ]);
    await db.execute(sql`INSERT INTO ai_account_projects (account_id, project_id) VALUES (${account.owned}, ${projectId})`);
    reservationsBefore = (await db.execute(sql`SELECT account_id, project_id FROM ai_account_projects ORDER BY account_id`) as unknown as Array<{ account_id: string; project_id: string }>)
      .map((row) => ({ accountId: row.account_id, projectId: row.project_id }));

    expect(upgradeMigrations).toEqual(expect.arrayContaining([`${ddlEntry.tag}.sql`, `${dataEntry.tag}.sql`]));
    expect(await inspectMigrations(legacyUrl)).toMatchObject({
      status: "needsMigrations",
      pendingMigrations: upgradeMigrations,
    });
    await applyPendingMigrations(legacyUrl);
  }, 240_000);

  afterAll(async () => {
    if (legacyUrl) await closeRegisteredClients(legacyUrl);
    await database?.cleanup();
    if (legacyMigrationsDir) await rm(legacyMigrationsDir, { recursive: true, force: true });
  });

  it("upgrades to the same schema as a fresh install", async () => {
    expect((await inspectMigrations(legacyUrl)).status).toBe("upToDate");
    const fresh = createDb(database.connectionString);
    const tables = sql.raw(`('ai_accounts','ai_account_hosts','ai_account_host_environments','ai_account_projects',
      'ai_account_agent_bindings','ai_account_run_slots','environment_availability','resource_wait_episodes',
      'resource_wait_notices','execution_wait_settings','deferred_data_migrations')`);
    const schemaOf = async (target: ReturnType<typeof createDb>) => ({
      columns: [...await target.execute(sql`SELECT table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ${tables}
        ORDER BY table_name, column_name`)],
      indexes: [...await target.execute(sql`SELECT tablename, indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename IN ${tables} ORDER BY tablename, indexname`)],
      constraints: [...await target.execute(sql`SELECT c.relname, k.conname, pg_get_constraintdef(k.oid) AS definition
        FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname IN ${tables} ORDER BY c.relname, k.conname`)],
    });
    const upgraded = await schemaOf(db);
    expect(upgraded.columns.length).toBeGreaterThan(0);
    expect(upgraded).toEqual(await schemaOf(fresh));
    expect(await db.select().from(aiAccountAgentBindings)).toEqual([]);
  });

  it("backfills owner, origin and status, and keeps reservations", async () => {
    const rows = await db.select().from(aiAccounts);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(account.owned)).toMatchObject({ ownerUserId: "user-a", origin: "legacy_host_pool", status: "active", poolEnabled: true, limitStrikes: 0, hostId: host.runner });
    expect(byId.get(account.unowned)).toMatchObject({ ownerUserId: null, createdByUserId: null, origin: "legacy_host_pool", status: "active" });
    expect(byId.get(account.outOfPool)).toMatchObject({ ownerUserId: "user-b", origin: "legacy_host_pool", status: "disabled", poolEnabled: false });
    expect(byId.get(account.signedOutOutOfPool)).toMatchObject({ ownerUserId: "user-b", status: "auth_failed", poolEnabled: false });
    expect(byId.get(account.owned)?.credentialMaterial).toEqual(material(1));
    expect(await db.select({ accountId: aiAccountProjects.accountId, projectId: aiAccountProjects.projectId }).from(aiAccountProjects))
      .toEqual(reservationsBefore);
  });

  it("backfills derived device keys and skips conflicting devices", async () => {
    const rows = await db.select({ id: aiAccountHosts.id, externalKey: aiAccountHosts.externalKey, targetKey: aiAccountHosts.targetKey })
      .from(aiAccountHosts);
    expect(Object.fromEntries(rows.map((row) => [row.id, row.externalKey]))).toEqual({
      [host.runner]: "ssh:runner.example.com:22",
      [host.computer]: "ssh:tower.example.com:2222",
      [host.split]: null,
      [host.twinA]: null,
      [host.twinB]: null,
      [host.server]: "local",
      [host.unmapped]: null,
    });
    expect(rows.every((row) => row.targetKey === null)).toBe(true);
    await expect(db.update(aiAccountHosts).set({ externalKey: "local" }).where(eq(aiAccountHosts.id, host.unmapped)))
      .rejects.toMatchObject({ cause: { code: "23505", constraint_name: "ai_account_hosts_external_key_uq" } });
    await db.update(aiAccountHosts).set({ kind: "external", targetKey: "target:p:fake:d-1" }).where(eq(aiAccountHosts.id, host.unmapped));
  });

  it("derives SSH device keys exactly as the shared helper does", async () => {
    // The key expression of the data migration's backfill, run as written in the file.
    const keyExpression = dataSql.match(/CASE\s+WHEN[\s\S]*?\bEND(?=\s+AS "key")/)?.[0];
    expect(keyExpression).toBeDefined();
    const configs: Array<Record<string, unknown>> = [
      { host: "Runner.Example.COM", port: 22 },
      { host: " runner.example.com " },
      { host: "tower.example.com", port: "0022" },
      { host: "tower.example.com", port: " 2222 " },
      { host: "tower.example.com", port: "" },
      { host: "tower.example.com", port: null },
      { host: "\tTabbed.Example", port: 2200 },
      { host: "   " },
      { port: 22 },
      { host: "tower.example.com", port: "22a" },
      { host: "tower.example.com", port: 22.5 },
      { host: "tower.example.com", port: 123456 },
      { host: "tower.example.com", port: true },
    ];
    const rows = await db.execute(sql`SELECT e.ord::int AS ord, ${sql.raw(keyExpression!)} AS key
      FROM jsonb_array_elements(${JSON.stringify(configs)}::jsonb) WITH ORDINALITY AS e("config", ord)
      ORDER BY e.ord`) as unknown as Array<{ ord: number; key: string | null }>;
    const keys = rows.map((row) => row.key);
    expect(keys).toEqual(configs.map((config) => sshExecutionDeviceKey(config.host, config.port)));
    expect(keys.slice(0, 7)).toEqual([
      "ssh:runner.example.com:22",
      "ssh:runner.example.com:22",
      "ssh:tower.example.com:22",
      "ssh:tower.example.com:2222",
      "ssh:tower.example.com:22",
      "ssh:tower.example.com:22",
      "ssh:\ttabbed.example:2200",
    ]);
    expect(dataSql).toContain(`SET "external_key" = '${LOCAL_EXECUTION_DEVICE_KEY}'`);
  });

  it("keeps the old image's account SQL working", async () => {
    const [inserted] = await db.insert(oldImageAiAccounts).values({
      hostId: host.runner,
      credentialType: "subscription",
      label: "Rollback window",
      emailHint: "rollback@example.com",
      credentialMaterial: material(5),
      credentialFingerprint: "fp-5",
      createdByUserId: "user-c",
    }).returning();
    const onHost = await db.select().from(oldImageAiAccounts).where(eq(oldImageAiAccounts.hostId, host.runner));
    expect(onHost.map((row) => row.id).sort()).toEqual([account.owned, account.outOfPool, inserted!.id].sort());
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(oldImageAiAccounts)
      .where(and(eq(oldImageAiAccounts.hostId, host.runner), eq(oldImageAiAccounts.poolEnabled, true), eq(oldImageAiAccounts.status, "active")));
    expect(count).toBe(2);
    const [row] = await db.select().from(aiAccounts).where(eq(aiAccounts.id, inserted!.id));
    // The effective owner of a row the old image adds is its creator.
    expect(row).toMatchObject({ ownerUserId: null, createdByUserId: "user-c", origin: "pool", limitStrikes: 0 });
  });

  it("keeps the credential when its device is deleted", async () => {
    await db.delete(aiAccountHosts).where(eq(aiAccountHosts.id, host.runner));
    const rows = await db.select().from(aiAccounts).where(eq(aiAccounts.id, account.owned));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hostId: null, ownerUserId: "user-a", credentialFingerprint: "fp-1" });
    expect(rows[0]!.credentialMaterial).toEqual(material(1));
    expect(await db.select().from(aiAccountHostEnvironments).where(eq(aiAccountHostEnvironments.hostId, host.runner))).toEqual([]);
  });

  it("scopes e-mail hints per effective owner and keeps fingerprints global", async () => {
    const add = (values: { ownerUserId: string | null; createdByUserId: string | null; emailHint: string; fingerprint: string }) =>
      db.insert(aiAccounts).values({
        credentialType: "subscription",
        label: values.fingerprint,
        emailHint: values.emailHint,
        ownerUserId: values.ownerUserId,
        createdByUserId: values.createdByUserId,
        credentialMaterial: material(9),
        credentialFingerprint: values.fingerprint,
      }).returning();
    const [shared] = await add({ ownerUserId: "user-b", createdByUserId: "user-b", emailHint: "shared@example.com", fingerprint: "fp-10" });
    expect(shared).toMatchObject({ hostId: null, origin: "pool", status: "active" });
    await expect(add({ ownerUserId: "user-a", createdByUserId: "admin", emailHint: "SHARED@example.com", fingerprint: "fp-11" }))
      .rejects.toMatchObject({ cause: { code: "23505", constraint_name: "ai_accounts_owner_email_hint_uq" } });
    // No owner column yet: the creator is the effective owner.
    await expect(add({ ownerUserId: null, createdByUserId: "user-a", emailHint: "shared@EXAMPLE.com", fingerprint: "fp-12" }))
      .rejects.toMatchObject({ cause: { code: "23505", constraint_name: "ai_accounts_owner_email_hint_uq" } });
    await expect(add({ ownerUserId: "user-c", createdByUserId: "user-c", emailHint: "own@example.com", fingerprint: "fp-1" }))
      .rejects.toMatchObject({ cause: { code: "23505", constraint_name: "ai_accounts_fingerprint_uq" } });
  });

  it("allows one open wait episode per chain, inside the agent's company", async () => {
    const episode = (values: { issueId: string | null; agentId?: string; companyId?: string; resourceKey?: string }) =>
      db.insert(resourceWaitEpisodes).values({
        companyId: values.companyId ?? companyId,
        agentId: values.agentId ?? agentId,
        issueId: values.issueId,
        kind: "environment",
        reason: "offline",
        scope: "target",
        resourceKey: values.resourceKey ?? `environment:${randomUUID()}`,
        since: new Date(),
      }).returning();
    const [first] = await episode({ issueId });
    await expect(episode({ issueId, agentId: secondAgentId }))
      .rejects.toMatchObject({ cause: { code: "23505", constraint_name: "resource_wait_episodes_open_uq" } });
    await episode({ issueId: null });
    await expect(episode({ issueId: null }))
      .rejects.toMatchObject({ cause: { code: "23505", constraint_name: "resource_wait_episodes_open_uq" } });
    await episode({ issueId: null, agentId: secondAgentId });
    await db.update(resourceWaitEpisodes).set({ resolvedAt: new Date(), resolution: "superseded" })
      .where(eq(resourceWaitEpisodes.id, first!.id));
    await episode({ issueId });
    await expect(episode({ issueId: otherIssueId, agentId: secondAgentId }))
      .rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("keeps bindings inside the agent's company and unassigns them when the account goes", async () => {
    const [spare] = await db.insert(aiAccounts).values({
      credentialType: "api_key",
      label: "Spare",
      ownerUserId: "user-a",
      createdByUserId: "user-a",
      credentialMaterial: material(20),
      credentialFingerprint: "fp-20",
    }).returning();
    await expect(db.insert(aiAccountAgentBindings).values({ agentId, companyId, mode: "device_login", accountId: spare!.id }))
      .rejects.toMatchObject({ cause: { code: "23514", constraint_name: "ai_account_agent_bindings_account_check" } });
    await expect(db.insert(aiAccountAgentBindings).values({ agentId, companyId: otherCompanyId, mode: "pool_account", accountId: spare!.id }))
      .rejects.toMatchObject({ cause: { code: "23503" } });
    await db.insert(aiAccountAgentBindings).values({ agentId, companyId, mode: "pool_account", accountId: spare!.id });
    await db.delete(aiAccounts).where(eq(aiAccounts.id, spare!.id));
    expect(await db.select().from(aiAccountAgentBindings).where(eq(aiAccountAgentBindings.agentId, agentId)))
      .toMatchObject([{ mode: "pool_account", accountId: null, source: "manual", reviewedAt: null }]);
  });
});

describeEmbeddedPostgres("account pool migrations on production's ledger", () => {
  // Production applied the five pool migrations as 0306–0310, right after
  // upstream's 0305, and its ledger holds their hashes and these timestamps.
  // The 2026-10 sync renumbered them behind upstream's files with
  // byte-identical SQL, so only the files around them are pending there.
  const deployed = [
    { tag: "0306_faulty_the_executioner", when: 1791882144293 },
    { tag: "0307_many_the_fury", when: 1791882242616 },
    { tag: "0308_spicy_silk_fever", when: 1791972189545 },
    { tag: "0309_smooth_killmonger", when: 1792177610956 },
    { tag: "0310_productive_veda", when: 1792177623369 },
  ];
  const forkEntries = journal.entries.slice(forkStartPosition, ddlPosition + 2);
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let productionUrl: string;
  let productionMigrationsDir: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-ai-account-pool-ledger-");
    const name = `pool_0310_${randomUUID().replaceAll("-", "")}`;
    expect(await ensurePostgresDatabase(database.connectionString, name)).toBe("created");
    const url = new URL(database.connectionString);
    url.pathname = `/${name}`;
    productionUrl = url.href;

    // The journal production ran: upstream's base, then today's pool files
    // under their deployed tags and timestamps.
    productionMigrationsDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-account-pool-0310-"));
    await mkdir(path.join(productionMigrationsDir, "meta"));
    const baseEntries = journal.entries.slice(0, forkBasePosition);
    for (const entry of baseEntries) {
      await writeFile(path.join(productionMigrationsDir, `${entry.tag}.sql`), await readFile(new URL(`${entry.tag}.sql`, migrationsDir)));
    }
    expect(forkEntries.map((entry) => entry.tag.slice(5))).toEqual(deployed.map((entry) => entry.tag.slice(5)));
    const deployedEntries = forkEntries.map((entry, offset) => ({
      ...entry,
      idx: baseEntries.at(-1)!.idx + 1 + offset,
      tag: deployed[offset]!.tag,
      when: deployed[offset]!.when,
    }));
    for (const [offset, entry] of deployedEntries.entries()) {
      await writeFile(path.join(productionMigrationsDir, `${entry.tag}.sql`), await readFile(new URL(`${forkEntries[offset]!.tag}.sql`, migrationsDir)));
    }
    await writeFile(
      path.join(productionMigrationsDir, "meta", "_journal.json"),
      JSON.stringify({ ...journal, entries: [...baseEntries, ...deployedEntries] }),
    );
    const migrator = drizzle({ connection: { url: productionUrl, max: 1, onnotice: () => {} } });
    try {
      await migrate(migrator, { migrationsFolder: productionMigrationsDir });
    } finally {
      await migrator.$client.end();
    }
  }, 240_000);

  afterAll(async () => {
    if (productionUrl) await closeRegisteredClients(productionUrl);
    await database?.cleanup();
    if (productionMigrationsDir) await rm(productionMigrationsDir, { recursive: true, force: true });
  });

  it("runs only upstream's and later files, keeps the pool receipts, never replays the data migration, and matches a fresh install", async () => {
    const db = createDb(productionUrl);
    const ledger = async () => [...await db.execute(sql`SELECT id, hash, created_at::text AS created_at
      FROM drizzle.__drizzle_migrations ORDER BY id`)];
    // Added after the release and switched off by an admin. A replayed data
    // migration would give it an owner, relabel its origin and disable it.
    const accountId = randomUUID();
    await db.execute(sql`INSERT INTO ai_accounts (id, credential_type, label, credential_material, credential_fingerprint, created_by_user_id, pool_enabled)
      VALUES (${accountId}, 'subscription', 'Paused by an admin', ${JSON.stringify(material(30))}::jsonb, 'fp-30', 'user-z', false)`);
    const before = await ledger();
    expect(before).toHaveLength(forkBasePosition + deployed.length);

    const pending = [...journal.entries.slice(forkBasePosition, forkStartPosition), ...journal.entries.slice(ddlPosition + 2)]
      .map((entry) => `${entry.tag}.sql`);
    expect(pending).not.toContain(`${ddlEntry.tag}.sql`);
    expect(await inspectMigrations(productionUrl)).toMatchObject({ status: "needsMigrations", pendingMigrations: pending });
    await applyPendingMigrations(productionUrl);

    expect((await inspectMigrations(productionUrl)).status).toBe("upToDate");
    const after = await ledger();
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + pending.length);
    expect([...await db.execute(sql`SELECT owner_user_id, origin, status, pool_enabled FROM ai_accounts WHERE id = ${accountId}`)])
      .toEqual([{ owner_user_id: null, origin: "pool", status: "active", pool_enabled: false }]);
    const upgraded = await publicSchemaOf(db);
    expect(upgraded.triggers.length).toBeGreaterThan(0);
    expect(upgraded.constraints).toContainEqual(expect.objectContaining({
      conname: "ai_connection_pool_members_provider_check",
      definition: expect.stringContaining("'github'"),
    }));
    expect(upgraded).toEqual(await publicSchemaOf(createDb(database.connectionString)));

    await applyPendingMigrations(productionUrl);
    expect(await ledger()).toEqual(after);
  }, 240_000);
});
