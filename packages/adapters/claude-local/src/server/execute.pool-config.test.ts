import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adapterExecutionTargetSessionIdentity,
  type AdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  syncDirectoryToSsh,
  runSshCommand,
  startAdapterExecutionTargetPaperclipBridge,
  prepareAdapterExecutionTargetRuntime,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async (_runId: string, _command: string, args: string[], _options?: unknown): Promise<RunProcessResult> => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: args.includes("--version")
      ? "2.1.284 (Claude Code)\n"
      : [
          JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
          JSON.stringify({ type: "result", session_id: "claude-session-1", result: "hello", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }),
        ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "ssh://agent@ssh.example.test:22/remote/workspace :: claude"),
  prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  syncDirectoryToSsh: vi.fn(async () => undefined),
  runSshCommand: vi.fn(async (_config: unknown, _command: string, _options?: unknown) => ({ stdout: "", stderr: "" })),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(),
  prepareAdapterExecutionTargetRuntime: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return { ...actual, ensureCommandResolvable, resolveCommandForLogs, runChildProcess };
});

vi.mock("@paperclipai/adapter-utils/ssh", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/ssh")>(
    "@paperclipai/adapter-utils/ssh",
  );
  return {
    ...actual,
    prepareWorkspaceForSshExecution,
    restoreWorkspaceFromSshExecution,
    syncDirectoryToSsh,
    runSshCommand,
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    startAdapterExecutionTargetPaperclipBridge,
    prepareAdapterExecutionTargetRuntime: vi.fn((...args: Parameters<typeof actual.prepareAdapterExecutionTargetRuntime>) =>
      (prepareAdapterExecutionTargetRuntime.getMockImplementation()
        ? prepareAdapterExecutionTargetRuntime(...args)
        : actual.prepareAdapterExecutionTargetRuntime(...args))),
  };
});

import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { resolveClaudeExecutionEngineForRun } from "./acp.js";
import { resetClaudeCliCapabilitiesCacheForTests } from "./cli-capabilities.js";
import {
  AI_CREDENTIAL_REF_ENV_KEY,
  POOL_RUN_SSH_UNSET_ENV_KEYS,
  POOL_RUN_SSH_UNSET_ENV_PATTERNS,
} from "./ai-credential-ref.js";

const POOL_REF = "fedcba9876543210";
const SERVER_SECRETS = {
  DATABASE_URL: "postgres://paperclip:db-password@db.internal:5432/paperclip",
  BETTER_AUTH_SECRET: "better-auth-secret-value",
  PAPERCLIP_SECRETS_MASTER_KEY: "master-key-value",
};
const STOP = new Error("stop after the step under test");

interface RunnerCall {
  command: string;
  args: string[];
  env: Record<string, string> | undefined;
}

let root: string;
let workspaceDir: string;
let sharedClaudeConfig: string;

function sandboxTarget(calls: RunnerCall[]): AdapterExecutionTarget {
  return {
    kind: "remote",
    transport: "sandbox",
    providerKey: "test-provider",
    remoteCwd: "/sandbox/workspace",
    runner: {
      execute: async (input) => {
        calls.push({ command: input.command, args: input.args ?? [], env: input.env });
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

const sshSpec = {
  host: "ssh.example.test",
  port: 22,
  username: "agent",
  remoteWorkspacePath: "/remote/workspace",
  remoteCwd: "/remote/workspace",
  privateKey: null,
  knownHosts: null,
  strictHostKeyChecking: true,
};

function executeInput(input: {
  executionTarget?: AdapterExecutionTarget;
  executionTransport?: { remoteExecution: Record<string, unknown> };
  env?: Record<string, string>;
}) {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Claude Coder", adapterType: "claude_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      engine: "cli",
      // Pinned so no CLI version probe adds a call.
      model: "claude-opus-5",
      command: "claude",
      env: input.env ?? {},
    },
    context: {
      paperclipWorkspace: { cwd: workspaceDir, source: "project_primary", strategy: "git_worktree", worktreePath: workspaceDir },
    },
    runtimeCommandSpec: { command: "claude", installCommand: "install-claude", detectCommand: "claude" },
    ...(input.executionTarget ? { executionTarget: input.executionTarget } : {}),
    ...(input.executionTransport ? { executionTransport: input.executionTransport } : {}),
    onLog: async () => {},
  };
}

function preparedSandboxRuntime(target: AdapterExecutionTarget) {
  const runtimeRootDir = "/sandbox/workspace/.paperclip-runtime/claude";
  return {
    target,
    workspaceRemoteDir: "/sandbox/workspace",
    runtimeRootDir,
    assetDirs: {
      skills: `${runtimeRootDir}/skills`,
      "mcp-config": `${runtimeRootDir}/mcp-config`,
      "config-seed": `${runtimeRootDir}/config-seed`,
    },
    additionalSourceDirs: {},
    additionalSourceFailures: [],
    workspaceSyncSnapshot: null,
    restoreWorkspace: async () => {},
  };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-pool-execute-"));
  workspaceDir = path.join(root, "workspace");
  sharedClaudeConfig = path.join(root, "shared-claude");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(sharedClaudeConfig, { recursive: true });
  await writeFile(
    path.join(sharedClaudeConfig, "settings.json"),
    JSON.stringify({ theme: "dark", env: { ANTHROPIC_BASE_URL: "http://proxy.invalid" }, apiKeyHelper: "/bin/helper" }),
    "utf8",
  );
  vi.stubEnv("CLAUDE_CONFIG_DIR", sharedClaudeConfig);
  vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip-home"));
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "test-instance");
  for (const [key, value] of Object.entries(SERVER_SECRETS)) vi.stubEnv(key, value);
});

