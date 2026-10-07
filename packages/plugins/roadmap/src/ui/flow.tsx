import { useMemo, useState } from "react";
import { useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import {
  ATTENTION_ORDER,
  COLUMN_LABELS,
  STATUS_LABELS,
  type ColumnKey,
  type ColumnSlice,
  type ProjectRoadmap,
  type RoadmapLane,
  type RoutineGroup,
} from "../domain/types.ts";
import { EmptyState, LabelHelp, ProgressBar, StateBadge, StatusDot, TaskCard, laneSummary, laneTitle } from "./components.tsx";
import { useCollapsedLanes, formatRelativeDays } from "./hooks.ts";
import { ChevronIcon, EpicIcon, RepeatIcon } from "./icons.tsx";
import { T, sp, statusDotColor, tint } from "./styles.ts";
import { plural } from "./copy.ts";

const MOBILE_GROUP_PREVIEW = 5;

function defaultCollapsed(roadmap: ProjectRoadmap): Set<string> {
  const collapsed = new Set<string>();
  for (const lane of roadmap.lanes) {
    if (lane.kind === "version" && lane.state === "done") collapsed.add(lane.id);
  }
  return collapsed;
}

export function FlowView({
  roadmap,
  isMobile,
  storageKey,
}: {
  roadmap: ProjectRoadmap;
  isMobile: boolean;
  storageKey: string;
}) {
  const defaults = useMemo(() => defaultCollapsed(roadmap), [roadmap]);
  const { isCollapsed, toggle } = useCollapsedLanes(storageKey, defaults);
  const hasVersions = roadmap.lanes.some((lane) => lane.kind === "version");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: sp(3), minWidth: 0 }}>
      {!hasVersions && roadmap.totals.tasks > 0 ? (
        <div className="rm-banner rm-banner-info">
          <span>
            <strong style={{ fontWeight: T.weightSemibold }}>No versions yet. </strong>
            <LabelHelp />
          </span>
        </div>
      ) : null}
      {roadmap.totals.tasks === 0 && roadmap.routines.length === 0 ? (
        <EmptyState title="No tasks in this project yet">
          <LabelHelp />
        </EmptyState>
      ) : null}
      {roadmap.lanes.map((lane) => (
        <LaneSection
          key={lane.id}
          lane={lane}
          collapsed={isCollapsed(lane.id)}
          onToggle={() => toggle(lane.id)}
          isMobile={isMobile}
        />
      ))}
      <RoutinesBand
        routines={roadmap.routines}
        collapsed={isCollapsed("routines")}
        onToggle={() => toggle("routines")}
      />
    </div>
  );
}

