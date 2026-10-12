import { parseObject } from "../../adapters/utils.js";

// A provider usage limit is a wait for the account to reset, not a transient
// failure of one run. When the "AI provider quota" issue monitor comes due,
// the heartbeat starts a replacement run in this lane. The lane keeps its own
// attempt counter and never spends the transient-failure retry budget.
export const PROVIDER_QUOTA_RECOVERY_RETRY_REASON = "provider_quota_recovery";
export const PROVIDER_QUOTA_RECOVERY_WAKE_REASON = "provider_quota_recovery";
// Recovery cause of the board-owned action raised when a quota wait is spent.
export const PROVIDER_QUOTA_EXHAUSTED_RECOVERY_CAUSE = "provider_quota_exhausted";

// Bounds for one quota wait, from the first usage-limit failure until a run
// gets past the limit:
// - A weekly subscription limit resets at most 7 days after it is hit, so the
//   wait ends 8 days after it started (one week plus a day of slack for late
//   or skewed resets).
// - 40 replacement attempts cover those 8 days of probes without a known reset
//   time (about 34 with the backoff below), or 5-hour session windows. More
//   attempts than that mean the limit is not resetting as reported.
// When either bound is spent, the issue goes to the board instead of waiting.
export const PROVIDER_QUOTA_RECOVERY_MAX_WAIT_MS = 8 * 24 * 60 * 60 * 1000;
export const PROVIDER_QUOTA_RECOVERY_MAX_ATTEMPTS = 40;

// Probe delays when the provider reported no reset time (for example ACP
// "terminal limit failure" results): 1h, 2h, 4h, then every 6h.
const HOUR_MS = 60 * 60 * 1000;
export const PROVIDER_QUOTA_RECOVERY_BACKOFF_MS = [
  HOUR_MS,
  2 * HOUR_MS,
  4 * HOUR_MS,
  6 * HOUR_MS,
] as const;

// A replacement run that still hits the limit after the reported reset time
// (late or skewed reset) reports a reset that has already passed. Waiting at
// least this long keeps such a wait from re-running every recovery sweep.
export const PROVIDER_QUOTA_RECOVERY_PASSED_RESET_FLOOR_MS = 10 * 60 * 1000;

export function providerQuotaRecoveryBackoffMs(completedAttempts: number) {
  const index = Math.min(
    Math.max(0, Math.floor(completedAttempts)),
    PROVIDER_QUOTA_RECOVERY_BACKOFF_MS.length - 1,
  );
  return PROVIDER_QUOTA_RECOVERY_BACKOFF_MS[index]!;
}

export type ProviderQuotaRecoveryProgress = {
  attempts: number;
  waitStartedAt: Date;
  deadline: Date;
};

function readCount(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function readDate(value: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * How far the quota wait has progressed, read from the latest failed run. Only
 * a run that was itself a quota-recovery replacement continues the wait; any
 * other failed run (a fresh wake, a continuation after progress) starts a new
 * wait at its own creation time.
 */
export function readProviderQuotaRecoveryProgress(
  run: { contextSnapshot?: unknown; createdAt?: Date | null },
  now: Date,
): ProviderQuotaRecoveryProgress {
  const context = parseObject(run.contextSnapshot);
  const continuesWait =
    context.retryReason === PROVIDER_QUOTA_RECOVERY_RETRY_REASON;
  const attempts = continuesWait
    ? (readCount(context.scheduledRetryAttempt) ?? 1)
    : 0;
  const waitStartedAt =
    (continuesWait ? readDate(context.providerQuotaWaitStartedAt) : null) ??
    run.createdAt ??
    now;
  return {
    attempts,
    waitStartedAt,
    deadline: new Date(
      waitStartedAt.getTime() + PROVIDER_QUOTA_RECOVERY_MAX_WAIT_MS,
    ),
  };
}

export function providerQuotaRecoveryExhaustion(
  progress: ProviderQuotaRecoveryProgress,
  now: Date,
): "max_attempts_exhausted" | "timeout_exceeded" | null {
  if (progress.attempts >= PROVIDER_QUOTA_RECOVERY_MAX_ATTEMPTS)
    return "max_attempts_exhausted";
  if (now.getTime() >= progress.deadline.getTime()) return "timeout_exceeded";
  return null;
}

export function providerQuotaExhaustionReason(
  kind: "max_attempts_exhausted" | "timeout_exceeded",
) {
  return kind === "timeout_exceeded"
    ? `the usage limit did not clear within ${PROVIDER_QUOTA_RECOVERY_MAX_WAIT_MS / (24 * HOUR_MS)} days`
    : `all ${PROVIDER_QUOTA_RECOVERY_MAX_ATTEMPTS} automatic replacement attempts were used`;
}

export function providerQuotaExhaustedComment(input: {
  reason: string;
  progress?: ProviderQuotaRecoveryProgress | null;
}) {
  return [
    "Paperclip stopped waiting for the AI provider usage limit to reset on this issue.",
    "",
    `- Reason: ${input.reason}`,
    ...(input.progress
      ? [
          `- Waiting since: ${input.progress.waitStartedAt.toISOString()}`,
          `- Replacement attempts: ${input.progress.attempts}`,
        ]
      : []),
    "",
    "Next action: check the AI account's usage limit or move the agent to an available account, then retry the original assignee, reassign, or resolve the task.",
  ].join("\n");
}
