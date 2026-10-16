import { z } from "zod";
import type { PluginEnvironmentDriverBaseParams } from "./protocol.js";

/**
 * Fork: environment availability for environment driver plugins.
 *
 * - A typed "environment unavailable" signal. A driver throws
 *   `PluginEnvironmentUnavailableError` from a lease, workspace or execute
 *   call when its target cannot take the run right now. The worker forwards
 *   only the validated envelope as JSON-RPC error data, and the host makes
 *   the run wait instead of failing it. `retryable: false` is a refusal and
 *   blocks the run.
 * - The optional `environmentCheckAvailability` call: a cheap, side-effect
 *   free, target-level check the host makes while runs wait.
 * - Worker→host `environments.reportTargets` (push target state) and
 *   `environments.ensureCompanyEnvironment` (create the driver's own
 *   environment for one company from a board user's action).
 *
 * Plugins bundle the SDK, so only rebuilt plugins send these. An older host
 * ignores the envelope and answers METHOD_NOT_FOUND to the two host methods.
 */

export const ENVIRONMENT_UNAVAILABLE_SCHEMA = "paperclip/environment-unavailable/v1";

/**
 * The `supportedMethods` marker a worker advertises when it opts into
 * `projectId` in its driver params (`environmentDriverFeatures.projectId`).
 * The host sends the `projectId` key only to workers that advertise it.
 */
export const ENVIRONMENT_PROJECT_ID_FEATURE = "feature:environment.projectId";

/**
 * `target`: the target itself is down for every company (it is recorded in
 * the host's availability registry). `admission`: the driver refused this
 * run only, for example a company it does not serve.
 */
export const PLUGIN_ENVIRONMENT_UNAVAILABLE_SCOPES = ["target", "admission"] as const;
export type PluginEnvironmentUnavailableScope = (typeof PLUGIN_ENVIRONMENT_UNAVAILABLE_SCOPES)[number];

export const PLUGIN_ENVIRONMENT_UNAVAILABLE_REASONS = [
  "offline",
  "paused",
  "stopped",
  "maintenance",
  "updating",
  "busy",
  "not_allowed",
  "not_serving",
  "restarting",
  "other",
] as const;
export type PluginEnvironmentUnavailableReason = (typeof PLUGIN_ENVIRONMENT_UNAVAILABLE_REASONS)[number];

/** Reasons allowed with `target` scope, in target reports and in availability checks. */
export const PLUGIN_ENVIRONMENT_TARGET_REASONS = ["offline", "paused", "maintenance", "updating", "other"] as const;
export type PluginEnvironmentTargetReason = (typeof PLUGIN_ENVIRONMENT_TARGET_REASONS)[number];

/** Reasons allowed with `admission` scope. */
export const PLUGIN_ENVIRONMENT_ADMISSION_REASONS = ["stopped", "busy", "not_allowed", "not_serving", "restarting", "other"] as const;
export type PluginEnvironmentAdmissionReason = (typeof PLUGIN_ENVIRONMENT_ADMISSION_REASONS)[number];

export interface PluginEnvironmentUnavailable {
  scope: PluginEnvironmentUnavailableScope;
  reason: PluginEnvironmentUnavailableReason;
  /** False makes it a refusal: the host fails the run as incomplete configuration. */
  retryable: boolean;
  /** The target (device) this refers to; letters, digits, `.`, `_`, `:` and `-`, at most 128. */
  targetKey?: string;
  /** Display name of the target, at most 80 characters of plain text. */
  targetLabel?: string;
  /** ISO-8601 time to try again, at most 7 days ahead. */
  retryAfter?: string;
  /** Plain text for people, at most 300 characters. Never provider internals or secrets. */
  message?: string;
}

