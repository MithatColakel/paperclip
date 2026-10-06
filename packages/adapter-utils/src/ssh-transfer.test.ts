import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  syncDirectoryToSsh,
  type SshRemoteExecutionSpec,
} from "./ssh.js";
import { GIT_BACKED_WORKSPACE_BASELINE_EXCLUDES, removeRemoteRunScratchDir } from "./remote-managed-runtime.js";
import { captureDirectorySnapshot } from "./workspace-restore-merge.js";

// A stand-in `ssh` on PATH. "local" runs the remote command on this machine,
// so the real tar and git do the transfer; "drop" reads a little of the
// upload and then dies like a dropped tunnel.
const FAKE_SSH = {
  local: "#!/bin/sh\nfor last; do :; done\nexec sh -c \"$last\"\n",
  drop: "#!/bin/sh\nhead -c 4096 >/dev/null\necho 'Connection to fake closed by remote host.' >&2\nexit 255\n",
};

const spec = (remoteCwd: string): SshRemoteExecutionSpec => ({
  host: "fake",
  port: 22,
  username: "fixture",
  remoteWorkspacePath: remoteCwd,
  remoteCwd,
  privateKey: null,
  knownHosts: null,
  strictHostKeyChecking: false,
});

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

async function exists(target: string) {
  return stat(target).then(() => true, () => false);
}

