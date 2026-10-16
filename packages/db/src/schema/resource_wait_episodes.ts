import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/**
 * Fork: one wait for a resource (an environment, a pool account or a device's
 * account slots), carried across every replacement run of a chain. A chain is
 * an issue, or an agent for runs without an issue, and has at most one open
 * episode. All mutable wait bookkeeping lives here, never in a run's context.
 */
export const resourceWaitEpisodes = pgTable("resource_wait_episodes", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull(),
  issueId: uuid("issue_id"),
  kind: text("kind").$type<"environment" | "ai_account" | "device_slots">().notNull(),
  reason: text("reason").notNull(),
  scope: text("scope").$type<"target" | "admission" | "account" | "device">().notNull(),
  /** `environment:<id>`, `account:<id>` or `device:<id>`. */
  resourceKey: text("resource_key").notNull(),
  environmentId: uuid("environment_id"),
  deviceId: uuid("device_id"),
  accountId: uuid("account_id"),
  since: timestamp("since", { withTimezone: true }).notNull(),
  currentRunId: uuid("current_run_id"),
  resumeAt: timestamp("resume_at", { withTimezone: true }),
  resumeAtSource: text("resume_at_source").$type<"provider" | "estimated" | "check">(),
  nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
  checks: integer("checks").notNull().default(0),
  gateCheckedAt: timestamp("gate_checked_at", { withTimezone: true }),
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
  longNotifiedAt: timestamp("long_notified_at", { withTimezone: true }),
  resolvedNotifiedAt: timestamp("resolved_notified_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolution: text("resolution").$type<"resolved" | "superseded" | "abandoned" | "refused">(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ columns: [t.companyId, t.agentId], foreignColumns: [agents.companyId, agents.id], name: "resource_wait_episodes_company_agent_fk" }).onDelete("cascade"),
  foreignKey({ columns: [t.companyId, t.issueId], foreignColumns: [issues.companyId, issues.id], name: "resource_wait_episodes_company_issue_fk" }).onDelete("cascade"),
  uniqueIndex("resource_wait_episodes_open_uq")
    .on(t.companyId, sql`coalesce(${t.issueId}::text, 'agent:' || ${t.agentId}::text)`)
    .where(sql`${t.resolvedAt} is null`),
  index("resource_wait_episodes_company_open_idx").on(t.companyId).where(sql`${t.resolvedAt} is null`),
  index("resource_wait_episodes_current_run_idx").on(t.currentRunId),
  // The cascading composite foreign keys need these, or every agent or issue
  // delete scans the (never pruned) episodes table.
  index("resource_wait_episodes_company_issue_idx").on(t.companyId, t.issueId),
  index("resource_wait_episodes_company_agent_idx").on(t.companyId, t.agentId),
  check("resource_wait_episodes_kind_check", sql`${t.kind} in ('environment','ai_account','device_slots')`),
  check("resource_wait_episodes_scope_check", sql`${t.scope} in ('target','admission','account','device')`),
  check("resource_wait_episodes_resume_at_source_check", sql`${t.resumeAtSource} is null or ${t.resumeAtSource} in ('provider','estimated','check')`),
  check("resource_wait_episodes_resolution_check", sql`${t.resolution} is null or ${t.resolution} in ('resolved','superseded','abandoned','refused')`),
]);

/**
 * Fork: "once" gates for wait notices, activity entries and PM wakes. Each
 * first runs `INSERT … ON CONFLICT DO NOTHING RETURNING`; only the inserter
 * acts.
 */
export const resourceWaitNotices = pgTable("resource_wait_notices", {
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  noticeKey: text("notice_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.companyId, t.noticeKey], name: "resource_wait_notices_pk" }),
]);
