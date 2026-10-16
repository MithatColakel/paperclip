import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { AiAccountCredentialType, AiAccountHostKind, AiAccountLimitReason, AiAccountStatus } from "@paperclipai/shared";
import { environments } from "./environments.js";
import { projects } from "./projects.js";

/**
 * Fork: an execution device, i.e. one machine that runs agents (the Paperclip
 * server, an SSH runner, or a device that an environment driver plugin
 * reports). At most `min(max_accounts, 3)` distinct pool accounts are in use
 * by the agents that run on it.
 *
 * Instance-level by design, an explicit exception to company scoping (see
 * AGENTS.md §5): one machine serves every company's runs. Instance admins
 * manage these rows and the managing plugin reports its targets; each run's
 * use is logged in the run's own company.
 */
export const aiAccountHosts = pgTable("ai_account_hosts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  kind: text("kind").$type<AiAccountHostKind>().notNull(),
  maxAccounts: integer("max_accounts").notNull().default(3),
  /** Legacy host-pool setting. Ignored by pool accounts. */
  overflowToOtherAccounts: boolean("overflow_to_other_accounts").notNull().default(true),
  createdByUserId: text("created_by_user_id"),
  /** Derived identity: `local`, or `ssh:<lower(host)>:<port>`. */
  externalKey: text("external_key"),
  /** Plugin identity: `target:<pluginId>:<provider>:<targetKey>`. A linked row carries both keys. */
  targetKey: text("target_key"),
  /** The sandbox provider whose environments run on this device. */
  targetProvider: text("target_provider"),
  /** 1–3 top-level config fields that pick this device's sandbox environments. */
  targetMatch: jsonb("target_match").$type<Record<string, string>>(),
  /** The last target report, used to seed availability for environments created later. */
  targetState: jsonb("target_state").$type<Record<string, unknown>>(),
  targetReportedAt: timestamp("target_reported_at", { withTimezone: true }),
  /** The only plugin allowed to report this target. */
  managedByPluginId: uuid("managed_by_plugin_id"),
  /** Display only, from a plugin report. Ownership never gates core runs. */
  ownerUserId: text("owner_user_id"),
  ownerSource: text("owner_source").$type<"plugin">(),
  /** Set when bound accounts exceed the cap after a change that could not be refused. */
  overLimitAt: timestamp("over_limit_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("ai_account_hosts_name_uq").on(t.name),
  uniqueIndex("ai_account_hosts_external_key_uq").on(t.externalKey).where(sql`${t.externalKey} is not null`),
  uniqueIndex("ai_account_hosts_target_key_uq").on(t.targetKey).where(sql`${t.targetKey} is not null`),
  check("ai_account_hosts_kind_check", sql`${t.kind} in ('server','ssh_host','mac','external')`),
  check("ai_account_hosts_max_accounts_check", sql`${t.maxAccounts} between 1 and 3`),
  check("ai_account_hosts_owner_source_check", sql`${t.ownerSource} is null or ${t.ownerSource} in ('plugin')`),
]);

