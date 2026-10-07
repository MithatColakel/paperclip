/**
 * Version keys come from labels `v:<key>`. They are free text (the plan's key
 * rule is `^[a-z0-9][a-z0-9._-]{0,31}$`), so ordering is "semver-ish":
 *
 *   - `mvp` first, then numeric keys in natural order, then any other key;
 *   - an optional leading `v` before a number is ignored (`v1.0` sorts with `1.0`);
 *   - a patch key such as `1.0.1` comes right after its base `1.0`;
 *   - a pre-release suffix (`-rc1`, `-beta`, `-alpha.2`) sorts before the plain
 *     key, any other suffix after it (`mvp` < `mvp-2` < `mvp2`, `1.0` < `1.0-hotfix`);
 *   - keys that share a project prefix (`onb-1.0`, `onb-1.1`) sort together
 *     after the unprefixed ones. `mvp` and a bare `v` are never a prefix.
 */

export interface ParsedVersionKey {
  raw: string;
  lower: string;
  /** Lowercase project prefix (`onb` in `onb-1.0`), or "" when there is none. */
  prefix: string;
  /** 0 = mvp, 1 = numeric, 2 = anything else. */
  rank: 0 | 1 | 2;
  nums: number[];
  /** Text after the mvp or number core, for example `-rc1`. */
  suffix: string;
  /** The suffix marks a pre-release (`-rc1`, `-beta`, `-alpha.2`, `-pre`, `-preview`, `-dev`). */
  preRelease: boolean;
}

const CORE = String.raw`mvp|v[-_.]?\d+(?:\.\d+)*|\d+(?:\.\d+)*`;
const UNPREFIXED = new RegExp(`^(${CORE})(.*)$`);
const PREFIXED = new RegExp(`^([a-z][a-z0-9._-]*?)[-_/](${CORE})(.*)$`);
const PRE_RELEASE = /^[-_.]?(?:alpha|beta|rc|pre|preview|dev)(?:[-_.]?\d+)*$/;

function parseCore(raw: string, lower: string, prefix: string, core: string, suffix: string): ParsedVersionKey {
  const preRelease = PRE_RELEASE.test(suffix);
  if (core === "mvp") return { raw, lower, prefix, rank: 0, nums: [], suffix, preRelease };
  const digits = core.replace(/^v[-_.]?/, "");
  const nums = digits.split(".").map((part) => Number.parseInt(part, 10));
  return { raw, lower, prefix, rank: 1, nums, suffix, preRelease };
}

export function parseVersionKey(key: string): ParsedVersionKey {
  const raw = key.trim();
  const lower = raw.toLowerCase();
  const plain = UNPREFIXED.exec(lower);
  if (plain) return parseCore(raw, lower, "", plain[1] ?? "", plain[2] ?? "");
  const prefixed = PREFIXED.exec(lower);
  if (prefixed) return parseCore(raw, lower, prefixed[1] ?? "", prefixed[2] ?? "", prefixed[3] ?? "");
  return { raw, lower, prefix: "", rank: 2, nums: [], suffix: lower, preRelease: false };
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
}

/** 0 = pre-release, 1 = plain, 2 = any other suffix. */
function suffixRank(parsed: ParsedVersionKey): number {
  if (parsed.suffix === "") return 1;
  return parsed.preRelease ? 0 : 2;
}

export function compareVersionKeys(a: string, b: string): number {
  if (a === b) return 0;
  const pa = parseVersionKey(a);
  const pb = parseVersionKey(b);
  if (pa.prefix !== pb.prefix) {
    if (pa.prefix === "") return -1;
    if (pb.prefix === "") return 1;
    return naturalCompare(pa.prefix, pb.prefix);
  }
  if (pa.rank !== pb.rank) return pa.rank - pb.rank;
  if (pa.rank === 1) {
    const length = Math.min(pa.nums.length, pb.nums.length);
    for (let index = 0; index < length; index += 1) {
      const diff = (pa.nums[index] ?? 0) - (pb.nums[index] ?? 0);
      if (diff !== 0) return diff;
    }
    // A base version sorts before its patches: 1.0 < 1.0.1.
    if (pa.nums.length !== pb.nums.length) return pa.nums.length - pb.nums.length;
  }
  if (pa.rank !== 2) {
    const byKind = suffixRank(pa) - suffixRank(pb);
    if (byKind !== 0) return byKind;
  }
  if (pa.suffix !== pb.suffix) {
    const bySuffix = naturalCompare(pa.suffix, pb.suffix);
    if (bySuffix !== 0) return bySuffix;
  }
  const byLower = naturalCompare(pa.lower, pb.lower);
  if (byLower !== 0) return byLower;
  return a < b ? -1 : 1;
}

export function sortVersionKeys(keys: Iterable<string>): string[] {
  return [...new Set(keys)].sort(compareVersionKeys);
}

/** `1.0.1` is a patch of `1.0`; `1.0` and `1.0.0` are not patches. */
export function isPatchKey(key: string): boolean {
  const parsed = parseVersionKey(key);
  return parsed.rank === 1 && parsed.nums.length >= 3 && (parsed.nums[2] ?? 0) > 0;
}