export const ENVIRONMENT_UNAVAILABLE_LIMITS = {
  targetLabelMaxLength: 80,
  messageMaxLength: 300,
  retryAfterMaxAheadMs: 7 * 24 * 60 * 60 * 1000,
  /** Error objects `findEnvironmentUnavailable` examines along a `.cause` chain. */
  maxCauseDepth: 6,
} as const;

const TARGET_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
// C0 and C1 controls, zero-width characters, and bidirectional overrides.
const UNSAFE_TEXT_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u2029\u202A-\u202E\u2060-\u2069\uFEFF]/g;

const SCOPE_SET: ReadonlySet<string> = new Set(PLUGIN_ENVIRONMENT_UNAVAILABLE_SCOPES);
const REASON_SET: ReadonlySet<string> = new Set(PLUGIN_ENVIRONMENT_UNAVAILABLE_REASONS);
const TARGET_REASON_SET: ReadonlySet<string> = new Set(PLUGIN_ENVIRONMENT_TARGET_REASONS);
const ADMISSION_REASON_SET: ReadonlySet<string> = new Set(PLUGIN_ENVIRONMENT_ADMISSION_REASONS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Control characters become spaces, runs of whitespace collapse, and the ends are trimmed. */
function cleanText(value: string): string {
  return value.replace(UNSAFE_TEXT_CHARACTERS, " ").replace(/\s+/g, " ").trim();
}

function truncateText(value: string, max: number): string {
  if (value.length <= max) return value;
  // Never split a surrogate pair.
  const end = /[\uD800-\uDBFF]/.test(value.charAt(max - 1)) ? max - 1 : max;
  return value.slice(0, end).trimEnd();
}

/**
 * Clean plain text for an envelope or a target report: controls removed,
 * whitespace collapsed, cut to `max` characters. Returns undefined when
 * nothing is left.
 */
export function sanitizeEnvironmentText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = truncateText(cleanText(value), max);
  return text.length > 0 ? text : undefined;
}

/** A canonical ISO-8601 time at most 7 days after `now`, or null. */
function readRetryAfter(value: unknown, now: Date): string | null {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  if (at - now.getTime() > ENVIRONMENT_UNAVAILABLE_LIMITS.retryAfterMaxAheadMs) return null;
  return new Date(at).toISOString();
}

/** Whether `reason` may be used with `scope`. */
export function isEnvironmentUnavailableReasonAllowed(
  scope: PluginEnvironmentUnavailableScope,
  reason: PluginEnvironmentUnavailableReason,
): boolean {
  return scope === "target" ? TARGET_REASON_SET.has(reason) : ADMISSION_REASON_SET.has(reason);
}

/**
 * Strict read of an envelope body. Unknown fields are dropped. Text that is
 * too long, a malformed target key or time, a time more than 7 days ahead,
 * or a reason that does not fit the scope rejects the whole envelope.
 */
function parseUnavailable(value: unknown, now: Date): PluginEnvironmentUnavailable | null {
  if (!isRecord(value)) return null;
  const { scope, reason, retryable } = value;
  if (typeof scope !== "string" || !SCOPE_SET.has(scope)) return null;
  if (typeof reason !== "string" || !REASON_SET.has(reason)) return null;
  const typedScope = scope as PluginEnvironmentUnavailableScope;
  const typedReason = reason as PluginEnvironmentUnavailableReason;
  if (!isEnvironmentUnavailableReasonAllowed(typedScope, typedReason)) return null;
  if (typeof retryable !== "boolean") return null;
  const result: PluginEnvironmentUnavailable = { scope: typedScope, reason: typedReason, retryable };

  if (value.targetKey != null) {
    if (typeof value.targetKey !== "string" || !TARGET_KEY_PATTERN.test(value.targetKey)) return null;
    result.targetKey = value.targetKey;
  }
  for (const [field, max] of [
    ["targetLabel", ENVIRONMENT_UNAVAILABLE_LIMITS.targetLabelMaxLength],
    ["message", ENVIRONMENT_UNAVAILABLE_LIMITS.messageMaxLength],
  ] as const) {
    const raw = value[field];
    if (raw == null) continue;
    if (typeof raw !== "string") return null;
    const text = cleanText(raw);
    if (text.length > max) return null;
    if (text.length > 0) result[field] = text;
  }
  if (value.retryAfter != null) {
    const retryAfter = readRetryAfter(value.retryAfter, now);
    if (!retryAfter) return null;
    result.retryAfter = retryAfter;
  }
  return result;
}

