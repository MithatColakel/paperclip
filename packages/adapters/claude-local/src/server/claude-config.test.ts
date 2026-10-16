import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

// A shared handle so the managed-config test can force the runtime preparation
// step to throw an error that carries untrusted markers.
const { prepareAdapterExecutionTargetRuntime } = vi.hoisted(() => ({
  prepareAdapterExecutionTargetRuntime: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    adapterExecutionTargetUsesManagedHome: () => true,
    maybeRunSandboxInstallCommand: async () => null,
    prepareAdapterExecutionTargetRuntime,
  };
});

import { execFile } from "node:child_process";
import { buildSshEnvLoadSteps } from "@paperclipai/adapter-utils/ssh";
import {
  AI_CREDENTIAL_REF_ENV_KEY as SHARED_AI_CREDENTIAL_REF_ENV_KEY,
  AI_CREDENTIAL_REF_PATTERN,
  FORBIDDEN_SETTINGS_KEYS,
  isPoolRunForbiddenEnvKey,
  POOL_RUN_FORBIDDEN_ENV_MATCHERS,
  POOL_RUN_REMOVED_ENV_KEYS,
} from "@paperclipai/shared";
import {
  buildRemoteClaudeConfigMaterializationCommand,
  POOL_CLAUDE_CONFIG_MATERIALIZATION,
  prepareClaudeConfigSeed,
  prepareSandboxClaudeProbeRuntime,
} from "./claude-config.js";
import {
  AI_CREDENTIAL_REF_ENV_KEY,
  managedClaudeConfigDirName,
  POOL_RUN_SSH_UNSET_ENV_KEYS,
  POOL_RUN_SSH_UNSET_ENV_PATTERNS,
  readAiCredentialRef,
  sshPoolClaudeConfigDir,
} from "./ai-credential-ref.js";

describe("prepareClaudeConfigSeed", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function createEnv(root: string, sourceDir: string): NodeJS.ProcessEnv {
    return {
      HOME: root,
      PAPERCLIP_HOME: path.join(root, "paperclip-home"),
      PAPERCLIP_INSTANCE_ID: "test-instance",
      CLAUDE_CONFIG_DIR: sourceDir,
    };
  }

  it("reuses the same snapshot path when the seeded files are unchanged", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-seed-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({
      theme: "light",
      permissions: { defaultMode: "bypassPermissions" },
    }), "utf8");
    await fs.writeFile(path.join(sourceDir, ".credentials.json"), JSON.stringify({ token: "local" }), "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);

    const first = await prepareClaudeConfigSeed(env, onLog, "company-1");
    const second = await prepareClaudeConfigSeed(env, onLog, "company-1");

    expect(first).toBe(second);
    await expect(fs.readFile(path.join(first, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ theme: "light", permissions: { defaultMode: "default" } }));
    await expect(fs.access(path.join(first, ".credentials.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an existing snapshot intact when the seeded files change", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-race-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({ theme: "light" }), "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);
    const first = await prepareClaudeConfigSeed(env, onLog, "company-1");

    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({ theme: "dark" }), "utf8");
    const second = await prepareClaudeConfigSeed(env, onLog, "company-1");

    expect(second).not.toBe(first);
    await expect(fs.readFile(path.join(first, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ theme: "light", permissions: { defaultMode: "default" } }));
    await expect(fs.readFile(path.join(second, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ theme: "dark", permissions: { defaultMode: "default" } }));
  });

  it("strips local-only settings from remote Claude config seeds", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-boundary-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({
      permissions: {
        defaultMode: "dontAsk",
        allow: ["Bash(op item *)"],
      },
      hooks: { PreToolUse: [{ matcher: "*" }] },
      mcpServers: { local: { command: "secret-local-server" } },
      permissionMode: "dontAsk",
      skipDangerousModePermissionPrompt: true,
    }), "utf8");
    await fs.writeFile(path.join(sourceDir, "settings.local.json"), JSON.stringify({
      permissions: { defaultMode: "bypassPermissions" },
    }), "utf8");
    await fs.writeFile(path.join(sourceDir, "credentials.json"), JSON.stringify({ token: "local" }), "utf8");
    await fs.writeFile(path.join(sourceDir, "CLAUDE.md"), "local instructions", "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);
    const seedDir = await prepareClaudeConfigSeed(env, onLog, "company-1");
    const remoteSettings = JSON.parse(await fs.readFile(path.join(seedDir, "settings.json"), "utf8"));

    expect(remoteSettings.permissions).toEqual({ defaultMode: "default" });
    expect(remoteSettings.hooks).toBeUndefined();
    expect(remoteSettings.mcpServers).toBeUndefined();
    expect(remoteSettings.permissionMode).toBeUndefined();
    expect(remoteSettings.skipDangerousModePermissionPrompt).toBeUndefined();
    await expect(fs.access(path.join(seedDir, "settings.local.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(seedDir, "credentials.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(seedDir, "CLAUDE.md"), "utf8"))
      .resolves.toBe("local instructions");
  });
});

