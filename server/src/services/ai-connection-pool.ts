import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  type Db,
  aiConnectionPoolMembers,
  aiConnectionQuotaStates,
  connectionGrants,
  toolConnections,
} from "@paperclipai/db";
import {
  AI_CONNECTION_POOL_DEFAULT_COOLDOWN_MS,
  AI_CONNECTION_POOL_USAGE_THRESHOLD_PERCENT,
  aiConnectionMetadataSchema,
  type AiConnectionPoolMemberSummary,
  type AiConnectionPoolSummary,
  type AiConnectionPoolUsageWindow,
  type AiConnectionPoolUsageWindowKey,
  type AiConnectionQuotaReason,
  type AiConnectionQuotaSource,
  type AiManagedConnectionSummary,
  type AiProvider,
  type ReplaceAiConnectionPool,
} from "@paperclipai/shared";
import { HttpError, notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";

export function isAiConnectionPoolExhausted(error: unknown): error is HttpError {
  return error instanceof HttpError && error.status === 422 &&
    (error.details as { code?: unknown } | undefined)?.code === "ai_connection_pool_exhausted";
}

/** Earliest time a pool account becomes usable again, carried on `ai_connection_pool_exhausted`. */
export function aiConnectionPoolRetryAt(error: HttpError): Date | null {
  const value = (error.details as { retryAt?: unknown } | undefined)?.retryAt;
  const parsed = typeof value === "string" ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
}

const CLAUDE_USAGE_LABEL_KEYS: Record<string, AiConnectionPoolUsageWindowKey> = {
  "Current session": "five_hour",
  "Current week (all models)": "seven_day",
  "Current week (Sonnet only)": "seven_day_sonnet",
  "Current week (Opus only)": "seven_day_opus",
};

/** Maps the Claude adapter's labelled usage windows onto stable pool keys; extra usage is ignored. */
export function claudeUsageToPoolWindows(
  windows: Array<{ label: string; usedPercent: number | null; resetsAt: string | null }>,
): AiConnectionPoolUsageWindow[] {
  return windows.flatMap((window) => {
    const key = CLAUDE_USAGE_LABEL_KEYS[window.label];
    return key ? [{ key, usedPercent: window.usedPercent, resetsAt: window.resetsAt }] : [];
  });
}

/** Returns when the account may serve this model again, or null when it is below the threshold. */
export function usageBlockedUntil(
  windows: AiConnectionPoolUsageWindow[],
  model: unknown,
  now: Date,
): Date | null {
  const name = typeof model === "string" ? model.toLowerCase() : "";
  const relevant = new Set<AiConnectionPoolUsageWindowKey>(["five_hour", "seven_day"]);
  if (name.includes("opus")) relevant.add("seven_day_opus");
  if (name.includes("sonnet")) relevant.add("seven_day_sonnet");
  let until: Date | null = null;
  for (const window of windows) {
    if (!relevant.has(window.key) || window.usedPercent == null) continue;
    if (window.usedPercent < AI_CONNECTION_POOL_USAGE_THRESHOLD_PERCENT) continue;
    const resetsAt = window.resetsAt ? new Date(window.resetsAt) : null;
    const candidate = resetsAt && !Number.isNaN(resetsAt.getTime())
      ? resetsAt
      : new Date(now.getTime() + AI_CONNECTION_POOL_DEFAULT_COOLDOWN_MS);
    if (candidate.getTime() <= now.getTime()) continue;
    if (!until || candidate.getTime() > until.getTime()) until = candidate;
  }
  return until;
}

export type AiConnectionPoolMember = {
  connectionId: string;
  grantId: string;
  priority: number;
  exhaustedUntil: Date | null;
  usageCheckedAt: Date | null;
  usageWindows: AiConnectionPoolUsageWindow[];
};

export function aiConnectionPoolService(db: Db) {
  async function members(companyId: string, provider: AiProvider): Promise<AiConnectionPoolMember[]> {
    const rows = await db
      .select({ member: aiConnectionPoolMembers, state: aiConnectionQuotaStates })
      .from(aiConnectionPoolMembers)
      .leftJoin(
        aiConnectionQuotaStates,
        and(
          eq(aiConnectionQuotaStates.companyId, aiConnectionPoolMembers.companyId),
          eq(aiConnectionQuotaStates.connectionId, aiConnectionPoolMembers.connectionId),
        ),
      )
      .where(and(eq(aiConnectionPoolMembers.companyId, companyId), eq(aiConnectionPoolMembers.provider, provider)))
      .orderBy(asc(aiConnectionPoolMembers.priority));
    return rows.map(({ member, state }) => ({
      connectionId: member.connectionId,
      grantId: member.grantId,
      priority: member.priority,
      exhaustedUntil: state?.exhaustedUntil ?? null,
      usageCheckedAt: state?.usageCheckedAt ?? null,
      usageWindows: state?.usageWindows ?? [],
    }));
  }

  /** True when some pool member is not usage-limited at `now`; health is checked at selection. */
  async function hasAvailableMember(companyId: string, provider: AiProvider, now = new Date()) {
    return (await members(companyId, provider)).some(
      (member) => !member.exhaustedUntil || member.exhaustedUntil.getTime() <= now.getTime(),
    );
  }

  async function markExhausted(input: {
    companyId: string;
    connectionId: string;
    until: Date;
    reason: AiConnectionQuotaReason;
    source: AiConnectionQuotaSource;
    runId?: string | null;
  }) {
    // A later limit always wins so a short estimate never shortens a known reset.
    const until = sql`${input.until.toISOString()}::timestamptz`;
    await db
      .insert(aiConnectionQuotaStates)
      .values({
        companyId: input.companyId,
        connectionId: input.connectionId,
        exhaustedUntil: input.until,
        reason: input.reason,
        source: input.source,
        lastRunId: input.runId ?? null,
      })
      .onConflictDoUpdate({
        target: [aiConnectionQuotaStates.companyId, aiConnectionQuotaStates.connectionId],
        set: {
          exhaustedUntil: sql`greatest(coalesce(${aiConnectionQuotaStates.exhaustedUntil}, ${until}), ${until})`,
          reason: input.reason,
          source: input.source,
          lastRunId: input.runId ?? null,
          updatedAt: new Date(),
        },
      });
  }

  async function recordUsage(companyId: string, connectionId: string, windows: AiConnectionPoolUsageWindow[], checkedAt: Date) {
    await db
      .insert(aiConnectionQuotaStates)
      .values({ companyId, connectionId, usageCheckedAt: checkedAt, usageWindows: windows })
      .onConflictDoUpdate({
        target: [aiConnectionQuotaStates.companyId, aiConnectionQuotaStates.connectionId],
        set: { usageCheckedAt: checkedAt, usageWindows: windows, updatedAt: new Date() },
      });
  }

  async function aiRows(companyId: string, provider: AiProvider) {
    const rows = await db
      .select({ connection: toolConnections, grant: connectionGrants })
      .from(toolConnections)
      .innerJoin(
        connectionGrants,
        and(eq(connectionGrants.companyId, toolConnections.companyId), eq(connectionGrants.connectionId, toolConnections.id)),
      )
      .where(and(
        eq(toolConnections.companyId, companyId),
        eq(toolConnections.connectionPurpose, "ai"),
        eq(connectionGrants.kind, "organization"),
      ));
    return rows.flatMap((row) => {
      const metadata = aiConnectionMetadataSchema.safeParse(row.connection.config.ai);
      return metadata.success && metadata.data.provider === provider ? [{ ...row, metadata: metadata.data }] : [];
    });
  }

  function accountStatus(row: Awaited<ReturnType<typeof aiRows>>[number]): AiManagedConnectionSummary["status"] {
    const { connection, grant } = row;
    if (grant.status === "revoked") return "revoked";
    if (grant.status === "expired") return "expired";
    return grant.status !== "active" || !connection.enabled || connection.status !== "active" || connection.healthStatus !== "ok"
      ? "needs_attention"
      : "connected";
  }

  async function summary(companyId: string, provider: AiProvider): Promise<AiConnectionPoolSummary> {
    const [accounts, pool] = await Promise.all([aiRows(companyId, provider), members(companyId, provider)]);
    const states = pool.length
      ? await db
          .select()
          .from(aiConnectionQuotaStates)
          .where(and(
            eq(aiConnectionQuotaStates.companyId, companyId),
            inArray(aiConnectionQuotaStates.connectionId, pool.map((m) => m.connectionId)),
          ))
      : [];
    const memberSummaries: AiConnectionPoolMemberSummary[] = pool.flatMap((member) => {
      const account = accounts.find((a) => a.connection.id === member.connectionId && a.grant.id === member.grantId);
      if (!account) return [];
      const state = states.find((s) => s.connectionId === member.connectionId);
      return [{
        connectionId: member.connectionId,
        grantId: member.grantId,
        provider,
        method: account.metadata.method,
        priority: member.priority,
        name: account.connection.name,
        accountLabel: account.grant.providerTenant?.name,
        status: accountStatus(account),
        exhaustedUntil: member.exhaustedUntil?.toISOString() ?? null,
        quotaReason: state?.reason ?? null,
        quotaSource: state?.source ?? null,
        usageCheckedAt: member.usageCheckedAt?.toISOString() ?? null,
        usageWindows: member.usageWindows,
      }];
    });
    return {
      companyId,
      provider,
      members: memberSummaries,
      candidates: accounts
        .filter((a) => !pool.some((m) => m.connectionId === a.connection.id))
        .map((a) => ({
          connectionId: a.connection.id,
          grantId: a.grant.id,
          method: a.metadata.method,
          name: a.connection.name,
          accountLabel: a.grant.providerTenant?.name,
          status: accountStatus(a),
        })),
    };
  }

  async function replace(companyId: string, userId: string, input: ReplaceAiConnectionPool) {
    const accounts = await aiRows(companyId, input.provider);
    for (const member of input.members) {
      // Only this company's shared accounts can join; another company's account is never visible here.
      if (!accounts.some((a) => a.connection.id === member.connectionId && a.grant.id === member.grantId))
        throw unprocessable("Only this company's shared accounts for this provider can join the pool", {
          code: "ai_connection_pool_member_invalid",
          connectionId: member.connectionId,
        });
    }
    await db.transaction(async (tx) => {
      await tx
        .delete(aiConnectionPoolMembers)
        .where(and(eq(aiConnectionPoolMembers.companyId, companyId), eq(aiConnectionPoolMembers.provider, input.provider)));
      if (input.members.length)
        await tx.insert(aiConnectionPoolMembers).values(
          input.members.map((member, priority) => ({
            companyId,
            provider: input.provider,
            connectionId: member.connectionId,
            grantId: member.grantId,
            priority,
            createdByUserId: userId,
          })),
        );
      await logActivity(tx as unknown as Db, {
        companyId,
        actorType: "user",
        actorId: userId,
        action: "ai_connection.pool_updated",
        entityType: "company",
        entityId: companyId,
        details: { provider: input.provider, connectionIds: input.members.map((m) => m.connectionId) },
      });
    });
    return summary(companyId, input.provider);
  }

  async function clearLimit(companyId: string, userId: string, connectionId: string) {
    const [updated] = await db
      .update(aiConnectionQuotaStates)
      .set({ exhaustedUntil: null, reason: null, source: "manual", usageCheckedAt: null, updatedAt: new Date() })
      .where(and(eq(aiConnectionQuotaStates.companyId, companyId), eq(aiConnectionQuotaStates.connectionId, connectionId)))
      .returning({ connectionId: aiConnectionQuotaStates.connectionId });
    if (!updated) throw notFound("This account has no recorded usage limit");
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: userId,
      action: "ai_connection.pool_limit_cleared",
      entityType: "tool_connection",
      entityId: connectionId,
      details: {},
    });
  }

  return { members, hasAvailableMember, markExhausted, recordUsage, summary, replace, clearLimit };
}