function LaneSection({
  lane,
  collapsed,
  onToggle,
  isMobile,
}: {
  lane: RoadmapLane;
  collapsed: boolean;
  onToggle: () => void;
  isMobile: boolean;
}) {
  const bodyId = `rm-lane-${lane.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  return (
    <section className="rm-lane" aria-label={lane.kind === "version" ? `Version ${lane.key}` : lane.title}>
      <button type="button" className="rm-lane-head" aria-expanded={!collapsed} aria-controls={bodyId} onClick={onToggle}>
        <ChevronIcon open={!collapsed} />
        {laneTitle(lane)}
        {lane.kind === "version" ? <StateBadge state={lane.state} /> : null}
        {lane.kind === "version" ? <ProgressBar progress={lane.progress} label={`Version ${lane.key} progress`} /> : null}
        <span className="rm-muted" style={{ fontSize: T.textCompact }}>
          {laneSummary(lane)}
        </span>
      </button>
      {collapsed ? null : (
        <div className="rm-lane-body" id={bodyId}>
          {lane.epics.length > 0 ? (
            <div className="rm-epics" role="group" aria-label="Epics in this lane">
              {lane.epics.map((epic) => (
                <span key={epic.id} className="rm-pill" style={{ background: T.mutedBg, color: T.fg }} title={`Epic ${epic.identifier ?? ""}`}>
                  <EpicIcon size={3} />
                  <span className="rm-truncate" style={{ maxWidth: "var(--sz-240px)" }}>
                    {epic.title}
                  </span>
                  <span className="rm-muted">
                    {epic.done}/{Math.max(0, epic.total - epic.cancelled)}
                  </span>
                </span>
              ))}
            </div>
          ) : null}
          {lane.total === 0 ? (
            <span className="rm-muted" style={{ fontSize: T.textCompact }}>
              {lane.kind === "ongoing"
                ? "No ongoing tasks. Tasks without a v: label show here."
                : "Nothing here right now."}
            </span>
          ) : isMobile ? (
            <AttentionList lane={lane} />
          ) : (
            <Board lane={lane} />
          )}
        </div>
      )}
    </section>
  );
}

function Board({ lane }: { lane: RoadmapLane }) {
  const showVersion = lane.kind !== "version";
  return (
    <div className="rm-board-scroll">
      <div className="rm-board">
        {lane.columns.map((column) => (
          <div key={column.key} className="rm-col" role="group" aria-label={`${COLUMN_LABELS[column.key]}: ${plural(column.total, "task")}`}>
            <div className="rm-col-head" aria-hidden="true">
              <span className="rm-dot" style={{ background: statusDotColor(column.key) }} />
              <span>{column.key === "done" ? "Done · 14d" : COLUMN_LABELS[column.key]}</span>
              <span style={{ marginLeft: "auto" }}>{column.total}</span>
            </div>
            {column.cards.map((card) => (
              <TaskCard key={card.id} card={card} options={{ showVersion }} />
            ))}
            <MoreNote column={column} />
          </div>
        ))}
      </div>
    </div>
  );
}

function MoreNote({ column }: { column: ColumnSlice }) {
  const hidden = column.total - column.cards.length;
  if (hidden <= 0) return null;
  return (
    <span className="rm-muted" style={{ fontSize: T.textXs }}>
      +{hidden} more not shown
    </span>
  );
}

function AttentionList({ lane }: { lane: RoadmapLane }) {
  const [expanded, setExpanded] = useState<Partial<Record<ColumnKey, boolean>>>({});
  const showVersion = lane.kind !== "version";
  const columns = new Map(lane.columns.map((column) => [column.key, column]));
  const done = columns.get("done");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: sp(3) }}>
      {ATTENTION_ORDER.map((key) => {
        const column = columns.get(key);
        if (!column || column.total === 0) return null;
        const open = expanded[key] ?? false;
        const cards = open ? column.cards : column.cards.slice(0, MOBILE_GROUP_PREVIEW);
        return (
          <div key={key} className="rm-list-group">
            <div className="rm-col-head">
              <StatusDot status={key} />
              <span>{COLUMN_LABELS[key]}</span>
              <span style={{ marginLeft: "auto" }}>{column.total}</span>
            </div>
            {cards.map((card) => (
              <TaskCard key={card.id} card={card} options={{ showVersion }} />
            ))}
            {column.cards.length > MOBILE_GROUP_PREVIEW ? (
              <button type="button" className="rm-btn rm-btn-ghost" onClick={() => setExpanded((current) => ({ ...current, [key]: !open }))}>
                {open ? "Show fewer" : `See all ${column.cards.length}`}
              </button>
            ) : null}
            <MoreNote column={column} />
          </div>
        );
      })}
      {done && done.total > 0 ? (
        <span className="rm-muted" style={{ fontSize: T.textCompact }}>
          {STATUS_LABELS.done}: {done.total} in the last 14 days
        </span>
      ) : null}
    </div>
  );
}

function RoutinesBand({
  routines,
  collapsed,
  onToggle,
}: {
  routines: RoutineGroup[];
  collapsed: boolean;
  onToggle: () => void;
}) {
  const navigation = useHostNavigation();
  const failing = routines.filter((routine) => routine.failing).length;
  return (
    <section className="rm-lane" aria-label="Routines">
      <button type="button" className="rm-lane-head" aria-expanded={!collapsed} onClick={onToggle}>
        <ChevronIcon open={!collapsed} />
        <span className="rm-row" style={{ flexWrap: "nowrap", fontWeight: T.weightSemibold }}>
          <RepeatIcon />
          Routines
        </span>
        <span className="rm-muted" style={{ fontSize: T.textCompact }}>
          {plural(routines.length, "routine")} with runs in 30 days{failing > 0 ? ` · ${failing} failing` : ""} · never counted in a version
        </span>
      </button>
      {collapsed ? null : (
        <div className="rm-lane-body">
          {routines.length === 0 ? (
            <span className="rm-muted" style={{ fontSize: T.textCompact }}>
              No routine runs in the last 30 days.
            </span>
          ) : (
            <RoutineList routines={routines} />
          )}
          <a {...navigation.linkProps("/routines")} className="rm-link rm-muted rm-tap" style={{ fontSize: T.textCompact, alignSelf: "flex-start" }}>
            All routines
          </a>
        </div>
      )}
    </section>
  );
}

/** One row per routine: name, failing flag, the last runs (newest first), run count and last run. */
export function RoutineList({ routines }: { routines: readonly RoutineGroup[] }) {
  const navigation = useHostNavigation();
  return (
    <div>
      {routines.map((routine) => (
        <div key={routine.routineId} className="rm-routine">
          <a
            {...navigation.linkProps(`/routines/${encodeURIComponent(routine.routineId)}`)}
            className="rm-link rm-truncate rm-tap"
            style={{ fontWeight: T.weightMedium, minWidth: 0, flex: "1 1 var(--sz-240px)" }}
          >
            {routine.title}
          </a>
          {routine.failing ? (
            <span className="rm-pill" style={{ background: tint(T.destructive, 16) }}>
              failing
            </span>
          ) : null}
          <span className="rm-runs" role="list" aria-label="Last runs, newest first">
            {routine.runs.map((run) => (
              <span
                key={run.id}
                role="listitem"
                title={`${run.identifier ?? ""} ${STATUS_LABELS[run.status]}`.trim()}
                style={{ display: "inline-flex" }}
              >
                <StatusDot status={run.status} decorative />
                <span className="rm-sr-only">
                  {run.identifier ? `${run.identifier}: ` : ""}
                  {STATUS_LABELS[run.status]}
                </span>
              </span>
            ))}
          </span>
          <span className="rm-muted" style={{ fontSize: T.textXs }}>
            {plural(routine.runCount, "run")} · last {formatRelativeDays(routine.lastRunAt)}
            {routine.openCount > 0 ? ` · ${routine.openCount} open` : ""}
          </span>
        </div>
      ))}
    </div>
  );
}
