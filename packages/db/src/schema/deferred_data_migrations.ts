import { integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Fork: markers for data jobs that run at boot after the migrations, outside
 * the migration transaction (for example the Claude account binding
 * backfill). Instance-level job metadata.
 */
export const deferredDataMigrations = pgTable("deferred_data_migrations", {
  key: text("key").primaryKey(),
  status: text("status").notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  summary: jsonb("summary").$type<Record<string, unknown>>(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});
