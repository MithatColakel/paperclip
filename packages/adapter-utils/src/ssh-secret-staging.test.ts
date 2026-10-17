import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runChildProcess } from "./server-utils.js";
import {
  buildSshEnvLoadSteps,
  buildSshSpawnTarget,
  buildSshStagedEnvFile,
  createSshCommandManagedRuntimeRunner,
  getSshEnvLabSupport,
  parseSshStagedEnvDir,
  runSshCommand,
  shellQuote,
  SSH_ENV_STAGING_SCRIPT,
  SshEnvStagingError,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
  buildSshEnvLabFixtureConfig,
  type SshEnvLabFixtureState,
  type SshRemoteExecutionSpec,
} from "./ssh.js";

// A stand-in for the ssh client. It records every argv it receives (one file
// per call, NUL-separated), drops the ssh options and runs the remote command
// the way a remote login would: with /bin/sh, a clean environment and the
// fake remote HOME and TMPDIR. FAKE_SSH_FAIL_PATTERN makes a matching call
// fail like an unreachable host; FAKE_SSH_HANG_PATTERN makes a matching call
// hang before the remote command starts, like a slow connection.
const FAKE_SSH_SCRIPT = `#!/bin/sh
call=$(mktemp "$FAKE_SSH_LOG_DIR/call.XXXXXX")
printf '%s\\0' "$@" > "$call"
while [ $# -gt 0 ]; do
  case "$1" in
    -o|-i|-p|-F|-l) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
shift
if [ -n "\${FAKE_SSH_FAIL_PATTERN:-}" ]; then
  case "$*" in
    *"$FAKE_SSH_FAIL_PATTERN"*)
      echo "ssh: connect to host fake.example.test port 22: Connection refused" >&2
      exit 255
      ;;
  esac
fi
if [ -n "\${FAKE_SSH_HANG_PATTERN:-}" ]; then
  case "$*" in
    *"$FAKE_SSH_HANG_PATTERN"*) sleep 30 ;;
  esac
fi
exec env -i HOME="$FAKE_REMOTE_HOME" PATH="/usr/bin:/bin" TMPDIR="$FAKE_REMOTE_TMPDIR" /bin/sh -c "$*"
`;

const SECRET_API_KEY = "sk-test-staged-api-key-value";
const SECRET_CUSTOM = "custom-secret-value-7f3a";
const SECRET_BRIDGE = "bridge-token-value-91c2";
// Company secrets bound to names that do not look secret.
const SECRET_DATABASE_URL = "postgres://app:S3cr3tPw-4b1d@db.invalid/prod";
const SECRET_PAT = "pat-value-8e2c";

const LEGACY_PROFILE_STEPS = [
  'if [ -f /etc/profile ]; then . /etc/profile >/dev/null 2>&1 || true; fi',
  'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
  'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1 || true; elif [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc" >/dev/null 2>&1 || true; fi',
  'if [ -f "$HOME/.zprofile" ]; then . "$HOME/.zprofile" >/dev/null 2>&1 || true; fi',
];

interface FakeSshHost {
  root: string;
  logDir: string;
  remoteHome: string;
  remoteTmp: string;
  remoteCwd: string;
  spec: SshRemoteExecutionSpec;
}

