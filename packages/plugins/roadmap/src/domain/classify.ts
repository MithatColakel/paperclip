/**
 * Places every task of a project in exactly one place on the Roadmap.
 *
 * Rules, first match wins (doc/plans/2026-10-06-epics-and-versioned-releases.md §3.3):
 *   1. `originKind = routine_execution` → Routines band (labels are ignored).
 *   2. label `release-ops`              → Release ops lane (never counted).
 *   3. label `type:epic`                → epic header, not a card. A `v:` label on
 *                                         an epic is ignored and reported.
 *   4. label `type:hotfix`, still open  → Hotfix lane (shown first). It still
 *                                         counts toward its version's progress.
 *   5. an effective version             → that version lane. A task without its own
 *                                         `v:` label inherits the version of its
 *                                         nearest labelled non-epic ancestor
 *                                         (display only, depth ≤ 8, cycle-safe).
 *   6. everything else                  → Ongoing.
 *
 * Counted toward version progress: a task that carries `v:<key>` itself, is not
 * an epic or an ops task, and whose nearest countable ancestor (skipping epics,
 * release-ops tasks and routine runs, which are never counted themselves) does
 * not carry the same label, so a copied label on a sub-task never counts twice.
 *
 * Plugin operations are not tasks of the flow (plan F34): the host's list
 * includes them whenever it is filtered by project, so the reader drops them
 * with `isPluginOperationOriginKind` before anything is classified.
 */

import { labelTraits, type LabelTraits } from "./labels.ts";
import { OPEN_STATUSES, type TaskInput } from "./types.ts";

export const MAX_ANCESTOR_DEPTH = 8;
export const ROUTINE_EXECUTION_ORIGIN = "routine_execution";

export const LANE_ID_HOTFIX = "hotfix";
export const LANE_ID_ONGOING = "ongoing";
export const LANE_ID_RELEASE_OPS = "release-ops";
export const LANE_ID_ROUTINES = "routines";
export const LANE_ID_EPIC = "epic";

/**
 * Mirrors `isPluginOperationIssueOriginKind` in packages/shared/src/constants.ts
 * plus the three legacy content-machine kinds core lists hide
 * (server/src/services/issues.ts, `nonPluginOperationIssueCondition`).
 */
const PLUGIN_OPERATION_ORIGIN = /^plugin:[^:]+:operation(?::|$)/;
export const LEGACY_PLUGIN_OPERATION_ORIGIN_KINDS: ReadonlySet<string> = new Set([
  "plugin:paperclipai.content-machine:case",
  "plugin:paperclipai.content-machine:evaluation",
  "plugin:paperclipai.content-machine:source-sync",
]);

export function isPluginOperationOriginKind(originKind: string | null | undefined): boolean {
  if (typeof originKind !== "string") return false;
  return PLUGIN_OPERATION_ORIGIN.test(originKind) || LEGACY_PLUGIN_OPERATION_ORIGIN_KINDS.has(originKind);
}

/** Lane ids use the canonical (lowercase) key, so `v:MVP` and `v:mvp` share one lane. */
export function versionLaneId(key: string): string {
  return `version:${key}`;
}

export interface EffectiveVersion {
  /** Canonical (lowercase) key. */
  key: string;
  /** The key as spelled on the label the version comes from. */
  spelling: string;
  inherited: boolean;
  /** Ancestor that carries the label when inherited. */
  fromId: string | null;
}

export interface TaskFacts {
  task: TaskInput;
  traits: LabelTraits;
  isRoutine: boolean;
  isOpen: boolean;
  version: EffectiveVersion | null;
  /** Carries two or more `v:` labels; the earliest version wins. */
  conflict: boolean;
  counted: boolean;
  epicId: string | null;
  laneId: string;
}

export function isRoutineExecution(task: Pick<TaskInput, "originKind">): boolean {
  return task.originKind === ROUTINE_EXECUTION_ORIGIN;
}

export function isOpenStatus(status: TaskInput["status"]): boolean {
  return OPEN_STATUSES.has(status);
}

/**
 * The one lane rule, shared by the board and the task chip so both always
 * place a task in the same spot. First match wins.
 */
