import { z } from "zod";

/**
 * Fork: owner-issued password reset links.
 *
 * A company owner (or an instance admin) creates a one-time link for a member
 * and hands it over like an invite. Whoever opens it sets a new password, so a
 * link is only issued when the creator owns every company the member is an
 * active member of. Using the link signs the member out everywhere.
 */

/** A link stays usable for 24 hours, once. A newer link revokes older ones. */
export const PASSWORD_RESET_LINK_TTL_MS = 24 * 60 * 60 * 1000;

/** Better Auth's default bounds for email/password accounts. */
export const PASSWORD_RESET_MIN_LENGTH = 8;
export const PASSWORD_RESET_MAX_LENGTH = 128;

export const completePasswordResetSchema = z.object({
  password: z.string().min(PASSWORD_RESET_MIN_LENGTH).max(PASSWORD_RESET_MAX_LENGTH),
});

export type CompletePasswordReset = z.infer<typeof completePasswordResetSchema>;

/** Whether the current board user may create a reset link for one member. */
export interface PasswordResetMemberAccess {
  canCreate: boolean;
  reason: string | null;
}

/** `GET /companies/:companyId/password-reset-access` */
export interface PasswordResetAccessResponse {
  /** False when the viewer is neither an owner of this company nor an instance admin. */
  actorCanCreate: boolean;
  /** Keyed by company membership id. */
  members: Record<string, PasswordResetMemberAccess>;
}

/** `POST /companies/:companyId/members/:memberId/password-reset-links` */
export interface PasswordResetLinkCreated {
  id: string;
  userId: string;
  userEmail: string;
  userName: string | null;
  resetPath: string;
  resetUrl: string;
  expiresAt: string;
  /** Open links for the same user that this one replaced. */
  revokedPreviousCount: number;
}

/** `GET /password-reset/:token` — what the link's holder sees before choosing a password. */
export interface PasswordResetLinkSummary {
  userEmail: string;
  userName: string | null;
  companyName: string | null;
  createdByUserName: string | null;
  expiresAt: string;
}

/** `POST /password-reset/:token` */
export interface PasswordResetCompleted {
  userEmail: string;
  revokedSessionCount: number;
}
