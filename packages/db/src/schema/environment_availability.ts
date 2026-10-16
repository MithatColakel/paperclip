import { sql } from "drizzle-orm";
import { bigint, check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { AiAccountCredentialType } from "@paperclipai/shared";
import { environments } from "./environments.js";

/**
 * Fork: target-level availability per execution environment. One machine
 * reached two ways can be up on one path and down on the other, so rows are
 * per environment, not per device. A missing row means available. Admission
 * refusals are per-run waits and never land here.
 *
 * Keyed by environment like `environments` itself, which may be shared by
 * every company, so the registry is instance-level.
 */
export const environmentAvailability = pgTable("environment_availability", {
  environmentId: uuid("environment_id").primaryKey().references(() => environments.id, { onDelete: "cascade" }),
  state: text("state").$type<"available" | "unavailable" | "retired">().notNull(),
  reason: text("reason"),
  /** Target display name, at most 80 characters. */
  label: text("label"),
  /** Sanitized, at most 300 characters. */
  message: text("message"),
  targetKey: text("target_key"),
  /** NULL accepts any credential type. */
  acceptedCredentialTypes: text("accepted_credential_types").array().$type<AiAccountCredentialType[]>(),
  unavailableSince: timestamp("unavailable_since", { withTimezone: true }),
  retryAfter: timestamp("retry_after", { withTimezone: true }),
  checkedAt: timestamp("checked_at", { withTimezone: true }),
  /** NULL means the row is due for a check. */
  nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
  checkFailures: integer("check_failures").notNull().default(0),
  /** Bumped by every report, check or wake, so a deferral can detect a wake it raced with. */
  wakeEpoch: bigint("wake_epoch", { mode: "number" }).notNull().default(0),
  source: text("source").$type<"lease_error" | "probe" | "check" | "plugin_report">().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("environment_availability_state_next_check_idx").on(t.state, t.nextCheckAt),
  check("environment_availability_state_check", sql`${t.state} in ('available','unavailable','retired')`),
  check("environment_availability_source_check", sql`${t.source} in ('lease_error','probe','check','plugin_report')`),
]);
