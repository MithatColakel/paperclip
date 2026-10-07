/**
 * Roadmap URLs (plan §10.3), without the company prefix the host adds:
 *
 *   /roadmap                          last project and view used, else a guess
 *   /roadmap/overview                 one card per project
 *   /roadmap/flow?project=<id>        the board
 *   /roadmap/list?project=<id>        the same lanes as tables
 *
 * The first v0.1 build used `/roadmap?project=<id>&view=<view>`. Those links
 * are still read (`legacy: true`) and the page rewrites them to the sub-path
 * form. Later phases add `/roadmap/backlog`, `/roadmap/versions/<id>`, …
 */

export const PAGE_PATH = "/roadmap";

export type RoadmapView = "flow" | "list" | "overview";
const VIEWS: ReadonlySet<string> = new Set(["flow", "list", "overview"]);

export interface RoadmapRoute {
  projectId: string | null;
  view: RoadmapView | null;
  /** The URL names no view and no project: reopen the last one. */
  bare: boolean;
  /** The URL uses the old query form (`?view=`, or `?project=` without a view path) and should be rewritten. */
  legacy: boolean;
}

const ROADMAP_PATH = /\/roadmap(?:\/([^/]+))?\/*$/i;

export function parseRoadmapLocation(pathname: string, search: string): RoadmapRoute {
  const params = new URLSearchParams(search);
  const segment = ROADMAP_PATH.exec(pathname)?.[1]?.toLowerCase() ?? null;
  const pathView = segment && VIEWS.has(segment) ? (segment as RoadmapView) : null;
  const queryView = params.get("view");
  const legacyView = queryView && VIEWS.has(queryView) ? (queryView as RoadmapView) : null;
  const project = params.get("project");
  const projectId = project && project !== "all" ? project : null;
  return {
    projectId,
    view: pathView ?? legacyView,
    bare: pathView === null && legacyView === null && projectId === null,
    legacy: pathView === null && (legacyView !== null || projectId !== null),
  };
}

/** The canonical href of a view. Overview never carries a project. */
export function roadmapHref(projectId: string | null, view: RoadmapView): string {
  if (view === "overview" || !projectId) return `${PAGE_PATH}/overview`;
  return `${PAGE_PATH}/${view}?project=${encodeURIComponent(projectId)}`;
}
