/**
 * Reads tasks, projects and agents through the plugin SDK and maps them to the
 * lean domain types. Read-only: nothing here writes to the host.
 */

import type { Agent, Issue, PluginContext, Project } from "@paperclipai/plugin-sdk";
import { ROUTINE_EXECUTION_ORIGIN, isPluginOperationOriginKind, isRoutineExecution } from "./domain/classify.ts";
import {
  TASK_STATUSES,
  type AgentRef,
  type ProjectRef,
  type TaskInput,
  type TaskPriority,
  type TaskStatus,
} from "./domain/types.ts";

export type HostReader = Pick<PluginContext, "issues" | "projects" | "agents">;

/**
 * Real tasks loaded per status (and, in the overview, per project when the
 * company-wide list is full). A status that hits the cap is reported as
 * truncated.
 */
export const PER_STATUS_CAP = 2000;
/** Routine executions loaded for the Routines band. */
export const ROUTINE_CAP = 1000;

const PRIORITIES: ReadonlySet<string> = new Set(["critical", "high", "medium", "low"]);
const STATUS_SET: ReadonlySet<string> = new Set(TASK_STATUSES);

function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  return null;
}

export function toTaskInput(issue: Issue): TaskInput {
  const createdAt = toIso(issue.createdAt) ?? new Date(0).toISOString();
  return {
    id: issue.id,
    identifier: issue.identifier ?? null,
    title: issue.title ?? "",
    status: (STATUS_SET.has(issue.status) ? issue.status : "backlog") as TaskStatus,
    priority: (PRIORITIES.has(issue.priority) ? issue.priority : "medium") as TaskPriority,
    projectId: issue.projectId ?? null,
    parentId: issue.parentId ?? null,
    assigneeAgentId: issue.assigneeAgentId ?? null,
    assigneeUserId: issue.assigneeUserId ?? null,
    labels: (issue.labels ?? []).map((label) => ({ id: label.id, name: label.name, color: label.color ?? null })),
    originKind: typeof issue.originKind === "string" ? issue.originKind : null,
    originId: issue.originId ?? null,
    createdAt,
    updatedAt: toIso(issue.updatedAt) ?? createdAt,
    completedAt: toIso(issue.completedAt),
    cancelledAt: toIso(issue.cancelledAt),
    live: issue.activeRun != null,
  };
}

export function toProjectRef(project: Project, agentNames: Map<string, string>): ProjectRef {
  return {
    id: project.id,
    name: project.name,
    status: project.status,
    leadAgentId: project.leadAgentId ?? null,
    leadAgentName: project.leadAgentId ? agentNames.get(project.leadAgentId) ?? null : null,
    archived: project.archivedAt != null,
  };
}

export function toAgentRef(agent: Agent): AgentRef {
  return { id: agent.id, name: agent.name, status: agent.status };
}

/** True for rows the Roadmap shows: core lists hide plugin operations (plan F34). */
export function isRoadmapVisible(issue: Pick<Issue, "originKind">): boolean {
  return !isPluginOperationOriginKind(typeof issue.originKind === "string" ? issue.originKind : null);
}

export interface LoadedRoutineExecutions {
  executions: TaskInput[];
  truncated: boolean;
}

/**
 * Routine executions for the Routines band, read first and on their own so
 * the per-status task lists can make room for them (see `loadTasks`).
 * `originKindPrefix` keeps the call within the SDK's typed filters; it
 * matches `routine_execution` exactly in practice.
 *
 * The host orders the list by priority, then by last activity, and the SDK
 * cannot ask for another order or a date bound, so when the cap is hit the
 * runs left out are those of lower-priority routines, not the oldest ones.
 */
export async function loadRoutineExecutions(
  host: HostReader,
  companyId: string,
  projectId: string | null,
  cap = ROUTINE_CAP,
): Promise<LoadedRoutineExecutions> {
  const rows = await host.issues.list({
    companyId,
    ...(projectId ? { projectId } : {}),
    originKindPrefix: ROUTINE_EXECUTION_ORIGIN,
    limit: cap + 1,
    offset: 0,
  });
  return {
    executions: rows
      .slice(0, cap)
      .filter((row) => row.originKind === ROUTINE_EXECUTION_ORIGIN)
      .map(toTaskInput),
    truncated: rows.length > cap,
  };
}

export interface LoadedTasks {
  tasks: TaskInput[];
  /** Statuses where some list hit the cap; their counts are lower bounds. */
  truncatedStatuses: TaskStatus[];
  /** Projects whose own list hit the cap. */
  truncatedProjectIds: string[];
  /** Overview: tasks without a project come from a company-wide list that hit the cap. */
  noProjectTruncated: boolean;
  /** Plugin-operation rows the host returned and the Roadmap leaves out. */
  pluginOperationsSkipped: number;
}