export function laneIdFor(input: {
  isRoutine: boolean;
  traits: Pick<LabelTraits, "isEpic" | "isHotfix" | "isReleaseOps">;
  isOpen: boolean;
  version: EffectiveVersion | null;
}): string {
  if (input.isRoutine) return LANE_ID_ROUTINES;
  if (input.traits.isReleaseOps) return LANE_ID_RELEASE_OPS;
  if (input.traits.isEpic) return LANE_ID_EPIC;
  if (input.traits.isHotfix && input.isOpen) return LANE_ID_HOTFIX;
  if (input.version) return versionLaneId(input.version.key);
  return LANE_ID_ONGOING;
}

/**
 * Walks up the parent chain. `visit` returns true to stop. The walk ends at a
 * missing parent, after MAX_ANCESTOR_DEPTH steps, or on a cycle.
 */
export function walkAncestors(
  start: TaskInput,
  getTask: (id: string) => TaskInput | undefined,
  visit: (ancestor: TaskInput) => boolean,
): void {
  const seen = new Set<string>([start.id]);
  let parentId = start.parentId;
  let depth = 0;
  while (parentId && depth < MAX_ANCESTOR_DEPTH && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = getTask(parentId);
    if (!parent) return;
    if (visit(parent)) return;
    parentId = parent.parentId;
    depth += 1;
  }
}

export function analyzeTasks(tasks: readonly TaskInput[]): Map<string, TaskFacts> {
  const byId = new Map<string, TaskInput>();
  for (const task of tasks) byId.set(task.id, task);
  const getTask = (id: string) => byId.get(id);

  const traitsCache = new Map<string, LabelTraits>();
  const traitsOf = (task: TaskInput): LabelTraits => {
    let traits = traitsCache.get(task.id);
    if (!traits) {
      traits = labelTraits(task.labels);
      traitsCache.set(task.id, traits);
    }
    return traits;
  };

  const facts = new Map<string, TaskFacts>();
  for (const task of tasks) {
    const traits = traitsOf(task);
    const isRoutine = isRoutineExecution(task);
    const isOpen = isOpenStatus(task.status);

    let version: EffectiveVersion | null = null;
    if (!isRoutine && !traits.isEpic) {
      const ownKey = traits.versionKeys[0];
      if (ownKey) {
        version = { key: ownKey, spelling: traits.versionSpellings[ownKey] ?? ownKey, inherited: false, fromId: null };
      } else {
        walkAncestors(task, getTask, (ancestor) => {
          const ancestorTraits = traitsOf(ancestor);
          if (ancestorTraits.isEpic || isRoutineExecution(ancestor)) return false;
          const key = ancestorTraits.versionKeys[0];
          if (!key) return false;
          version = { key, spelling: ancestorTraits.versionSpellings[key] ?? key, inherited: true, fromId: ancestor.id };
          return true;
        });
      }
    }

    let counted = false;
    const resolvedVersion = version as EffectiveVersion | null;
    if (resolvedVersion && !resolvedVersion.inherited && !traits.isReleaseOps) {
      // Only an ancestor that can itself be counted makes this label a copy.
      let nearestCountable: TaskInput | null = null;
      walkAncestors(task, getTask, (ancestor) => {
        const ancestorTraits = traitsOf(ancestor);
        if (ancestorTraits.isEpic || ancestorTraits.isReleaseOps || isRoutineExecution(ancestor)) return false;
        nearestCountable = ancestor;
        return true;
      });
      const nearest = nearestCountable as TaskInput | null;
      counted = !(nearest && traitsOf(nearest).versionKeys.includes(resolvedVersion.key));
    }

    let epicId: string | null = null;
    if (!traits.isEpic) {
      walkAncestors(task, getTask, (ancestor) => {
        if (!traitsOf(ancestor).isEpic) return false;
        epicId = ancestor.id;
        return true;
      });
    }

    const laneId = laneIdFor({ isRoutine, traits, isOpen, version: resolvedVersion });

    facts.set(task.id, {
      task,
      traits,
      isRoutine,
      isOpen,
      version: resolvedVersion,
      conflict: !isRoutine && !traits.isEpic && traits.versionKeys.length > 1,
      counted,
      epicId,
      laneId,
    });
  }
  return facts;
}
