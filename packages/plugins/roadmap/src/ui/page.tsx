import { useEffect, useMemo, useRef, useState } from "react";
import { Spinner, usePluginData, type PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import type { RoadmapSnapshot, RoadmapWarning, WarningCode } from "../domain/types.ts";
import { STATUS_LABELS } from "../domain/types.ts";
import { EmptyState, ErrorBanner } from "./components.tsx";
import { listText, plural } from "./copy.ts";
import { FlowView } from "./flow.tsx";
import {
  formatTime,
  lastRouteKey,
  readStorage,
  useIsMobile,
  useLastGood,
  useRefreshOnFocus,
  useRoadmapRoute,
  type RoadmapView,
} from "./hooks.ts";
import { RefreshIcon, RoadmapIcon } from "./icons.tsx";
import { ListView } from "./list.tsx";
import { OverviewView } from "./overview.tsx";
import { T, sp, useRoadmapStyles } from "./styles.ts";

export const SNAPSHOT_KEY = "roadmap.snapshot";

const VIEW_LABELS: Record<RoadmapView, string> = { flow: "Flow", list: "List", overview: "Overview" };

const WARNING_TEXT: Record<WarningCode, (count: number) => string> = {
  label_conflict: (count) => `${plural(count, "task carries", "tasks carry")} more than one v: label; the earliest version is used.`,
  label_case_variant: (count) =>
    `${plural(count, "task uses", "tasks use")} a v: label that differs from another one only in case (for example v:MVP and v:mvp). They are shown as one version; use one spelling.`,
  epic_with_version_label: (count) => `${plural(count, "epic carries", "epics carry")} a v: label; labels on epics are ignored. Label the stories instead.`,
  unlabelled_child_of_version_task: (count) =>
    count === 1
      ? `1 sub-task has no v: label of its own and inherits its parent's version (shown as "inherited").`
      : `${count} sub-tasks have no v: label of their own and inherit their parent's version (shown as "inherited").`,
  hotfix_unassigned: (count) => `${plural(count, "open hotfix has", "open hotfixes have")} no assignee.`,
};

export function RoadmapPage({ context }: PluginPageProps) {
  useRoadmapStyles();
  if (!context.companyId) {
    return (
      <div className="rm-root">
        <EmptyState title="Select a company to see its Roadmap" />
      </div>
    );
  }
  return <RoadmapPageBody companyId={context.companyId} />;
}

function RoadmapPageBody({ companyId }: { companyId: string }) {
  const isMobile = useIsMobile();
  const { route, setRoute } = useRoadmapRoute(companyId);
  const [refreshToken, setRefreshToken] = useState<string | null>(null);

  // A link in the first v0.1 form (?project=&view=) is rewritten to the
  // sub-path form so later views can share the URL scheme.
  const legacyRewritten = useRef(false);
  useEffect(() => {
    if (legacyRewritten.current || !route.legacy) return;
    legacyRewritten.current = true;
    setRoute(route.view === "overview" ? null : route.projectId, route.view ?? "flow", { replace: true });
  }, [route, setRoute]);

  // A bare /roadmap opens the last project and view this viewer used. The
  // remembered route is used for the first request right away, and the URL
  // is rewritten so it can be shared.
  const remembered = useMemo(
    () => (route.bare ? readStorage<{ projectId?: string | null; view?: RoadmapView }>(lastRouteKey(companyId)) : null),
    [companyId, route.bare],
  );
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !remembered || (!remembered.projectId && !remembered.view)) return;
    restored.current = true;
    setRoute(remembered.projectId ?? null, remembered.view ?? "flow", { replace: true });
  }, [remembered, setRoute]);

  const routeProjectId = route.bare ? remembered?.projectId ?? null : route.projectId;
  const requestedView = route.bare ? remembered?.view ?? null : route.view;
  const view: RoadmapView = routeProjectId ? requestedView ?? "flow" : "overview";
  const mode = routeProjectId && view !== "overview" ? "project" : "overview";
  // The overview is always all projects: the header and the switcher say so.
  const projectId = mode === "project" ? routeProjectId : null;
  const requestProjectId = projectId;

  const params = useMemo(
    () => ({ companyId, projectId: requestProjectId, ...(refreshToken ? { refreshToken } : {}) }),
    [companyId, requestProjectId, refreshToken],
  );
  const result = usePluginData<RoadmapSnapshot>(SNAPSHOT_KEY, params);
  const cacheKey = `${companyId}|${mode}|${requestProjectId ?? "*"}`;
  const snapshot = useLastGood(cacheKey, result.data, (data) =>
    data.companyId === companyId && data.mode === mode && data.projectId === requestProjectId,
  );
  useRefreshOnFocus(result.refresh);

  // With nothing remembered, a company with exactly one project (or one with versions) opens its flow.
  const autoPicked = useRef(false);
  useEffect(() => {
    if (autoPicked.current || !route.bare || remembered || !snapshot?.overview) return;
    autoPicked.current = true;
    const live = snapshot.overview.projects.filter((summary) => !summary.project.archived);
    const withVersions = live.filter((summary) => summary.versions.length > 0);
    const pick = withVersions.length === 1 ? withVersions[0] : live.length === 1 ? live[0] : null;
    if (pick) setRoute(pick.project.id, "flow", { replace: true });
  }, [remembered, route.bare, setRoute, snapshot]);

  const projects = (snapshot?.projects ?? result.data?.projects ?? []).filter(
    (project) => !project.archived || project.id === projectId,
  );
  const currentProject = projects.find((project) => project.id === projectId) ?? null;
  const loading = result.loading;
  const error = result.error;

  const manualRefresh = () => {
    const token = String(Date.now());
    if (token === refreshToken) result.refresh();
    else setRefreshToken(token);
  };

  const collapseKey = `paperclip.roadmap.collapsed.${companyId}.${projectId ?? "all"}`;

  return (
    <div className="rm-root">
      <header className="rm-header">
        <div className="rm-header-title">
          <RoadmapIcon size={5} />
          <h1>Roadmap</h1>
          <span className="rm-muted rm-truncate" style={{ fontSize: T.textCompact }}>
            {currentProject ? currentProject.name : "All projects"}
          </span>
        </div>
        <div className="rm-controls">
          <label className="rm-sr-only" htmlFor="rm-project-select">
            Project
          </label>
          <select
            id="rm-project-select"
            className="rm-select"
            value={projectId ?? "all"}
            onChange={(event) => {
              const next = event.target.value === "all" ? null : event.target.value;
              setRoute(next, next ? (view === "overview" ? "flow" : view) : "overview");
            }}
          >
            <option value="all">All projects (overview)</option>
            {projectId && !currentProject ? <option value={projectId}>Selected project</option> : null}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
                {project.archived ? " (archived)" : ""}
              </option>
            ))}
          </select>
          <div className="rm-seg" role="group" aria-label="View">
            {(["flow", "list", "overview"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={view === option}
                disabled={!projectId && option !== "overview"}
                title={!projectId && option !== "overview" ? "Pick a project first" : undefined}
                onClick={() => setRoute(option === "overview" ? null : projectId, option)}
              >
                {VIEW_LABELS[option]}
              </button>
            ))}
          </div>
          <button type="button" className="rm-btn" onClick={manualRefresh} disabled={loading} aria-label="Refresh">
            <RefreshIcon />
            <span className="rm-hide-mobile">{loading && snapshot ? "Refreshing…" : "Refresh"}</span>
          </button>
          {snapshot ? (
            <span className="rm-muted rm-hide-mobile" style={{ fontSize: T.textXs }}>
              Updated {formatTime(snapshot.generatedAt)}
            </span>
          ) : null}
        </div>
      </header>

      {error ? (
        <ErrorBanner
          message={snapshot ? "Could not refresh the Roadmap." : "Could not load the Roadmap."}
          detail={`${error.message}${snapshot ? ` Showing the data loaded at ${formatTime(snapshot.generatedAt)}.` : ""}`}
          onRetry={manualRefresh}
          action={
            projectId && /not found/i.test(error.message) ? (
              <button type="button" className="rm-btn" onClick={() => setRoute(null, "overview")}>
                Show all projects
              </button>
            ) : undefined
          }
        />
      ) : null}

      {snapshot ? <SnapshotNotices snapshot={snapshot} /> : null}

      {!snapshot ? (
        loading || !error ? (
          <div className="rm-row rm-muted" style={{ padding: sp(6), justifyContent: "center" }}>
            <Spinner />
            Loading the Roadmap…
          </div>
        ) : null
      ) : mode === "overview" && snapshot.overview ? (
        <OverviewView overview={snapshot.overview} onOpenProject={(id) => setRoute(id, "flow")} />
      ) : snapshot.roadmap ? (
        view === "list" ? (
          <ListView roadmap={snapshot.roadmap} isMobile={isMobile} />
        ) : (
          <FlowView roadmap={snapshot.roadmap} isMobile={isMobile} storageKey={collapseKey} />
        )
      ) : null}
    </div>
  );
}