describe("prepareSandboxClaudeProbeRuntime managed-config diagnostics", () => {
  const cleanupDirs: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  const sandboxTarget: AdapterExecutionTarget = {
    kind: "remote",
    transport: "sandbox",
    providerKey: "daytona",
    remoteCwd: "/home/daytona/paperclip-workspace",
    runner: {
      execute: async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
      }),
    },
  };

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("keeps a thrown config-materialization error out of every check and the log", async () => {
    // The runtime preparation throws an error that carries two untrusted values:
    // an opaque credential marker and a proxy marker. Neither may reach a check
    // or the server log. The log carries only the fixed context, the allowlisted
    // classification, and the safe error class name.
    const opaqueCredMarker = "OPAQUECREDMARKERconfig";
    const proxyMarker = "http://user:pass@proxy.corp.internal:3128";

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-mgmt-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });

    for (const key of ["CLAUDE_CONFIG_DIR", "PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID"]) {
      savedEnv[key] = process.env[key];
    }
    process.env.CLAUDE_CONFIG_DIR = sourceDir;
    process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    prepareAdapterExecutionTargetRuntime.mockRejectedValueOnce(
      new Error(`materialize failed with ${opaqueCredMarker} via ${proxyMarker}`),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const checks = await prepareSandboxClaudeProbeRuntime({
      runId: "run-1",
      target: sandboxTarget,
      // The probe passes no CLAUDE_CONFIG_DIR, so the managed branch runs.
      cwd: "/home/daytona/paperclip-workspace",
      companyId: "company-1",
      env: {},
      installCommand: "install-claude",
      detectCommand: "claude",
      targetIsRemote: true,
      targetIsSandbox: true,
      helloProbeTimeoutSec: 30,
    });

    const failed = checks.find((check) => check.code === "claude_managed_config_dir_failed");
    expect(failed).toBeTruthy();
    const checkText = JSON.stringify(checks);
    expect(checkText).not.toContain(opaqueCredMarker);
    expect(checkText).not.toContain("proxy.corp.internal");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const loggedText = JSON.stringify(warnSpy.mock.calls);
    expect(loggedText).not.toContain(opaqueCredMarker);
    expect(loggedText).not.toContain("proxy.corp.internal");
    expect(warnSpy.mock.calls[0]?.[1]).toMatchObject({
      classification: "spawn_error",
      errorClass: "Error",
    });
    warnSpy.mockRestore();
  });
});

const POOL_REF = "0123456789abcdef";

function runShell(script: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("/bin/sh", ["-c", script], { env }, (error) => (error ? reject(error) : resolve()));
  });
}

