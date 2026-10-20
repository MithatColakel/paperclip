import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => {
  runAdapterExecutionTargetProcess.mockClear();
  resetClaudeCliCapabilitiesCacheForTests();
});

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
