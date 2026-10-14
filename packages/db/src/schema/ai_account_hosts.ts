import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { AiAccountCredentialType, AiAccountHostKind, AiAccountLimitReason, AiAccountStatus } from "@paperclipai/shared";
import { environments } from "./environments.js";
import { projects } from "./projects.js";

/**
 * Fork: a machine that runs agents (the Paperclip server, a runner server,
 * later a Mac) and the Claude credentials that serve every run on it.
 *
 * Instance-level by design, an explicit exception to company scoping (see
 * AGENTS.md §5): one machine serves every company's runs, and its account
 * limit is per machine. Only instance admins read or change these rows, and
 * each run's use is logged in the run's own company.
 */
export const aiAccountHosts = pgTable("ai_account_hosts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  kind: text("kind").$type<AiAccountHostKind>().notNull(),
  maxAccounts: integer("max_accounts").notNull().default(3),
  /** When a project's own accounts are all limited (or it has none), use the host's other accounts. */
  overflowToOtherAccounts: boolean("overflow_to_other_accounts").notNull().default(true),
  createdByUserId: text("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("ai_account_hosts_name_uq").on(t.name),
  check("ai_account_hosts_kind_check", sql`${t.kind} in ('server','ssh_host','mac')`),
  check("ai_account_hosts_max_accounts_check", sql`${t.maxAccounts} between 1 and 3`),
]);

/** Which host an execution environment runs on. An environment is on at most one host. */
export const aiAccountHostEnvironments = pgTable("ai_account_host_environments", {
  environmentId: uuid("environment_id").primaryKey().references(() => environments.id, { onDelete: "cascade" }),
  hostId: uuid("host_id").notNull().references(() => aiAccountHosts.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("ai_account_host_environments_host_idx").on(t.hostId),
]);

/**
 * One Claude credential on one host: a subscription setup token or an API
 * key. The value is local_encrypted material under the instance master key and
 * is never returned by the API. A credential (by fingerprint) lives on one
 * host only.
 */
export const aiAccounts = pgTable("ai_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  hostId: uuid("host_id").notNull().references(() => aiAccountHosts.id, { onDelete: "cascade" }),
  provider: text("provider").notNull().default("anthropic"),
  credentialType: text("credential_type").$type<AiAccountCredentialType>().notNull(),
  label: text("label").notNull(),
  emailHint: text("email_hint"),
  plan: text("plan"),
  poolEnabled: boolean("pool_enabled").notNull().default(true),
  status: text("status").$type<AiAccountStatus>().notNull().default("active"),
  statusMessage: text("status_message"),
  credentialMaterial: jsonb("credential_material").$type<Record<string, unknown>>().notNull(),
  credentialFingerprint: text("credential_fingerprint").notNull(),
  credentialHint: text("credential_hint"),
  exhaustedUntil: timestamp("exhausted_until", { withTimezone: true }),
  limitReason: text("limit_reason").$type<AiAccountLimitReason>(),
  limitRunId: uuid("limit_run_id"),
  lastLimitedAt: timestamp("last_limited_at", { withTimezone: true }),
  lastSelectedAt: timestamp("last_selected_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdByUserId: text("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("ai_accounts_host_idx").on(t.hostId),
  uniqueIndex("ai_accounts_fingerprint_uq").on(t.credentialFingerprint),
  uniqueIndex("ai_accounts_email_hint_uq").on(sql`lower(${t.emailHint})`).where(sql`${t.emailHint} is not null`),
  check("ai_accounts_provider_check", sql`${t.provider} in ('anthropic')`),
  check("ai_accounts_credential_type_check", sql`${t.credentialType} in ('subscription','api_key')`),
  check("ai_accounts_status_check", sql`${t.status} in ('active','auth_failed','disabled')`),
  check("ai_accounts_limit_reason_check", sql`${t.limitReason} is null or ${t.limitReason} in ('provider_quota','credit_balance','manual')`),
]);

/**
 * Projects an account is reserved for. An account with no rows is shared: it
 * serves runs without a project and projects that have no account of their
 * own. A project's runs use its own accounts first.
 */
export const aiAccountProjects = pgTable("ai_account_projects", {
  accountId: uuid("account_id").notNull().references(() => aiAccounts.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.accountId, t.projectId], name: "ai_account_projects_pk" }),
  index("ai_account_projects_project_idx").on(t.projectId),
]);
