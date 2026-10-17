import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { type Db, heartbeatRuns } from "@paperclipai/db";

/**
 * Fork: the account a `company_pool` agent is pinned to (spec 15.5, P7): the
 * connection of this agent's latest started run that used the company pool.
 * Null when it has none. The pool then serves that member, or its first member
 * when this one left the pool, and never another one.
 */
export async function lastUsedPoolConnectionId(
  db: Db,
  input: { companyId: string; agentId: string; provider: string },
): Promise<string | null> {
  const [last] = await db
    .select({ connectionId: sql<string | null>`${heartbeatRuns.contextSnapshot} -> 'aiConnection' ->> 'connectionId'` })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId),
      isNotNull(heartbeatRuns.startedAt),
      sql`${heartbeatRuns.contextSnapshot} -> 'aiConnection' ->> 'mode' = 'company_pool'`,
      sql`${heartbeatRuns.contextSnapshot} -> 'aiConnection' ->> 'provider' = ${input.provider}`,
    ))
    .orderBy(desc(heartbeatRuns.startedAt))
    .limit(1);
  return last?.connectionId ?? null;
}