async function createFakeSshHost(): Promise<FakeSshHost> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-staging-"));
  const binDir = path.join(root, "bin");
  const logDir = path.join(root, "calls");
  const remoteHome = path.join(root, "remote-home");
  const remoteTmp = path.join(root, "remote-tmp");
  const remoteCwd = path.join(root, "remote-workspace");
  for (const dir of [binDir, logDir, remoteHome, remoteTmp, remoteCwd]) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(path.join(binDir, "ssh"), FAKE_SSH_SCRIPT, "utf8");
  await chmod(path.join(binDir, "ssh"), 0o755);
  vi.stubEnv("PATH", `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`);
  vi.stubEnv("FAKE_SSH_LOG_DIR", logDir);
  vi.stubEnv("FAKE_REMOTE_HOME", remoteHome);
  vi.stubEnv("FAKE_REMOTE_TMPDIR", remoteTmp);
  vi.stubEnv("FAKE_SSH_FAIL_PATTERN", "");
  vi.stubEnv("FAKE_SSH_HANG_PATTERN", "");
  return {
    root,
    logDir,
    remoteHome,
    remoteTmp,
    remoteCwd,
    spec: {
      host: "fake.example.test",
      port: 22,
      username: "agent",
      remoteCwd,
      remoteWorkspacePath: remoteCwd,
      privateKey: null,
      knownHosts: null,
      strictHostKeyChecking: false,
    },
  };
}

/** Every argv the fake ssh received since the last clear, in no particular order. */
async function readSshCalls(host: FakeSshHost): Promise<string[][]> {
  const calls: string[][] = [];
  for (const name of await readdir(host.logDir)) {
    const raw = await readFile(path.join(host.logDir, name), "utf8");
    calls.push(raw.split("\0").slice(0, -1));
  }
  return calls;
}

async function clearSshCalls(host: FakeSshHost): Promise<void> {
  for (const name of await readdir(host.logDir)) {
    await rm(path.join(host.logDir, name), { force: true });
  }
}

/** The remote command a call ran: the last ssh argument. */
function remoteCommands(calls: string[][]): string[] {
  return calls.map((argv) => argv.at(-1) ?? "");
}

async function stagedEnvDirs(host: FakeSshHost): Promise<string[]> {
  return (await readdir(host.remoteTmp)).filter((name) => name.startsWith("paperclip-env."));
}

function expectNoSecretInArgv(calls: string[][], secrets: string[]): void {
  const argvText = calls.map((argv) => argv.join("\n")).join("\n");
  for (const secret of secrets) {
    expect(argvText).not.toContain(secret);
  }
}