function truncationText(snapshot: RoadmapSnapshot): string | null {
  const truncated = snapshot.truncatedStatuses;
  if (truncated.length === 0) return null;
  const cap = snapshot.limits.perStatusCap;
  const statuses = listText(truncated.map((status) => STATUS_LABELS[status]));
  const order = "The host returns tasks by priority, then by last activity, so the tasks left out are lower-priority ones, whatever their age.";
  if (snapshot.mode === "project") {
    return `This project has more than ${cap} tasks in ${statuses}. Only the first ${cap} per status were loaded. ${order} Counts, progress and the Done column for ${truncated.length === 1 ? "this status" : "these statuses"} are lower bounds.`;
  }
  const names = new Map(snapshot.projects.map((project) => [project.id, project.name]));
  const projects = (snapshot.truncatedProjectIds ?? []).map((id) => names.get(id) ?? "Unknown project");
  return `${plural(projects.length, "project has", "projects have")} more than ${cap} tasks in ${statuses}: ${listText(projects)}. The overview loads at most ${cap} tasks per project and status. ${order} Their counts are lower bounds.`;
}

function SnapshotNotices({ snapshot }: { snapshot: RoadmapSnapshot }) {
  const warnings: RoadmapWarning[] = snapshot.roadmap?.warnings ?? [];
  const truncation = truncationText(snapshot);
  if (!truncation && !snapshot.routinesTruncated && warnings.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: sp(2) }}>
      {truncation ? (
        <div className="rm-banner rm-banner-info" role="status">
          <span>{truncation}</span>
        </div>
      ) : null}
      {snapshot.routinesTruncated ? (
        <div className="rm-banner rm-banner-info" role="status">
          <span>
            Routines: only the first {snapshot.limits.routineCap} routine runs {snapshot.mode === "project" ? "of this project" : "of the company"} were
            read. The host returns them by priority, then by last activity, so routines with a lower priority may be missing
            and run counts are lower bounds.
          </span>
        </div>
      ) : null}
      {warnings.length > 0 ? (
        <details className="rm-banner rm-banner-info rm-details">
          <summary>
            Label checks ({warnings.reduce((sum, warning) => sum + warning.count, 0)})
          </summary>
          <ul style={{ margin: 0, paddingLeft: sp(5), display: "flex", flexDirection: "column", gap: sp(1), width: "100%" }}>
            {warnings.map((warning) => (
              <li key={warning.code}>
                {WARNING_TEXT[warning.code](warning.count)}
                {warning.identifiers.length > 0 ? (
                  <span className="rm-muted rm-mono" style={{ fontSize: T.textXs }}>
                    {" "}
                    {warning.identifiers.join(", ")}
                    {warning.count > warning.identifiers.length ? ", …" : ""}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
