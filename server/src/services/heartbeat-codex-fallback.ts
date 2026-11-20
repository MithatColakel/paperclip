import { and, eq, sql } from "drizzle-orm";
import { type Db, agents, heartbeatRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import {
  CODEX_FALLBACK_ADAPTER_TYPE,
  CODEX_FALLBACK_CONTEXT_KEY,
  CODEX_FALLBACK_SOURCE_ADAPTER_TYPE,
  CODEX_FALLBACK_WAIT_KINDS,
  blockCodexFallback,
  clearCodexFallbackBlock,
  codexBlockUntil,
  codexFallbackAgent,
  evaluateCodexFallback,
  readCodexFallbackAttribution,
  type CodexFallbackAttribution,
} from "./codex-fallback-policy.js";
import { claimedAdapterType } from "./conversation-continuation.js";
import {
  endedWithoutAccountFailure,
  isPersistedNativeRun,
  readRunEnd,
  readRunFailureFacts,
  type RunFailureProvenance,
} from "./heartbeat-ai-accounts.js";
import { DEVICE_LOGIN_ATTRIBUTION_KEY } from "./heartbeat-device-login.js";
import {
  claimResourceWaitNotice,
  releaseResourceWaitNotice,
  type ResourceWaitWakeFilter,
  type ResourceWaitWakeOptions,
} from "./resource-waits/index.js";

/**
 * Fork: the run path of the Codex fallback (policy in codex-fallback-policy.ts,
 * docs in AI-CONNECTIONS.md, "Codex fallback on a device").
 *
 * - `applyToRun` (executeRun, before anything adapter-specific): a claimed
 *   `claude_local` run of an agent whose Claude account is at its limit, with
 *   the fallback on and Codex not turned off on its device, is switched to the
 *   Codex adapter: its claim and its `codexFallback` attribution are written in
 *   one compare-and-set, and the Claude attributions it copied from the run it
 *   retries are dropped, so no Claude failure handler ever charges this run.
 *   A run whose claim already names Codex keeps it (a resumed execution).
 * - `proceedsForWait` (the wait hold): a Claude limit wait of such an agent
 *   proceeds now instead of at the reset.
 * - `wakeIfEligible`: after a Claude limit is recorded, or the setting is
 *   turned on, the agent's limit waits are woken so they start on Codex.
 * - `noteRunEnded` (run completion): a fallback run that Codex served clears
 *   any block on its device; one that hit Codex's limit, or failed before
 *   Codex served it, turns the fallback off there until Codex's reset (or for
 *   an hour), and the caller retries the task, which then waits for Claude.
 */

type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;
type AgentRow = typeof agents.$inferSelect;

export interface CodexFallbackRunEvent {
  eventType: string;
  stream?: "system" | "stdout" | "stderr";
  level?: "info" | "warn" | "error";
  message?: string;
  payload?: Record<string, unknown>;
}

export interface CreateHeartbeatCodexFallbackOptions {
  db: Db;
  wakeResourceWaits: (filter: ResourceWaitWakeFilter, options?: ResourceWaitWakeOptions) => Promise<unknown>;
  appendRunEvent?: (run: HeartbeatRunRow, event: CodexFallbackRunEvent) => Promise<unknown>;
  now?: () => Date;
}

export interface CodexFallbackApplied {
  /** The run row to go on with (its claim and context may have changed). */
  run: HeartbeatRunRow;
  /** Set when the run executes on Codex: the agent as Codex, and why. */
  fallback: { agent: AgentRow; attribution: CodexFallbackAttribution } | null;
}

export interface CodexFallbackRunEnd {
  /** The run was a fallback run. */
  fallback: boolean;
  /** Codex is now turned off on the run's device; the caller retries the task (it waits for Claude). */
  blocked: boolean;
  blockedUntil: Date | null;
  reason: "codex_limit" | "codex_failed" | "served" | "not_fallback" | "other_end";
}

export const CODEX_FALLBACK_RETRY_REASON = "codex_fallback_unavailable";

function describeClaude(attribution: CodexFallbackAttribution): string {
  return attribution.claudeSource === "pool_account"
    ? `Claude account "${attribution.accountLabel ?? "pool account"}"`
    : `the Claude login on ${attribution.environmentName ?? "this device"}`;
}

export function createHeartbeatCodexFallback(options: CreateHeartbeatCodexFallbackOptions) {
  const { db } = options;
  const clock = options.now ?? (() => new Date());

  async function event(run: HeartbeatRunRow, value: CodexFallbackRunEvent): Promise<void> {
    if (!options.appendRunEvent) return;
    await Promise.resolve(options.appendRunEvent(run, value)).catch(() => undefined);
  }

  async function logStartedOnce(run: HeartbeatRunRow, agent: AgentRow, attribution: CodexFallbackAttribution, now: Date): Promise<void> {
    const onceKey = `activity:agent.codex_fallback_started:${agent.id}:${attribution.environmentId}:${attribution.claudeUntil}`;
    if (!(await claimResourceWaitNotice(db, run.companyId, onceKey, now).catch(() => false))) return;
    try {
      await logActivity(db, {
        companyId: run.companyId,
        actorType: "system",
        actorId: "heartbeat",
        action: "agent.codex_fallback_started",
        entityType: "agent",
        entityId: agent.id,
        agentId: agent.id,
        runId: run.id,
        details: {
          environment: attribution.environmentName,
          claudeSource: attribution.claudeSource,
          ...(attribution.accountLabel ? { accountLabel: attribution.accountLabel } : {}),
          claudeUntil: attribution.claudeUntil,
          model: attribution.model,
        },
      });
    } catch (error) {
      await releaseResourceWaitNotice(db, run.companyId, onceKey).catch(() => undefined);
      logger.warn({ err: error, runId: run.id }, "failed to log a Codex fallback start");
    }
  }

  /**
   * For a claimed run, before anything adapter-specific is prepared. Returns
   * the agent and run to execute when the run uses Codex, else null (the run
   * goes on as the agent's own adapter, which may then wait for its limit).
   */
  async function applyToRun(input: { run: HeartbeatRunRow; agent: AgentRow; now?: Date }): Promise<CodexFallbackApplied> {
    const { run, agent } = input;
    const unchanged: CodexFallbackApplied = { run, fallback: null };
    if (agent.adapterType !== CODEX_FALLBACK_SOURCE_ADAPTER_TYPE) return unchanged;
    const claimed = claimedAdapterType(run);
    const saved = readCodexFallbackAttribution(run.contextSnapshot);
    if (claimed === CODEX_FALLBACK_ADAPTER_TYPE) {
      // The claim is immutable recovery evidence: a resumed execution stays on Codex.
      if (!saved) return unchanged;
      return { run, fallback: { agent: codexFallbackAgent(agent, saved), attribution: saved } };
    }
    if (claimed && claimed !== CODEX_FALLBACK_SOURCE_ADAPTER_TYPE) return unchanged;
    if (isPersistedNativeRun(run)) return unchanged;

    const now = input.now ?? clock();
    const decision = await evaluateCodexFallback(db, { agent, now });
    if (!decision.eligible) {
      if (!saved) return unchanged;
      // A retry of a fallback run that goes back to Claude keeps no Codex attribution.
      const [cleaned] = await db.update(heartbeatRuns)
        .set({ contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) - ${CODEX_FALLBACK_CONTEXT_KEY}::text` })
        .where(eq(heartbeatRuns.id, run.id))
        .returning();
      return { run: cleaned ?? run, fallback: null };
    }
    const attribution = decision.attribution;
    const [updated] = await db
      .update(heartbeatRuns)
      .set({
        runnerProfileJson: sql`(case when jsonb_typeof(${heartbeatRuns.runnerProfileJson}) = 'object' then ${heartbeatRuns.runnerProfileJson} else '{}'::jsonb end)
          || ${JSON.stringify({ adapterDispatch: { adapterType: CODEX_FALLBACK_ADAPTER_TYPE } })}::jsonb`,
        // The Claude attributions copied from the run this one retries never describe a Codex run.
        contextSnapshot: sql`((coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) - ${DEVICE_LOGIN_ATTRIBUTION_KEY}::text)
          - (case when coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) -> 'aiConnection' ->> 'mode' in ('pool_account', 'host_pool') then 'aiConnection' else '' end))
          || ${JSON.stringify({ [CODEX_FALLBACK_CONTEXT_KEY]: attribution })}::jsonb`,
        updatedAt: now,
      })
      .where(and(
        eq(heartbeatRuns.id, run.id),
        eq(heartbeatRuns.status, "running"),
        sql`coalesce(${heartbeatRuns.runnerProfileJson} -> 'adapterDispatch' ->> 'adapterType', ${CODEX_FALLBACK_SOURCE_ADAPTER_TYPE}) = ${CODEX_FALLBACK_SOURCE_ADAPTER_TYPE}`,
      ))
      .returning();
    if (!updated) return unchanged;
    await event(updated, {
      eventType: "lifecycle",
      stream: "system",
      level: "info",
      message: `${describeClaude(attribution)} is at its usage limit until ${attribution.claudeUntil}. `
        + `This run uses the Codex login of ${attribution.environmentName ?? "this device"} instead (agent setting "Codex fallback"); `
        + "the agent goes back to Claude after the reset.",
      payload: {
        codexFallback: true,
        environmentId: attribution.environmentId,
        claudeSource: attribution.claudeSource,
        claudeUntil: attribution.claudeUntil,
        model: attribution.model,
      },
    });
    await logStartedOnce(updated, agent, attribution, now);
    return { run: updated, fallback: { agent: codexFallbackAgent(agent, attribution), attribution } };
  }

  /** Whether a Claude limit wait of this agent should proceed now (it would run on Codex). */
  async function proceedsForWait(input: { agent: AgentRow; now?: Date }): Promise<boolean> {
    const decision = await evaluateCodexFallback(db, { agent: input.agent, now: input.now ?? clock() });
    return decision.eligible;
  }

  /** Wakes the agent's Claude limit waits when its runs would use Codex now. */
  async function wakeIfEligible(input: { agent: AgentRow; now?: Date }): Promise<boolean> {
    const now = input.now ?? clock();
    const decision = await evaluateCodexFallback(db, { agent: input.agent, now });
    if (!decision.eligible) return false;
    try {
      await options.wakeResourceWaits(
        { agentIds: [input.agent.id], companyId: input.agent.companyId, kinds: [...CODEX_FALLBACK_WAIT_KINDS] },
        { now },
      );
    } catch (error) {
      logger.warn({ err: error, agentId: input.agent.id }, "failed to wake waits for the Codex fallback");
      return false;
    }
    return true;
  }

  /**
   * A fallback run ended. Pass the finished run row. A run Codex served ends
   * any block on its device; a Codex limit or a failure before Codex served
   * the run blocks the fallback there. Cancelled and other ends change
   * nothing.
   */
  async function noteRunEnded(input: { run: HeartbeatRunRow; provenance?: RunFailureProvenance | null; now?: Date }): Promise<CodexFallbackRunEnd> {
    const { run } = input;
    const none = (reason: CodexFallbackRunEnd["reason"], fallback = false): CodexFallbackRunEnd => ({ fallback, blocked: false, blockedUntil: null, reason });
    const attribution = readCodexFallbackAttribution(run.contextSnapshot);
    if (!attribution || claimedAdapterType(run) !== CODEX_FALLBACK_ADAPTER_TYPE) return none("not_fallback");
    const stored = await readRunEnd(db, run.id);
    if (!stored) return none("other_end", true);
    const now = input.now ?? clock();
    if (endedWithoutAccountFailure(stored.end)) {
      await clearCodexFallbackBlock(db, { companyId: run.companyId, environmentId: attribution.environmentId, now });
      return none("served", true);
    }
    if (stored.end.status !== "failed" && stored.end.status !== "timed_out") return none("other_end", true);
    const facts = await readRunFailureFacts(db, run.id, input.provenance);
    const reason = facts?.family === "provider_quota" ? "codex_limit" as const : "codex_failed" as const;
    const until = codexBlockUntil({ now, reason, typedReset: facts?.typedReset ?? null });
    const blockedUntil = await blockCodexFallback(db, {
      companyId: run.companyId,
      environmentId: attribution.environmentId,
      until,
      reason,
      runId: run.id,
      now,
    });
    await event(run, {
      eventType: "lifecycle",
      stream: "system",
      level: "warn",
      message: reason === "codex_limit"
        ? `Codex on ${attribution.environmentName ?? "this device"} is at its own usage limit until ${(blockedUntil ?? until).toISOString()}. `
          + `This task waits for ${describeClaude(attribution)} to reset, or for Codex, whichever the next attempt finds first.`
        : `The Codex fallback run on ${attribution.environmentName ?? "this device"} failed before Codex served it. `
          + `The fallback is off on this device until ${(blockedUntil ?? until).toISOString()}; this task waits for ${describeClaude(attribution)} to reset.`,
      payload: {
        codexFallback: true,
        environmentId: attribution.environmentId,
        blockReason: reason,
        blockedUntil: (blockedUntil ?? until).toISOString(),
        errorCode: facts?.errorCode ?? null,
      },
    });
    return { fallback: true, blocked: true, blockedUntil: blockedUntil ?? until, reason };
  }

  return { applyToRun, proceedsForWait, wakeIfEligible, noteRunEnded };
}

export type HeartbeatCodexFallback = ReturnType<typeof createHeartbeatCodexFallback>;
