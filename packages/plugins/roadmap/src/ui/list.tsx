import { useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import { ATTENTION_ORDER, STATUS_LABELS, type ColumnKey, type ProjectRoadmap, type RoadmapCard, type RoadmapLane } from "../domain/types.ts";
import { EmptyState, LabelHelp, StatusDot, TaskCard, VersionTag, laneSummary, laneTitle, taskHref } from "./components.tsx";
import { plural } from "./copy.ts";
import { BoltIcon } from "./icons.tsx";
import { T, sp } from "./styles.ts";

/** Rows in "needs attention first" order, then the recently done ones. */
const LIST_ORDER: readonly ColumnKey[] = [...ATTENTION_ORDER, "done"];

function laneRows(lane: RoadmapLane): { cards: RoadmapCard[]; hidden: number } {
  const columns = new Map(lane.columns.map((column) => [column.key, column]));
  const cards: RoadmapCard[] = [];
  let hidden = 0;
  for (const key of LIST_ORDER) {
    const column = columns.get(key);
    if (!column) continue;
    cards.push(...column.cards);
    hidden += column.total - column.cards.length;
  }
  return { cards, hidden };
}

export function ListView({ roadmap, isMobile }: { roadmap: ProjectRoadmap; isMobile: boolean }) {
  const lanes = roadmap.lanes.filter((lane) => lane.total > 0);
  if (lanes.length === 0) {
    return (
      <EmptyState title="No tasks in this project yet">
        <LabelHelp />
      </EmptyState>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: sp(4), minWidth: 0 }}>
      {lanes.map((lane) => (
        <LaneTable key={lane.id} lane={lane} isMobile={isMobile} />
      ))}
      {roadmap.routines.length > 0 ? (
        <span className="rm-muted" style={{ fontSize: T.textCompact }}>
          {plural(roadmap.routines.length, "routine")} ran in the last 30 days; {roadmap.routines.length === 1 ? "it is" : "they are"} listed in
          Flow and never counted in a version.
        </span>
      ) : null}
    </div>
  );
}

function LaneTable({ lane, isMobile }: { lane: RoadmapLane; isMobile: boolean }) {
  const navigation = useHostNavigation();
  const { cards, hidden } = laneRows(lane);
  const showVersion = lane.kind !== "version";
  const older = lane.counts.done - lane.doneRecent;
  return (
    <section className="rm-list-group" aria-label={lane.kind === "version" ? `Version ${lane.key}` : lane.title}>
      <div className="rm-row" style={{ gap: sp(3) }}>
        {laneTitle(lane)}
        <span className="rm-muted" style={{ fontSize: T.textCompact }}>
          {laneSummary(lane)}
        </span>
      </div>
      {isMobile ? (
        <div style={{ display: "flex", flexDirection: "column", gap: sp(2) }}>
          {cards.map((card) => (
            <TaskCard key={card.id} card={card} options={{ showVersion }} />
          ))}
        </div>
      ) : (
        <div className="rm-table-scroll">
          <table className="rm-table">
            <thead>
              <tr>
                <th scope="col">Task</th>
                <th scope="col">Status</th>
                <th scope="col">Assignee</th>
                <th scope="col">Version</th>
                <th scope="col">Epic</th>
                <th scope="col">Priority</th>
                <th scope="col">Age</th>
              </tr>
            </thead>
            <tbody>
              {cards.map((card) => (
                <tr key={card.id}>
                  <td style={{ minWidth: "var(--sz-280px)" }}>
                    <a {...navigation.linkProps(taskHref(card))} className="rm-link" style={{ display: "inline-flex", gap: sp(2), alignItems: "baseline" }}>
                      <span className="rm-mono rm-muted" style={{ fontSize: T.textXs, flex: "none" }}>
                        {card.identifier ?? "—"}
                      </span>
                      <span>{card.title}</span>
                    </a>
                    {card.isHotfix ? (
                      <span style={{ display: "inline-flex", marginLeft: sp(1.5), color: T.destructive, verticalAlign: "middle" }} title="Hotfix">
                        <BoltIcon size={3.5} />
                      </span>
                    ) : null}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <span className="rm-row" style={{ flexWrap: "nowrap" }}>
                      <StatusDot status={card.status} live={card.live} />
                      {STATUS_LABELS[card.status]}
                    </span>
                  </td>
                  <td className="rm-muted">{card.assigneeName ?? "Unassigned"}</td>
                  <td>
                    {card.versionKey && (showVersion || card.inheritedVersion) ? (
                      <VersionTag versionKey={card.versionKey} inherited={card.inheritedVersion} />
                    ) : card.versionKey ? (
                      <span className="rm-mono rm-muted">{card.versionKey}</span>
                    ) : (
                      <span className="rm-muted">—</span>
                    )}
                  </td>
                  <td className="rm-muted">{card.epicTitle ?? "—"}</td>
                  <td className="rm-muted">{card.priority}</td>
                  <td className="rm-muted" style={{ whiteSpace: "nowrap" }}>
                    {card.ageDays}d
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {hidden > 0 || older > 0 ? (
        <span className="rm-muted" style={{ fontSize: T.textXs }}>
          {hidden > 0 ? `${plural(hidden, "more task is", "more tasks are")} not shown. ` : ""}
          {older > 0
            ? `${plural(older, "task", "tasks")} finished more than 14 days ago ${older === 1 ? "is" : "are"} counted but not listed.`
            : ""}
        </span>
      ) : null}
    </section>
  );
}