describe("pool credential marker", () => {
  it("matches the shared marker and accepts only 16 lowercase hex characters", () => {
    expect(AI_CREDENTIAL_REF_ENV_KEY).toBe(SHARED_AI_CREDENTIAL_REF_ENV_KEY);
    for (const value of [POOL_REF, "0123456789ABCDEF", "0123456789abcde", "0123456789abcdef0", " 0123456789abcdef", ""]) {
      expect(readAiCredentialRef({ [AI_CREDENTIAL_REF_ENV_KEY]: value }) !== null).toBe(AI_CREDENTIAL_REF_PATTERN.test(value));
    }
    expect(readAiCredentialRef({})).toBeNull();
    expect(readAiCredentialRef(null)).toBeNull();
    expect(managedClaudeConfigDirName(POOL_REF)).toBe(`config-${POOL_REF}`);
    expect(managedClaudeConfigDirName(null)).toBe("config");
  });

  it("unsets every routing key and credential carrier the shared pool rules name", () => {
    for (const key of POOL_RUN_REMOVED_ENV_KEYS) expect(POOL_RUN_SSH_UNSET_ENV_KEYS).toContain(key);
    for (const matcher of POOL_RUN_FORBIDDEN_ENV_MATCHERS) {
      if (matcher.kind === "exact") expect(POOL_RUN_SSH_UNSET_ENV_KEYS).toContain(matcher.key);
      if (matcher.kind === "exact_any_case") {
        expect(POOL_RUN_SSH_UNSET_ENV_KEYS).toContain(matcher.key.toUpperCase());
        expect(POOL_RUN_SSH_UNSET_ENV_KEYS).toContain(matcher.key.toLowerCase());
      }
    }
    for (const key of POOL_RUN_SSH_UNSET_ENV_KEYS) {
      expect(isPoolRunForbiddenEnvKey(key) || (POOL_RUN_REMOVED_ENV_KEYS as readonly string[]).includes(key)).toBe(true);
    }
  });

  it("unsets, by glob, every name the routing guard flags, including names no fixed list knows", async () => {
    expect(POOL_RUN_SSH_UNSET_ENV_PATTERNS).toEqual(expect.arrayContaining([
      "ANTHROPIC_*BASE_URL",
      "CLAUDE_CODE_*BASE_URL",
      "CLAUDE_CODE_USE_*",
      "[Hh][Tt][Tt][Pp][Ss]_[Pp][Rr][Oo][Xx][Yy]",
    ]));
    const flagged = [
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_X_BASE_URL",
      "ANTHROPIC_NEW_PROVIDER_BASE_URL",
      "CLAUDE_CODE_BASE_URL",
      "CLAUDE_CODE_API_BASE_URL",
      "CLAUDE_CODE_USE_FOO",
      "CLAUDE_CODE_USE_BEDROCK",
      "Https_Proxy",
      "all_Proxy",
      "NODE_EXTRA_CA_CERTS",
    ];
    for (const name of flagged) expect(isPoolRunForbiddenEnvKey(name)).toBe(true);
    const kept = ["ANTHROPIC_MODEL", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "NO_PROXY"];
    // The steps an SSH pool run executes after the login profiles, here with
    // every name exported as a profile would.
    const steps = buildSshEnvLoadSteps({
      stagedDir: null,
      unsetEnvKeys: POOL_RUN_SSH_UNSET_ENV_KEYS,
      unsetEnvPatterns: POOL_RUN_SSH_UNSET_ENV_PATTERNS,
    });
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        "/bin/sh",
        ["-c", [...steps, "env"].join(" && ")],
        { env: { PATH: "/usr/bin:/bin", ...Object.fromEntries([...flagged, ...kept].map((name) => [name, "profile-value"])) } },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
    const remaining = new Set(output.split("\n").map((line) => line.split("=")[0]));
    for (const name of flagged) expect(remaining.has(name)).toBe(false);
    for (const name of kept) expect(remaining.has(name)).toBe(true);
  });
});

describe("sshPoolClaudeConfigDir", () => {
  it("keeps a pool account's config outside per-run scratch and git worktrees", () => {
    expect(sshPoolClaudeConfigDir({ remoteWorkspacePath: "/srv/ws", deviceMode: false, credentialRef: POOL_REF }))
      .toBe(`/srv/ws/.paperclip-runtime/claude/config-${POOL_REF}`);
    expect(sshPoolClaudeConfigDir({ remoteWorkspacePath: "/Users/dev/paperclip", deviceMode: true, credentialRef: POOL_REF }))
      .toBe(`/Users/dev/paperclip/.paperclip-device/claude/config-${POOL_REF}`);
  });
});

