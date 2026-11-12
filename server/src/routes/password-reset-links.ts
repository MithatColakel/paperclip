/**
 * Fork: routes for owner-issued password reset links. The rules live in
 * `services/password-reset-links.ts`.
 *
 *   GET  /companies/:companyId/password-reset-access                  board: who the viewer may reset
 *   POST /companies/:companyId/members/:memberId/password-reset-links board: create a link
 *   GET  /password-reset/:token                                       public: what the link resets
 *   POST /password-reset/:token                                       public: set the new password
 */
import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyMemberships } from "@paperclipai/db";
import {
  completePasswordResetSchema,
  type PasswordResetAccessResponse,
  type PasswordResetCompleted,
  type PasswordResetLinkCreated,
  type PasswordResetLinkSummary,
} from "@paperclipai/shared";
import { forbidden, notFound, tooManyRequests } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import { createInviteRateLimiter, type InviteRateLimiter } from "../services/invite-rate-limit.js";
import {
  passwordResetLinkService,
  passwordResetPath,
  type PasswordResetActor,
} from "../services/password-reset-links.js";
import { assertCompanyAccess } from "./authz.js";
import { resolveBaseUrl } from "./access.js";

const LINK_NOT_FOUND = "This password reset link is invalid, expired or already used.";

export function passwordResetLinkRoutes(
  db: Db,
  opts: { authPublicBaseUrl?: string; rateLimiter?: InviteRateLimiter } = {},
) {
  const router = Router();
  const links = passwordResetLinkService(db);

  // The token sits in the URL and is looked up by hash: keep it out of caches
  // and referrers, and rate-limit lookups per IP like invite tokens.
  const rateLimiter = opts.rateLimiter ?? createInviteRateLimiter();
  router.use("/password-reset/:token", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    const result = rateLimiter.consume(req.ip || req.socket?.remoteAddress || "unknown");
    res.setHeader("X-RateLimit-Limit", String(result.limit));
    res.setHeader("X-RateLimit-Remaining", String(result.remaining));
    if (!result.allowed) {
      res.setHeader("Retry-After", String(result.retryAfterSeconds));
      next(tooManyRequests("Too many password reset requests", { retryAfterSeconds: result.retryAfterSeconds }));
      return;
    }
    next();
  });

  async function resolveActor(req: Request): Promise<PasswordResetActor> {
    if (req.actor.type !== "board") throw forbidden("Board access required");
    if (req.actor.source === "local_implicit") {
      return { userId: req.actor.userId ?? "local-board", isInstanceAdmin: true };
    }
    const userId = req.actor.userId;
    if (!userId) throw forbidden("Board access required");
    return { userId, isInstanceAdmin: await links.isInstanceAdmin(userId) };
  }

  router.get("/companies/:companyId/password-reset-access", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = await resolveActor(req);
    const members = await db
      .select({ id: companyMemberships.id, userId: companyMemberships.principalId })
      .from(companyMemberships)
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user")));
    const { actorCanCreate, reasons } = await links.evaluate({
      companyId,
      actor,
      targetUserIds: members.map((member) => member.userId),
    });
    const body: PasswordResetAccessResponse = { actorCanCreate, members: {} };
    for (const member of members) {
      const reason = reasons.get(member.userId) ?? null;
      body.members[member.id] = { canCreate: reason === null, reason };
    }
    res.json(body);
  });

  router.post("/companies/:companyId/members/:memberId/password-reset-links", async (req, res) => {
    const companyId = req.params.companyId as string;
    const memberId = req.params.memberId as string;
    assertCompanyAccess(req, companyId);
    const actor = await resolveActor(req);
    const member = await db
      .select({ userId: companyMemberships.principalId })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.id, memberId),
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!member) throw notFound("Member not found");

    const { reasons } = await links.evaluate({ companyId, actor, targetUserIds: [member.userId] });
    const reason = reasons.get(member.userId) ?? null;
    if (reason) throw forbidden(reason);

    const { link, token, revokedPreviousCount } = await links.create({
      companyId,
      userId: member.userId,
      actor,
    });
    const summary = await links.findUsable(token);
    if (!summary) throw notFound("Member not found");

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actor.userId,
      action: "user.password_reset_link_created",
      entityType: "user",
      entityId: member.userId,
      details: {
        linkId: link.id,
        expiresAt: link.expiresAt.toISOString(),
        revokedPreviousCount,
      },
    });

    const resetPath = passwordResetPath(token);
    const body: PasswordResetLinkCreated = {
      id: link.id,
      userId: member.userId,
      userEmail: summary.userEmail,
      userName: summary.userName,
      resetPath,
      resetUrl: `${resolveBaseUrl(req, opts.authPublicBaseUrl)}${resetPath}`,
      expiresAt: link.expiresAt.toISOString(),
      revokedPreviousCount,
    };
    res.status(201).json(body);
  });

  router.get("/password-reset/:token", async (req, res) => {
    const summary = await links.findUsable(req.params.token as string);
    if (!summary) throw notFound(LINK_NOT_FOUND);
    const body: PasswordResetLinkSummary = {
      userEmail: summary.userEmail,
      userName: summary.userName,
      companyName: summary.companyName,
      createdByUserName: summary.createdByUserName,
      expiresAt: summary.link.expiresAt.toISOString(),
    };
    res.json(body);
  });

  router.post("/password-reset/:token", validate(completePasswordResetSchema), async (req, res) => {
    const result = await links.complete({
      token: req.params.token as string,
      password: req.body.password,
    });
    if (result.status === "not_found") throw notFound(LINK_NOT_FOUND);
    if (result.status === "creator_not_allowed") {
      throw forbidden(
        "This link can no longer be used: its creator can no longer reset this password. Ask for a new link.",
      );
    }

    await logActivity(db, {
      companyId: result.link.companyId,
      actorType: "user",
      actorId: result.link.userId,
      action: "user.password_reset_completed",
      entityType: "user",
      entityId: result.link.userId,
      details: {
        linkId: result.link.id,
        createdByUserId: result.link.createdByUserId,
        revokedSessionCount: result.revokedSessionCount,
      },
    });

    const body: PasswordResetCompleted = {
      userEmail: result.userEmail,
      revokedSessionCount: result.revokedSessionCount,
    };
    res.json(body);
  });

  return router;
}
