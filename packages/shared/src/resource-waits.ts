/**
 * Fork: resource waits. A run whose execution device, Claude account or device
 * account slots are unavailable does not fail. Paperclip cancels it as an
 * expected deferral (no provider work started) and schedules a successor in
 * one of three scheduled-retry lanes. The successor waits there until the
 * resource is back and then starts automatically. Nothing here moves a task
 * to another account or another device.
 *
 * Browser-safe: no Node-only code.
 */

/** The scheduled-retry lanes (`heartbeat_runs.scheduled_retry_reason`). */
export const RESOURCE_WAIT_RETRY_REASONS = ["environment_wait", "ai_account_wait", "device_slot_wait"] as const;
export type ResourceWaitRetryReason = (typeof RESOURCE_WAIT_RETRY_REASONS)[number];

export const RESOURCE_WAIT_KINDS = ["environment", "ai_account", "device_slots"] as const;
export type ResourceWaitKind = (typeof RESOURCE_WAIT_KINDS)[number];

/**
 * `target`: the device or its connection is down for everyone (recorded in the
 * availability registry). `admission`: the driver refused this run only (never
 * recorded in the registry). `account` and `device` belong to the account and
 * slot lanes.
 */
export const RESOURCE_WAIT_SCOPES = ["target", "admission", "account", "device"] as const;
export type ResourceWaitScope = (typeof RESOURCE_WAIT_SCOPES)[number];

/** The lane each wait kind runs in. */
export const RESOURCE_WAIT_LANE_BY_KIND: Readonly<Record<ResourceWaitKind, ResourceWaitRetryReason>> = {
  environment: "environment_wait",
  ai_account: "ai_account_wait",
  device_slots: "device_slot_wait",
};

export const RESOURCE_WAIT_KIND_BY_LANE: Readonly<Record<ResourceWaitRetryReason, ResourceWaitKind>> = {
  environment_wait: "environment",
  ai_account_wait: "ai_account",
  device_slot_wait: "device_slots",
};

/** Wake reason of the successor run each lane schedules. */
export const RESOURCE_WAIT_WAKE_REASONS: Readonly<Record<ResourceWaitRetryReason, string>> = {
  environment_wait: "environment_wait_retry",
  ai_account_wait: "ai_account_wait_retry",
  device_slot_wait: "device_slot_wait_retry",
};

/** The device or its connection is down: held until the registry says otherwise. */
export const ENVIRONMENT_TARGET_WAIT_REASONS = ["offline", "paused", "maintenance", "updating", "unreachable"] as const;
/**
 * The environment driver refused this run only. `other` may also arrive with
 * target scope from a driver plugin.
 */
export const ENVIRONMENT_ADMISSION_WAIT_REASONS = [
  "not_allowed",
  "not_serving",
  "stopped",
  "busy",
  "throttled",
  "restarting",
  "plugin_upgrade_pending",
  "other",
] as const;
export const ENVIRONMENT_WAIT_REASONS = [...ENVIRONMENT_TARGET_WAIT_REASONS, ...ENVIRONMENT_ADMISSION_WAIT_REASONS] as const;
export type EnvironmentTargetWaitReason = (typeof ENVIRONMENT_TARGET_WAIT_REASONS)[number];
export type EnvironmentAdmissionWaitReason = (typeof ENVIRONMENT_ADMISSION_WAIT_REASONS)[number];
export type EnvironmentWaitReason = (typeof ENVIRONMENT_WAIT_REASONS)[number];

/**
 * Account waits. Every planCredential wait reason is here, plus
 * `auth_unconfirmed`, the run-scoped wait after a first unconfirmed sign-in
 * failure (the account itself is unchanged).
 */
export const AI_ACCOUNT_WAIT_REASONS = [
  "usage_limit",
  "credit_balance",
  "auth_unconfirmed",
  "signed_out",
  "withdrawn",
  "unassigned",
  "owner_not_member",
  "reserved_elsewhere",
  "device_unknown",
  "credential_type_unsupported",
] as const;
export type AiAccountWaitReason = (typeof AI_ACCOUNT_WAIT_REASONS)[number];

