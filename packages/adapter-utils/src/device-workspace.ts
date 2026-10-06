import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sanitizeGitRemoteUrl } from "./git-workspace-sync.js";
import {
  runSshCommand,
  shellQuote,
  streamLocalFileToSsh,
  streamSshToLocalFile,
  type SshConnectionConfig,
} from "./ssh.js";

/**
 * Device mode for SSH environments.
 *
 * In copy mode the server worktree is the only real copy of an issue's work,
 * so every run uploads the history and the tree and pulls them back. On a
 * persistent device (a developer Mac) that moved gigabytes per run and threw
 * away every build cache. In device mode the device keeps its own clone and
 * one git worktree per execution workspace, which is the authoritative copy:
 *
 * - realize: the device fetches from the repository's origin itself; the
 *   server only sends commits the device does not have yet, as a small
 *   incremental bundle. The first realization seeds the device with the
 *   server copy's uncommitted changes once.
 * - run: the agent works in the device worktree (`in_place`).
 * - finish: the device pushes the issue branch with its own credentials and
 *   sends its new commits back as an incremental bundle, so the server copy
 *   fast-forwards and its git views stay current.
 *
 * Everything lives under `<remoteWorkspacePath>/.paperclip-device/`.
 */

export const DEVICE_WORKSPACE_DIR = ".paperclip-device";
/** Written into the server worktree's git dir after each device run. */
export const DEVICE_STATE_FILE = "paperclip-device-state.json";

const DISK_FAIL_KB = 3 * 1024 * 1024;
const DISK_WARN_KB = 10 * 1024 * 1024;
const PATH_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;
// Device git runs non-interactively with the device's own GitHub login. When
// the GitHub CLI is installed, it is offered as one more credential helper for
// github.com after whatever the device already configures (a keychain helper
// can be unreachable from an SSH session).
const GIT_ENV_PREAMBLE = [
  "export GIT_TERMINAL_PROMPT=0",
  'export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o BatchMode=yes}"',
  'if [ -z "${GIT_CONFIG_COUNT:-}" ] && command -v gh >/dev/null 2>&1; then export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.https://github.com.helper GIT_CONFIG_VALUE_0="!gh auth git-credential"; fi',
];

export type DeviceWorkspaceLog = (line: string) => Promise<void> | void;

export interface DeviceWorkspaceState {
  environmentId: string | null;
  host: string;
  port: number;
  username: string;
  worktreePath: string;
  branch: string | null;
  head: string | null;
  uncommittedCount: number;
  unpushedCount: number;
  pushedCount: number;
  pushError: string | null;
  mirrored: "same" | "fast_forwarded" | "not_updated" | "diverged" | "failed";
  updatedAt: string;
}

export function deviceWorkspaceRoot(remoteWorkspacePath: string): string {
  return path.posix.join(remoteWorkspacePath, DEVICE_WORKSPACE_DIR);
}

/** The per-run directory for runtime assets (skills, MCP config, Claude config). */
export function deviceRuntimeDir(remoteWorkspacePath: string, runId: string): string {
  return path.posix.join(deviceWorkspaceRoot(remoteWorkspacePath), "runtime", runId);
}

/** True for an `in_place` root that device mode created. */
export function isDeviceWorktreePath(candidate: string | null | undefined): boolean {
  return typeof candidate === "string" && candidate.includes(`/${DEVICE_WORKSPACE_DIR}/worktrees/`);
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 120) || "repo";
}

/** A stable directory name for one repository's clone on the device. */
export function deviceRepoKey(repoUrl: string | null, fallbackSeed: string): string {
  if (repoUrl) {
    const withoutScheme = repoUrl
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
      .replace(/^[^@/]+@/, "")
      .replace(/:(?!\d)/, "/")
      .replace(/\.git$/i, "")
      .replace(/\/+$/, "");
    return sanitizeSegment(withoutScheme.split("/").filter(Boolean).join("__"));
  }
  return `local-${createHash("sha256").update(fallbackSeed).digest("hex").slice(0, 16)}`;
}

