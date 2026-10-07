import type { ProjectSummary, RoadmapSnapshot } from "../domain/types.ts";
import { EmptyState, LabelHelp, Pill, ProgressBar, StateBadge, progressText } from "./components.tsx";
import { BoltIcon, RepeatIcon } from "./icons.tsx";
import { plural } from "./copy.ts";
import { RoutineList } from "./flow.tsx";
import { STATE_COLORS, STATE_DOT_COLORS, T, sp } from "./styles.ts";

export function OverviewView({
  overview,
  onOpenProject,
}: {
  overview: NonNullable<RoadmapSnapshot["overview"]>;
  onOpenProject: (projectId: string) => void;
}) {
  // `?? []`: a worker one build older than the UI bundle (mid-deploy) sends no routines.
  const noProjectRoutines = overview.noProject.routines ?? [];
  const hasNoProject = overview.noProject.total > 0 || noProjectRoutines.length > 0;
  if (overview.projects.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: sp(3), minWidth: 0 }}>
        <EmptyState title="No projects yet">
          <span>Create a project and give its tasks labels to see them on the Roadmap.</span>
          <LabelHelp />
        </EmptyState>
        {hasNoProject ? <NoProjectCard noProject={overview.noProject} /> : null}
      </div>
    );
  }
  const anyVersions = overview.projects.some((summary) => summary.versions.length > 0);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: sp(3), minWidth: 0 }}>
      {!anyVersions ? (
        <div className="rm-banner rm-banner-info">
          <span>
            <strong style={{ fontWeight: T.weightSemibold }}>No versions yet. </strong>
            <LabelHelp />
          </span>
        </div>
      ) : null}
      <div className="rm-grid">
        {overview.projects.map((summary) => (
          <ProjectCard key={summary.project.id} summary={summary} onOpen={() => onOpenProject(summary.project.id)} />
        ))}
        {hasNoProject ? <NoProjectCard noProject={overview.noProject} /> : null}
      </div>
    </div>
  );
}

function ProjectCard({ summary, onOpen }: { summary: ProjectSummary; onOpen: () => void }) {
  const current = summary.versions.find((version) => version.key === summary.currentVersionKey) ?? null;
  const others = summary.versions.filter((version) => version.key !== summary.currentVersionKey);
  return (
    <div className="rm-panel">
      <div className="rm-row" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
        <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <strong className="rm-truncate" style={{ fontWeight: T.weightSemibold, fontSize: T.textBase }}>
            {summary.project.name}
          </strong>
          <span className="rm-muted rm-truncate" style={{ fontSize: T.textXs }}>
            {summary.project.leadAgentName ? `Lead ${summary.project.leadAgentName}` : "No lead"}
            {summary.project.archived ? " · archived" : ""}
          </span>
        </span>
        <button type="button" className="rm-btn" onClick={onOpen}>
          Open flow
        </button>
      </div>

      {current ? (
        <div style={{ display: "flex", flexDirection: "column", gap: sp(1.5) }}>
          <span className="rm-row">
            <span className="rm-dot" style={{ background: STATE_DOT_COLORS[current.state] }} />
            <span style={{ fontWeight: T.weightMedium }}>Version</span>
            <span className="rm-mono" style={{ fontWeight: T.weightSemibold }}>
              {current.key}
            </span>
            <StateBadge state={current.state} />
          </span>
          <span className="rm-row">
            <ProgressBar progress={current.progress} label={`Version ${current.key} progress`} />
            <span className="rm-muted" style={{ fontSize: T.textXs }}>
              {progressText(current.progress)}
            </span>
          </span>
        </div>
      ) : (
        <span className="rm-muted" style={{ fontSize: T.textCompact }}>
          {summary.versions.length > 0 ? "Every version is done." : "No versions. All work is Ongoing."}
        </span>
      )}

      {others.length > 0 ? (
        <span className="rm-row" role="group" aria-label="Other versions">
          {others.map((version) => (
            <Pill key={version.key} color={STATE_COLORS[version.state]} title={`${version.key}: ${progressText(version.progress)}`}>
              <span className="rm-mono">{version.key}</span>
              {version.progress.pct !== null ? ` ${Math.round(version.progress.pct * 100)}%` : ""}
            </Pill>
          ))}
        </span>
      ) : null}

      <div className="rm-stats">
        <Stat label="Open" value={summary.totals.open} />
        <Stat label="Blocked" value={summary.counts.blocked} />
        <Stat label="In review" value={summary.counts.in_review} />
        <Stat label="Ongoing" value={summary.ongoingOpen} hint={summary.ongoingOldestDays !== null && summary.ongoingOpen > 0 ? `oldest ${summary.ongoingOldestDays}d` : undefined} />
        <Stat label="Epics" value={summary.epicCount} />
        <Stat label="Release ops" value={summary.releaseOpsOpen} />
      </div>

      <span className="rm-row rm-muted" style={{ fontSize: T.textXs }}>
        {summary.hotfixOpen > 0 ? (
          <span className="rm-row" style={{ color: T.destructive, flexWrap: "nowrap" }}>
            <BoltIcon size={3} />
            {plural(summary.hotfixOpen, "open hotfix", "open hotfixes")}
          </span>
        ) : null}
        <span className="rm-row" style={{ flexWrap: "nowrap" }}>
          <RepeatIcon size={3} />
          {plural(summary.routines.count, "routine")}
          {summary.routines.failing > 0 ? `, ${summary.routines.failing} failing` : ""}
        </span>
        {summary.warnings > 0 ? <span>{plural(summary.warnings, "label check")}</span> : null}
      </span>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <span className="rm-stat">
      <span className="rm-muted" style={{ fontSize: T.textXs }}>
        {label}
      </span>
      <strong>{value}</strong>
      {hint ? (
        <span className="rm-muted" style={{ fontSize: T.textNano }}>
          {hint}
        </span>
      ) : null}
    </span>
  );
}

function NoProjectCard({ noProject }: { noProject: NonNullable<RoadmapSnapshot["overview"]>["noProject"] }) {
  const atLeast = noProject.truncated ? "at least " : "";
  const routines = noProject.routines ?? [];
  const failing = routines.filter((routine) => routine.failing).length;
  return (
    <div className="rm-panel">
      <strong style={{ fontWeight: T.weightSemibold }}>No project</strong>
      {noProject.total > 0 ? (
        <span className="rm-muted" style={{ fontSize: T.textCompact }}>
          {atLeast}
          {plural(noProject.total, "task has", "tasks have")} no project ({atLeast}
          {noProject.open} open), so {noProject.total === 1 ? "it is" : "they are"} not on any Roadmap. Move{" "}
          {noProject.total === 1 ? "it" : "them"} into a project to place {noProject.total === 1 ? "it" : "them"} in a lane.
        </span>
      ) : null}
      {routines.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: sp(1) }}>
          <span className="rm-row" style={{ fontWeight: T.weightMedium }}>
            <RepeatIcon size={3.5} />
            Routines without a project ({routines.length})
            {failing > 0 ? (
              <span className="rm-muted" style={{ fontWeight: T.weightMedium, fontSize: T.textXs }}>
                {failing} failing
              </span>
            ) : null}
          </span>
          <RoutineList routines={routines} />
        </div>
      ) : null}
    </div>
  );
}
