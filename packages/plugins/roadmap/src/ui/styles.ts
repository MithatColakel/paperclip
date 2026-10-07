import { useInsertionEffect } from "react";
import type { TaskStatus, VersionState } from "../domain/types.ts";

/**
 * Host Tailwind does not compile plugin sources, so the Roadmap UI styles
 * itself: inline styles plus one scoped style block (`#rm-styles`) for hover,
 * focus, sticky and the phone breakpoint.
 *
 * Layout notes:
 * - The header sticks on desktop only. Its `top` is minus the host <main>
 *   padding (md:p-6), so it sits flush with the top of the scroll area
 *   instead of leaving a band where cards show through. On a phone the host's
 *   own sticky bar (menu button, breadcrumb) owns the top, so the header
 *   scrolls away.
 * - Board columns share the lane width (1fr) with a narrow minimum, so all
 *   six fit from about 1280 px wide and stay aligned from lane to lane.
 * - The root does not clip overflow, so focus rings at its edge stay whole;
 *   only the board and table scrollers contain wide content. Every value is a host token from
 * ui/src/index.css (or a Tailwind theme variable the host CSS emits);
 * `scripts/check-tokens.mjs` rejects colour, px and font-size literals.
 */

/** Spacing on the host scale: sp(2) is `calc(var(--spacing) * 2)`. */
export function sp(steps: number): string {
  return `calc(var(--spacing) * ${steps})`;
}

/** Computed geometry such as a progress bar width. */
export function pct(fraction: number): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  return `${Math.round(clamped * 1000) / 10}%`;
}

/** A translucent wash of a token colour. */
export function tint(color: string, percent: number): string {
  return `color-mix(in oklab, ${color} ${percent}%, transparent)`;
}

export const T = {
  fg: "var(--foreground)",
  muted: "var(--muted-foreground)",
  border: "var(--border)",
  bg: "var(--background)",
  card: "var(--card)",
  cardFg: "var(--card-foreground)",
  mutedBg: "var(--muted)",
  accent: "var(--accent)",
  primary: "var(--primary)",
  primaryFg: "var(--primary-foreground)",
  destructive: "var(--destructive)",
  radiusSm: "var(--radius-sm)",
  radiusMd: "var(--radius-md)",
  radius: "var(--radius-lg)",
  textNano: "var(--text-nano)",
  textMicro: "var(--text-micro)",
  textXs: "var(--text-xs)",
  textCompact: "var(--text-compact)",
  textSm: "var(--text-sm)",
  textBase: "var(--text-base)",
  textLg: "var(--text-lg)",
  weightMedium: "var(--font-weight-medium)",
  weightSemibold: "var(--font-weight-semibold)",
  mono: "var(--font-mono)",
  hairline: "var(--sz-1px)",
  tap: "var(--sz-44px)",
} as const;

/**
 * Hue of a bare status glyph (dot, progress fill). The host tunes
 * `--status-task-icon-*` to clear 3:1 against the page in both modes; the
 * chip base hues do not (ui/src/index.css, "Task status ICON hues").
 */
export function statusDotColor(status: TaskStatus): string {
  return `var(--status-task-icon-${status})`;
}

/** Chip base hues of the version states: only for tinted backgrounds. */
export const STATE_COLORS: Record<VersionState, string> = {
  planned: "var(--status-task-backlog)",
  active: "var(--status-task-in_progress)",
  done: "var(--status-task-done)",
};

/** Glyph hues of the version states (dots). */
export const STATE_DOT_COLORS: Record<VersionState, string> = {
  planned: "var(--status-task-icon-backlog)",
  active: "var(--status-task-icon-in_progress)",
  done: "var(--status-task-icon-done)",
};

export const STATE_LABELS: Record<VersionState, string> = {
  planned: "Planned",
  active: "In development",
  done: "Done",
};

const STYLE_ID = "rm-styles";

