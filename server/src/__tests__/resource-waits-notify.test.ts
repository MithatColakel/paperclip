import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  aiAccountAgentBindings,
  aiAccountHosts,
  aiAccountRunSlots,
  aiAccounts,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  environments,
  executionWaitSettings,
  heartbeatRuns,
  issueAccessGrants,
  issues,
  resourceWaitEpisodes,
  resourceWaitNotices,
} from "@paperclipai/db";
import { RESOURCE_WAIT_LANE_BY_KIND, type ResourceWaitKind, type ResourceWaitReason, type ResourceWaitScope } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  claimResourceWaitNotice,
  createResourceWaitNotifier,
  instanceDefaultNotifyHours,
  readExecutionWaitSettings,
  resourceEpisodeKeys,
  resourceWaitPmNoticeMarkdown,
  type ResourceWaitIssueNotice,
  type ResourceWaitWakeupOptions,
} from "../services/resource-waits/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres resource-wait notice tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("notice settings defaults", () => {
  it("reads the instance default hours from the environment", () => {
    expect(instanceDefaultNotifyHours({})).toBe(24);
    expect(instanceDefaultNotifyHours({ PAPERCLIP_RESOURCE_WAIT_NOTIFY_HOURS: "6" })).toBe(6);
    expect(instanceDefaultNotifyHours({ PAPERCLIP_RESOURCE_WAIT_NOTIFY_HOURS: "0" })).toBe(0);
    expect(instanceDefaultNotifyHours({ PAPERCLIP_RESOURCE_WAIT_NOTIFY_HOURS: "900" })).toBe(168);
    expect(instanceDefaultNotifyHours({ PAPERCLIP_RESOURCE_WAIT_NOTIFY_HOURS: "soon" })).toBe(24);
  });
});

// Fork: the task context heartbeat renders for a PM's summary wake (spec 8).
describe("resourceWaitPmNoticeMarkdown", () => {
  const wake = (resourceWaitNotice: Record<string, unknown>) => ({ wakeReason: "resource_wait_notice", resourceWaitNotice });

  it("names the resource, the reason, the reset and the waiting tasks, and says nothing moves", () => {
    const text = resourceWaitPmNoticeMarkdown(wake({
      kind: "ai_account",
      reason: "usage_limit",
      resourceLabel: "Max two",
      resumeAt: "2026-10-17T18:00:00.000Z",
      issueIds: ["issue-a", "issue-b"],
    }));
    expect(text).toContain('the Claude account "Max two" (usage limit)');
    expect(text).toContain("2026-10-17 18:00 UTC");
    expect(text).toContain("never moves a task to another Claude account or device");
    expect(text).toContain("- issue-a\n- issue-b");
    expect(resourceWaitPmNoticeMarkdown(wake({ kind: "environment", reason: "offline", resourceLabel: "Build box", issueIds: [] })))
      .toContain('the device "Build box" (offline)');
    expect(resourceWaitPmNoticeMarkdown(wake({ kind: "device_slots", reason: "slots_full", resourceLabel: "Build box" })))
      .toContain('a free account slot on the device "Build box"');
  });

  it("never names an account its owner no longer shares with the company", () => {
    const text = resourceWaitPmNoticeMarkdown(wake({
      kind: "ai_account",
      reason: "owner_not_member",
      resourceLabel: "an account that is no longer available in this company",
    }));
    expect(text).toContain("a Claude account that is no longer available in this company (account no longer available)");
    expect(text).not.toContain('"an account');
  });

  it("is empty for any other run", () => {
    expect(resourceWaitPmNoticeMarkdown({ wakeReason: "issue_assigned", resourceWait: { kind: "ai_account" } })).toBe("");
    expect(resourceWaitPmNoticeMarkdown({ wakeReason: "resource_wait_notice" })).toBe("");
    expect(resourceWaitPmNoticeMarkdown(null)).toBe("");
    // A lane run's own wait is never shown as a summary, whatever its wake reason.
    expect(resourceWaitPmNoticeMarkdown({
      wakeReason: "resource_wait_notice",
      resourceWait: { version: 1, episodeId: "episode-1", kind: "environment", reason: "offline", scope: "target", issueIds: ["issue-a"] },
    })).toBe("");
  });

  it("shows the summary after a later wake or the summary run's own wait replaced its wake reason", () => {
    const summary = { kind: "ai_account", reason: "usage_limit", resourceLabel: "Max two", issueIds: ["issue-a"] };
    // A timer wake merged into the queued summary run.
    expect(resourceWaitPmNoticeMarkdown({ wakeReason: "heartbeat_timer", resourceWaitNotice: summary }))
      .toContain('the Claude account "Max two" (usage limit)');
    // The summary run waited for the PM's own device: its successor carries the lane's wake reason and wait.
    expect(resourceWaitPmNoticeMarkdown({
      wakeReason: "environment_wait_retry",
      retryReason: "environment_wait",
      resourceWait: { version: 1, episodeId: "episode-1", kind: "environment", reason: "offline", scope: "target" },
      resourceWaitNotice: summary,
    })).toContain("- issue-a");
  });
});

