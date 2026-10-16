import { findEnvironmentUnavailable } from "@paperclipai/plugin-sdk";
import type { EnvironmentWaitReason } from "@paperclipai/shared";
import { RESOURCE_WAIT_TIMINGS } from "./types.js";

/**
 * Fork: classifying environment errors (spec 7.8). Pure: no database, no
 * clock beyond the `now` passed in.
 *
 * - A driver plugin's `paperclip/environment-unavailable/v1` envelope found on
 *   the error, its `.cause` chain or a JSON-RPC error's `data` (six levels):
 *   `retryable: true` waits with the envelope's scope and reason;
 *   `retryable: false` refuses the run (`environment_refused`).
 * - SSH exit 255: an unreachable host (refused, timed out, no route, an
 *   unresolved name, a banner timeout) waits as target `unreachable`; a closed
 *   or reset connection or a failed key exchange (sshd `MaxStartups` in a
 *   burst) waits as admission `throttled` for 30–60 s; `Permission denied` and
 *   host key failures stay configuration errors.
 * - A provider plugin's worker restarting waits as admission `restarting`
 *   (30 s); `upgrade_pending` as `plugin_upgrade_pending`. The `error` and
 *   `disabled` plugin states stay `configuration_incomplete`.
 * - Anything else is not a wait (null).
 *
 * The kill switch `PAPERCLIP_ENVIRONMENT_WAITS=off` turns all of it off.
 * Messages carried on are driver text the SDK already sanitized; ssh stderr is
 * matched here and never kept.
 */

export const ENVIRONMENT_WAITS_ENV = "PAPERCLIP_ENVIRONMENT_WAITS";

/** False when the environment-wait kill switch is set (read once at startup; a change needs a restart). */
export function environmentWaitsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[ENVIRONMENT_WAITS_ENV]?.trim().toLowerCase();
  return !(value === "off" || value === "false" || value === "0" || value === "disabled");
}

const MAX_CAUSE_DEPTH = 6;

/** ssh could not reach the host: the target is down for everyone. */
const SSH_UNREACHABLE_PATTERNS: readonly RegExp[] = [
  /ssh: connect to host \S+ port \d+: (?:Connection refused|Operation timed out|Connection timed out|No route to host|Network is unreachable|Host is down)/i,
  /Could not resolve hostname/i,
  // A sleeping machine behind a still-open reverse tunnel accepts the TCP
  // connection but never sends a banner.
  /Connection timed out during banner exchange/i,
  /Connection to \S+ port \d+ timed out/i,
];
/** sshd dropped the connection early, as `MaxStartups` does in a burst: this run only. */
const SSH_THROTTLED_PATTERNS: readonly RegExp[] = [
  /Connection closed by/i,
  /kex_exchange_identification/i,
  /Connection reset by peer/i,
];
/** The host answered; the configuration is wrong. Never a wait. */
const SSH_CONFIGURATION_PATTERNS: readonly RegExp[] = [/Permission denied/i, /Host key verification failed/i];

