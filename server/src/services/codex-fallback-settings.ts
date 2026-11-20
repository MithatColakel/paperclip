import { and, eq, sql } from "drizzle-orm";
import { type Db, agents, deviceLoginLimits } from "@paperclipai/db";
import type { AgentCodexFallbackView, SetAgentCodexFallback } from "@paperclipai/shared";
import { conflict, forbidden, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { isCompanyAdmin, type PoolContext, type PoolActor } from "./ai-account-pool.js";
import {
  CODEX_FALLBACK_SOURCE_ADAPTER_TYPE,
  CODEX_FALLBACK_WAIT_KINDS,
  codexFallbackEnvironment,
  evaluateCodexFallback,
  readCodexFallbackSetting,
} from "./codex-fallback-policy.js";
import { wakeResourceWaits } from "./resource-waits/index.js";

type AgentRow = typeof agents.$inferSelect;

/**
 * Fork: the agent setting of the Codex fallback (AI-CONNECTIONS.md, "Codex
 * fallback on a device"). Company members read it; only company admins change
 * it. A change is logged in the agent's company, and turning it on wakes the
 * agent's Claude limit waits, so waiting tasks start on Codex at once.
 */
export function codexFallbackSettingsService(db: Db, options: { now?: () => Date } = {}) {
  const clock = options.now ?? (() => new Date());

  async function getAgent(agentId: string): Promise<AgentRow | null> {
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    return row ?? null;
  }

  async function view(actor: PoolActor, agent: AgentRow): Promise<AgentCodexFallbackView> {
    const now = clock();
    const setting = readCodexFallbackSetting(agent.runtimeConfig);
    const environment = await codexFallbackEnvironment(db, agent);
    const unsupportedReason = agent.adapterType !== CODEX_FALLBACK_SOURCE_ADAPTER_TYPE
      ? "adapter" as const
      : !environment ? "no_device_environment" as const : null;
    let codexBlockedUntil: Date | null = null;
    let codexBlockReason: AgentCodexFallbackView["codexBlockReason"] = null;
    if (environment) {
      const [row] = await db
        .select({ until: deviceLoginLimits.codexFallbackBlockedUntil, reason: deviceLoginLimits.codexFallbackBlockReason })
        .from(deviceLoginLimits)
        .where(and(eq(deviceLoginLimits.environmentId, environment.id), eq(deviceLoginLimits.companyId, agent.companyId)));
      if (row?.until && row.until.getTime() > now.getTime()) {
        codexBlockedUntil = row.until;
        codexBlockReason = row.reason ?? null;
      }
    }
    const decision = setting.enabled && !unsupportedReason ? await evaluateCodexFallback(db, { agent, now }) : null;
    return {
      agentId: agent.id,
      enabled: setting.enabled,
      model: setting.model,
      modelReasoningEffort: setting.modelReasoningEffort,
      canChange: isCompanyAdmin(actor, agent.companyId),
      unsupportedReason,
      environment,
      active: decision?.eligible === true,
      claudeUntil: decision?.eligible ? decision.attribution.claudeUntil : null,
      codexBlockedUntil: codexBlockedUntil?.toISOString() ?? null,
      codexBlockReason,
    };
  }

  async function get(actor: PoolActor, agentId: string): Promise<AgentCodexFallbackView> {
    const agent = await getAgent(agentId);
    if (!agent) throw notFound("Agent not found");
    return view(actor, agent);
  }

  async function set(ctx: PoolContext, agentId: string, input: SetAgentCodexFallback): Promise<AgentCodexFallbackView> {
    const { actor } = ctx;
    const existing = await getAgent(agentId);
    if (!existing) throw notFound("Agent not found");
    if (actor.type !== "board" || !isCompanyAdmin(actor, existing.companyId)) {
      throw forbidden("Only a company admin can change an agent's Codex fallback.", { code: "codex_fallback_forbidden" });
    }
    if (input.enabled && existing.adapterType !== CODEX_FALLBACK_SOURCE_ADAPTER_TYPE) {
      throw conflict("Only a Claude agent can fall back to Codex.", { code: "codex_fallback_unsupported", reason: "adapter" });
    }
    if (input.enabled && !(await codexFallbackEnvironment(db, existing))) {
      throw conflict(
        "The Codex fallback needs the agent's default environment to be an active device (Mac Fleet) environment.",
        { code: "codex_fallback_unsupported", reason: "no_device_environment" },
      );
    }
    const before = readCodexFallbackSetting(existing.runtimeConfig);
    const next = {
      enabled: input.enabled,
      ...(input.model ? { model: input.model } : {}),
      ...(input.modelReasoningEffort ? { modelReasoningEffort: input.modelReasoningEffort } : {}),
    };
    const now = clock();
    const [updated] = await db
      .update(agents)
      .set({
        runtimeConfig: sql`(case when jsonb_typeof(${agents.runtimeConfig}) = 'object' then ${agents.runtimeConfig} else '{}'::jsonb end)
          || ${JSON.stringify({ codexFallback: next })}::jsonb`,
        updatedAt: now,
      })
      .where(and(eq(agents.id, existing.id), eq(agents.companyId, existing.companyId)))
      .returning();
    if (!updated) throw notFound("Agent not found");
    const after = readCodexFallbackSetting(updated.runtimeConfig);
    const changed = before.enabled !== after.enabled || before.model !== after.model
      || before.modelReasoningEffort !== after.modelReasoningEffort;
    if (changed) {
      await logActivity(db, {
        companyId: updated.companyId,
        actorType: ctx.audit.actorType,
        actorId: ctx.audit.actorId,
        agentId: ctx.audit.agentId ?? null,
        runId: ctx.audit.runId ?? null,
        agentApiKeyId: ctx.audit.agentApiKeyId ?? null,
        action: "agent.codex_fallback_updated",
        entityType: "agent",
        entityId: updated.id,
        details: {
          enabled: after.enabled,
          model: after.model,
          modelReasoningEffort: after.modelReasoningEffort,
          previousEnabled: before.enabled,
        },
      });
    }
    if (after.enabled && !before.enabled) {
      // Tasks already waiting for the Claude reset start on Codex now.
      await wakeResourceWaits(db, { agentIds: [updated.id], companyId: updated.companyId, kinds: [...CODEX_FALLBACK_WAIT_KINDS] }, { now })
        .catch((err) => logger.warn({ err, agentId: updated.id }, "failed to wake waits after turning the Codex fallback on"));
    }
    return view(actor, updated);
  }

  return { get, set, getAgent };
}
