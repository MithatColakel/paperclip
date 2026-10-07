/**
 * Shared types for the Roadmap snapshot. The worker builds these objects and
 * the UI renders them, so everything here must stay JSON-serializable.
 */

export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const OPEN_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
]);

/** Open statuses that mean work is moving (a version with one of these is active). */
export const MOVING_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "todo",
  "in_progress",
  "in_review",
  "blocked",
]);

export type TaskPriority = "critical" | "high" | "medium" | "low";

/** Board columns, left to right. Cancelled tasks are only counted. */
export const COLUMN_KEYS = ["backlog", "todo", "in_progress", "in_review", "blocked", "done"] as const;
export type ColumnKey = (typeof COLUMN_KEYS)[number];

export const COLUMN_LABELS: Record<ColumnKey, string> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  blocked: "Blocked",
  done: "Done",
};

/** Phone order: what needs attention first. Done is folded into a count. */
export const ATTENTION_ORDER: readonly ColumnKey[] = ["blocked", "in_review", "in_progress", "todo", "backlog"];

export const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

export type StatusCounts = Record<TaskStatus, number>;

export function emptyStatusCounts(): StatusCounts {
  return { backlog: 0, todo: 0, in_progress: 0, in_review: 0, blocked: 0, done: 0, cancelled: 0 };
}

// ---------------------------------------------------------------------------
// Input (a lean projection of the host Issue)
// ---------------------------------------------------------------------------

export interface TaskLabelInput {
  id?: string | null;
  name: string;
  color?: string | null;
}

export interface TaskInput {
  id: string;
  identifier: string | null;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  projectId: string | null;
  parentId: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  labels: TaskLabelInput[];
  originKind: string | null;
  originId: string | null;
  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  /** The task has a queued or running agent run. */
  live: boolean;
}

export interface AgentRef {
  id: string;
  name: string;
  status: string;
}

