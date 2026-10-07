/**
 * `roadmap.snapshot`: one read-only payload per (company, project) that feeds
 * the Roadmap page and the project tab. Built from about ten sequential host
 * reads (plus one per project for a status whose company-wide list is full in
 * the overview) and cached for a short time with single-flight, so many open
 * pages cost one build.
 */

import {
  DEFAULT_CARD_LIMIT,
  DEFAULT_DONE_CARD_LIMIT,
  DONE_WINDOW_DAYS,
  buildProjectRoadmap,
  summarizeProject,
} from "./domain/lanes.ts";
import { ROUTINE_WINDOW_DAYS, groupRoutineExecutions } from "./domain/routines.ts";
import { isRoutineExecution } from "./domain/classify.ts";
import type { ProjectRef, ProjectSummary, RoadmapSnapshot, TaskInput, TaskVersionInfo } from "./domain/types.ts";
import { resolveTaskVersion } from "./domain/task-version.ts";
import {
  PER_STATUS_CAP,
  ROUTINE_CAP,
  loadAgents,
  loadProjects,
  loadRoutineExecutions,
  loadTasks,
  toTaskInput,
  type HostReader,
} from "./host-data.ts";

export const SNAPSHOT_TTL_MS = 15_000;
const MAX_CARD_LIMIT = 200;

export interface SnapshotRequest {
  companyId: string;
  projectId: string | null;
  cardLimit: number;
  /** A new token skips the cache (the page's Refresh button). */
  refreshToken: string | null;
}

