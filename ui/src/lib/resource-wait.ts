/**
 * Fork: how a resource wait reads in the UI. A run whose execution device,
 * Claude account or device account slots are unavailable is cancelled as an
 * expected deferral (no provider work started) and a successor waits in one
 * of three scheduled-retry lanes. It starts automatically when the resource
 * is back, so nothing here is a failure: no failure toasts, neutral chat, and
 * copy that names the fix when a person has to act.
 */
import {
  RESOURCE_WAIT_ERROR_CODE_BY_KIND,
  RESOURCE_WAIT_KINDS,
  RESOURCE_WAIT_KIND_BY_LANE,
  RESOURCE_WAIT_RECOVERY_KIND,
  isResourceWaitErrorCode,
  isResourceWaitKind,
  isResourceWaitReason,
  isResourceWaitReasonOfKind,
  isResourceWaitRetryReason,
  readResourceWaitContext,
  type IssueRetryNowResponse,
  type IssueScheduledRetry,
  type ResourceWaitContext,
  type ResourceWaitKind,
  type ResourceWaitReason,
  type ResourceWaitRetryReason,
  type ScheduledRetryResourceWait,
} from "@paperclipai/shared";
import { POOL_BADGE_TONE_CLASS, formatResetTime, isEstimatedSource, readAiAccountPoolError } from "./ai-account-pool";
import type { RunRetryStateSummary } from "./runRetryState";
import { formatDateTime } from "./utils";

export { isResourceWaitErrorCode, isResourceWaitRetryReason };

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/** `info`: it resolves on its own. `warning`: a person has to act first. */
export type ResourceWaitTone = "info" | "warning";

export interface ResourceWaitCopy {
  kind: ResourceWaitKind;
  reason: ResourceWaitReason | null;
  /** Banner heading, e.g. "Waiting for device Build box (offline since 13:02)". */
  title: string;
  /** What happens next, and the fix when a person has to act. */
  detail: string;
  /** Compact chip, e.g. "Waiting for device: Build box". */
  chip: string;
  /** The reason in a few words, e.g. "device offline" ("Waited: device offline"). */
  short: string;
  tone: ResourceWaitTone;
}

/** A wait as an issue carries it (`scheduledRetry.resourceWait`) or as a run context carries it. */
export type ResourceWaitDisplay = ResourceWaitContext & { since?: string | null };

export interface DescribeResourceWaitOptions {
  /** Used when the wait context is missing or unreadable. */
  kind?: ResourceWaitKind | null;
  agentName?: string | null;
  now?: Date;
}

/** Reasons a person has to fix before the wait can end; the others resolve on their own. */
const NEEDS_ACTION_REASONS: ReadonlySet<ResourceWaitReason> = new Set<ResourceWaitReason>([
  "not_allowed",
  "not_serving",
  "signed_out",
  "withdrawn",
  "unassigned",
  "owner_not_member",
  "reserved_elsewhere",
  "device_unknown",
  "credential_type_unsupported",
]);

const KIND_FALLBACK: Record<ResourceWaitKind, Omit<ResourceWaitCopy, "kind" | "reason">> = {
  environment: {
    title: "Waiting for a device",
    detail: "Starts automatically when the device is available.",
    chip: "Waiting for device",
    short: "device unavailable",
    tone: "info",
  },
  ai_account: {
    title: "Waiting for a Claude account",
    detail: "Starts automatically when the account is available.",
    chip: "Waiting for a Claude account",
    short: "Claude account unavailable",
    tone: "info",
  },
  device_slots: {
    title: "Waiting for an account slot",
    detail: "Starts automatically when the device has a free account slot.",
    chip: "Waiting for an account slot",
    short: "account slots full",
    tone: "info",
  },
};

function since(wait: ResourceWaitDisplay, now: Date): string {
  const time = formatResetTime(wait.since ?? null, { now });
  return time ? ` since ${time}` : "";
}

/**
 * The driver's own words for its refusal, when it sent any. They name the fix
 * for the exact case (a device without an owner, a run without a project),
 * which the generic text can only guess.
 */
function driverMessage(wait: ResourceWaitDisplay): string | null {
  const message = wait.message?.trim();
  return message ? message : null;
}

/**
 * The banner, chip and ledger copy for a wait. Every reason of the three
 * lanes has its own text; reasons a person must fix name the fix.
 */