afterEach(async () => {
  vi.clearAllMocks();
  prepareAdapterExecutionTargetRuntime.mockReset();
  startAdapterExecutionTargetPaperclipBridge.mockReset();
  vi.unstubAllEnvs();
  resetClaudeCliCapabilitiesCacheForTests();
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

describe("claude sandbox runs never receive the server environment", () => {
  it("keeps the server env out of the install and resolvability commands", async () => {
    const calls: RunnerCall[] = [];
    prepareAdapterExecutionTargetRuntime.mockRejectedValue(STOP);

    await expect(execute(executeInput({ executionTarget: sandboxTarget(calls) }))).rejects.toBe(STOP);

    // The detect probe of the install step and the resolvability probe.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      const envText = JSON.stringify(call.env ?? {});
      for (const [key, value] of Object.entries(SERVER_SECRETS)) {
        expect(call.env ?? {}).not.toHaveProperty(key);
        expect(envText).not.toContain(value);
      }
      expect(call.env?.PAPERCLIP_RUN_ID).toBe("run-1");
    }
  });
});

describe("claude environment probes never receive the server environment", () => {
  function expectNoServerSecrets(calls: RunnerCall[]): void {
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const envText = JSON.stringify(call.env ?? {});
      for (const [key, value] of Object.entries(SERVER_SECRETS)) {
        expect(call.env ?? {}).not.toHaveProperty(key);
        expect(envText).not.toContain(value);
      }
    }
  }

  it("keeps the server env out of the environment test", async () => {
    const calls: RunnerCall[] = [];
    const target = sandboxTarget(calls);
    prepareAdapterExecutionTargetRuntime.mockResolvedValue(preparedSandboxRuntime(target));

    await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude", model: "claude-opus-5" },
      executionTarget: target,
      environmentName: "Sandbox",
    });
    expectNoServerSecrets(calls);
  });

  it("keeps the server env out of the ACP engine availability probe", async () => {
    const calls: RunnerCall[] = [];
    await resolveClaudeExecutionEngineForRun({
      config: { engine: "acp" },
      executionTarget: sandboxTarget(calls),
    });
    expectNoServerSecrets(calls);
  });
});

