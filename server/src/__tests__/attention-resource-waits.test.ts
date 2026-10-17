import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  aiAccountAgentBindings,
  aiAccountHosts,
  aiAccounts,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  environmentAvailability,
  environments,
  executionWaitSettings,
  heartbeatRuns,
  inboxDismissals,
  issues,
  resourceWaitEpisodes,
  resourceWaitNotices,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { captureQueries, explainAnalyze, rowsExamined, scansOf } from "./helpers/query-plan.js";
import { recheckDeviceLimits } from "../services/ai-account-pool.js";
import { attentionService } from "../services/attention.js";
import type { AuthorizationActor } from "../services/authorization.js";
import { canReadDecisionSource, decisionQueueService, type DecisionMutationActor } from "../services/decision-queues.js";
import {
  deviceOverLimitNoticeKey,
  noteDeviceOverLimit,
  resourceWaitAttentionInputs,
} from "../services/attention-resource-waits.js";
import { deviceForEnvironment } from "../services/execution-devices.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres resource-wait attention tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const now = new Date("2026-10-17T12:00:00.000Z");
const minutesAgo = (n: number) => new Date(now.getTime() - n * 60_000);
const hoursAgo = (n: number) => new Date(now.getTime() - n * 3_600_000);
/** The instance default (24 h) regardless of the test host's environment. */
const env = {} as NodeJS.ProcessEnv;

