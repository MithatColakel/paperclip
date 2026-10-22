import { defineConfig } from "drizzle-kit";

// Fork: only Paperclip's runner (server boot, `pnpm db:migrate`) applies
// migrations. drizzle-kit's stock `migrate` skips every file older than the
// newest ledger row, and the fork renumbers its migrations behind upstream's at
// each sync, so on production it would skip upstream files and replay the
// fork's. It also runs the whole journal in one transaction, which the
// CONCURRENTLY and batch-committing files refuse. `push` changes the schema
// without recording a migration. Both are refused unless DATABASE_URL names a
// database on this machine, or PAPERCLIP_DRIZZLE_KIT_ALLOW_REMOTE=true is set
// for a database that is not production. drizzle-kit takes an option's value
// from the next word, so the command can follow options
// (`drizzle-kit --config drizzle.config.ts push`): any argument counts.
const command = process.argv.slice(2).find((argument) => argument === "migrate" || argument === "push");
if (command && process.env.PAPERCLIP_DRIZZLE_KIT_ALLOW_REMOTE !== "true") {
  let host = "";
  try {
    host = new URL(process.env.DATABASE_URL ?? "").hostname;
  } catch {
    // Not a URL drizzle-kit could reach either; refuse it like a remote one.
  }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) {
    throw new Error(
      `Refusing \`drizzle-kit ${command}\` against a database that is not on this machine. `
        + "Apply migrations with `pnpm db:migrate`, Paperclip's migration runner. "
        + "For a database that is not production, set PAPERCLIP_DRIZZLE_KIT_ALLOW_REMOTE=true.",
    );
  }
}

export default defineConfig({
  schema: "./dist/schema/*.js",
  out: "./src/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
