import { and, eq, isNull, or, sql } from "drizzle-orm";
import { type Db, agents, aiAccountAgentBindings, aiAccounts, deviceLoginLimits, environments } from "@paperclipai/db";

/**
 * Fork: Codex fallback on a device (doc/connections/AI-CONNECTIONS.md,
 * "Codex fallback on a device").
 *
 * A Claude agent (`claude_local`) whose company admin turned the fallback on
 * runs on its device's own Codex login while its Claude account (its pool
 * account, or the device's own Claude login) is at its usage limit, instead of
 * waiting for the reset. It comes back to Claude by itself once the limit has
 * passed. This is the one exception to the no-failover rule (AGENTS.md, core
 * rule 3): the owner asked for it on 2026-11-20, and it never moves a task to
 * another Claude account, another device, or a Codex login that is not that
 * device's own.
 *
 * Only an agent whose own default environment is an active sandbox
 * environment (a Mac Fleet device) qualifies: there the Codex CLI reads the
 * device's own `~/.codex/auth.json`, and nothing copies it to the server. A
 * Codex limit or a failed fallback run turns the fallback off on that
 * environment for a while (`codex_fallback_blocked_until`); its tasks then wait
 * for the Claude reset as before.
 *
 * This module holds the policy only (database reads and pure builders), so the
 * wait hold can use it without importing the heartbeat services.
 */

export const CODEX_FALLBACK_SOURCE_ADAPTER_TYPE = "claude_local";
export const CODEX_FALLBACK_ADAPTER_TYPE = "codex_local";
/** `contextSnapshot.codexFallback`: this run uses the device's Codex login instead of Claude. */
export const CODEX_FALLBACK_CONTEXT_KEY = "codexFallback";
/** The adapter config flag that keeps Codex on the device's own login (codex-local adapter). */
export const CODEX_DEVICE_LOGIN_CONFIG_KEY = "deviceCodexLogin";

/** Claude limit waits the fallback replaces: a pool account's limit, or the device's own Claude login. */
export const CODEX_FALLBACK_WAIT_KINDS = ["ai_account", "device_login"] as const;

export const CODEX_FALLBACK_TIMINGS = {
  /** A fallback run failed before Codex served it (no login, Codex missing, a sign-in failure). */
  failedBlockMs: 60 * 60 * 1000,
  /** Codex reported its own usage limit without a reset time. */
  limitEstimateMs: 5 * 60 * 60 * 1000,
  /** A typed Codex reset is never trusted further ahead than this. */
  maxBlockMs: (7 * 24 + 1) * 60 * 60 * 1000,
} as const;

export interface CodexFallbackSetting {
  enabled: boolean;
  model: string | null;
  modelReasoningEffort: string | null;
}

export type CodexFallbackClaudeSource = "pool_account" | "device_login";

export interface CodexFallbackAttribution {
  environmentId: string;
  environmentName: string | null;
  claudeSource: CodexFallbackClaudeSource;
  accountId: string | null;
  accountLabel: string | null;
  /** When the Claude limit resets (ISO). */
  claudeUntil: string;
  model: string | null;
  modelReasoningEffort: string | null;
}

export type CodexFallbackIneligibleReason =
  | "disabled"
  | "adapter"
  | "no_device_environment"
  | "upstream_connection"
  | "claude_available"
  | "codex_blocked";

export type CodexFallbackDecision =
  | { eligible: true; attribution: CodexFallbackAttribution }
  | { eligible: false; reason: CodexFallbackIneligibleReason; codexBlockedUntil?: Date | null };

type AgentRef = Pick<typeof agents.$inferSelect, "id" | "companyId" | "adapterType" | "runtimeConfig" | "defaultEnvironmentId">;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** The agent's `runtimeConfig.codexFallback`; off unless `enabled` is exactly true. */
export function readCodexFallbackSetting(runtimeConfig: unknown): CodexFallbackSetting {
  const raw = asRecord(asRecord(runtimeConfig).codexFallback);
  return {
    enabled: raw.enabled === true,
    model: nonEmptyString(raw.model),
    modelReasoningEffort: nonEmptyString(raw.modelReasoningEffort),
  };
}

/** The run's own fallback attribution, written when it switched to Codex. */
export function readCodexFallbackAttribution(contextSnapshot: unknown): CodexFallbackAttribution | null {
  const raw = asRecord(asRecord(contextSnapshot)[CODEX_FALLBACK_CONTEXT_KEY]);
  const environmentId = nonEmptyString(raw.environmentId);
  const claudeUntil = nonEmptyString(raw.claudeUntil);
  const claudeSource = raw.claudeSource === "pool_account" || raw.claudeSource === "device_login" ? raw.claudeSource : null;
  if (!environmentId || !claudeUntil || !claudeSource) return null;
  return {
    environmentId,
    environmentName: nonEmptyString(raw.environmentName),
    claudeSource,
    accountId: nonEmptyString(raw.accountId),
    accountLabel: nonEmptyString(raw.accountLabel),
    claudeUntil,
    model: nonEmptyString(raw.model),
    modelReasoningEffort: nonEmptyString(raw.modelReasoningEffort),
  };
}

