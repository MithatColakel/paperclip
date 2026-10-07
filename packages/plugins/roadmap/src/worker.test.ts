import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Agent, Issue, Project } from "@paperclipai/plugin-sdk";
import { isPluginOperationIssueOriginKind, pluginManifestV1Schema } from "@paperclipai/shared";
import { beforeEach, describe, expect, it } from "vitest";
import type { RoadmapSnapshot, TaskVersionInfo, VersionLane } from "./domain/types.ts";
import { SnapshotCache, buildSnapshot, loadTaskVersion } from "./snapshot.ts";
import { loadRoutineExecutions, loadTasks, type HostReader } from "./host-data.ts";
import manifest from "./manifest.ts";
import plugin, { DATA_KEYS } from "./worker.ts";

const COMPANY = "company-1";
const OTHER_COMPANY = "company-2";
const now = new Date();
const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

function label(name: string, color = "#6366f1") {
  return { id: `label-${name}`, companyId: COMPANY, name, color, createdAt: now, updatedAt: now };
}

let counter = 0;
function issue(partial: Partial<Issue> & { labelNames?: string[] }): Issue {
  counter += 1;
  const { labelNames, ...rest } = partial;
  const labels = (labelNames ?? []).map((name) => label(name));
  return {
    id: `issue-${counter}`,
    companyId: COMPANY,
    projectId: "project-app",
    identifier: `CLE-${counter}`,
    title: `Task ${counter}`,
    status: "todo",
    priority: "medium",
    parentId: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    originKind: "manual",
    originId: null,
    createdAt: daysAgo(5),
    updatedAt: daysAgo(1),
    completedAt: null,
    cancelledAt: null,
    labels,
    labelIds: labels.map((entry) => entry.id),
    ...rest,
  } as unknown as Issue;
}

function project(id: string, name: string, extra: Partial<Project> = {}): Project {
  return {
    id,
    companyId: COMPANY,
    name,
    status: "in_progress",
    leadAgentId: "agent-pm",
    archivedAt: null,
    ...extra,
  } as unknown as Project;
}

const agents = [
  { id: "agent-pm", companyId: COMPANY, name: "PM", status: "idle" },
  { id: "agent-ios", companyId: COMPANY, name: "iOS Engineer", status: "running" },
] as unknown as Agent[];

function seededHarness() {
  const harness = createTestHarness({ manifest });
  const epic = issue({ id: "epic", title: "Onboarding", status: "backlog", labelNames: ["type:epic"] });
  const issues = [
    epic,
    issue({ id: "story-1", parentId: "epic", status: "done", completedAt: daysAgo(2), labelNames: ["v:mvp"] }),
    issue({ id: "story-2", parentId: "epic", status: "in_progress", assigneeAgentId: "agent-ios", labelNames: ["v:mvp"] }),
    issue({ id: "sub", parentId: "story-2", status: "todo" }),
    issue({ id: "later", status: "backlog", labelNames: ["v:1.0"] }),
    issue({ id: "hotfix", status: "todo", priority: "critical", assigneeUserId: "user-1", labelNames: ["type:hotfix"] }),
    issue({ id: "ongoing", status: "blocked" }),
    issue({ id: "ops", status: "todo", labelNames: ["release-ops", "v:mvp"] }),
    issue({ id: "run-1", status: "done", originKind: "routine_execution", originId: "routine-trello", title: "Trello intake poll", createdAt: daysAgo(1) }),
    issue({ id: "run-2", status: "cancelled", originKind: "routine_execution", originId: "routine-trello", title: "Trello intake poll", createdAt: daysAgo(2) }),
    issue({ id: "web-1", projectId: "project-web", status: "todo", labelNames: ["v:web-1.0"] }),
    issue({ id: "loose", projectId: null, status: "todo" }),
    issue({ id: "foreign", companyId: OTHER_COMPANY, status: "todo", labelNames: ["v:mvp"] }),
  ];
  harness.seed({
    projects: [project("project-app", "Cleanio iOS"), project("project-web", "Website"), project("project-old", "Old", { archivedAt: daysAgo(100) } as Partial<Project>)],
    agents,
    issues,
  });
  return harness;
}