export const DEVICE_SLOT_WAIT_REASONS = ["slots_full"] as const;
export type DeviceSlotWaitReason = (typeof DEVICE_SLOT_WAIT_REASONS)[number];

export const RESOURCE_WAIT_REASONS = [
  ...ENVIRONMENT_WAIT_REASONS,
  ...AI_ACCOUNT_WAIT_REASONS,
  ...DEVICE_SLOT_WAIT_REASONS,
] as const;
export type ResourceWaitReason = (typeof RESOURCE_WAIT_REASONS)[number];

export const RESOURCE_WAIT_REASONS_BY_KIND: Readonly<{
  environment: readonly EnvironmentWaitReason[];
  ai_account: readonly AiAccountWaitReason[];
  device_slots: readonly DeviceSlotWaitReason[];
}> = {
  environment: ENVIRONMENT_WAIT_REASONS,
  ai_account: AI_ACCOUNT_WAIT_REASONS,
  device_slots: DEVICE_SLOT_WAIT_REASONS,
};

/**
 * When the board hears about a wait. `immediate`: a person has to act, or an
 * account reached its limit. `after_threshold`: only once the wait is older
 * than the company's notify-after hours. `never`: a deliberate stop.
 */
export type ResourceWaitNoticePolicy = "immediate" | "after_threshold" | "never";

export const RESOURCE_WAIT_NOTICE_POLICY: Readonly<Record<ResourceWaitReason, ResourceWaitNoticePolicy>> = {
  offline: "after_threshold",
  paused: "after_threshold",
  maintenance: "after_threshold",
  updating: "after_threshold",
  unreachable: "after_threshold",
  not_allowed: "immediate",
  not_serving: "immediate",
  stopped: "never",
  busy: "after_threshold",
  throttled: "after_threshold",
  restarting: "after_threshold",
  plugin_upgrade_pending: "after_threshold",
  other: "after_threshold",
  usage_limit: "immediate",
  credit_balance: "immediate",
  auth_unconfirmed: "never",
  signed_out: "immediate",
  withdrawn: "immediate",
  unassigned: "immediate",
  owner_not_member: "immediate",
  reserved_elsewhere: "immediate",
  device_unknown: "immediate",
  credential_type_unsupported: "immediate",
  slots_full: "immediate",
};

/** `errorCode` of the cancelled deferral run, one per kind. */
export const RESOURCE_WAIT_ERROR_CODES = ["environment_unavailable", "ai_account_unavailable", "device_slots_full"] as const;
export type ResourceWaitErrorCode = (typeof RESOURCE_WAIT_ERROR_CODES)[number];

export const RESOURCE_WAIT_ERROR_CODE_BY_KIND: Readonly<Record<ResourceWaitKind, ResourceWaitErrorCode>> = {
  environment: "environment_unavailable",
  ai_account: "ai_account_unavailable",
  device_slots: "device_slots_full",
};

/** `resultJson.executionRecovery.kind` of a deferral run. */
export const RESOURCE_WAIT_RECOVERY_KIND = "resource_wait" as const;

export interface ResourceWaitExecutionRecovery {
  kind: typeof RESOURCE_WAIT_RECOVERY_KIND;
  providerWorkStarted: false;
}

/**
 * Configuration problems that block the run instead of waiting: a refusing or
 * retired environment, a provider routing override, or a persisted run whose
 * account is gone.
 */
export const RESOURCE_WAIT_REFUSAL_REASONS = ["environment_refused", "ai_connection_incompatible", "ai_connection_changed"] as const;
export type ResourceWaitRefusalReason = (typeof RESOURCE_WAIT_REFUSAL_REASONS)[number];

/** Where `resumeAt` came from: a provider reset, an estimate, or the next availability check. */
export const RESOURCE_WAIT_RESUME_AT_SOURCES = ["provider", "estimated", "check"] as const;
export type ResourceWaitResumeAtSource = (typeof RESOURCE_WAIT_RESUME_AT_SOURCES)[number];

/** How a wait episode ended. */
export const RESOURCE_WAIT_RESOLUTIONS = ["resolved", "superseded", "abandoned", "refused"] as const;
export type ResourceWaitResolution = (typeof RESOURCE_WAIT_RESOLUTIONS)[number];

