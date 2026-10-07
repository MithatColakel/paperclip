/**
 * Builds the lanes of one project from its tasks: Hotfix → versions → Ongoing
 * → Release ops, plus the Routines band. Counts are exact; only the card lists
 * are trimmed.
 */

import {
  LANE_ID_EPIC,
  LANE_ID_HOTFIX,
  LANE_ID_ONGOING,
  LANE_ID_RELEASE_OPS,
  LANE_ID_ROUTINES,
  analyzeTasks,
  isRoutineExecution,
  versionLaneId,
  type TaskFacts,
} from "./classify.ts";
import { canonicalVersionKey, pickVersionSpelling, versionKeyFromLabel, versionLabelColor } from "./labels.ts";
import { groupRoutineExecutions, ROUTINE_WINDOW_DAYS } from "./routines.ts";
import {
  COLUMN_KEYS,
  MOVING_STATUSES,
  emptyStatusCounts,
  type AgentRef,
  type ColumnKey,
  type ColumnSlice,
  type EpicSummary,
  type LaneEpic,
  type PlainLane,
  type ProjectRoadmap,
  type ProjectSummary,
  type ProjectRef,
  type RoadmapCard,
  type RoadmapLane,
  type RoadmapWarning,
  type StatusCounts,
  type TaskInput,
  type VersionLane,
  type VersionProgress,
  type VersionState,
  type WarningCode,
} from "./types.ts";
import { compareVersionKeys, isPatchKey } from "./versions.ts";

export const DEFAULT_CARD_LIMIT = 40;
export const DEFAULT_DONE_CARD_LIMIT = 15;
export const DONE_WINDOW_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;
const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export interface BuildRoadmapOptions {
  now: number;
  agents: readonly AgentRef[];
  cardLimit?: number;
  doneCardLimit?: number;
  doneWindowDays?: number;
  routineWindowDays?: number;
}