// The messages environment-runtime throws while a provider plugin is not ready
// (see heartbeat's isSandboxProviderWorkerUnavailableFailureMessage and
// parseSandboxProviderPluginNotReadyFailureMessage).
const PLUGIN_WORKER_NOT_RUNNING_RE = /sandbox provider .* is installed via plugin .* but its worker is not running/i;
const PLUGIN_UPGRADE_PENDING_RE = /sandbox provider "[^"]*" is installed via plugin "[^"]*", but that plugin is currently upgrade_pending\b/i;

export type SshFailureClass =
  | { scope: "target"; reason: "unreachable" }
  | { scope: "admission"; reason: "throttled" }
  | null;

export type EnvironmentErrorClassification =
  | {
    action: "wait";
    scope: "target" | "admission";
    reason: EnvironmentWaitReason;
    source: "envelope" | "ssh" | "plugin_lifecycle";
    /** Not earlier than this; null for the lane's own backoff. */
    retryAfter: Date | null;
    /** Sanitized envelope text only. */
    message: string | null;
    /** The driver's own key for its target (envelopes only). */
    targetKey: string | null;
    /** The driver's display name for its target (envelopes only). */
    targetLabel: string | null;
  }
  | {
    action: "refuse";
    reason: "environment_refused";
    source: "envelope";
    message: string | null;
    targetLabel: string | null;
  };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ssh reached the host and the host refused the login: the target is up. */
export function isSshConfigurationFailure(stderr: string): boolean {
  return SSH_CONFIGURATION_PATTERNS.some((pattern) => pattern.test(stderr));
}

/** The ssh failure class of one stderr text, or null when it is not an availability problem. */
export function classifySshStderr(stderr: string): SshFailureClass {
  if (isSshConfigurationFailure(stderr)) return null;
  if (SSH_UNREACHABLE_PATTERNS.some((pattern) => pattern.test(stderr))) return { scope: "target", reason: "unreachable" };
  if (SSH_THROTTLED_PATTERNS.some((pattern) => pattern.test(stderr))) return { scope: "admission", reason: "throttled" };
  return null;
}

/** An ssh exit-255 failure (an `execFile` error or a staging error): `{code: 255, stderr}`. */
export function classifySshFailure(value: unknown): SshFailureClass {
  if (!isRecord(value)) return null;
  const code = typeof value.code === "string" && /^\d+$/.test(value.code) ? Number(value.code) : value.code;
  if (code !== 255 || typeof value.stderr !== "string") return null;
  return classifySshStderr(value.stderr);
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth += 1) {
    chain.push(current);
    current = isRecord(current) || current instanceof Error ? (current as { cause?: unknown }).cause : undefined;
  }
  return chain;
}

function messageOf(value: unknown): string | null {
  if (value instanceof Error) return value.message;
  return isRecord(value) && typeof value.message === "string" ? value.message : null;
}

function jitteredDelay(minMs: number, maxMs: number, random: () => number): number {
  const fraction = Math.min(Math.max(random(), 0), 1);
  return Math.round(minMs + (maxMs - minMs) * fraction);
}

/**
 * Classify a lease (or other pre-dispatch environment) error. Returns null
 * for anything that is not a wait or a refusal, and always null while the
 * kill switch is set.
 */
export function classifyEnvironmentError(
  error: unknown,
  options: { now?: Date; enabled?: boolean; random?: () => number } = {},
): EnvironmentErrorClassification | null {
  if (options.enabled === false || error == null) return null;
  const now = options.now ?? new Date();
  const random = options.random ?? Math.random;

  const envelope = findEnvironmentUnavailable(error, now);
  if (envelope) {
    if (!envelope.retryable) {
      return {
        action: "refuse",
        reason: "environment_refused",
        source: "envelope",
        message: envelope.message ?? null,
        targetLabel: envelope.targetLabel ?? null,
      };
    }
    return {
      action: "wait",
      scope: envelope.scope,
      reason: envelope.reason,
      source: "envelope",
      retryAfter: envelope.retryAfter ? new Date(envelope.retryAfter) : null,
      message: envelope.message ?? null,
      targetKey: envelope.targetKey ?? null,
      targetLabel: envelope.targetLabel ?? null,
    };
  }

  const chain = errorChain(error);
  for (const level of chain) {
    const ssh = classifySshFailure(level);
    if (!ssh) continue;
    return {
      action: "wait",
      scope: ssh.scope,
      reason: ssh.reason,
      source: "ssh",
      retryAfter: ssh.reason === "throttled"
        ? new Date(now.getTime() + jitteredDelay(RESOURCE_WAIT_TIMINGS.throttledMinMs, RESOURCE_WAIT_TIMINGS.throttledMaxMs, random))
        : null,
      message: null,
      targetKey: null,
      targetLabel: null,
    };
  }

  for (const level of chain) {
    const message = messageOf(level);
    if (!message) continue;
    if (PLUGIN_WORKER_NOT_RUNNING_RE.test(message)) {
      return {
        action: "wait",
        scope: "admission",
        reason: "restarting",
        source: "plugin_lifecycle",
        retryAfter: new Date(now.getTime() + RESOURCE_WAIT_TIMINGS.restartingMs),
        message: null,
        targetKey: null,
        targetLabel: null,
      };
    }
    if (PLUGIN_UPGRADE_PENDING_RE.test(message)) {
      return {
        action: "wait",
        scope: "admission",
        reason: "plugin_upgrade_pending",
        source: "plugin_lifecycle",
        retryAfter: null,
        message: null,
        targetKey: null,
        targetLabel: null,
      };
    }
  }
  return null;
}