export const RESOURCE_WAIT_CONTEXT_VERSION = 1 as const;

/** Display text in a wait context is cut to these lengths, never rejected. */
export const RESOURCE_WAIT_CONTEXT_LIMITS = {
  nameMaxLength: 200,
  messageMaxLength: 300,
} as const;

/**
 * `contextSnapshot.resourceWait` of a lane successor. Written once, when the
 * successor is created, and never changed afterwards. Mutable bookkeeping
 * (notice times, check counts) lives on the wait episode.
 */
export interface ResourceWaitContext {
  version: typeof RESOURCE_WAIT_CONTEXT_VERSION;
  episodeId: string;
  kind: ResourceWaitKind;
  reason: ResourceWaitReason;
  scope: ResourceWaitScope;
  environmentId: string | null;
  environmentName: string | null;
  deviceId: string | null;
  deviceName: string | null;
  accountId: string | null;
  /** Names and labels are at most 200 characters. */
  accountLabel: string | null;
  /** Expected resume time, or null when it depends on an event. */
  resumeAt: string | null;
  resumeAtSource: ResourceWaitResumeAtSource | null;
  /** Short plain-text explanation, at most 300 characters. */
  message: string | null;
}

/**
 * `IssueScheduledRetry.resourceWait`: the waiting run's context plus the
 * episode's start and immediate-notice times.
 */
export interface ScheduledRetryResourceWait extends ResourceWaitContext {
  /** When the episode started; it carries over every replacement run. */
  since: string | null;
  notifiedAt: string | null;
}

/** Default hours before a long device wait notifies the board; 0 means never. */
export const DEFAULT_RESOURCE_WAIT_NOTIFY_HOURS = 24;
export const MAX_RESOURCE_WAIT_NOTIFY_HOURS = 168;
/** Instance-wide override of the default, read by the server. */
export const RESOURCE_WAIT_NOTIFY_HOURS_ENV = "PAPERCLIP_RESOURCE_WAIT_NOTIFY_HOURS";

const RETRY_REASON_SET: ReadonlySet<string> = new Set(RESOURCE_WAIT_RETRY_REASONS);
const ERROR_CODE_SET: ReadonlySet<string> = new Set(RESOURCE_WAIT_ERROR_CODES);
const REASON_SET: ReadonlySet<string> = new Set(RESOURCE_WAIT_REASONS);
const KIND_SET: ReadonlySet<string> = new Set(RESOURCE_WAIT_KINDS);
const SCOPE_SET: ReadonlySet<string> = new Set(RESOURCE_WAIT_SCOPES);
const RESUME_AT_SOURCE_SET: ReadonlySet<string> = new Set(RESOURCE_WAIT_RESUME_AT_SOURCES);
const SCOPES_BY_KIND: Readonly<Record<ResourceWaitKind, ReadonlySet<string>>> = {
  environment: new Set(["target", "admission"]),
  ai_account: new Set(["account"]),
  device_slots: new Set(["device"]),
};

export function isResourceWaitRetryReason(value: unknown): value is ResourceWaitRetryReason {
  return typeof value === "string" && RETRY_REASON_SET.has(value);
}

export function isResourceWaitErrorCode(value: unknown): value is ResourceWaitErrorCode {
  return typeof value === "string" && ERROR_CODE_SET.has(value);
}

export function isResourceWaitReason(value: unknown): value is ResourceWaitReason {
  return typeof value === "string" && REASON_SET.has(value);
}

export function isResourceWaitKind(value: unknown): value is ResourceWaitKind {
  return typeof value === "string" && KIND_SET.has(value);
}

/** Whether `reason` belongs to the reason set of `kind`. */
export function isResourceWaitReasonOfKind(kind: ResourceWaitKind, reason: unknown): reason is ResourceWaitReason {
  return typeof reason === "string" && (RESOURCE_WAIT_REASONS_BY_KIND[kind] as readonly string[]).includes(reason);
}

function nullableString(value: unknown, max: number): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? undefined : trimmed;
}

