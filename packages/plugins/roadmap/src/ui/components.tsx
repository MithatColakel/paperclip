import type { ReactNode } from "react";
import { useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import { isMarkerLabel, isVersionLabel } from "../domain/labels.ts";
import type { RoadmapCard, RoadmapLane, TaskStatus, VersionProgress, VersionState } from "../domain/types.ts";
import { STATUS_LABELS } from "../domain/types.ts";
import { BoltIcon, BugIcon, EpicIcon } from "./icons.tsx";
import { STATE_COLORS, STATE_DOT_COLORS, STATE_LABELS, T, pct, sp, statusDotColor, tint } from "./styles.ts";

export function taskHref(card: Pick<RoadmapCard, "identifier" | "id">): string {
  return `/issues/${encodeURIComponent(card.identifier ?? card.id)}`;
}

export function Pill({ color, children, title }: { color: string; children: ReactNode; title?: string }) {
  return (
    <span className="rm-pill" title={title} style={{ background: tint(color, 16), color: T.fg }}>
      {children}
    </span>
  );
}

/**
 * A bare status glyph. It uses the AA-tuned `--status-task-icon-*` hues, which
 * clear 3:1 next to text; the `--status-task-*` chip hues are only for tints.
 */
export function StatusDot({ status, live = false, decorative = false }: { status: TaskStatus; live?: boolean; decorative?: boolean }) {
  return (
    <span
      className={live ? "rm-dot rm-live" : "rm-dot"}
      title={decorative ? undefined : live ? `${STATUS_LABELS[status]} · agent working now` : STATUS_LABELS[status]}
      aria-hidden={decorative ? true : undefined}
      style={{ background: statusDotColor(status) }}
    />
  );
}

export function StateBadge({ state }: { state: VersionState }) {
  return (
    <Pill color={STATE_COLORS[state]}>
      <span className="rm-dot" style={{ background: STATE_DOT_COLORS[state], width: sp(1.5), height: sp(1.5) }} />
      {STATE_LABELS[state]}
    </Pill>
  );
}

export function ProgressBar({ progress, label }: { progress: VersionProgress; label: string }) {
  const value = progress.pct ?? 0;
  return (
    <span
      className="rm-bar"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
    >
      <span style={{ width: pct(value) }} />
    </span>
  );
}

export function progressText(progress: VersionProgress): string {
  if (progress.total === 0) return "No counted tasks";
  const percent = progress.pct === null ? "—" : `${Math.round(progress.pct * 100)}%`;
  const cancelled = progress.cancelled > 0 ? ` · ${progress.cancelled} cancelled` : "";
  return `${progress.done}/${progress.denominator} done · ${percent}${cancelled}`;
}

export function VersionTag({ versionKey, inherited }: { versionKey: string; inherited: boolean }) {
  return (
    <span
      className="rm-pill rm-mono"
      title={inherited ? `Version ${versionKey}, inherited from a parent task` : `Version ${versionKey}`}
      style={{ background: T.mutedBg, color: inherited ? T.muted : T.fg }}
    >
      {versionKey}
      {inherited ? " · inherited" : ""}
    </span>
  );
}

const PRIORITY_COLORS: Record<string, string> = {
  critical: "var(--destructive)",
  high: "var(--status-task-todo)",
};

export interface CardOptions {
  /** Show the version tag (off inside the card's own version lane unless inherited). */
  showVersion: boolean;
}

export function TaskCard({ card, options }: { card: RoadmapCard; options: CardOptions }) {
  const navigation = useHostNavigation();
  const otherLabels = card.labels.filter((label) => !isVersionLabel(label.name) && !isMarkerLabel(label.name));
  const showVersion = card.versionKey !== null && (options.showVersion || card.inheritedVersion);
  return (
    <a {...navigation.linkProps(taskHref(card))} className="rm-card" title={card.title}>
      <span className="rm-row" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
        <span className="rm-row" style={{ flexWrap: "nowrap", minWidth: 0 }}>
          <StatusDot status={card.status} live={card.live} />
          <span className="rm-mono rm-truncate rm-muted" style={{ fontSize: T.textXs }}>
            {card.identifier ?? "—"}
          </span>
        </span>
        <span className="rm-row" style={{ flexWrap: "nowrap", flex: "none" }}>
          {card.isHotfix ? (
            <Pill color="var(--destructive)" title="Hotfix">
              <BoltIcon size={3} />
              Hotfix
            </Pill>
          ) : null}
          {card.isBug ? (
            <Pill color="var(--status-task-blocked)" title="Bug">
              <BugIcon size={3} />
              Bug
            </Pill>
          ) : null}
          {PRIORITY_COLORS[card.priority] && !card.isHotfix ? (
            <Pill color={PRIORITY_COLORS[card.priority] ?? T.muted}>{card.priority}</Pill>
          ) : null}
        </span>
      </span>
      <span className="rm-clamp" style={{ fontSize: T.textCompact, fontWeight: T.weightMedium, lineHeight: "var(--leading-snug)" }}>
        {card.title}
      </span>
      {card.epicTitle || showVersion || otherLabels.length > 0 ? (
        <span className="rm-row">
          {showVersion && card.versionKey ? <VersionTag versionKey={card.versionKey} inherited={card.inheritedVersion} /> : null}
          {card.epicTitle ? (
            <span className="rm-pill" title={`Epic: ${card.epicTitle}`} style={{ background: T.mutedBg, color: T.muted, maxWidth: "100%" }}>
              <EpicIcon size={3} />
              <span className="rm-truncate">{card.epicTitle}</span>
            </span>
          ) : null}
          {otherLabels.slice(0, 3).map((label) => (
            <span key={label.name} className="rm-pill" style={{ background: T.mutedBg, color: T.muted }}>
              {label.name}
            </span>
          ))}
        </span>
      ) : null}
      <span className="rm-row rm-muted" style={{ justifyContent: "space-between", fontSize: T.textXs }}>
        <span className="rm-truncate">{card.assigneeName ?? "Unassigned"}</span>
        <span style={{ flex: "none" }} title={`Created ${card.ageDays} days ago`}>
          {card.ageDays}d
        </span>
      </span>
    </a>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rm-empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function LabelHelp() {
  return (
    <span>
      Add the label <code>v:&lt;key&gt;</code> (for example <code>v:mvp</code> or <code>v:1.0</code>) to tasks to group them
      into a Version lane; sub-tasks inherit their parent's version. Label an unassigned backlog task <code>type:epic</code> to
      make it an epic: its sub-tasks are its stories. Label urgent work <code>type:hotfix</code> to pin it in the Hotfix lane,
      and coordination tasks <code>release-ops</code>. Everything else is Ongoing.
    </span>
  );
}

export function ErrorBanner({
  message,
  detail,
  onRetry,
  action,
}: {
  message: string;
  detail?: string;
  onRetry?: () => void;
  action?: ReactNode;
}) {
  return (
    <div className="rm-banner rm-banner-error" role="alert">
      <span style={{ display: "flex", flexDirection: "column", gap: sp(1), minWidth: 0 }}>
        <strong style={{ fontWeight: T.weightSemibold }}>{message}</strong>
        {detail ? <span className="rm-muted">{detail}</span> : null}
      </span>
      <span className="rm-row">
        {action}
        {onRetry ? (
          <button type="button" className="rm-btn" onClick={onRetry}>
            Retry
          </button>
        ) : null}
      </span>
    </div>
  );
}

export function laneSummary(lane: RoadmapLane): string {
  const parts: string[] = [];
  if (lane.kind === "version") {
    parts.push(progressText(lane.progress));
    if (lane.open > 0) parts.push(`${lane.open} open`);
    if (lane.inheritedCount > 0) parts.push(`${lane.inheritedCount} inherited`);
    if (lane.hotfixOpenElsewhere > 0) parts.push(`${lane.hotfixOpenElsewhere} in Hotfix`);
    return parts.join(" · ");
  }
  parts.push(`${lane.open} open`);
  if (lane.kind === "ongoing" && lane.oldestOpenDays !== null && lane.open > 0) parts.push(`oldest ${lane.oldestOpenDays}d`);
  if (lane.unassignedOpen > 0) parts.push(`${lane.unassignedOpen} unassigned`);
  if (lane.doneRecent > 0) parts.push(`${lane.doneRecent} done in 14d`);
  if (lane.counts.cancelled > 0) parts.push(`${lane.counts.cancelled} cancelled`);
  return parts.join(" · ");
}

export function laneTitle(lane: RoadmapLane): ReactNode {
  if (lane.kind === "version") {
    return (
      <span className="rm-row" style={{ flexWrap: "nowrap", minWidth: 0 }}>
        <span className="rm-dot" style={{ background: lane.color ?? STATE_DOT_COLORS[lane.state] }} />
        <span style={{ fontWeight: T.weightSemibold }}>Version</span>
        <span className="rm-mono rm-truncate" style={{ fontWeight: T.weightSemibold }}>
          {lane.key}
        </span>
        {lane.isPatch ? <Pill color={T.muted}>patch</Pill> : null}
      </span>
    );
  }
  if (lane.kind === "hotfix") {
    return (
      <span className="rm-row" style={{ flexWrap: "nowrap", fontWeight: T.weightSemibold, color: T.destructive }}>
        <BoltIcon />
        Hotfix
      </span>
    );
  }
  return <span style={{ fontWeight: T.weightSemibold }}>{lane.title}</span>;
}
