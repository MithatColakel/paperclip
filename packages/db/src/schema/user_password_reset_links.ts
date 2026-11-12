import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { authUsers } from "./auth.js";

/**
 * Fork: one-time password reset links that a company owner (or an instance
 * admin) creates for a member and hands over like an invite link.
 *
 * The password belongs to the user, not to the company, so a link is only
 * issued when the creator owns every company the user is an active member of.
 * `company_id` is the company the link was created from; its activity log
 * carries the link's creation and use. Only the SHA-256 of the token is
 * stored; the raw token is returned once, on creation.
 */
export const userPasswordResetLinks = pgTable(
  "user_password_reset_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenHashUniqueIdx: uniqueIndex("user_password_reset_links_token_hash_unique_idx").on(table.tokenHash),
    userOpenIdx: index("user_password_reset_links_user_open_idx").on(
      table.userId,
      table.usedAt,
      table.revokedAt,
    ),
    companyIdx: index("user_password_reset_links_company_idx").on(table.companyId, table.createdAt),
  }),
);
