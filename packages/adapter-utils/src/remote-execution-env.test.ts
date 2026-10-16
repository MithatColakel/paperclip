import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  type AdapterExecutionTarget,
} from "./execution-target.js";
import {
  defaultPathForPlatform,
  remoteSafeRuntimeEnv,
  sanitizeRemoteExecutionEnv,
} from "./remote-execution-env.js";
import { ensurePathInEnv } from "./server-utils.js";

const SERVER_SECRETS = {
  DATABASE_URL: "postgres://paperclip:db-password@db.internal:5432/paperclip",
  BETTER_AUTH_SECRET: "better-auth-secret-value",
  PAPERCLIP_SECRETS_MASTER_KEY: "master-key-value",
};

function sandboxTarget(calls: Array<Record<string, string> | undefined>): AdapterExecutionTarget {
  return {
    kind: "remote",
    transport: "sandbox",
    providerKey: "test-provider",
    remoteCwd: "/workspace",
    runner: {
      execute: async (input) => {
        calls.push(input.env);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "",
          pid: null,
          startedAt: new Date().toISOString(),
        };
      },
    },
  };
}

const sshTarget: AdapterExecutionTarget = {
  kind: "remote",
  transport: "ssh",
  remoteCwd: "/home/agent/workspace",
  spec: {
    host: "ssh.example.test",
    port: 22,
    username: "agent",
    remoteCwd: "/home/agent/workspace",
    remoteWorkspacePath: "/home/agent/workspace",
    privateKey: null,
    knownHosts: null,
    strictHostKeyChecking: true,
  },
};

describe("remoteSafeRuntimeEnv", () => {
  beforeEach(() => {
    for (const [key, value] of Object.entries(SERVER_SECRETS)) vi.stubEnv(key, value);
    vi.stubEnv("PATH", "/server/bin:/usr/bin:/bin");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("merges the server env under the run env for a local target, as before", () => {
    const env = { FOO: "run", DATABASE_URL: "run-db" };
    for (const target of [null, undefined, { kind: "local" as const }]) {
      const result = remoteSafeRuntimeEnv(env, target);
      expect(result).toEqual(Object.fromEntries(
        Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ));
      expect(result.BETTER_AUTH_SECRET).toBe(SERVER_SECRETS.BETTER_AUTH_SECRET);
      expect(result.DATABASE_URL).toBe("run-db");
    }
  });

  it("returns only the run env for a remote target", () => {
    for (const target of [sshTarget, sandboxTarget([])]) {
      const result = remoteSafeRuntimeEnv({ FOO: "run", PAPERCLIP_API_KEY: "run-token" }, target);
      expect(result).toEqual({ FOO: "run", PAPERCLIP_API_KEY: "run-token", PATH: "/server/bin:/usr/bin:/bin" });
      for (const key of Object.keys(SERVER_SECRETS)) expect(result).not.toHaveProperty(key);
    }
  });

  it("fills PATH only for local lookups and never sends it to the target", () => {
    const result = remoteSafeRuntimeEnv({ FOO: "run" }, sshTarget);
    expect(result.PATH).toBe("/server/bin:/usr/bin:/bin");
    expect(sanitizeRemoteExecutionEnv(result)).toEqual({ FOO: "run" });

    expect(remoteSafeRuntimeEnv({ PATH: "/run/bin" }, sshTarget).PATH).toBe("/run/bin");
    expect(remoteSafeRuntimeEnv({}, sshTarget, {}).PATH).toBe(defaultPathForPlatform());
  });

  it("keeps the server env out of a sandbox install and resolvability probe", async () => {
    const calls: Array<Record<string, string> | undefined> = [];
    const target = sandboxTarget(calls);
    const runtimeEnv = remoteSafeRuntimeEnv({ ANTHROPIC_API_KEY: "run-key" }, target);

    await ensureAdapterExecutionTargetRuntimeCommandInstalled({
      runId: "run-1",
      target,
      installCommand: "install-cli",
      detectCommand: "cli",
      cwd: "/workspace",
      env: runtimeEnv,
    });
    await ensureAdapterExecutionTargetCommandResolvable("cli", target, "/workspace", runtimeEnv);

    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const env of calls) {
      expect(env).toEqual({ ANTHROPIC_API_KEY: "run-key" });
    }
  });
});