const CSS = `
.rm-root { color: var(--foreground); font-size: var(--text-sm); min-width: 0; max-width: 100%; display: flex; flex-direction: column; gap: calc(var(--spacing) * 4); }
.rm-root *, .rm-root *::before, .rm-root *::after { box-sizing: border-box; }
.rm-muted { color: var(--muted-foreground); }
.rm-mono { font-family: var(--font-mono); }
.rm-truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.rm-clamp { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.rm-sr-only { position: absolute; width: var(--sz-1px); height: var(--sz-1px); padding: 0; margin: calc(var(--sz-1px) * -1); overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.rm-header { position: sticky; top: calc(var(--spacing) * -6); z-index: var(--z-20); background: var(--background); border-bottom: var(--sz-1px) solid var(--border); padding-block: calc(var(--spacing) * 3); display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: calc(var(--spacing) * 3); }
.rm-header-title { display: flex; align-items: center; gap: calc(var(--spacing) * 2); min-width: 0; }
.rm-header-title h1 { margin: 0; font-size: var(--text-lg); font-weight: var(--font-weight-semibold); }
.rm-controls { display: flex; flex-wrap: wrap; align-items: center; gap: calc(var(--spacing) * 2); min-width: 0; }
.rm-btn { display: inline-flex; align-items: center; justify-content: center; gap: calc(var(--spacing) * 1.5); min-height: calc(var(--spacing) * 8); padding: 0 calc(var(--spacing) * 3); border: var(--sz-1px) solid var(--border); border-radius: var(--radius-md); background: var(--background); color: var(--foreground); font: inherit; font-size: var(--text-compact); font-weight: var(--font-weight-medium); cursor: pointer; text-decoration: none; }
.rm-btn:hover { background: var(--accent); }
.rm-btn:disabled { cursor: default; opacity: 0.6; }
.rm-btn-ghost { border-color: transparent; background: transparent; }
.rm-select { min-height: calc(var(--spacing) * 8); max-width: 100%; padding: 0 calc(var(--spacing) * 2); border: var(--sz-1px) solid var(--border); border-radius: var(--radius-md); background: var(--background); color: var(--foreground); font: inherit; font-size: var(--text-compact); }
.rm-seg { display: inline-flex; border: var(--sz-1px) solid var(--border); border-radius: var(--radius-md); overflow: hidden; }
.rm-seg button { min-height: calc(var(--spacing) * 8); padding: 0 calc(var(--spacing) * 3); border: 0; background: transparent; color: var(--muted-foreground); font: inherit; font-size: var(--text-compact); font-weight: var(--font-weight-medium); cursor: pointer; }
.rm-seg button + button { border-left: var(--sz-1px) solid var(--border); }
.rm-seg button[aria-pressed="true"] { background: var(--accent); color: var(--foreground); }
.rm-seg button:disabled { cursor: default; opacity: 0.5; }
.rm-btn:focus-visible, .rm-seg button:focus-visible, .rm-select:focus-visible, .rm-card:focus-visible, .rm-lane-head:focus-visible, .rm-link:focus-visible, .rm-navlink:focus-visible, .rm-chip:focus-visible { outline: var(--sz-2px) solid var(--ring); outline-offset: var(--sz-2px); }
.rm-link { color: inherit; text-decoration: underline; text-underline-offset: calc(var(--spacing) * 0.5); text-decoration-color: var(--border); }
.rm-link:hover { text-decoration-color: currentColor; }
.rm-navlink { display: flex; align-items: center; gap: calc(var(--spacing) * 2.5); margin-inline: calc(var(--spacing) * 2); padding: calc(var(--spacing) * 1.5) calc(var(--spacing) * 2); border-radius: var(--radius-lg); color: color-mix(in oklab, var(--foreground) 80%, transparent); font-size: var(--text-compact); font-weight: var(--font-weight-medium); text-decoration: none; }
.rm-navlink:hover, .rm-navlink[aria-current="page"] { background: var(--sidebar-accent); color: var(--sidebar-accent-foreground); }
.rm-banner { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: calc(var(--spacing) * 2); padding: calc(var(--spacing) * 3); border: var(--sz-1px) solid var(--border); border-radius: var(--radius-lg); font-size: var(--text-compact); }
.rm-banner-error { border-color: color-mix(in oklab, var(--destructive) 40%, var(--border)); background: color-mix(in oklab, var(--destructive) 6%, transparent); }
.rm-banner-info { background: var(--muted); }
.rm-lane { border: var(--sz-1px) solid var(--border); border-radius: var(--radius-lg); background: var(--background); min-width: 0; }
.rm-lane-head { display: flex; flex-wrap: wrap; align-items: center; gap: calc(var(--spacing) * 2) calc(var(--spacing) * 3); width: 100%; padding: calc(var(--spacing) * 2.5) calc(var(--spacing) * 3); border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; border-radius: var(--radius-lg); }
.rm-lane-head:hover { background: color-mix(in oklab, var(--accent) 60%, transparent); }
.rm-lane-body { display: flex; flex-direction: column; gap: calc(var(--spacing) * 3); padding: 0 calc(var(--spacing) * 3) calc(var(--spacing) * 3); min-width: 0; }
.rm-board-scroll { overflow-x: auto; overscroll-behavior-x: contain; min-width: 0; padding-bottom: calc(var(--spacing) * 1); }
.rm-board { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(calc(var(--spacing) * 36), 1fr); gap: calc(var(--spacing) * 2); }
.rm-col { display: flex; flex-direction: column; gap: calc(var(--spacing) * 2); min-width: 0; padding: calc(var(--spacing) * 2); border-radius: var(--radius-md); background: color-mix(in oklab, var(--muted) 70%, transparent); }
.rm-col-head { display: flex; align-items: center; gap: calc(var(--spacing) * 1.5); font-size: var(--text-xs); font-weight: var(--font-weight-semibold); color: var(--muted-foreground); text-transform: uppercase; letter-spacing: var(--tracking-label); }
.rm-card { display: flex; flex-direction: column; gap: calc(var(--spacing) * 1.5); padding: calc(var(--spacing) * 2.5); border: var(--sz-1px) solid var(--border); border-radius: var(--radius-md); background: var(--card); color: var(--card-foreground); text-decoration: none; min-width: 0; }
.rm-card:hover { border-color: color-mix(in oklab, var(--foreground) 30%, var(--border)); }
.rm-row { display: flex; flex-wrap: wrap; align-items: center; gap: calc(var(--spacing) * 1.5); min-width: 0; }
.rm-pill { display: inline-flex; align-items: center; gap: calc(var(--spacing) * 1); max-width: 100%; padding: 0 calc(var(--spacing) * 1.5); border-radius: var(--radius-sm); font-size: var(--text-micro); font-weight: var(--font-weight-medium); line-height: var(--leading-snug); white-space: nowrap; }
.rm-chip { display: inline-flex; align-items: center; gap: calc(var(--spacing) * 1.5); min-height: calc(var(--spacing) * 8); padding: 0 calc(var(--spacing) * 2.5); border: var(--sz-1px) solid var(--border); border-radius: var(--radius-md); background: var(--background); color: var(--foreground); font-size: var(--text-compact); font-weight: var(--font-weight-medium); text-decoration: none; white-space: nowrap; }
.rm-chip:hover { background: var(--accent); }
.rm-dot { display: inline-block; flex: none; width: calc(var(--spacing) * 2); height: calc(var(--spacing) * 2); border-radius: 50%; }
.rm-live { animation: rm-pulse var(--motion-duration-slow) var(--motion-ease-standard) infinite alternate; }
@keyframes rm-pulse { from { opacity: 1; } to { opacity: 0.35; } }
.rm-bar { position: relative; flex: none; width: var(--sz-120px); height: calc(var(--spacing) * 1.5); border-radius: var(--radius-sm); background: var(--muted); overflow: hidden; }
.rm-bar > span { position: absolute; inset: 0 auto 0 0; background: var(--status-task-icon-done); }
.rm-epics { display: flex; flex-wrap: wrap; gap: calc(var(--spacing) * 1.5); }
.rm-list-group { display: flex; flex-direction: column; gap: calc(var(--spacing) * 1.5); }
.rm-table-scroll { overflow-x: auto; min-width: 0; }
.rm-table { width: 100%; border-collapse: collapse; font-size: var(--text-compact); }
.rm-table th { text-align: left; font-size: var(--text-xs); font-weight: var(--font-weight-semibold); color: var(--muted-foreground); padding: calc(var(--spacing) * 2); border-bottom: var(--sz-1px) solid var(--border); white-space: nowrap; }
.rm-table td { padding: calc(var(--spacing) * 2); border-bottom: var(--sz-1px) solid var(--border); vertical-align: top; }
.rm-table tbody tr:hover { background: color-mix(in oklab, var(--accent) 50%, transparent); }
.rm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(var(--sz-280px), 1fr)); gap: calc(var(--spacing) * 3); }
.rm-panel { display: flex; flex-direction: column; gap: calc(var(--spacing) * 3); padding: calc(var(--spacing) * 4); border: var(--sz-1px) solid var(--border); border-radius: var(--radius-lg); background: var(--card); color: var(--card-foreground); min-width: 0; }
.rm-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: calc(var(--spacing) * 2); }
.rm-stat { display: flex; flex-direction: column; gap: calc(var(--spacing) * 0.5); min-width: 0; }
.rm-stat strong { font-size: var(--text-base); font-weight: var(--font-weight-semibold); }
.rm-routine { display: flex; flex-wrap: wrap; align-items: center; gap: calc(var(--spacing) * 2) calc(var(--spacing) * 3); padding: calc(var(--spacing) * 2) 0; border-top: var(--sz-1px) solid var(--border); }
.rm-routine:first-child { border-top: 0; }
.rm-runs { display: inline-flex; gap: calc(var(--spacing) * 1); }
.rm-empty { display: flex; flex-direction: column; gap: calc(var(--spacing) * 2); padding: calc(var(--spacing) * 6) calc(var(--spacing) * 4); border: var(--sz-1px) dashed var(--border); border-radius: var(--radius-lg); color: var(--muted-foreground); font-size: var(--text-compact); }
.rm-empty strong { color: var(--foreground); font-size: var(--text-sm); }
.rm-empty code, .rm-banner code { font-family: var(--font-mono); font-size: var(--text-xs); padding: 0 calc(var(--spacing) * 1); border-radius: var(--radius-sm); background: var(--muted); color: var(--foreground); }
.rm-details summary { cursor: pointer; }
@media (pointer: coarse) {
  .rm-navlink { padding-block: calc(var(--spacing) * 1); }
}
@media (max-width: 767px) {
  .rm-header { position: static; padding-block: calc(var(--spacing) * 2); }
  .rm-controls { width: 100%; }
  .rm-controls .rm-select { flex: 1 1 100%; }
  .rm-btn, .rm-select, .rm-seg button, .rm-chip, .rm-lane-head, .rm-card { min-height: var(--sz-44px); }
  .rm-btn { min-width: var(--sz-44px); }
  .rm-details { padding-block: 0; }
  .rm-details[open] { padding-bottom: calc(var(--spacing) * 3); }
  .rm-details > summary { min-height: var(--sz-44px); padding-block: calc(var(--spacing) * 3); }
  .rm-tap { display: inline-flex; align-items: center; min-height: var(--sz-44px); }
  .rm-seg { flex: 1 1 auto; }
  .rm-seg button { flex: 1 1 0; }
  .rm-hide-mobile { display: none; }
  .rm-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (prefers-reduced-motion: reduce) {
  .rm-live { animation: none; }
}
`;

/** Injects the scoped style block once per document. */
export function useRoadmapStyles(): void {
  useInsertionEffect(() => {
    if (typeof document === "undefined") return;
    const existing = document.getElementById(STYLE_ID);
    if (existing && existing.textContent === CSS) return;
    const element = existing ?? document.createElement("style");
    element.id = STYLE_ID;
    element.textContent = CSS;
    if (!existing) document.head.appendChild(element);
  }, []);
}
