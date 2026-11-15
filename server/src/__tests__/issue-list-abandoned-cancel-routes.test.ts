import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companyMemberships, createDb, issues, principalPermissionGrants } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { __clearIssueListResponseCacheForTests, issueRoutes } from "../routes/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres abandoned issue list tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type BlockedStatement = { application_name: string };

// Fork: an issue list whose every client disconnected stops its database work.
// An exclusive lock on `issues` holds the list's main statement in Postgres, so
// each test can see whether the statement is still waiting after a disconnect.
describeEmbeddedPostgres("issue list routes cancel the work of disconnected clients", () => {
  let db!: ReturnType<typeof createDb>;
  // A separate client, so the lock and the probes never share the app's pools.
  let observer!: ReturnType<typeof createDb>["$client"];
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const servers: Server[] = [];
  const savedSetting = process.env.PAPERCLIP_CANCEL_ABANDONED_ISSUE_LISTS;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-list-abandoned-");
    db = createDb(tempDb.connectionString);
    observer = createDb(tempDb.connectionString, { maxConnections: 2 }).$client;
  }, 20_000);

  afterEach(async () => {
    if (savedSetting === undefined) delete process.env.PAPERCLIP_CANCEL_ABANDONED_ISSUE_LISTS;
    else process.env.PAPERCLIP_CANCEL_ABANDONED_ISSUE_LISTS = savedSetting;
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
    __clearIssueListResponseCacheForTests();
    await db.delete(issues);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await observer?.end();
    await tempDb?.cleanup();
  });

  async function seedCompanyWithIssue() {
    const companyId = randomUUID();
    const userId = "cloud-user-1";
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `P${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: userId,
      membershipRole: "owner",
      grantedByUserId: null,
    });
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Listed issue", status: "todo", priority: "medium" });
    return { companyId, issueId, userId };
  }

  async function startServer(companyId: string, userId: string): Promise<string> {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active", principalId: userId }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, {}));
    app.use(errorHandler);
    const server = await new Promise<Server>((resolve) => {
      const started = app.listen(0, "127.0.0.1", () => resolve(started));
    });
    servers.push(server);
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function lockIssuesTable() {
    const locker = await observer.reserve();
    await locker`begin`;
    await locker`lock table issues in access exclusive mode`;
    return async () => {
      await locker`rollback`;
      locker.release();
    };
  }

  async function blockedStatements(): Promise<BlockedStatement[]> {
    return observer<BlockedStatement[]>`
      select application_name from pg_stat_activity
       where state = 'active' and wait_event_type = 'Lock' and pid <> pg_backend_pid()
    `;
  }

  async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error("condition not reached in time");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  function listRequest(baseUrl: string, companyId: string) {
    const controller = new AbortController();
    const response = fetch(`${baseUrl}/api/companies/${companyId}/issues?limit=20`, {
      signal: controller.signal,
    }).then(
      async (res) => ({ status: res.status, body: (await res.json()) as Array<{ id: string }> }),
      (error: unknown) => ({ error }),
    );
    return { abort: () => controller.abort(), response };
  }

  it("cancels the list statement when its only client disconnects, and serves the next request", async () => {
    const { companyId, issueId, userId } = await seedCompanyWithIssue();
    const baseUrl = await startServer(companyId, userId);
    const unlock = await lockIssuesTable();
    try {
      const first = listRequest(baseUrl, companyId);
      await waitFor(async () =>
        (await blockedStatements()).some((row) => row.application_name === "paperclip-abandonable-read"));

      first.abort();
      // The lock is still held, so only a cancel can end the waiting statement.
      await waitFor(async () => (await blockedStatements()).length === 0);
      expect(await first.response).toHaveProperty("error");
    } finally {
      await unlock();
    }

    const next = await listRequest(baseUrl, companyId).response;
    expect(next).toMatchObject({ status: 200 });
    expect((next as { body: Array<{ id: string }> }).body.map((issue) => issue.id)).toEqual([issueId]);
  }, 30_000);

  it("keeps a coalesced computation running while another client still waits for it", async () => {
    const { companyId, issueId, userId } = await seedCompanyWithIssue();
    const baseUrl = await startServer(companyId, userId);
    const unlock = await lockIssuesTable();
    let second: ReturnType<typeof listRequest>;
    try {
      const first = listRequest(baseUrl, companyId);
      await waitFor(async () => (await blockedStatements()).length === 1);
      second = listRequest(baseUrl, companyId);
      // Give the second request time to join the in-flight computation.
      await new Promise((resolve) => setTimeout(resolve, 200));

      first.abort();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await blockedStatements()).toHaveLength(1);
    } finally {
      await unlock();
    }

    const answer = await second!.response;
    expect(answer).toMatchObject({ status: 200 });
    expect((answer as { body: Array<{ id: string }> }).body.map((issue) => issue.id)).toEqual([issueId]);
  }, 30_000);

  it("lets the statement run on when PAPERCLIP_CANCEL_ABANDONED_ISSUE_LISTS=false", async () => {
    process.env.PAPERCLIP_CANCEL_ABANDONED_ISSUE_LISTS = "false";
    const { companyId, userId } = await seedCompanyWithIssue();
    const baseUrl = await startServer(companyId, userId);
    const unlock = await lockIssuesTable();
    try {
      const first = listRequest(baseUrl, companyId);
      await waitFor(async () => (await blockedStatements()).length === 1);
      expect((await blockedStatements())[0]?.application_name).toBe("paperclip");

      first.abort();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await blockedStatements()).toHaveLength(1);
    } finally {
      await unlock();
    }
    await waitFor(async () => (await blockedStatements()).length === 0);
  }, 30_000);
});