/** Claude-only adapter settings that Codex must not receive. */
const CLAUDE_ONLY_CONFIG_KEYS = [
  "model",
  "effort",
  "chrome",
  "maxTurnsPerRun",
  "dangerouslySkipPermissions",
  "command",
  "extraArgs",
  "engine",
  "agentCommand",
  "mode",
  "stateDir",
  "nonInteractivePermissions",
  "warmHandleIdleMs",
  "stalledToolTimeoutSec",
] as const;

/** Env keys that would point Codex at another credential than the device's own login. */
function isForeignCredentialEnvKey(key: string): boolean {
  return key.startsWith("CLAUDE_") || key.startsWith("ANTHROPIC_") || key === "OPENAI_API_KEY" || key === "CODEX_HOME";
}

/** An adapter config (or per-task override) without Claude-only settings and foreign credential env. */
export function stripClaudeOnlyAdapterConfig(value: unknown): Record<string, unknown> {
  const source = asRecord(value);
  const config: Record<string, unknown> = { ...source };
  for (const key of CLAUDE_ONLY_CONFIG_KEYS) delete config[key];
  const env = asRecord(source.env);
  if (Object.keys(env).length > 0) {
    config.env = Object.fromEntries(Object.entries(env).filter(([key]) => !isForeignCredentialEnvKey(key)));
  }
  return config;
}

/**
 * The Codex adapter config of a fallback run, built from the Claude agent's
 * own config: instructions, prompt, working directory, workspace strategy,
 * timeouts and the non-credential env stay; Claude-only settings go; Codex
 * runs on the CLI engine, with approvals bypassed exactly when Claude skipped
 * its permission prompts, and only on the device's own Codex login.
 */
export function buildCodexFallbackAdapterConfig(
  claudeConfig: unknown,
  setting: Pick<CodexFallbackSetting, "model" | "modelReasoningEffort">,
): Record<string, unknown> {
  const source = asRecord(claudeConfig);
  const config = stripClaudeOnlyAdapterConfig(source);
  config.engine = "cli";
  config.dangerouslyBypassApprovalsAndSandbox = source.dangerouslySkipPermissions !== false;
  config[CODEX_DEVICE_LOGIN_CONFIG_KEY] = true;
  if (setting.model) config.model = setting.model;
  if (setting.modelReasoningEffort) config.modelReasoningEffort = setting.modelReasoningEffort;
  return config;
}

/** The agent as a fallback run executes it: the same agent on the Codex adapter. */
export function codexFallbackAgent<T extends { adapterType: string; adapterConfig: unknown }>(
  agent: T,
  setting: Pick<CodexFallbackSetting, "model" | "modelReasoningEffort">,
): T {
  return {
    ...agent,
    adapterType: CODEX_FALLBACK_ADAPTER_TYPE,
    adapterConfig: buildCodexFallbackAdapterConfig(agent.adapterConfig, setting),
  };
}

export interface CodexFallbackEnvironment {
  id: string;
  name: string;
}

/** The agent's own default environment when it is an active device (sandbox) environment. */
export async function codexFallbackEnvironment(db: Db, agent: Pick<AgentRef, "companyId" | "defaultEnvironmentId">): Promise<CodexFallbackEnvironment | null> {
  if (!agent.defaultEnvironmentId) return null;
  const [row] = await db
    .select({ id: environments.id, name: environments.name, driver: environments.driver, status: environments.status })
    .from(environments)
    .where(and(
      eq(environments.id, agent.defaultEnvironmentId),
      or(isNull(environments.companyId), eq(environments.companyId, agent.companyId)),
    ));
  if (!row || row.driver !== "sandbox" || row.status !== "active") return null;
  return { id: row.id, name: row.name };
}

/**
 * Whether the agent's next run would use Codex instead of waiting for Claude:
 * the setting is on, the agent is a Claude agent on a device environment, its
 * Claude account is at its usage limit now (a limit whose reset has passed is
 * not: the next Claude run tests it), and Codex is not turned off there.
 */