/**
 * Plugin-side normalization, so a slightly long message or a far retry time
 * does not cost the whole envelope: text is cleaned and cut, `retryAfter` is
 * capped at 7 days, and an invalid target key or time is dropped.
 */
function normalizeUnavailableForSend(input: PluginEnvironmentUnavailable, now: Date): PluginEnvironmentUnavailable {
  const result: PluginEnvironmentUnavailable = {
    scope: input.scope,
    reason: input.reason,
    retryable: input.retryable,
  };
  if (typeof input.targetKey === "string" && TARGET_KEY_PATTERN.test(input.targetKey)) result.targetKey = input.targetKey;
  const targetLabel = sanitizeEnvironmentText(input.targetLabel, ENVIRONMENT_UNAVAILABLE_LIMITS.targetLabelMaxLength);
  if (targetLabel) result.targetLabel = targetLabel;
  const message = sanitizeEnvironmentText(input.message, ENVIRONMENT_UNAVAILABLE_LIMITS.messageMaxLength);
  if (message) result.message = message;
  if (typeof input.retryAfter === "string" && ISO_TIMESTAMP_PATTERN.test(input.retryAfter)) {
    const at = Date.parse(input.retryAfter);
    if (Number.isFinite(at)) {
      result.retryAfter = new Date(Math.min(at, now.getTime() + ENVIRONMENT_UNAVAILABLE_LIMITS.retryAfterMaxAheadMs)).toISOString();
    }
  }
  return result;
}

/**
 * Throw this from a driver hook when the target cannot take the run right
 * now. The host makes the run wait (or, with `retryable: false`, refuses
 * it). Only the validated envelope crosses to the host; never put provider
 * responses or secrets in it.
 */
export class PluginEnvironmentUnavailableError extends Error {
  readonly unavailable: PluginEnvironmentUnavailable;

  constructor(unavailable: PluginEnvironmentUnavailable, message?: string, options?: ErrorOptions) {
    const normalized = normalizeUnavailableForSend(unavailable, new Date());
    super(message ?? normalized.message ?? `The environment is unavailable (${normalized.reason}).`, options);
    this.name = "PluginEnvironmentUnavailableError";
    this.unavailable = normalized;
  }
}

/**
 * Read a validated envelope from a `PluginEnvironmentUnavailableError`, or
 * from the `data` of an error such as `JsonRpcCallError`. Returns null for
 * anything else or anything malformed.
 */
export function readEnvironmentUnavailableError(error: unknown, now: Date = new Date()): PluginEnvironmentUnavailable | null {
  if (error instanceof PluginEnvironmentUnavailableError) return parseUnavailable(error.unavailable, now);
  const data = isRecord(error) ? error.data : undefined;
  if (!isRecord(data) || data.schema !== ENVIRONMENT_UNAVAILABLE_SCHEMA) return null;
  return parseUnavailable(data.unavailable, now);
}

/**
 * Walk `.cause` (and each level's `data`) up to six error objects deep and
 * return the first valid envelope.
 */
export function findEnvironmentUnavailable(error: unknown, now: Date = new Date()): PluginEnvironmentUnavailable | null {
  let current: unknown = error;
  for (let depth = 0; depth < ENVIRONMENT_UNAVAILABLE_LIMITS.maxCauseDepth && current != null; depth += 1) {
    const found = readEnvironmentUnavailableError(current, now);
    if (found) return found;
    current = isRecord(current) ? current.cause : undefined;
  }
  return null;
}

