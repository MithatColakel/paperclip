import { inArray, sql } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";

/**
 * Fork: lets the periodic recovery sweeps skip issues whose recovery inputs
 * did not change since their last evaluation.
 *
 * The stranded-issue sweep and the active-recovery-action sweep re-evaluate
 * every open assigned issue on each scheduler tick (30 s). A full evaluation
 * costs roughly 6 to 40 queries per issue, and on a quiet instance it almost
 * always reaches the same no-op. Their decisions read durable state (issue,
 * runs, wakes, comments, interactions, approvals, work products, children,
 * blockers, recovery actions, the assignee and tree holds) plus a few
 * wall-clock conditions (backoffs from 60 s, a 30 min progress exemption,
 * provider-quota resets in hours, monthly budget windows).
 *
 * The gate keys each issue (or action) by a change token computed in one query
 * per pass. A changed token is evaluated at once, exactly as before. An
 * unchanged one is evaluated again after `recheckMs`, so a wall-clock condition
 * is noticed at most `recheckMs` later than without the gate; it is never
 * dropped. An overdue monitor check or due scheduled retry changes the token
 * on every pass, so those issues keep today's cadence.
 *
 * `recheckMs <= 0` disables the gate: every candidate is evaluated.
 */
export function createUnchangedInputGate(input: {
  recheckMs: number;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  const memo = new Map<string, { token: string; evaluatedAt: number }>();
  const enabled = input.recheckMs > 0;

  return {
    enabled,
    /** True when the key has no settled evaluation for this token, or it is older than recheckMs. */
    isDue(key: string, token: string | undefined) {
      if (!enabled || token === undefined) return true;
      const last = memo.get(key);
      return !last || last.token !== token || now() - last.evaluatedAt >= input.recheckMs;
    },
    /** Remembers a finished evaluation; call only after the pass that evaluated the key completed. */
    record(key: string, token: string | undefined) {
      if (!enabled || token === undefined) return;
      memo.set(key, { token, evaluatedAt: now() });
    },
    /** Forgets keys that are no longer candidates, so the memo stays bounded. */
    retainOnly(keys: Iterable<string>) {
      if (!enabled) return;
      const keep = new Set(keys);
      for (const key of memo.keys()) if (!keep.has(key)) memo.delete(key);
    },
    size() {
      return memo.size;
    },
  };
}

export type UnchangedInputGate = ReturnType<typeof createUnchangedInputGate>;

const part = (value: ReturnType<typeof sql>) => sql`coalesce((${value})::text, '-')`;

/**
 * One change token per issue, covering the durable inputs of the recovery
 * decisions. Each part is an indexed max(updated_at)-style lookup; together
 * they replace the per-issue fan-out when nothing changed.
 */
export async function loadRecoveryIssueChangeTokens(
  db: Pick<Db, "select">,
  issueIds: readonly string[],
): Promise<Map<string, string>> {
  if (issueIds.length === 0) return new Map();
  const issueId = sql`${issues.id}`;
  const companyId = sql`${issues.companyId}`;
  const token = sql<string>`concat_ws('|',
    ${part(sql`${issues.updatedAt}`)},
    ${part(sql`${issues.status}`)},
    ${part(sql`${issues.statusVersion}`)},
    ${part(sql`${issues.assigneeAgentId}`)},
    ${part(sql`${issues.assigneeUserId}`)},
    ${part(sql`${issues.executionRunId}`)},
    ${part(sql`${issues.checkoutRunId}`)},
    ${part(sql`${issues.monitorNextCheckAt}`)},
    ${part(sql`${issues.lastStatusDecisionId}`)},
    ${part(sql`select max(r.updated_at) from heartbeat_runs r
      where r.company_id = ${companyId} and r.context_snapshot ->> 'issueId' = ${issueId}::text`)},
    ${part(sql`select max(r.updated_at) from heartbeat_runs r
      where r.company_id = ${companyId} and r.issue_id = ${issueId}`)},
    ${part(sql`select max(r.updated_at) from heartbeat_runs r
      where r.company_id = ${companyId} and r.native_issue_id = ${issueId}`)},
    ${part(sql`select max(w.updated_at) from agent_wakeup_requests w
      where w.company_id = ${companyId} and w.payload ->> 'issueId' = ${issueId}::text`)},
    ${part(sql`select max(c.updated_at) from issue_comments c
      where c.company_id = ${companyId} and c.issue_id = ${issueId}`)},
    ${part(sql`select max(at.updated_at) from issue_attachments at
      where at.company_id = ${companyId} and at.issue_id = ${issueId}`)},
    ${part(sql`select max(t.updated_at) from issue_thread_interactions t
      where t.company_id = ${companyId} and t.issue_id = ${issueId}`)},
    ${part(sql`select max(a.updated_at) from issue_approvals ia
      join approvals a on a.id = ia.approval_id and a.company_id = ia.company_id
      where ia.company_id = ${companyId} and ia.issue_id = ${issueId}`)},
    ${part(sql`select max(p.updated_at) from issue_work_products p
      where p.company_id = ${companyId} and p.issue_id = ${issueId}`)},
    ${part(sql`select max(ch.updated_at) from issues ch
      where ch.company_id = ${companyId} and ch.parent_id = ${issueId}`)},
    ${part(sql`select max(b.updated_at) from issue_relations e
      join issues b on b.id = e.issue_id and b.company_id = e.company_id
      where e.company_id = ${companyId} and e.related_issue_id = ${issueId}`)},
    ${part(sql`select max(ra.updated_at) from issue_recovery_actions ra
      where ra.company_id = ${companyId} and ra.source_issue_id = ${issueId}`)},
    ${part(sql`select max(n.updated_at) from native_run_finalizations n
      where n.company_id = ${companyId} and n.issue_id = ${issueId}`)},
    ${part(sql`select ag.updated_at from agents ag where ag.id = ${issues.assigneeAgentId}`)},
    ${part(sql`select max(h.updated_at) from issue_tree_holds h where h.company_id = ${companyId}`)},
    case when ${issues.monitorNextCheckAt} <= now() then now()::text else '' end,
    case when exists (select 1 from heartbeat_runs r
      where r.company_id = ${companyId} and r.status = 'scheduled_retry' and r.scheduled_retry_at <= now()
        and (r.context_snapshot ->> 'issueId' = ${issueId}::text or r.issue_id = ${issueId}))
      then now()::text else '' end
  )`;
  const rows = await db
    .select({ id: issues.id, token })
    .from(issues)
    .where(inArray(issues.id, [...new Set(issueIds)]));
  return new Map(rows.map((row) => [row.id, row.token]));
}
