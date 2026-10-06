import path from "node:path";
import { GIT_ARCHIVE_EXCLUDES } from "./git-workspace-sync.js";
import {
  type SshRemoteExecutionSpec,
  type SshTransferProcessRegistrar,
  prepareWorkspaceForSshExecution,
  runSshCommand,
  restoreWorkspaceFromSshExecution,
  syncDirectoryToSsh,
} from "./ssh.js";
import {
  mergeExcludes,
  referencedSourceIgnoreExcludeEntries,
  type SandboxAdditionalSource,
  type SandboxManagedRuntimeAssetRestoreContext,
} from "./sandbox-managed-runtime.js";
import { captureDirectorySnapshot } from "./workspace-restore-merge.js";
import type { RuntimeProgressSink } from "./runtime-progress.js";

// The fixed heavy-directory excludes every referenced project drops,
// regardless of its ignore resolution. A `git`-resolved project additionally
// drops its own resolved ignored paths (see `referencedSourceIgnoreExcludeEntries`
// and the per-project merge below); an `other` project keeps only this set.
const REMOTE_ADDITIONAL_SOURCE_HEAVY_DIR_EXCLUDES = [
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".git",
].flatMap((entry) => [entry, `${entry}/*`, `*/${entry}`, `*/${entry}/*`]);

// A git-backed upload runs tar with `--exclude .git`, which drops `.git` at every
// depth, so nested repositories (e.g. `.paperclip-repositories/*`) reach the host
// without their `.git`. The restore baseline must skip them the same way;
// otherwise the merge reads their absence as a remote deletion and removes the
// local `.git`, leaving "already exists but is not a git checkout" workspaces.
export const GIT_BACKED_WORKSPACE_BASELINE_EXCLUDES = [
  ...GIT_ARCHIVE_EXCLUDES,
  "*/.git",
  "*/.git/*",
  ".paperclip-runtime",
];

export interface RemoteManagedRuntimeAsset {
  key: string;
  localDir: string;
  followSymlinks?: boolean;
  exclude?: string[];
  restore?: (ctx: SandboxManagedRuntimeAssetRestoreContext) => Promise<void>;
}

export interface PreparedRemoteManagedRuntime {
  spec: SshRemoteExecutionSpec;
  workspaceLocalDir: string;
  workspaceRemoteDir: string;
  runtimeRootDir: string;
  assetDirs: Record<string, string>;
  /**
   * Remote directory of each additional (referenced) project that staged
   * successfully, keyed by `projectId`. A project whose staging failed is
   * absent (per-project failure isolation).
   */
  additionalSourceDirs: Record<string, string>;
  restoreWorkspace(onProgress?: RuntimeProgressSink): Promise<void>;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

// Escapes a literal for a POSIX extended regular expression (pkill -f).
function escapeExtendedRegex(value: string): string {
  return value.replace(/[\\.^$|?*+()[\]{}]/g, "\\$&");
}

/**
 * Removes a run's scratch directory on the SSH host (its copied workspace or
 * its runtime assets) and stops any process still running from it, such as an
 * orphaned callback-bridge server. Best effort: a failure only leaves files
 * behind. The path is split across shell variables so the process match never
 * matches this cleanup command itself.
 */
export async function removeRemoteRunScratchDir(
  spec: SshRemoteExecutionSpec,
  scratchDir: string,
  runId: string,
): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId) || path.posix.basename(scratchDir) !== runId) return;
  const parentDir = path.posix.dirname(scratchDir);
  if (!path.posix.isAbsolute(parentDir) || parentDir === "/") return;
  const pattern = `[${scratchDir[0]}]${escapeExtendedRegex(scratchDir.slice(1))}/`;
  const script = [
    `parent=${shellQuote(parentDir)}`,
    `run=${shellQuote(runId)}`,
    'dir="$parent/$run"',
    '[ -d "$dir" ] || exit 0',
    `pkill -TERM -f ${shellQuote(pattern)} >/dev/null 2>&1 || true`,
    'rm -rf -- "$dir"',
  ].join("\n");
  await runSshCommand(spec, script, { timeoutMs: 120_000, maxBuffer: 64 * 1024 }).catch((error) => {
    console.warn(`[paperclip] Could not remove the run's remote scratch directory ${scratchDir}: ${String(error)}`);
  });
}