export function describeResourceWait(
  wait: ResourceWaitDisplay | null,
  options: DescribeResourceWaitOptions = {},
): ResourceWaitCopy {
  const kind = wait?.kind ?? options.kind ?? "environment";
  const fallback = { kind, reason: null, ...KIND_FALLBACK[kind] };
  if (!wait) return fallback;

  const now = options.now ?? new Date();
  const agent = options.agentName?.trim() || "the agent";
  const device = wait.deviceName ?? wait.environmentName ?? null;
  const deviceName = device ?? "the device";
  const account = wait.accountLabel ?? "the Claude account";
  const tone: ResourceWaitTone = NEEDS_ACTION_REASONS.has(wait.reason) ? "warning" : "info";
  const deviceChip = device ? `Waiting for device: ${device}` : "Waiting for device";
  const base = { kind: wait.kind, reason: wait.reason, tone };
  const moveHint = `To run it elsewhere, move ${agent} to another device.`;

  switch (wait.reason) {
    // Device or connection down (target scope).
    case "offline":
      return { ...base, title: `Waiting for device ${deviceName} (offline${since(wait, now)})`, detail: `Starts automatically when ${deviceName} is back online. ${moveHint}`, chip: deviceChip, short: "device offline" };
    case "paused":
      return { ...base, title: `Waiting for device ${deviceName} (paused)`, detail: `Starts automatically when ${deviceName} is resumed. ${moveHint}`, chip: deviceChip, short: "device paused" };
    case "maintenance":
      return { ...base, title: `Waiting for device ${deviceName} (maintenance)`, detail: `Starts automatically when maintenance on ${deviceName} ends.`, chip: deviceChip, short: "device maintenance" };
    case "updating":
      return { ...base, title: `Waiting for device ${deviceName} (updating)`, detail: `Starts automatically when ${deviceName} finishes updating.`, chip: deviceChip, short: "device updating" };
    case "unreachable":
      return { ...base, title: `Waiting for device ${deviceName} (unreachable${since(wait, now)})`, detail: `Paperclip cannot reach ${deviceName}. Starts automatically when the connection is back; check that the device is on and online. ${moveHint}`, chip: deviceChip, short: "device unreachable" };
    // The driver refused this run only (admission scope).
    case "not_allowed":
      return { ...base, title: `Waiting for device ${deviceName}: this project is not enabled there`, detail: driverMessage(wait) ?? `Enable this project for this company on ${deviceName}, or move ${agent} to another device. Starts automatically once it is enabled.`, chip: deviceChip, short: "project not enabled on device" };
    case "not_serving":
      return { ...base, title: `Waiting for device ${deviceName}: it does not serve this company`, detail: driverMessage(wait) ?? `${deviceName} takes work only for companies its owner belongs to. Add its owner to this company (if it has no owner, an admin assigns one first), or move ${agent} to another device.`, chip: deviceChip, short: "device not serving this company" };
    case "stopped":
      return { ...base, title: `Waiting for device ${deviceName} (stopped for this company)`, detail: `Work on ${deviceName} is stopped for this company. Starts automatically when the stop is lifted.`, chip: deviceChip, short: "device stopped" };
    case "busy":
      return { ...base, title: `Waiting for device ${deviceName} (busy)`, detail: `${deviceName} is busy with other work. Starts automatically when it has room.`, chip: deviceChip, short: "device busy" };
    case "throttled":
      return { ...base, title: `Waiting for device ${deviceName} (too many connections)`, detail: `${deviceName} is refusing new connections for a moment. Paperclip tries again shortly.`, chip: deviceChip, short: "device throttled" };
    case "restarting":
      return { ...base, title: `Waiting for device ${deviceName} (driver restarting)`, detail: `The environment driver for ${deviceName} is restarting. Starts automatically when it is back.`, chip: deviceChip, short: "driver restarting" };
    case "plugin_upgrade_pending":
      return { ...base, title: `Waiting for device ${deviceName} (driver upgrade pending)`, detail: `The environment driver for ${deviceName} is waiting for its upgrade. Starts automatically when it is ready; an instance admin can finish the upgrade in Plugins.`, chip: deviceChip, short: "driver upgrade pending" };
    case "other":
      return { ...base, title: `Waiting for device ${deviceName}`, detail: driverMessage(wait) ?? `${deviceName} is not available right now. Starts automatically when it is.`, chip: deviceChip, short: "device unavailable" };
    // Account lane.
    case "usage_limit": {
      const reset = formatResetTime(wait.resumeAt, { now, estimated: isEstimatedSource(wait.resumeAtSource) });
      return {
        ...base,
        title: reset ? `Waiting for Claude account ${account}: the usage limit resets at ${reset}` : `Waiting for Claude account ${account}: usage limit reached`,
        detail: "Resumes automatically. Paperclip never moves a task to another account; the owner can clear the limit after checking.",
        chip: reset ? `Waiting for limit reset: ${reset}` : "Waiting for limit reset",
        short: "usage limit",
      };
    }
    case "credit_balance": {
      const reset = formatResetTime(wait.resumeAt, { now, estimated: isEstimatedSource(wait.resumeAtSource) });
      return {
        ...base,
        title: `Waiting for Claude account ${account}: no API credit left`,
        detail: reset
          ? `Resumes automatically at ${reset}. To resume sooner, add credit and ask the owner to clear the limit.`
          : "Add credit to the account, then the owner can clear the limit.",
        chip: reset ? `Waiting for limit reset: ${reset}` : "Waiting for API credit",
        short: "no API credit",
      };
    }
    case "auth_unconfirmed":
      return { ...base, title: `Waiting for Claude account ${account}: checking its sign-in`, detail: "The last run could not confirm the sign-in. Paperclip tries again in a few minutes; if it keeps failing, the owner should replace the token.", chip: "Waiting for a Claude account", short: "sign-in check" };
    case "signed_out":
      return { ...base, title: `Waiting for a Claude account: ${account} is signed out`, detail: `The owner of ${account} must replace its token in Claude accounts, or choose another account for ${agent}.`, chip: "Waiting for a Claude account", short: "account signed out" };
    case "withdrawn":
      return { ...base, title: `Waiting for a Claude account: ${account} is switched off`, detail: `${account} must be turned back on in Claude accounts, or choose another account for ${agent}.`, chip: "Waiting for a Claude account", short: "account switched off" };
    case "unassigned":
      return { ...base, title: "Waiting for a Claude account: none is chosen", detail: `Choose a Claude account for ${agent} in Claude accounts, or switch it to the device's own login.`, chip: "Waiting for a Claude account", short: "no account chosen" };
    case "owner_not_member":
      // Never names the account: its owner is not a member of this company.
      return { ...base, title: "Waiting for a Claude account: the account is no longer available in this company", detail: `Its owner is no longer a member of this company. Choose another account for ${agent}, or add the owner back.`, chip: "Waiting for a Claude account", short: "account no longer available" };
    case "reserved_elsewhere":
      return { ...base, title: `Waiting for a Claude account: ${account} is reserved for other projects`, detail: `The owner of ${account} can clear the reservation in Claude accounts, or choose another account for ${agent}.`, chip: "Waiting for a Claude account", short: "account reserved elsewhere" };
    case "device_unknown":
      return { ...base, title: "Waiting for a Claude account: the agent's device is unknown", detail: `Paperclip cannot tell which device ${agent} runs on, so it cannot check the device's account limit. Pin ${agent} to an environment, or ask an instance admin to map the environment to a device.`, chip: "Waiting for a Claude account", short: "device unknown" };
    case "credential_type_unsupported":
      return { ...base, title: `Waiting for a Claude account: ${deviceName} does not accept this credential type`, detail: `Choose an account of a type ${deviceName} accepts for ${agent}, or move ${agent} to another device.`, chip: "Waiting for a Claude account", short: "credential type not accepted" };
    // Device account slots.
    case "slots_full":
      return { ...base, title: `Waiting for an account slot on ${deviceName}`, detail: `${deviceName} already runs its maximum of Claude accounts. Starts automatically when one is free; to avoid the wait, choose an account already on ${deviceName} for ${agent}.`, chip: device ? `Waiting for an account slot: ${device}` : "Waiting for an account slot", short: "account slots full" };
    default:
      // A reason this build does not know yet still reads as a wait.
      return fallback;
  }
}

