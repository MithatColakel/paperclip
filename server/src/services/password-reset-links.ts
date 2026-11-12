/**
 * Fork: owner-issued, one-time password reset links.
 *
 * Paperclip runs Better Auth without a reset e-mail or an admin plugin, so a
 * member who forgets their password had no way back in. A company owner (or an
 * instance admin) now creates a link for the member and hands it over like an
 * invite; the member opens it and picks a new password.
 *
 * The password belongs to the user, not to the company: whoever opens the link
 * can sign in to every company the user belongs to. So a link is only issued —
 * and only accepted — while its creator owns every company the user is an
 * active member of, or is an instance admin. Owners and instance admins can
 * only be reset by an instance admin, and nobody resets their own password
 * this way.
 *
 * A link is usable once, for 24 hours. Creating a link revokes the user's
 * older open links. Using it replaces the credential hash and deletes every
 * session of the user. Only the SHA-256 of the token is stored.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import type { Db } from "@paperclipai/db";
import {
  authAccounts,
  authSessions,
  authUsers,
  companies,
  companyMemberships,
  instanceUserRoles,
  userPasswordResetLinks,
} from "@paperclipai/db";
import { PASSWORD_RESET_LINK_TTL_MS } from "@paperclipai/shared";
import { normalizeHumanRole } from "./company-member-roles.js";

const TOKEN_PREFIX = "pcp_pwreset_";
// 32 random bytes = 256 bits, the same strength as invite tokens.
const TOKEN_ENTROPY_BYTES = 32;
const CREDENTIAL_PROVIDER_ID = "credential";
/** The `userId` the local-trusted board acts as; it is an implicit instance admin. */
const LOCAL_BOARD_USER_ID = "local-board";

export const PASSWORD_RESET_REASONS = {
  notOwner: "Only an owner of this organization can create password reset links.",
  self: "You cannot create a password reset link for yourself.",
  notActiveMember: "Only active members can get a password reset link.",
  instanceAdmin: "Only an instance admin can reset an instance admin's password.",
  owner: "Only an instance admin can reset an owner's password.",
  otherCompany:
    "This user is also a member of an organization you do not own. Ask an instance admin to reset the password.",
  noPassword: "This user does not sign in with a password.",
} as const;

export interface PasswordResetActor {
  userId: string;
  isInstanceAdmin: boolean;
}