describe("ssh secret staging", () => {
  let host: FakeSshHost;

  beforeEach(async () => {
    host = await createFakeSshHost();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(host.root, { recursive: true, force: true }).catch(() => undefined);
  });

  it("keeps secret values off the runSshCommand argv and delivers them", async () => {
    const result = await runSshCommand(
      host.spec,
      'printf "%s|%s|%s" "$ANTHROPIC_API_KEY" "$PAPERCLIP_TASK_ID" "$PAPERCLIP_RUN_ID"',
      {
        env: {
          ANTHROPIC_API_KEY: SECRET_API_KEY,
          PAPERCLIP_TASK_ID: SECRET_CUSTOM,
          PAPERCLIP_RUN_ID: "plain-value",
        },
        // A name on the non-secret list is staged too when the caller says so.
        secretEnvKeys: ["PAPERCLIP_TASK_ID"],
      },
    );

    expect(result.stdout).toBe(`${SECRET_API_KEY}|${SECRET_CUSTOM}|plain-value`);
    const calls = await readSshCalls(host);
    // One staging call, then the command itself.
    expect(calls).toHaveLength(2);
    expectNoSecretInArgv(calls, [SECRET_API_KEY, SECRET_CUSTOM]);
    // A value under a known non-secret name still rides the command line as before.
    expect(remoteCommands(calls).filter((command) => command.includes("PAPERCLIP_RUN_ID="))).toHaveLength(1);
    expect(await stagedEnvDirs(host)).toEqual([]);
  });

  it("stages a value whose name does not look secret, with no secret key list", async () => {
    // A secret bound to DATABASE_URL or GH_PAT: nothing in its name says secret.
    const env = { DATABASE_URL: SECRET_DATABASE_URL, GH_PAT: SECRET_PAT, PAPERCLIP_RUN_ID: "run-plain" };
    const script = 'printf "%s|%s|%s" "$DATABASE_URL" "$GH_PAT" "$PAPERCLIP_RUN_ID"';
    const expected = `${SECRET_DATABASE_URL}|${SECRET_PAT}|run-plain`;

    const target = await buildSshSpawnTarget({ spec: host.spec, command: "sh", args: ["-c", script], env });
    try {
      expectNoSecretInArgv([target.args], [SECRET_DATABASE_URL, SECRET_PAT]);
      expect(target.args.at(-1)).toContain("PAPERCLIP_RUN_ID=");
      expect(target.discardStagedEnv).toBeDefined();
      await target.discardStagedEnv?.();
    } finally {
      await target.cleanup();
    }

    const viaSpawn = await runChildProcess("run-staging-unnamed", "sh", ["-c", script], {
      cwd: host.root,
      env,
      timeoutSec: 30,
      graceSec: 2,
      onLog: async () => {},
      remoteExecution: host.spec,
    });
    expect(viaSpawn.exitCode).toBe(0);
    expect(viaSpawn.stdout).toBe(expected);

    expect((await runSshCommand(host.spec, script, { env })).stdout).toBe(expected);

    const runner = createSshCommandManagedRuntimeRunner({ spec: host.spec });
    const viaScript = await runner.execute({ command: "sh", args: ["-c", script], env, timeoutMs: 30_000 });
    expect(viaScript.stdout).toBe(expected);
    const viaExec = await runner.execute({
      command: "printenv",
      args: ["DATABASE_URL"],
      env: { DATABASE_URL: SECRET_DATABASE_URL, GH_PAT: SECRET_PAT },
      timeoutMs: 30_000,
    });
    expect(viaExec.stdout).toBe(`${SECRET_DATABASE_URL}\n`);

    expectNoSecretInArgv(await readSshCalls(host), [SECRET_DATABASE_URL, SECRET_PAT]);
    expect(await stagedEnvDirs(host)).toEqual([]);
  });

  it("keeps secret values off the buildSshSpawnTarget argv and removes the staged file before the command starts", async () => {
    const script = 'ls "$TMPDIR" | grep -c paperclip-env; printf "%s" "$CLAUDE_CODE_OAUTH_TOKEN"';
    const target = await buildSshSpawnTarget({
      spec: host.spec,
      command: "sh",
      args: ["-c", script],
      env: { CLAUDE_CODE_OAUTH_TOKEN: SECRET_API_KEY, PAPERCLIP_RUN_ID: "run-1" },
    });
    try {
      expectNoSecretInArgv([target.args], [SECRET_API_KEY]);
      expect(target.args.at(-1)).toContain("PAPERCLIP_RUN_ID=");
      // The staging call already ran; its file waits for the command.
      expect(await stagedEnvDirs(host)).toHaveLength(1);
      // The failure cleanup removes a file no command consumed.
      await target.discardStagedEnv?.();
      expect(await stagedEnvDirs(host)).toEqual([]);
    } finally {
      await target.cleanup();
    }

    const result = await runChildProcess("run-staging-1", "sh", ["-c", script], {
      cwd: host.root,
      env: { CLAUDE_CODE_OAUTH_TOKEN: SECRET_API_KEY, PAPERCLIP_RUN_ID: "run-1" },
      timeoutSec: 30,
      graceSec: 2,
      onLog: async () => {},
      remoteExecution: host.spec,
    });

    expect(result.exitCode).toBe(0);
    // When the command starts, the staged directory is already gone.
    expect(result.stdout).toBe(`0\n${SECRET_API_KEY}`);
    expect(await stagedEnvDirs(host)).toEqual([]);
    expectNoSecretInArgv(await readSshCalls(host), [SECRET_API_KEY]);
  });

  it("stages the file with mode 0600 inside a private directory", async () => {
    const stageResult = await new Promise<{ stdout: string; code: number | null }>((resolve, reject) => {
      const child = execFile(
        "/bin/sh",
        ["-c", SSH_ENV_STAGING_SCRIPT],
        { env: { PATH: "/usr/bin:/bin", TMPDIR: host.remoteTmp } },
        (error, stdout) => {
          if (error && typeof error.code !== "number") reject(error);
          else resolve({ stdout, code: error ? Number(error.code) : 0 });
        },
      );
      child.stdin?.end(buildSshStagedEnvFile([["API_TOKEN", "it's a 'quoted'\nmulti-line value"]]));
    });
    expect(stageResult.code).toBe(0);
    const stagedDir = parseSshStagedEnvDir(stageResult.stdout);
    expect(stagedDir).not.toBeNull();
    expect((await stat(path.join(stagedDir!, "env"))).mode & 0o777).toBe(0o600);
    expect((await stat(stagedDir!)).mode & 0o777).toBe(0o700);

    // The load steps export the value exactly and delete the directory.
    const loadScript = [...buildSshEnvLoadSteps({ stagedDir, unsetEnvKeys: [] }), 'printf "%s" "$API_TOKEN"'].join(" && ");
    const loaded = await new Promise<string>((resolve, reject) => {
      execFile("/bin/sh", ["-c", loadScript], { env: { PATH: "/usr/bin:/bin" } }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
    expect(loaded).toBe("it's a 'quoted'\nmulti-line value");
    await expect(stat(stagedDir!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lets staged secrets win over profile exports and unsets the listed keys", async () => {
    await writeFile(
      path.join(host.remoteHome, ".profile"),
      [
        "export ANTHROPIC_API_KEY=profile-api-key",
        "export HTTPS_PROXY=http://profile-proxy.invalid:3128",
        "export NODE_EXTRA_CA_CERTS=/profile/ca.pem",
        "export PROFILE_ONLY=kept",
        "",
      ].join("\n"),
      "utf8",
    );
    const script = 'printf "%s|%s|%s|%s" "$ANTHROPIC_API_KEY" "${HTTPS_PROXY-unset}" "${NODE_EXTRA_CA_CERTS-unset}" "$PROFILE_ONLY"';

    const viaCommand = await runSshCommand(host.spec, script, {
      env: { ANTHROPIC_API_KEY: SECRET_API_KEY },
      unsetEnvKeys: ["HTTPS_PROXY", "NODE_EXTRA_CA_CERTS"],
    });
    expect(viaCommand.stdout).toBe(`${SECRET_API_KEY}|unset|unset|kept`);

    const viaSpawn = await runChildProcess("run-staging-2", "sh", ["-c", script], {
      cwd: host.root,
      env: { ANTHROPIC_API_KEY: SECRET_API_KEY },
      timeoutSec: 30,
      graceSec: 2,
      onLog: async () => {},
      remoteExecution: host.spec,
      remoteEnvOptions: { unsetEnvKeys: ["HTTPS_PROXY", "NODE_EXTRA_CA_CERTS"] },
    });
    expect(viaSpawn.exitCode).toBe(0);
    expect(viaSpawn.stdout).toBe(`${SECRET_API_KEY}|unset|unset|kept`);
    expect(await stagedEnvDirs(host)).toEqual([]);
  });

  it("keeps the run's own value for a key it also asks to unset", async () => {
    await writeFile(path.join(host.remoteHome, ".profile"), "export HTTPS_PROXY=http://profile-proxy.invalid\n", "utf8");
    const result = await runSshCommand(host.spec, 'printf "%s" "$HTTPS_PROXY"', {
      env: { HTTPS_PROXY: "http://run-proxy.invalid" },
      unsetEnvKeys: ["HTTPS_PROXY"],
    });
    expect(result.stdout).toBe("http://run-proxy.invalid");
  });

  it("unsets every exported name that matches an unset glob after the profiles", async () => {
    await writeFile(
      path.join(host.remoteHome, ".profile"),
      [
        "export CLAUDE_CODE_USE_FOO=1",
        "export CLAUDE_CODE_USE_BAR=1",
        "export ANTHROPIC_X_BASE_URL=http://profile-route.invalid",
        "export Https_Proxy=http://profile-proxy.invalid:3128",
        "export ANTHROPIC_MODEL=profile-model",
        // A value line that looks like a matching name only names a variable that is not set.
        "MULTI_LINE='first",
        "CLAUDE_CODE_USE_PHANTOM=1'",
        "export MULTI_LINE",
        "",
      ].join("\n"),
      "utf8",
    );
    const script = [
      'printf "%s|%s|%s|%s|%s|%s|%s"',
      '"${CLAUDE_CODE_USE_FOO-unset}" "${CLAUDE_CODE_USE_BAR-unset}" "${ANTHROPIC_X_BASE_URL-unset}"',
      '"${Https_Proxy-unset}" "${ANTHROPIC_MODEL-unset}" "${ANTHROPIC_API_KEY-unset}" "$MULTI_LINE"',
    ].join(" ");
    const unsetEnvPatterns = ["CLAUDE_CODE_USE_*", "ANTHROPIC_*BASE_URL", "[Hh][Tt][Tt][Pp][Ss]_[Pp][Rr][Oo][Xx][Yy]"];
    // The run's own values still win over the globs.
    const env = { ANTHROPIC_API_KEY: SECRET_API_KEY, CLAUDE_CODE_USE_BAR: "run-value" };
    const expected = `unset|run-value|unset|unset|profile-model|${SECRET_API_KEY}|first\nCLAUDE_CODE_USE_PHANTOM=1`;

    const viaCommand = await runSshCommand(host.spec, script, { env, unsetEnvPatterns });
    expect(viaCommand.stdout).toBe(expected);

    const viaSpawn = await runChildProcess("run-staging-patterns", "sh", ["-c", script], {
      cwd: host.root,
      env,
      timeoutSec: 30,
      graceSec: 2,
      onLog: async () => {},
      remoteExecution: host.spec,
      remoteEnvOptions: { unsetEnvPatterns },
    });
    expect(viaSpawn.exitCode).toBe(0);
    expect(viaSpawn.stdout).toBe(expected);
    expect(await stagedEnvDirs(host)).toEqual([]);
    expectNoSecretInArgv(await readSshCalls(host), [SECRET_API_KEY]);
  });

  it.each(["*", "**", "A;true", "$(id)", "A B", "[!A]*", "A-B", "A'B"])(
    "refuses the unset glob %j before staging anything",
    async (pattern) => {
      await expect(
        buildSshSpawnTarget({ spec: host.spec, command: "true", args: [], env: { ANTHROPIC_API_KEY: SECRET_API_KEY }, unsetEnvPatterns: [pattern] }),
      ).rejects.toThrow("Invalid SSH environment name pattern");
      await expect(
        runSshCommand(host.spec, "true", { env: { ANTHROPIC_API_KEY: SECRET_API_KEY }, unsetEnvPatterns: [pattern] }),
      ).rejects.toThrow("Invalid SSH environment name pattern");
      expect(await readSshCalls(host)).toEqual([]);
      expect(() => buildSshEnvLoadSteps({ stagedDir: null, unsetEnvKeys: [], unsetEnvPatterns: [pattern] }))
        .toThrow("Invalid SSH environment name pattern");
    },
  );

  it("removes the staged file when the main ssh call is killed before the remote script runs", async () => {
    // The main call hangs before its remote script starts, like a slow
    // connection or login, and the run times out and kills it.
    vi.stubEnv("FAKE_SSH_HANG_PATTERN", "never-runs");
    const result = await runChildProcess("run-staging-killed", "sh", ["-c", "echo never-runs"], {
      cwd: host.root,
      env: { ANTHROPIC_API_KEY: SECRET_API_KEY, VISIBLE: "1" },
      timeoutSec: 1,
      graceSec: 1,
      onLog: async () => {},
      remoteExecution: host.spec,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.signal).not.toBeNull();
    // Nothing on the host consumed the file; the client-side cleanup removed it.
    expect(await stagedEnvDirs(host)).toEqual([]);
    expect(remoteCommands(await readSshCalls(host)).some((command) => command.includes("rm -rf"))).toBe(true);
  }, 20_000);

  it("produces the same scripts as before when every name is a known non-secret one and nothing is unset", async () => {
    const env = { LANG: "C.UTF-8", PAPERCLIP_RUN_ID: "run-9", PAPERCLIP_WAKE_REASON: "it's" };
    const envArgs = Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ");

    const target = await buildSshSpawnTarget({ spec: host.spec, command: "node", args: ["--version"], env });
    await target.cleanup();
    expect(target.discardStagedEnv).toBeUndefined();
    const legacySpawnScript = [
      ...LEGACY_PROFILE_STEPS,
      `cd ${shellQuote(host.spec.remoteCwd)}`,
      `exec env ${envArgs} 'node' '--version'`,
    ].join(" && ");
    expect(target.args.slice(-4)).toEqual([
      "-p",
      "22",
      "agent@fake.example.test",
      `sh -c ${shellQuote(legacySpawnScript)}`,
    ]);

    await clearSshCalls(host);
    await runSshCommand(host.spec, "true", { env });
    const legacyCommandScript = [...LEGACY_PROFILE_STEPS, `exec env ${envArgs} sh -c 'true'`].join(" && ");
    expect(remoteCommands(await readSshCalls(host))).toEqual([`sh -c ${shellQuote(legacyCommandScript)}`]);

    // No env at all keeps the plain form too.
    await clearSshCalls(host);
    await runSshCommand(host.spec, "true");
    expect(remoteCommands(await readSshCalls(host))).toEqual([
      `sh -c ${shellQuote([...LEGACY_PROFILE_STEPS, "exec sh -c 'true'"].join(" && "))}`,
    ]);
  });

  it("removes the staged file when the main ssh call fails before the remote script runs", async () => {
    // The main call carries the inline value; the staging call does not.
    vi.stubEnv("FAKE_SSH_FAIL_PATTERN", "exec env");
    const result = await runChildProcess("run-staging-3", "sh", ["-c", "true"], {
      cwd: host.root,
      env: { ANTHROPIC_API_KEY: SECRET_API_KEY, PAPERCLIP_RUN_ID: "1" },
      timeoutSec: 30,
      graceSec: 2,
      onLog: async () => {},
      remoteExecution: host.spec,
    });
    expect(result.exitCode).toBe(255);
    // The best-effort cleanup call matches no failure pattern, so it ran.
    expect(await stagedEnvDirs(host)).toEqual([]);

    await expect(
      runSshCommand(host.spec, "true", { env: { ANTHROPIC_API_KEY: SECRET_API_KEY, PAPERCLIP_RUN_ID: "1" } }),
    ).rejects.toMatchObject({ code: 255 });
    expect(await stagedEnvDirs(host)).toEqual([]);
  });

  it("reports a failed staging call like an unreachable host", async () => {
    vi.stubEnv("FAKE_SSH_FAIL_PATTERN", "mktemp");
    const logs: string[] = [];
    const result = await runChildProcess("run-staging-4", "sh", ["-c", "true"], {
      cwd: host.root,
      env: { ANTHROPIC_API_KEY: SECRET_API_KEY },
      timeoutSec: 30,
      graceSec: 2,
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
      remoteExecution: host.spec,
    });
    expect(result.exitCode).toBe(255);
    expect(result.stderr).toContain("Connection refused");
    expect(logs.join("")).toContain("Connection refused");

    await expect(
      runSshCommand(host.spec, "true", { env: { ANTHROPIC_API_KEY: SECRET_API_KEY } }),
    ).rejects.toBeInstanceOf(SshEnvStagingError);
    expectNoSecretInArgv(await readSshCalls(host), [SECRET_API_KEY]);
  });

  it("stages secret values for the SSH command runner", async () => {
    const runner = createSshCommandManagedRuntimeRunner({ spec: host.spec });
    const result = await runner.execute({
      command: "sh",
      args: ["-c", 'printf "%s|%s" "$PAPERCLIP_BRIDGE_TOKEN" "$PAPERCLIP_BRIDGE_PORT"'],
      env: { PAPERCLIP_BRIDGE_TOKEN: SECRET_BRIDGE, PAPERCLIP_BRIDGE_PORT: "4100" },
      timeoutMs: 30_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${SECRET_BRIDGE}|4100`);
    expectNoSecretInArgv(await readSshCalls(host), [SECRET_BRIDGE]);
    expect(await stagedEnvDirs(host)).toEqual([]);
  });

  it("refuses an invalid key in the unset list", async () => {
    await expect(
      buildSshSpawnTarget({ spec: host.spec, command: "true", args: [], env: {}, unsetEnvKeys: ["BAD KEY"] }),
    ).rejects.toThrow("Invalid SSH environment variable key: BAD KEY");
  });

  it("only accepts a staged directory under a temp dir with a safe path", () => {
    expect(parseSshStagedEnvDir("motd line\nPAPERCLIP_STAGED_ENV_DIR=/tmp/paperclip-env.AbC123\n")).toBe(
      "/tmp/paperclip-env.AbC123",
    );
    expect(parseSshStagedEnvDir("PAPERCLIP_STAGED_ENV_DIR=/tmp/'x/paperclip-env.AbC123\n")).toBeNull();
    expect(parseSshStagedEnvDir("PAPERCLIP_STAGED_ENV_DIR=/tmp/elsewhere\n")).toBeNull();
    expect(parseSshStagedEnvDir("nothing here\n")).toBeNull();
  });
});

describe("ssh secret staging against a local sshd", () => {
  let fixtureRoot: string | null = null;
  let fixture: SshEnvLabFixtureState | null = null;

  afterEach(async () => {
    if (fixture) await stopSshEnvLabFixture(fixture).catch(() => undefined);
    fixture = null;
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
    fixtureRoot = null;
  });

  it("delivers staged secrets through a real sshd without putting them on the argv", async () => {
    const support = await getSshEnvLabSupport();
    if (!support.supported) {
      console.warn(`Skipping the local sshd staging test: ${support.reason ?? "unsupported"}`);
      return;
    }
    fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-staging-sshd-"));
    try {
      fixture = await startSshEnvLabFixture({ statePath: path.join(fixtureRoot, "state.json") });
    } catch (error) {
      console.warn(`Skipping the local sshd staging test: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const config = await buildSshEnvLabFixtureConfig(fixture);
    const spec: SshRemoteExecutionSpec = { ...config, remoteCwd: fixture.workspaceDir };

    const viaCommand = await runSshCommand(spec, 'printf "%s" "$ANTHROPIC_API_KEY"', {
      env: { ANTHROPIC_API_KEY: SECRET_API_KEY },
    });
    expect(viaCommand.stdout).toBe(SECRET_API_KEY);

    const target = await buildSshSpawnTarget({
      spec,
      command: "sh",
      args: ["-c", 'printf "%s" "$ANTHROPIC_API_KEY"'],
      env: { ANTHROPIC_API_KEY: SECRET_API_KEY },
    });
    expectNoSecretInArgv([target.args], [SECRET_API_KEY]);
    await target.discardStagedEnv?.();
    await target.cleanup();

    const viaSpawn = await runChildProcess("run-staging-sshd", "sh", ["-c", 'printf "%s" "$ANTHROPIC_API_KEY"'], {
      cwd: fixtureRoot,
      env: { ANTHROPIC_API_KEY: SECRET_API_KEY },
      timeoutSec: 30,
      graceSec: 2,
      onLog: async () => {},
      remoteExecution: spec,
    });
    expect(viaSpawn.exitCode).toBe(0);
    expect(viaSpawn.stdout).toBe(SECRET_API_KEY);
  }, 60_000);
});
