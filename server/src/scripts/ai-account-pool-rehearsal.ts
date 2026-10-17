import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isGoNoGoBlocker, type AiAccountMigrationReport, type DeploymentMode } from "@paperclipai/shared";
import type { AiAccountMigrationRunResult } from "../services/ai-account-pool-migration.js";

/**
 * Fork: the snapshot rehearsal of the Claude account binding backfill (spec
 * 15.1, 15.3 and 17 step 1).
 *
 * Before a deploy, an operator restores a production dump into a throwaway
 * Postgres and runs this script from the NEW image against that copy (the
 * image's working directory is /app):
 *
 *   node --import ./server/node_modules/tsx/dist/loader.mjs \
 *     server/dist/scripts/ai-account-pool-rehearsal.js --snapshot > rehearsal.json
 *
 * with `PAPERCLIP_REHEARSAL_DATABASE_URL` pointing at the copy. The script:
 * 1. applies the pending migrations with the runner the server uses at boot
 *    (`@paperclipai/db`), and times them;
 * 2. runs the binding backfill (`runDeferredAiAccountMigration`, forced, as
 *    the migration actor);
 * 3. prints `readAiAccountMigrationReport`, whose `goNoGo` is
 *    `aiAccountMigrationGoNoGo`, as one JSON document on stdout, and its
 *    progress and a short readable summary on stderr.
 *
 * Exit code: 0 go, 2 no-go, 1 error or refusal. The history windows (45 days)
 * and the go/no-go window (7 days) count back from the time of the run, so
 * rehearse on a fresh dump.
 *
 * It writes to the database it is given, so it refuses to run unless:
 * - the flag `--snapshot` is given;
 * - the URL comes from `PAPERCLIP_REHEARSAL_DATABASE_URL` (it never reads
 *   `DATABASE_URL`);
 * - the database name contains "rehearsal" or "snapshot", both in the URL and
 *   as the server reports it (a query parameter can redirect the driver). On a
 *   cluster forked from a backup, copy the database under such a name first:
 *   `CREATE DATABASE paperclip_snapshot TEMPLATE <database>`;
 * - the database is not empty (an empty one means nothing was restored).
 *
 * It prints the target host and database before it starts. It loads only the
 * migration runner and the backfill service: no scheduler, heartbeat, plugin
 * worker or HTTP server starts. It never prints the URL's password or any
 * account credential; the report holds ids, names, labels and notes only.
 */

export const REHEARSAL_DATABASE_URL_ENV = "PAPERCLIP_REHEARSAL_DATABASE_URL";
export const REHEARSAL_SNAPSHOT_FLAG = "--snapshot";
export const REHEARSAL_EXIT_GO = 0;
export const REHEARSAL_EXIT_ERROR = 1;
export const REHEARSAL_EXIT_NO_GO = 2;

const REHEARSAL_DATABASE_NAME = /rehearsal|snapshot/i;
const APPLICATION_NAME = "paperclip-ai-account-rehearsal";
const CLIENT_END_TIMEOUT_SECONDS = 5;
/** Once the output is written, the process exits within this delay even if a stray handle stays open. */
const FORCED_EXIT_DELAY_MS = 10_000;

const USAGE = [
  "Usage, from /app in the new image:",
  `  ${REHEARSAL_DATABASE_URL_ENV}=postgres://<user>:<password>@<host>:<port>/<name> \\`,
  `    node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/scripts/ai-account-pool-rehearsal.js ${REHEARSAL_SNAPSHOT_FLAG}`,
  "",
  "Rehearses the Claude account binding backfill on a restored copy of the production database:",
  "applies the pending migrations, runs the backfill, and prints the report and the go/no-go.",
  `It writes to that database, so <name> must contain "rehearsal" or "snapshot". It never reads DATABASE_URL.`,
  "stdout: the JSON report. stderr: progress and a readable summary.",
  "Exit code: 0 go, 2 no-go, 1 error or refusal.",
].join("\n");

export interface AiAccountPoolRehearsalIo {
  /** The arguments after the script path. */
  argv: readonly string[];
  /** Only `PAPERCLIP_REHEARSAL_DATABASE_URL` is read from it. */
  env: Readonly<Record<string, string | undefined>>;
  /** Receives the JSON report: one document, written once, and only once the target was accepted. */
  stdout: (text: string) => void;
  /** Receives refusals, progress and the readable summary. */
  stderr: (text: string) => void;
}

