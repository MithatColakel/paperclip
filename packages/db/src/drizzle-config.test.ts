import { afterEach, describe, expect, it, vi } from "vitest";

// Fork: drizzle.config.ts refuses drizzle-kit's stock `migrate` and `push`
// unless DATABASE_URL names a database on this machine or the operator opts in
// with PAPERCLIP_DRIZZLE_KIT_ALLOW_REMOTE=true; Paperclip's runner is the only
// one that may apply migrations to production.

const configUrl = new URL("../drizzle.config.ts", import.meta.url).href;
const remoteUrl = "postgres://paperclip:secret@db.example.com:5432/paperclip";

async function loadConfig(argv: string[], databaseUrl: string | undefined, allowRemote?: string) {
  vi.resetModules();
  vi.stubEnv("DATABASE_URL", databaseUrl);
  vi.stubEnv("PAPERCLIP_DRIZZLE_KIT_ALLOW_REMOTE", allowRemote);
  const originalArgv = process.argv;
  process.argv = [originalArgv[0]!, "drizzle-kit", ...argv];
  try {
    return ((await import(configUrl)) as { default: { dbCredentials: { url: string } } }).default;
  } finally {
    process.argv = originalArgv;
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("drizzle-kit config guard", () => {
  it.each([
    ["migrate", "postgres://paperclip:secret@db-postgresql-fra1-1.b.db.ondigitalocean.com:25060/defaultdb?sslmode=require"],
    ["push", remoteUrl],
    ["migrate", undefined],
    ["push", "not a url"],
  ])("refuses %s against %s", async (command, databaseUrl) => {
    await expect(loadConfig([command, "--config", "drizzle.config.ts"], databaseUrl))
      .rejects.toThrow(`Refusing \`drizzle-kit ${command}\` against a database that is not on this machine.`);
  });

  it("finds the command after options, where drizzle-kit also accepts it", async () => {
    await expect(loadConfig(["--config", "drizzle.config.ts", "push"], remoteUrl))
      .rejects.toThrow("Refusing `drizzle-kit push` against a database that is not on this machine.");
  });

  it.each([
    ["migrate", "postgres://paperclip:paperclip@localhost:5432/paperclip"],
    ["push", "postgres://paperclip:paperclip@127.0.0.1:5432/paperclip"],
    ["push", "postgres://paperclip:paperclip@[::1]:5432/paperclip"],
  ])("allows %s against %s", async (command, databaseUrl) => {
    expect((await loadConfig([command], databaseUrl)).dbCredentials.url).toBe(databaseUrl);
  });

  it("allows a remote database only with the explicit override", async () => {
    expect((await loadConfig(["push"], remoteUrl, "true")).dbCredentials.url).toBe(remoteUrl);
    await expect(loadConfig(["push"], remoteUrl, "1")).rejects.toThrow("PAPERCLIP_DRIZZLE_KIT_ALLOW_REMOTE=true");
  });

  it("leaves generate alone, which needs no database", async () => {
    await expect(loadConfig(["generate"], remoteUrl)).resolves.toMatchObject({
      schema: "./dist/schema/*.js",
      out: "./src/migrations",
    });
  });
});
