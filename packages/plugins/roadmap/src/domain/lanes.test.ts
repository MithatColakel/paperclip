import { describe, expect, it } from "vitest";
import { NOW, daysAgo, makeTask } from "../testing/fixtures.ts";
import { buildProjectRoadmap, currentVersionKey, deriveVersionState, summarizeProject, versionProgress } from "./lanes.ts";
import type { RoadmapLane, TaskInput, VersionLane } from "./types.ts";

const agents = [{ id: "agent-1", name: "Engineer", status: "idle" }];

function build(tasks: TaskInput[], extra: TaskInput[] = [], options: { cardLimit?: number; doneCardLimit?: number } = {}) {
  return buildProjectRoadmap("project-1", tasks, extra, { now: NOW, agents, ...options });
}

function versionLane(lanes: RoadmapLane[], key: string): VersionLane {
  const lane = lanes.find((candidate) => candidate.kind === "version" && candidate.key === key);
  if (!lane || lane.kind !== "version") throw new Error(`no lane for ${key}`);
  return lane;
}

describe("progress and state", () => {
  it("computes done / (total − cancelled)", () => {
    expect(versionProgress(3, 2, 8)).toEqual({ done: 3, cancelled: 2, total: 8, denominator: 6, pct: 0.5 });
    expect(versionProgress(0, 2, 2)).toMatchObject({ denominator: 0, pct: null });
    expect(versionProgress(0, 0, 0).pct).toBeNull();
  });

  it("derives planned, active and done", () => {
    expect(deriveVersionState(["backlog", "backlog", "done"])).toBe("planned");
    expect(deriveVersionState(["backlog", "todo"])).toBe("active");
    expect(deriveVersionState(["blocked"])).toBe("active");
    expect(deriveVersionState(["in_review", "cancelled"])).toBe("active");
    expect(deriveVersionState(["done", "cancelled"])).toBe("done");
    expect(deriveVersionState([])).toBe("done");
  });
});