describe("buildRemoteClaudeConfigMaterializationCommand", () => {
  const dir = "/srv/ws/.paperclip-runtime/claude/config";
  const seed = "/srv/ws/.paperclip-runtime/claude/config-seed";

  it("keeps today's command when no option is set", () => {
    expect(buildRemoteClaudeConfigMaterializationCommand({ remoteClaudeConfigDir: dir, remoteClaudeConfigSeedDir: seed })).toBe(
      `mkdir -p '${dir}' && if [ -d '${seed}' ]; then cp -R '${seed}/.' '${dir}'/; fi; ` +
        `for file in .credentials.json credentials.json; do ` +
        `if [ -n "\${HOME:-}" ] && [ -f "\${HOME}/.claude/\${file}" ] && [ ! -f '${dir}'/"\${file}" ]; then ` +
        `cp "\${HOME}/.claude/\${file}" '${dir}'/"\${file}"; fi; done`,
    );
  });

  it("removes stored logins, resets settings and never reads HOME for a pool account", async () => {
    const command = buildRemoteClaudeConfigMaterializationCommand({
      remoteClaudeConfigDir: `${dir}-${POOL_REF}`,
      remoteClaudeConfigSeedDir: seed,
      ...POOL_CLAUDE_CONFIG_MATERIALIZATION,
    });
    expect(command).not.toContain("HOME");
    expect(command).toContain(`rm -f '${dir}-${POOL_REF}'/.credentials.json '${dir}-${POOL_REF}'/credentials.json`);

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-pool-config-"));
    try {
      const home = path.join(root, "home");
      const configDir = path.join(root, `config-${POOL_REF}`);
      const seedDir = path.join(root, "config-seed");
      await fs.mkdir(path.join(home, ".claude"), { recursive: true });
      await fs.mkdir(configDir, { recursive: true });
      await fs.mkdir(seedDir, { recursive: true });
      await fs.writeFile(path.join(home, ".claude", ".credentials.json"), '{"owner":"login"}', "utf8");
      // A previous run left a routing setting and a stored login behind.
      await fs.writeFile(path.join(configDir, "settings.json"), '{"env":{"ANTHROPIC_BASE_URL":"http://x"}}', "utf8");
      await fs.writeFile(path.join(configDir, ".credentials.json"), '{"stale":"login"}', "utf8");
      await fs.writeFile(path.join(configDir, "credentials.json"), '{"stale":"login"}', "utf8");
      await fs.writeFile(path.join(seedDir, "CLAUDE.md"), "seeded instructions", "utf8");

      await runShell(
        buildRemoteClaudeConfigMaterializationCommand({
          remoteClaudeConfigDir: configDir,
          remoteClaudeConfigSeedDir: seedDir,
          ...POOL_CLAUDE_CONFIG_MATERIALIZATION,
        }),
        { HOME: home, PATH: "/usr/bin:/bin" },
      );

      expect((await fs.readdir(configDir)).sort()).toEqual(["CLAUDE.md"]);

      await fs.writeFile(path.join(seedDir, "settings.json"), '{"theme":"dark"}', "utf8");
      await runShell(
        buildRemoteClaudeConfigMaterializationCommand({
          remoteClaudeConfigDir: configDir,
          remoteClaudeConfigSeedDir: seedDir,
          ...POOL_CLAUDE_CONFIG_MATERIALIZATION,
        }),
        { HOME: home, PATH: "/usr/bin:/bin" },
      );
      await expect(fs.readFile(path.join(configDir, "settings.json"), "utf8")).resolves.toBe('{"theme":"dark"}');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("prepareClaudeConfigSeed for pool accounts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drops env and credential helpers from the seeded settings", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-pool-seed-"));
    try {
      const sourceDir = path.join(root, "claude-source");
      await fs.mkdir(sourceDir, { recursive: true });
      const settings: Record<string, unknown> = {
        theme: "light",
        env: { ANTHROPIC_BASE_URL: "http://proxy.invalid" },
      };
      for (const key of FORBIDDEN_SETTINGS_KEYS) settings[key] = "/usr/local/bin/credential-helper";
      await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify(settings), "utf8");
      const env: NodeJS.ProcessEnv = {
        HOME: root,
        PAPERCLIP_HOME: path.join(root, "paperclip-home"),
        PAPERCLIP_INSTANCE_ID: "test-instance",
        CLAUDE_CONFIG_DIR: sourceDir,
      };

      const poolSeed = await prepareClaudeConfigSeed(env, async () => {}, "company-1", { stripAuthSettings: true });
      const poolSettings = JSON.parse(await fs.readFile(path.join(poolSeed, "settings.json"), "utf8"));
      expect(poolSettings).toEqual({ theme: "light", permissions: { defaultMode: "default" } });

      // Without the pool option the seed is unchanged from today.
      const defaultSeed = await prepareClaudeConfigSeed(env, async () => {}, "company-1");
      expect(defaultSeed).not.toBe(poolSeed);
      const defaultSettings = JSON.parse(await fs.readFile(path.join(defaultSeed, "settings.json"), "utf8"));
      expect(defaultSettings.env).toEqual({ ANTHROPIC_BASE_URL: "http://proxy.invalid" });
      expect(defaultSettings.apiKeyHelper).toBe("/usr/local/bin/credential-helper");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("prepareSandboxClaudeProbeRuntime pool config dir", () => {
  const runtimeRoot = "/home/daytona/paperclip-workspace/.paperclip-runtime/claude";
  let root: string;
  let runnerCalls: Array<{ script: string; env: Record<string, string> | undefined }>;

  function target(): AdapterExecutionTarget {
    return {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd: "/home/daytona/paperclip-workspace",
      runner: {
        execute: async (input) => {
          runnerCalls.push({ script: input.args?.join(" ") ?? "", env: input.env });
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

  async function probe(env: Record<string, string>) {
    prepareAdapterExecutionTargetRuntime.mockResolvedValueOnce({
      target: target(),
      workspaceRemoteDir: null,
      runtimeRootDir: runtimeRoot,
      assetDirs: { "config-seed": `${runtimeRoot}/config-seed` },
      additionalSourceDirs: {},
      additionalSourceFailures: [],
      workspaceSyncSnapshot: null,
      restoreWorkspace: async () => {},
    });
    const checks = await prepareSandboxClaudeProbeRuntime({
      runId: "run-pool",
      target: target(),
      cwd: "/home/daytona/paperclip-workspace",
      companyId: "company-1",
      env,
      installCommand: "install-claude",
      detectCommand: "claude",
      targetIsRemote: true,
      targetIsSandbox: true,
      helloProbeTimeoutSec: 30,
    });
    const materialization = runnerCalls.find((call) => call.script.includes("mkdir -p"));
    return { checks, materialization };
  }

  beforeEach(async () => {
    runnerCalls = [];
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-pool-probe-"));
    await fs.mkdir(path.join(root, "claude-source"), { recursive: true });
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(root, "claude-source"));
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip-home"));
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "test-instance");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("uses config-<ref>, removes stored logins and sends no env when the marker is set", async () => {
    const env: Record<string, string> = {
      [AI_CREDENTIAL_REF_ENV_KEY]: POOL_REF,
      CLAUDE_CODE_OAUTH_TOKEN: "pool-token-value",
      // An explicit directory never beats the account's own directory.
      CLAUDE_CONFIG_DIR: "/home/daytona/.claude",
    };
    const { checks, materialization } = await probe(env);

    expect(env.CLAUDE_CONFIG_DIR).toBe(`${runtimeRoot}/config-${POOL_REF}`);
    expect(checks.some((check) => check.code === "claude_managed_config_dir")).toBe(true);
    expect(materialization?.script).toContain(`rm -f '${runtimeRoot}/config-${POOL_REF}'/.credentials.json`);
    expect(materialization?.script).not.toContain("HOME");
    expect(materialization?.env).toEqual({});
  });

  it("ignores an invalid marker and keeps today's directory and command", async () => {
    for (const marker of ["0123456789ABCDEF", "not-a-ref"]) {
      runnerCalls = [];
      const env: Record<string, string> = { [AI_CREDENTIAL_REF_ENV_KEY]: marker };
      const { materialization } = await probe(env);
      expect(env.CLAUDE_CONFIG_DIR).toBe(`${runtimeRoot}/config`);
      expect(materialization?.script).toContain(
        buildRemoteClaudeConfigMaterializationCommand({
          remoteClaudeConfigDir: `${runtimeRoot}/config`,
          remoteClaudeConfigSeedDir: `${runtimeRoot}/config-seed`,
        }),
      );
    }
  });
});
