import { describe, expect, it } from "vitest";
import { makeTask } from "../testing/fixtures.ts";
import { LANE_ID_EPIC, LANE_ID_HOTFIX, LANE_ID_ONGOING, LANE_ID_RELEASE_OPS, LANE_ID_ROUTINES, analyzeTasks } from "./classify.ts";
import { resolveTaskVersion } from "./task-version.ts";
import type { TaskInput, TaskVersionKind } from "./types.ts";

function lookup(tasks: TaskInput[]) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return async (id: string) => byId.get(id) ?? null;
}

const KIND_OF_LANE: Record<string, TaskVersionKind> = {
  [LANE_ID_ROUTINES]: "routine",
  [LANE_ID_RELEASE_OPS]: "release_ops",
  [LANE_ID_EPIC]: "epic",
  [LANE_ID_HOTFIX]: "hotfix",
  [LANE_ID_ONGOING]: "ongoing",
};

describe("resolveTaskVersion", () => {
  it("agrees with the board for every task of a project", async () => {
    const tasks = [
      makeTask({ id: "epic-ops", labels: ["type:epic", "release-ops"] }),
      makeTask({ id: "epic", labels: ["type:epic", "v:mvp"] }),
      makeTask({ id: "story", parentId: "epic", labels: ["v:mvp"] }),
      makeTask({ id: "story-plain", parentId: "epic" }),
      makeTask({ id: "sub", parentId: "story" }),
      makeTask({ id: "ops", labels: ["release-ops", "v:1.0"] }),
      makeTask({ id: "ops-child", parentId: "ops" }),
      makeTask({ id: "hot", labels: ["type:hotfix", "v:1.0.1"] }),
      makeTask({ id: "hot-done", status: "done", labels: ["type:hotfix", "v:1.0.1"] }),
      makeTask({ id: "run", originKind: "routine_execution", originId: "r", labels: ["v:mvp"] }),
      makeTask({ id: "run-child", parentId: "run" }),
      makeTask({ id: "both", labels: ["v:1.0", "v:mvp"] }),
      makeTask({ id: "plain" }),
    ];
    const board = analyzeTasks(tasks);
    const getTask = lookup(tasks);
    for (const task of tasks) {
      const fact = board.get(task.id);
      const info = await resolveTaskVersion(task, getTask);
      const expected = fact ? KIND_OF_LANE[fact.laneId] ?? "version" : "missing";
      expect([task.id, info.kind]).toEqual([task.id, expected]);
      expect([task.id, info.versionKey]).toEqual([task.id, fact?.version?.spelling ?? null]);
    }
    expect(await resolveTaskVersion(tasks[0] ?? null, getTask)).toMatchObject({ kind: "release_ops" });
    expect(await resolveTaskVersion(tasks[4] ?? null, getTask)).toMatchObject({
      kind: "version",
      versionKey: "mvp",
      inherited: true,
      inheritedFromIdentifier: "STORY",
    });
    expect(await resolveTaskVersion(tasks[11] ?? null, getTask)).toMatchObject({ conflictKeys: ["mvp", "1.0"] });
  });

  it("stops at a parent in another project, as the board does", async () => {
    const tasks = [
      makeTask({ id: "parent", projectId: "project-2", labels: ["v:2.0"] }),
      makeTask({ id: "child", projectId: "project-1", parentId: "parent" }),
    ];
    expect(await resolveTaskVersion(tasks[1] ?? null, lookup(tasks))).toMatchObject({ kind: "ongoing", versionKey: null, inherited: false });
  });

  it("stops at a plugin operation parent and hides plugin operations", async () => {
    const tasks = [
      makeTask({ id: "op", originKind: "plugin:paperclipai.llm-wiki:operation", labels: ["v:mvp"] }),
      makeTask({ id: "child", parentId: "op" }),
    ];
    expect(await resolveTaskVersion(tasks[1] ?? null, lookup(tasks))).toMatchObject({ kind: "ongoing", versionKey: null });
    expect(await resolveTaskVersion(tasks[0] ?? null, lookup(tasks))).toMatchObject({ kind: "hidden" });
    expect(await resolveTaskVersion(null, lookup(tasks))).toMatchObject({ kind: "missing" });
  });

  it("shows the spelling of the label the version comes from", async () => {
    const tasks = [makeTask({ id: "parent", labels: ["v:MVP"] }), makeTask({ id: "child", parentId: "parent" })];
    expect(await resolveTaskVersion(tasks[1] ?? null, lookup(tasks))).toMatchObject({ versionKey: "MVP", inherited: true });
  });
});