export interface AiAccountPoolRehearsalTarget {
  host: string;
  port: number;
  database: string;
}

export interface AiAccountPoolRehearsalResult {
  target: AiAccountPoolRehearsalTarget & { serverVersion: string | null };
  deploymentMode: DeploymentMode | null;
  startedAt: string;
  finishedAt: string;
  /** Migration file names: pending before the run, journal entries repaired from the schema, and applied. */
  migrations: { pending: string[]; repaired: string[]; applied: string[]; durationMs: number } | null;
  backfill: {
    status: AiAccountMigrationRunResult["status"];
    added: number | null;
    error: string | null;
    durationMs: number;
  } | null;
  /** `readAiAccountMigrationReport`; its `goNoGo` is `aiAccountMigrationGoNoGo`. */
  report: AiAccountMigrationReport | null;
  verdict: "go" | "no-go" | "error";
  error: string | null;
  exitCode: number;
}

/** A precondition the operator must fix; nothing was written. */
class RehearsalRefusal extends Error {}

type Runtime = Awaited<ReturnType<typeof loadRuntime>>;

/**
 * Loaded only once the target is accepted, so a refusal loads nothing. These
 * are the migration runner and the backfill service with their own imports;
 * none of them starts anything when loaded.
 */
async function loadRuntime() {
  const [database, orm, configFile, migration] = await Promise.all([
    import("@paperclipai/db"),
    import("drizzle-orm"),
    import("../config-file.js"),
    import("../services/ai-account-pool-migration.js"),
  ]);
  return { database, orm, configFile, migration };
}

// ---------------------------------------------------------------------------
// Arguments and target
// ---------------------------------------------------------------------------

function parseArguments(argv: readonly string[]): { help: boolean; snapshot: boolean; unknown: number } {
  let help = false;
  let snapshot = false;
  let unknown = 0;
  for (const arg of argv) {
    if (arg === REHEARSAL_SNAPSHOT_FLAG) snapshot = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else unknown += 1;
  }
  return { help, snapshot, unknown };
}

type TargetParse =
  | { ok: true; url: string; target: AiAccountPoolRehearsalTarget; secrets: string[] }
  | { ok: false; reason: string; secrets: string[] };

/** The URL as the driver reads it: the host and the database come from the URL itself. */
function parseTarget(raw: string | undefined): TargetParse {
  const value = raw?.trim() ?? "";
  if (!value) {
    return {
      ok: false,
      secrets: [],
      reason: `${REHEARSAL_DATABASE_URL_ENV} is not set. Point it at the throwaway database that holds the restored dump; this script never reads DATABASE_URL.`,
    };
  }
  const secrets = [value];
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, secrets, reason: `${REHEARSAL_DATABASE_URL_ENV} is not a valid postgres:// URL.` };
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    return { ok: false, secrets, reason: `${REHEARSAL_DATABASE_URL_ENV} must be a postgres:// or postgresql:// URL.` };
  }
  const host = url.hostname;
  if (!host) return { ok: false, secrets, reason: `${REHEARSAL_DATABASE_URL_ENV} names no host.` };
  if (host.includes(",")) {
    return { ok: false, secrets, reason: `${REHEARSAL_DATABASE_URL_ENV} names several hosts; give the one throwaway database server.` };
  }
  // The driver takes the path as is, without decoding it.
  const database = url.pathname.slice(1);
  if (!database) return { ok: false, secrets, reason: `${REHEARSAL_DATABASE_URL_ENV} names no database.` };
  if (!REHEARSAL_DATABASE_NAME.test(database)) {
    return {
      ok: false,
      secrets,
      reason: `The database "${database}" on host ${host} is not a rehearsal copy: its name must contain "rehearsal" or "snapshot". `
        + "This script writes to the database it is given, so it never runs against a live one.",
    };
  }
  return { ok: true, url: value, target: { host, port: url.port ? Number(url.port) : 5432, database }, secrets };
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

/** Removes the given secrets and the password of any connection URL. */
function redact(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join("***");
  }
  return result.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)[^\s@/]*@/gi, "$1***@");
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim() || "unknown error";
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Migration names for a line of text; the JSON report keeps the whole list. */
function migrationList(names: readonly string[]): string {
  return names.length > 6 ? `${names.slice(0, 3).join(", ")} (+${names.length - 3} more)` : names.join(", ");
}