export interface ProjectRef {
  id: string;
  name: string;
  status: string;
  leadAgentId: string | null;
  leadAgentName: string | null;
  archived: boolean;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type LaneKind = "hotfix" | "version" | "ongoing" | "release_ops";
export type VersionState = "planned" | "active" | "done";

export interface CardLabel {
  name: string;
  color: string | null;
}

export interface RoadmapCard {
  id: string;
  identifier: string | null;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeName: string | null;
  assigneeKind: "agent" | "board" | null;
  labels: CardLabel[];
  isEpic: boolean;
  isHotfix: boolean;
  isBug: boolean;
  parentIdentifier: string | null;
  epicTitle: string | null;
  epicIdentifier: string | null;
  /** The version as the lane spells it (null for Ongoing work). */
  versionKey: string | null;
  inheritedVersion: boolean;
  live: boolean;
  updatedAt: string;
  completedAt: string | null;
  ageDays: number;
}

export interface ColumnSlice {
  key: ColumnKey;
  /** Exact number of tasks in this column (Done: finished within the done window). */
  total: number;
  /** At most the card limit; `total` stays exact. */
  cards: RoadmapCard[];
}

export interface LaneEpic {
  id: string;
  identifier: string | null;
  title: string;
  /** Stories of this epic shown in this lane. */
  total: number;
  done: number;
  cancelled: number;
}

export interface VersionProgress {
  /** Counted tasks (own `v:` label, not a copy of the parent's) that are done. */
  done: number;
  cancelled: number;
  total: number;
  /** total − cancelled */
  denominator: number;
  /** done / denominator, or null when nothing is left to count. */
  pct: number | null;
}

interface LaneBase {
  id: string;
  kind: LaneKind;
  title: string;
  /** Exact per-status counts of the tasks shown in this lane. */
  counts: StatusCounts;
  total: number;
  open: number;
  /** Done within the done window (the Done column). */
  doneRecent: number;
  columns: ColumnSlice[];
  epics: LaneEpic[];
  /** Age in days of the oldest open task, by creation date. */
  oldestOpenDays: number | null;
  unassignedOpen: number;
}

export interface VersionLane extends LaneBase {
  kind: "version";
  /**
   * The key as shown. Labels that differ only in case (`v:MVP`, `v:mvp`) are
   * one version; the lowercase spelling wins when there is one. The lane id
   * uses the lowercase key.
   */
  key: string;
  labelName: string;
  /** Label colour as stored by the host (data, not a design token). */
  color: string | null;
  state: VersionState;
  isPatch: boolean;
  progress: VersionProgress;
  /** Tasks shown here only because an ancestor carries the label. */
  inheritedCount: number;
  /** Open hotfixes of this version; they are shown in the Hotfix lane. */
  hotfixOpenElsewhere: number;
  /** Open tasks that are unassigned and in backlog. */
  parkedCount: number;
}

export interface PlainLane extends LaneBase {
  kind: "hotfix" | "ongoing" | "release_ops";
}

export type RoadmapLane = VersionLane | PlainLane;

export interface RoutineRun {
  id: string;
  identifier: string | null;
  status: TaskStatus;
  createdAt: string;
}

export interface RoutineGroup {
  routineId: string;
  title: string;
  projectId: string | null;
  lastRunAt: string;
  /** Executions within the routine window. */
  runCount: number;
  openCount: number;
  /** The last two executions were cancelled or blocked. */
  failing: boolean;
  /** Most recent first, at most five. */
  runs: RoutineRun[];
}

export interface EpicSummary {
  id: string;
  identifier: string | null;
  title: string;
  status: TaskStatus;
  total: number;
  done: number;
  cancelled: number;
  laneIds: string[];
}

export type WarningCode =
  | "label_conflict"
  | "label_case_variant"
  | "epic_with_version_label"
  | "unlabelled_child_of_version_task"
  | "hotfix_unassigned";

export interface RoadmapWarning {
  code: WarningCode;
  count: number;
  /** Up to five sample task identifiers. */
  identifiers: string[];
}

export interface ProjectRoadmap {
  projectId: string | null;
  lanes: RoadmapLane[];
  routines: RoutineGroup[];
  epics: EpicSummary[];
  warnings: RoadmapWarning[];
  totals: {
    tasks: number;
    open: number;
    routineExecutions: number;
    versions: number;
  };
}

export interface VersionSummary {
  key: string;
  state: VersionState;
  isPatch: boolean;
  progress: VersionProgress;
  open: number;
}

export interface ProjectSummary {
  project: ProjectRef;
  totals: { tasks: number; open: number };
  counts: StatusCounts;
  hotfixOpen: number;
  releaseOpsOpen: number;
  ongoingOpen: number;
  ongoingOldestDays: number | null;
  versions: VersionSummary[];
  currentVersionKey: string | null;
  epicCount: number;
  routines: { count: number; failing: number };
  warnings: number;
}

export interface RoadmapLimits {
  perStatusCap: number;
  routineCap: number;
  cardLimit: number;
  doneCardLimit: number;
  doneWindowDays: number;
  routineWindowDays: number;
}

export interface NoProjectSummary {
  open: number;
  total: number;
  /** A company-wide list these tasks come from hit the cap: the numbers are lower bounds. */
  truncated: boolean;
  /** Routines whose runs have no project (company-level routines). */
  routines: RoutineGroup[];
}

export interface RoadmapSnapshot {
  schemaVersion: 1;
  mode: "project" | "overview";
  companyId: string;
  projectId: string | null;
  generatedAt: string;
  projects: ProjectRef[];
  agents: AgentRef[];
  /** Set in project mode. */
  roadmap: ProjectRoadmap | null;
  /** Set in overview mode. */
  overview: {
    projects: ProjectSummary[];
    noProject: NoProjectSummary;
  } | null;
  limits: RoadmapLimits;
  /**
   * Statuses whose task list hit the per-status cap; their counts are lower
   * bounds. The host returns tasks by priority, then last activity, so the
   * tasks left out are the lower-priority ones, whatever their age.
   */
  truncatedStatuses: TaskStatus[];
  /**
   * Projects whose own list hit the cap. Project mode: the project itself.
   * Overview: a status whose company-wide list hit the cap is read again per
   * project, so the cap applies per project; these are the projects that
   * still hit it.
   */
  truncatedProjectIds: string[];
  /** The routine run list hit its cap (by priority, then last activity). */
  routinesTruncated: boolean;
  stats: {
    tasksScanned: number;
    routineExecutionsScanned: number;
    /** Plugin-operation tasks the host returned and the Roadmap leaves out. */
    pluginOperationsSkipped: number;
    buildMs: number;
  };
}

export type TaskVersionKind =
  | "version"
  | "hotfix"
  | "release_ops"
  | "epic"
  | "routine"
  | "ongoing"
  /** A plugin operation: not on the Roadmap. */
  | "hidden"
  | "missing";

export interface TaskVersionInfo {
  kind: TaskVersionKind;
  /** The key as spelled on the label the version comes from. */
  versionKey: string | null;
  inherited: boolean;
  inheritedFromIdentifier: string | null;
  isHotfix: boolean;
  projectId: string | null;
  /** All `v:` keys on the task itself when it carries more than one. */
  conflictKeys: string[];
}