describeEmbeddedPostgres("resource wait notices (database)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let localEnvironment: typeof environments.$inferSelect;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-resource-waits-notify-");
    db = createDb(database.connectionString);
  }, 120_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate table companies, plugins, ai_account_hosts, ai_accounts, environments, "user" cascade`);
    [localEnvironment] = await db.insert(environments).values({ name: "Local", driver: "local" }).returning();
  });

  const tag = () => randomUUID().slice(0, 8);
  const hours = (now: Date, n: number) => new Date(now.getTime() + n * 3_600_000);

  async function company() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: `Company ${tag()}`, issuePrefix: `N${id.replaceAll("-", "").slice(0, 7).toUpperCase()}` });
    return id;
  }

  async function agent(companyId: string, overrides: Partial<typeof agents.$inferInsert> = {}) {
    const [row] = await db.insert(agents).values({
      companyId, name: `Agent ${tag()}`, adapterType: "claude_local", status: "active", ...overrides,
    }).returning();
    return row!;
  }

  async function member(companyId: string, userId: string) {
    const at = new Date();
    await db.insert(authUsers).values({ id: userId, name: userId, email: `${userId}@example.com`, emailVerified: true, createdAt: at, updatedAt: at }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
  }

  async function account(ownerUserId: string, overrides: Partial<typeof aiAccounts.$inferInsert> = {}) {
    const [row] = await db.insert(aiAccounts).values({
      credentialType: "subscription", label: `Max ${tag()}`, ownerUserId, createdByUserId: ownerUserId,
      credentialMaterial: { provider: "local_encrypted", ciphertext: tag() }, credentialFingerprint: randomUUID(), ...overrides,
    }).returning();
    return row!;
  }

  async function waiting(input: {
    agent: typeof agents.$inferSelect;
    issueId?: string | null;
    kind: ResourceWaitKind;
    reason: ResourceWaitReason;
    scope: ResourceWaitScope;
    since: Date;
    environmentId?: string | null;
    deviceId?: string | null;
    accountId?: string | null;
    resumeAt?: Date | null;
    runStatus?: string;
  }) {
    const issueId = input.issueId ?? null;
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: input.agent.companyId, agentId: input.agent.id, status: input.runStatus ?? "scheduled_retry",
      scheduledRetryReason: RESOURCE_WAIT_LANE_BY_KIND[input.kind], scheduledRetryAt: hours(new Date(), 1),
      contextSnapshot: issueId ? { issueId } : {},
    }).returning();
    const resourceKey = input.kind === "environment" ? `environment:${input.environmentId}`
      : input.kind === "ai_account" ? `account:${input.accountId}` : `device:${input.deviceId}`;
    const [episode] = await db.insert(resourceWaitEpisodes).values({
      companyId: input.agent.companyId, agentId: input.agent.id, issueId, kind: input.kind, reason: input.reason, scope: input.scope,
      resourceKey, environmentId: input.environmentId ?? null, deviceId: input.deviceId ?? null, accountId: input.accountId ?? null,
      since: input.since, resumeAt: input.resumeAt ?? null, resumeAtSource: input.resumeAt ? "provider" : null, currentRunId: run!.id,
    }).returning();
    return { run: run!, episode: episode! };
  }

  function notifier(options: { failFirstNotice?: boolean; env?: NodeJS.ProcessEnv } = {}) {
    const notices: ResourceWaitIssueNotice[] = [];
    const wakes: Array<{ agentId: string; opts: ResourceWaitWakeupOptions }> = [];
    let failures = options.failFirstNotice ? 1 : 0;
    const service = createResourceWaitNotifier({
      db,
      env: options.env ?? {},
      deps: {
        async addIssueSystemNotice(input) {
          if (failures > 0) {
            failures -= 1;
            throw new Error("comment insert failed");
          }
          notices.push(input);
          return null;
        },
        async enqueueWakeup(agentId, opts) {
          wakes.push({ agentId, opts });
          return null;
        },
      },
    });
    return { service, notices, wakes };
  }

  async function episode(id: string) {
    const [row] = await db.select().from(resourceWaitEpisodes).where(eq(resourceWaitEpisodes.id, id));
    return row!;
  }

  it("gates a key for its first inserter only", async () => {
    const companyId = await company();
    expect(await claimResourceWaitNotice(db, companyId, "issue:x:y:immediate")).toBe(true);
    expect(await claimResourceWaitNotice(db, companyId, "issue:x:y:immediate")).toBe(false);
    expect(await claimResourceWaitNotice(db, await company(), "issue:x:y:immediate")).toBe(true);
  });

  it("posts an immediate notice once per episode, names the fix, and retries a failed send", async () => {
    const companyId = await company();
    await member(companyId, "owner-1");
    const worker = await agent(companyId);
    const [task] = await db.insert(issues).values({ companyId, title: "Task", status: "in_progress", priority: "medium", assigneeAgentId: worker.id }).returning();
    const pool = await account("owner-1", { label: "Max-2", status: "auth_failed" });
    const { episode: row } = await waiting({ agent: worker, issueId: task!.id, kind: "ai_account", reason: "signed_out", scope: "account", since: new Date(), accountId: pool.id });
    const { service, notices } = notifier({ failFirstNotice: true });
    await expect(service.notifyImmediate(row)).rejects.toThrow("comment insert failed");
    expect(await db.select().from(resourceWaitNotices)).toEqual([]);
    expect(await service.notifyImmediate(row)).toMatchObject({ issueNotice: true });
    expect(await service.notifyImmediate(await episode(row.id))).toMatchObject({ issueNotice: false });
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toContain("Waiting for Claude account **Max-2**: it is signed out");
    expect(notices[0]!.body).toContain(worker.name);
    expect(notices[0]!.presentation).toMatchObject({ kind: "system_notice", tone: "warning" });
    expect((await episode(row.id)).notifiedAt).not.toBeNull();
  });

  it("never names an account whose owner is not a member of the company", async () => {
    const companyId = await company();
    const worker = await agent(companyId);
    const [task] = await db.insert(issues).values({ companyId, title: "Task", status: "in_progress", priority: "medium", assigneeAgentId: worker.id }).returning();
    const outsider = await account("owner-9", { label: "Private Max" });
    const { episode: row } = await waiting({ agent: worker, issueId: task!.id, kind: "ai_account", reason: "owner_not_member", scope: "account", since: new Date(), accountId: outsider.id });
    const { service, notices } = notifier();
    await service.notifyImmediate(row);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toContain("an account that is no longer available in this company");
    expect(JSON.stringify(notices[0])).not.toContain("Private Max");
  });

  it("wakes the PM once per limit episode, without an issue id, and skips a PM on the same account", async () => {
    const now = new Date();
    const companyId = await company();
    await member(companyId, "owner-1");
    const lead = await agent(companyId, { name: "Lead" });
    const worker = await agent(companyId, { reportsTo: lead.id });
    const pool = await account("owner-1", { label: "Max-2", exhaustedUntil: hours(now, 2), limitEpisodeStartedAt: now, limitReason: "provider_quota", limitSource: "provider", limitStrikes: 1 });
    const issueIds: string[] = [];
    const episodes = [];
    for (let index = 0; index < 2; index += 1) {
      const [task] = await db.insert(issues).values({ companyId, title: `Task ${index}`, status: "in_progress", priority: "medium", assigneeAgentId: worker.id, createdByAgentId: lead.id }).returning();
      issueIds.push(task!.id);
      episodes.push((await waiting({ agent: worker, issueId: task!.id, kind: "ai_account", reason: "usage_limit", scope: "account", since: now, accountId: pool.id, resumeAt: hours(now, 2) })).episode);
    }
    const { service, notices, wakes } = notifier();
    for (const row of episodes) await service.notifyImmediate(row);
    // One issue notice per episode; one PM wake for the account's limit episode.
    expect(notices).toHaveLength(2);
    expect(notices[0]!.body).toContain("usage limit reached. Resumes automatically at");
    expect(notices[0]!.body).toContain("(provider reset)");
    expect(notices[0]!.body).toContain("Paperclip never moves a task to another account.");
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.agentId).toBe(lead.id);
    expect(wakes[0]!.opts.payload).toBeNull();
    expect(wakes[0]!.opts.contextSnapshot).not.toHaveProperty("issueId");
    expect(wakes[0]!.opts.contextSnapshot).toMatchObject({
      wakeReason: "resource_wait_notice",
      resourceWaitNotice: { kind: "ai_account", reason: "usage_limit", resourceLabel: "Max-2" },
    });
    // Fork: the summary is a run of its own, and `resourceWait` stays a lane run's own wait.
    expect(wakes[0]!.opts.allowRunCoalescing).toBe(false);
    expect(wakes[0]!.opts.contextSnapshot).not.toHaveProperty("resourceWait");
    expect((wakes[0]!.opts.contextSnapshot.resourceWaitNotice as { issueIds: string[] }).issueIds.sort()).toEqual([...issueIds].sort());
    const keys = await resourceEpisodeKeys(db, episodes);
    expect(new Set(keys.values())).toEqual(new Set([now.toISOString()]));

    // A PM bound to the same account would only wait too.
    const sharedLead = await agent(companyId, { name: "Shared lead" });
    await db.insert(aiAccountAgentBindings).values({ agentId: sharedLead.id, companyId, mode: "pool_account", accountId: pool.id });
    const sibling = await agent(companyId, { reportsTo: sharedLead.id });
    const { episode: shared } = await waiting({ agent: sibling, kind: "ai_account", reason: "usage_limit", scope: "account", since: now, accountId: pool.id });
    const second = notifier();
    expect(await second.service.notifyImmediate(shared)).toMatchObject({ pmWake: false });
    expect(second.wakes).toEqual([]);
    // The company can turn account PM wakes off.
    await db.insert(executionWaitSettings).values({ companyId, notifyPmOnAccountWait: false });
    const third = await waiting({ agent: worker, kind: "ai_account", reason: "signed_out", scope: "account", since: now, accountId: pool.id });
    const quiet = notifier();
    expect(await quiet.service.notifyImmediate(third.episode)).toMatchObject({ pmWake: false });
  });

  it("lists in the PM's wake only the waiting tasks the PM may read", async () => {
    const now = new Date();
    const companyId = await company();
    await member(companyId, "owner-1");
    await member(companyId, "private-owner");
    const lead = await agent(companyId, { name: "Lead" });
    const worker = await agent(companyId, { reportsTo: lead.id });
    const pool = await account("owner-1", { label: "Max-2", exhaustedUntil: hours(now, 2), limitEpisodeStartedAt: now, limitReason: "provider_quota", limitSource: "provider", limitStrikes: 1 });
    const task = async (title: string, visibility: "open" | "private") => {
      const id = randomUUID();
      const [row] = await db.insert(issues).values({
        id, companyId, title, status: "in_progress", priority: "medium", assigneeAgentId: worker.id, createdByAgentId: lead.id,
        ...(visibility === "private" ? { visibility, privacyRootIssueId: id, responsibleUserId: "private-owner", createdByUserId: "private-owner" } : {}),
      }).returning();
      const wait = await waiting({ agent: worker, issueId: row!.id, kind: "ai_account", reason: "usage_limit", scope: "account", since: now, accountId: pool.id, resumeAt: hours(now, 2) });
      return { id: row!.id, episode: wait.episode };
    };
    const open = await task("Open task", "open");
    // Private to its owner: neither the lead's own nor shared with it (creating it as an agent grants nothing).
    const unreadable = await task("Private task", "private");
    // Private, but shared with the lead.
    const shared = await task("Private task shared with the lead", "private");
    await db.insert(issueAccessGrants).values({ issueId: shared.id, subjectType: "agent", subjectId: lead.id, source: "explicit", grantedByUserId: "private-owner" });

    const { service, wakes } = notifier();
    expect(await service.notifyImmediate(open.episode, now)).toMatchObject({ pmWake: true });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.agentId).toBe(lead.id);
    const listed = (wakes[0]!.opts.contextSnapshot.resourceWaitNotice as { issueIds: string[] }).issueIds;
    expect([...listed].sort()).toEqual([open.id, shared.id].sort());
    expect(JSON.stringify(wakes[0]!.opts)).not.toContain(unreadable.id);
  });

  it("reports a long device wait once after the threshold, and the PM only when the company asks", async () => {
    const now = new Date();
    const companyId = await company();
    const lead = await agent(companyId);
    const worker = await agent(companyId, { reportsTo: lead.id });
    const ssh = (await db.insert(environments).values({ name: "Runner", driver: "ssh", config: { host: "runner.invalid" } }).returning())[0]!;
    const [device] = await db.insert(aiAccountHosts).values({ name: "SSH · Runner", kind: "ssh_host", externalKey: "ssh:runner.invalid:22" }).returning();
    const [task] = await db.insert(issues).values({ companyId, title: "Task", status: "in_progress", priority: "medium", assigneeAgentId: worker.id }).returning();
    const { episode: row } = await waiting({ agent: worker, issueId: task!.id, kind: "environment", reason: "offline", scope: "target", since: hours(now, -23), environmentId: ssh.id, deviceId: device!.id });
    const { service, notices, wakes } = notifier();
    expect(await service.notifyLong(row, now)).toMatchObject({ issueNotice: false });
    const later = hours(now, 2);
    expect(await service.notifyLong(row, later)).toMatchObject({ issueNotice: true, pmWake: false });
    expect(await service.notifyLong(await episode(row.id), later)).toMatchObject({ issueNotice: false });
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toContain("This task has been waiting for device **SSH · Runner** for **1 d 1 h** (offline)");
    expect(notices[0]!.body).toContain(`move **${worker.name}** to another device`);
    expect(wakes).toEqual([]);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "resource_wait.long_wait_notified"))).toHaveLength(1);

    // With device PM wakes on, the PM hears about it, unless it runs on the same device.
    await db.insert(executionWaitSettings).values({ companyId, notifyPmOnDeviceWait: true, notifyAfterHours: 1 });
    const peer = () => agent(companyId, { reportsTo: lead.id });
    const second = await waiting({ agent: await peer(), kind: "environment", reason: "unreachable", scope: "target", since: hours(now, -2), environmentId: ssh.id, deviceId: device!.id });
    const loud = notifier();
    expect(await loud.service.notifyLong(second.episode, now)).toMatchObject({ pmWake: true });
    expect(loud.wakes[0]!.agentId).toBe(lead.id);
    await db.update(agents).set({ defaultEnvironmentId: ssh.id }).where(eq(agents.id, lead.id));
    const third = await waiting({ agent: await peer(), kind: "environment", reason: "paused", scope: "target", since: hours(now, -2), environmentId: ssh.id, deviceId: device!.id });
    const onDevice = notifier();
    expect(await onDevice.service.notifyLong(third.episode, now)).toMatchObject({ pmWake: false });
    // 0 hours never reports.
    await db.update(executionWaitSettings).set({ notifyAfterHours: 0 }).where(eq(executionWaitSettings.companyId, companyId));
    const fourth = await waiting({ agent: await peer(), kind: "environment", reason: "offline", scope: "target", since: hours(now, -100), environmentId: ssh.id, deviceId: device!.id });
    expect(await onDevice.service.notifyLong(fourth.episode, now)).toMatchObject({ issueNotice: false, pmWake: false });
    expect(await readExecutionWaitSettings(db, companyId, {})).toMatchObject({ notifyAfterHours: 0, notifyPmOnDeviceWait: true, notifyPmOnAccountWait: true, instanceDefaultHours: 24 });
  });

  it("never notifies a deliberate stop and posts the resolved notice only for a notified wait", async () => {
    const now = new Date();
    const companyId = await company();
    const worker = await agent(companyId, { defaultEnvironmentId: localEnvironment.id });
    const [task] = await db.insert(issues).values({ companyId, title: "Task", status: "in_progress", priority: "medium", assigneeAgentId: worker.id }).returning();
    const stopped = await waiting({ agent: worker, issueId: task!.id, kind: "environment", reason: "stopped", scope: "admission", since: hours(now, -200), environmentId: localEnvironment.id });
    const { service, notices } = notifier();
    expect(await service.notifyImmediate(stopped.episode, now)).toMatchObject({ issueNotice: false });
    expect(await service.notifyLong(stopped.episode, now)).toMatchObject({ issueNotice: false });
    await db.update(resourceWaitEpisodes).set({ resolvedAt: now, resolution: "resolved" }).where(eq(resourceWaitEpisodes.id, stopped.episode.id));
    expect(await service.notifyResolved(await episode(stopped.episode.id), now)).toBe(false);

    const [task2] = await db.insert(issues).values({ companyId, title: "Task 2", status: "in_progress", priority: "medium", assigneeAgentId: worker.id }).returning();
    const notified = await waiting({ agent: worker, issueId: task2!.id, kind: "device_slots", reason: "slots_full", scope: "device", since: hours(now, -3), deviceId: randomUUID() });
    await service.notifyImmediate(notified.episode, now);
    await db.update(resourceWaitEpisodes).set({ resolvedAt: now, resolution: "resolved" }).where(eq(resourceWaitEpisodes.id, notified.episode.id));
    expect(await service.notifyResolved(await episode(notified.episode.id), now)).toBe(true);
    expect(await service.notifyResolved(await episode(notified.episode.id), now)).toBe(false);
    expect(notices.map((notice) => notice.body)).toEqual([
      expect.stringContaining("Waiting for an account slot"),
      "Started after waiting 3 h.",
    ]);
  });

  it("wakes the PM about full slots unless it would need a new slot on that device too", async () => {
    const now = new Date();
    const companyId = await company();
    await member(companyId, "owner-1");
    const ssh = (await db.insert(environments).values({ name: "Runner", driver: "ssh", config: { host: "runner.invalid", port: 22, username: "runner" } }).returning())[0]!;
    const [device] = await db.insert(aiAccountHosts).values({ name: "SSH · Runner", kind: "ssh_host", externalKey: "ssh:runner.invalid:22", maxAccounts: 1 }).returning();
    // The PM runs on the same device, on the device's own login.
    const lead = await agent(companyId, { name: "Lead", defaultEnvironmentId: ssh.id });
    const worker = await agent(companyId, { reportsTo: lead.id, defaultEnvironmentId: ssh.id });
    const slotWait = async (sinceHours: number) => {
      const [task] = await db.insert(issues).values({ companyId, title: `Task ${tag()}`, status: "in_progress", priority: "medium", assigneeAgentId: worker.id }).returning();
      const waitingAccount = await account("owner-1");
      return (await waiting({
        agent: worker, issueId: task!.id, kind: "device_slots", reason: "slots_full", scope: "device",
        since: hours(now, -sinceHours), deviceId: device!.id, environmentId: ssh.id, accountId: waitingAccount.id,
      })).episode;
    };
    const first = notifier();
    expect(await first.service.notifyImmediate(await slotWait(1), now)).toMatchObject({ issueNotice: true, pmWake: true });
    expect(first.wakes.map((wake) => wake.agentId)).toEqual([lead.id]);

    // Bound to an account that already runs there: full slots do not block it either.
    const running = await account("owner-1");
    await db.insert(aiAccountAgentBindings).values({ agentId: lead.id, companyId, mode: "pool_account", accountId: running.id });
    const [busy] = await db.insert(heartbeatRuns).values({ companyId, agentId: lead.id, status: "running", startedAt: now }).returning();
    await db.insert(aiAccountRunSlots).values({ runId: busy!.id, companyId, deviceId: device!.id, accountId: running.id });
    expect(await notifier().service.notifyImmediate(await slotWait(2), now)).toMatchObject({ pmWake: true });

    // Bound to an account that would need a new slot: the PM would only wait too.
    const idle = await account("owner-1");
    await db.update(aiAccountAgentBindings).set({ accountId: idle.id }).where(eq(aiAccountAgentBindings.agentId, lead.id));
    expect(await notifier().service.notifyImmediate(await slotWait(3), now)).toMatchObject({ issueNotice: true, pmWake: false });
  });

  it("the notify pass picks long waits past their company's threshold only, so waits that are not due never crowd out due ones", async () => {
    const now = new Date();
    const patient = await company();
    const never = await company();
    const usual = await company();
    await db.insert(executionWaitSettings).values([
      { companyId: patient, notifyAfterHours: 168 },
      { companyId: never, notifyAfterHours: 0 },
    ]);
    for (const [companyId, hoursAgo] of [[patient, 100], [never, 90], [usual, 30]] as const) {
      const worker = await agent(companyId);
      const [task] = await db.insert(issues).values({ companyId, title: "Task", status: "in_progress", priority: "medium", assigneeAgentId: worker.id }).returning();
      await waiting({ agent: worker, issueId: task!.id, kind: "environment", reason: "offline", scope: "target", since: hours(now, -hoursAgo), environmentId: localEnvironment.id });
    }
    const { service, notices } = notifier();
    // One candidate per pass: the due wait comes first although two older ones exist.
    expect(await service.runNotifyPass({ now, limit: 1 })).toEqual({ immediate: 0, long: 1 });
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toContain("for **1 d 6 h**");
    expect(await service.runNotifyPass({ now, limit: 1 })).toEqual({ immediate: 0, long: 0 });
  });

  it("the sweep's notify pass sends missed immediate notices and due long notices, and skips ended runs", async () => {
    const now = new Date();
    const companyId = await company();
    await member(companyId, "owner-1");
    const worker = await agent(companyId);
    const pool = await account("owner-1", { status: "disabled" });
    const [task] = await db.insert(issues).values({ companyId, title: "Task", status: "in_progress", priority: "medium", assigneeAgentId: worker.id }).returning();
    await waiting({ agent: worker, issueId: task!.id, kind: "ai_account", reason: "withdrawn", scope: "account", since: now, accountId: pool.id });
    const [task2] = await db.insert(issues).values({ companyId, title: "Task 2", status: "in_progress", priority: "medium", assigneeAgentId: worker.id }).returning();
    await waiting({ agent: worker, issueId: task2!.id, kind: "environment", reason: "busy", scope: "admission", since: hours(now, -30), environmentId: localEnvironment.id });
    const [task3] = await db.insert(issues).values({ companyId, title: "Task 3", status: "in_progress", priority: "medium", assigneeAgentId: worker.id }).returning();
    await waiting({ agent: worker, issueId: task3!.id, kind: "ai_account", reason: "unassigned", scope: "account", since: now, accountId: null, runStatus: "cancelled" });
    const { service, notices } = notifier();
    expect(await service.runNotifyPass({ now })).toEqual({ immediate: 1, long: 1 });
    expect(notices).toHaveLength(2);
    expect(await service.runNotifyPass({ now })).toEqual({ immediate: 0, long: 0 });
  });
});