function kindOfReason(reason: ResourceWaitReason): ResourceWaitKind {
  return RESOURCE_WAIT_KINDS.find((kind) => isResourceWaitReasonOfKind(kind, reason)) ?? "environment";
}

/** A wait reason in a few words, without names: "device offline", "usage limit". */
export function resourceWaitReasonLabel(reason: ResourceWaitReason): string {
  return describeResourceWait({ ...partialContext(kindOfReason(reason)), reason }).short;
}

/**
 * What a wait reason means and its fix, without names, for lists and device
 * pages: "Starts automatically when the device is back online. …".
 */
export function resourceWaitReasonText(reason: ResourceWaitReason): string {
  return describeResourceWait({ ...partialContext(kindOfReason(reason)), reason }).detail;
}

/** Badge classes for a wait chip or banner tone. */
export const RESOURCE_WAIT_TONE_CLASS: Record<ResourceWaitTone, string> = {
  info: POOL_BADGE_TONE_CLASS.info,
  warning: POOL_BADGE_TONE_CLASS.warning,
};

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export interface ScheduledResourceWait {
  lane: ResourceWaitRetryReason;
  /** Null when the context is missing or unreadable; the lane still says what kind of wait it is. */
  wait: ScheduledRetryResourceWait | null;
  agentName: string | null;
}