/** Counts the queries a call starts on the handle: every builder entry point. */
function countingDb(db: Db) {
  const counter = { queries: 0 };
  const entryPoints = new Set(["select", "selectDistinct", "selectDistinctOn", "insert", "update", "delete", "execute", "with", "$with", "transaction"]);
  const proxy = new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (!entryPoints.has(String(property))) return value.bind(target);
      return (...args: unknown[]) => {
        counter.queries += 1;
        return (value as (...inner: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { db: proxy as Db, counter };
}

describeEmbeddedPostgres("resource-wait inbox items", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-attention-resource-waits-");
    db = createDb(database.connectionString);
  }, 120_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate table companies, ai_account_hosts, ai_accounts, environments, "user" cascade`);
  });

  const tag = () => randomUUID().slice(0, 8);

  async function company(name = `Company ${tag()}`) {
    const id = randomUUID();
    const issuePrefix = `C${id.replaceAll("-", "").slice(0, 5).toUpperCase()}`;
    await db.insert(companies).values({ id, name, issuePrefix });
    return { id, prefix: issuePrefix };
  }

  async function user(id: string, memberOf: string[] = []) {
    await db.insert(authUsers).values({ id, name: `User ${id}`, email: `${id}@example.com`, emailVerified: true, createdAt: now, updatedAt: now });
    for (const companyId of memberOf) {
      await db.insert(companyMemberships).values({ companyId, principalId: id, principalType: "user", status: "active", membershipRole: "member" });
    }
    return id;
  }

  async function agent(companyId: string, name = `Agent ${tag()}`) {
    const [row] = await db.insert(agents).values({ companyId, name, adapterType: "claude_local" }).returning();
    return row!;
  }

  let issueNumber = 0;
  async function issue(companyId: string, prefix: string, assigneeAgentId: string, status = "in_progress") {
    issueNumber += 1;
    const [row] = await db.insert(issues).values({
      companyId,
      title: `Waiting task ${issueNumber}`,
      status,
      priority: "medium",
      assigneeAgentId,
      issueNumber,
      identifier: `${prefix}-${issueNumber}`,
    }).returning();
    return row!;
  }

  async function account(ownerUserId: string | null, label: string, overrides: Partial<typeof aiAccounts.$inferInsert> = {}) {
    const [row] = await db.insert(aiAccounts).values({
      credentialType: "subscription",
      label,
      ownerUserId,
      createdByUserId: ownerUserId,
      credentialMaterial: { provider: "local_encrypted", ciphertext: tag() },
      credentialFingerprint: randomUUID(),
      ...overrides,
    }).returning();
    return row!;
  }

  async function laneRun(agentRow: { id: string; companyId: string }, issueId: string | null, lane: string, status = "scheduled_retry") {
    const [row] = await db.insert(heartbeatRuns).values({
      companyId: agentRow.companyId,
      agentId: agentRow.id,
      status,
      invocationSource: "automation",
      triggerDetail: "system",
      scheduledRetryReason: lane,
      scheduledRetryAt: new Date(now.getTime() + 3_600_000),
      contextSnapshot: issueId ? { issueId } : {},
    }).returning();
    return row!;
  }

  async function episode(input: {
    agent: { id: string; companyId: string };
    issueId: string | null;
    kind: "environment" | "ai_account" | "device_slots";
    reason: string;
    scope: "target" | "admission" | "account" | "device";
    resourceKey: string;
    since: Date;
    currentRunId: string;
    accountId?: string | null;
    deviceId?: string | null;
    environmentId?: string | null;
    resumeAt?: Date | null;
  }) {
    const [row] = await db.insert(resourceWaitEpisodes).values({
      companyId: input.agent.companyId,
      agentId: input.agent.id,
      issueId: input.issueId,
      kind: input.kind,
      reason: input.reason,
      scope: input.scope,
      resourceKey: input.resourceKey,
      since: input.since,
      currentRunId: input.currentRunId,
      accountId: input.accountId ?? null,
      deviceId: input.deviceId ?? null,
      environmentId: input.environmentId ?? null,
      resumeAt: input.resumeAt ?? null,
      resumeAtSource: input.resumeAt ? "estimated" : null,
    }).returning();
    return row!;
  }

  /** A task of `agentRow` waiting for a usage limit of `accountId` to reset. */
  async function limitWait(agentRow: { id: string; companyId: string }, prefix: string, accountId: string, since: Date) {
    const task = await issue(agentRow.companyId, prefix, agentRow.id);
    const run = await laneRun(agentRow, task.id, "ai_account_wait");
    const row = await episode({
      agent: agentRow,
      issueId: task.id,
      kind: "ai_account",
      reason: "usage_limit",
      scope: "account",
      resourceKey: `account:${accountId}`,
      accountId,
      since,
      currentRunId: run.id,
      resumeAt: new Date(now.getTime() + 2 * 3_600_000),
    });
    return { task, run, episode: row };
  }

  const collect = (companyId: string, prefix: string, extra: { deploymentMode?: "local_trusted" | "authenticated"; database?: Db } = {}) =>
    resourceWaitAttentionInputs(extra.database ?? db, companyId, { prefix, now, env, deploymentMode: extra.deploymentMode ?? "authenticated" });

  it("shows exactly one item per account limit episode, however many tasks wait or probes fail", async () => {
    const acme = await company("Acme");
    await user("owner", [acme.id]);
    const limitStart = minutesAgo(30);
    const max = await account("owner", "Max-2", { limitEpisodeStartedAt: limitStart, exhaustedUntil: new Date(now.getTime() + 3_600_000), limitStrikes: 1, limitSource: "estimated" });
    const worker = await agent(acme.id, "Worker");
    const first = await limitWait(worker, acme.prefix, max.id, minutesAgo(29));
    const second = await limitWait(worker, acme.prefix, max.id, minutesAgo(10));

    const items = await collect(acme.id, acme.prefix);
    expect(items).toHaveLength(1);
    const [item] = items;
    const dedupKey = `resource_wait:ai_account:account:${max.id}:${limitStart.toISOString()}`;
    expect(item).toMatchObject({
      sourceKind: "resource_wait_alert",
      dedupKey,
      severity: "medium",
      activityAt: limitStart.toISOString(),
      relatedIssue: { kind: "issue", id: first.task.id, identifier: first.task.identifier },
      subject: { kind: "resource_wait", id: dedupKey, title: "Claude account Max-2 reached its usage limit", status: "usage_limit" },
    });
    expect(item!.whyNow).toContain("2 tasks wait for the limit to reset");
    expect(item!.whyNow).toContain("never moves a task to another account");
    expect(item!.subject.metadata).toMatchObject({ waitingCount: 2, issueIds: [first.task.id, second.task.id], accountId: max.id });

    // A failed probe re-arms the same limit episode: a new run, more strikes, a later reset.
    const replacement = await laneRun(worker, first.task.id, "ai_account_wait");
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, first.run.id));
    await db.update(resourceWaitEpisodes).set({ currentRunId: replacement.id }).where(eq(resourceWaitEpisodes.id, first.episode.id));
    await db.update(aiAccounts).set({ limitStrikes: 2, exhaustedUntil: new Date(now.getTime() + 4 * 3_600_000) }).where(eq(aiAccounts.id, max.id));
    const afterProbe = await collect(acme.id, acme.prefix);
    expect(afterProbe.map((entry) => entry.dedupKey)).toEqual([dedupKey]);
    expect(afterProbe[0]!.subject.metadata).toMatchObject({ waitingCount: 2 });

    // A new limit after a successful run is a new episode, so a new item.
    const nextStart = minutesAgo(1);
    await db.update(aiAccounts).set({ limitEpisodeStartedAt: nextStart }).where(eq(aiAccounts.id, max.id));
    expect((await collect(acme.id, acme.prefix)).map((entry) => entry.dedupKey))
      .toEqual([`resource_wait:ai_account:account:${max.id}:${nextStart.toISOString()}`]);
  });

  it("keeps one item per task for reasons a person must act on", async () => {
    const acme = await company();
    await user("owner", [acme.id]);
    const worker = await agent(acme.id, "Worker");
    const signedOut = await account("owner", "Team key", { status: "auth_failed" });
    const runs = [];
    for (const since of [minutesAgo(20), minutesAgo(5)]) {
      const task = await issue(acme.id, acme.prefix, worker.id);
      const run = await laneRun(worker, task.id, "ai_account_wait");
      await episode({ agent: worker, issueId: task.id, kind: "ai_account", reason: "signed_out", scope: "account", resourceKey: `account:${signedOut.id}`, accountId: signedOut.id, since, currentRunId: run.id });
      runs.push(run);
    }
    const items = await collect(acme.id, acme.prefix);
    expect(items.map((entry) => entry.dedupKey)).toEqual([
      `resource_wait:ai_account:account:${signedOut.id}:${minutesAgo(20).toISOString()}:signed_out`,
      `resource_wait:ai_account:account:${signedOut.id}:${minutesAgo(5).toISOString()}:signed_out`,
    ]);
    expect(items[0]).toMatchObject({ severity: "high", subject: { title: "Claude account Team key is signed out" } });
    expect(items[0]!.whyNow).toContain("replace the token");
  });

  it("skips waits whose run the issue gate ended, closed or hidden tasks, and reasons that never notify", async () => {
    const acme = await company();
    await user("owner", [acme.id]);
    const max = await account("owner", "Max", { limitEpisodeStartedAt: minutesAgo(15) });
    const worker = await agent(acme.id);

    // The gate cancelled the current run; the sweep has not closed the episode yet.
    const gated = await limitWait(worker, acme.prefix, max.id, minutesAgo(14));
    await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "issue_reassigned" }).where(eq(heartbeatRuns.id, gated.run.id));
    // The task was closed while it waited.
    const closed = await limitWait(worker, acme.prefix, max.id, minutesAgo(13));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, closed.task.id));
    // A hidden task.
    const hidden = await limitWait(worker, acme.prefix, max.id, minutesAgo(12));
    await db.update(issues).set({ hiddenAt: now }).where(eq(issues.id, hidden.task.id));
    // A deliberate stop, and a run-scoped sign-in check, never notify.
    for (const [reason, kind, scope, lane] of [
      ["stopped", "environment", "admission", "environment_wait"],
      ["auth_unconfirmed", "ai_account", "account", "ai_account_wait"],
    ] as const) {
      const task = await issue(acme.id, acme.prefix, worker.id);
      const run = await laneRun(worker, task.id, lane);
      await episode({ agent: worker, issueId: task.id, kind, reason, scope, resourceKey: kind === "environment" ? `environment:${randomUUID()}` : `account:${max.id}`, since: minutesAgo(11), currentRunId: run.id });
    }

    expect(await collect(acme.id, acme.prefix)).toEqual([]);
  });

  it("shows a device outage once it is older than the company's notify-after hours", async () => {
    const acme = await company();
    const worker = await agent(acme.id, "Remote worker");
    const [ssh] = await db.insert(environments).values({ name: "Studio", driver: "ssh", config: { host: "studio.example.com", port: 22, username: "runner" } }).returning();
    const device = (await deviceForEnvironment(db, ssh!))!;
    const outageStart = hoursAgo(30);
    await db.insert(environmentAvailability).values({ environmentId: ssh!.id, state: "unavailable", reason: "unreachable", unavailableSince: outageStart, checkedAt: minutesAgo(1), source: "lease_error" });
    const task = await issue(acme.id, acme.prefix, worker.id);
    const run = await laneRun(worker, task.id, "environment_wait");
    await episode({ agent: worker, issueId: task.id, kind: "environment", reason: "unreachable", scope: "target", resourceKey: `environment:${ssh!.id}`, environmentId: ssh!.id, deviceId: device.id, since: hoursAgo(2), currentRunId: run.id });

    // Two hours is under the 24-hour default.
    expect(await collect(acme.id, acme.prefix)).toEqual([]);

    await db.insert(executionWaitSettings).values({ companyId: acme.id, notifyAfterHours: 1 });
    const [item] = await collect(acme.id, acme.prefix);
    expect(item).toMatchObject({
      dedupKey: `resource_wait:environment:environment:${ssh!.id}:${outageStart.toISOString()}`,
      severity: "high",
      activityAt: new Date(outageStart.getTime() + 3_600_000).toISOString(),
      subject: { title: `Waiting for device ${device.name} (unreachable)` },
    });
    expect(item!.whyNow).toContain("A task has waited for");
    expect(JSON.stringify(item)).not.toContain("studio.example.com");

    // 0 never notifies.
    await db.update(executionWaitSettings).set({ notifyAfterHours: 0 }).where(eq(executionWaitSettings.companyId, acme.id));
    expect(await collect(acme.id, acme.prefix)).toEqual([]);
  });

  it("names an account only where its owner is an active member", async () => {
    const acme = await company();
    const other = await company();
    await user("outsider", [other.id]);
    const theirs = await account("outsider", "Outsider private label", { status: "auth_failed" });
    const worker = await agent(acme.id, "Worker");
    const task = await issue(acme.id, acme.prefix, worker.id);
    const run = await laneRun(worker, task.id, "ai_account_wait");
    await episode({ agent: worker, issueId: task.id, kind: "ai_account", reason: "signed_out", scope: "account", resourceKey: `account:${theirs.id}`, accountId: theirs.id, since: minutesAgo(3), currentRunId: run.id });

    const [item] = await collect(acme.id, acme.prefix);
    expect(item!.subject.title).toBe("A Claude account is signed out");
    expect(JSON.stringify(item)).not.toContain("Outsider private label");
    expect(item!.subject.metadata).not.toHaveProperty("accountId");

    // In local_trusted mode the local board user's accounts keep their labels.
    await user("local-board");
    const local = await account("local-board", "Local board key", { status: "auth_failed" });
    await db.update(resourceWaitEpisodes).set({ accountId: local.id, resourceKey: `account:${local.id}` }).where(eq(resourceWaitEpisodes.currentRunId, run.id));
    const [trusted] = await collect(acme.id, acme.prefix, { deploymentMode: "local_trusted" });
    expect(trusted!.subject.title).toBe("Claude account Local board key is signed out");
  });

  it("reads everything in one query, whatever the number of waits", async () => {
    const acme = await company();
    await user("owner", [acme.id]);
    const max = await account("owner", "Max", { limitEpisodeStartedAt: minutesAgo(40) });
    const worker = await agent(acme.id);
    for (let index = 0; index < 4; index += 1) await limitWait(worker, acme.prefix, max.id, minutesAgo(39 - index));
    const unassignedTask = await issue(acme.id, acme.prefix, worker.id);
    const unassignedRun = await laneRun(worker, unassignedTask.id, "ai_account_wait");
    await episode({ agent: worker, issueId: unassignedTask.id, kind: "ai_account", reason: "unassigned", scope: "account", resourceKey: "account:none", since: minutesAgo(2), currentRunId: unassignedRun.id });

    const counted = countingDb(db);
    const items = await collect(acme.id, acme.prefix, { database: counted.db });
    expect(items).toHaveLength(2);
    expect(counted.counter.queries).toBe(1);

    const empty = await company();
    const countedEmpty = countingDb(db);
    expect(await collect(empty.id, empty.prefix, { database: countedEmpty.db })).toEqual([]);
    expect(countedEmpty.counter.queries).toBe(1);
  });

  it("reads the company's over-limit notices once per read, by key, however many notices the company has", async () => {
    const acme = await company();
    await user("owner", [acme.id]);
    const max = await account("owner", "Max", { limitEpisodeStartedAt: minutesAgo(40) });
    const worker = await agent(acme.id);
    for (let index = 0; index < 4; index += 1) await limitWait(worker, acme.prefix, max.id, minutesAgo(39 - index));
    // A device flagged over its limit with the company's notice, among the many notices a company collects.
    const [local] = await db.insert(environments).values({ name: "Local", driver: "local" }).returning();
    const server = (await deviceForEnvironment(db, local!))!;
    const overLimitAt = minutesAgo(3);
    await db.update(aiAccountHosts).set({ overLimitAt }).where(eq(aiAccountHosts.id, server.id));
    expect(await noteDeviceOverLimit(db, { deviceId: server.id, change: "flagged", overLimitAt, companyIds: [acme.id] })).toEqual([acme.id]);
    await db.execute(sql`
      insert into resource_wait_notices (company_id, notice_key)
      select ${acme.id}, 'issue:' || gen_random_uuid() || ':' || gen_random_uuid() || ':immediate' from generate_series(1, 2000)
    `);
    // The notices of the device's earlier flags stay too.
    await db.execute(sql`
      insert into resource_wait_notices (company_id, notice_key)
      select ${acme.id}, ${`device-over-limit:${server.id}:`} || (${overLimitAt.getTime()}::bigint - n * 60000) from generate_series(1, 200) n
    `);
    await db.execute(sql`analyze resource_wait_notices`);

    const capture = captureQueries(db);
    let items: Awaited<ReturnType<typeof collect>>;
    try {
      items = await collect(acme.id, acme.prefix);
    } finally {
      capture.restore();
    }
    expect(items.map((entry) => entry.dedupKey)).toContain(`resource_wait:device_slots:device:${server.id}:${overLimitAt.toISOString()}`);
    expect(capture.queries).toHaveLength(1);
    // Index paths and nested loops, as on large tables: the notice is found by its key, not among the company's 2000.
    const plan = await explainAnalyze(db, capture.queries[0]!, ["enable_seqscan = off", "enable_hashjoin = off", "enable_mergejoin = off"]);
    const noticeScans = scansOf(plan, "resource_wait_notices");
    expect(noticeScans.length).toBeGreaterThan(0);
    // Once per read and flagged device, never once per waiting task.
    expect(noticeScans.reduce((loops, node) => loops + Number(node["Actual Loops"] ?? 1), 0)).toBe(1);
    expect(rowsExamined(plan, "resource_wait_notices")).toBeLessThan(20);
  });

  it("lets the board triage and queue a live wait item, and fails closed once the wait ends", async () => {
    const acme = await company();
    await user("owner", [acme.id]);
    const max = await account("owner", "Max-2", { limitEpisodeStartedAt: minutesAgo(30) });
    const worker = await agent(acme.id, "Worker");
    const wait = await limitWait(worker, acme.prefix, max.id, minutesAgo(29));
    const [item] = await collect(acme.id, acme.prefix);
    const sourceId = item!.subject.id;
    const board: AuthorizationActor = { type: "board", source: "local_implicit", userId: "board-user", companyIds: [acme.id], isInstanceAdmin: false };
    const actor: DecisionMutationActor = { actorType: "user", actorId: "board-user", agentId: null, userId: "board-user", runId: null, agentApiKeyId: null, responsibleUserId: "board-user" };
    const queues = decisionQueueService(db);

    expect(await canReadDecisionSource(db, board, acme.id, "resource_wait_alert", sourceId)).toBe(true);
    expect(await queues.updateTriage({ companyId: acme.id, sourceKind: "resource_wait_alert", sourceId, decideBy: "today", authActor: board, actor }))
      .toMatchObject({ sourceKind: "resource_wait_alert", sourceId, decideBy: "today" });
    await queues.create({ companyId: acme.id, key: "waits", title: "Waits", authActor: board, actor });
    expect((await queues.addItem({ companyId: acme.id, key: "waits", sourceKind: "resource_wait_alert", sourceId, authActor: board, actor })).created).toBe(true);
    expect(await queues.listItems(acme.id, "waits", board)).toEqual([expect.objectContaining({ sourceKind: "resource_wait_alert", sourceId })]);
    // A key that names no live wait is no source.
    expect(await canReadDecisionSource(db, board, acme.id, "resource_wait_alert", `${sourceId}-x`)).toBe(false);

    // Once the wait ends there is no source: writes fail closed and the queue hides the row.
    await db.update(resourceWaitEpisodes).set({ resolvedAt: now, resolution: "resolved" }).where(eq(resourceWaitEpisodes.id, wait.episode.id));
    await expect(queues.updateTriage({ companyId: acme.id, sourceKind: "resource_wait_alert", sourceId, decideBy: "this_week", authActor: board, actor }))
      .rejects.toMatchObject({ status: 404 });
    expect(await queues.listItems(acme.id, "waits", board)).toEqual([]);
  });

  it("notifies each affected company at once when a device goes over its account limit", async () => {
    const acme = await company("Acme");
    const bystander = await company("Bystander");
    await user("owner", [acme.id]);
    const [local] = await db.insert(environments).values({ name: "Local", driver: "local" }).returning();
    const server = (await deviceForEnvironment(db, local!))!;
    await db.update(aiAccountHosts).set({ maxAccounts: 1 }).where(eq(aiAccountHosts.id, server.id));
    const first = await agent(acme.id, "First");
    const second = await agent(acme.id, "Second");
    const a = await account("owner", "Account A");
    const b = await account("owner", "Account B");
    await db.insert(aiAccountAgentBindings).values([
      { agentId: first.id, companyId: acme.id, mode: "pool_account", accountId: a.id },
      { agentId: second.id, companyId: acme.id, mode: "pool_account", accountId: b.id },
    ]);
    await agent(bystander.id, "Elsewhere");

    const [check] = await recheckDeviceLimits(db, { deviceIds: [server.id], now: minutesAgo(5) });
    expect(check).toMatchObject({ change: "flagged", overLimit: true, companyIds: [acme.id] });
    const overLimitAt = check!.overLimitAt!;
    expect(await db.select().from(resourceWaitNotices).where(eq(resourceWaitNotices.noticeKey, deviceOverLimitNoticeKey(server.id, overLimitAt))))
      .toHaveLength(1);
    expect(await db.select({ action: activityLog.action }).from(activityLog).where(and(eq(activityLog.companyId, acme.id), eq(activityLog.entityId, server.id))))
      .toEqual([{ action: "execution_device.over_limit" }]);
    // The notice is claimed once per flag.
    expect(await noteDeviceOverLimit(db, check!)).toEqual([]);

    const dedupKey = `resource_wait:device_slots:device:${server.id}:${overLimitAt.toISOString()}`;
    const [notice] = await collect(acme.id, acme.prefix);
    expect(notice).toMatchObject({
      dedupKey,
      severity: "high",
      relatedIssue: null,
      subject: { title: `${server.name} is over its Claude account limit`, href: `/${acme.prefix}/company/settings/devices` },
    });
    expect(notice!.whyNow).toContain("than its limit of 1");
    expect(await collect(bystander.id, bystander.prefix)).toEqual([]);

    // Slot waits of the same flag share the item.
    const task = await issue(acme.id, acme.prefix, second.id);
    const run = await laneRun(second, task.id, "device_slot_wait");
    const slotWait = await episode({ agent: second, issueId: task.id, kind: "device_slots", reason: "slots_full", scope: "device", resourceKey: `device:${server.id}`, deviceId: server.id, accountId: b.id, since: minutesAgo(2), currentRunId: run.id });
    const merged = await collect(acme.id, acme.prefix);
    expect(merged.map((entry) => entry.dedupKey)).toEqual([dedupKey]);
    expect(merged[0]!.whyNow).toContain("A task waits for a free slot");
    expect(merged[0]!.relatedIssue).toMatchObject({ id: task.id });

    // Once the bound accounts fit again, the flag clears and the notice goes.
    await db.update(resourceWaitEpisodes).set({ resolvedAt: now, resolution: "resolved" }).where(eq(resourceWaitEpisodes.id, slotWait.id));
    await db.delete(aiAccountAgentBindings).where(eq(aiAccountAgentBindings.agentId, second.id));
    const [cleared] = await recheckDeviceLimits(db, { deviceIds: [server.id] });
    expect(cleared).toMatchObject({ change: "cleared", overLimit: false });
    expect(await collect(acme.id, acme.prefix)).toEqual([]);

    // A later overflow is a new flag, with one new item; the old notice stays gone.
    await db.insert(aiAccountAgentBindings).values({ agentId: second.id, companyId: acme.id, mode: "pool_account", accountId: b.id });
    const [again] = await recheckDeviceLimits(db, { deviceIds: [server.id], now: minutesAgo(1) });
    expect(again).toMatchObject({ change: "flagged" });
    expect((await collect(acme.id, acme.prefix)).map((entry) => entry.dedupKey))
      .toEqual([`resource_wait:device_slots:device:${server.id}:${again!.overLimitAt!.toISOString()}`]);
  });

  it("feeds the attention list, where a dismissal holds for the whole episode", async () => {
    const acme = await company();
    await user("owner", [acme.id]);
    const limitStart = minutesAgo(30);
    const max = await account("owner", "Max-2", { limitEpisodeStartedAt: limitStart });
    const worker = await agent(acme.id, "Worker");
    const wait = await limitWait(worker, acme.prefix, max.id, minutesAgo(29));
    const service = attentionService(db, { now: () => now.getTime() });

    const feed = await service.list(acme.id, { userId: "board-user", all: true, allowUnscopedAll: true });
    const items = feed.items.filter((entry) => entry.sourceKind === "resource_wait_alert");
    expect(items).toHaveLength(1);
    expect(feed.countsBySourceKind.resource_wait_alert).toBe(1);
    const dedupKey = items[0]!.dedupKey;
    expect(items[0]).toMatchObject({ id: `resource_wait_alert:${dedupKey}`, dismissalKey: `attention:${dedupKey}`, inlineResolvable: false });

    await db.insert(inboxDismissals).values({ companyId: acme.id, userId: "board-user", itemKey: `attention:${dedupKey}`, dismissedAt: minutesAgo(20) });
    // A replacement run of the same limit episode keeps the dismissal.
    const replacement = await laneRun(worker, wait.task.id, "ai_account_wait");
    await db.update(resourceWaitEpisodes).set({ currentRunId: replacement.id }).where(eq(resourceWaitEpisodes.id, wait.episode.id));
    const dismissed = await service.list(acme.id, { userId: "board-user", all: true, allowUnscopedAll: true });
    expect(dismissed.items.filter((entry) => entry.sourceKind === "resource_wait_alert")).toEqual([]);

    // The next limit episode is a new item.
    await db.update(aiAccounts).set({ limitEpisodeStartedAt: minutesAgo(1) }).where(eq(aiAccounts.id, max.id));
    const next = await service.list(acme.id, { userId: "board-user", all: true, allowUnscopedAll: true });
    expect(next.items.filter((entry) => entry.sourceKind === "resource_wait_alert").map((entry) => entry.dedupKey))
      .toEqual([`resource_wait:ai_account:account:${max.id}:${minutesAgo(1).toISOString()}`]);
  });
});
