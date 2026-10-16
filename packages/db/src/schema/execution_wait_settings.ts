import { sql } from "drizzle-orm";
import { boolean, check, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/** Fork: how a company is told about tasks that wait for a device or a Claude account. */
export const executionWaitSettings = pgTable("execution_wait_settings", {
  companyId: uuid("company_id").primaryKey().references(() => companies.id, { onDelete: "cascade" }),
  /** Hours before a long device wait is reported. NULL uses the instance default; 0 never reports. */
  notifyAfterHours: integer("notify_after_hours"),
  notifyPmOnDeviceWait: boolean("notify_pm_on_device_wait").notNull().default(false),
  notifyPmOnAccountWait: boolean("notify_pm_on_account_wait").notNull().default(true),
  updatedByUserId: text("updated_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("execution_wait_settings_notify_after_hours_check", sql`${t.notifyAfterHours} is null or ${t.notifyAfterHours} between 0 and 168`),
]);