/** The issue's resource wait while its successor is still waiting; null otherwise. */
export function scheduledResourceWait(scheduledRetry: IssueScheduledRetry | null | undefined): ScheduledResourceWait | null {
  if (!scheduledRetry || scheduledRetry.status !== "scheduled_retry") return null;
  if (!isResourceWaitRetryReason(scheduledRetry.scheduledRetryReason)) return null;
  const context = readResourceWaitContext(scheduledRetry.resourceWait ?? null);
  const wait = context && scheduledRetry.resourceWait
    ? { ...context, since: scheduledRetry.resourceWait.since ?? null, notifiedAt: scheduledRetry.resourceWait.notifiedAt ?? null }
    : null;
  return { lane: scheduledRetry.scheduledRetryReason, wait, agentName: scheduledRetry.agentName ?? null };
}

/** Copy for an issue's waiting successor. */
export function describeScheduledResourceWait(
  scheduled: ScheduledResourceWait,
  options: { now?: Date } = {},
): ResourceWaitCopy {
  return describeResourceWait(scheduled.wait, {
    ...options,
    agentName: scheduled.agentName,
    kind: RESOURCE_WAIT_KIND_BY_LANE[scheduled.lane],
  });
}

/** The waiting surfaces' copy (top banner and composer strip), shaped like the monitor copy. */
export interface ResourceWaitSurfaceCopy {
  bannerTitle: string;
  stripTitle: string;
  bannerMeta: string[];
  stripMeta: string[];
  tone: ResourceWaitTone;
  resourceWait: true;
}

export function resourceWaitSurfaceCopy(
  scheduled: ScheduledResourceWait,
  options: { now?: Date } = {},
): ResourceWaitSurfaceCopy {
  const copy = describeScheduledResourceWait(scheduled, options);
  return {
    bannerTitle: copy.title,
    stripTitle: copy.chip,
    bannerMeta: [copy.detail],
    stripMeta: [copy.detail],
    tone: copy.tone,
    resourceWait: true,
  };
}

/** Lane labels for retry badges and properties. */
const LANE_LABELS: Record<ResourceWaitRetryReason, string> = {
  environment_wait: "Waiting for device",
  ai_account_wait: "Waiting for Claude account",
  device_slot_wait: "Waiting for account slot",
};

export function resourceWaitLaneLabel(reason: string | null | undefined): string | null {
  return isResourceWaitRetryReason(reason) ? LANE_LABELS[reason] : null;
}

const RESUMED_DETAIL: Record<ResourceWaitRetryReason, string> = {
  environment_wait: "Started after waiting for its device",
  ai_account_wait: "Started after waiting for its Claude account",
  device_slot_wait: "Started after waiting for an account slot",
};

export type ResourceWaitCheckNowTone = "neutral" | "success" | "error";

export interface ResourceWaitCheckNowResult {
  tone: ResourceWaitCheckNowTone;
  text: string;
}

/**
 * The in-place result of "Check now" on a waiting task. A 409
 * `resource_still_unavailable` is an answer, not a failure.
 */
