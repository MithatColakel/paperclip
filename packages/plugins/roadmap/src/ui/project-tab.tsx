import { useMemo, useState } from "react";
import { Spinner, useHostNavigation, usePluginData, type PluginDetailTabProps } from "@paperclipai/plugin-sdk/ui";
import type { RoadmapSnapshot } from "../domain/types.ts";
import { EmptyState, ErrorBanner, LabelHelp, ProgressBar, StateBadge, laneSummary, laneTitle } from "./components.tsx";
import { plural } from "./copy.ts";
import { formatTime, roadmapHref, useLastGood } from "./hooks.ts";
import { RepeatIcon } from "./icons.tsx";
import { SNAPSHOT_KEY } from "./page.tsx";
import { T, sp, useRoadmapStyles } from "./styles.ts";

/** Project page tab: the project's lanes in one compact column, plus a link to the full Roadmap. */
export function ProjectRoadmapTab({ context }: PluginDetailTabProps) {
  useRoadmapStyles();
  const navigation = useHostNavigation();
  const projectId = context.entityId;
  const companyId = context.companyId;
  // A new token makes the worker skip its 15 s cache, as the page's Refresh does.
  const [refreshToken, setRefreshToken] = useState<string | null>(null);
  const params = useMemo(
    () => ({ companyId, projectId, cardLimit: 5, ...(refreshToken ? { refreshToken } : {}) }),
    [companyId, projectId, refreshToken],
  );
  const result = usePluginData<RoadmapSnapshot>(SNAPSHOT_KEY, params);
  const manualRefresh = () => {
    const token = String(Date.now());
    if (token === refreshToken) result.refresh();
    else setRefreshToken(token);
  };
  const snapshot = useLastGood(`${companyId}|tab|${projectId}`, result.data, (data) => data.projectId === projectId && data.mode === "project");
  const roadmap = snapshot?.roadmap ?? null;

  return (
    <div className="rm-root" style={{ gap: sp(3) }}>
      <div className="rm-row" style={{ justifyContent: "space-between" }}>
        <span className="rm-muted" style={{ fontSize: T.textCompact }}>
          {snapshot ? `Read-only view of this project's flow · updated ${formatTime(snapshot.generatedAt)}` : "Read-only view of this project's flow"}
        </span>
        <span className="rm-row">
          <button type="button" className="rm-btn" onClick={manualRefresh} disabled={result.loading}>
            Refresh
          </button>
          <a {...navigation.linkProps(roadmapHref(projectId, "flow"))} className="rm-btn">
            Open Roadmap
          </a>
        </span>
      </div>

      {result.error ? (
        <ErrorBanner
          message={snapshot ? "Could not refresh the Roadmap." : "Could not load the Roadmap."}
          detail={result.error.message}
          onRetry={manualRefresh}
        />
      ) : null}

      {!roadmap ? (
        result.loading ? (
          <div className="rm-row rm-muted">
            <Spinner />
            Loading…
          </div>
        ) : null
      ) : roadmap.totals.tasks === 0 && roadmap.routines.length === 0 ? (
        <EmptyState title="No tasks in this project yet">
          <LabelHelp />
        </EmptyState>
      ) : (
        <div className="rm-panel" style={{ gap: 0, padding: 0 }}>
          {roadmap.lanes.map((lane) => (
            <div key={lane.id} className="rm-routine" style={{ padding: `${sp(2.5)} ${sp(3)}` }}>
              <span className="rm-row" style={{ minWidth: 0, flex: "1 1 var(--sz-240px)" }}>
                {laneTitle(lane)}
                {lane.kind === "version" ? <StateBadge state={lane.state} /> : null}
              </span>
              {lane.kind === "version" ? <ProgressBar progress={lane.progress} label={`Version ${lane.key} progress`} /> : null}
              <span className="rm-muted" style={{ fontSize: T.textXs }}>
                {laneSummary(lane)}
              </span>
            </div>
          ))}
          <div className="rm-routine" style={{ padding: `${sp(2.5)} ${sp(3)}` }}>
            <span className="rm-row" style={{ fontWeight: T.weightSemibold, flex: "1 1 var(--sz-240px)" }}>
              <RepeatIcon />
              Routines
            </span>
            <span className="rm-muted" style={{ fontSize: T.textXs }}>
              {plural(roadmap.routines.length, "routine")} with runs in 30 days
              {roadmap.routines.some((routine) => routine.failing)
                ? ` · ${roadmap.routines.filter((routine) => routine.failing).length} failing`
                : ""}
            </span>
          </div>
        </div>
      )}
      {roadmap && roadmap.totals.versions === 0 && roadmap.totals.tasks > 0 ? (
        <span className="rm-muted" style={{ fontSize: T.textCompact }}>
          <LabelHelp />
        </span>
      ) : null}
    </div>
  );
}