describe("SSH workspace transfer", () => {
  const cleanupDirs: string[] = [];
  const originalPath = process.env.PATH;
  let binDir = "";

  async function useFakeSsh(kind: keyof typeof FAKE_SSH) {
    await writeFile(path.join(binDir, "ssh"), FAKE_SSH[kind], "utf8");
    await chmod(path.join(binDir, "ssh"), 0o755);
  }

  async function tempDir(prefix: string) {
    const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
    cleanupDirs.push(dir);
    return dir;
  }

  async function gitWorkspace() {
    const dir = await tempDir("paperclip-ssh-transfer-local-");
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "test@example.com");
    git(dir, "config", "user.name", "Test");
    await writeFile(path.join(dir, ".gitignore"), ".build/\n", "utf8");
    await writeFile(path.join(dir, "app.swift"), "let a = 1\n", "utf8");
    await mkdir(path.join(dir, "Package"), { recursive: true });
    await writeFile(path.join(dir, "Package", "Package.swift"), "// package\n", "utf8");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "init");
    await mkdir(path.join(dir, "Package", ".build"), { recursive: true });
    await writeFile(path.join(dir, "Package", ".build", "cache.bin"), randomBytes(256 * 1024));
    await writeFile(path.join(dir, "notes.md"), "untracked, not ignored\n", "utf8");
    return dir;
  }

  beforeEach(async () => {
    binDir = await tempDir("paperclip-fake-ssh-");
    process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    while (cleanupDirs.length > 0) {
      await rm(cleanupDirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("fails the transfer instead of crashing the process when ssh drops mid-upload", async () => {
    await useFakeSsh("drop");
    const localDir = await tempDir("paperclip-ssh-drop-");
    await writeFile(path.join(localDir, "big.bin"), randomBytes(4 * 1024 * 1024));

    await expect(syncDirectoryToSsh({
      spec: spec("/remote"),
      localDir,
      remoteDir: "/remote/workspace",
    })).rejects.toThrow("Connection to fake closed by remote host.");
  });

  it("fails the git history import when ssh drops mid-upload", async () => {
    await useFakeSsh("drop");
    const localDir = await gitWorkspace();
    await writeFile(path.join(localDir, "history.bin"), randomBytes(2 * 1024 * 1024));
    git(localDir, "add", "history.bin");
    git(localDir, "commit", "-q", "-m", "big");

    await expect(prepareWorkspaceForSshExecution({
      spec: spec("/remote"),
      localDir,
      remoteDir: "/remote/workspace",
    })).rejects.toThrow("Connection to fake closed by remote host.");
  });

  it("stops the upload when the registered transfer process is killed", async () => {
    await writeFile(
      path.join(binDir, "ssh"),
      "#!/bin/sh\nexec sleep 30\n",
      "utf8",
    );
    await chmod(path.join(binDir, "ssh"), 0o755);
    const localDir = await tempDir("paperclip-ssh-cancel-");
    await writeFile(path.join(localDir, "big.bin"), randomBytes(1024 * 1024));
    const registered: number[] = [];
    let unregistered = 0;

    const startedAt = Date.now();
    await expect(syncDirectoryToSsh({
      spec: spec("/remote"),
      localDir,
      remoteDir: "/remote/workspace",
      registerTransferProcess: (child) => {
        registered.push(child.pid ?? -1);
        setTimeout(() => child.kill("SIGTERM"), 100);
        return () => {
          unregistered += 1;
        };
      },
    })).rejects.toThrow(/ssh exited with signal SIGTERM/);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(registered).toHaveLength(1);
    expect(unregistered).toBe(1);
  });

  it("leaves git-ignored build output out of the upload and the pull-back", async () => {
    await useFakeSsh("local");
    const localDir = await gitWorkspace();
    const remoteRoot = await tempDir("paperclip-ssh-remote-");
    const remoteDir = path.join(remoteRoot, "workspace");
    const target = spec(remoteRoot);

    const prepared = await prepareWorkspaceForSshExecution({ spec: target, localDir, remoteDir });
    expect(prepared).toEqual({ gitBacked: true, ignoredPaths: ["Package/.build"] });
    expect(await exists(path.join(remoteDir, "app.swift"))).toBe(true);
    expect(await exists(path.join(remoteDir, "notes.md"))).toBe(true);
    expect(await exists(path.join(remoteDir, "Package", ".build"))).toBe(false);

    const baselineSnapshot = await captureDirectorySnapshot(localDir, {
      exclude: [...GIT_BACKED_WORKSPACE_BASELINE_EXCLUDES, ...prepared.ignoredPaths],
    });

    // The agent edits code and builds on the host.
    await writeFile(path.join(remoteDir, "app.swift"), "let a = 2\n", "utf8");
    await mkdir(path.join(remoteDir, "Other", ".build"), { recursive: true });
    await writeFile(path.join(remoteDir, "Other", ".build", "obj.o"), randomBytes(64 * 1024));

    await restoreWorkspaceFromSshExecution({
      spec: target,
      localDir,
      remoteDir,
      baselineSnapshot,
      ignoredPaths: prepared.ignoredPaths,
      restoreGitHistory: true,
    });

    await expect(readFile(path.join(localDir, "app.swift"), "utf8")).resolves.toBe("let a = 2\n");
    // Local build output survives; remote build output stays remote.
    expect(await exists(path.join(localDir, "Package", ".build", "cache.bin"))).toBe(true);
    expect(await exists(path.join(localDir, "Other", ".build"))).toBe(false);
    await expect(readFile(path.join(localDir, "notes.md"), "utf8")).resolves.toBe("untracked, not ignored\n");
  });

  it("removes a run's remote scratch directory and stops processes started from it", async () => {
    await useFakeSsh("local");
    const remoteRoot = await tempDir("paperclip-ssh-scratch-");
    const runId = "run-0123";
    const scratchDir = path.join(remoteRoot, ".paperclip-runtime", "runs", runId);
    const bridgeScript = path.join(scratchDir, "workspace", "bridge.mjs");
    await mkdir(path.dirname(bridgeScript), { recursive: true });
    await writeFile(bridgeScript, "setInterval(() => {}, 1000);\n", "utf8");
    const orphan = spawn(process.execPath, [bridgeScript], { stdio: "ignore", detached: true });
    const exited = new Promise<void>((resolve) => orphan.once("exit", () => resolve()));

    await removeRemoteRunScratchDir(spec(remoteRoot), scratchDir, runId);

    await exited;
    expect(await exists(scratchDir)).toBe(false);
    expect(await exists(path.join(remoteRoot, ".paperclip-runtime", "runs"))).toBe(true);
  });

  it("refuses to remove a directory that is not named after the run", async () => {
    await useFakeSsh("local");
    const remoteRoot = await tempDir("paperclip-ssh-scratch-guard-");
    const other = path.join(remoteRoot, "projects");
    await mkdir(other, { recursive: true });

    await removeRemoteRunScratchDir(spec(remoteRoot), other, "run-0123");

    expect(await exists(other)).toBe(true);
  });
});
