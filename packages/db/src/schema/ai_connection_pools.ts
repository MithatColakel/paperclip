import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { AiConnectionPoolUsageWindow, AiConnectionQuotaReason, AiConnectionQuotaSource, AiProvider } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { connectionGrants, toolConnections } from "./tool_access.js";

/** Ordered company-shared AI accounts that `company_pool` bindings fail over between.
 * Composite foreign keys keep every member inside its own company. */
export const aiConnectionPoolMembers = pgTable("ai_connection_pool_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  provider: text("provider").$type<AiProvider>().notNull(),
  connectionId: uuid("connection_id").notNull(),
  grantId: uuid("grant_id").notNull(),
  priority: integer("priority").notNull(),
  createdByUserId: text("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("ai_connection_pool_members_connection_uq").on(t.companyId, t.provider, t.connectionId),
  uniqueIndex("ai_connection_pool_members_priority_uq").on(t.companyId, t.provider, t.priority),
  foreignKey({ columns: [t.companyId, t.connectionId], foreignColumns: [toolConnections.companyId, toolConnections.id], name: "ai_connection_pool_members_company_connection_fk" }).onDelete("cascade"),
  foreignKey({ columns: [t.companyId, t.grantId], foreignColumns: [connectionGrants.companyId, connectionGrants.id], name: "ai_connection_pool_members_company_grant_fk" }).onDelete("cascade"),
  check("ai_connection_pool_members_provider_check", sql`${t.provider} in ('anthropic','openai','openrouter','xai')`),
  check("ai_connection_pool_members_priority_check", sql`${t.priority} >= 0`),
]);

/** Per-account usage-limit state. A row whose `exhaustedUntil` has passed is available again. */
export const aiConnectionQuotaStates = pgTable("ai_connection_quota_states", {
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id").notNull(),
  exhaustedUntil: timestamp("exhausted_until", { withTimezone: true }),
  reason: text("reason").$type<AiConnectionQuotaReason>(),
  source: text("source").$type<AiConnectionQuotaSource>(),
  lastRunId: uuid("last_run_id"),
  usageCheckedAt: timestamp("usage_checked_at", { withTimezone: true }),
  usageWindows: jsonb("usage_windows").$type<AiConnectionPoolUsageWindow[]>(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.companyId, t.connectionId], name: "ai_connection_quota_states_pk" }),
  foreignKey({ columns: [t.companyId, t.connectionId], foreignColumns: [toolConnections.companyId, toolConnections.id], name: "ai_connection_quota_states_company_connection_fk" }).onDelete("cascade"),
  index("ai_connection_quota_states_exhausted_idx").on(t.companyId, t.exhaustedUntil),
  check("ai_connection_quota_states_reason_check", sql`${t.reason} is null or ${t.reason} in ('provider_quota','usage_threshold')`),
  check("ai_connection_quota_states_source_check", sql`${t.source} is null or ${t.source} in ('run_failure','usage_probe','manual')`),
]);