describe("manifest", () => {
  it("passes the host manifest schema", () => {
    const result = pluginManifestV1Schema.safeParse(manifest);
    expect(result.success, JSON.stringify(result.error?.issues ?? [])).toBe(true);
  });

  it("declares the capability each slot needs and nothing that writes", () => {
    // Mirrors UI_SLOT_CAPABILITIES in server/src/services/plugin-capability-validator.ts.
    const needed: Record<string, string> = {
      sidebar: "ui.sidebar.register",
      page: "ui.page.register",
      detailTab: "ui.detailTab.register",
      toolbarButton: "ui.action.register",
    };
    for (const slot of manifest.ui?.slots ?? []) {
      expect(manifest.capabilities).toContain(needed[slot.type]);
    }
    expect(manifest.capabilities.some((capability) => /create|update|write|wakeup|migrate/.test(capability))).toBe(false);
    expect(manifest.database).toBeUndefined();
  });
});

describe("roadmap.snapshot", () => {
  let harness: ReturnType<typeof seededHarness>;
  beforeEach(async () => {
    harness = seededHarness();
    await plugin.definition.setup(harness.ctx);
  });

  it("builds the project flow with lanes in order", async () => {
    const snapshot = await harness.getData<RoadmapSnapshot>(DATA_KEYS.snapshot, { companyId: COMPANY, projectId: "project-app" });
    expect(snapshot.mode).toBe("project");
    expect(snapshot.projects.map((entry) => entry.name)).toEqual(["Cleanio iOS", "Old", "Website"]);
    const roadmap = snapshot.roadmap;
    expect(roadmap?.lanes.map((lane) => lane.id)).toEqual(["hotfix", "version:mvp", "version:1.0", "ongoing", "release-ops"]);
    const mvp = roadmap?.lanes.find((lane) => lane.id === "version:mvp") as VersionLane;
    expect(mvp.state).toBe("active");
    expect(mvp.progress).toMatchObject({ done: 1, total: 2, pct: 0.5 });
    expect(mvp.inheritedCount).toBe(1);
    expect(mvp.color).toBe("#6366f1");
    const inProgress = mvp.columns.find((column) => column.key === "in_progress");
    expect(inProgress?.cards[0]).toMatchObject({ id: "story-2", assigneeName: "iOS Engineer", epicTitle: "Onboarding" });
    expect(roadmap?.lanes.find((lane) => lane.id === "version:1.0")).toMatchObject({ state: "planned" });
    expect(roadmap?.routines).toEqual([
      expect.objectContaining({ routineId: "routine-trello", title: "Trello intake poll", runCount: 2, failing: false }),
    ]);
    expect(roadmap?.epics).toEqual([expect.objectContaining({ id: "epic", total: 2, done: 1 })]);
    expect(snapshot.truncatedStatuses).toEqual([]);
    expect(snapshot.stats.tasksScanned).toBe(10);
  });

  it("summarizes every project in overview mode", async () => {
    const snapshot = await harness.getData<RoadmapSnapshot>(DATA_KEYS.snapshot, { companyId: COMPANY, projectId: null });
    expect(snapshot.mode).toBe("overview");
    expect(snapshot.roadmap).toBeNull();
    const summaries = snapshot.overview?.projects ?? [];
    // The archived project without tasks is left out.
    expect(summaries.map((summary) => summary.project.name)).toEqual(["Cleanio iOS", "Website"]);
    expect(summaries[0]).toMatchObject({ currentVersionKey: "mvp", hotfixOpen: 1, ongoingOpen: 1, releaseOpsOpen: 1, epicCount: 1 });
    expect(summaries[0]?.routines).toEqual({ count: 1, failing: 0 });
    expect(summaries[1]?.versions.map((version) => version.key)).toEqual(["web-1.0"]);
    expect(snapshot.overview?.noProject).toEqual({ total: 1, open: 1, truncated: false, routines: [] });
  });

  it("treats projectId \"all\" as the overview", async () => {
    const snapshot = await harness.getData<RoadmapSnapshot>(DATA_KEYS.snapshot, { companyId: COMPANY, projectId: "all" });
    expect(snapshot.mode).toBe("overview");
  });

  it("refuses a project of another company and a missing company", async () => {
    await expect(harness.getData(DATA_KEYS.snapshot, { companyId: OTHER_COMPANY, projectId: "project-app" })).rejects.toThrow(
      "Project not found in this company",
    );
    await expect(harness.getData(DATA_KEYS.snapshot, { projectId: "project-app" })).rejects.toThrow("companyId is required");
  });

  it("reports a status that hits the cap", async () => {
    const loaded = await loadTasks(harness.ctx, COMPANY, { projectId: "project-app" }, [], 2);
    expect(loaded.truncatedStatuses).toEqual(["todo"]);
    expect(loaded.truncatedProjectIds).toEqual(["project-app"]);
    expect(loaded.tasks.filter((task) => task.status === "todo")).toHaveLength(2);
  });
});

