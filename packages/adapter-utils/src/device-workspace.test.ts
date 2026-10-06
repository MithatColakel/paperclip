import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deviceRepoKey,
  deviceRuntimeDir,
  finishDeviceWorkspaceRun,
  isDeviceWorktreePath,
  readDeviceWorkspaceState,
  realizeDeviceWorkspace,
  removeDeviceWorktree,
} from "./device-workspace.js";
import type { SshConnectionConfig } from "./ssh.js";

// A stand-in `ssh` that runs the remote command on this machine, so the real
// git does the device side.
const FAKE_SSH = "#!/bin/sh\nfor last; do :; done\nexec sh -c \"$last\"\n";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();
}

async function exists(target: string) {
  return stat(target).then(() => true, () => false);
}

describe("SSH device workspaces", () => {
  const cleanupDirs: string[] = [];
  const originalPath = process.env.PATH;

  async function tempDir(prefix: string) {
    const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
    cleanupDirs.push(dir);
    return dir;
  }

  beforeEach(async () => {
    const binDir = await tempDir("paperclip-device-ssh-");
    await writeFile(path.join(binDir, "ssh"), FAKE_SSH, "utf8");
    await chmod(path.join(binDir, "ssh"), 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    while (cleanupDirs.length > 0) {
      await rm(cleanupDirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function fixture() {
    const base = await tempDir("paperclip-device-fixture-");
    const origin = path.join(base, "origin.git");
    const seed = path.join(base, "seed");
    const serverRepo = path.join(base, "server");
    const serverWorktree = path.join(base, "server-worktrees", "VPN-1-feature");
    const deviceRoot = path.join(base, "device");
    await mkdir(deviceRoot, { recursive: true });

    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    execFileSync("git", ["init", "-q", "-b", "main", seed]);
    await writeFile(path.join(seed, ".gitignore"), ".build/\n", "utf8");
    await writeFile(path.join(seed, "app.swift"), "let a = 1\n", "utf8");
    git(seed, "add", ".");
    git(seed, "commit", "-q", "-m", "A");
    git(seed, "remote", "add", "origin", origin);
    git(seed, "push", "-q", "origin", "main");

    execFileSync("git", ["clone", "-q", origin, serverRepo]);
    git(serverRepo, "worktree", "add", "-q", "-b", "VPN-1-feature", serverWorktree, "origin/main");
    // Work the server copy already holds from earlier copy-mode runs.
    await writeFile(path.join(serverWorktree, "feature.swift"), "let b = 2\n", "utf8");
    git(serverWorktree, "add", "feature.swift");
    git(serverWorktree, "commit", "-q", "-m", "B (never pushed)");
    await writeFile(path.join(serverWorktree, "app.swift"), "let a = 10\n", "utf8");
    await writeFile(path.join(serverWorktree, "notes.md"), "untracked\n", "utf8");
    await mkdir(path.join(serverWorktree, ".build"), { recursive: true });
    await writeFile(path.join(serverWorktree, ".build", "cache"), "big\n", "utf8");

    const spec: SshConnectionConfig = {
      host: "device",
      port: 22,
      username: "fixture",
      remoteWorkspacePath: deviceRoot,
      privateKey: null,
      knownHosts: null,
      strictHostKeyChecking: false,
    };
    return { origin, serverWorktree, deviceRoot, spec };
  }

  it("keeps the workspace on the device, pushes the branch and fast-forwards the server copy", async () => {
    const { origin, serverWorktree, deviceRoot, spec } = await fixture();
    const logs: string[] = [];

    const realized = await realizeDeviceWorkspace({
      spec,
      localDir: serverWorktree,
      repoUrl: `file://${origin}`,
      branchName: "VPN-1-feature",
      companyId: "company-1",
      workspaceKey: "ew-1",
      runId: "run-1",
      onLog: (line) => {
        logs.push(line);
      },
    });

    expect(realized.created).toBe(true);
    expect(realized.seeded).toBe(true);
    expect(realized.worktreePath).toBe(path.posix.join(deviceRoot, ".paperclip-device", "worktrees", "company-1", "ew-1"));
    expect(isDeviceWorktreePath(realized.worktreePath)).toBe(true);
    const wt = realized.worktreePath;
    expect(git(wt, "log", "-1", "--format=%s")).toBe("B (never pushed)");
    await expect(readFile(path.join(wt, "app.swift"), "utf8")).resolves.toBe("let a = 10\n");
    await expect(readFile(path.join(wt, "notes.md"), "utf8")).resolves.toBe("untracked\n");
    expect(await exists(path.join(wt, ".build"))).toBe(false);
    // The server copy's uncommitted work moved; its backup is in the stash.
    expect(git(serverWorktree, "status", "--porcelain")).toBe("");
    expect(git(serverWorktree, "stash", "list")).toContain("moved to device workspace (run run-1)");
    expect(logs.join("")).toContain("The device cloned");
    expect(logs.join("")).toContain("server commits the device did not have");

    // The agent commits on the device and builds there.
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "C");
    await mkdir(path.join(wt, ".build"), { recursive: true });
    await writeFile(path.join(wt, ".build", "obj.o"), "binary\n", "utf8");
    // Runtime files the run left in the worktree stay out of its status.
    await mkdir(path.join(wt, ".paperclip-runtime", "github"), { recursive: true });

    const state = await finishDeviceWorkspaceRun({
      spec,
      environmentId: "env-1",
      worktreePath: wt,
      localDir: serverWorktree,
      runId: "run-1",
    });

    expect(state).toMatchObject({
      environmentId: "env-1",
      branch: "VPN-1-feature",
      pushedCount: 2,
      unpushedCount: 0,
      uncommittedCount: 0,
      pushError: null,
      mirrored: "fast_forwarded",
    });
    const deviceHead = git(wt, "rev-parse", "HEAD");
    expect(execFileSync("git", ["--git-dir", origin, "rev-parse", "refs/heads/VPN-1-feature"], { encoding: "utf8" }).trim())
      .toBe(deviceHead);
    expect(git(serverWorktree, "rev-parse", "HEAD")).toBe(deviceHead);
    expect(await exists(path.join(serverWorktree, ".build", "cache"))).toBe(true);
    expect(await readDeviceWorkspaceState(serverWorktree)).toMatchObject({ head: deviceHead, unpushedCount: 0 });

    // The next run reuses the device worktree and moves no history.
    const again = await realizeDeviceWorkspace({
      spec,
      localDir: serverWorktree,
      repoUrl: `file://${origin}`,
      branchName: "VPN-1-feature",
      companyId: "company-1",
      workspaceKey: "ew-1",
      runId: "run-2",
    });
    expect(again).toMatchObject({ created: false, seeded: false, head: deviceHead });
    expect(again.messages.join(" ")).not.toContain("did not have");
    expect(await exists(path.join(wt, ".build", "obj.o"))).toBe(true);

    expect(await removeDeviceWorktree({ spec, worktreePath: wt })).toEqual({ removed: true, reason: null });
    expect(await exists(wt)).toBe(false);
  });

  it("works without origin access by sending the history once, and blocks removal of unpushed work", async () => {
    const { serverWorktree, spec } = await fixture();
    git(serverWorktree, "remote", "remove", "origin");

    const realized = await realizeDeviceWorkspace({
      spec,
      localDir: serverWorktree,
      repoUrl: null,
      branchName: "VPN-1-feature",
      companyId: "company-1",
      workspaceKey: "ew-2",
      runId: "run-1",
    });
    expect(realized.created).toBe(true);
    expect(realized.messages.join(" ")).toContain("sending the history from the server once");

    const state = await finishDeviceWorkspaceRun({
      spec,
      worktreePath: realized.worktreePath,
      localDir: serverWorktree,
      runId: "run-1",
    });
    expect(state?.unpushedCount).toBeGreaterThan(0);
    expect(state?.pushedCount).toBe(0);
    // The seeded changes are still uncommitted on the device.
    expect(await removeDeviceWorktree({ spec, worktreePath: realized.worktreePath }))
      .toEqual({ removed: false, reason: "dirty" });
    git(realized.worktreePath, "add", "-A");
    git(realized.worktreePath, "commit", "-q", "-m", "C");
    expect(await removeDeviceWorktree({ spec, worktreePath: realized.worktreePath }))
      .toEqual({ removed: false, reason: "unpushed" });
  });

  it("names device paths predictably", () => {
    expect(deviceRepoKey("https://github.com/MithatColakel/SecurezoneVPN.git", "x")).toBe("github.com__MithatColakel__SecurezoneVPN");
    expect(deviceRepoKey("git@github.com:MithatColakel/SecurezoneVPN.git", "x")).toBe("github.com__MithatColakel__SecurezoneVPN");
    expect(deviceRepoKey(null, "/srv/repo")).toMatch(/^local-[0-9a-f]{16}$/);
    expect(deviceRuntimeDir("/Users/me/PaperclipDevice", "run-1")).toBe("/Users/me/PaperclipDevice/.paperclip-device/runtime/run-1");
    expect(isDeviceWorktreePath("/Users/me/Projects/.paperclip-runtime/runs/x/workspace")).toBe(false);
  });
});
