import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { aiAccountHosts } from "./ai_account_hosts.js";
import { companies } from "./companies.js";
import { environments } from "./environments.js";

/**
 * Fork: the usage limit of a device's own Claude login, per environment.
 *
 * An agent without a pool account (no binding row, or `device_login`) runs on
 * the login of the user its environment runs as: a Mac's own account, or an
 * SSH user's. When such a run reports a usage limit, the environment's row
 * records the reset, and every later device-login run there waits in the
 * `device_login_wait` lane until it passes, exactly as a pool account's runs
 * wait. Nothing moves a task to another account or another device.
 *
 * Keyed by environment, so the row stays company-scoped and an SSH host whose
 * users have their own logins keeps one limit per user. `device_id` is display
 * context only.
 */
export const deviceLoginLimits = pgTable("device_login_limits", {
  environmentId: uuid("environment_id").primaryKey().references(() => environments.id, { onDelete: "cascade" }),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  deviceId: uuid("device_id").references(() => aiAccountHosts.id, { onDelete: "set null" }),
  /** The reset; null when no limit is in force. */
  exhaustedUntil: timestamp("exhausted_until", { withTimezone: true }),
  limitReason: text("limit_reason").$type<"provider_quota" | "credit_balance">(),
  /** `provider`: the CLI named the reset; `estimated`: no reset was given, or it was clamped. */
  limitSource: text("limit_source").$type<"provider" | "estimated">(),
  /** Hits in a row without a served run; drives the estimate (1, 2, 4, 8, then 12 h). */
  limitStrikes: integer("limit_strikes").notNull().default(0),
  limitEpisodeStartedAt: timestamp("limit_episode_started_at", { withTimezone: true }),
  /** The one run that tests the login after an estimated or repeated limit. */
  limitProbeRunId: uuid("limit_probe_run_id"),
  limitRunId: uuid("limit_run_id"),
  lastLimitedAt: timestamp("last_limited_at", { withTimezone: true }),
  /**
   * Fork: Codex fallback (AI-CONNECTIONS.md, "Codex fallback on a device").
   * While set and ahead, a Claude agent that opted in does not switch to the
   * device's own Codex login here: its last fallback run hit Codex's own
   * usage limit or failed. Its tasks wait for the Claude reset meanwhile.
   */
  codexFallbackBlockedUntil: timestamp("codex_fallback_blocked_until", { withTimezone: true }),
  codexFallbackBlockReason: text("codex_fallback_block_reason").$type<"codex_limit" | "codex_failed">(),
  codexFallbackBlockRunId: uuid("codex_fallback_block_run_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("device_login_limits_company_idx").on(t.companyId),
  index("device_login_limits_device_idx").on(t.deviceId),
  check("device_login_limits_reason_check", sql`${t.limitReason} is null or ${t.limitReason} in ('provider_quota','credit_balance')`),
  check("device_login_limits_source_check", sql`${t.limitSource} is null or ${t.limitSource} in ('provider','estimated')`),
  check("device_login_limits_codex_block_reason_check", sql`${t.codexFallbackBlockReason} is null or ${t.codexFallbackBlockReason} in ('codex_limit','codex_failed')`),
]);