describe("buildProjectRoadmap", () => {
  it("orders lanes hotfix → versions → ongoing → release ops", () => {
    const roadmap = build([
      makeTask({ labels: ["release-ops"] }),
      makeTask({ labels: ["v:1.1"] }),
      makeTask({}),
      makeTask({ labels: ["v:1.0.1"] }),
      makeTask({ labels: ["type:hotfix"] }),
      makeTask({ labels: ["v:mvp"] }),
      makeTask({ labels: ["v:1.0"] }),
    ]);
    expect(roadmap.lanes.map((lane) => lane.id)).toEqual([
      "hotfix",
      "version:mvp",
      "version:1.0",
      "version:1.0.1",
      "version:1.1",
      "ongoing",
      "release-ops",
    ]);
    expect(versionLane(roadmap.lanes, "1.0.1").isPatch).toBe(true);
    expect(roadmap.totals.versions).toBe(4);
  });

  it("always has an Ongoing lane and omits empty hotfix and ops lanes", () => {
    const roadmap = build([]);
    expect(roadmap.lanes.map((lane) => lane.id)).toEqual(["ongoing"]);
    expect(roadmap.lanes[0]?.total).toBe(0);
  });

  it("counts only counted non-epic tasks toward progress and every shown task per status", () => {
    const roadmap = build([
      makeTask({ id: "epic", status: "backlog", labels: ["type:epic"] }),
      makeTask({ id: "s1", parentId: "epic", status: "done", labels: ["v:mvp"] }),
      makeTask({ id: "s2", parentId: "epic", status: "in_progress", labels: ["v:mvp"] }),
      makeTask({ id: "s3", status: "cancelled", labels: ["v:mvp"] }),
      makeTask({ id: "s4", status: "todo", labels: ["v:mvp"] }),
      makeTask({ id: "sub", parentId: "s4", status: "todo" }),
      makeTask({ id: "copy", parentId: "s4", status: "done", labels: ["v:mvp"] }),
      makeTask({ id: "hot", status: "blocked", labels: ["v:mvp", "type:hotfix"] }),
      makeTask({ id: "ops", status: "todo", labels: ["v:mvp", "release-ops"] }),
    ]);
    const mvp = versionLane(roadmap.lanes, "mvp");
    // Counted: s1 (done), s2, s3 (cancelled), s4, hot. Not counted: epic, sub (inherited), copy, ops.
    expect(mvp.progress).toEqual({ done: 1, cancelled: 1, total: 5, denominator: 4, pct: 0.25 });
    // Shown: s1, s2, s3, s4, sub, copy. The hotfix is in the Hotfix lane, ops in Release ops.
    expect(mvp.total).toBe(6);
    expect(mvp.counts).toMatchObject({ done: 2, in_progress: 1, cancelled: 1, todo: 2, blocked: 0 });
    expect(mvp.inheritedCount).toBe(1);
    expect(mvp.hotfixOpenElsewhere).toBe(1);
    expect(mvp.state).toBe("active");
    expect(mvp.epics).toEqual([{ id: "epic", identifier: "EPIC", title: "Task epic", total: 2, done: 1, cancelled: 0 }]);
    expect(roadmap.lanes[0]?.id).toBe("hotfix");
    expect(roadmap.epics[0]).toMatchObject({ id: "epic", total: 2, done: 1, laneIds: ["version:mvp"] });
    expect(roadmap.warnings.find((warning) => warning.code === "unlabelled_child_of_version_task")?.count).toBe(1);
  });

  it("marks a version planned when all of its open tasks are in backlog", () => {
    const roadmap = build([
      makeTask({ status: "backlog", labels: ["v:1.0"] }),
      makeTask({ status: "backlog", assigneeAgentId: "agent-1", labels: ["v:1.0"] }),
      makeTask({ status: "done", labels: ["v:1.0"] }),
    ]);
    const lane = versionLane(roadmap.lanes, "1.0");
    expect(lane.state).toBe("planned");
    expect(lane.parkedCount).toBe(1);
    expect(currentVersionKey(roadmap.lanes)).toBe("1.0");
  });

  it("keeps column totals exact while trimming cards, and shows done only within 14 days", () => {
    const tasks = [
      ...Array.from({ length: 7 }, (_, index) => makeTask({ status: "todo", labels: ["v:mvp"], priority: index === 6 ? "critical" : "medium" })),
      makeTask({ id: "recent", status: "done", completedAt: daysAgo(2), labels: ["v:mvp"] }),
      makeTask({ id: "old", status: "done", completedAt: daysAgo(40), updatedAt: daysAgo(40), labels: ["v:mvp"] }),
    ];
    const lane = versionLane(build(tasks, [], { cardLimit: 3, doneCardLimit: 5 }).lanes, "mvp");
    const todo = lane.columns.find((column) => column.key === "todo");
    const done = lane.columns.find((column) => column.key === "done");
    expect(todo?.total).toBe(7);
    expect(todo?.cards).toHaveLength(3);
    expect(todo?.cards[0]?.priority).toBe("critical");
    expect(done?.total).toBe(1);
    expect(done?.cards.map((card) => card.id)).toEqual(["recent"]);
    expect(lane.counts.done).toBe(2);
    expect(lane.doneRecent).toBe(1);
    expect(lane.progress).toMatchObject({ done: 2, total: 9 });
  });

  it("sorts hotfix cards first and fills card details", () => {
    const roadmap = build([
      makeTask({ id: "epic", labels: ["type:epic"], title: "Checkout" }),
      makeTask({ id: "parent", identifier: "CLE-1", parentId: "epic", labels: ["v:mvp"] }),
      makeTask({ id: "child", identifier: "CLE-2", parentId: "parent", assigneeAgentId: "agent-1", status: "todo", priority: "low", labels: ["type:bug"] }),
      makeTask({ id: "board", status: "todo", assigneeUserId: "user-1", labels: ["v:mvp", "type:hotfix"] }),
      makeTask({ id: "hotdone", status: "done", labels: ["v:mvp", "type:hotfix"] }),
    ]);
    const mvp = versionLane(roadmap.lanes, "mvp");
    const todo = mvp.columns.find((column) => column.key === "todo");
    expect(todo?.cards.map((card) => card.id)).toEqual(["parent", "child"]);
    const child = todo?.cards[1];
    expect(child).toMatchObject({
      identifier: "CLE-2",
      assigneeName: "Engineer",
      assigneeKind: "agent",
      isBug: true,
      parentIdentifier: "CLE-1",
      epicTitle: "Checkout",
      versionKey: "mvp",
      inheritedVersion: true,
      ageDays: 3,
    });
    const hotfixLane = roadmap.lanes.find((lane) => lane.kind === "hotfix");
    expect(hotfixLane?.columns.find((column) => column.key === "todo")?.cards[0]).toMatchObject({
      id: "board",
      assigneeName: "board",
      assigneeKind: "board",
      isHotfix: true,
    });
    // A finished hotfix goes back to its version.
    expect(mvp.columns.find((column) => column.key === "done")?.cards[0]?.id).toBe("hotdone");
  });

  it("builds the Routines band from routine executions in both inputs without double counting", () => {
    const run = (id: string, status: TaskInput["status"], days: number, routine = "routine-1") =>
      makeTask({ id, status, originKind: "routine_execution", originId: routine, title: "Trello intake poll", createdAt: daysAgo(days) });
    const fromList = run("r1", "done", 1);
    const roadmap = build([fromList, makeTask({ id: "work" })], [fromList, run("r2", "cancelled", 2), run("r3", "done", 45)]);
    expect(roadmap.routines).toHaveLength(1);
    expect(roadmap.routines[0]).toMatchObject({ routineId: "routine-1", runCount: 2, title: "Trello intake poll" });
    expect(roadmap.totals.routineExecutions).toBe(3);
    expect(roadmap.totals.tasks).toBe(1);
    // Routine executions never land in a lane.
    expect(roadmap.lanes.reduce((sum, lane) => sum + lane.total, 0)).toBe(1);
  });

  it("reports label warnings", () => {
    const roadmap = build([
      makeTask({ identifier: "CLE-9", labels: ["type:epic", "v:mvp"] }),
      makeTask({ identifier: "CLE-10", labels: ["v:mvp", "v:1.0"] }),
      makeTask({ identifier: "CLE-11", status: "todo", labels: ["type:hotfix"] }),
    ]);
    const codes = Object.fromEntries(roadmap.warnings.map((warning) => [warning.code, warning.identifiers]));
    expect(codes).toEqual({
      epic_with_version_label: ["CLE-9"],
      label_conflict: ["CLE-10"],
      hotfix_unassigned: ["CLE-11"],
    });
  });

  it("summarizes a project for the overview", () => {
    const roadmap = build([
      makeTask({ status: "done", labels: ["v:mvp"] }),
      makeTask({ status: "todo", labels: ["v:1.0"] }),
      makeTask({ status: "backlog", labels: ["v:1.1"] }),
      makeTask({ status: "blocked", createdAt: daysAgo(9) }),
      makeTask({ status: "todo", labels: ["type:hotfix"] }),
    ]);
    const summary = summarizeProject(
      { id: "project-1", name: "App", status: "in_progress", leadAgentId: null, leadAgentName: null, archived: false },
      roadmap,
    );
    expect(summary.currentVersionKey).toBe("1.0");
    expect(summary.versions.map((version) => [version.key, version.state])).toEqual([
      ["mvp", "done"],
      ["1.0", "active"],
      ["1.1", "planned"],
    ]);
    expect(summary).toMatchObject({ hotfixOpen: 1, ongoingOpen: 1, ongoingOldestDays: 9, totals: { tasks: 5, open: 4 } });
    expect(summary.counts.blocked).toBe(1);
  });

  it("shows labels that differ only in case as one version lane and flags them", () => {
    const roadmap = build([
      makeTask({ id: "a", identifier: "CLE-1", status: "done", labels: ["v:MVP"] }),
      makeTask({ id: "b", identifier: "CLE-2", status: "todo", labels: ["v:mvp"] }),
      makeTask({ id: "c", identifier: "CLE-3", status: "todo", labels: ["v:MVP", "v:mvp"] }),
    ]);
    expect(roadmap.lanes.map((lane) => lane.id)).toEqual(["version:mvp", "ongoing"]);
    const lane = versionLane(roadmap.lanes, "mvp");
    expect(lane).toMatchObject({ labelName: "v:mvp", total: 3 });
    expect(lane.progress).toMatchObject({ done: 1, total: 3 });
    const cards = lane.columns.flatMap((column) => column.cards);
    expect(new Set(cards.map((card) => card.versionKey))).toEqual(new Set(["mvp"]));
    expect(roadmap.warnings).toEqual([{ code: "label_case_variant", count: 2, identifiers: ["CLE-1", "CLE-3"] }]);
  });

  it("keeps the only spelling when there is no lowercase one", () => {
    const roadmap = build([makeTask({ labels: ["v:MVP"] })]);
    expect(roadmap.lanes[0]).toMatchObject({ id: "version:mvp", key: "MVP", title: "Version MVP" });
    expect(roadmap.warnings).toEqual([]);
  });
});
