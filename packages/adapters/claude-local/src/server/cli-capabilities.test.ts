import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

const { runAdapterExecutionTargetProcess } = vi.hoisted(() => ({
  runAdapterExecutionTargetProcess: vi.fn(),
}));

// Pass through to the real runner by default so a test can run a real
// process; the timeout tables stub single calls with mockResolvedValueOnce.
vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  runAdapterExecutionTargetProcess.mockImplementation(actual.runAdapterExecutionTargetProcess);
  return { ...actual, runAdapterExecutionTargetProcess };
});

import {
  claudeCommandSupportsEffortFlag,
  readClaudeCommandVersion,
  resetClaudeCliCapabilitiesCacheForTests,
} from "./cli-capabilities.js";

const directories: string[] = [];

afterEach(() => {
  runAdapterExecutionTargetProcess.mockClear();
  resetClaudeCliCapabilitiesCacheForTests();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function slowClaude() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "paperclip-slow-claude-"));
  directories.push(cwd);
  const command = path.join(cwd, "claude");
  writeFileSync(command, `#!${process.execPath}\nsetTimeout(() => {
  console.log(process.argv.includes("--version") ? "2.1.284 (test CLI)" : "Usage: claude --effort <level>");
}, 1500);\n`);
  chmodSync(command, 0o755);
  return { runId: "capability-probe", command, target: null, cwd, env: {}, graceSec: 1 };
}

// This fixture is a real executable. Windows does not use POSIX shebang files.
describe.skipIf(process.platform === "win32")("Claude CLI capability probe budgets", () => {
  it("allows a slow version and effort probe with an unlimited run timeout", async () => {
    const input = { ...slowClaude(), timeoutSec: 0 };
    await expect(readClaudeCommandVersion(input)).resolves.toBe("2.1.284");
    await expect(claudeCommandSupportsEffortFlag(input)).resolves.toBe(true);
  }, 30_000);

  it("retains an explicit shorter positive timeout", async () => {
    const input = { ...slowClaude(), timeoutSec: 1 };
    await expect(readClaudeCommandVersion(input)).resolves.toBeNull();
    await expect(claudeCommandSupportsEffortFlag(input)).resolves.toBeNull();
  }, 30_000);
});

// Fork: SSH runs. These cases pin the exact probe timeout the runner receives
// for each run timeoutSec, and read a CLI that answers after more than 1 s.
// One SSH round trip over a reverse tunnel can take about 1 s, so a 1 s probe
// failed the minimum Claude CLI version gate for Opus/Sonnet 5.5.
//
// SSH targets resolve an unset adapter timeoutSec to 0 ("no adapter
// wall-clock timeout"); see resolveAdapterExecutionTargetTimeout.
const sshTarget: AdapterExecutionTarget = {
  kind: "remote",
  transport: "ssh",
  remoteCwd: "/Users/agent/paperclip-workspace",
  spec: {
    host: "127.0.0.1",
    port: 2222,
    username: "agent",
    remoteCwd: "/Users/agent/paperclip-workspace",
    remoteWorkspacePath: "/Users/agent/paperclip-workspace",
    privateKey: null,
    knownHosts: null,
    strictHostKeyChecking: true,
  },
};

function probeResult(stdout: string) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout,
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  };
}

function probeInput(timeoutSec: number) {
  return {
    runId: "run-probe-timeout",
    command: "claude",
    target: sshTarget,
    cwd: "/host/workspace",
    env: {},
    timeoutSec,
    graceSec: 20,
  };
}

function probeTimeoutSec(): number {
  expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
  return runAdapterExecutionTargetProcess.mock.calls[0]![4].timeoutSec;
}

const timeoutCases: Array<[configured: number, expected: number]> = [
  [0, 20],
  [-1, 20],
  [5, 5],
  [45, 20],
  [0.5, 1],
];

describe("Claude CLI probe timeouts", () => {
  it.each(timeoutCases)("gives the --version probe for run timeoutSec %s a %s s timeout", async (configured, expected) => {
    runAdapterExecutionTargetProcess.mockResolvedValueOnce(probeResult("2.1.304 (Claude Code)\n"));

    await expect(readClaudeCommandVersion(probeInput(configured))).resolves.toBe("2.1.304");

    expect(runAdapterExecutionTargetProcess.mock.calls[0]![3]).toEqual(["--version"]);
    expect(probeTimeoutSec()).toBe(expected);
  });

  it.each(timeoutCases)("gives the --help effort probe for run timeoutSec %s a %s s timeout", async (configured, expected) => {
    runAdapterExecutionTargetProcess.mockResolvedValueOnce(probeResult("  --effort <level>\n"));

    await expect(claudeCommandSupportsEffortFlag(probeInput(configured))).resolves.toBe(true);

    expect(runAdapterExecutionTargetProcess.mock.calls[0]![3]).toEqual(["--help"]);
    expect(probeTimeoutSec()).toBe(expected);
  });

  it("reads the version from a CLI that answers after more than 1 s when the run has no timeout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-version-probe-"));
    const claudePath = path.join(root, "claude");
    await writeFile(claudePath, "#!/bin/sh\nsleep 1.5\necho '2.1.304 (Claude Code)'\n");
    await chmod(claudePath, 0o755);

    try {
      await expect(readClaudeCommandVersion({
        runId: "run-slow-version-probe",
        command: claudePath,
        target: null,
        cwd: root,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        timeoutSec: 0,
        graceSec: 1,
      })).resolves.toBe("2.1.304");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);
});
