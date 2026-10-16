import { index, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { aiAccountHosts, aiAccounts } from "./ai_account_hosts.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/**
 * Fork: the pool account a run acquired on a device. A device's running set
 * is its slots joined to runs whose status is `running`, so no release hook is
 * needed; the sweep prunes slots of terminal runs. The device cap never reads
 * `context_snapshot`, which other writers replace wholesale.
 */
export const aiAccountRunSlots = pgTable("ai_account_run_slots", {
  runId: uuid("run_id").primaryKey().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
  companyId: uuid("company_id").notNull(),
  deviceId: uuid("device_id").notNull().references(() => aiAccountHosts.id, { onDelete: "cascade" }),
  accountId: uuid("account_id").notNull().references(() => aiAccounts.id, { onDelete: "cascade" }),
  acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("ai_account_run_slots_device_idx").on(t.deviceId),
]);