// Credentials never travel in the URL; a `file://` origin (a repository the
// device can read directly) carries none to begin with.
function sanitizeDeviceRemoteUrl(url: string): string | null {
  const trimmed = url.trim();
  if (/^file:\/\/\/[^\s]*$/.test(trimmed)) return trimmed;
  return sanitizeGitRemoteUrl(trimmed);
}

function parseKeyValues(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    out[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return out;
}

async function runLocalGit(
  cwd: string,
  args: string[],
  options: { timeout?: number; maxBuffer?: number } = {},
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { timeout: options.timeout ?? 60_000, maxBuffer: options.maxBuffer ?? 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
          return;
        }
        resolve(String(stdout ?? ""));
      },
    );
  });
}

async function runLocalCommand(file: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(file, args, { cwd, timeout: 300_000, maxBuffer: 1024 * 1024, env: { ...process.env, COPYFILE_DISABLE: "1" } }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readServerCopyChanges(localDir: string): Promise<{ patch: string; untracked: string[] }> {
  const patch = await runLocalGit(localDir, ["diff", "HEAD", "--binary"], { maxBuffer: 256 * 1024 * 1024 });
  const untracked = (await runLocalGit(localDir, ["ls-files", "--others", "--exclude-standard", "-z"], {
    maxBuffer: 64 * 1024 * 1024,
  }))
    .split("\0")
    .filter((entry) => entry.length > 0 && entry !== ".paperclip-runtime" && !entry.startsWith(".paperclip-runtime/"));
  return { patch, untracked };
}

export interface RealizeDeviceWorkspaceInput {
  spec: SshConnectionConfig;
  /** The server worktree of the execution workspace. */
  localDir: string;
  repoUrl: string | null;
  branchName: string;
  companyId: string;
  /** Names the device worktree; normally the execution workspace id. */
  workspaceKey: string;
  runId: string;
  onLog?: DeviceWorkspaceLog;
}

export interface RealizedDeviceWorkspace {
  worktreePath: string;
  branch: string;
  head: string;
  created: boolean;
  seeded: boolean;
  messages: string[];
}

/**
 * Prepares the device worktree for a run and returns its path. Throws when the
 * device cannot hold the workspace (disk nearly full, history unavailable).
 */
export async function realizeDeviceWorkspace(input: RealizeDeviceWorkspaceInput): Promise<RealizedDeviceWorkspace> {
  if (!PATH_SEGMENT_RE.test(input.companyId) || !PATH_SEGMENT_RE.test(input.workspaceKey)) {
    throw new Error("Device workspace keys must be simple path segments.");
  }
  const messages: string[] = [];
  const log = async (line: string) => {
    messages.push(line);
    await input.onLog?.(`[paperclip] ${line}\n`);
  };
  const root = deviceWorkspaceRoot(input.spec.remoteWorkspacePath);
  const serverHead = (await runLocalGit(input.localDir, ["rev-parse", "HEAD"], { timeout: 10_000 })).trim();
  const commonDir = (await runLocalGit(input.localDir, ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    timeout: 10_000,
  }).catch(() => input.localDir)).trim();
  const repoUrl = input.repoUrl ? sanitizeDeviceRemoteUrl(input.repoUrl) : null;
  const originUrl = repoUrl ?? sanitizeDeviceRemoteUrl(
    (await runLocalGit(input.localDir, ["remote", "get-url", "origin"], { timeout: 10_000 }).catch(() => "")).trim(),
  );
  const repoDir = path.posix.join(root, "repos", deviceRepoKey(originUrl, commonDir));
  const worktreePath = path.posix.join(root, "worktrees", input.companyId, input.workspaceKey);

  const prepare = parseKeyValues((await runSshCommand(input.spec, [
    "set -e",
    ...GIT_ENV_PREAMBLE,
    `root=${shellQuote(root)}`,
    `repo=${shellQuote(repoDir)}`,
    `url=${shellQuote(originUrl ?? "")}`,
    `server_head=${shellQuote(serverHead)}`,
    'mkdir -p "$root/repos" "$root/worktrees" "$root/runtime"',
    'echo "disk_kb=$(df -Pk "$root" 2>/dev/null | awk \'NR==2 {print $4}\')"',
    'if ! git -C "$repo" rev-parse --git-dir >/dev/null 2>&1; then',
    '  rm -rf "$repo"',
    '  if [ -n "$url" ] && git clone --quiet --no-checkout "$url" "$repo" >/dev/null 2>"$root/clone.err"; then',
    '    echo "cloned=1"',
    "  else",
    '    echo "clone_error=$(tr \'\\n\' \' \' < "$root/clone.err" 2>/dev/null | cut -c1-300)"',
    '    rm -rf "$repo"',
    '    git init --quiet "$repo"',
    '    if [ -n "$url" ]; then git -C "$repo" remote add origin "$url"; fi',
    '    echo "cloned=0"',
    "  fi",
    "else",
    '  if [ -n "$url" ]; then git -C "$repo" remote set-url origin "$url" 2>/dev/null || git -C "$repo" remote add origin "$url" 2>/dev/null || true; fi',
    '  if git -C "$repo" fetch --quiet --prune origin >/dev/null 2>&1; then echo "fetched=1"; else echo "fetched=0"; fi',
    "fi",
    // Keep the device's own runtime files out of every worktree's status.
    'exclude_file=$(git -C "$repo" rev-parse --path-format=absolute --git-path info/exclude)',
    'mkdir -p "$(dirname "$exclude_file")"',
    'grep -qx "/.paperclip-runtime/" "$exclude_file" 2>/dev/null || printf "\\n/.paperclip-runtime/\\n" >> "$exclude_file"',
    'if git -C "$repo" cat-file -e "$server_head^{commit}" 2>/dev/null; then echo "has_server_head=1"; else echo "has_server_head=0"; fi',
  ].join("\n"), { timeoutMs: 20 * 60_000, maxBuffer: 256 * 1024 })).stdout);

  const diskKb = Number.parseInt(prepare.disk_kb ?? "", 10);
  if (Number.isFinite(diskKb) && diskKb < DISK_FAIL_KB) {
    throw new Error(`The device has only ${(diskKb / 1024 / 1024).toFixed(1)} GB free under ${root}; free disk space before running here.`);
  }
  if (Number.isFinite(diskKb) && diskKb < DISK_WARN_KB) {
    await log(`Warning: the device has only ${(diskKb / 1024 / 1024).toFixed(1)} GB free under ${root}.`);
  }
  if (prepare.cloned === "0") {
    await log(`The device could not clone ${originUrl ?? "the repository"} itself${prepare.clone_error ? ` (${prepare.clone_error})` : ""}; sending the history from the server once.`);
  } else if (prepare.cloned === "1") {
    await log(`The device cloned ${originUrl} into ${repoDir}.`);
  } else if (prepare.fetched === "0") {
    await log("Warning: the device could not fetch from origin; continuing with the commits it has.");
  }

  if (prepare.has_server_head !== "1") {
    await sendServerCommits({ spec: input.spec, localDir: input.localDir, repoDir, serverHead, log });
  }

  const worktree = parseKeyValues((await runSshCommand(input.spec, [
    "set -e",
    ...GIT_ENV_PREAMBLE,
    `repo=${shellQuote(repoDir)}`,
    `wt=${shellQuote(worktreePath)}`,
    `branch=${shellQuote(input.branchName)}`,
    `server_head=${shellQuote(serverHead)}`,
    'if [ ! -e "$wt/.git" ]; then',
    '  mkdir -p "$(dirname "$wt")"',
    '  rm -rf "$wt"',
    '  git -C "$repo" worktree prune',
    '  git -C "$repo" worktree add --quiet --force -B "$branch" "$wt" "$server_head" >/dev/null',
    '  echo "state=created"',
    "else",
    '  head=$(git -C "$wt" rev-parse HEAD)',
    '  if [ "$head" = "$server_head" ]; then echo "state=same"',
    '  elif git -C "$wt" merge-base --is-ancestor "$server_head" "$head" 2>/dev/null; then echo "state=device_ahead"',
    '  elif git -C "$wt" merge-base --is-ancestor "$head" "$server_head" 2>/dev/null; then',
    '    if [ -z "$(git -C "$wt" status --porcelain --untracked-files=no)" ] && git -C "$wt" merge --ff-only --quiet "$server_head" >/dev/null 2>&1; then echo "state=fast_forwarded"; else echo "state=behind_dirty"; fi',
    '  else echo "state=diverged"; fi',
    "fi",
    // Someone else pushed to the issue branch: follow it while the worktree is clean.
    'cur=$(git -C "$wt" rev-parse HEAD)',
    'up=$(git -C "$wt" rev-parse --verify --quiet "refs/remotes/origin/$branch" || true)',
    'if [ -n "$up" ] && [ "$up" != "$cur" ] && git -C "$wt" merge-base --is-ancestor "$cur" "$up" 2>/dev/null && [ -z "$(git -C "$wt" status --porcelain --untracked-files=no)" ]; then',
    '  if git -C "$wt" merge --ff-only --quiet "$up" >/dev/null 2>&1; then echo "origin_fast_forwarded=1"; fi',
    "fi",
    'echo "head=$(git -C "$wt" rev-parse HEAD)"',
    'echo "branch=$(git -C "$wt" rev-parse --abbrev-ref HEAD)"',
  ].join("\n"), { timeoutMs: 10 * 60_000, maxBuffer: 64 * 1024 })).stdout);

  const created = worktree.state === "created";
  switch (worktree.state) {
    case "created":
      await log(`Created the device worktree ${worktreePath} on ${input.branchName}.`);
      break;
    case "same":
    case "device_ahead":
      await log(`Reusing the device worktree ${worktreePath}.`);
      break;
    case "fast_forwarded":
      await log(`Reusing the device worktree ${worktreePath}; fast-forwarded it to the server's ${serverHead.slice(0, 12)}.`);
      break;
    case "behind_dirty":
      await log(`Warning: the device worktree has uncommitted changes and is behind the server's ${serverHead.slice(0, 12)}; leaving it as it is.`);
      break;
    case "diverged":
      await log(`Warning: the device worktree and the server copy have diverged; the device copy is kept as it is.`);
      break;
    default:
      break;
  }
  if (worktree.origin_fast_forwarded === "1") {
    await log(`Fast-forwarded the device worktree to origin/${input.branchName}.`);
  }

  const seeded = created ? await seedServerCopyChanges({ ...input, worktreePath, log }) : false;
  return {
    worktreePath,
    branch: worktree.branch || input.branchName,
    head: worktree.head || serverHead,
    created,
    seeded,
    messages,
  };
}

async function sendServerCommits(input: {
  spec: SshConnectionConfig;
  localDir: string;
  repoDir: string;
  serverHead: string;
  log: (line: string) => Promise<void>;
}): Promise<void> {
  const tempRef = `refs/paperclip/device-sync/${randomUUID()}`;
  await runLocalGit(input.localDir, ["update-ref", tempRef, input.serverHead], { timeout: 10_000 });
  try {
    await withTempDir("paperclip-device-bundle-", async (dir) => {
      const bundlePath = path.join(dir, "commits.bundle");
      const importScript = [
        "set -e",
        `repo=${shellQuote(input.repoDir)}`,
        'tmp=$(mktemp "${TMPDIR:-/tmp}/paperclip-device-bundle.XXXXXX")',
        'trap \'rm -f "$tmp"\' EXIT',
        'cat > "$tmp"',
        `git -C "$repo" fetch --quiet "$tmp" ${shellQuote(`+${tempRef}:refs/paperclip/server-head`)}`,
      ].join("\n");
      // Only what origin does not already have; the device fetched origin.
      const incremental = await runLocalGit(
        input.localDir,
        ["bundle", "create", bundlePath, tempRef, "--not", "--remotes=origin"],
        { timeout: 300_000 },
      ).then(() => true, () => false);
      if (incremental) {
        const size = (await fs.stat(bundlePath)).size;
        const sent = await streamLocalFileToSsh({ spec: input.spec, localFile: bundlePath, remoteScript: importScript })
          .then(() => true, () => false);
        if (sent) {
          await input.log(`Sent ${(size / 1024 / 1024).toFixed(1)} MB of server commits the device did not have.`);
          return;
        }
      }
      await runLocalGit(input.localDir, ["bundle", "create", bundlePath, tempRef], { timeout: 600_000 });
      const size = (await fs.stat(bundlePath)).size;
      await input.log(`Sending the full history to the device (${(size / 1024 / 1024).toFixed(1)} MB, once).`);
      await streamLocalFileToSsh({ spec: input.spec, localFile: bundlePath, remoteScript: importScript });
    });
  } finally {
    await runLocalGit(input.localDir, ["update-ref", "-d", tempRef], { timeout: 10_000 }).catch(() => undefined);
  }
}

// The first device run of a workspace that already ran in copy mode: carry the
// server copy's uncommitted work over once, then park the server copy's
// version in its stash so later fast-forwards from the device apply cleanly.
async function seedServerCopyChanges(input: RealizeDeviceWorkspaceInput & {
  worktreePath: string;
  log: (line: string) => Promise<void>;
}): Promise<boolean> {
  const changes = await readServerCopyChanges(input.localDir).catch(() => null);
  if (!changes || (changes.patch.length === 0 && changes.untracked.length === 0)) return false;
  try {
    await withTempDir("paperclip-device-seed-", async (dir) => {
      await fs.writeFile(path.join(dir, "seed.patch"), changes.patch);
      if (changes.untracked.length > 0) {
        const listPath = path.join(dir, "untracked.list");
        await fs.writeFile(listPath, `${changes.untracked.join("\0")}\0`);
        await runLocalCommand("tar", ["--null", "-T", listPath, "-cf", path.join(dir, "untracked.tar")], input.localDir);
      } else {
        await fs.writeFile(path.join(dir, "untracked.tar"), "");
      }
      await runLocalCommand("tar", ["-cf", path.join(dir, "seed.tar"), "seed.patch", "untracked.tar"], dir);
      await streamLocalFileToSsh({
        spec: input.spec,
        localFile: path.join(dir, "seed.tar"),
        remoteScript: [
          "set -e",
          `wt=${shellQuote(input.worktreePath)}`,
          'd=$(mktemp -d "${TMPDIR:-/tmp}/paperclip-device-seed.XXXXXX")',
          'trap \'rm -rf "$d"\' EXIT',
          'tar -xf - -C "$d"',
          'if [ -s "$d/seed.patch" ]; then git -C "$wt" apply --binary --whitespace=nowarn "$d/seed.patch"; fi',
          'if [ -s "$d/untracked.tar" ]; then tar -xf "$d/untracked.tar" -C "$wt"; fi',
        ].join("\n"),
      });
    });
  } catch (error) {
    await input.log(`Warning: could not copy the server copy's uncommitted changes to the device: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  const stashMessage = `paperclip: moved to device workspace (run ${input.runId})`;
  await runLocalGit(input.localDir, [
    "stash", "push", "--include-untracked", "-m", stashMessage, "--", ".", ":(exclude).paperclip-runtime",
  ], { timeout: 120_000 }).catch(() => undefined);
  await input.log(
    `Moved the server copy's uncommitted changes (${changes.untracked.length} untracked files) to the device; the server keeps a backup in its stash ("${stashMessage}").`,
  );
  return true;
}

export interface FinishDeviceWorkspaceRunInput {
  spec: SshConnectionConfig;
  environmentId?: string | null;
  worktreePath: string;
  localDir: string;
  runId: string;
  onLog?: DeviceWorkspaceLog;
}

/**
 * Ends a device run: pushes the issue branch from the device, brings new
 * commits back to the server copy and records the device's state for close
 * readiness. Never throws; a failure is logged and recorded.
 */
export async function finishDeviceWorkspaceRun(input: FinishDeviceWorkspaceRunInput): Promise<DeviceWorkspaceState | null> {
  const log = async (line: string) => {
    await input.onLog?.(`[paperclip] ${line}\n`);
  };
  if (!PATH_SEGMENT_RE.test(input.runId)) return null;
  try {
    const serverHead = (await runLocalGit(input.localDir, ["rev-parse", "HEAD"], { timeout: 10_000 })).trim();
    const report = parseKeyValues((await runSshCommand(input.spec, [
      ...GIT_ENV_PREAMBLE,
      `wt=${shellQuote(input.worktreePath)}`,
      `server_head=${shellQuote(serverHead)}`,
      'cd "$wt" || exit 0',
      'head=$(git rev-parse HEAD)',
      'branch=$(git rev-parse --abbrev-ref HEAD)',
      'echo "head=$head"',
      'echo "branch=$branch"',
      'echo "uncommitted=$(git status --porcelain | wc -l | tr -d \' \')"',
      'default=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed "s#^origin/##")',
      'unpushed=$(git rev-list --count HEAD --not --remotes=origin 2>/dev/null || echo 0)',
      'if [ "$branch" != "HEAD" ] && [ "$branch" != "$default" ] && [ "$branch" != main ] && [ "$branch" != master ] && [ "${unpushed:-0}" -gt 0 ] && git remote get-url origin >/dev/null 2>&1; then',
      '  if out=$(git push --quiet origin "HEAD:refs/heads/$branch" 2>&1); then',
      '    echo "pushed=$unpushed"',
      '    unpushed=$(git rev-list --count HEAD --not --remotes=origin 2>/dev/null || echo 0)',
      "  else",
      '    echo "push_error=$(printf "%s" "$out" | tr "\\n" " " | cut -c1-300)"',
      "  fi",
      "fi",
      'echo "unpushed=$unpushed"',
      'if [ "$head" = "$server_head" ]; then echo "mirror=same"',
      'elif git cat-file -e "$server_head^{commit}" 2>/dev/null && git merge-base --is-ancestor "$server_head" "$head"; then echo "mirror=ahead"',
      'else echo "mirror=diverged"; fi',
    ].join("\n"), { timeoutMs: 10 * 60_000, maxBuffer: 64 * 1024 })).stdout);

    const state: DeviceWorkspaceState = {
      environmentId: input.environmentId ?? null,
      host: input.spec.host,
      port: input.spec.port,
      username: input.spec.username,
      worktreePath: input.worktreePath,
      branch: report.branch && report.branch !== "HEAD" ? report.branch : null,
      head: report.head || null,
      uncommittedCount: Number.parseInt(report.uncommitted ?? "0", 10) || 0,
      unpushedCount: Number.parseInt(report.unpushed ?? "0", 10) || 0,
      pushedCount: Number.parseInt(report.pushed ?? "0", 10) || 0,
      pushError: report.push_error || null,
      mirrored: report.mirror === "same" ? "same" : report.mirror === "diverged" ? "diverged" : "not_updated",
      updatedAt: new Date().toISOString(),
    };

    if (report.mirror === "ahead" && state.head) {
      state.mirrored = await mirrorDeviceCommits({
        spec: input.spec,
        worktreePath: input.worktreePath,
        localDir: input.localDir,
        runId: input.runId,
        serverHead,
        deviceHead: state.head,
      });
    }

    const parts = [`Device workspace ${input.worktreePath}: ${state.branch ?? "detached"} at ${state.head?.slice(0, 12) ?? "?"}`];
    if (state.pushedCount > 0) parts.push(`pushed ${state.pushedCount} commit(s) to origin`);
    if (state.pushError) parts.push(`push failed (${state.pushError})`);
    if (state.unpushedCount > 0) parts.push(`${state.unpushedCount} commit(s) not on origin`);
    if (state.uncommittedCount > 0) parts.push(`${state.uncommittedCount} uncommitted change(s) stay on the device`);
    if (state.mirrored === "fast_forwarded") parts.push("server copy fast-forwarded");
    if (state.mirrored === "not_updated" || state.mirrored === "failed") parts.push("server copy not updated (it has its own local changes)");
    if (state.mirrored === "diverged") parts.push("server copy and device have diverged");
    await log(`${parts.join("; ")}.`);
    await writeDeviceState(input.localDir, state);
    return state;
  } catch (error) {
    await log(`Warning: could not finish the device workspace run: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function mirrorDeviceCommits(input: {
  spec: SshConnectionConfig;
  worktreePath: string;
  localDir: string;
  runId: string;
  serverHead: string;
  deviceHead: string;
}): Promise<DeviceWorkspaceState["mirrored"]> {
  const remoteRef = `refs/paperclip/mirror/${input.runId}`;
  const localRef = `refs/paperclip/device-mirror/${randomUUID()}`;
  try {
    return await withTempDir("paperclip-device-mirror-", async (dir) => {
      const bundlePath = path.join(dir, "mirror.bundle");
      await streamSshToLocalFile({
        spec: input.spec,
        localFile: bundlePath,
        remoteScript: [
          "set -e",
          `wt=${shellQuote(input.worktreePath)}`,
          `ref=${shellQuote(remoteRef)}`,
          'tmp=$(mktemp "${TMPDIR:-/tmp}/paperclip-device-mirror.XXXXXX")',
          'trap \'rm -f "$tmp"; git -C "$wt" update-ref -d "$ref" >/dev/null 2>&1 || true\' EXIT',
          'git -C "$wt" update-ref "$ref" HEAD',
          `git -C "$wt" bundle create "$tmp" "$ref" ${shellQuote(`^${input.serverHead}`)} >/dev/null 2>&1`,
          'cat "$tmp"',
        ].join("\n"),
      });
      await runLocalGit(input.localDir, ["fetch", "--quiet", bundlePath, `${remoteRef}:${localRef}`], { timeout: 300_000 });
      const merged = await runLocalGit(input.localDir, ["merge", "--ff-only", "--quiet", localRef], { timeout: 120_000 })
        .then(() => true, () => false);
      return merged ? "fast_forwarded" : "not_updated";
    });
  } catch {
    return "failed";
  } finally {
    await runLocalGit(input.localDir, ["update-ref", "-d", localRef], { timeout: 10_000 }).catch(() => undefined);
  }
}

async function deviceStatePath(localDir: string): Promise<string> {
  const gitDir = (await runLocalGit(localDir, ["rev-parse", "--absolute-git-dir"], { timeout: 10_000 })).trim();
  return path.join(gitDir, DEVICE_STATE_FILE);
}

async function writeDeviceState(localDir: string, state: DeviceWorkspaceState): Promise<void> {
  await fs.writeFile(await deviceStatePath(localDir), `${JSON.stringify(state, null, 2)}\n`, "utf8").catch(() => undefined);
}

/** The state the last device run recorded for this server worktree, if any. */
export async function readDeviceWorkspaceState(localDir: string): Promise<DeviceWorkspaceState | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(await deviceStatePath(localDir), "utf8")) as DeviceWorkspaceState;
    return parsed && typeof parsed.worktreePath === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Removes a device worktree when its execution workspace is archived. Refuses
 * while the device still holds uncommitted or unpushed work.
 */
export async function removeDeviceWorktree(input: {
  spec: SshConnectionConfig;
  worktreePath: string;
}): Promise<{ removed: boolean; reason: string | null }> {
  if (!isDeviceWorktreePath(input.worktreePath)) {
    return { removed: false, reason: "not a device worktree path" };
  }
  const result = parseKeyValues((await runSshCommand(input.spec, [
    `wt=${shellQuote(input.worktreePath)}`,
    '[ -e "$wt/.git" ] || { echo "state=missing"; exit 0; }',
    'if [ -n "$(git -C "$wt" status --porcelain)" ]; then echo "state=dirty"; exit 0; fi',
    'if [ "$(git -C "$wt" rev-list --count HEAD --not --remotes=origin 2>/dev/null || echo 1)" != "0" ]; then echo "state=unpushed"; exit 0; fi',
    'branch=$(git -C "$wt" rev-parse --abbrev-ref HEAD)',
    'common=$(git -C "$wt" rev-parse --path-format=absolute --git-common-dir)',
    'git -C "$wt" worktree remove --force "$wt" && echo "state=removed"',
    '[ "$branch" = "HEAD" ] || git --git-dir="$common" branch -D "$branch" >/dev/null 2>&1 || true',
  ].join("\n"), { timeoutMs: 120_000, maxBuffer: 64 * 1024 })).stdout);
  if (result.state === "removed" || result.state === "missing") return { removed: true, reason: null };
  return { removed: false, reason: result.state ?? "unknown" };
}