/** Like `nullableString`, but text over `max` is cut there (never inside a surrogate pair). */
function clippedString(value: unknown, max: number): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= max) return trimmed;
  const end = /[\uD800-\uDBFF]/.test(trimmed.charAt(max - 1)) ? max - 1 : max;
  return trimmed.slice(0, end).trimEnd();
}

/**
 * Build `contextSnapshot.resourceWait` for a lane successor. Names, labels and
 * the message are trimmed and cut to `RESOURCE_WAIT_CONTEXT_LIMITS`, so an
 * environment or device with a very long name still gets a waiting banner.
 */
export function buildResourceWaitContext(input: Omit<ResourceWaitContext, "version">): ResourceWaitContext {
  const { nameMaxLength, messageMaxLength } = RESOURCE_WAIT_CONTEXT_LIMITS;
  return {
    version: RESOURCE_WAIT_CONTEXT_VERSION,
    episodeId: input.episodeId,
    kind: input.kind,
    reason: input.reason,
    scope: input.scope,
    environmentId: input.environmentId,
    environmentName: clippedString(input.environmentName, nameMaxLength) ?? null,
    deviceId: input.deviceId,
    deviceName: clippedString(input.deviceName, nameMaxLength) ?? null,
    accountId: input.accountId,
    accountLabel: clippedString(input.accountLabel, nameMaxLength) ?? null,
    resumeAt: input.resumeAt,
    resumeAtSource: input.resumeAtSource,
    message: clippedString(input.message, messageMaxLength) ?? null,
  };
}

/**
 * Read `contextSnapshot.resourceWait` from untyped run context. Returns null
 * for anything that is not a well-formed version 1 context, including a
 * reason outside its kind's reason set or a scope outside its kind. Names and
 * the message are cut to `RESOURCE_WAIT_CONTEXT_LIMITS` rather than rejected,
 * so one long environment name never hides the wait.
 */
export function readResourceWaitContext(value: unknown): ResourceWaitContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.version !== RESOURCE_WAIT_CONTEXT_VERSION) return null;
  if (typeof row.episodeId !== "string" || row.episodeId.trim().length === 0) return null;
  if (!isResourceWaitKind(row.kind)) return null;
  const kind = row.kind;
  if (!isResourceWaitReasonOfKind(kind, row.reason)) return null;
  if (typeof row.scope !== "string" || !SCOPE_SET.has(row.scope) || !SCOPES_BY_KIND[kind].has(row.scope)) return null;
  const resumeAtSource = row.resumeAtSource ?? null;
  if (resumeAtSource !== null && (typeof resumeAtSource !== "string" || !RESUME_AT_SOURCE_SET.has(resumeAtSource))) return null;
  const resumeAt = nullableString(row.resumeAt, 64);
  if (resumeAt === undefined || (resumeAt !== null && !Number.isFinite(Date.parse(resumeAt)))) return null;
  const { nameMaxLength, messageMaxLength } = RESOURCE_WAIT_CONTEXT_LIMITS;
  const fields = {
    environmentId: nullableString(row.environmentId, 200),
    environmentName: clippedString(row.environmentName, nameMaxLength),
    deviceId: nullableString(row.deviceId, 200),
    deviceName: clippedString(row.deviceName, nameMaxLength),
    accountId: nullableString(row.accountId, 200),
    accountLabel: clippedString(row.accountLabel, nameMaxLength),
    message: clippedString(row.message, messageMaxLength),
  };
  if (Object.values(fields).some((field) => field === undefined)) return null;
  return {
    version: RESOURCE_WAIT_CONTEXT_VERSION,
    episodeId: row.episodeId.trim(),
    kind,
    reason: row.reason as ResourceWaitReason,
    scope: row.scope as ResourceWaitScope,
    environmentId: fields.environmentId ?? null,
    environmentName: fields.environmentName ?? null,
    deviceId: fields.deviceId ?? null,
    deviceName: fields.deviceName ?? null,
    accountId: fields.accountId ?? null,
    accountLabel: fields.accountLabel ?? null,
    resumeAt,
    resumeAtSource: resumeAtSource as ResourceWaitResumeAtSource | null,
    message: fields.message ?? null,
  };
}
