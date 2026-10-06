import type { Db } from "@paperclipai/db";
import {
  readDeviceWorkspaceState,
  removeDeviceWorktree,
  type DeviceWorkspaceState,
} from "@paperclipai/adapter-utils/device-workspace";
import { resolveEnvironmentDriverConfigForRuntime } from "./environment-config.js";
import { environmentService } from "./environments.js";

/**
 * The device-workspace record of a server worktree. Read it before the server
 * worktree is removed: the record lives in that worktree's git dir.
 */
export async function readDeviceWorkspaceStateForCleanup(
  serverWorktreePath: string | null | undefined,
): Promise<DeviceWorkspaceState | null> {
  if (!serverWorktreePath) return null;
  return await readDeviceWorkspaceState(serverWorktreePath).catch(() => null);
}

/**
 * Removes the SSH device worktree of an archived execution workspace. The
 * device refuses while it still holds uncommitted or unpushed work; that and
 * any other failure comes back as a cleanup warning.
 */
export async function removeDeviceWorktreeForArchivedWorkspace(
  db: Db,
  companyId: string,
  state: DeviceWorkspaceState | null,
): Promise<string[]> {
  if (!state?.environmentId) return [];
  const where = `${state.username}@${state.host}:${state.worktreePath}`;
  try {
    const environment = await environmentService(db).getById(state.environmentId);
    if (!environment || environment.driver !== "ssh") return [];
    const parsed = await resolveEnvironmentDriverConfigForRuntime(db, companyId, environment);
    if (parsed.driver !== "ssh") return [];
    const result = await removeDeviceWorktree({ spec: parsed.config, worktreePath: state.worktreePath });
    if (result.removed) return [];
    const reason = result.reason === "dirty"
      ? "it has uncommitted changes"
      : result.reason === "unpushed"
        ? "it has commits that are not on origin"
        : result.reason ?? "unknown reason";
    return [`Kept the device worktree ${where} because ${reason}.`];
  } catch (error) {
    return [`Could not remove the device worktree ${where}: ${error instanceof Error ? error.message : String(error)}`];
  }
}