function timeOf(value: string | null | undefined): number {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function ageDays(createdAt: string, now: number): number {
  const created = timeOf(createdAt);
  if (!created) return 0;
  return Math.max(0, Math.floor((now - created) / DAY_MS));
}

function finishedAt(task: TaskInput): number {
  return timeOf(task.completedAt) || timeOf(task.updatedAt);
}

export function versionProgress(done: number, cancelled: number, total: number): VersionProgress {
  const denominator = Math.max(0, total - cancelled);
  return {
    done,
    cancelled,
    total,
    denominator,
    pct: denominator > 0 ? Math.min(1, done / denominator) : null,
  };
}

/**
 * planned = every open task is in backlog; active = some open task is to do,
 * in progress, in review or blocked; done = nothing is open.
 */
export function deriveVersionState(statuses: readonly TaskInput["status"][]): VersionState {
  let open = 0;
  for (const status of statuses) {
    if (status === "done" || status === "cancelled") continue;
    open += 1;
    if (MOVING_STATUSES.has(status)) return "active";
  }
  return open === 0 ? "done" : "planned";
}

function compareCards(column: ColumnKey) {
  return (a: TaskFacts, b: TaskFacts): number => {
    if (a.traits.isHotfix !== b.traits.isHotfix) return a.traits.isHotfix ? -1 : 1;
    if (column === "done") {
      const byFinished = finishedAt(b.task) - finishedAt(a.task);
      if (byFinished !== 0) return byFinished;
    } else {
      const byPriority = (PRIORITY_RANK[a.task.priority] ?? 9) - (PRIORITY_RANK[b.task.priority] ?? 9);
      if (byPriority !== 0) return byPriority;
      const byUpdated = timeOf(b.task.updatedAt) - timeOf(a.task.updatedAt);
      if (byUpdated !== 0) return byUpdated;
    }
    return (a.task.identifier ?? a.task.id).localeCompare(b.task.identifier ?? b.task.id, "en", { numeric: true });
  };
}

interface BuildContext {
  now: number;
  facts: Map<string, TaskFacts>;
  /** Canonical version key → the spelling its lane shows. */
  versionDisplay: Map<string, string>;
  agentNames: Map<string, string>;
  cardLimit: number;
  doneCardLimit: number;
  doneSince: number;
}

function toCard(fact: TaskFacts, ctx: BuildContext): RoadmapCard {
  const { task, traits } = fact;
  const parent = task.parentId ? ctx.facts.get(task.parentId)?.task : undefined;
  const epic = fact.epicId ? ctx.facts.get(fact.epicId)?.task : undefined;
  let assigneeName: string | null = null;
  let assigneeKind: RoadmapCard["assigneeKind"] = null;
  if (task.assigneeAgentId) {
    assigneeKind = "agent";
    assigneeName = ctx.agentNames.get(task.assigneeAgentId) ?? "Unknown agent";
  } else if (task.assigneeUserId) {
    assigneeKind = "board";
    assigneeName = "board";
  }
  return {
    id: task.id,
    identifier: task.identifier,
    title: task.title,
    status: task.status,
    priority: task.priority,
    assigneeName,
    assigneeKind,
    labels: task.labels.map((label) => ({ name: label.name, color: label.color ?? null })),
    isEpic: traits.isEpic,
    isHotfix: traits.isHotfix,
    isBug: traits.isBug,
    parentIdentifier: parent?.identifier ?? null,
    epicTitle: epic?.title ?? null,
    epicIdentifier: epic?.identifier ?? null,
    versionKey: fact.version ? ctx.versionDisplay.get(fact.version.key) ?? fact.version.spelling : null,
    inheritedVersion: fact.version?.inherited ?? false,
    live: task.live,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
    ageDays: ageDays(task.createdAt, ctx.now),
  };
}

function buildColumns(members: readonly TaskFacts[], ctx: BuildContext): ColumnSlice[] {
  return COLUMN_KEYS.map((key) => {
    const inColumn = members.filter((fact) => {
      if (fact.task.status !== key) return false;
      return key !== "done" || finishedAt(fact.task) >= ctx.doneSince;
    });
    inColumn.sort(compareCards(key));
    const limit = key === "done" ? ctx.doneCardLimit : ctx.cardLimit;
    return { key, total: inColumn.length, cards: inColumn.slice(0, limit).map((fact) => toCard(fact, ctx)) };
  });
}

function countStatuses(members: readonly TaskFacts[]): StatusCounts {
  const counts = emptyStatusCounts();
  for (const fact of members) counts[fact.task.status] += 1;
  return counts;
}

function laneEpics(members: readonly TaskFacts[], ctx: BuildContext): LaneEpic[] {
  const byEpic = new Map<string, LaneEpic>();
  for (const fact of members) {
    // Stories are the epic's direct children; their sub-tasks are not counted again.
    if (!fact.epicId || fact.task.parentId !== fact.epicId) continue;
    const epic = ctx.facts.get(fact.epicId)?.task;
    if (!epic) continue;
    let entry = byEpic.get(epic.id);
    if (!entry) {
      entry = { id: epic.id, identifier: epic.identifier, title: epic.title, total: 0, done: 0, cancelled: 0 };
      byEpic.set(epic.id, entry);
    }
    entry.total += 1;
    if (fact.task.status === "done") entry.done += 1;
    if (fact.task.status === "cancelled") entry.cancelled += 1;
  }
  return [...byEpic.values()].sort((a, b) => a.title.localeCompare(b.title));
}

function laneBase(id: string, title: string, members: readonly TaskFacts[], ctx: BuildContext) {
  const counts = countStatuses(members);
  const openMembers = members.filter((fact) => fact.isOpen);
  const oldest = openMembers.reduce<number | null>((max, fact) => {
    const age = ageDays(fact.task.createdAt, ctx.now);
    return max === null || age > max ? age : max;
  }, null);
  const columns = buildColumns(members, ctx);
  return {
    id,
    title,
    counts,
    total: members.length,
    open: openMembers.length,
    doneRecent: columns.find((column) => column.key === "done")?.total ?? 0,
    columns,
    epics: laneEpics(members, ctx),
    oldestOpenDays: oldest,
    unassignedOpen: openMembers.filter((fact) => !fact.task.assigneeAgentId && !fact.task.assigneeUserId).length,
  };
}

function plainLane(kind: PlainLane["kind"], id: string, title: string, members: readonly TaskFacts[], ctx: BuildContext): PlainLane {
  return { kind, ...laneBase(id, title, members, ctx) };
}

function addWarning(map: Map<WarningCode, RoadmapWarning>, code: WarningCode, identifier: string | null) {
  let warning = map.get(code);
  if (!warning) {
    warning = { code, count: 0, identifiers: [] };
    map.set(code, warning);
  }
  warning.count += 1;
  if (identifier && warning.identifiers.length < 5) warning.identifiers.push(identifier);
}

export function buildProjectRoadmap(
  projectId: string | null,
  tasks: readonly TaskInput[],
  extraRoutineExecutions: readonly TaskInput[],
  options: BuildRoadmapOptions,
): ProjectRoadmap {
  const now = options.now;
  const facts = analyzeTasks(tasks);
  const versionDisplay = new Map<string, string>();
  const ctx: BuildContext = {
    now,
    facts,
    versionDisplay,
    agentNames: new Map(options.agents.map((agent) => [agent.id, agent.name])),
    cardLimit: options.cardLimit ?? DEFAULT_CARD_LIMIT,
    doneCardLimit: options.doneCardLimit ?? DEFAULT_DONE_CARD_LIMIT,
    doneSince: now - (options.doneWindowDays ?? DONE_WINDOW_DAYS) * DAY_MS,
  };

  const buckets = new Map<string, TaskFacts[]>();
  const versionMembers = new Map<string, TaskFacts[]>();
  const versionColors = new Map<string, string | null>();
  const versionSpellings = new Map<string, Set<string>>();
  const warnings = new Map<WarningCode, RoadmapWarning>();
  const routineExecutions: TaskInput[] = [];

  for (const fact of facts.values()) {
    const list = buckets.get(fact.laneId) ?? [];
    list.push(fact);
    buckets.set(fact.laneId, list);

    if (fact.isRoutine) {
      routineExecutions.push(fact.task);
      continue;
    }
    const { task, traits } = fact;
    for (const key of traits.versionKeys) {
      if (!versionColors.has(key) || versionColors.get(key) === null) {
        versionColors.set(key, versionLabelColor(task.labels, key));
      }
      const spelling = traits.versionSpellings[key];
      if (spelling !== undefined) {
        const set = versionSpellings.get(key) ?? new Set<string>();
        set.add(spelling);
        versionSpellings.set(key, set);
      }
    }
    if (traits.isEpic && traits.versionKeys.length > 0) addWarning(warnings, "epic_with_version_label", task.identifier);
    if (fact.conflict) addWarning(warnings, "label_conflict", task.identifier);
    if (fact.version?.inherited && !traits.isReleaseOps) {
      addWarning(warnings, "unlabelled_child_of_version_task", task.identifier);
    }
    if (traits.isHotfix && fact.isOpen && !traits.isEpic && !task.assigneeAgentId && !task.assigneeUserId) {
      addWarning(warnings, "hotfix_unassigned", task.identifier);
    }
    if (fact.version && !traits.isReleaseOps && !traits.isEpic) {
      const members = versionMembers.get(fact.version.key) ?? [];
      members.push(fact);
      versionMembers.set(fact.version.key, members);
    }
  }
  for (const execution of extraRoutineExecutions) {
    if (isRoutineExecution(execution) && !facts.has(execution.id)) routineExecutions.push(execution);
  }

  // Labels that differ only in case are one version, shown with one spelling.
  for (const [key, spellings] of versionSpellings) {
    versionDisplay.set(key, pickVersionSpelling(spellings) ?? key);
  }
  for (const fact of facts.values()) {
    if (fact.isRoutine) continue;
    const variant = fact.task.labels.some((label) => {
      const key = versionKeyFromLabel(label.name);
      if (key === null) return false;
      const display = versionDisplay.get(canonicalVersionKey(key));
      return display !== undefined && display !== key;
    });
    if (variant) addWarning(warnings, "label_case_variant", fact.task.identifier);
  }

  const lanes: RoadmapLane[] = [];
  const hotfixMembers = buckets.get(LANE_ID_HOTFIX) ?? [];
  if (hotfixMembers.length > 0) lanes.push(plainLane("hotfix", LANE_ID_HOTFIX, "Hotfix", hotfixMembers, ctx));

  const versionKeys = [...versionMembers.keys()].sort(compareVersionKeys);
  for (const key of versionKeys) {
    const members = versionMembers.get(key) ?? [];
    const laneId = versionLaneId(key);
    const shown = buckets.get(laneId) ?? [];
    const counted = members.filter((fact) => fact.counted);
    const progress = versionProgress(
      counted.filter((fact) => fact.task.status === "done").length,
      counted.filter((fact) => fact.task.status === "cancelled").length,
      counted.length,
    );
    const display = versionDisplay.get(key) ?? key;
    const lane: VersionLane = {
      kind: "version",
      ...laneBase(laneId, `Version ${display}`, shown, ctx),
      key: display,
      labelName: `v:${display}`,
      color: versionColors.get(key) ?? null,
      state: deriveVersionState(members.map((fact) => fact.task.status)),
      isPatch: isPatchKey(key),
      progress,
      inheritedCount: shown.filter((fact) => fact.version?.inherited).length,
      hotfixOpenElsewhere: members.filter((fact) => fact.laneId === LANE_ID_HOTFIX).length,
      parkedCount: members.filter(
        (fact) => fact.isOpen && fact.task.status === "backlog" && !fact.task.assigneeAgentId && !fact.task.assigneeUserId,
      ).length,
    };
    lanes.push(lane);
  }

  lanes.push(plainLane("ongoing", LANE_ID_ONGOING, "Ongoing", buckets.get(LANE_ID_ONGOING) ?? [], ctx));
  const opsMembers = buckets.get(LANE_ID_RELEASE_OPS) ?? [];
  if (opsMembers.length > 0) lanes.push(plainLane("release_ops", LANE_ID_RELEASE_OPS, "Release ops", opsMembers, ctx));

  const storiesByEpic = new Map<string, TaskFacts[]>();
  for (const fact of facts.values()) {
    if (!fact.epicId || fact.task.parentId !== fact.epicId || fact.isRoutine || fact.laneId === LANE_ID_EPIC) continue;
    const list = storiesByEpic.get(fact.epicId) ?? [];
    list.push(fact);
    storiesByEpic.set(fact.epicId, list);
  }
  const epics: EpicSummary[] = [];
  for (const fact of buckets.get(LANE_ID_EPIC) ?? []) {
    const stories = storiesByEpic.get(fact.task.id) ?? [];
    const laneIds = [...new Set(stories.map((story) => story.laneId))];
    epics.push({
      id: fact.task.id,
      identifier: fact.task.identifier,
      title: fact.task.title,
      status: fact.task.status,
      total: stories.length,
      done: stories.filter((story) => story.task.status === "done").length,
      cancelled: stories.filter((story) => story.task.status === "cancelled").length,
      laneIds,
    });
  }
  epics.sort((a, b) => a.title.localeCompare(b.title));

  const routines = groupRoutineExecutions(routineExecutions, {
    now,
    windowDays: options.routineWindowDays ?? ROUTINE_WINDOW_DAYS,
  });

  const nonRoutine = [...facts.values()].filter((fact) => !fact.isRoutine);
  return {
    projectId,
    lanes,
    routines,
    epics,
    warnings: [...warnings.values()],
    totals: {
      tasks: nonRoutine.length,
      open: nonRoutine.filter((fact) => fact.isOpen && fact.laneId !== LANE_ID_EPIC).length,
      routineExecutions: new Set(routineExecutions.map((execution) => execution.id)).size,
      versions: versionKeys.length,
    },
  };
}

/** The version the board most likely cares about now: the first active one, else the first planned one. */
export function currentVersionKey(lanes: readonly RoadmapLane[]): string | null {
  const versions = lanes.filter((lane): lane is VersionLane => lane.kind === "version");
  return (versions.find((lane) => lane.state === "active") ?? versions.find((lane) => lane.state === "planned"))?.key ?? null;
}

export function summarizeProject(project: ProjectRef, roadmap: ProjectRoadmap): ProjectSummary {
  const counts = emptyStatusCounts();
  for (const lane of roadmap.lanes) {
    for (const status of Object.keys(counts) as Array<keyof StatusCounts>) counts[status] += lane.counts[status];
  }
  const ongoing = roadmap.lanes.find((lane) => lane.kind === "ongoing");
  const versions = roadmap.lanes.filter((lane): lane is VersionLane => lane.kind === "version");
  const versionOpen = (lane: VersionLane) => lane.open + lane.hotfixOpenElsewhere;
  return {
    project,
    totals: { tasks: roadmap.totals.tasks, open: roadmap.totals.open },
    counts,
    hotfixOpen: roadmap.lanes.find((lane) => lane.kind === "hotfix")?.open ?? 0,
    releaseOpsOpen: roadmap.lanes.find((lane) => lane.kind === "release_ops")?.open ?? 0,
    ongoingOpen: ongoing?.open ?? 0,
    ongoingOldestDays: ongoing?.oldestOpenDays ?? null,
    versions: versions.map((lane) => ({
      key: lane.key,
      state: lane.state,
      isPatch: lane.isPatch,
      progress: lane.progress,
      open: versionOpen(lane),
    })),
    currentVersionKey: currentVersionKey(roadmap.lanes),
    epicCount: roadmap.epics.length,
    routines: {
      count: roadmap.routines.length,
      failing: roadmap.routines.filter((routine) => routine.failing).length,
    },
    warnings: roadmap.warnings.reduce((sum, warning) => sum + warning.count, 0),
  };
}

export { LANE_ID_EPIC, LANE_ID_HOTFIX, LANE_ID_ONGOING, LANE_ID_RELEASE_OPS, LANE_ID_ROUTINES };
