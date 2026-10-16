import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { aiAccounts } from "./ai_account_hosts.js";
import { companies } from "./companies.js";

/**
 * Fork: which Claude credential an agent runs with.
 *
 * - No row: the legacy path (the upstream `aiConnection`, else the device login).
 * - `device_login`: the device's own login, chosen explicitly.
 * - `pool_account`: that pool account. A NULL `account_id` (the account was
 *   removed, or the migration could not choose) makes the agent wait as
 *   unassigned; it never falls back silently.
 *
 * A separate table rather than an `aiConnection` mode, so a rolled-back image
 * ignores it, PATCH never re-applies it and hires never copy it.
 */
export const aiAccountAgentBindings = pgTable("ai_account_agent_bindings", {
  agentId: uuid("agent_id").primaryKey(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  mode: text("mode").$type<"pool_account" | "device_login">().notNull(),
  accountId: uuid("account_id").references(() => aiAccounts.id, { onDelete: "set null" }),
  source: text("source").$type<"manual" | "migrated_host_pool" | "migrated_company_pool">().notNull().default("manual"),
  /** Why the migration chose this, or why it could not choose. */
  migrationNote: text("migration_note"),
  /** Migrated rows show "review" until an admin confirms them. */
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  updatedByUserId: text("updated_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ columns: [t.companyId, t.agentId], foreignColumns: [agents.companyId, agents.id], name: "ai_account_agent_bindings_company_agent_fk" }).onDelete("cascade"),
  index("ai_account_agent_bindings_account_idx").on(t.accountId),
  index("ai_account_agent_bindings_company_account_idx").on(t.companyId, t.accountId),
  check("ai_account_agent_bindings_mode_check", sql`${t.mode} in ('pool_account','device_login')`),
  check("ai_account_agent_bindings_source_check", sql`${t.source} in ('manual','migrated_host_pool','migrated_company_pool')`),
  check("ai_account_agent_bindings_account_check", sql`${t.mode} = 'pool_account' or ${t.accountId} is null`),
]);