export async function evaluateCodexFallback(
  db: Db,
  input: { agent: AgentRef; now: Date },
): Promise<CodexFallbackDecision> {
  const { agent, now } = input;
  const setting = readCodexFallbackSetting(agent.runtimeConfig);
  if (!setting.enabled) return { eligible: false, reason: "disabled" };
  if (agent.adapterType !== CODEX_FALLBACK_SOURCE_ADAPTER_TYPE) return { eligible: false, reason: "adapter" };
  const environment = await codexFallbackEnvironment(db, agent);
  if (!environment) return { eligible: false, reason: "no_device_environment" };

  const [binding] = await db
    .select({ mode: aiAccountAgentBindings.mode, accountId: aiAccountAgentBindings.accountId })
    .from(aiAccountAgentBindings)
    .where(and(eq(aiAccountAgentBindings.agentId, agent.id), eq(aiAccountAgentBindings.companyId, agent.companyId)));
  const [limitRow] = await db
    .select()
    .from(deviceLoginLimits)
    .where(and(eq(deviceLoginLimits.environmentId, environment.id), eq(deviceLoginLimits.companyId, agent.companyId)));

  let claude: { source: CodexFallbackClaudeSource; accountId: string | null; accountLabel: string | null; until: Date } | null = null;
  if (binding?.mode === "pool_account") {
    if (binding.accountId) {
      const [account] = await db
        .select({ id: aiAccounts.id, label: aiAccounts.label, exhaustedUntil: aiAccounts.exhaustedUntil })
        .from(aiAccounts)
        .where(eq(aiAccounts.id, binding.accountId));
      if (account?.exhaustedUntil && account.exhaustedUntil.getTime() > now.getTime()) {
        claude = { source: "pool_account", accountId: account.id, accountLabel: account.label, until: account.exhaustedUntil };
      }
    }
  } else {
    // Without a binding row an upstream AI connection serves the agent, not the device's login.
    if (!binding && asRecord(agent.runtimeConfig).aiConnection) return { eligible: false, reason: "upstream_connection" };
    if (limitRow?.exhaustedUntil && limitRow.exhaustedUntil.getTime() > now.getTime()) {
      claude = { source: "device_login", accountId: null, accountLabel: null, until: limitRow.exhaustedUntil };
    }
  }
  if (!claude) return { eligible: false, reason: "claude_available" };
  if (limitRow?.codexFallbackBlockedUntil && limitRow.codexFallbackBlockedUntil.getTime() > now.getTime()) {
    return { eligible: false, reason: "codex_blocked", codexBlockedUntil: limitRow.codexFallbackBlockedUntil };
  }
  return {
    eligible: true,
    attribution: {
      environmentId: environment.id,
      environmentName: environment.name,
      claudeSource: claude.source,
      accountId: claude.accountId,
      accountLabel: claude.accountLabel,
      claudeUntil: claude.until.toISOString(),
      model: setting.model,
      modelReasoningEffort: setting.modelReasoningEffort,
    },
  };
}

/** The Codex reset of a limit, or the estimate, never further ahead than the cap. */
export function codexBlockUntil(input: { now: Date; reason: "codex_limit" | "codex_failed"; typedReset: Date | null }): Date {
  const { now } = input;
  if (input.reason === "codex_failed") return new Date(now.getTime() + CODEX_FALLBACK_TIMINGS.failedBlockMs);
  const cap = now.getTime() + CODEX_FALLBACK_TIMINGS.maxBlockMs;
  if (input.typedReset && input.typedReset.getTime() > now.getTime()) {
    return new Date(Math.min(input.typedReset.getTime(), cap));
  }
  return new Date(now.getTime() + CODEX_FALLBACK_TIMINGS.limitEstimateMs);
}

/**
 * Turns the fallback off on an environment until `until`: its last fallback
 * run hit Codex's limit or failed. A later block never shortens one in force.
 */
export async function blockCodexFallback(
  db: Db,
  input: { companyId: string; environmentId: string; until: Date; reason: "codex_limit" | "codex_failed"; runId: string; now: Date },
): Promise<Date | null> {
  const t = deviceLoginLimits;
  await db.insert(deviceLoginLimits)
    .values({ environmentId: input.environmentId, companyId: input.companyId })
    .onConflictDoNothing({ target: deviceLoginLimits.environmentId });
  const untilText = input.until.toISOString();
  const [row] = await db
    .update(deviceLoginLimits)
    .set({
      codexFallbackBlockedUntil: sql`greatest(coalesce(${t.codexFallbackBlockedUntil}, ${untilText}::timestamptz), ${untilText}::timestamptz)`,
      codexFallbackBlockReason: input.reason,
      codexFallbackBlockRunId: input.runId,
      updatedAt: input.now,
    })
    .where(and(eq(t.environmentId, input.environmentId), eq(t.companyId, input.companyId)))
    .returning({ until: t.codexFallbackBlockedUntil });
  return row?.until ?? null;
}

/** A fallback run that Codex served ends any block on its environment. */
export async function clearCodexFallbackBlock(
  db: Db,
  input: { companyId: string; environmentId: string; now: Date },
): Promise<boolean> {
  const t = deviceLoginLimits;
  const cleared = await db
    .update(deviceLoginLimits)
    .set({ codexFallbackBlockedUntil: null, codexFallbackBlockReason: null, codexFallbackBlockRunId: null, updatedAt: input.now })
    .where(and(
      eq(t.environmentId, input.environmentId),
      eq(t.companyId, input.companyId),
      sql`${t.codexFallbackBlockedUntil} is not null`,
    ))
    .returning({ environmentId: t.environmentId });
  return cleared.length > 0;
}
