import { describe, expect, it } from "vitest";
import { isPluginOperationIssueOriginKind } from "@paperclipai/shared";
import { makeTask } from "../testing/fixtures.ts";
import {
  LANE_ID_EPIC,
  LANE_ID_HOTFIX,
  LANE_ID_ONGOING,
  LANE_ID_RELEASE_OPS,
  LANE_ID_ROUTINES,
  MAX_ANCESTOR_DEPTH,
  analyzeTasks,
  isPluginOperationOriginKind,
  versionLaneId,
} from "./classify.ts";

function factsOf(...tasks: ReturnType<typeof makeTask>[]) {
  const facts = analyzeTasks(tasks);
  return (id: string) => {
    const fact = facts.get(id);
    if (!fact) throw new Error(`no facts for ${id}`);
    return fact;
  };
}

describe("lane classification", () => {
  it("places tasks with their own v: label in that version lane and counts them", () => {
    const get = factsOf(makeTask({ id: "a", labels: ["v:mvp"] }));
    expect(get("a")).toMatchObject({
      laneId: versionLaneId("mvp"),
      version: { key: "mvp", inherited: false },
      counted: true,
    });
  });

  it("puts tasks without a version in Ongoing", () => {
    const get = factsOf(makeTask({ id: "a" }));
    expect(get("a").laneId).toBe(LANE_ID_ONGOING);
    expect(get("a").version).toBeNull();
    expect(get("a").counted).toBe(false);
  });

  it("puts routine executions in the Routines band and ignores their labels", () => {
    const get = factsOf(makeTask({ id: "r", originKind: "routine_execution", originId: "routine-1", labels: ["v:mvp", "type:hotfix"] }));
    expect(get("r")).toMatchObject({ laneId: LANE_ID_ROUTINES, isRoutine: true, version: null, counted: false });
  });

  it("puts release-ops tasks in the Release ops lane and never counts them", () => {
    const get = factsOf(makeTask({ id: "ops", labels: ["release-ops", "v:1.0"] }));
    expect(get("ops")).toMatchObject({ laneId: LANE_ID_RELEASE_OPS, counted: false });
    expect(get("ops").version?.key).toBe("1.0");
  });

  it("puts open hotfixes in the Hotfix lane but still counts them toward their version", () => {
    const get = factsOf(
      makeTask({ id: "hot", status: "in_progress", labels: ["type:hotfix", "v:1.0.1"] }),
      makeTask({ id: "fixed", status: "done", labels: ["type:hotfix", "v:1.0.1"] }),
      makeTask({ id: "plain-hot", status: "todo", labels: ["type:hotfix"] }),
    );
    expect(get("hot")).toMatchObject({ laneId: LANE_ID_HOTFIX, counted: true, version: { key: "1.0.1" } });
    expect(get("fixed")).toMatchObject({ laneId: versionLaneId("1.0.1"), counted: true });
    expect(get("plain-hot").laneId).toBe(LANE_ID_HOTFIX);
  });

  it("treats epics as headers, ignores a v: label on them and links their stories", () => {
    const get = factsOf(
      makeTask({ id: "epic", status: "backlog", labels: ["type:epic", "v:mvp"] }),
      makeTask({ id: "story-labelled", parentId: "epic", labels: ["v:mvp"] }),
      makeTask({ id: "story-plain", parentId: "epic" }),
    );
    expect(get("epic")).toMatchObject({ laneId: LANE_ID_EPIC, version: null, counted: false, epicId: null });
    // A story does not inherit from its epic.
    expect(get("story-labelled")).toMatchObject({ laneId: versionLaneId("mvp"), counted: true, epicId: "epic" });
    expect(get("story-plain")).toMatchObject({ laneId: LANE_ID_ONGOING, version: null, epicId: "epic" });
  });

  it("inherits the version of the nearest labelled non-epic ancestor, through epics", () => {
    const get = factsOf(
      makeTask({ id: "grand", labels: ["v:1.0"] }),
      makeTask({ id: "epic", parentId: "grand", labels: ["type:epic", "v:2.0"] }),
      makeTask({ id: "child", parentId: "epic" }),
      makeTask({ id: "leaf", parentId: "child" }),
    );
    expect(get("child")).toMatchObject({
      laneId: versionLaneId("1.0"),
      version: { key: "1.0", inherited: true, fromId: "grand" },
      counted: false,
      epicId: "epic",
    });
    expect(get("leaf").version).toEqual({ key: "1.0", spelling: "1.0", inherited: true, fromId: "grand" });
    expect(get("leaf").epicId).toBe("epic");
  });

  it("does not count a sub-task that copies its parent's label, but counts a different label", () => {
    const get = factsOf(
      makeTask({ id: "parent", labels: ["v:mvp"] }),
      makeTask({ id: "copy", parentId: "parent", labels: ["v:mvp"] }),
      makeTask({ id: "moved", parentId: "parent", labels: ["v:1.0"] }),
    );
    expect(get("parent").counted).toBe(true);
    expect(get("copy")).toMatchObject({ laneId: versionLaneId("mvp"), counted: false, version: { inherited: false } });
    expect(get("moved")).toMatchObject({ laneId: versionLaneId("1.0"), counted: true });
  });

  it("checks only the nearest non-epic ancestor for the counting rule, skipping epics", () => {
    const get = factsOf(
      makeTask({ id: "top", labels: ["v:mvp"] }),
      makeTask({ id: "epic", parentId: "top", labels: ["type:epic"] }),
      makeTask({ id: "story", parentId: "epic", labels: ["v:mvp"] }),
    );
    expect(get("story").counted).toBe(false);
  });

  it("resolves a label conflict to the earliest version and flags it", () => {
    const get = factsOf(makeTask({ id: "both", labels: ["v:1.0", "v:mvp"] }));
    expect(get("both")).toMatchObject({ laneId: versionLaneId("mvp"), conflict: true, counted: true });
  });

  it("survives parent cycles and missing parents", () => {
    const get = factsOf(
      makeTask({ id: "a", parentId: "b" }),
      makeTask({ id: "b", parentId: "a" }),
      makeTask({ id: "orphan", parentId: "not-loaded" }),
    );
    expect(get("a").laneId).toBe(LANE_ID_ONGOING);
    expect(get("b").laneId).toBe(LANE_ID_ONGOING);
    expect(get("orphan").laneId).toBe(LANE_ID_ONGOING);
  });

  it("stops inheriting after the maximum depth", () => {
    const chain = [makeTask({ id: "n0", labels: ["v:mvp"] })];
    for (let index = 1; index <= MAX_ANCESTOR_DEPTH + 1; index += 1) {
      chain.push(makeTask({ id: `n${index}`, parentId: `n${index - 1}` }));
    }
    const get = factsOf(...chain);
    expect(get(`n${MAX_ANCESTOR_DEPTH}`).version?.key).toBe("mvp");
    expect(get(`n${MAX_ANCESTOR_DEPTH + 1}`).version).toBeNull();
  });
});

