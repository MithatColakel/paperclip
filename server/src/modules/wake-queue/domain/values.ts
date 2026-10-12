// Small, shared domain values for the wake-queue module: string readers, the
// two failed-run codes, and the recovery retry reason they gate. The
// application and adapter layers both need these, so they live here once
// instead of twice.

export function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function parseObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Payload marker on a deferred wake that the per-agent daily run or cost cap
 * held back. Only the heartbeat's cap admission sweep promotes these rows;
 * queue drains leave them alone so a capped agent cannot loop.
 */
export const DAILY_CAP_DEFERRAL_KEY = "dailyCapDeferral";

export const WORKSPACE_VALIDATION_FAILURE_CODE = "workspace_validation_failed";
export const CONFIGURATION_INCOMPLETE_FAILURE_CODE = "configuration_incomplete";
export const EXECUTION_REVIEW_PARTICIPANT_RECOVERY_RETRY_REASON = "execution_review_participant_recovery";

export function isWorkspaceValidationFailedRun(run: { errorCode: string | null }): boolean {
  return run.errorCode === WORKSPACE_VALIDATION_FAILURE_CODE;
}

export function isConfigurationIncompleteFailedRun(run: { errorCode: string | null }): boolean {
  return run.errorCode === CONFIGURATION_INCOMPLETE_FAILURE_CODE || run.errorCode === "model_not_found";
}
