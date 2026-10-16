import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

const STOP = new Error("stop after the probe under test");

const { prepareAdapterExecutionTargetRuntime, resolveAdapterExecutionTargetCommandForLogs } = vi.hoisted(() => ({
  prepareAdapterExecutionTargetRuntime: vi.fn(),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>();
  return {
    ...actual,
    prepareAdapterExecutionTargetRuntime,
    startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => null),
    resolveAdapterExecutionTargetCommandForLogs,
  };
});

import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

// Server-only values that must never reach a sandbox command.
const SERVER_SECRETS = {
  DATABASE_URL: "postgres://paperclip:db-password@db.internal:5432/paperclip",
  BETTER_AUTH_SECRET: "better-auth-secret-value",
  PAPERCLIP_SECRETS_MASTER_KEY: "master-key-value",
};

type RecordedEnv = Record<string, string> | undefined;

function recordingSandboxTarget(envs: RecordedEnv[]): AdapterExecutionTarget {
  return {
    kind: "remote",
    transport: "sandbox",
    providerKey: "test-provider",
    remoteCwd: "/sandbox/workspace",
    runner: {
      execute: async (input) => {
        envs.push(input.env);
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

function expectNoServerSecrets(envs: RecordedEnv[]): void {
  expect(envs.length).toBeGreaterThan(0);
  for (const env of envs) {
    const text = JSON.stringify(env ?? {});
    for (const [key, value] of Object.entries(SERVER_SECRETS)) {
      expect(env ?? {}).not.toHaveProperty(key);
      expect(text).not.toContain(value);
    }
  }
}

describe("opencode remote targets never receive the server environment", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-remote-env-"));
    await fs.mkdir(path.join(root, "workspace"), { recursive: true });
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip-home"));
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "test-instance");
    for (const [key, value] of Object.entries(SERVER_SECRETS)) vi.stubEnv(key, value);
    prepareAdapterExecutionTargetRuntime.mockImplementation(async () => ({
      target: null,
      workspaceRemoteDir: "/sandbox/workspace",
      runtimeRootDir: "/sandbox/workspace/.paperclip-runtime/opencode",
      assetDirs: {},
      additionalSourceDirs: {},
      additionalSourceFailures: [],
      workspaceSyncSnapshot: null,
      restoreWorkspace: async () => {},
    }));
    resolveAdapterExecutionTargetCommandForLogs.mockRejectedValue(STOP);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("keeps it out of the environment test probes", async () => {
    const envs: RecordedEnv[] = [];
    await testEnvironment({
      companyId: "company-1",
      adapterType: "opencode_local",
      config: { command: "opencode", model: "anthropic/claude-sonnet-4-5", env: { ANTHROPIC_API_KEY: "run-key" } },
      executionTarget: recordingSandboxTarget(envs),
      environmentName: "Sandbox",
    });
    expectNoServerSecrets(envs);
  });

  it("keeps it out of the run's install and resolvability probes", async () => {
    const envs: RecordedEnv[] = [];
    await expect(execute({
      runId: "run-1",
      agent: { id: "agent-1", companyId: "company-1", name: "Agent", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { ...{ command: "opencode", model: "anthropic/claude-sonnet-4-5", env: { ANTHROPIC_API_KEY: "run-key" } }, cwd: path.join(root, "workspace") },
      context: {},
      runtimeCommandSpec: { command: "opencode", installCommand: "install-cli", detectCommand: "opencode" },
      executionTarget: recordingSandboxTarget(envs),
      onLog: async () => {},
    })).rejects.toBe(STOP);
    expectNoServerSecrets(envs);
  });
});