describe("roadmap.taskVersion", () => {
  let harness: ReturnType<typeof seededHarness>;
  beforeEach(async () => {
    harness = seededHarness();
    await plugin.definition.setup(harness.ctx);
  });

  const versionOf = (issueId: string) =>
    harness.getData<TaskVersionInfo>(DATA_KEYS.taskVersion, { companyId: COMPANY, issueId });

  it("returns the own version, an inherited one, and the special kinds", async () => {
    expect(await versionOf("story-2")).toMatchObject({ kind: "version", versionKey: "mvp", inherited: false });
    expect(await versionOf("sub")).toMatchObject({
      kind: "version",
      versionKey: "mvp",
      inherited: true,
      inheritedFromIdentifier: expect.stringMatching(/^CLE-/),
    });
    expect(await versionOf("hotfix")).toMatchObject({ kind: "hotfix", versionKey: null, isHotfix: true });
    expect(await versionOf("ongoing")).toMatchObject({ kind: "ongoing", versionKey: null });
    expect(await versionOf("epic")).toMatchObject({ kind: "epic" });
    expect(await versionOf("ops")).toMatchObject({ kind: "release_ops", versionKey: "mvp" });
    expect(await versionOf("run-1")).toMatchObject({ kind: "routine" });
    expect(await versionOf("missing")).toMatchObject({ kind: "missing" });
  });

  it("does not read across companies", async () => {
    const info = await loadTaskVersion(harness.ctx, { companyId: COMPANY, issueId: "foreign" });
    expect(info.kind).toBe("missing");
  });
});