export function describeResourceWaitCheckNow(
  data: IssueRetryNowResponse | undefined,
  error: unknown,
): ResourceWaitCheckNowResult | null {
  if (error) {
    const info = readAiAccountPoolError(error);
    if (info?.code === "resource_still_unavailable") return { tone: "neutral", text: "Still unavailable (checked just now)" };
    if (info?.status === 429) return { tone: "neutral", text: "Checked less than a minute ago. Try again in a minute." };
    return { tone: "error", text: `Couldn't check now: ${info?.message ?? "the request failed"}` };
  }
  if (!data) return null;
  switch (data.outcome) {
    case "promoted":
      return { tone: "success", text: "Available. Starting now." };
    case "already_promoted":
      return { tone: "success", text: "Already starting." };
    case "no_scheduled_retry":
      return { tone: "neutral", text: "This task is no longer waiting." };
    case "gate_suppressed":
      return { tone: "neutral", text: data.message };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** The run fields the wait helpers read; run lists, run pages and the ledger all carry them. */
export interface ResourceWaitRunLike {
  status: string;
  errorCode?: string | null;
  resultJson?: Record<string, unknown> | null;
  contextSnapshot?: Record<string, unknown> | null;
  scheduledRetryReason?: string | null;
  scheduledRetryAt?: string | Date | null;
  retryOfRunId?: string | null;
  startedAt?: string | Date | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const KIND_BY_ERROR_CODE = Object.fromEntries(
  Object.entries(RESOURCE_WAIT_ERROR_CODE_BY_KIND).map(([kind, code]) => [code, kind]),
) as Record<string, ResourceWaitKind>;

/** A cancelled deferral: the run waited instead of starting provider work. */
export function isResourceWaitDeferralRun(run: Pick<ResourceWaitRunLike, "status" | "errorCode" | "resultJson">): boolean {
  if (run.status !== "cancelled") return false;
  if (isResourceWaitErrorCode(run.errorCode)) return true;
  return asRecord(run.resultJson?.executionRecovery)?.kind === RESOURCE_WAIT_RECOVERY_KIND;
}

/** A run that is part of a wait: a deferral, the waiting successor, or a successor cancelled before it started. */
export function isResourceWaitLedgerRun(run: ResourceWaitRunLike): boolean {
  if (isResourceWaitDeferralRun(run)) return true;
  if (!isResourceWaitRetryReason(run.scheduledRetryReason)) return false;
  return run.status === "scheduled_retry" || (run.status === "cancelled" && !run.startedAt);
}

export interface RunResourceWait {
  kind: ResourceWaitKind;
  wait: ResourceWaitContext | null;
}

/**
 * What a wait run waited for. A deferral records its own wait in
 * `resultJson.resourceWait`; a successor carries the wait it was created for
 * in `contextSnapshot.resourceWait`.
 */
export function readRunResourceWait(run: ResourceWaitRunLike): RunResourceWait | null {
  const fromContext = readResourceWaitContext(run.contextSnapshot?.resourceWait ?? null);
  if (isResourceWaitDeferralRun(run)) {
    const result = asRecord(run.resultJson?.resourceWait);
    const fromResult = readResourceWaitContext(result);
    const codeKind = typeof run.errorCode === "string" ? KIND_BY_ERROR_CODE[run.errorCode] ?? null : null;
    const resultKind = result?.kind;
    const resultReason = result?.reason;
    const kind = fromResult?.kind ?? codeKind ?? (isResourceWaitKind(resultKind) ? resultKind : null) ?? fromContext?.kind ?? null;
    if (!kind) return null;
    if (fromResult) return { kind, wait: fromResult };
    // A partial record still names its reason.
    if (isResourceWaitReasonOfKind(kind, resultReason)) {
      return { kind, wait: { ...partialContext(kind), reason: resultReason } };
    }
    return { kind, wait: fromContext?.kind === kind ? fromContext : null };
  }
  if (isResourceWaitRetryReason(run.scheduledRetryReason)) {
    return { kind: RESOURCE_WAIT_KIND_BY_LANE[run.scheduledRetryReason], wait: fromContext };
  }
  return null;
}

function partialContext(kind: ResourceWaitKind): ResourceWaitContext {
  return {
    version: 1,
    episodeId: "",
    kind,
    reason: kind === "device_slots" ? "slots_full" : "other",
    scope: kind === "environment" ? "target" : kind === "ai_account" ? "account" : "device",
    environmentId: null,
    environmentName: null,
    deviceId: null,
    deviceName: null,
    accountId: null,
    accountLabel: null,
    resumeAt: null,
    resumeAtSource: null,
    message: null,
  };
}

/** Copy for one wait run. */
export function describeRunResourceWait(run: ResourceWaitRunLike, options: { agentName?: string | null; now?: Date } = {}): ResourceWaitCopy | null {
  const read = readRunResourceWait(run);
  return read ? describeResourceWait(read.wait, { ...options, kind: read.kind }) : null;
}

/**
 * Run badges: a waiting successor reads "Waiting" with its next check, and a
 * deferral reads "Waited" (no provider work started), instead of a retry.
 */
export function describeResourceWaitRunState(run: ResourceWaitRunLike): RunRetryStateSummary | null {
  const retryOfRunId = typeof run.retryOfRunId === "string" && run.retryOfRunId.trim() ? run.retryOfRunId.trim() : null;
  if (!isResourceWaitLedgerRun(run)) {
    // A lane successor that went on to run: it resumed after the wait, it is not a retry.
    if (!isResourceWaitRetryReason(run.scheduledRetryReason)) return null;
    return {
      kind: "attempted",
      badgeLabel: "Resumed",
      tone: POOL_BADGE_TONE_CLASS.muted,
      detail: RESUMED_DETAIL[run.scheduledRetryReason],
      secondary: null,
      retryOfRunId,
    };
  }
  const copy = describeRunResourceWait(run);
  if (!copy) return null;
  if (run.status === "scheduled_retry") {
    return {
      kind: "scheduled",
      badgeLabel: "Waiting",
      tone: RESOURCE_WAIT_TONE_CLASS[copy.tone],
      detail: copy.title,
      secondary: run.scheduledRetryAt ? `Next check ${formatDateTime(run.scheduledRetryAt)}` : "Starts automatically",
      retryOfRunId,
    };
  }
  return {
    kind: "attempted",
    badgeLabel: "Waited",
    tone: POOL_BADGE_TONE_CLASS.muted,
    detail: `Waited: ${copy.short}`,
    secondary: "No provider work started. The task starts automatically when the resource is available.",
    retryOfRunId,
  };
}

/** One line for a wait run, e.g. "Waiting: device offline · Coder". */
export function resourceWaitRunSummary(run: ResourceWaitRunLike, agentName: string): string {
  const copy = describeRunResourceWait(run, { agentName });
  const short = copy?.short ?? "resource unavailable";
  return run.status === "scheduled_retry" ? `Waiting: ${short} · ${agentName}` : `Waited: ${short} · ${agentName}`;
}

// ---------------------------------------------------------------------------
// Run ledger
// ---------------------------------------------------------------------------

export interface ResourceWaitLedgerRunLike extends ResourceWaitRunLike {
  runId: string;
  agentId: string;
  createdAt: string;
  finishedAt?: string | null;
}

/** Consecutive wait runs of one agent and reason, newest first, shown as one ledger entry. */
export interface ResourceWaitRunGroup<TRun extends ResourceWaitLedgerRunLike> {
  kind: "resource_wait";
  id: string;
  timestamp: string;
  runs: TRun[];
}

function groupKey(run: ResourceWaitLedgerRunLike): string {
  const read = readRunResourceWait(run);
  return `${run.agentId}:${read?.kind ?? "unknown"}:${read?.wait?.reason ?? ""}`;
}

/**
 * Collapses consecutive wait runs of a newest-first feed into one entry per
 * wait ("Waited: device offline"), so an outage reads as one wait instead of
 * a column of cancellations. Other items keep their place.
 */
export function collapseResourceWaitRuns<
  TItem extends { kind: string; id: string; timestamp: string },
  TRun extends ResourceWaitLedgerRunLike,
>(items: readonly TItem[], runOf: (item: TItem) => TRun | null): Array<TItem | ResourceWaitRunGroup<TRun>> {
  const collapsed: Array<TItem | ResourceWaitRunGroup<TRun>> = [];
  let group: ResourceWaitRunGroup<TRun> | null = null;
  let key: string | null = null;
  for (const item of items) {
    const run = runOf(item);
    if (run && isResourceWaitLedgerRun(run)) {
      const runKey = groupKey(run);
      if (group && key === runKey) {
        group.runs.push(run);
        continue;
      }
      group = { kind: "resource_wait", id: `resource-wait:${run.runId}`, timestamp: item.timestamp, runs: [run] };
      key = runKey;
      collapsed.push(group);
      continue;
    }
    group = null;
    key = null;
    collapsed.push(item);
  }
  return collapsed;
}

function formatSpan(fromMs: number, toMs: number): string | null {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return null;
  const minutes = Math.round((toMs - fromMs) / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export interface ResourceWaitRunGroupDisplay {
  /** "Waiting: device offline" while the newest run still waits, else "Waited: device offline". */
  label: string;
  /** The newest wait's banner line. */
  detail: string | null;
  waiting: boolean;
  /** Cancelled deferrals in the group: each is one admission attempt. */
  attempts: number;
  /** How long the wait lasted so far. */
  duration: string | null;
}

export function describeResourceWaitRunGroup(
  runs: readonly ResourceWaitLedgerRunLike[],
  options: { agentName?: string | null; now?: Date } = {},
): ResourceWaitRunGroupDisplay {
  const newest = runs[0];
  const waiting = newest?.status === "scheduled_retry";
  const copy = runs.map((run) => describeRunResourceWait(run, options)).find((entry) => entry?.reason) ??
    (newest ? describeRunResourceWait(newest, options) : null);
  const short = copy?.short ?? "resource unavailable";
  const oldest = runs[runs.length - 1];
  const startMs = oldest ? new Date(oldest.startedAt ?? oldest.createdAt).getTime() : Number.NaN;
  const endMs = waiting
    ? (options.now ?? new Date()).getTime()
    : newest ? new Date(newest.finishedAt ?? newest.startedAt ?? newest.createdAt).getTime() : Number.NaN;
  return {
    label: `${waiting ? "Waiting" : "Waited"}: ${short}`,
    detail: copy?.title ?? null,
    waiting,
    attempts: runs.filter((run) => isResourceWaitDeferralRun(run)).length,
    duration: formatSpan(startMs, endMs),
  };
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

const POOL_ACTIVITY_VERBS: Record<string, string> = {
  "ai_account.created": "added a Claude account",
  "ai_account.updated": "updated a Claude account",
  "ai_account.owner_changed": "transferred a Claude account",
  "ai_account.credential_replaced": "replaced the token of a Claude account",
  "ai_account.limit_cleared": "cleared the usage limit of a Claude account",
  "ai_account.deleted": "removed a Claude account",
  "ai_account.admin_disabled": "disabled a Claude account",
  "ai_account.admin_enabled": "re-enabled a Claude account",
  "ai_account.binding_updated": "changed the Claude account of",
  "ai_account.binding_cleared": "cleared the Claude account of",
  "ai_account.limit_reached": "recorded a usage limit on a Claude account",
  "ai_account.signed_out": "recorded a sign-in failure on a Claude account",
  "resource_wait.started": "started waiting on",
  "resource_wait.long_wait_notified": "reported a long wait on",
  "resource_wait.resolved": "resumed after waiting on",
  "execution_device.updated": "updated an execution device",
  "execution_device.linked": "linked an execution device",
  "company.execution_wait_settings_updated": "updated wait notices for",
};

function readWaitShort(details: Record<string, unknown> | null | undefined): string | null {
  const reason = details?.reason;
  const kind = details?.kind;
  if (isResourceWaitReason(reason)) return resourceWaitReasonLabel(reason);
  return isResourceWaitKind(kind) ? KIND_FALLBACK[kind].short : null;
}

function readAccountLabel(details: Record<string, unknown> | null | undefined): string | null {
  const label = details?.accountLabel ?? details?.label;
  return typeof label === "string" && label.trim() ? label.trim() : null;
}

/** Activity-row verbs for the account pool, devices and waits; null for other actions. */
export function accountPoolActivityVerb(action: string, details?: Record<string, unknown> | null): string | null {
  const verb = POOL_ACTIVITY_VERBS[action];
  if (!verb) return null;
  if (action.startsWith("ai_account.") && verb.endsWith("a Claude account")) {
    const label = readAccountLabel(details);
    if (label) return `${verb.slice(0, -"a Claude account".length)}Claude account ${label}`;
  }
  if (action === "resource_wait.started") {
    const short = readWaitShort(details);
    if (short) return `started waiting (${short}) on`;
  }
  return verb;
}

/** Issue activity lines for waits; null for other actions. */
export function accountPoolIssueActivityLabel(action: string, details?: Record<string, unknown> | null): string | null {
  const short = readWaitShort(details);
  switch (action) {
    case "resource_wait.started":
      return short ? `started waiting: ${short}` : "started waiting for a resource";
    case "resource_wait.long_wait_notified":
      return short ? `reported a long wait: ${short}` : "reported a long wait";
    case "resource_wait.resolved":
      return "resumed after waiting";
    default:
      return null;
  }
}
