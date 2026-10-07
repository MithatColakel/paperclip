/**
 * The Routines band. Plugins cannot read the `routines` table, so the band is
 * built from routine executions: issues with `originKind = routine_execution`
 * and `originId = <routine id>`. They are never counted toward a version.
 */

import { isOpenStatus, isRoutineExecution } from "./classify.ts";
import type { RoutineGroup, TaskInput, TaskStatus } from "./types.ts";

export const ROUTINE_WINDOW_DAYS = 30;
export const ROUTINE_RECENT_RUNS = 5;

const FAILED_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["cancelled", "blocked"]);

const DAY_MS = 24 * 60 * 60 * 1000;

function timeOf(value: string): number {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

export interface GroupRoutineOptions {
  now: number;
  windowDays?: number;
  recentRuns?: number;
}

export function groupRoutineExecutions(executions: readonly TaskInput[], options: GroupRoutineOptions): RoutineGroup[] {
  const windowDays = options.windowDays ?? ROUTINE_WINDOW_DAYS;
  const recentRuns = options.recentRuns ?? ROUTINE_RECENT_RUNS;
  const since = options.now - windowDays * DAY_MS;

  const seen = new Set<string>();
  const byRoutine = new Map<string, TaskInput[]>();
  for (const execution of executions) {
    if (!isRoutineExecution(execution) || !execution.originId) continue;
    if (seen.has(execution.id)) continue;
    seen.add(execution.id);
    if (timeOf(execution.createdAt) < since) continue;
    const list = byRoutine.get(execution.originId) ?? [];
    list.push(execution);
    byRoutine.set(execution.originId, list);
  }

  const groups: RoutineGroup[] = [];
  for (const [routineId, runs] of byRoutine) {
    runs.sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt) || (a.id < b.id ? -1 : 1));
    const latest = runs[0];
    if (!latest) continue;
    const lastTwo = runs.slice(0, 2);
    groups.push({
      routineId,
      title: latest.title,
      projectId: latest.projectId,
      lastRunAt: latest.createdAt,
      runCount: runs.length,
      openCount: runs.filter((run) => isOpenStatus(run.status)).length,
      failing: lastTwo.length === 2 && lastTwo.every((run) => FAILED_STATUSES.has(run.status)),
      runs: runs.slice(0, recentRuns).map((run) => ({
        id: run.id,
        identifier: run.identifier,
        status: run.status,
        createdAt: run.createdAt,
      })),
    });
  }

  groups.sort((a, b) => {
    if (a.failing !== b.failing) return a.failing ? -1 : 1;
    return timeOf(b.lastRunAt) - timeOf(a.lastRunAt) || a.title.localeCompare(b.title);
  });
  return groups;
}