async function readRemoteFile(spec: SshRemoteExecutionSpec, remotePath: string): Promise<Buffer> {
  const result = await runSshCommand(spec, `base64 < ${shellQuote(remotePath)}`, {
    maxBuffer: 1024 * 1024,
  });
  return Buffer.from(result.stdout.replace(/\s+/g, ""), "base64");
}

export function buildRemoteExecutionSessionIdentity(spec: SshRemoteExecutionSpec | null) {
  if (!spec) return null;
  return {
    transport: "ssh",
    host: spec.host,
    port: spec.port,
    username: spec.username,
    remoteCwd: spec.remoteCwd,
  } as const;
}

export function remoteExecutionSessionMatches(saved: unknown, current: SshRemoteExecutionSpec | null): boolean {
  const currentIdentity = buildRemoteExecutionSessionIdentity(current);
  if (!currentIdentity) return false;

  const parsedSaved = asObject(saved);
  return (
    asString(parsedSaved.transport) === currentIdentity.transport &&
    asString(parsedSaved.host) === currentIdentity.host &&
    asNumber(parsedSaved.port) === currentIdentity.port &&
    asString(parsedSaved.username) === currentIdentity.username &&
    asString(parsedSaved.remoteCwd) === currentIdentity.remoteCwd
  );
}

