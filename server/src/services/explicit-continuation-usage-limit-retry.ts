import { and, eq, isNull, sql } from "drizzle-orm";
import { agentWakeupRequests, issues } from "@paperclipai/db";
import { RESOURCE_WAIT_RETRY_REASONS } from "@paperclipai/shared";
import { AI_CONNECTION_POOL_WAIT_RETRY_REASON } from "../modules/run-dispatch/index.js";
import { admitExplicitContinuationRetry } from "./explicit-native-continuation.js";
import { PROVIDER_QUOTA_RECOVERY_RETRY_REASON } from "./recovery/provider-quota-recovery.js";

/**
 * Fork usage-limit lanes that resume a turn the user continued explicitly: the
 * provider-quota monitor's replacement, a company-pool member's wait for its
 * reset, and device, account and slot waits. Like a transient retry, each
 * successor renews the user's authorization through
 * admitExplicitContinuationRetry. No lane borrows the parent's receipt, and
 * none moves the turn to another account (P7).
 */
export const EXPLICIT_CONTINUATION_USAGE_LIMIT_RETRY_REASONS: ReadonlySet<string> = new Set([
  PROVIDER_QUOTA_RECOVERY_RETRY_REASON,
  // A company_pool turn waits for its own member's reset (spec 4.6, 7.6),
  // not for the provider-quota monitor.
  AI_CONNECTION_POOL_WAIT_RETRY_REASON,
  ...RESOURCE_WAIT_RETRY_REASONS,
]);

/**
 * Admission for a usage-limit lane. Call it under the task lock, in the
 * transaction that creates the successor. While the provider-quota monitor
 * waits for the reset, the task claim is released, so the exact-owner check
 * would always refuse. If no run holds the claim, lend it to the parent, run
 * the unchanged admission, and take the claim back when admission refuses. A
 * claim that another run holds is never touched.
 *
 * Newer input takes precedence: while a wake for this assignee waits on the
 * task claim, refuse, so queue-first settlement promotes that input instead of
 * a successor that would carry the older message's authority. A wake held by
 * the daily cap is skipped here, as the queue drain skips it.
 */
export async function admitExplicitContinuationUsageLimitRetry(
  input: Parameters<typeof admitExplicitContinuationRetry>[0],
) {
  const { db, companyId, issueId, agentId, parentRunId } = input;
  const [newerInput] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId),
    eq(agentWakeupRequests.status, "deferred_issue_execution"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
    sql`${agentWakeupRequests.payload} -> 'dailyCapDeferral' is null`,
  )).limit(1);
  if (newerInput) return null;
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
