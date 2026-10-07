/**
 * The version of one task, for the chip on the task page. It runs the board's
 * own classifier (`analyzeTasks`) over the task and the ancestors the board
 * can see, so the chip and the board always agree:
 *
 *   - the walk stops at a parent in another project (the board loads one
 *     project at a time) and at a plugin operation (the board leaves those out);
 *   - it is capped at MAX_ANCESTOR_DEPTH and cycle-safe, like the board's walk.
 */

import {
  LANE_ID_EPIC,
  LANE_ID_HOTFIX,
  LANE_ID_ONGOING,
  LANE_ID_RELEASE_OPS,
  LANE_ID_ROUTINES,
  MAX_ANCESTOR_DEPTH,
  analyzeTasks,
  isPluginOperationOriginKind,
} from "./classify.ts";
import type { TaskInput, TaskVersionInfo, TaskVersionKind } from "./types.ts";

function kindForLane(laneId: string): TaskVersionKind {
  switch (laneId) {
    case LANE_ID_ROUTINES:
      return "routine";
    case LANE_ID_RELEASE_OPS:
      return "release_ops";
    case LANE_ID_EPIC:
      return "epic";
    case LANE_ID_HOTFIX:
      return "hotfix";
    case LANE_ID_ONGOING:
      return "ongoing";
    default:
      return "version";
  }
}

/** The task plus the ancestors the board would see, nearest first. */
export async function loadBoardChain(
  task: TaskInput,
  getTask: (id: string) => Promise<TaskInput | null>,
): Promise<TaskInput[]> {
  const chain: TaskInput[] = [task];
  const seen = new Set<string>([task.id]);
  let parentId = task.parentId;
  while (parentId && chain.length <= MAX_ANCESTOR_DEPTH && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = await getTask(parentId);
    if (!parent || parent.projectId !== task.projectId || isPluginOperationOriginKind(parent.originKind)) break;
    chain.push(parent);
    parentId = parent.parentId;
  }
  return chain;
}

export async function resolveTaskVersion(
  task: TaskInput | null,
  getTask: (id: string) => Promise<TaskInput | null>,
): Promise<TaskVersionInfo> {
  const base: TaskVersionInfo = {
    kind: "missing",
    versionKey: null,
    inherited: false,
    inheritedFromIdentifier: null,
    isHotfix: false,
    projectId: null,
    conflictKeys: [],
  };
  if (!task) return base;
  if (isPluginOperationOriginKind(task.originKind)) return { ...base, kind: "hidden", projectId: task.projectId };

  const chain = await loadBoardChain(task, getTask);
  const fact = analyzeTasks(chain).get(task.id);
  if (!fact) return base;
  const from = fact.version?.fromId ? chain.find((entry) => entry.id === fact.version?.fromId) ?? null : null;
  return {
    kind: kindForLane(fact.laneId),
    versionKey: fact.version?.spelling ?? null,
    inherited: fact.version?.inherited ?? false,
    inheritedFromIdentifier: from?.identifier ?? null,
    isHotfix: !fact.isRoutine && fact.traits.isHotfix,
    projectId: task.projectId,
    conflictKeys: fact.conflict ? fact.traits.versionKeys : [],
  };
}
