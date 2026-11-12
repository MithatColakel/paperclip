/**
 * Fork: owner-issued password reset links, end to end against the real Better
 * Auth mount, the real Drizzle schema and a migrated Postgres.
 *
 * The rule under test: the password belongs to the user, so a company owner
 * may only issue (and the link only works) while the owner owns every company
 * the user is an active member of. Instance admins may reset anyone but
 * themselves. A link works once, for 24 hours, and signs the user out.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  authSessions,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  userPasswordResetLinks,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createBetterAuthHandler, createBetterAuthInstance } from "../auth/better-auth.js";
import type { Config } from "../config.js";
import { errorHandler } from "../middleware/index.js";
import { passwordResetLinkRoutes } from "../routes/password-reset-links.js";
import { createInviteRateLimiter } from "../services/invite-rate-limit.js";
import { PASSWORD_RESET_REASONS, passwordResetLinkService } from "../services/password-reset-links.js";

const ORIGIN = "http://127.0.0.1:41998";
const OLD_PASSWORD = "old-password-1234";
const NEW_PASSWORD = "brand-new-password-5678";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function testConfig(): Config {
  return {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    authBaseUrlMode: "explicit",
    authPublicBaseUrl: ORIGIN,
    authDisableSignUp: false,
    allowedHostnames: ["127.0.0.1"],
    port: 41998,
  } as unknown as Config;
}

type Actor = Record<string, unknown>;

describeEmbeddedPostgres("owner-issued password reset links", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let app!: express.Express;
  const actors = new Map<string, Actor>();
  const originalEnv = {
    secret: process.env.BETTER_AUTH_SECRET,
    rateLimit: process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED,
  };

  let companyA = "";
  let companyB = "";
  const users = { owner: "", member: "", multi: "", ownerB: "", admin: "", coOwner: "" };
  const memberIds = { member: "", multi: "", owner: "", coOwner: "", admin: "" };

  async function signUp(email: string) {
    const res = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ email, password: OLD_PASSWORD, name: email.split("@")[0] });
    expect(res.status).toBe(200);
    return res.body.user.id as string;
  }

  async function signIn(email: string, password: string) {
    return request(app).post("/api/auth/sign-in/email").set("origin", ORIGIN).send({ email, password });
  }

  async function addMember(companyId: string, userId: string, role: string) {
    const [row] = await db
      .insert(companyMemberships)
      .values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: role })
      .returning();
    return row!.id;
  }

  function boardActor(userId: string, isInstanceAdmin = false): Actor {
    return {
      type: "board",
      source: "session",
      userId,
      companyIds: [companyA, companyB],
      isInstanceAdmin,
    };
  }

  function as(name: string) {
    return { "x-test-actor": name };
  }

  async function createLink(actor: string, memberId: string, companyId = companyA) {
    return request(app)
      .post(`/api/companies/${companyId}/members/${memberId}/password-reset-links`)
      .set(as(actor))
      .send({});
  }

  function tokenOf(resetPath: string) {
    return decodeURIComponent(resetPath.replace("/reset-password/", ""));
  }

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = "better-auth-secret-for-password-reset-tests";
    process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = "false";
    database = await startEmbeddedPostgresTestDatabase("paperclip-password-reset-");
    db = createDb(database.connectionString);

    const auth = createBetterAuthInstance(db, testConfig(), [ORIGIN]);
    app = express();
    app.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));
    app.use(express.json());
    app.use((req, _res, next) => {
      const name = req.header("x-test-actor");
      (req as any).actor = (name && actors.get(name)) ?? { type: "none", source: "none" };
      next();
    });
    app.use(
      "/api",
      passwordResetLinkRoutes(db, {
        authPublicBaseUrl: ORIGIN,
        rateLimiter: createInviteRateLimiter({ maxRequests: 10_000 }),
      }),
    );
    app.use(errorHandler);

    const [a, b] = await db
      .insert(companies)
      .values([
        { name: "Alpha", issuePrefix: `A${randomUUID().slice(0, 5).toUpperCase()}` },
        { name: "Beta", issuePrefix: `B${randomUUID().slice(0, 5).toUpperCase()}` },
      ])
      .returning();
    companyA = a!.id;
    companyB = b!.id;

    users.owner = await signUp("owner@example.com");
    users.member = await signUp("member@example.com");
    users.multi = await signUp("multi@example.com");
    users.ownerB = await signUp("owner-b@example.com");
    users.admin = await signUp("admin@example.com");
    users.coOwner = await signUp("co-owner@example.com");

    memberIds.owner = await addMember(companyA, users.owner, "owner");
    memberIds.member = await addMember(companyA, users.member, "operator");
    memberIds.multi = await addMember(companyA, users.multi, "operator");
    await addMember(companyB, users.multi, "viewer");
    await addMember(companyB, users.ownerB, "owner");
    memberIds.coOwner = await addMember(companyA, users.coOwner, "owner");
    memberIds.admin = await addMember(companyA, users.admin, "admin");
    await db.insert(instanceUserRoles).values({ userId: users.admin, role: "instance_admin" });

    actors.set("owner", boardActor(users.owner));
    actors.set("member", boardActor(users.member));
    actors.set("admin", boardActor(users.admin, true));
    actors.set("agent", { type: "agent", source: "agent_key", agentId: randomUUID(), companyId: companyA });
  }, 60_000);

  afterAll(async () => {
    await database?.cleanup();
    if (originalEnv.secret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalEnv.secret;
    if (originalEnv.rateLimit === undefined) delete process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED;
    else process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = originalEnv.rateLimit;
  });

  it("tells an owner which members they may reset, and why not", async () => {
    const res = await request(app).get(`/api/companies/${companyA}/password-reset-access`).set(as("owner"));
    expect(res.status).toBe(200);
    expect(res.body.actorCanCreate).toBe(true);
    expect(res.body.members[memberIds.member]).toEqual({ canCreate: true, reason: null });
    expect(res.body.members[memberIds.multi].reason).toBe(PASSWORD_RESET_REASONS.otherCompany);
    expect(res.body.members[memberIds.owner].reason).toBe(PASSWORD_RESET_REASONS.self);
    expect(res.body.members[memberIds.coOwner].reason).toBe(PASSWORD_RESET_REASONS.owner);
    expect(res.body.members[memberIds.admin].reason).toBe(PASSWORD_RESET_REASONS.instanceAdmin);
  });

  it("offers nothing to a member who is not an owner, and refuses agents", async () => {
    const res = await request(app).get(`/api/companies/${companyA}/password-reset-access`).set(as("member"));
    expect(res.status).toBe(200);
    expect(res.body.actorCanCreate).toBe(false);
    expect((await createLink("member", memberIds.multi)).status).toBe(403);
    expect((await createLink("agent", memberIds.member)).status).toBe(403);
    expect((await createLink("anonymous", memberIds.member)).status).toBe(401);
  });

  it("refuses a member who also belongs to a company the owner does not own", async () => {
    const res = await createLink("owner", memberIds.multi);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(PASSWORD_RESET_REASONS.otherCompany);
  });

  it("lets the member set a new password once, and signs them out everywhere", async () => {
    const session = await signIn("member@example.com", OLD_PASSWORD);
    expect(session.status).toBe(200);
    const sessionsBefore = await db.select().from(authSessions).where(eq(authSessions.userId, users.member));
    expect(sessionsBefore.length).toBeGreaterThan(0);

    const created = await createLink("owner", memberIds.member);
    expect(created.status).toBe(201);
    expect(created.body.userEmail).toBe("member@example.com");
    expect(created.body.resetUrl).toBe(`${ORIGIN}${created.body.resetPath}`);
    const token = tokenOf(created.body.resetPath);
    expect(token.startsWith("pcp_pwreset_")).toBe(true);

    // Only the hash is stored.
    const [stored] = await db.select().from(userPasswordResetLinks).where(eq(userPasswordResetLinks.id, created.body.id));
    expect(stored!.tokenHash).not.toContain(token);
    expect(stored!.createdByUserId).toBe(users.owner);

    const summary = await request(app).get(`/api/password-reset/${encodeURIComponent(token)}`);
    expect(summary.status).toBe(200);
    expect(summary.headers["cache-control"]).toBe("no-store");
    expect(summary.body).toMatchObject({
      userEmail: "member@example.com",
      companyName: "Alpha",
      createdByUserName: "owner",
    });

    const tooShort = await request(app).post(`/api/password-reset/${encodeURIComponent(token)}`).send({ password: "short" });
    expect(tooShort.status).toBe(400);

    const done = await request(app)
      .post(`/api/password-reset/${encodeURIComponent(token)}`)
      .send({ password: NEW_PASSWORD });
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ userEmail: "member@example.com", revokedSessionCount: sessionsBefore.length });

    expect(await db.select().from(authSessions).where(eq(authSessions.userId, users.member))).toHaveLength(0);
    expect((await signIn("member@example.com", OLD_PASSWORD)).status).not.toBe(200);
    expect((await signIn("member@example.com", NEW_PASSWORD)).status).toBe(200);

    const again = await request(app)
      .post(`/api/password-reset/${encodeURIComponent(token)}`)
      .send({ password: "yet-another-password" });
    expect(again.status).toBe(404);
    expect((await request(app).get(`/api/password-reset/${encodeURIComponent(token)}`)).status).toBe(404);

    const activity = await db
      .select({ action: activityLog.action, actorId: activityLog.actorId, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyA), eq(activityLog.entityId, users.member)));
    expect(activity.map((row) => row.action).sort()).toEqual([
      "user.password_reset_completed",
      "user.password_reset_link_created",
    ]);
    expect(JSON.stringify(activity)).not.toContain(token);
  });

  it("revokes the older link when a new one is created", async () => {
    const first = await createLink("owner", memberIds.member);
    const second = await createLink("owner", memberIds.member);
    expect(second.status).toBe(201);
    expect(second.body.revokedPreviousCount).toBe(1);
    expect((await request(app).get(`/api/password-reset/${encodeURIComponent(tokenOf(first.body.resetPath))}`)).status).toBe(404);
    expect((await request(app).get(`/api/password-reset/${encodeURIComponent(tokenOf(second.body.resetPath))}`)).status).toBe(200);
  });

  it("lets an instance admin reset a member of several companies", async () => {
    const created = await createLink("admin", memberIds.multi);
    expect(created.status).toBe(201);
    const done = await request(app)
      .post(`/api/password-reset/${encodeURIComponent(tokenOf(created.body.resetPath))}`)
      .send({ password: NEW_PASSWORD });
    expect(done.status).toBe(200);
    expect((await signIn("multi@example.com", NEW_PASSWORD)).status).toBe(200);
  });

  it("stops working when the member joins a company the creator does not own", async () => {
    const created = await createLink("owner", memberIds.member);
    expect(created.status).toBe(201);
    const extra = await addMember(companyB, users.member, "viewer");
    try {
      const res = await request(app)
        .post(`/api/password-reset/${encodeURIComponent(tokenOf(created.body.resetPath))}`)
        .send({ password: "password-after-joining-b" });
      expect(res.status).toBe(403);
      expect((await signIn("member@example.com", "password-after-joining-b")).status).not.toBe(200);
    } finally {
      await db.delete(companyMemberships).where(eq(companyMemberships.id, extra));
    }
  });

  it("does not accept an expired link", async () => {
    const service = passwordResetLinkService(db);
    const { token } = await service.create({
      companyId: companyA,
      userId: users.member,
      actor: { userId: users.owner, isInstanceAdmin: false },
      now: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    expect((await request(app).get(`/api/password-reset/${encodeURIComponent(token)}`)).status).toBe(404);
    const res = await request(app)
      .post(`/api/password-reset/${encodeURIComponent(token)}`)
      .send({ password: "password-from-expired-link" });
    expect(res.status).toBe(404);
  });
});
