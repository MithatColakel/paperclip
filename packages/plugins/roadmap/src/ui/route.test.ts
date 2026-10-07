import { describe, expect, it } from "vitest";
import { parseRoadmapLocation, roadmapHref } from "./route.ts";

describe("Roadmap routes", () => {
  it("reads the sub-path views of plan §10.3", () => {
    expect(parseRoadmapLocation("/PAP/roadmap/overview", "")).toEqual({ projectId: null, view: "overview", bare: false, legacy: false });
    expect(parseRoadmapLocation("/PAP/roadmap/flow", "?project=p1")).toEqual({ projectId: "p1", view: "flow", bare: false, legacy: false });
    expect(parseRoadmapLocation("/PAP/roadmap/list/", "?project=p1")).toMatchObject({ projectId: "p1", view: "list", legacy: false });
  });

  it("treats a bare /roadmap as 'reopen the last view'", () => {
    expect(parseRoadmapLocation("/PAP/roadmap", "")).toEqual({ projectId: null, view: null, bare: true, legacy: false });
    expect(parseRoadmapLocation("/PAP/roadmap/versions/123", "")).toMatchObject({ bare: true });
  });

  it("still reads the first v0.1 links and marks them for a rewrite", () => {
    expect(parseRoadmapLocation("/PAP/roadmap", "?project=p1&view=list")).toEqual({ projectId: "p1", view: "list", bare: false, legacy: true });
    expect(parseRoadmapLocation("/PAP/roadmap", "?project=p1")).toEqual({ projectId: "p1", view: null, bare: false, legacy: true });
    expect(parseRoadmapLocation("/PAP/roadmap", "?view=overview")).toMatchObject({ view: "overview", legacy: true });
  });

  it("builds canonical links; the overview never carries a project", () => {
    expect(roadmapHref("p 1", "flow")).toBe("/roadmap/flow?project=p%201");
    expect(roadmapHref("p1", "list")).toBe("/roadmap/list?project=p1");
    expect(roadmapHref("p1", "overview")).toBe("/roadmap/overview");
    expect(roadmapHref(null, "flow")).toBe("/roadmap/overview");
  });
});
