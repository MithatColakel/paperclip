import type { TaskInput, TaskLabelInput } from "../domain/types.ts";

export const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

export function daysAgo(days: number): string {
  return new Date(NOW - days * DAY_MS).toISOString();
}

let sequence = 0;

export type TaskFixture = Partial<Omit<TaskInput, "labels">> & { labels?: Array<string | TaskLabelInput> };

/** A task with sensible defaults; labels may be given as plain names. */
export function makeTask(fixture: TaskFixture = {}): TaskInput {
  sequence += 1;
  const id = fixture.id ?? `task-${sequence}`;
  const labels = (fixture.labels ?? []).map((label) =>
    typeof label === "string" ? { id: `label-${label}`, name: label, color: null } : label,
  );
  return {
    id,
    identifier: fixture.identifier ?? id.toUpperCase(),
    title: fixture.title ?? `Task ${id}`,
    status: fixture.status ?? "todo",
    priority: fixture.priority ?? "medium",
    projectId: fixture.projectId === undefined ? "project-1" : fixture.projectId,
    parentId: fixture.parentId ?? null,
    assigneeAgentId: fixture.assigneeAgentId ?? null,
    assigneeUserId: fixture.assigneeUserId ?? null,
    labels,
    originKind: fixture.originKind ?? "manual",
    originId: fixture.originId ?? null,
    createdAt: fixture.createdAt ?? daysAgo(3),
    updatedAt: fixture.updatedAt ?? daysAgo(1),
    completedAt: fixture.completedAt ?? (fixture.status === "done" ? daysAgo(1) : null),
    cancelledAt: fixture.cancelledAt ?? null,
    live: fixture.live ?? false,
  };
}