export interface TaskScope {
  /** One project, or null for the whole company (overview). */
  projectId: string | null;
  /** Overview: the company's projects, read one by one when a company-wide list hits the cap. */
  projectIds?: readonly string[];
}

/**
 * Loads every visible task of a project (or of the company when `projectId`
 * is null), one status at a time and sequentially, so open work is never
 * crowded out by a long done history and the host's DB pool sees one request
 * at a time.
 *
 * - Plugin operations are dropped. The host includes them whenever the list
 *   is filtered by project, so without this the project view and the overview
 *   would disagree.
 * - The default list also includes routine executions, and the SDK cannot
 *   exclude them. Each status call therefore asks for `cap` real tasks plus
 *   one row per routine execution already known in that status
 *   (`knownRoutineRuns`), so routine runs do not use up the cap.
 * - Overview: a status whose company-wide list hits the cap is read again
 *   per project, so the cap applies per project, not per company.
 *
 * Each call reads from offset 0 instead of paging: the host's `issues.list`
 * applies `offset` twice (once in SQL in `issueService.list`, once more in
 * `applyWindow` in plugin-host-services), so any page after the first comes
 * back empty. A list that comes back full is reported as truncated.
 */
export async function loadTasks(
  host: HostReader,
  companyId: string,
  scope: TaskScope,
  knownRoutineRuns: readonly TaskInput[] = [],
  cap = PER_STATUS_CAP,
): Promise<LoadedTasks> {
  const tasks: TaskInput[] = [];
  const seen = new Set<string>();
  const truncatedStatuses = new Set<TaskStatus>();
  const truncatedProjectIds = new Set<string>();
  let noProjectTruncated = false;
  let pluginOperationsSkipped = 0;

  const routineRunsIn = (status: TaskStatus, projectId: string | null) =>
    knownRoutineRuns.filter((run) => run.status === status && (projectId === null || run.projectId === projectId)).length;

  const add = (row: TaskInput) => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    tasks.push(row);
  };

  const readStatus = async (status: TaskStatus, projectId: string | null) => {
    const limit = cap + routineRunsIn(status, projectId) + 1;
    const rows = await host.issues.list({
      companyId,
      ...(projectId ? { projectId } : {}),
      status,
      limit,
      offset: 0,
    });
    const visible: TaskInput[] = [];
    let realTasks = 0;
    for (const row of rows) {
      if (!isRoadmapVisible(row)) {
        pluginOperationsSkipped += 1;
        continue;
      }
      const task = toTaskInput(row);
      if (!isRoutineExecution(task)) {
        // At most `cap` real tasks per list, so "the first N" stays exact.
        if (realTasks >= cap) continue;
        realTasks += 1;
      }
      visible.push(task);
    }
    return { rows: visible, truncated: rows.length >= limit };
  };

  for (const status of TASK_STATUSES) {
    if (scope.projectId) {
      const result = await readStatus(status, scope.projectId);
      result.rows.forEach(add);
      if (result.truncated) {
        truncatedStatuses.add(status);
        truncatedProjectIds.add(scope.projectId);
      }
      continue;
    }

    const company = await readStatus(status, null);
    if (!company.truncated) {
      company.rows.forEach(add);
      continue;
    }
    // The company-wide list hit the cap: read this status per project so one
    // big project does not hide the others. Tasks without a project only come
    // from the company-wide list, so their numbers stay lower bounds.
    noProjectTruncated = true;
    for (const projectId of scope.projectIds ?? []) {
      const result = await readStatus(status, projectId);
      result.rows.forEach(add);
      if (result.truncated) {
        truncatedStatuses.add(status);
        truncatedProjectIds.add(projectId);
      }
    }
    company.rows.forEach(add);
  }

  return {
    tasks,
    truncatedStatuses: TASK_STATUSES.filter((status) => truncatedStatuses.has(status)),
    truncatedProjectIds: [...truncatedProjectIds],
    noProjectTruncated,
    pluginOperationsSkipped,
  };
}

export async function loadAgents(host: HostReader, companyId: string): Promise<AgentRef[]> {
  const agents = await host.agents.list({ companyId });
  return agents.map(toAgentRef).sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadProjects(host: HostReader, companyId: string, agents: readonly AgentRef[]): Promise<ProjectRef[]> {
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));
  const projects = await host.projects.list({ companyId });
  return projects
    .map((project) => toProjectRef(project, agentNames))
    .sort((a, b) => a.name.localeCompare(b.name));
}