export async function prepareRemoteManagedRuntime(input: {
  spec: SshRemoteExecutionSpec;
  runId: string;
  adapterKey: string;
  workspaceLocalDir: string;
  workspaceRemoteDir?: string;
  syncWorkspace?: boolean;
  workspaceFileMode?: "all";
  workspaceExclude?: string[];
  assets?: RemoteManagedRuntimeAsset[];
  /** Referenced (additional) projects to stage as plain, read-only trees. */
  additionalSources?: SandboxAdditionalSource[];
  // Upload progress sink. Threaded for the byte-counting transport rewrite; the
  // child task wires it into the workspace/asset transfers.
  onProgress?: RuntimeProgressSink;
  /**
   * A per-run directory for the runtime assets, outside the workspace. A device
   * workspace that stays on the host between runs must not collect copied
   * credentials and skills inside its git worktree. Removed after the restore.
   */
  runtimeRemoteDir?: string;
  /** Exposes each upload process to the run's cancellation for its duration. */
  registerTransferProcess?: SshTransferProcessRegistrar;
}): Promise<PreparedRemoteManagedRuntime> {
  const baseWorkspaceRemoteDir = input.workspaceRemoteDir ?? input.spec.remoteCwd;
  const syncWorkspace = input.syncWorkspace !== false;
  // A copied workspace lives in its own per-run directory; nothing else uses
  // it once the run's changes are back, so it is removed after the restore.
  const runScratchDir = syncWorkspace
    ? path.posix.join(baseWorkspaceRemoteDir, ".paperclip-runtime", "runs", input.runId)
    : input.runtimeRemoteDir ?? null;
  const workspaceRemoteDir = syncWorkspace
    ? path.posix.join(baseWorkspaceRemoteDir, ".paperclip-runtime", "runs", input.runId, "workspace")
    : baseWorkspaceRemoteDir;
  const runtimeRootDir = input.runtimeRemoteDir
    ? path.posix.join(input.runtimeRemoteDir, input.adapterKey)
    : path.posix.join(workspaceRemoteDir, ".paperclip-runtime", input.adapterKey);

  let preparedWorkspace: Awaited<ReturnType<typeof prepareWorkspaceForSshExecution>> | null = null;
  if (syncWorkspace) {
    try {
      preparedWorkspace = await prepareWorkspaceForSshExecution({
        spec: input.spec,
        localDir: input.workspaceLocalDir,
        remoteDir: workspaceRemoteDir,
        onProgress: input.onProgress,
        workspaceFileMode: input.workspaceFileMode,
        workspaceExclude: input.workspaceExclude,
        registerTransferProcess: input.registerTransferProcess,
      });
    } catch (error) {
      // Nothing ran there yet, so a partial upload holds no work to keep.
      if (runScratchDir) await removeRemoteRunScratchDir(input.spec, runScratchDir, input.runId);
      throw error;
    }
  }
  const ignoredPaths = preparedWorkspace?.ignoredPaths ?? [];
  const baselineSnapshot = preparedWorkspace
    ? await captureDirectorySnapshot(input.workspaceLocalDir, {
        exclude: preparedWorkspace.gitBacked
          ? [...GIT_BACKED_WORKSPACE_BASELINE_EXCLUDES, ...ignoredPaths]
          : [".paperclip-runtime", ...(input.workspaceFileMode === "all" ? input.workspaceExclude ?? [] : [])],
      })
    : null;

  const assetDirs: Record<string, string> = {};
  try {
    for (const asset of input.assets ?? []) {
      const remoteDir = path.posix.join(runtimeRootDir, asset.key);
      assetDirs[asset.key] = remoteDir;
      await syncDirectoryToSsh({
        spec: input.spec,
        localDir: asset.localDir,
        remoteDir,
        followSymlinks: asset.followSymlinks,
        exclude: asset.exclude,
        onProgress: input.onProgress,
        progressLabel: asset.key,
        registerTransferProcess: input.registerTransferProcess,
      });
    }
  } catch (error) {
    if (preparedWorkspace && baselineSnapshot) {
      await restoreWorkspaceFromSshExecution({
        spec: input.spec,
        localDir: input.workspaceLocalDir,
        remoteDir: workspaceRemoteDir,
        baselineSnapshot,
        ignoredPaths,
        restoreGitHistory: preparedWorkspace.gitBacked,
        onProgress: input.onProgress,
      });
    }
    if (runScratchDir) await removeRemoteRunScratchDir(input.spec, runScratchDir, input.runId);
    throw error;
  }

  // Stage each referenced (additional) project as a plain, read-only tree in its
  // OWN isolated remote directory (`project-<projectId>`). Additional sources
  // never get the anchor's git-history/overlay semantics. Per-project failure
  // isolation: one project's failure logs a warning and is skipped; the run and
  // the other projects continue (no workspace restore, unlike an asset failure).
  const additionalSourceDirs: Record<string, string> = {};
  for (const source of input.additionalSources ?? []) {
    const { localPath, projectId, ignoreResolution } = source;
    try {
      if (!path.posix.isAbsolute(localPath)) {
        throw new Error(`additional source localPath is not an absolute path: ${localPath}`);
      }
      if (
        projectId.length === 0 ||
        projectId.includes("/") ||
        projectId.includes("\\") ||
        projectId.includes("..")
      ) {
        throw new Error(`additional source projectId is not a simple path segment: ${projectId}`);
      }
      // Fail closed: a project whose ignore resolution failed is not staged at
      // all — the existing per-project skip-and-warn path below handles it.
      if (ignoreResolution.kind === "failed") {
        throw new Error(`referenced project ignore resolution failed: ${ignoreResolution.reason}`);
      }
      const remoteDir = path.posix.join(runtimeRootDir, `project-${projectId}`);
      const exclude = mergeExcludes(
        REMOTE_ADDITIONAL_SOURCE_HEAVY_DIR_EXCLUDES,
        referencedSourceIgnoreExcludeEntries(ignoreResolution),
      );
      await syncDirectoryToSsh({
        spec: input.spec,
        localDir: localPath,
        remoteDir,
        exclude,
        onProgress: input.onProgress,
        progressLabel: `project-${projectId}`,
      });
      additionalSourceDirs[projectId] = remoteDir;
    } catch (error) {
      console.warn(
        `[paperclip] Failed to stage referenced project ${projectId}; skipping it. ${String(error)}`,
      );
    }
  }

  return {
    spec: input.spec,
    workspaceLocalDir: input.workspaceLocalDir,
    workspaceRemoteDir,
    runtimeRootDir,
    assetDirs,
    additionalSourceDirs,
    restoreWorkspace: async (onProgress?: RuntimeProgressSink) => {
      if (preparedWorkspace && baselineSnapshot) {
        try {
          await restoreWorkspaceFromSshExecution({
            spec: input.spec,
            localDir: input.workspaceLocalDir,
            remoteDir: workspaceRemoteDir,
            baselineSnapshot,
            ignoredPaths,
            restoreGitHistory: preparedWorkspace.gitBacked,
            onProgress,
          });
        } catch (error) {
          // The remote copy may now hold the run's only copy of its work.
          if (runScratchDir) {
            console.warn(
              `[paperclip] Workspace restore failed; the run's remote copy stays at ${input.spec.username}@${input.spec.host}:${runScratchDir}.`,
            );
          }
          throw error;
        }
      }
      for (const asset of input.assets ?? []) {
        if (!asset.restore) continue;
        await asset.restore({
          assetDir: path.posix.join(runtimeRootDir, asset.key),
          readFile: (remotePath) => readRemoteFile(input.spec, remotePath),
        });
      }
      if (runScratchDir) await removeRemoteRunScratchDir(input.spec, runScratchDir, input.runId);
    },
  };
}
