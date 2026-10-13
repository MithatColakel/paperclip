import { and, eq, isNull } from "drizzle-orm";
import { issues } from "@paperclipai/db";
import { AI_CONNECTION_FAILOVER_RETRY_REASON } from "../modules/run-dispatch/index.js";
import { admitExplicitContinuationRetry } from "./explicit-native-continuation.js";
import { PROVIDER_QUOTA_RECOVERY_RETRY_REASON } from "./recovery/provider-quota-recovery.js";

/**
 * Fork usage-limit lanes that resume a turn the user continued explicitly: the
 * provider-quota monitor's replacement and the company-pool account failover.
 * Like a transient retry, each successor renews the user's authorization
 * through admitExplicitContinuationRetry. No lane borrows the parent's receipt.
 */
export const EXPLICIT_CONTINUATION_USAGE_LIMIT_RETRY_REASONS: ReadonlySet<string> = new Set([
  PROVIDER_QUOTA_RECOVERY_RETRY_REASON,
  AI_CONNECTION_FAILOVER_RETRY_REASON,
]);

/**
 * Admission for a usage-limit lane. Call it under the task lock, in the
 * transaction that creates the successor. While the provider-quota monitor
 * waits for the reset, the task claim is released, so the exact-owner check
 * would always refuse. If no run holds the claim, lend it to the parent, run
 * the unchanged admission, and take the claim back when admission refuses. A
 * claim that another run holds is never touched.
 */
export async function admitExplicitContinuationUsageLimitRetry(
  input: Parameters<typeof admitExplicitContinuationRetry>[0],
) {
  const { db, companyId, issueId, parentRunId } = input;
  const lent = await db.update(issues).set({ executionRunId: parentRunId })
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId), isNull(issues.executionRunId)))
    .returning({ id: issues.id });
  const continuation = await admitExplicitContinuationRetry(input);
  if (!continuation && lent.length > 0) {
    await db.update(issues).set({ executionRunId: null })
      .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId), eq(issues.executionRunId, parentRunId)));
  }
  return continuation;
}