describe("counting under ops tasks", () => {
  it("counts work that copies the label of a release-ops parent", () => {
    const get = factsOf(
      makeTask({ id: "track", status: "todo", labels: ["release-ops", "v:1.0"] }),
      makeTask({ id: "work", parentId: "track", status: "done", labels: ["v:1.0"] }),
      makeTask({ id: "work2", parentId: "track", status: "todo", labels: ["v:1.0"] }),
      makeTask({ id: "sub", parentId: "work", status: "done", labels: ["v:1.0"] }),
    );
    expect(get("track")).toMatchObject({ laneId: LANE_ID_RELEASE_OPS, counted: false });
    expect(get("work")).toMatchObject({ laneId: versionLaneId("1.0"), counted: true });
    expect(get("work2")).toMatchObject({ laneId: versionLaneId("1.0"), counted: true });
    // A copy under a countable task still counts once.
    expect(get("sub").counted).toBe(false);
  });

  it("skips routine runs too when looking for the parent that makes a label a copy", () => {
    const get = factsOf(
      makeTask({ id: "run", originKind: "routine_execution", originId: "routine-1", labels: ["v:mvp"] }),
      makeTask({ id: "follow-up", parentId: "run", labels: ["v:mvp"] }),
    );
    expect(get("follow-up").counted).toBe(true);
  });
});

describe("plugin operations", () => {
  it("matches the shared predicate and the three legacy kinds", () => {
    const kinds = [
      "plugin:paperclipai.llm-wiki:operation",
      "plugin:paperclipai.llm-wiki:operation:ingest",
      "plugin:paperclipai.llm-wiki:operational",
      "plugin:paperclipai.llm-wiki:task",
      "plugin::operation",
      "routine_execution",
      "manual",
    ];
    for (const kind of kinds) expect([kind, isPluginOperationOriginKind(kind)]).toEqual([kind, isPluginOperationIssueOriginKind(kind)]);
    expect(isPluginOperationOriginKind("plugin:paperclipai.content-machine:case")).toBe(true);
    expect(isPluginOperationOriginKind("plugin:paperclipai.content-machine:evaluation")).toBe(true);
    expect(isPluginOperationOriginKind("plugin:paperclipai.content-machine:source-sync")).toBe(true);
    expect(isPluginOperationOriginKind(null)).toBe(false);
  });
});

describe("labels that differ only in case", () => {
  it("are one version and never a conflict", () => {
    const get = factsOf(
      makeTask({ id: "upper", labels: ["v:MVP"] }),
      makeTask({ id: "both", labels: ["v:MVP", "v:mvp"] }),
      makeTask({ id: "child", parentId: "upper" }),
    );
    expect(get("upper")).toMatchObject({ laneId: versionLaneId("mvp"), version: { key: "mvp", spelling: "MVP" } });
    expect(get("both")).toMatchObject({ laneId: versionLaneId("mvp"), conflict: false });
    expect(get("child").version).toMatchObject({ key: "mvp", spelling: "MVP", inherited: true });
  });
});