function stringParam(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function parseSnapshotParams(params: Record<string, unknown>): SnapshotRequest {
  const companyId = stringParam(params.companyId);
  if (!companyId) throw new Error("companyId is required");
  const rawProject = stringParam(params.projectId);
  const projectId = rawProject && rawProject !== "all" ? rawProject : null;
  const rawLimit = typeof params.cardLimit === "number" ? params.cardLimit : Number.NaN;
  const cardLimit = Number.isFinite(rawLimit)
    ? Math.min(MAX_CARD_LIMIT, Math.max(5, Math.floor(rawLimit)))
    : DEFAULT_CARD_LIMIT;
  const token = params.refreshToken;
  const refreshToken = typeof token === "string" || typeof token === "number" ? String(token) : null;
  return { companyId, projectId, cardLimit, refreshToken };
}

export async function buildSnapshot(
  host: HostReader,
  request: SnapshotRequest,
  now: number = Date.now(),
): Promise<RoadmapSnapshot> {
  const started = Date.now();
  const { companyId, projectId, cardLimit } = request;
  const agents = await loadAgents(host, companyId);
  const projects = await loadProjects(host, companyId, agents);
  if (projectId && !projects.some((project) => project.id === projectId)) {
    throw new Error("Project not found in this company");
  }

  // Routine runs first: the per-status task lists make room for them.
  const routines = await loadRoutineExecutions(host, companyId, projectId);
  const loaded = await loadTasks(
    host,
    companyId,
    { projectId, projectIds: projects.map((project) => project.id) },
    routines.executions,
  );
  const doneCardLimit = Math.max(DEFAULT_DONE_CARD_LIMIT, Math.floor(cardLimit / 2));
  const buildOptions = { now, agents, cardLimit, doneCardLimit };

  const base = {
    schemaVersion: 1 as const,
    companyId,
    projectId,
    generatedAt: new Date(now).toISOString(),
    projects,
    agents,
    limits: {
      perStatusCap: PER_STATUS_CAP,
      routineCap: ROUTINE_CAP,
      cardLimit,
      doneCardLimit,
      doneWindowDays: DONE_WINDOW_DAYS,
      routineWindowDays: ROUTINE_WINDOW_DAYS,
    },
    truncatedStatuses: loaded.truncatedStatuses,
    truncatedProjectIds: loaded.truncatedProjectIds,
    routinesTruncated: routines.truncated,
  };
  const stats = () => ({
    tasksScanned: loaded.tasks.length,
    routineExecutionsScanned: routines.executions.length,
    pluginOperationsSkipped: loaded.pluginOperationsSkipped,
    buildMs: Date.now() - started,
  });

  if (projectId) {
    const roadmap = buildProjectRoadmap(projectId, loaded.tasks, routines.executions, buildOptions);
    return {
      ...base,
      mode: "project",
      roadmap,
      overview: null,
      stats: stats(),
    };
  }

  const tasksByProject = groupByProject(loaded.tasks);
  const routinesByProject = groupByProject(routines.executions);
  const summaries: ProjectSummary[] = [];
  const knownProjects = new Map(projects.map((project) => [project.id, project]));
  for (const project of projects) {
    const tasks = tasksByProject.get(project.id) ?? [];
    const executions = routinesByProject.get(project.id) ?? [];
    if (project.archived && tasks.length === 0 && executions.length === 0) continue;
    const roadmap = buildProjectRoadmap(project.id, tasks, executions, { ...buildOptions, cardLimit: 0, doneCardLimit: 0 });
    summaries.push(summarizeProject(project, roadmap));
  }
  // Tasks of projects the list did not return (should not happen) still show up.
  for (const [id, tasks] of tasksByProject) {
    if (id === NO_PROJECT || knownProjects.has(id)) continue;
    const ref: ProjectRef = { id, name: "Unknown project", status: "unknown", leadAgentId: null, leadAgentName: null, archived: false };
    const roadmap = buildProjectRoadmap(id, tasks, [], { ...buildOptions, cardLimit: 0, doneCardLimit: 0 });
    summaries.push(summarizeProject(ref, roadmap));
  }
  const noProjectTasks = (tasksByProject.get(NO_PROJECT) ?? []).filter((task) => !isRoutineExecution(task));
  // Company-level routines (no project) have no lane of their own; the
  // overview lists them with the tasks that have no project.
  const noProjectRoutines = groupRoutineExecutions(
    [...(routinesByProject.get(NO_PROJECT) ?? []), ...(tasksByProject.get(NO_PROJECT) ?? [])],
    { now },
  );

  return {
    ...base,
    mode: "overview",
    roadmap: null,
    overview: {
      projects: summaries,
      noProject: {
        total: noProjectTasks.length,
        open: noProjectTasks.filter((task) => task.status !== "done" && task.status !== "cancelled").length,
        truncated: loaded.noProjectTruncated,
        routines: noProjectRoutines,
      },
    },
    stats: stats(),
  };
}

const NO_PROJECT = "\u0000none";

function groupByProject(tasks: readonly TaskInput[]): Map<string, TaskInput[]> {
  const map = new Map<string, TaskInput[]>();
  for (const task of tasks) {
    const key = task.projectId ?? NO_PROJECT;
    const list = map.get(key) ?? [];
    list.push(task);
    map.set(key, list);
  }
  return map;
}

interface CacheEntry {
  at: number;
  token: string | null;
  promise: Promise<RoadmapSnapshot>;
}

/** Short-lived per (company, project, card limit) cache with single-flight. */
export class SnapshotCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly ttlMs: number = SNAPSHOT_TTL_MS,
    private readonly clock: () => number = Date.now,
  ) {}

  get(request: SnapshotRequest, build: () => Promise<RoadmapSnapshot>): Promise<RoadmapSnapshot> {
    const key = `${request.companyId}|${request.projectId ?? "*"}|${request.cardLimit}`;
    const now = this.clock();
    const existing = this.entries.get(key);
    const tokenMatches = request.refreshToken === null || existing?.token === request.refreshToken;
    if (existing && tokenMatches && now - existing.at < this.ttlMs) return existing.promise;

    const promise = build();
    const entry: CacheEntry = { at: now, token: request.refreshToken ?? existing?.token ?? null, promise };
    this.entries.set(key, entry);
    // A failed build must not be served from the cache.
    promise.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    this.prune(now);
    return promise;
  }

  clear(): void {
    this.entries.clear();
  }

  private prune(now: number): void {
    if (this.entries.size < 64) return;
    for (const [key, entry] of this.entries) {
      if (now - entry.at >= this.ttlMs) this.entries.delete(key);
    }
  }
}

export async function loadTaskVersion(
  host: HostReader,
  params: Record<string, unknown>,
): Promise<TaskVersionInfo> {
  const companyId = stringParam(params.companyId);
  const issueId = stringParam(params.issueId);
  if (!companyId) throw new Error("companyId is required");
  if (!issueId) throw new Error("issueId is required");
  const getTask = async (id: string): Promise<TaskInput | null> => {
    const issue = await host.issues.get(id, companyId);
    return issue ? toTaskInput(issue) : null;
  };
  return resolveTaskVersion(await getTask(issueId), getTask);
}
