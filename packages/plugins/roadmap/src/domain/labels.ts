import type { TaskLabelInput } from "./types.ts";
import { sortVersionKeys } from "./versions.ts";

/** Label conventions. Labels are company-wide; match them case-insensitively. */
export const VERSION_LABEL_PREFIX = "v:";
export const LABEL_EPIC = "type:epic";
export const LABEL_HOTFIX = "type:hotfix";
export const LABEL_BUG = "type:bug";
export const LABEL_RELEASE_OPS = "release-ops";

/** Labels the board represents with its own markers instead of a label pill. */
export const MARKER_LABELS: ReadonlySet<string> = new Set([LABEL_EPIC, LABEL_HOTFIX, LABEL_BUG, LABEL_RELEASE_OPS]);

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

/** `v:mvp` → `mvp`, keeping the label's spelling. Returns null for anything that is not a version label. */
export function versionKeyFromLabel(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed.toLowerCase().startsWith(VERSION_LABEL_PREFIX)) return null;
  const key = trimmed.slice(VERSION_LABEL_PREFIX.length).trim();
  return key.length > 0 ? key : null;
}

/**
 * Version keys group case-insensitively: the host allows both `v:MVP` and
 * `v:mvp` (label names are unique by exact text), but they are one version.
 */
export function canonicalVersionKey(key: string): string {
  return key.trim().toLowerCase();
}

/**
 * The spelling a version is shown with when its labels differ only in case:
 * an all-lowercase spelling when one exists, else the first in code-unit
 * order. Deterministic whatever order the tasks arrive in.
 */
export function pickVersionSpelling(spellings: Iterable<string>): string | null {
  let best: string | null = null;
  for (const spelling of spellings) {
    if (best === null) {
      best = spelling;
      continue;
    }
    const lower = spelling === spelling.toLowerCase();
    const bestLower = best === best.toLowerCase();
    if (lower !== bestLower) {
      if (lower) best = spelling;
      continue;
    }
    if (spelling < best) best = spelling;
  }
  return best;
}

export function isVersionLabel(name: string): boolean {
  return versionKeyFromLabel(name) !== null;
}

export function isMarkerLabel(name: string): boolean {
  return MARKER_LABELS.has(normalize(name));
}

export interface LabelTraits {
  /** Distinct canonical (lowercase) `v:` keys in version order. */
  versionKeys: string[];
  /** The spelling each canonical key has on this task's own label. */
  versionSpellings: Record<string, string>;
  isEpic: boolean;
  isHotfix: boolean;
  isBug: boolean;
  isReleaseOps: boolean;
}

export function labelTraits(labels: readonly TaskLabelInput[] | null | undefined): LabelTraits {
  const keys: string[] = [];
  const spellings: Record<string, string> = {};
  let isEpic = false;
  let isHotfix = false;
  let isBug = false;
  let isReleaseOps = false;
  for (const label of labels ?? []) {
    if (!label || typeof label.name !== "string") continue;
    const key = versionKeyFromLabel(label.name);
    if (key) {
      const canonical = canonicalVersionKey(key);
      keys.push(canonical);
      const existing = spellings[canonical];
      spellings[canonical] = existing === undefined ? key : pickVersionSpelling([existing, key]) ?? key;
      continue;
    }
    switch (normalize(label.name)) {
      case LABEL_EPIC:
        isEpic = true;
        break;
      case LABEL_HOTFIX:
        isHotfix = true;
        break;
      case LABEL_BUG:
        isBug = true;
        break;
      case LABEL_RELEASE_OPS:
        isReleaseOps = true;
        break;
      default:
        break;
    }
  }
  return { versionKeys: sortVersionKeys(keys), versionSpellings: spellings, isEpic, isHotfix, isBug, isReleaseOps };
}

/** The colour of a `v:<key>` label (any case) among the labels, when one carries it. */
export function versionLabelColor(labels: readonly TaskLabelInput[], key: string): string | null {
  const canonical = canonicalVersionKey(key);
  for (const label of labels) {
    const labelKey = versionKeyFromLabel(label.name);
    if (labelKey !== null && canonicalVersionKey(labelKey) === canonical) return label.color ?? null;
  }
  return null;
}