function refuse(
  io: AiAccountPoolRehearsalIo,
  reason: string,
  options: { secrets?: readonly string[]; usage?: boolean } = {},
): number {
  io.stderr(`Refused: ${redact(reason, options.secrets ?? [])}\n${options.usage ? `\n${USAGE}\n` : ""}`);
  return REHEARSAL_EXIT_ERROR;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** The database and version the server reports for this connection. */
async function serverIdentity(runtime: Runtime, db: ReturnType<Runtime["database"]["createDb"]>) {
  const rows = await db.execute(
    runtime.orm.sql`select current_database() as database, current_setting('server_version') as version`,
  );
  const [row] = [...rows] as Array<{ database?: unknown; version?: unknown }>;
  return {
    database: typeof row?.database === "string" ? row.database : "",
    version: typeof row?.version === "string" ? row.version : null,
  };
}

/**
 * The boot sequence of the server: repair journal entries whose changes the
 * schema already has, then apply the rest with the same runner.
 */
async function applyMigrations(runtime: Runtime, url: string, io: AiAccountPoolRehearsalIo) {
  const { applyPendingMigrations, inspectMigrations, reconcilePendingMigrationHistory } = runtime.database;
  const started = Date.now();
  const before = await inspectMigrations(url);
  if (before.status === "upToDate") {
    io.stderr("Migrations: none pending.\n");
    return { pending: [], repaired: [], applied: [], durationMs: Date.now() - started };
  }
  if (before.reason === "no-migration-journal-empty-db") {
    throw new RehearsalRefusal("The database has no tables: restore the production dump into it first. Nothing was changed.");
  }
  const pending = [...before.pendingMigrations];
  io.stderr(`Migrations: ${plural(pending.length, "pending migration", "pending migrations")} (${migrationList(pending)}).\n`);
  const repaired = before.reason === "pending-migrations"
    ? (await reconcilePendingMigrationHistory(url)).repairedMigrations
    : [];
  const applied = pending.filter((name) => !repaired.includes(name));
  if (applied.length > 0) await applyPendingMigrations(url);
  const after = await inspectMigrations(url);
  if (after.status !== "upToDate") {
    throw new Error(`Migrations are still pending after the run: ${after.pendingMigrations.join(", ")}`);
  }
  const durationMs = Date.now() - started;
  const repairedText = repaired.length > 0 ? `, ${plural(repaired.length, "journal entry", "journal entries")} repaired` : "";
  io.stderr(`Migrations: ${applied.length} applied${repairedText} in ${seconds(durationMs)}.\n`);
  return { pending, repaired, applied, durationMs };
}

// ---------------------------------------------------------------------------
// Readable summary
// ---------------------------------------------------------------------------

function readableSummary(result: AiAccountPoolRehearsalResult, goNoGoDays: number | null): string {
  const lines = ["", "AI account pool rehearsal: summary"];
  const { target } = result;
  lines.push(
    `Target: host ${target.host}, port ${target.port}, database ${target.database}`
      + (target.serverVersion ? ` (PostgreSQL ${target.serverVersion})` : ""),
  );
  if (result.deploymentMode) lines.push(`Deployment mode: ${result.deploymentMode}`);
  if (result.migrations) {
    lines.push(`Migrations: ${result.migrations.applied.length} applied in ${seconds(result.migrations.durationMs)}`
      + (result.migrations.applied.length > 0 ? ` (${migrationList(result.migrations.applied)})` : ""));
  }
  if (result.backfill) {
    lines.push(result.backfill.status === "failed"
      ? `Binding backfill: failed after ${seconds(result.backfill.durationMs)}: ${result.backfill.error ?? "unknown error"}`
      : `Binding backfill: ${result.backfill.status} in ${seconds(result.backfill.durationMs)}, `
        + `${plural(result.backfill.added ?? 0, "binding row", "binding rows")} added`);
  }

  const summary = result.report?.summary ?? null;
  if (summary) {
    lines.push(`Outcomes: ${summary.bound} bound, ${summary.unassigned} unassigned (waiting for an account), ${summary.unbound} unbound`);
    const byRule = new Map<string, number>();
    for (const entry of summary.agents) {
      if (entry.outcome === "bound" && entry.rule) byRule.set(entry.rule, (byRule.get(entry.rule) ?? 0) + 1);
    }
    if (byRule.size > 0) lines.push(`Bound by rule: ${[...byRule].map(([rule, count]) => `${rule} ${count}`).join(", ")}`);
    if (summary.overLimitDevices.length > 0) {
      lines.push(`Devices at or over their account cap (${summary.overLimitDevices.length}):`);
      for (const device of summary.overLimitDevices) {
        lines.push(`  - ${device.deviceName}: ${device.inUse} of ${device.limit} accounts in use`);
      }
    }
    for (const [outcome, title] of [
      ["unassigned", "Unassigned, waiting for an account"],
      ["unbound", "Left unbound, with a review note"],
    ] as const) {
      const entries = summary.agents.filter((entry) => entry.outcome === outcome);
      if (entries.length === 0) continue;
      lines.push(`${title} (${entries.length}):`);
      for (const entry of entries) {
        lines.push(`  - ${entry.companyName} / ${entry.agentName}: ${entry.note ?? "no note"}`);
      }
    }
  } else if (result.report) {
    lines.push("Outcomes: none recorded; the binding backfill did not complete.");
  }

  const goNoGo = result.report?.goNoGo ?? null;
  if (goNoGo) {
    const blocked = goNoGo.agents.filter(isGoNoGoBlocker);
    // An agent whose own account is only at its limit waits for the reset (P7): a warning, not a blocker.
    const limited = goNoGo.agents.filter((entry) => entry.plan !== "use" && !isGoNoGoBlocker(entry));
    const window = goNoGoDays === null ? "recently" : `in the last ${goNoGoDays} days`;
    lines.push(goNoGo.agents.length === 0
      ? `Go/no-go: no Claude agent had a host-pool run ${window}.`
      : `Go/no-go: ${goNoGo.agents.length - blocked.length - limited.length} of ${goNoGo.agents.length} Claude agents with a host-pool run ${window} would use their account.`);
    for (const entry of blocked) {
      lines.push(`  - ${entry.companyName ?? entry.companyId} / ${entry.agentName}: ${entry.plan}${entry.reason ? ` (${entry.reason})` : ""}`);
    }
    if (limited.length > 0) {
      lines.push(`At their account's limit, waiting for its reset on the same account; this does not block go (${limited.length}):`);
      for (const entry of limited) {
        lines.push(`  - ${entry.companyName ?? entry.companyId} / ${entry.agentName}: ${entry.reason}`);
      }
    }
  }
  if (result.error) lines.push(`Error: ${result.error}`);
  const verdict = result.verdict === "go" ? "GO" : result.verdict === "no-go" ? "NO-GO" : "ERROR";
  lines.push(`Result: ${verdict} (exit code ${result.exitCode}). The JSON report is on stdout.`);
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// The rehearsal
// ---------------------------------------------------------------------------

/** Runs the rehearsal and returns the exit code. Never throws for a database or job failure. */
export async function runAiAccountPoolRehearsal(io: AiAccountPoolRehearsalIo): Promise<number> {
  const args = parseArguments(io.argv);
  if (args.help) {
    io.stderr(`${USAGE}\n`);
    return REHEARSAL_EXIT_GO;
  }
  if (args.unknown > 0) {
    // Not echoed: a mistyped command line may carry the URL and its password.
    return refuse(io, `This script takes only ${REHEARSAL_SNAPSHOT_FLAG}; the database URL goes in ${REHEARSAL_DATABASE_URL_ENV}.`, { usage: true });
  }
  if (!args.snapshot) {
    return refuse(io, `${REHEARSAL_SNAPSHOT_FLAG} is required: it confirms that the target is a restored copy, never the live database.`, { usage: true });
  }
  const parsed = parseTarget(io.env[REHEARSAL_DATABASE_URL_ENV]);
  if (!parsed.ok) return refuse(io, parsed.reason, { secrets: parsed.secrets });
  const { url, target, secrets } = parsed;
  const scrub = (text: string) => redact(text, secrets);

  io.stderr(`Rehearsal target: host ${target.host}, port ${target.port}, database ${target.database}\n`);
  const result: AiAccountPoolRehearsalResult = {
    target: { ...target, serverVersion: null },
    deploymentMode: null,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    migrations: null,
    backfill: null,
    report: null,
    verdict: "error",
    error: null,
    exitCode: REHEARSAL_EXIT_ERROR,
  };
  let goNoGoDays: number | null = null;

  let db: ReturnType<Runtime["database"]["createDb"]> | null = null;
  try {
    const runtime = await loadRuntime().catch((error: unknown) => {
      throw new Error(
        `Loading the server modules failed; run the script from /app with node --import ./server/node_modules/tsx/dist/loader.mjs. ${errorMessage(error)}`,
      );
    });
    goNoGoDays = runtime.migration.AI_ACCOUNT_MIGRATION_GO_NO_GO_DAYS;
    db = runtime.database.createDb(url, { applicationName: APPLICATION_NAME });

    // 1. The server must report the database the URL names.
    const server = await serverIdentity(runtime, db);
    if (server.database !== target.database) {
      throw new RehearsalRefusal(
        `The server reports database "${server.database}", not "${target.database}". Remove any query parameter that changes the database. Nothing was changed.`,
      );
    }
    result.target.serverVersion = server.version;
    io.stderr(`Connected: the server reports database ${server.database}${server.version ? ` (PostgreSQL ${server.version})` : ""}.\n`);

    // 2. The deployment mode the server would resolve here; the image sets authenticated.
    const deploymentMode = runtime.configFile.resolveDeploymentMode();
    result.deploymentMode = deploymentMode;
    io.stderr(`Deployment mode: ${deploymentMode}\n`);

    // 3. The migrations, as at boot.
    result.migrations = await applyMigrations(runtime, url, io);

    // 4. The binding backfill, as an instance admin's re-run would, but as the migration actor.
    io.stderr("Binding backfill: running.\n");
    const backfillStarted = Date.now();
    const run = await runtime.migration.runDeferredAiAccountMigration(db, {
      deploymentMode,
      force: true,
      actor: {
        audit: { actorType: "system", actorId: runtime.migration.AI_ACCOUNT_MIGRATION_ACTOR_ID },
        userId: null,
      },
    });
    result.backfill = {
      status: run.status,
      added: run.status === "completed" ? run.added : null,
      error: run.status === "failed" ? run.error : null,
      durationMs: Date.now() - backfillStarted,
    };
    io.stderr(`Binding backfill: ${run.status} in ${seconds(result.backfill.durationMs)}.\n`);

    // 5. The report and a fresh go/no-go.
    const report = await runtime.migration.readAiAccountMigrationReport(db, { deploymentMode });
    result.report = report;
    if (run.status === "failed") {
      result.error = `The binding backfill failed: ${run.error}`;
    } else {
      result.verdict = report.goNoGo.go ? "go" : "no-go";
      result.exitCode = report.goNoGo.go ? REHEARSAL_EXIT_GO : REHEARSAL_EXIT_NO_GO;
    }
  } catch (error) {
    if (error instanceof RehearsalRefusal) return refuse(io, error.message, { secrets });
    result.error = errorMessage(error);
    result.verdict = "error";
    result.exitCode = REHEARSAL_EXIT_ERROR;
  } finally {
    await db?.$client.end({ timeout: CLIENT_END_TIMEOUT_SECONDS }).catch(() => undefined);
  }

  result.finishedAt = new Date().toISOString();
  io.stdout(`${scrub(JSON.stringify(result, null, 2))}\n`);
  io.stderr(scrub(readableSummary(result, goNoGoDays)));
  return result.exitCode;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const writeStdout = process.stdout.write.bind(process.stdout) as (chunk: string) => boolean;
  const writeStderr = process.stderr.write.bind(process.stderr) as (...args: unknown[]) => boolean;
  // stdout carries the JSON report only. Anything else written there, the
  // server's logger included (it is created after this line), goes to stderr.
  process.stdout.write = ((...args: unknown[]) => writeStderr(...args)) as typeof process.stdout.write;
  // Nothing in this process may reach the live database.
  delete process.env.DATABASE_URL;
  delete process.env.DATABASE_MIGRATION_URL;
  if (!process.env.PAPERCLIP_LOG_LEVEL?.trim()) process.env.PAPERCLIP_LOG_LEVEL = "warn";

  let code = REHEARSAL_EXIT_ERROR;
  try {
    code = await runAiAccountPoolRehearsal({
      argv: process.argv.slice(2),
      env: process.env,
      stdout: (text) => {
        writeStdout(text);
      },
      stderr: (text) => {
        writeStderr(text);
      },
    });
  } catch (error) {
    writeStderr(`Error: ${redact(errorMessage(error), [])}\n`);
  }
  process.exitCode = code;
  setTimeout(() => process.exit(code), FORCED_EXIT_DELAY_MS).unref();
}

function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(resolve(entry)).href === metaUrl;
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  void main();
}