/**
 * The JSON-RPC error data a worker sends for a thrown error: the envelope of
 * the first `PluginEnvironmentUnavailableError` on its `.cause` chain. Plain
 * errors, and any `data` they carry, are never forwarded.
 */
export function environmentUnavailableErrorData(error: unknown): unknown {
  let current: unknown = error;
  for (let depth = 0; depth < ENVIRONMENT_UNAVAILABLE_LIMITS.maxCauseDepth && current != null; depth += 1) {
    if (current instanceof PluginEnvironmentUnavailableError) {
      const unavailable = readEnvironmentUnavailableError(current);
      return unavailable ? { schema: ENVIRONMENT_UNAVAILABLE_SCHEMA, unavailable } : undefined;
    }
    current = current instanceof Error ? (current as { cause?: unknown }).cause : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Host→worker `environmentCheckAvailability`
// ---------------------------------------------------------------------------

export interface PluginEnvironmentCheckAvailabilityParams extends PluginEnvironmentDriverBaseParams {
  agentId?: string | null;
}

/**
 * Target-level state only: no company or project admission, no side
 * effects. `unknown` when the driver cannot tell cheaply.
 */
export type PluginEnvironmentAvailability =
  | { state: "available" }
  | { state: "unavailable"; unavailable: PluginEnvironmentUnavailable }
  | { state: "unknown" };

/** Host-side read of a worker's availability answer; anything malformed is `unknown`. */
export function readEnvironmentAvailabilityResult(value: unknown, now: Date = new Date()): PluginEnvironmentAvailability {
  if (!isRecord(value)) return { state: "unknown" };
  if (value.state === "available") return { state: "available" };
  if (value.state !== "unavailable") return { state: "unknown" };
  const unavailable = parseUnavailable(value.unavailable, now);
  if (!unavailable || unavailable.scope !== "target") return { state: "unknown" };
  return { state: "unavailable", unavailable };
}

// ---------------------------------------------------------------------------
// Worker→host `environments.reportTargets`
// ---------------------------------------------------------------------------

export const PLUGIN_ENVIRONMENT_CREDENTIAL_TYPES = ["subscription", "api_key"] as const;
export type PluginEnvironmentCredentialType = (typeof PLUGIN_ENVIRONMENT_CREDENTIAL_TYPES)[number];

export const ENVIRONMENT_TARGET_REPORT_LIMITS = {
  maxTargets: 500,
  minConfigMatchEntries: 1,
  maxConfigMatchEntries: 3,
  configMatchValueMaxLength: 256,
  labelMaxLength: 80,
  messageMaxLength: 300,
  maxServedCompanyIds: 200,
  maxAliases: 5,
  aliasMaxLength: 253,
} as const;

export interface PluginEnvironmentTargetReport {
  /** Stable key of the target within this driver. */
  targetKey: string;
  label: string;
  /**
   * One to three top-level environment config fields (string values) that
   * identify this target's environments, for example `{ deviceId }`. The
   * provider is implied by the driver key and never listed here.
   */
  configMatch: Record<string, string>;
  state: "available" | "unavailable";
  reason?: PluginEnvironmentTargetReason;
  message?: string;
  retryAfter?: string;
  /** Credential types runs on this target accept. Omitted means the host's default. */
  acceptedCredentialTypes?: PluginEnvironmentCredentialType[];
  /** The target's owner, for display only. The host ignores unknown users. */
  ownerUserId?: string | null;
  /** Companies the target serves, for device visibility only. */
  servedCompanyIds?: string[];
  /** Up to five hostnames of the machine, used to spot the same machine reached another way. */
  aliases?: string[];
  /** Something that affects admission changed; waiting runs should try again. */
  wake?: boolean;
  /** The target was removed; its environments refuse new runs. */
  retired?: boolean;
}

export interface PluginEnvironmentReportTargetsParams {
  /** A `sandbox_provider` driver key this plugin declares. */
  driverKey: string;
  targets: PluginEnvironmentTargetReport[];
}

export interface PluginEnvironmentReportTargetsResult {
  accepted: number;
}

const DRIVER_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const CONFIG_FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const COMPANY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const USER_ID_PATTERN = /^[^\s\u0000-\u001F\u007F]{1,200}$/;
const HOSTNAME_PATTERN = /^(?=.{1,253}$)[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?(?:\.[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?)*$/;

const driverKeySchema = z.string().regex(DRIVER_KEY_PATTERN, "A driver key is lowercase letters, digits, dots, hyphens or underscores");

function displayTextSchema(max: number) {
  return z.string().transform(cleanText).pipe(z.string().min(1).max(max));
}

const retryAfterSchema = z.string().transform((value, ctx) => {
  const retryAfter = readRetryAfter(value, new Date());
  if (!retryAfter) {
    ctx.addIssue({ code: "custom", message: "retryAfter must be an ISO-8601 time at most 7 days ahead" });
    return z.NEVER;
  }
  return retryAfter;
});

function configMatchSchema(label: string) {
  return z.record(
    z.string().regex(CONFIG_FIELD_PATTERN, `${label} keys are top-level config field names`)
      .refine((key) => key !== "provider", `${label} never lists provider; the driver key implies it`),
    z.string().min(1).max(ENVIRONMENT_TARGET_REPORT_LIMITS.configMatchValueMaxLength),
  ).superRefine((value, ctx) => {
    const count = Object.keys(value).length;
    if (count < ENVIRONMENT_TARGET_REPORT_LIMITS.minConfigMatchEntries || count > ENVIRONMENT_TARGET_REPORT_LIMITS.maxConfigMatchEntries) {
      ctx.addIssue({ code: "custom", message: `${label} has 1 to 3 entries` });
    }
  });
}

const targetReportSchema = z.object({
  targetKey: z.string().regex(TARGET_KEY_PATTERN, "A target key is 1 to 128 letters, digits, dots, colons, underscores or hyphens"),
  label: displayTextSchema(ENVIRONMENT_TARGET_REPORT_LIMITS.labelMaxLength),
  configMatch: configMatchSchema("configMatch"),
  state: z.enum(["available", "unavailable"]),
  reason: z.enum(PLUGIN_ENVIRONMENT_TARGET_REASONS).optional(),
  message: displayTextSchema(ENVIRONMENT_TARGET_REPORT_LIMITS.messageMaxLength).optional(),
  retryAfter: retryAfterSchema.optional(),
  acceptedCredentialTypes: z.array(z.enum(PLUGIN_ENVIRONMENT_CREDENTIAL_TYPES))
    .max(PLUGIN_ENVIRONMENT_CREDENTIAL_TYPES.length)
    .refine((types) => new Set(types).size === types.length, "acceptedCredentialTypes lists each type once")
    .optional(),
  ownerUserId: z.string().regex(USER_ID_PATTERN, "ownerUserId is a user id").nullable().optional(),
  servedCompanyIds: z.array(z.string().regex(COMPANY_ID_PATTERN, "servedCompanyIds holds company ids"))
    .max(ENVIRONMENT_TARGET_REPORT_LIMITS.maxServedCompanyIds)
    .optional(),
  aliases: z.array(
    z.string().max(ENVIRONMENT_TARGET_REPORT_LIMITS.aliasMaxLength).regex(HOSTNAME_PATTERN, "aliases are hostnames")
      .transform((alias) => alias.toLowerCase()),
  ).max(ENVIRONMENT_TARGET_REPORT_LIMITS.maxAliases).optional(),
  wake: z.boolean().optional(),
  retired: z.boolean().optional(),
});

/**
 * Host-side validator for `environments.reportTargets` params: at most 500
 * targets with distinct keys, 1–3 `configMatch` entries, an `ownerUserId`
 * string or null, at most 200 served companies and at most 5 hostname
 * aliases. Unknown target fields are dropped; display text is cleaned.
 */
export const pluginEnvironmentReportTargetsParamsSchema = z.object({
  driverKey: driverKeySchema,
  targets: z.array(targetReportSchema).max(ENVIRONMENT_TARGET_REPORT_LIMITS.maxTargets),
}).superRefine((value, ctx) => {
  const seen = new Set<string>();
  value.targets.forEach((target, index) => {
    if (seen.has(target.targetKey)) {
      ctx.addIssue({ code: "custom", message: `Duplicate targetKey "${target.targetKey}"`, path: ["targets", index, "targetKey"] });
    }
    seen.add(target.targetKey);
  });
});

/**
 * A hostname as reports carry it: trimmed, without the root dot
 * (`build-box.local.`), lower-case. Null when it is not a hostname.
 */
function normalizeAlias(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const alias = value.trim().replace(/\.$/, "").toLowerCase();
  return alias.length <= ENVIRONMENT_TARGET_REPORT_LIMITS.aliasMaxLength && HOSTNAME_PATTERN.test(alias) ? alias : null;
}

/**
 * Plugin-side cleanup before a report is sent, so one device's bad field
 * does not cost the whole report (the host rejects a report with any
 * invalid target):
 * - display text is cleaned and cut, and `retryAfter` is capped at 7 days
 *   (or dropped when malformed);
 * - aliases are trimmed, lose a trailing root dot and are lower-cased;
 *   anything that is still not a hostname is dropped, duplicates go, and at
 *   most 5 stay;
 * - served companies keep only well-formed ids, without duplicates, at most
 *   200;
 * - an `ownerUserId` that is not a user id becomes null (unowned), and
 *   unknown or repeated credential types are dropped.
 */
export function normalizeEnvironmentTargetReports(
  params: PluginEnvironmentReportTargetsParams,
  now: Date = new Date(),
): PluginEnvironmentReportTargetsParams {
  return {
    driverKey: params.driverKey,
    targets: params.targets.map((target) => {
      const label = sanitizeEnvironmentText(target.label, ENVIRONMENT_TARGET_REPORT_LIMITS.labelMaxLength) ?? target.targetKey;
      const normalized: PluginEnvironmentTargetReport = { ...target, label };
      const message = sanitizeEnvironmentText(target.message, ENVIRONMENT_TARGET_REPORT_LIMITS.messageMaxLength);
      if (message) normalized.message = message;
      else delete normalized.message;
      if (target.retryAfter !== undefined) {
        const at = typeof target.retryAfter === "string" && ISO_TIMESTAMP_PATTERN.test(target.retryAfter)
          ? Date.parse(target.retryAfter)
          : Number.NaN;
        if (Number.isFinite(at)) {
          normalized.retryAfter = new Date(Math.min(at, now.getTime() + ENVIRONMENT_UNAVAILABLE_LIMITS.retryAfterMaxAheadMs)).toISOString();
        } else {
          delete normalized.retryAfter;
        }
      }
      if (Array.isArray(target.aliases)) {
        const aliases = target.aliases.map(normalizeAlias).filter((alias): alias is string => alias !== null);
        normalized.aliases = [...new Set(aliases)].slice(0, ENVIRONMENT_TARGET_REPORT_LIMITS.maxAliases);
      }
      if (Array.isArray(target.servedCompanyIds)) {
        const companyIds = target.servedCompanyIds.filter((id): id is string => typeof id === "string" && COMPANY_ID_PATTERN.test(id));
        normalized.servedCompanyIds = [...new Set(companyIds)].slice(0, ENVIRONMENT_TARGET_REPORT_LIMITS.maxServedCompanyIds);
      }
      if (target.ownerUserId !== undefined && target.ownerUserId !== null
        && (typeof target.ownerUserId !== "string" || !USER_ID_PATTERN.test(target.ownerUserId))) {
        normalized.ownerUserId = null;
      }
      if (Array.isArray(target.acceptedCredentialTypes)) {
        normalized.acceptedCredentialTypes = [...new Set(target.acceptedCredentialTypes)]
          .filter((type) => (PLUGIN_ENVIRONMENT_CREDENTIAL_TYPES as readonly unknown[]).includes(type));
      }
      return normalized;
    }),
  };
}

// ---------------------------------------------------------------------------
// Worker→host `environments.ensureCompanyEnvironment`
// ---------------------------------------------------------------------------

export interface PluginEnsureCompanyEnvironmentParams {
  /** Must be the company of the current `performAction` invocation. */
  companyId: string;
  /** A `sandbox_provider` driver key this plugin declares. */
  driverKey: string;
  /** Display name; the host makes it unique. */
  name: string;
  description?: string | null;
  /**
   * The environment config, at most 4 KB as JSON. The host sets `provider` to
   * the driver key. No secret references.
   */
  config: Record<string, unknown>;
  /**
   * One to three config fields that identify the environment. An active
   * environment of this company and driver whose config contains them is
   * returned instead of creating another. `config` must contain them too.
   */
  match: Record<string, string>;
}

export interface PluginEnsureCompanyEnvironmentResult {
  environmentId: string;
  name: string;
  created: boolean;
}

export const ENSURE_COMPANY_ENVIRONMENT_LIMITS = {
  nameMaxLength: 100,
  descriptionMaxLength: 500,
  configMaxBytes: 4096,
} as const;

const SECRET_REFERENCE_TYPES: ReadonlySet<string> = new Set(["secret_ref", "user_secret_ref"]);

function containsSecretReference(value: unknown, depth = 0): boolean {
  if (depth > 32) return true;
  if (Array.isArray(value)) return value.some((item) => containsSecretReference(item, depth + 1));
  if (!isRecord(value)) return false;
  if (typeof value.type === "string" && SECRET_REFERENCE_TYPES.has(value.type)) return true;
  return Object.values(value).some((item) => containsSecretReference(item, depth + 1));
}

function jsonByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Host-side validator for `environments.ensureCompanyEnvironment` params.
 * Strict: unknown fields such as `envVars` are rejected.
 *
 * It finds secret references in their object form only (`{type:
 * "secret_ref" | "user_secret_ref"}`). A provider config schema can also bind
 * a secret as a bare secret-id string at a `format: "secret-ref"` path, which
 * only the host can see: its handler must also refuse a secret-id string at
 * any secret-ref path of the provider's config schema before it creates the
 * environment.
 */
export const pluginEnsureCompanyEnvironmentParamsSchema = z.object({
  companyId: z.string().regex(COMPANY_ID_PATTERN, "companyId is a company id"),
  driverKey: driverKeySchema,
  name: displayTextSchema(ENSURE_COMPANY_ENVIRONMENT_LIMITS.nameMaxLength),
  description: z.string().transform(cleanText).pipe(z.string().max(ENSURE_COMPANY_ENVIRONMENT_LIMITS.descriptionMaxLength)).nullable().optional(),
  config: z.record(z.string(), z.unknown()),
  match: configMatchSchema("match"),
}).strict().superRefine((value, ctx) => {
  if (jsonByteLength(value.config) > ENSURE_COMPANY_ENVIRONMENT_LIMITS.configMaxBytes) {
    ctx.addIssue({ code: "custom", message: "config is at most 4 KB as JSON", path: ["config"] });
  }
  if (containsSecretReference(value.config)) {
    ctx.addIssue({ code: "custom", message: "config may not contain secret references", path: ["config"] });
  }
  for (const [key, expected] of Object.entries(value.match)) {
    if (value.config[key] !== expected) {
      ctx.addIssue({ code: "custom", message: `config.${key} must equal match.${key}`, path: ["match", key] });
    }
  }
});
