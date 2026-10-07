import { describe, expect, it } from "vitest";
import { NOW, daysAgo, makeTask } from "../testing/fixtures.ts";
import { groupRoutineExecutions } from "./routines.ts";
import type { TaskInput } from "./types.ts";

function run(routine: string, status: TaskInput["status"], days: number, title = `Routine ${routine}`) {
  return makeTask({ originKind: "routine_execution", originId: routine, status, createdAt: daysAgo(days), title });
}

describe("groupRoutineExecutions", () => {
  it("groups by routine with the last five runs, newest first", () => {
    const runs = [1, 2, 3, 4, 5, 6, 7].map((day) => run("a", day === 1 ? "in_progress" : "done", day));
    const [group] = groupRoutineExecutions(runs, { now: NOW });
    expect(group).toMatchObject({ routineId: "a", runCount: 7, openCount: 1, failing: false, lastRunAt: daysAgo(1) });
    expect(group?.runs.map((entry) => entry.createdAt)).toEqual([1, 2, 3, 4, 5].map(daysAgo));
    expect(group?.runs[0]?.status).toBe("in_progress");
  });

  it("only keeps runs from the last 30 days and drops routines without one", () => {
    const groups = groupRoutineExecutions([run("a", "done", 31), run("b", "done", 29)], { now: NOW });
    expect(groups.map((group) => group.routineId)).toEqual(["b"]);
  });

  it("flags a routine whose last two runs were cancelled or blocked and lists it first", () => {
    const groups = groupRoutineExecutions(
      [
        run("healthy", "done", 1),
        run("broken", "cancelled", 2),
        run("broken", "blocked", 3),
        run("broken", "done", 4),
        run("flaky", "cancelled", 2),
        run("flaky", "done", 3),
      ],
      { now: NOW },
    );
    expect(groups.map((group) => [group.routineId, group.failing])).toEqual([
      ["broken", true],
      ["healthy", false],
      ["flaky", false],
    ]);
  });

  it("ignores other tasks, executions without a routine id and duplicates", () => {
    const execution = run("a", "done", 1);
    const groups = groupRoutineExecutions(
      [execution, execution, makeTask({ status: "done" }), makeTask({ originKind: "routine_execution", originId: null })],
      { now: NOW },
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.runCount).toBe(1);
  });
});