describe("claude pool-account config directory", () => {
  it("materializes config-<ref> without stored logins on a sandbox target", async () => {
    const calls: RunnerCall[] = [];
    const target = sandboxTarget(calls);
    prepareAdapterExecutionTargetRuntime.mockResolvedValue(preparedSandboxRuntime(target));
    startAdapterExecutionTargetPaperclipBridge.mockRejectedValue(STOP);

    await expect(execute(executeInput({
      executionTarget: target,
      env: { [AI_CREDENTIAL_REF_ENV_KEY]: POOL_REF, CLAUDE_CODE_OAUTH_TOKEN: "pool-token-value" },
    }))).rejects.toBe(STOP);

    const materialization = calls.find((call) => call.args.join(" ").includes("mkdir -p"));
    const script = materialization?.args.join(" ") ?? "";
    expect(script).toContain(`/sandbox/workspace/.paperclip-runtime/claude/config-${POOL_REF}`);
    expect(script).toContain(".credentials.json");
    expect(script).not.toContain("HOME");
    expect(materialization?.env).toEqual({});

    // The seed the run synced has the routing and helper settings stripped.
    const stageInput = prepareAdapterExecutionTargetRuntime.mock.calls[0]?.[0] as {
      assets?: Array<{ key: string; localDir: string }>;
    };
    const seed = stageInput.assets?.find((asset) => asset.key === "config-seed");
    expect(seed).toBeDefined();
    expect(JSON.parse(await readFile(path.join(seed!.localDir, "settings.json"), "utf8"))).toEqual({
      theme: "dark",
      permissions: { defaultMode: "default" },
    });
  });

  it("keeps today's config directory and command on a sandbox target without the marker", async () => {
    const calls: RunnerCall[] = [];
    const target = sandboxTarget(calls);
    prepareAdapterExecutionTargetRuntime.mockResolvedValue(preparedSandboxRuntime(target));
    startAdapterExecutionTargetPaperclipBridge.mockRejectedValue(STOP);

    await expect(execute(executeInput({ executionTarget: target, env: { [AI_CREDENTIAL_REF_ENV_KEY]: "NOT-A-REF" } })))
      .rejects.toBe(STOP);

    const materialization = calls.find((call) => call.args.join(" ").includes("mkdir -p"));
    const script = materialization?.args.join(" ") ?? "";
    expect(script).toContain("mkdir -p '/sandbox/workspace/.paperclip-runtime/claude/config' && ");
    expect(script).toContain('"${HOME}/.claude/${file}"');
    expect(materialization?.env?.PAPERCLIP_RUN_ID).toBe("run-1");
  });

  it("creates config-<ref> on an SSH host and unsets profile routing keys for the run", async () => {
    startAdapterExecutionTargetPaperclipBridge.mockResolvedValue(null);
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-1/workspace";
    // The run's runtime root is per-run scratch; the account's directory is not.
    const configDir = `/remote/workspace/.paperclip-runtime/claude/config-${POOL_REF}`;

    const result = await execute(executeInput({
      executionTransport: { remoteExecution: sshSpec },
      env: { [AI_CREDENTIAL_REF_ENV_KEY]: POOL_REF, CLAUDE_CODE_OAUTH_TOKEN: "pool-token-value" },
    }));
    expect(result.exitCode).toBe(0);

    // The stripped seed went up with the other runtime assets, into the run's scratch.
    const seedDir = `${managedRemoteWorkspace}/.paperclip-runtime/claude/config-seed`;
    expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({ remoteDir: seedDir }));
    const materialization = runSshCommand.mock.calls.find((call) => String(call[1]).includes("mkdir -p"));
    expect(String(materialization?.[1])).toContain(`mkdir -p '${configDir}' && rm -f '${configDir}'/settings.json`);
    expect(String(materialization?.[1])).toContain(`cp -R '${seedDir}/.' '${configDir}'/`);
    expect(String(materialization?.[1])).toContain(`rm -f '${configDir}'/.credentials.json '${configDir}'/credentials.json`);
    expect(String(materialization?.[1])).not.toContain("HOME");
    expect((materialization?.[2] as { env?: Record<string, string> } | undefined)?.env).toEqual({});

    const mainCall = runChildProcess.mock.calls.find((call) => !call[2].includes("--version"));
    const options = mainCall?.[3] as unknown as {
      env: Record<string, string>;
      remoteEnvOptions?: { unsetEnvKeys?: readonly string[]; unsetEnvPatterns?: readonly string[] };
    };
    expect(options.env.CLAUDE_CONFIG_DIR).toBe(configDir);
    expect(options.remoteEnvOptions?.unsetEnvKeys).toEqual(POOL_RUN_SSH_UNSET_ENV_KEYS);
    expect(options.remoteEnvOptions?.unsetEnvPatterns).toEqual(POOL_RUN_SSH_UNSET_ENV_PATTERNS);
  });

  it("keeps one config-<ref> per SSH device across runs, outside the per-run runtime directory", async () => {
    startAdapterExecutionTargetPaperclipBridge.mockResolvedValue(null);
    const deviceWorktree = "/device/root/.paperclip-device/worktrees/company-1/ew-1";
    const deviceTarget: AdapterExecutionTarget = {
      kind: "remote",
      transport: "ssh",
      remoteCwd: deviceWorktree,
      spec: { ...sshSpec, remoteWorkspacePath: "/device/root", remoteCwd: deviceWorktree },
      workspaceRealization: {
        mode: "in_place",
        authoritativeRoot: deviceWorktree,
        pathAliases: [],
        outboundRestorePaths: [],
      },
    };
    const configDir = `/device/root/.paperclip-device/claude/config-${POOL_REF}`;
    // The device keeps the worktree and the session identity between runs, so
    // every run resumes the agent's session: its transcript must still be there.
    const sessionId = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
    const runtime = {
      sessionId,
      sessionParams: { sessionId, cwd: deviceWorktree, remoteExecution: adapterExecutionTargetSessionIdentity(deviceTarget) },
      sessionDisplayId: null,
      taskKey: null,
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runs: Array<{ runtimeRootDir: string; configDir: string | undefined; args: string[]; materialization: string }> = [];
    try {
      for (const runId of ["run-1", "run-2"]) {
        runChildProcess.mockClear();
        runSshCommand.mockClear();
        syncDirectoryToSsh.mockClear();
        const result = await execute({
          ...executeInput({
            executionTarget: deviceTarget,
            env: { [AI_CREDENTIAL_REF_ENV_KEY]: POOL_REF, CLAUDE_CODE_OAUTH_TOKEN: "pool-token-value" },
          }),
          runId,
          runtime,
        });
        expect(result.exitCode).toBe(0);
        const mainCall = runChildProcess.mock.calls.find((call) => !call[2].includes("--version"));
        const options = mainCall?.[3] as unknown as { env: Record<string, string> };
        runs.push({
          runtimeRootDir: `/device/root/.paperclip-device/runtime/${runId}/claude`,
          configDir: options.env.CLAUDE_CONFIG_DIR,
          args: mainCall?.[2] ?? [],
          materialization: String(runSshCommand.mock.calls.find((call) => String(call[1]).includes("mkdir -p"))?.[1] ?? ""),
        });
        // The seed is per run; it is materialized into the account's directory every time.
        expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({
          remoteDir: `/device/root/.paperclip-device/runtime/${runId}/claude/config-seed`,
        }));
      }
    } finally {
      warnSpy.mockRestore();
    }

    expect(runs[0]!.configDir).toBe(configDir);
    expect(runs[1]!.configDir).toBe(configDir);
    for (const run of runs) {
      expect(run.args).toEqual(expect.arrayContaining(["--resume", sessionId]));
      expect(run.configDir!.startsWith(`${run.runtimeRootDir}/`)).toBe(false);
      expect(run.configDir!.startsWith("/device/root/.paperclip-device/worktrees/")).toBe(false);
      expect(run.materialization).toContain(`mkdir -p '${configDir}' && rm -f '${configDir}'/settings.json`);
      expect(run.materialization).toContain(`cp -R '${run.runtimeRootDir}/config-seed/.' '${configDir}'/`);
      expect(run.materialization).toContain(`rm -f '${configDir}'/.credentials.json '${configDir}'/credentials.json`);
    }
  });

  it("leaves an SSH device run without the marker on today's directories", async () => {
    startAdapterExecutionTargetPaperclipBridge.mockResolvedValue(null);
    const deviceWorktree = "/device/root/.paperclip-device/worktrees/company-1/ew-1";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await execute(executeInput({
        executionTarget: {
          kind: "remote",
          transport: "ssh",
          remoteCwd: deviceWorktree,
          spec: { ...sshSpec, remoteWorkspacePath: "/device/root", remoteCwd: deviceWorktree },
          workspaceRealization: {
            mode: "in_place",
            authoritativeRoot: deviceWorktree,
            pathAliases: [],
            outboundRestorePaths: [],
          },
        },
      }));
      expect(result.exitCode).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
    expect(runSshCommand.mock.calls.some((call) => String(call[1]).includes("/claude/config"))).toBe(false);
    const mainCall = runChildProcess.mock.calls.find((call) => !call[2].includes("--version"));
    const options = mainCall?.[3] as unknown as { env: Record<string, string>; remoteEnvOptions?: unknown };
    expect(options.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(options.remoteEnvOptions).toBeUndefined();
  });

  it("leaves an SSH run without the marker as it was", async () => {
    startAdapterExecutionTargetPaperclipBridge.mockResolvedValue(null);

    const result = await execute(executeInput({ executionTransport: { remoteExecution: sshSpec } }));
    expect(result.exitCode).toBe(0);

    expect(runSshCommand.mock.calls.some((call) => String(call[1]).includes("/claude/config"))).toBe(false);
    const mainCall = runChildProcess.mock.calls.find((call) => !call[2].includes("--version"));
    const options = mainCall?.[3] as unknown as { env: Record<string, string>; remoteEnvOptions?: unknown };
    expect(options.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(options.remoteEnvOptions).toBeUndefined();
  });

  it("keeps a local pool run on today's config directory", async () => {
    const result = await execute(executeInput({
      env: { [AI_CREDENTIAL_REF_ENV_KEY]: POOL_REF, CLAUDE_CODE_OAUTH_TOKEN: "pool-token-value" },
    }));
    expect(result.exitCode).toBe(0);
    const mainCall = runChildProcess.mock.calls.find((call) => !call[2].includes("--version"));
    const options = mainCall?.[3] as unknown as { env: Record<string, string>; remoteEnvOptions?: unknown };
    expect(options.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(options.remoteEnvOptions).toBeUndefined();
    expect(runSshCommand).not.toHaveBeenCalled();
  });
});