/** Which device an execution environment runs on. An environment is on at most one device. */
export const aiAccountHostEnvironments = pgTable("ai_account_host_environments", {
  environmentId: uuid("environment_id").primaryKey().references(() => environments.id, { onDelete: "cascade" }),
  hostId: uuid("host_id").notNull().references(() => aiAccountHosts.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("ai_account_host_environments_host_idx").on(t.hostId),
]);

/**
 * Fork: a user-owned pool account holding one Claude credential, a
 * subscription setup token or an API key. The value is local_encrypted
 * material under the instance master key and is never returned by the API.
 *
 * The effective owner is `coalesce(owner_user_id, created_by_user_id)`. One
 * credential (by fingerprint) has one owner; an e-mail hint is unique per
 * owner. `host_id` is a legacy hint: new accounts have none, and deleting a
 * device never deletes a credential.
 */
export const aiAccounts = pgTable("ai_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  hostId: uuid("host_id").references(() => aiAccountHosts.id, { onDelete: "set null" }),
  provider: text("provider").notNull().default("anthropic"),
  credentialType: text("credential_type").$type<AiAccountCredentialType>().notNull(),
  label: text("label").notNull(),
  emailHint: text("email_hint"),
  plan: text("plan"),
  /** Kept for a rolled-back image: written as `status <> 'disabled' and admin_disabled_at is null`. */
  poolEnabled: boolean("pool_enabled").notNull().default(true),
  status: text("status").$type<AiAccountStatus>().notNull().default("active"),
  statusMessage: text("status_message"),
  credentialMaterial: jsonb("credential_material").$type<Record<string, unknown>>().notNull(),
  credentialFingerprint: text("credential_fingerprint").notNull(),
  credentialHint: text("credential_hint"),
  exhaustedUntil: timestamp("exhausted_until", { withTimezone: true }),
  limitReason: text("limit_reason").$type<AiAccountLimitReason>(),
  limitRunId: uuid("limit_run_id"),
  /** Where `exhausted_until` came from. */
  limitSource: text("limit_source").$type<"provider" | "estimated">(),
  /** Consecutive limit hits with no successful run in between. */
  limitStrikes: integer("limit_strikes").notNull().default(0),
  /** Set when strikes go from 0 to 1 and cleared on success: the key for limit notices. */
  limitEpisodeStartedAt: timestamp("limit_episode_started_at", { withTimezone: true }),
  /** The one waiting run released to test an estimated reset. */
  limitProbeRunId: uuid("limit_probe_run_id"),
  lastLimitedAt: timestamp("last_limited_at", { withTimezone: true }),
  lastSelectedAt: timestamp("last_selected_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  /** The first unconfirmed auth failure (two-strike rule). */
  authSuspectAt: timestamp("auth_suspect_at", { withTimezone: true }),
  authSuspectRunId: uuid("auth_suspect_run_id"),
  ownerUserId: text("owner_user_id"),
  origin: text("origin").$type<"pool" | "legacy_host_pool">().notNull().default("pool"),
  /** Instance-admin withdrawal, separate from the owner's `status`. Only admins clear it. */
  adminDisabledAt: timestamp("admin_disabled_at", { withTimezone: true }),
  adminDisabledByUserId: text("admin_disabled_by_user_id"),
  adminDisabledReason: text("admin_disabled_reason"),
  createdByUserId: text("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("ai_accounts_host_idx").on(t.hostId),
  index("ai_accounts_owner_idx").on(t.ownerUserId),
  uniqueIndex("ai_accounts_fingerprint_uq").on(t.credentialFingerprint),
  uniqueIndex("ai_accounts_owner_email_hint_uq")
    .on(sql`coalesce(${t.ownerUserId}, ${t.createdByUserId})`, sql`lower(${t.emailHint})`)
    .where(sql`${t.emailHint} is not null`),
  check("ai_accounts_provider_check", sql`${t.provider} in ('anthropic')`),
  check("ai_accounts_credential_type_check", sql`${t.credentialType} in ('subscription','api_key')`),
  check("ai_accounts_status_check", sql`${t.status} in ('active','auth_failed','disabled')`),
  check("ai_accounts_limit_reason_check", sql`${t.limitReason} is null or ${t.limitReason} in ('provider_quota','credit_balance','manual')`),
  check("ai_accounts_limit_source_check", sql`${t.limitSource} is null or ${t.limitSource} in ('provider','estimated')`),
  check("ai_accounts_origin_check", sql`${t.origin} in ('pool','legacy_host_pool')`),
]);

/**
 * Projects an account is reserved for. An account with rows is usable only in
 * companies that own one of those projects, until its owner clears the
 * restriction.
 */
export const aiAccountProjects = pgTable("ai_account_projects", {
  accountId: uuid("account_id").notNull().references(() => aiAccounts.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.accountId, t.projectId], name: "ai_account_projects_pk" }),
  index("ai_account_projects_project_idx").on(t.projectId),
]);