describe("SnapshotCache", () => {
  it("shares one build per key within the TTL and rebuilds on a new refresh token", async () => {
    let clock = 0;
    const cache = new SnapshotCache(15_000, () => clock);
    let builds = 0;
    const build = async () => {
      builds += 1;
      return { builds } as unknown as RoadmapSnapshot;
    };
    const request = { companyId: COMPANY, projectId: "p", cardLimit: 40, refreshToken: null };
    await Promise.all([cache.get(request, build), cache.get(request, build)]);
    expect(builds).toBe(1);
    await cache.get({ ...request, refreshToken: "1" }, build);
    expect(builds).toBe(2);
    await cache.get({ ...request, refreshToken: "1" }, build);
    await cache.get(request, build);
    expect(builds).toBe(2);
    clock = 20_000;
    await cache.get(request, build);
    expect(builds).toBe(3);
  });

  it("does not keep a failed build", async () => {
    const cache = new SnapshotCache(15_000, () => 0);
    const request = { companyId: COMPANY, projectId: null, cardLimit: 40, refreshToken: null };
    await expect(cache.get(request, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    const ok = await cache.get(request, async () => ({ ok: true }) as unknown as RoadmapSnapshot);
    expect(ok).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// A fake host that behaves like `issueService.list` where the SDK harness does
// not: rows come back by priority, then last activity (not by age), plugin
// operations are included only when the list is filtered by project or
// origin, and routine executions are always included.
// ---------------------------------------------------------------------------

const LEGACY_OPERATION_KINDS = new Set([
  "plugin:paperclipai.content-machine:case",
  "plugin:paperclipai.content-machine:evaluation",
  "plugin:paperclipai.content-machine:source-sync",
]);
const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

interface ListInput {
  companyId: string;
  projectId?: string;
  status?: string;
  originKindPrefix?: string;
  originId?: string;
  originKind?: string;
  includePluginOperations?: boolean;
  limit?: number;
  offset?: number;
}

function priorityFirstHost(issues: Issue[], projects: Project[]) {
  const calls: ListInput[] = [];
  const host = {
    issues: {
      async list(input: ListInput) {
        calls.push(input);
        const includeOperations = Boolean(
          input.includePluginOperations || input.originKind || input.originKindPrefix || input.originId || input.projectId,
        );
        const rows = issues
          .filter((row) => row.companyId === input.companyId)
          .filter((row) => !input.projectId || row.projectId === input.projectId)
          .filter((row) => !input.status || row.status === input.status)
          .filter((row) => !input.originKindPrefix || String(row.originKind ?? "").startsWith(input.originKindPrefix))
          .filter((row) => !input.originId || row.originId === input.originId)
          .filter(
            (row) =>
              includeOperations ||
              !(isPluginOperationIssueOriginKind(row.originKind) || LEGACY_OPERATION_KINDS.has(String(row.originKind))),
          )
          .sort(
            (a, b) =>
              (PRIORITY_ORDER[a.priority] ?? 4) - (PRIORITY_ORDER[b.priority] ?? 4) ||
              new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime() ||
              (a.id < b.id ? 1 : -1),
          );
        const offset = input.offset ?? 0;
        return rows.slice(offset, input.limit === undefined ? undefined : offset + input.limit);
      },
      async get(issueId: string, companyId: string) {
        return issues.find((row) => row.id === issueId && row.companyId === companyId) ?? null;
      },
    },
    projects: {
      async list(input: { companyId: string }) {
        return projects.filter((row) => row.companyId === input.companyId);
      },
    },
    agents: {
      async list(input: { companyId: string }) {
        return agents.filter((row) => row.companyId === input.companyId);
      },
    },
  } as unknown as HostReader;
  return { host, calls };
}

describe("reading tasks like the host lists them", () => {
  const projects = [project("project-app", "Cleanio iOS"), project("project-web", "Website"), project("project-wiki", "LLM Wiki")];

  it("leaves plugin operations out of the project view and the overview alike", async () => {
    const issues = [
      issue({ id: "work", projectId: "project-wiki", status: "todo" }),
      issue({ id: "done-work", projectId: "project-wiki", status: "done", completedAt: daysAgo(1) }),
      issue({ id: "op", projectId: "project-wiki", status: "todo", originKind: "plugin:paperclipai.llm-wiki:operation" }),
      issue({ id: "op-sub", projectId: "project-wiki", status: "done", originKind: "plugin:paperclipai.llm-wiki:operation:ingest" }),
      issue({ id: "legacy", projectId: "project-wiki", status: "todo", originKind: "plugin:paperclipai.content-machine:case" }),
      issue({ id: "not-op", projectId: "project-wiki", status: "todo", originKind: "plugin:paperclipai.llm-wiki:operational" }),
    ];
    const { host } = priorityFirstHost(issues, projects);
    const request = { companyId: COMPANY, cardLimit: 40, refreshToken: null };
    const projectView = await buildSnapshot(host, { ...request, projectId: "project-wiki" });
    const overview = await buildSnapshot(host, { ...request, projectId: null });

    const ongoing = projectView.roadmap?.lanes.find((lane) => lane.id === "ongoing");
    const cardIds = ongoing?.columns.flatMap((column) => column.cards.map((card) => card.id)) ?? [];
    expect(cardIds.sort()).toEqual(["done-work", "not-op", "work"]);
    expect(projectView.stats.pluginOperationsSkipped).toBe(3);

    const summary = overview.overview?.projects.find((entry) => entry.project.id === "project-wiki");
    expect(projectView.roadmap?.totals).toMatchObject({ tasks: 3, open: 2 });
    expect(summary?.totals).toEqual({ tasks: 3, open: 2 });
    expect(summary?.counts).toMatchObject({ todo: 2, done: 1 });
  });

  it("does not let routine runs use up the cap of real tasks", async () => {
    const issues = [
      ...[1, 2, 3].map((n) => issue({ id: `real-${n}`, status: "done", priority: "low", completedAt: daysAgo(n) })),
      ...[1, 2, 3, 4, 5].map((n) =>
        issue({ id: `run-${n}`, status: "done", priority: "high", originKind: "routine_execution", originId: "routine-1", createdAt: daysAgo(n) }),
      ),
    ];
    const { host } = priorityFirstHost(issues, projects);
    const routines = await loadRoutineExecutions(host, COMPANY, "project-app");
    const loaded = await loadTasks(host, COMPANY, { projectId: "project-app" }, routines.executions, 3);
    expect(loaded.truncatedStatuses).toEqual([]);
    expect(loaded.tasks.filter((task) => task.id.startsWith("real-")).map((task) => task.id).sort()).toEqual(["real-1", "real-2", "real-3"]);

    // Without the known runs the high-priority runs fill the window and every real task is lost.
    const blind = await loadTasks(host, COMPANY, { projectId: "project-app" }, [], 3);
    expect(blind.truncatedStatuses).toEqual(["done"]);
    expect(blind.tasks.some((task) => task.id.startsWith("real-"))).toBe(false);
  });

  it("re-reads a full status per project in the overview so one big project does not hide the others", async () => {
    const issues = [
      ...[1, 2, 3, 4].map((n) => issue({ id: `app-${n}`, status: "done", priority: "high", completedAt: daysAgo(n) })),
      issue({ id: "web-low", projectId: "project-web", status: "done", priority: "low", completedAt: daysAgo(1) }),
      issue({ id: "loose", projectId: null, status: "done", priority: "low", completedAt: daysAgo(1) }),
    ];
    const { host, calls } = priorityFirstHost(issues, projects);
    const loaded = await loadTasks(host, COMPANY, { projectId: null, projectIds: projects.map((entry) => entry.id) }, [], 3);
    expect(loaded.tasks.map((task) => task.id)).toContain("web-low");
    expect(loaded.truncatedStatuses).toEqual(["done"]);
    expect(loaded.truncatedProjectIds).toEqual(["project-app"]);
    expect(loaded.noProjectTruncated).toBe(true);
    expect(calls.filter((call) => call.status === "done").map((call) => call.projectId ?? "*")).toEqual([
      "*",
      "project-app",
      "project-web",
      "project-wiki",
    ]);
    // Statuses that fit stay one company-wide call each.
    expect(calls.filter((call) => call.status === "todo")).toHaveLength(1);
  });

  it("lists routines without a project in the overview", async () => {
    const issues = [
      issue({ id: "company-run-1", projectId: null, status: "done", originKind: "routine_execution", originId: "routine-co", title: "Weekly digest", createdAt: daysAgo(1) }),
      issue({ id: "company-run-2", projectId: null, status: "blocked", originKind: "routine_execution", originId: "routine-co", title: "Weekly digest", createdAt: daysAgo(8) }),
      issue({ id: "loose", projectId: null, status: "todo" }),
    ];
    const { host } = priorityFirstHost(issues, projects);
    const snapshot = await buildSnapshot(host, { companyId: COMPANY, projectId: null, cardLimit: 40, refreshToken: null });
    expect(snapshot.overview?.noProject).toMatchObject({ total: 1, open: 1, truncated: false });
    expect(snapshot.overview?.noProject.routines).toEqual([
      expect.objectContaining({ routineId: "routine-co", title: "Weekly digest", runCount: 2 }),
    ]);
  });
});

describe("task chip and board agree", () => {
  it("places every task of a project in the same spot", async () => {
    const issues = [
      issue({ id: "epic-ops", status: "backlog", labelNames: ["type:epic", "release-ops"] }),
      issue({ id: "release", status: "todo", labelNames: ["release-ops", "v:1.0"] }),
      issue({ id: "under-release", parentId: "release", status: "done", completedAt: daysAgo(1), labelNames: ["v:1.0"] }),
      issue({ id: "inherits", parentId: "release", status: "todo" }),
      issue({ id: "hot", status: "todo", labelNames: ["type:hotfix", "v:mvp"] }),
      issue({ id: "plain", status: "in_progress" }),
      issue({ id: "web-parent", projectId: "project-web", status: "todo", labelNames: ["v:2.0"] }),
      issue({ id: "cross", parentId: "web-parent", status: "todo" }),
      issue({ id: "case", status: "todo", labelNames: ["v:MVP"] }),
    ];
    const { host } = priorityFirstHost(issues, [project("project-app", "Cleanio iOS"), project("project-web", "Website")]);
    const snapshot = await buildSnapshot(host, { companyId: COMPANY, projectId: "project-app", cardLimit: 40, refreshToken: null });
    const laneOf = new Map<string, string>();
    for (const lane of snapshot.roadmap?.lanes ?? []) {
      for (const column of lane.columns) for (const card of column.cards) laneOf.set(card.id, lane.kind);
    }
    for (const epic of snapshot.roadmap?.epics ?? []) laneOf.set(epic.id, "epic");

    const chipKind = async (issueId: string) => (await loadTaskVersion(host, { companyId: COMPANY, issueId })).kind;
    for (const id of ["epic-ops", "release", "under-release", "inherits", "hot", "plain", "cross", "case"]) {
      const kind = await chipKind(id);
      expect([id, kind]).toEqual([id, laneOf.get(id)]);
    }
    expect(await loadTaskVersion(host, { companyId: COMPANY, issueId: "cross" })).toMatchObject({ kind: "ongoing", versionKey: null });
    expect(await loadTaskVersion(host, { companyId: COMPANY, issueId: "case" })).toMatchObject({ kind: "version", versionKey: "MVP" });
  });
});