export function createPasswordResetToken() {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_ENTROPY_BYTES).toString("base64url")}`;
}

export function hashPasswordResetToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function passwordResetPath(token: string) {
  return `/reset-password/${encodeURIComponent(token)}`;
}

function isOwnerRole(role: string | null) {
  return role !== null && normalizeHumanRole(role, "operator") === "owner";
}

export function passwordResetLinkService(db: Db) {
  async function isInstanceAdmin(userId: string) {
    if (userId === LOCAL_BOARD_USER_ID) return true;
    const row = await db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows[0] ?? null);
    return Boolean(row);
  }

  /**
   * Decide, for each target user, whether `actor` may reset their password
   * from `companyId`. Returns `null` for an allowed target and the reason
   * otherwise. Batched so the members page costs a fixed number of queries.
   */
  async function evaluate(input: {
    companyId: string;
    actor: PasswordResetActor;
    targetUserIds: string[];
  }): Promise<{ actorCanCreate: boolean; reasons: Map<string, string | null> }> {
    const { companyId, actor } = input;
    const targetUserIds = [...new Set(input.targetUserIds)];
    const reasons = new Map<string, string | null>();

    const ownedCompanyIds = new Set<string>();
    if (!actor.isInstanceAdmin) {
      const actorMemberships = await db
        .select({ companyId: companyMemberships.companyId, role: companyMemberships.membershipRole })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, actor.userId),
            eq(companyMemberships.status, "active"),
          ),
        );
      for (const membership of actorMemberships) {
        if (isOwnerRole(membership.role)) ownedCompanyIds.add(membership.companyId);
      }
    }
    const actorCanCreate = actor.isInstanceAdmin || ownedCompanyIds.has(companyId);
    if (!actorCanCreate) {
      for (const userId of targetUserIds) reasons.set(userId, PASSWORD_RESET_REASONS.notOwner);
      return { actorCanCreate, reasons };
    }
    if (targetUserIds.length === 0) return { actorCanCreate, reasons };

    const [targetMemberships, adminRows, credentialRows] = await Promise.all([
      db
        .select({
          userId: companyMemberships.principalId,
          companyId: companyMemberships.companyId,
          role: companyMemberships.membershipRole,
        })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.status, "active"),
            inArray(companyMemberships.principalId, targetUserIds),
          ),
        ),
      db
        .select({ userId: instanceUserRoles.userId })
        .from(instanceUserRoles)
        .where(
          and(
            eq(instanceUserRoles.role, "instance_admin"),
            inArray(instanceUserRoles.userId, targetUserIds),
          ),
        ),
      db
        .select({ userId: authAccounts.userId })
        .from(authAccounts)
        .where(
          and(
            eq(authAccounts.providerId, CREDENTIAL_PROVIDER_ID),
            inArray(authAccounts.userId, targetUserIds),
          ),
        ),
    ]);

    const membershipsByUser = new Map<string, Array<{ companyId: string; role: string | null }>>();
    for (const row of targetMemberships) {
      const list = membershipsByUser.get(row.userId) ?? [];
      list.push({ companyId: row.companyId, role: row.role });
      membershipsByUser.set(row.userId, list);
    }
    const instanceAdmins = new Set(adminRows.map((row) => row.userId));
    const withPassword = new Set(credentialRows.map((row) => row.userId));

    for (const userId of targetUserIds) {
      const memberships = membershipsByUser.get(userId) ?? [];
      let reason: string | null = null;
      if (userId === actor.userId) {
        reason = PASSWORD_RESET_REASONS.self;
      } else if (!memberships.some((membership) => membership.companyId === companyId)) {
        reason = PASSWORD_RESET_REASONS.notActiveMember;
      } else if (instanceAdmins.has(userId) && !actor.isInstanceAdmin) {
        reason = PASSWORD_RESET_REASONS.instanceAdmin;
      } else if (!actor.isInstanceAdmin && memberships.some((membership) => isOwnerRole(membership.role))) {
        reason = PASSWORD_RESET_REASONS.owner;
      } else if (
        !actor.isInstanceAdmin &&
        memberships.some((membership) => !ownedCompanyIds.has(membership.companyId))
      ) {
        reason = PASSWORD_RESET_REASONS.otherCompany;
      } else if (!withPassword.has(userId)) {
        reason = PASSWORD_RESET_REASONS.noPassword;
      }
      reasons.set(userId, reason);
    }
    return { actorCanCreate, reasons };
  }

  async function create(input: {
    companyId: string;
    userId: string;
    actor: PasswordResetActor;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const token = createPasswordResetToken();
    const expiresAt = new Date(now.getTime() + PASSWORD_RESET_LINK_TTL_MS);
    return db.transaction(async (tx) => {
      const revoked = await tx
        .update(userPasswordResetLinks)
        .set({ revokedAt: now, updatedAt: now })
        .where(
          and(
            eq(userPasswordResetLinks.userId, input.userId),
            isNull(userPasswordResetLinks.usedAt),
            isNull(userPasswordResetLinks.revokedAt),
            gt(userPasswordResetLinks.expiresAt, now),
          ),
        )
        .returning({ id: userPasswordResetLinks.id });
      const [link] = await tx
        .insert(userPasswordResetLinks)
        .values({
          companyId: input.companyId,
          userId: input.userId,
          tokenHash: hashPasswordResetToken(token),
          createdByUserId: input.actor.userId,
          expiresAt,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return { link: link!, token, revokedPreviousCount: revoked.length };
    });
  }

  /** The open link for `token`, with what its holder is shown; `null` when unusable. */
  async function findUsable(token: string, now: Date = new Date()) {
    const trimmed = token.trim();
    if (!trimmed) return null;
    const row = await db
      .select({
        link: userPasswordResetLinks,
        userEmail: authUsers.email,
        userName: authUsers.name,
        companyName: companies.name,
      })
      .from(userPasswordResetLinks)
      .innerJoin(authUsers, eq(authUsers.id, userPasswordResetLinks.userId))
      .innerJoin(companies, eq(companies.id, userPasswordResetLinks.companyId))
      .where(eq(userPasswordResetLinks.tokenHash, hashPasswordResetToken(trimmed)))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const { link } = row;
    if (link.usedAt || link.revokedAt || link.expiresAt.getTime() <= now.getTime()) return null;
    const creator = await db
      .select({ name: authUsers.name })
      .from(authUsers)
      .where(eq(authUsers.id, link.createdByUserId))
      .then((rows) => rows[0] ?? null);
    return {
      link,
      userEmail: row.userEmail,
      userName: row.userName,
      companyName: row.companyName,
      createdByUserName: creator?.name ?? null,
    };
  }

  /**
   * Re-check the creator's right at use time: the user may have joined a
   * company the creator does not own, or the creator may have lost ownership,
   * since the link was made.
   */
  async function creatorStillAllowed(link: typeof userPasswordResetLinks.$inferSelect) {
    const actor: PasswordResetActor = {
      userId: link.createdByUserId,
      isInstanceAdmin: await isInstanceAdmin(link.createdByUserId),
    };
    const { reasons } = await evaluate({
      companyId: link.companyId,
      actor,
      targetUserIds: [link.userId],
    });
    return reasons.get(link.userId) ?? null;
  }

  type CompleteResult =
    | { status: "not_found" }
    | { status: "creator_not_allowed"; reason: string }
    | {
        status: "completed";
        link: typeof userPasswordResetLinks.$inferSelect;
        userEmail: string;
        revokedSessionCount: number;
      };

  async function complete(input: { token: string; password: string; now?: Date }): Promise<CompleteResult> {
    const now = input.now ?? new Date();
    const usable = await findUsable(input.token, now);
    if (!usable) return { status: "not_found" };
    const reason = await creatorStillAllowed(usable.link);
    if (reason) return { status: "creator_not_allowed", reason };

    // scrypt is slow on purpose; hash before taking the row lock.
    const hash = await hashPassword(input.password);
    return db.transaction(async (tx): Promise<CompleteResult> => {
      const locked = await tx
        .select()
        .from(userPasswordResetLinks)
        .where(eq(userPasswordResetLinks.id, usable.link.id))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!locked || locked.usedAt || locked.revokedAt || locked.expiresAt.getTime() <= now.getTime()) {
        return { status: "not_found" };
      }
      const updatedAccounts = await tx
        .update(authAccounts)
        .set({ password: hash, updatedAt: now })
        .where(and(eq(authAccounts.userId, locked.userId), eq(authAccounts.providerId, CREDENTIAL_PROVIDER_ID)))
        .returning({ id: authAccounts.id });
      if (updatedAccounts.length === 0) {
        return { status: "creator_not_allowed", reason: PASSWORD_RESET_REASONS.noPassword };
      }
      const deletedSessions = await tx
        .delete(authSessions)
        .where(eq(authSessions.userId, locked.userId))
        .returning({ id: authSessions.id });
      await tx
        .update(userPasswordResetLinks)
        .set({ usedAt: now, updatedAt: now })
        .where(eq(userPasswordResetLinks.id, locked.id));
      return {
        status: "completed",
        link: { ...locked, usedAt: now, updatedAt: now },
        userEmail: usable.userEmail,
        revokedSessionCount: deletedSessions.length,
      };
    });
  }

  return { isInstanceAdmin, evaluate, create, findUsable, complete };
}
