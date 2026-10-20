import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  streamLocalFileToSsh,
  syncDirectoryFromSsh,
  syncDirectoryToSsh,
  type SshRemoteExecutionSpec,
} from "./ssh.js";
import { GIT_ARCHIVE_EXCLUDES, PROJECT_REPOSITORIES_DIR } from "./git-workspace-sync.js";
import { prepareRemoteManagedRuntime, removeRemoteRunScratchDir } from "./remote-managed-runtime.js";
import { captureDirectorySnapshot } from "./workspace-restore-merge.js";

// A stand-in `ssh` on PATH. "local" runs the remote command on this machine,
// so the real tar and git do the transfer; "drop" reads a little of the
// upload and then dies like a dropped tunnel. "stallThenDrop" stops reading
// first, so the upload backs up before ssh gives up the way ServerAlive does;
// "hang" stops reading and stays connected; "slow" reads the whole upload in
// small, steady steps.
const FAKE_SSH = {
  local: "#!/bin/sh\nfor last; do :; done\nexec sh -c \"$last\"\n",
  drop: "#!/bin/sh\nhead -c 4096 >/dev/null\necho 'Connection to fake closed by remote host.' >&2\nexit 255\n",
  stallThenDrop: "#!/bin/sh\nhead -c 4096 >/dev/null\nsleep 1\necho 'Timeout, server fake not responding.' >&2\nexit 255\n",
  hang: "#!/bin/sh\nhead -c 4096 >/dev/null\nexec sleep 30\n",
  slow: "#!/bin/sh\nwhile [ \"$(head -c 65536 | wc -c)\" -gt 0 ]; do sleep 0.05; done\n",
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

  // With a progress sink the upload runs through a byte counter. When ssh died
  // with the pipe backed up, tar's stdout stayed paused behind that counter, so
  // tar never emitted `close` and the run waited forever on the transfer.
  it("settles a progress-reporting upload when ssh drops with the pipe backed up", async () => {
    await useFakeSsh("stallThenDrop");
    const localDir = await tempDir("paperclip-ssh-stall-drop-");
    await writeFile(path.join(localDir, "big.bin"), randomBytes(8 * 1024 * 1024));
    const lines: string[] = [];

    await expect(syncDirectoryToSsh({
      spec: spec("/remote"),
      localDir,
      remoteDir: "/remote/workspace",
      onProgress: (line) => {
        lines.push(line);
      },
      progressLabel: "workspace",
    })).rejects.toThrow("Timeout, server fake not responding.");
    expect(lines.at(-1)).toMatch(/^\[paperclip\] Syncing workspace to ssh: failed /);
  }, 15_000);

  it("settles a progress-reporting upload when the registered transfer process is killed", async () => {
    await writeFile(path.join(binDir, "ssh"), "#!/bin/sh\nexec sleep 30\n", "utf8");
    await chmod(path.join(binDir, "ssh"), 0o755);
    const localDir = await tempDir("paperclip-ssh-cancel-progress-");
    await writeFile(path.join(localDir, "big.bin"), randomBytes(8 * 1024 * 1024));
    let unregistered = 0;

    await expect(syncDirectoryToSsh({
      spec: spec("/remote"),
      localDir,
      remoteDir: "/remote/workspace",
      onProgress: () => undefined,
      registerTransferProcess: (child) => {
        setTimeout(() => child.kill("SIGTERM"), 300);
        return () => {
          unregistered += 1;
        };
      },
    })).rejects.toThrow(/ssh exited with signal SIGTERM/);
    expect(unregistered).toBe(1);
  }, 15_000);

  it("fails an upload that stops moving while ssh stays connected", async () => {
    await useFakeSsh("hang");
    const localDir = await tempDir("paperclip-ssh-hang-");
    await writeFile(path.join(localDir, "big.bin"), randomBytes(8 * 1024 * 1024));
    const lines: string[] = [];

    const startedAt = Date.now();
    await expect(syncDirectoryToSsh({
      spec: spec("/remote"),
      localDir,
      remoteDir: "/remote/workspace",
      onProgress: (line) => {
        lines.push(line);
      },
      progressLabel: "workspace",
      stallTimeoutMs: 500,
    })).rejects.toThrow("SSH transfer stalled: no data moved for 500 ms");
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(lines.at(-1)).toMatch(/^\[paperclip\] Syncing workspace to ssh: failed /);
  }, 15_000);

  it("keeps a slow upload going while its bytes keep moving", async () => {
    await useFakeSsh("slow");
    const localDir = await tempDir("paperclip-ssh-slow-");
    await writeFile(path.join(localDir, "big.bin"), randomBytes(2 * 1024 * 1024));

    const startedAt = Date.now();
    await syncDirectoryToSsh({
      spec: spec("/remote"),
      localDir,
      remoteDir: "/remote/workspace",
      onProgress: () => undefined,
      stallTimeoutMs: 400,
    });
    // The whole upload outlasts the stall timeout; only the gaps are shorter.
    expect(Date.now() - startedAt).toBeGreaterThan(400);
  }, 30_000);

  it("fails a git history upload that stops moving while ssh stays connected", async () => {
    await useFakeSsh("hang");
    const localDir = await tempDir("paperclip-ssh-bundle-hang-");
    const localFile = path.join(localDir, "workspace.bundle");
    await writeFile(localFile, randomBytes(8 * 1024 * 1024));

    await expect(streamLocalFileToSsh({
      spec: spec("/remote"),
      localFile,
      remoteScript: "cat >/dev/null",
      stallTimeoutMs: 500,
    })).rejects.toThrow("SSH transfer stalled: no data moved for 500 ms");
  }, 15_000);

  it("does not time the remote work that follows a git history upload", async () => {
    // Reads the whole bundle, then stays quiet while it "fetches and checks out".
    await writeFile(path.join(binDir, "ssh"), "#!/bin/sh\ncat >/dev/null\nsleep 1\nexit 0\n", "utf8");
    await chmod(path.join(binDir, "ssh"), 0o755);
    const localDir = await tempDir("paperclip-ssh-bundle-quiet-");
    const localFile = path.join(localDir, "workspace.bundle");
    await writeFile(localFile, randomBytes(1024 * 1024));

    await streamLocalFileToSsh({
      spec: spec("/remote"),
      localFile,
      remoteScript: "cat >/dev/null",
      stallTimeoutMs: 300,
    });
  }, 15_000);

  it("settles a progress-reporting restore when the local tar dies mid-transfer", async () => {
    await useFakeSsh("local");
    const realTar = execFileSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).trim();
    // The local extraction (`tar -xf - -C <staging>`) reads a little and fails;
    // the remote side's archive still comes from the real tar.
    await writeFile(
      path.join(binDir, "tar"),
      `#!/bin/sh\nif [ "$1" = "-xf" ]; then head -c 4096 >/dev/null; echo 'tar: fake extract failure' >&2; exit 2; fi\nexec '${realTar}' "$@"\n`,
      "utf8",
    );
    await chmod(path.join(binDir, "tar"), 0o755);
    const remoteDir = await tempDir("paperclip-ssh-restore-remote-");
    await writeFile(path.join(remoteDir, "big.bin"), randomBytes(8 * 1024 * 1024));
    const localDir = await tempDir("paperclip-ssh-restore-local-");
    await writeFile(path.join(localDir, "keep.txt"), "local\n", "utf8");

    await expect(syncDirectoryFromSsh({
      spec: spec(remoteDir),
      remoteDir,
      localDir,
      onProgress: () => undefined,
    })).rejects.toThrow();
    // A failed restore leaves the local copy alone.
    expect(await readFile(path.join(localDir, "keep.txt"), "utf8")).toBe("local\n");
    expect(await exists(path.join(localDir, "big.bin"))).toBe(false);
  }, 15_000);

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
      exclude: [...GIT_ARCHIVE_EXCLUDES, ".paperclip-runtime", ...prepared.ignoredPaths],
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

  it("keeps each project repository's git-ignored output on its own side of the transfer", async () => {
    await useFakeSsh("local");
    const localDir = await gitWorkspace();
    const repository = `${PROJECT_REPOSITORIES_DIR}/backend-abc123`;
    const repositoryDir = path.join(localDir, repository);
    await mkdir(repositoryDir, { recursive: true });
    git(repositoryDir, "init", "-q");
    git(repositoryDir, "config", "user.email", "test@example.com");
    git(repositoryDir, "config", "user.name", "Test");
    await writeFile(path.join(repositoryDir, ".gitignore"), "dist/\n", "utf8");
    await writeFile(path.join(repositoryDir, "server.ts"), "export const a = 1;\n", "utf8");
    git(repositoryDir, "add", ".");
    git(repositoryDir, "commit", "-q", "-m", "init");
    await mkdir(path.join(repositoryDir, "dist"), { recursive: true });
    await writeFile(path.join(repositoryDir, "dist", "server.js"), randomBytes(64 * 1024));
    // The anchor checkout ignores its managed project repositories.
    await writeFile(path.join(localDir, ".git", "info", "exclude"), `/${PROJECT_REPOSITORIES_DIR}/\n`, "utf8");
    const remoteRoot = await tempDir("paperclip-ssh-remote-repos-");
    const target = spec(remoteRoot);

    const prepared = await prepareWorkspaceForSshExecution({
      spec: target,
      localDir,
      remoteDir: path.join(remoteRoot, "direct"),
    });
    expect(prepared).toEqual({
      gitBacked: true,
      ignoredPaths: ["Package/.build"],
      repositories: [repository],
      repositoryIgnoredPaths: { [repository]: ["dist"] },
    });

    const runtime = await prepareRemoteManagedRuntime({
      spec: target,
      runId: "run-repos",
      adapterKey: "claude",
      workspaceLocalDir: localDir,
    });
    const remoteDir = runtime.workspaceRemoteDir;
    expect(await exists(path.join(remoteDir, repository, "server.ts"))).toBe(true);
    expect(await exists(path.join(remoteDir, repository, ".git"))).toBe(true);
    expect(await exists(path.join(remoteDir, repository, "dist"))).toBe(false);
    expect(await exists(path.join(remoteDir, "Package", ".build"))).toBe(false);

    // The agent edits the repository and builds it on the host.
    await writeFile(path.join(remoteDir, repository, "server.ts"), "export const a = 2;\n", "utf8");
    await mkdir(path.join(remoteDir, repository, "dist"), { recursive: true });
    await writeFile(path.join(remoteDir, repository, "dist", "remote.js"), "remote build\n", "utf8");

    await runtime.restoreWorkspace();

    await expect(readFile(path.join(repositoryDir, "server.ts"), "utf8")).resolves.toBe("export const a = 2;\n");
    // Local build output survives; remote build output stays remote.
    expect(await exists(path.join(repositoryDir, "dist", "server.js"))).toBe(true);
    expect(await exists(path.join(repositoryDir, "dist", "remote.js"))).toBe(false);
    expect(await exists(path.join(repositoryDir, ".git"))).toBe(true);
    expect(await exists(path.join(localDir, "Package", ".build", "cache.bin"))).toBe(true);
    // A restored run's remote copy is removed.
    expect(await exists(path.join(remoteRoot, ".paperclip-runtime", "runs", "run-repos"))).toBe(false);
  });

  it("keeps nested .git entries outside the project repositories across a git-backed restore", async () => {
    await useFakeSsh("local");
    const localDir = await gitWorkspace();
    // A submodule: its worktree carries a `.git` file that points into the
    // anchor's `.git/modules`.
    const upstreamDir = await tempDir("paperclip-ssh-submodule-upstream-");
    git(upstreamDir, "init", "-q");
    git(upstreamDir, "config", "user.email", "test@example.com");
    git(upstreamDir, "config", "user.name", "Test");
    await writeFile(path.join(upstreamDir, "lib.swift"), "let lib = 1\n", "utf8");
    git(upstreamDir, "add", ".");
    git(upstreamDir, "commit", "-q", "-m", "init");
    git(localDir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", upstreamDir, "mods/sub");
    git(localDir, "commit", "-q", "-m", "add submodule");
    // A nested clone that is neither tracked nor ignored by the anchor.
    const nestedDir = path.join(localDir, "vendor", "lib");
    await mkdir(nestedDir, { recursive: true });
    git(nestedDir, "init", "-q");
    git(nestedDir, "config", "user.email", "test@example.com");
    git(nestedDir, "config", "user.name", "Test");
    await writeFile(path.join(nestedDir, "lib.c"), "int lib;\n", "utf8");
    git(nestedDir, "add", ".");
    git(nestedDir, "commit", "-q", "-m", "local only");
    const nestedHead = git(nestedDir, "rev-parse", "HEAD").trim();
    const remoteRoot = await tempDir("paperclip-ssh-remote-nested-git-");

    const runtime = await prepareRemoteManagedRuntime({
      spec: spec(remoteRoot),
      runId: "run-nested-git",
      adapterKey: "claude",
      workspaceLocalDir: localDir,
    });
    const remoteDir = runtime.workspaceRemoteDir;
    // The upload drops `.git` at every depth.
    expect(await exists(path.join(remoteDir, "vendor", "lib", "lib.c"))).toBe(true);
    expect(await exists(path.join(remoteDir, "vendor", "lib", ".git"))).toBe(false);
    expect(await exists(path.join(remoteDir, "mods", "sub", ".git"))).toBe(false);

    await writeFile(path.join(remoteDir, "app.swift"), "let a = 2\n", "utf8");
    await runtime.restoreWorkspace();

    await expect(readFile(path.join(localDir, "app.swift"), "utf8")).resolves.toBe("let a = 2\n");
    // Missing on the host is not a remote deletion: both `.git` entries stay.
    await expect(readFile(path.join(localDir, "mods", "sub", ".git"), "utf8")).resolves.toContain("gitdir:");
    expect(git(nestedDir, "rev-parse", "HEAD").trim()).toBe(nestedHead);
    const submoduleDir = path.join(localDir, "mods", "sub");
    expect(git(submoduleDir, "rev-parse", "--show-toplevel").trim()).toBe(await realpath(submoduleDir));
  });

  it("keeps a nested clone's .git inside a project repository across a restore", async () => {
    await useFakeSsh("local");
    const localDir = await gitWorkspace();
    const repository = `${PROJECT_REPOSITORIES_DIR}/backend-abc123`;
    const repositoryDir = path.join(localDir, repository);
    await mkdir(repositoryDir, { recursive: true });
    git(repositoryDir, "init", "-q");
    git(repositoryDir, "config", "user.email", "test@example.com");
    git(repositoryDir, "config", "user.name", "Test");
    await writeFile(path.join(repositoryDir, "server.ts"), "export const a = 1;\n", "utf8");
    git(repositoryDir, "add", ".");
    git(repositoryDir, "commit", "-q", "-m", "init");
    await writeFile(path.join(localDir, ".git", "info", "exclude"), `/${PROJECT_REPOSITORIES_DIR}/\n`, "utf8");
    const nestedDir = path.join(repositoryDir, "vendor", "dep");
    await mkdir(nestedDir, { recursive: true });
    git(nestedDir, "init", "-q");
    git(nestedDir, "config", "user.email", "test@example.com");
    git(nestedDir, "config", "user.name", "Test");
    await writeFile(path.join(nestedDir, "dep.ts"), "export const dep = 1;\n", "utf8");
    git(nestedDir, "add", ".");
    git(nestedDir, "commit", "-q", "-m", "local only");
    const nestedHead = git(nestedDir, "rev-parse", "HEAD").trim();
    const remoteRoot = await tempDir("paperclip-ssh-remote-repo-nested-git-");

    const runtime = await prepareRemoteManagedRuntime({
      spec: spec(remoteRoot),
      runId: "run-repo-nested-git",
      adapterKey: "claude",
      workspaceLocalDir: localDir,
    });
    const remoteDir = runtime.workspaceRemoteDir;
    expect(await exists(path.join(remoteDir, repository, "vendor", "dep", "dep.ts"))).toBe(true);
    expect(await exists(path.join(remoteDir, repository, "vendor", "dep", ".git"))).toBe(false);

    await writeFile(path.join(remoteDir, repository, "server.ts"), "export const a = 2;\n", "utf8");
    await runtime.restoreWorkspace();

    await expect(readFile(path.join(repositoryDir, "server.ts"), "utf8")).resolves.toBe("export const a = 2;\n");
    expect(git(nestedDir, "rev-parse", "HEAD").trim()).toBe(nestedHead);
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
