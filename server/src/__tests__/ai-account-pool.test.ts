import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  aiAccountAgentBindings,
  aiAccountHosts,
  aiAccountProjects,
  aiAccounts,
  authUsers,
  companies,
  companyMemberships,
  costEvents,
  createDb,
  environments,
  heartbeatRuns,
  plugins,
  projects,
} from "@paperclipai/db";
import type { PluginEnvironmentTargetReport } from "@paperclipai/plugin-sdk";
import { AI_CREDENTIAL_REF_PATTERN } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  aiAccountPoolService,
  assertAccountPoolAllowsManagedBinding,
  checkAccountBinding,
  isCompanyAdmin,
  maskEmail,
  mayChangeBinding,
  mayEditBinding,
  poolPlacementOf,
  recheckDeviceLimits,
  type PoolActor,
  type PoolContext,
} from "../services/ai-account-pool.js";
import { credentialHint, credentialRefForAccount } from "../services/ai-account-credentials.js";
import { deviceForEnvironment, upsertPluginTargetByTargetKey } from "../services/execution-devices.js";
import { readWakeEpochs } from "../services/resource-waits/epochs.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";

function board(userId: string, memberships: Array<[string, string]> = [], extra: Partial<PoolActor> = {}): PoolActor {
  return {
    type: "board",
    source: "session",
    userId,
    companyIds: memberships.map(([companyId]) => companyId),
    memberships: memberships.map(([companyId, membershipRole]) => ({ companyId, membershipRole, status: "active" })),
    isInstanceAdmin: false,
    ...extra,
  };
}

describe("account pool permissions (spec 5.1, D4)", () => {
  const agentActor: PoolActor = { type: "agent", agentId: "agent-1" };
  const localBoard: PoolActor = { type: "board", source: "local_implicit", userId: "local-board", isInstanceAdmin: true };

  it("counts local_implicit, owner and admin roles, and instance admins with company access as company admins", () => {
    expect(isCompanyAdmin(localBoard, COMPANY)).toBe(true);
    expect(isCompanyAdmin(board("u", [[COMPANY, "owner"]]), COMPANY)).toBe(true);
    expect(isCompanyAdmin(board("u", [[COMPANY, "admin"]]), COMPANY)).toBe(true);
    expect(isCompanyAdmin(board("u", [[COMPANY, "operator"]]), COMPANY)).toBe(false);
    expect(isCompanyAdmin(board("u", [[COMPANY, "viewer"]]), COMPANY)).toBe(false);
    // An instance admin is a company admin only where they have company access, whatever the role.
    expect(isCompanyAdmin(board("u", [[COMPANY, "viewer"]], { isInstanceAdmin: true }), COMPANY)).toBe(true);
    expect(isCompanyAdmin(board("u", [], { isInstanceAdmin: true }), COMPANY)).toBe(false);
    expect(isCompanyAdmin(agentActor, COMPANY)).toBe(false);
  });

  it("lets an owner bind their own account only over an unbound, device-login, empty or own binding", () => {
    const owner = board("owner", [[COMPANY, "operator"]]);
    const own = { mode: "pool_account" as const, accountId: "a", accountOwnerId: "owner" };
    const others = { mode: "pool_account" as const, accountId: "b", accountOwnerId: "someone" };
    const bindOwn = { mode: "pool_account" as const, accountOwnerId: "owner" };
    expect(mayChangeBinding(owner, COMPANY, null, bindOwn)).toBe(true);
    expect(mayChangeBinding(owner, COMPANY, { mode: "device_login", accountId: null, accountOwnerId: null }, bindOwn)).toBe(true);
    expect(mayChangeBinding(owner, COMPANY, { mode: "pool_account", accountId: null, accountOwnerId: null }, bindOwn)).toBe(true);
    expect(mayChangeBinding(owner, COMPANY, own, bindOwn)).toBe(true);
    expect(mayChangeBinding(owner, COMPANY, others, bindOwn)).toBe(false);
    expect(mayChangeBinding(owner, COMPANY, null, { mode: "pool_account", accountOwnerId: "someone" })).toBe(false);
    // The device login and removal only while the agent is on one of the owner's accounts.
    expect(mayChangeBinding(owner, COMPANY, own, { mode: "device_login" })).toBe(true);
    expect(mayChangeBinding(owner, COMPANY, own, { mode: "clear" })).toBe(true);
    expect(mayChangeBinding(owner, COMPANY, null, { mode: "device_login" })).toBe(false);
    expect(mayChangeBinding(owner, COMPANY, others, { mode: "clear" })).toBe(false);
    // Viewers and agents never; admins always.
    expect(mayChangeBinding(board("owner", [[COMPANY, "viewer"]]), COMPANY, null, bindOwn)).toBe(false);
    expect(mayChangeBinding(agentActor, COMPANY, null, bindOwn)).toBe(false);
    expect(mayChangeBinding(board("admin", [[COMPANY, "admin"]]), COMPANY, others, { mode: "device_login" })).toBe(true);
    expect(mayEditBinding(owner, COMPANY, others)).toBe(false);
    expect(mayEditBinding(owner, COMPANY, own)).toBe(true);
    expect(mayEditBinding(owner, COMPANY, null)).toBe(true);
    expect(mayEditBinding(board("viewer", [[COMPANY, "viewer"]]), COMPANY, null)).toBe(false);
  });

  it("refuses new company pools, and routers for Claude agents only", () => {
    expect(() => assertAccountPoolAllowsManagedBinding({ mode: "company_pool" }, "claude_local")).toThrow(/retired/);
    expect(() => assertAccountPoolAllowsManagedBinding({ mode: "company_pool" }, "codex_local")).toThrow(/retired/);
    expect(() => assertAccountPoolAllowsManagedBinding({ mode: "router" }, "claude_local")).toThrow(/router/);
    expect(() => assertAccountPoolAllowsManagedBinding({ mode: "router" }, "codex_local")).not.toThrow();
    expect(() => assertAccountPoolAllowsManagedBinding({ mode: "responsible_user" }, "claude_local")).not.toThrow();
  });

  it("derives the credential marker and masks e-mails", () => {
    const ref = credentialRefForAccount("6f1e7c9a-3b2d-4c5e-8f90-1a2b3c4d5e6f");
    expect(ref).toMatch(AI_CREDENTIAL_REF_PATTERN);
    expect(ref).toBe(createHash("sha256").update("paperclip-ai-account:6f1e7c9a-3b2d-4c5e-8f90-1a2b3c4d5e6f").digest("hex").slice(0, 16));
    expect(credentialHint("sk-ant-oat01-abcdefghij")).toBe("…ghij");
    expect(maskEmail("alice@example.com")).toBe("al•••@example.com");
    expect(maskEmail(null)).toBeNull();
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping embedded Postgres account pool tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

const sub = (tag: string) => `sk-ant-oat01-${tag.padEnd(40, "x")}`;

describeEmbeddedPostgres("account pool service (database)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let pool: ReturnType<typeof aiAccountPoolService>;
  let localEnvironment: typeof environments.$inferSelect;

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "a".repeat(64));
    database = await startEmbeddedPostgresTestDatabase("paperclip-ai-account-pool-");
    db = createDb(database.connectionString);
    pool = aiAccountPoolService(db, { deploymentMode: "authenticated" });
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await database?.cleanup();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate table companies, plugins, ai_account_hosts, ai_accounts, environments, "user" cascade`);
    [localEnvironment] = await db.insert(environments).values({ name: "Local", driver: "local" }).returning();
  });

  const tag = () => randomUUID().slice(0, 8);

  async function company(name = `Company ${tag()}`) {
    const id = randomUUID();
    await db.insert(companies).values({ id, name, issuePrefix: `C${id.replaceAll("-", "").slice(0, 7).toUpperCase()}` });
    return id;
  }

  async function user(id: string) {
    const at = new Date();
    await db.insert(authUsers).values({ id, name: `User ${id}`, email: `${id}@example.com`, emailVerified: true, createdAt: at, updatedAt: at });
    return id;
  }

  async function member(companyId: string, userId: string, membershipRole = "operator") {
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole });
  }

  async function agent(companyId: string, overrides: Partial<typeof agents.$inferInsert> = {}) {
    const [row] = await db.insert(agents).values({ companyId, name: `Agent ${tag()}`, adapterType: "claude_local", ...overrides }).returning();
    return row!;
  }

  async function sshEnvironment(host = `runner-${tag()}.example.com`) {
    const [row] = await db.insert(environments).values({ name: `ssh ${tag()}`, driver: "ssh", config: { host, port: 22, username: "runner" } }).returning();
    return row!;
  }

  async function account(ownerUserId: string | null, overrides: Partial<typeof aiAccounts.$inferInsert> = {}) {
    const [row] = await db.insert(aiAccounts).values({
      credentialType: "subscription",
      label: `Account ${tag()}`,
      ownerUserId,
      createdByUserId: ownerUserId,
      credentialMaterial: { scheme: "local_encrypted_v1", ciphertext: tag() },
      credentialFingerprint: randomUUID(),
      ...overrides,
    }).returning();
    return row!;
  }

  async function bind(agentRow: { id: string; companyId: string }, accountId: string | null, mode: "pool_account" | "device_login" = "pool_account") {
    await db.insert(aiAccountAgentBindings).values({ agentId: agentRow.id, companyId: agentRow.companyId, mode, accountId });
  }

  async function waitingRun(agentRow: { id: string; companyId: string }, resourceWait: Record<string, unknown>) {
    const dueAt = new Date(Date.now() + 60 * 60_000);
    const [row] = await db.insert(heartbeatRuns).values({
      companyId: agentRow.companyId,
      agentId: agentRow.id,
      status: "scheduled_retry",
      scheduledRetryReason: "ai_account_wait",
      scheduledRetryAt: dueAt,
      contextSnapshot: { resourceWait: { version: 1, episodeId: randomUUID(), kind: "ai_account", ...resourceWait } },
    }).returning();
    return row!;
  }

  async function dueAtOf(runId: string) {
    const [row] = await db.select({ scheduledRetryAt: heartbeatRuns.scheduledRetryAt }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    return row!.scheduledRetryAt!.getTime();
  }

  function ctx(actor: PoolActor): PoolContext {
    return { actor, audit: { actorType: actor.type === "agent" ? "agent" : "user", actorId: actor.userId ?? actor.agentId ?? "board" } };
  }

  async function sandboxTarget(provider: string, opts: { ownerUserId?: string; acceptedCredentialTypes?: Array<"subscription" | "api_key"> } = {}) {
    const pluginKey = `test.${provider}.${tag()}`;
    const [plugin] = await db.insert(plugins).values({
      pluginKey,
      packageName: pluginKey,
      version: "1.0.0",
      status: "ready",
      manifestJson: { id: pluginKey, displayName: provider, environmentDrivers: [{ driverKey: provider, kind: "sandbox_provider", displayName: provider }] } as never,
    }).returning();
    const target = {
      targetKey: "d-1",
      label: "Build box",
      configMatch: { deviceId: "d-1" },
      state: "available",
      acceptedCredentialTypes: opts.acceptedCredentialTypes ?? ["subscription"],
      ...(opts.ownerUserId ? { ownerUserId: opts.ownerUserId } : {}),
    } as PluginEnvironmentTargetReport;
    const { device } = await upsertPluginTargetByTargetKey(db, { pluginId: plugin!.id, provider, target });
    const [environment] = await db.insert(environments).values({ name: `sandbox ${tag()}`, driver: "sandbox", config: { provider, deviceId: "d-1" } }).returning();
    return { device, environment: environment! };
  }

  describe("binding checks (spec 5.3 steps 3-7)", () => {
    it("binds on the Local environment's server device and on a device another user owns", async () => {
      const companyId = await company();
      await user("owner");
      await user("someone-else");
      await member(companyId, "owner");
      const x = await account("owner");
      const local = await agent(companyId, { defaultEnvironmentId: localEnvironment.id });
      const localCheck = await checkAccountBinding(db, { agent: poolPlacementOf(local), account: x });
      expect(localCheck.ok).toBe(true);
      if (localCheck.ok) expect(localCheck.devices.map((device) => [device.kind, device.externalKey])).toEqual([["server", "local"]]);

      const { device, environment } = await sandboxTarget("box", { ownerUserId: "someone-else" });
      expect(device.ownerUserId).toBe("someone-else");
      const remote = await agent(companyId, { defaultEnvironmentId: environment.id });
      const remoteCheck = await checkAccountBinding(db, { agent: poolPlacementOf(remote), account: x });
      expect(remoteCheck.ok).toBe(true);
    });

    it("refuses an unmapped environment as device_unknown and an unaccepted credential type", async () => {
      const companyId = await company();
      await user("owner");
      await member(companyId, "owner");
      const apiKey = await account("owner", { credentialType: "api_key" });
      const [orphan] = await db.insert(environments).values({ name: "Orphan sandbox", driver: "sandbox", config: { provider: "nobody" } }).returning();
      const unmapped = await agent(companyId, { defaultEnvironmentId: orphan!.id });
      const unknown = await checkAccountBinding(db, { agent: poolPlacementOf(unmapped), account: apiKey });
      expect(unknown).toMatchObject({ ok: false, failure: { code: "ai_account_incompatible", reason: "device_unknown", environmentName: "Orphan sandbox" } });

      const { environment } = await sandboxTarget("box", { acceptedCredentialTypes: ["subscription"] });
      const boxed = await agent(companyId, { defaultEnvironmentId: environment.id });
      const unsupported = await checkAccountBinding(db, { agent: poolPlacementOf(boxed), account: apiKey });
      expect(unsupported).toMatchObject({ ok: false, failure: { code: "ai_account_incompatible", reason: "credential_type_unsupported", deviceName: "Build box" } });
    });

    it("applies eligibility: owner membership, reservations, switched off and signed out", async () => {
      const companyId = await company();
      const otherCompanyId = await company();
      await user("owner");
      await user("outsider");
      await member(companyId, "owner");
      const target = await agent(companyId, { defaultEnvironmentId: localEnvironment.id });
      const placement = poolPlacementOf(target);
      const check = async (row: typeof aiAccounts.$inferSelect, newSelection = true) =>
        checkAccountBinding(db, { agent: placement, account: row, newSelection, deploymentMode: "authenticated" });

      expect(await check(await account("outsider"))).toMatchObject({ ok: false, failure: { code: "ai_account_not_eligible", reason: "owner_not_member" } });
      const reserved = await account("owner");
      const [elsewhere] = await db.insert(projects).values({ companyId: otherCompanyId, name: "Elsewhere" }).returning();
      await db.insert(aiAccountProjects).values({ accountId: reserved.id, projectId: elsewhere!.id });
      expect(await check(reserved)).toMatchObject({ ok: false, failure: { code: "ai_account_not_eligible", reason: "reserved_elsewhere" } });
      expect(await check(await account("owner", { status: "disabled" }))).toMatchObject({ ok: false, failure: { reason: "account_disabled" } });
      expect(await check(await account("owner", { adminDisabledAt: new Date() }))).toMatchObject({ ok: false, failure: { reason: "account_disabled" } });
      const signedOut = await account("owner", { status: "auth_failed" });
      expect(await check(signedOut)).toMatchObject({ ok: false, failure: { reason: "account_signed_out" } });
      expect((await check(signedOut, false)).ok).toBe(true);
      const limited = await account("owner", { exhaustedUntil: new Date(Date.now() + 60_000), limitReason: "provider_quota" });
      expect(await check(limited)).toMatchObject({ ok: true, warnings: ["usage_limit"] });
    });

    it("caps a device at three accounts across companies, and honours in-memory bound sets", async () => {
      const companyA = await company();
      const companyB = await company();
      for (const id of ["a1", "a2", "b1", "b2"]) await user(id);
      await member(companyA, "a1");
      await member(companyA, "a2");
      await member(companyB, "b1");
      await member(companyB, "b2");
      const ssh = await sshEnvironment();
      const accounts = { a1: await account("a1"), a2: await account("a2"), b1: await account("b1"), b2: await account("b2") };
      await bind(await agent(companyB, { defaultEnvironmentId: ssh.id }), accounts.b1.id);
      await bind(await agent(companyB, { defaultEnvironmentId: ssh.id }), accounts.b2.id);
      await bind(await agent(companyA, { defaultEnvironmentId: ssh.id }), accounts.a1.id);
      const newcomer = await agent(companyA, { defaultEnvironmentId: ssh.id });
      const full = await checkAccountBinding(db, { agent: poolPlacementOf(newcomer), account: accounts.a2 });
      expect(full).toMatchObject({ ok: false, failure: { code: "device_account_limit", limit: 3 } });
      // An account already on the device takes no new slot.
      expect((await checkAccountBinding(db, { agent: poolPlacementOf(newcomer), account: accounts.a1 })).ok).toBe(true);
      // A migration passes its own sets in processing order.
      const device = (await deviceForEnvironment(db, ssh))!;
      expect((await checkAccountBinding(db, { agent: poolPlacementOf(newcomer), account: accounts.a2, boundAccounts: new Map([[device.id, new Set([accounts.a1.id])]]) })).ok).toBe(true);
    });
  });

  describe("placement (spec 5.6)", () => {
    async function fullDevice() {
      const companyId = await company();
      for (const id of ["o1", "o2", "o3", "o4", "o5"]) {
        await user(id);
        await member(companyId, id);
      }
      const crowded = await sshEnvironment("crowded.example.com");
      const quiet = await sshEnvironment("quiet.example.com");
      const [a1, a2, a3, a4] = [await account("o1"), await account("o2"), await account("o3"), await account("o4")];
      await bind(await agent(companyId, { defaultEnvironmentId: crowded.id }), a1.id);
      await bind(await agent(companyId, { defaultEnvironmentId: crowded.id }), a2.id);
      const mover1 = await agent(companyId, { defaultEnvironmentId: quiet.id });
      const mover2 = await agent(companyId, { defaultEnvironmentId: quiet.id });
      await bind(mover1, a3.id);
      await bind(mover2, a4.id);
      return { companyId, crowded, quiet, mover1, mover2, a3, a4 };
    }

    it("lets exactly one of two concurrent moves onto a full device through", async () => {
      const { companyId, crowded, mover1, mover2 } = await fullDevice();
      const admin = board("admin", [[companyId, "admin"]]);
      const move = (row: typeof mover1) => pool.savePlacement(admin, row, { defaultEnvironmentId: crowded.id }, async (executor) => {
        await executor.update(agents).set({ defaultEnvironmentId: crowded.id }).where(eq(agents.id, row.id));
        return row.id;
      });
      const results = await Promise.allSettled([move(mover1), move(mover2)]);
      const refused = results.filter((result) => result.status === "rejected");
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({ status: 409, details: { code: "device_account_limit" } });
    });

    it("refuses a stale move as placement_conflict, an agent moving itself, and a member who does not own the account", async () => {
      const { companyId, crowded, quiet, mover1 } = await fullDevice();
      const admin = board("admin", [[companyId, "admin"]]);
      const stale = { ...mover1, defaultEnvironmentId: crowded.id };
      await expect(pool.savePlacement(admin, stale, { defaultEnvironmentId: quiet.id }, async () => "saved"))
        .rejects.toMatchObject({ status: 409, details: { code: "placement_conflict" } });
      await expect(pool.savePlacement({ type: "agent", agentId: mover1.id }, mover1, { defaultEnvironmentId: localEnvironment.id }, async () => "saved"))
        .rejects.toMatchObject({ status: 403, details: { code: "ai_account_binding_forbidden" } });
      await expect(pool.savePlacement(board("o1", [[companyId, "operator"]]), mover1, { defaultEnvironmentId: localEnvironment.id }, async () => "saved"))
        .rejects.toMatchObject({ status: 403 });
      // The account's owner may move it; the move wakes the agent's waits.
      const waiting = await waitingRun(mover1, { reason: "unassigned" });
      expect(await pool.savePlacement(board("o3", [[companyId, "operator"]]), mover1, { defaultEnvironmentId: localEnvironment.id }, async () => "saved")).toBe("saved");
      expect(await dueAtOf(waiting.id)).toBeLessThanOrEqual(Date.now());
      // No move, no lock: the save runs as it is.
      expect(await pool.savePlacement({ type: "agent", agentId: mover1.id }, mover1, { name: "Renamed" }, async () => "plain")).toBe("plain");
    });

    it("checks and writes a pool-bound hire's environment before approval activates it", async () => {
      const { companyId, crowded, a3 } = await fullDevice();
      const pending = await agent(companyId, { status: "pending_approval" });
      await bind(pending, a3.id);
      await db.insert(aiAccountAgentBindings).values({ agentId: (await agent(companyId, { defaultEnvironmentId: crowded.id })).id, companyId, mode: "pool_account", accountId: (await account("o5")).id });
      const approval = { companyId, type: "hire_agent", status: "pending", payload: { agentId: pending.id, defaultEnvironmentId: crowded.id } };
      await expect(pool.placeHireForApproval(board("admin", [[companyId, "admin"]]), approval, undefined))
        .rejects.toMatchObject({ status: 409, details: { code: "device_account_limit" } });
      await pool.placeHireForApproval(board("admin", [[companyId, "admin"]]), approval, localEnvironment.id);
      const [row] = await db.select({ defaultEnvironmentId: agents.defaultEnvironmentId }).from(agents).where(eq(agents.id, pending.id));
      expect(row!.defaultEnvironmentId).toBe(localEnvironment.id);
    });

    it("leaves the environment of a hire without a pool account to activation", async () => {
      const { companyId, crowded } = await fullDevice();
      const admin = board("admin", [[companyId, "admin"]]);
      const unbound = await agent(companyId, { status: "pending_approval" });
      const emptyBinding = await agent(companyId, { status: "pending_approval" });
      await bind(emptyBinding, null);
      for (const pending of [unbound, emptyBinding]) {
        const approval = { companyId, type: "hire_agent", status: "pending", payload: { agentId: pending.id } };
        await pool.placeHireForApproval(admin, approval, crowded.id);
        const [row] = await db.select({ defaultEnvironmentId: agents.defaultEnvironmentId }).from(agents).where(eq(agents.id, pending.id));
        expect(row!.defaultEnvironmentId).toBeNull();
      }
      expect(await pool.assertPlacementAndWriteEnvironment(admin, unbound, crowded.id)).toBe(false);
    });

    it("moves the binding's updated_at and the old environment's wake epoch on a move", async () => {
      const { companyId, quiet, mover1 } = await fullDevice();
      const admin = board("admin", [[companyId, "admin"]]);
      const deviceLogin = await agent(companyId, { defaultEnvironmentId: quiet.id });
      await bind(deviceLogin, null, "device_login");
      for (const moving of [mover1, deviceLogin]) {
        // The rows the lost-wake guard of a deferral racing the move reads.
        const before = await readWakeEpochs(db, { environmentId: quiet.id, agentId: moving.id });
        await pool.savePlacement(admin, moving, { defaultEnvironmentId: localEnvironment.id }, async (executor) => {
          await executor.update(agents).set({ defaultEnvironmentId: localEnvironment.id }).where(eq(agents.id, moving.id));
        });
        const after = await readWakeEpochs(db, { environmentId: quiet.id, agentId: moving.id });
        expect(after.bindingUpdatedAt! > before.bindingUpdatedAt!).toBe(true);
        expect(after.environmentEpoch!).toBeGreaterThan(before.environmentEpoch!);
      }
    });

    it("flags a device that a project default pushes over its limit and tells the company", async () => {
      const companyId = await company();
      for (const id of ["p1", "p2", "p3", "p4"]) {
        await user(id);
        await member(companyId, id);
      }
      const ssh = await sshEnvironment("shared.example.com");
      await deviceForEnvironment(db, ssh);
      const pinned: Array<typeof agents.$inferSelect> = [];
      for (const id of ["p1", "p2", "p3"]) {
        const row = await agent(companyId, { defaultEnvironmentId: ssh.id });
        await bind(row, (await account(id)).id);
        pinned.push(row);
      }
      // An unpinned agent follows the project default onto the same device.
      await bind(await agent(companyId), (await account("p4")).id);
      expect((await recheckDeviceLimits(db)).filter((check) => check.change === "flagged")).toHaveLength(0);
      await db.insert(projects).values({ companyId, name: "Moved", defaultEnvironmentId: ssh.id });
      const flagged = (await recheckDeviceLimits(db)).filter((check) => check.change === "flagged");
      expect(flagged).toHaveLength(1);
      expect(flagged[0]).toMatchObject({ inUse: 4, limit: 3, companyIds: [companyId] });
      const [device] = await db.select().from(aiAccountHosts).where(eq(aiAccountHosts.id, flagged[0]!.deviceId));
      expect(device!.overLimitAt).not.toBeNull();
      const notices = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "execution_device.over_limit")));
      expect(notices).toHaveLength(1);
      // Removing a binding that frees a slot clears the flag, so a later overflow is noticed again.
      await pool.clearBinding(ctx(board("admin", [[companyId, "admin"]])), pinned[0]!.id);
      const [cleared] = await db.select().from(aiAccountHosts).where(eq(aiAccountHosts.id, flagged[0]!.deviceId));
      expect(cleared!.overLimitAt).toBeNull();
    });
  });

  describe("accounts", () => {
    it("stores the token encrypted and nowhere else, and audits only in the owner's companies", async () => {
      const mine = await company();
      const theirs = await company();
      await user("owner");
      await member(mine, "owner");
      const token = sub(`secret-${tag()}`);
      const owner = board("owner", [[mine, "operator"]]);
      const created = await pool.create(ctx(owner), { label: "Max", credentialType: "subscription", value: token, emailHint: "max@example.com" });
      expect(JSON.stringify(created)).not.toContain(token);
      expect(created).toMatchObject({ label: "Max", state: "active", origin: "pool", credentialHint: `…${token.slice(-4)}` });
      const [row] = await db.select().from(aiAccounts).where(eq(aiAccounts.id, created.id));
      expect(row).toMatchObject({ ownerUserId: "owner", createdByUserId: "owner", hostId: null });

      await pool.replaceCredential(ctx(owner), created.id, { value: sub(`second-${tag()}`) });
      const dump = await db.execute(sql`select string_agg(t::text, ' ') as all_rows from (
        select row_to_json(a)::text as t from ai_accounts a
        union all select row_to_json(l)::text from activity_log l
        union all select row_to_json(b)::text from ai_account_agent_bindings b
      ) rows`);
      expect(String((dump as unknown as Array<{ all_rows: string | null }>)[0]?.all_rows ?? "")).not.toContain(token);

      const entries = await db.select().from(activityLog).where(eq(activityLog.entityId, created.id));
      expect(entries.map((entry) => entry.companyId)).toEqual([mine, mine]);
      expect(entries.every((entry) => entry.companyId !== theirs)).toBe(true);
      expect(entries.map((entry) => entry.action).sort()).toEqual(["ai_account.created", "ai_account.credential_replaced"]);
      expect(entries[0]!.details).toMatchObject({ accountLabel: "Max" });
    });

    it("refuses a duplicate credential or e-mail with a generic 409", async () => {
      const companyId = await company();
      await user("one");
      await user("two");
      await member(companyId, "one");
      await member(companyId, "two");
      const token = sub(`dup-${tag()}`);
      await pool.create(ctx(board("one", [[companyId, "operator"]])), { label: "A", credentialType: "subscription", value: token, emailHint: "Shared@Example.com" });
      const duplicate = await pool.create(ctx(board("two", [[companyId, "operator"]])), { label: "B", credentialType: "subscription", value: token }).catch((error: unknown) => error);
      expect(duplicate).toMatchObject({ status: 409, details: { code: "ai_account_duplicate" } });
      expect(String((duplicate as Error).message)).not.toContain("one");
      // E-mail hints are unique per owner only.
      await pool.create(ctx(board("two", [[companyId, "operator"]])), { label: "C", credentialType: "subscription", value: sub(`c-${tag()}`), emailHint: "shared@example.com" });
      await expect(pool.create(ctx(board("one", [[companyId, "operator"]])), { label: "D", credentialType: "subscription", value: sub(`d-${tag()}`), emailHint: "SHARED@example.com" }))
        .rejects.toMatchObject({ status: 409, details: { code: "ai_account_duplicate" } });
    });

    it("binds a legacy row and lets its owner resume a row the migration switched off", async () => {
      const companyId = await company();
      await user("legacy-owner");
      await member(companyId, "legacy-owner");
      const [host] = await db.insert(aiAccountHosts).values({ name: "Old host", kind: "ssh_host" }).returning();
      const legacy = await account("legacy-owner", { origin: "legacy_host_pool", hostId: host!.id, ownerUserId: null });
      const target = await agent(companyId, { defaultEnvironmentId: localEnvironment.id });
      const owner = board("legacy-owner", [[companyId, "operator"]]);
      const bound = await pool.setBinding(ctx(owner), target.id, { mode: "pool_account", accountId: legacy.id });
      expect(bound).toMatchObject({ state: "pool_account", appliesFrom: "next_run", account: { id: legacy.id, ownedByMe: true } });
      const listed = (await pool.listAll()).accounts.find((entry) => entry.id === legacy.id);
      expect(listed).toMatchObject({
        origin: "legacy_host_pool",
        legacyHostId: host!.id,
        legacyHostName: "Old host",
        owner: { userId: "legacy-owner", email: "legacy-owner@example.com" },
        companies: [{ companyId, agentCount: 1 }],
      });

      // Migration 0310 turned `pool_enabled = false` into `status = 'disabled'`.
      const parked = await account("legacy-owner", { origin: "legacy_host_pool", poolEnabled: false, status: "disabled" });
      const resumed = await pool.update(ctx(owner), parked.id, { status: "active" });
      expect(resumed).toMatchObject({ status: "active", state: "active" });
      const [row] = await db.select().from(aiAccounts).where(eq(aiAccounts.id, parked.id));
      expect(row).toMatchObject({ status: "active", poolEnabled: true });
      // A signed-out account comes back only with a new token.
      const signedOut = await account("legacy-owner", { status: "auth_failed" });
      await expect(pool.update(ctx(owner), signedOut.id, { status: "active" })).rejects.toMatchObject({ status: 422 });
    });

    it("wakes the account's waits and moves its updated_at on every change a wait can be waiting for", async () => {
      const companyId = await company();
      await user("owner");
      await user("admin");
      await member(companyId, "owner");
      const owner = board("owner", [[companyId, "operator"]]);
      const admin = board("admin", [], { isInstanceAdmin: true });
      const created = await pool.create(ctx(owner), { label: "Waker", credentialType: "subscription", value: sub(`w-${tag()}`) });
      const target = await agent(companyId);
      // The exact database text the lost-wake guard compares (microseconds).
      const updatedAtOf = async () => (await readWakeEpochs(db, { accountId: created.id })).accountUpdatedAt!;
      const [project] = await db.insert(projects).values({ companyId, name: "Reserved" }).returning();
      const changes: Array<[string, () => Promise<unknown>]> = [
        ["owner clears the limit", () => pool.clearLimit(ctx(owner), created.id)],
        ["owner replaces the token", () => pool.replaceCredential(ctx(owner), created.id, { value: sub(`w2-${tag()}`) })],
        ["owner resumes the account", async () => {
          await pool.update(ctx(owner), created.id, { status: "disabled" });
          return pool.update(ctx(owner), created.id, { status: "active" });
        }],
        ["owner clears the project restriction", async () => {
          await db.insert(aiAccountProjects).values({ accountId: created.id, projectId: project!.id });
          return pool.clearProjectRestriction(ctx(owner), created.id);
        }],
        ["admin clears the limit", () => pool.adminClearLimit(ctx(admin), created.id)],
        ["admin re-enables the account", async () => {
          await pool.setAdminDisabled(ctx(admin), created.id, { adminDisabled: true, reason: "Check" });
          return pool.setAdminDisabled(ctx(admin), created.id, { adminDisabled: false });
        }],
      ];
      for (const [change, run] of changes) {
        const waiting = await waitingRun(target, { reason: "usage_limit", accountId: created.id });
        const before = await updatedAtOf();
        await run();
        expect(await dueAtOf(waiting.id), change).toBeLessThanOrEqual(Date.now());
        expect(await updatedAtOf() > before, change).toBe(true);
      }
    });

    it("refuses to pause a signed-out account, so a later resume cannot bring back the rejected token", async () => {
      const companyId = await company();
      await user("owner");
      await member(companyId, "owner");
      const owner = board("owner", [[companyId, "operator"]]);
      const signedOut = await account("owner", { status: "auth_failed", statusMessage: "Invalid bearer token" });
      await expect(pool.update(ctx(owner), signedOut.id, { status: "disabled" }))
        .rejects.toMatchObject({ status: 422, message: "This account is signed out. Replace its token or remove it." });
      await expect(pool.update(ctx(owner), signedOut.id, { status: "active" })).rejects.toMatchObject({ status: 422 });
      const [row] = await db.select().from(aiAccounts).where(eq(aiAccounts.id, signedOut.id));
      expect(row).toMatchObject({ status: "auth_failed", statusMessage: "Invalid bearer token" });
      // Other edits still work, and a new token signs it back in.
      expect(await pool.update(ctx(owner), signedOut.id, { label: "Renamed" })).toMatchObject({ label: "Renamed", status: "auth_failed" });
      expect(await pool.replaceCredential(ctx(owner), signedOut.id, { value: sub(`fresh-${tag()}`) })).toMatchObject({ status: "active" });
    });

    it("transfers an account to an existing user, audits both owners' companies and wakes its waits", async () => {
      const oldCompany = await company();
      const newCompany = await company();
      await user("old-owner");
      await user("new-owner");
      await user("admin");
      await member(oldCompany, "old-owner");
      await member(newCompany, "new-owner");
      const created = await pool.create(ctx(board("old-owner", [[oldCompany, "operator"]])), {
        label: "Moving", credentialType: "subscription", value: sub(`t-${tag()}`), emailHint: "move@example.com",
      });
      const admin = board("admin", [], { isInstanceAdmin: true });
      await expect(pool.transferOwner(ctx(admin), created.id, "nobody")).rejects.toMatchObject({ status: 422 });
      const waiting = await waitingRun(await agent(oldCompany), { reason: "owner_not_member", accountId: created.id });
      const moved = await pool.transferOwner(ctx(admin), created.id, "new-owner");
      expect(moved.owner).toMatchObject({ userId: "new-owner" });
      expect(await dueAtOf(waiting.id)).toBeLessThanOrEqual(Date.now());
      const entries = await db.select().from(activityLog).where(and(eq(activityLog.entityId, created.id), eq(activityLog.action, "ai_account.owner_changed")));
      expect(entries.map((entry) => entry.companyId).sort()).toEqual([oldCompany, newCompany].sort());
      // Where the new owner is not a member, the entry does not name them.
      expect(entries.find((entry) => entry.companyId === oldCompany)!.details).not.toHaveProperty("newOwnerUserId");
      expect(entries.find((entry) => entry.companyId === newCompany)!.details).toMatchObject({ newOwnerUserId: "new-owner" });
      // The new owner already has that e-mail hint.
      const duplicate = await pool.create(ctx(board("old-owner", [[oldCompany, "operator"]])), {
        label: "Again", credentialType: "subscription", value: sub(`u-${tag()}`), emailHint: "MOVE@example.com",
      });
      await expect(pool.transferOwner(ctx(admin), duplicate.id, "new-owner")).rejects.toMatchObject({ status: 409, details: { code: "ai_account_duplicate" } });
    });

    it("audits a transfer between owners outside every company in the companies using the account, without names", async () => {
      const usingCompany = await company();
      const otherCompany = await company();
      await user("admin");
      await user("newcomer");
      const ownerless = await account(null, { origin: "legacy_host_pool", label: "Ownerless" });
      await bind(await agent(usingCompany), ownerless.id);
      const admin = board("admin", [], { isInstanceAdmin: true });
      const moved = await pool.transferOwner(ctx(admin), ownerless.id, "newcomer");
      expect(moved.owner).toMatchObject({ userId: "newcomer" });
      const entries = await db.select().from(activityLog).where(and(eq(activityLog.entityId, ownerless.id), eq(activityLog.action, "ai_account.owner_changed")));
      expect(entries.map((entry) => entry.companyId)).toEqual([usingCompany]);
      expect(entries[0]!.details).toEqual({});
      expect(entries.every((entry) => entry.companyId !== otherCompany)).toBe(true);
    });

    it("releases bindings when an account is removed, so the agents wait unassigned", async () => {
      const companyId = await company();
      await user("owner");
      await member(companyId, "owner");
      const owner = board("owner", [[companyId, "operator"]]);
      const created = await pool.create(ctx(owner), { label: "Leaving", credentialType: "subscription", value: sub(`r-${tag()}`) });
      const target = await agent(companyId, { defaultEnvironmentId: localEnvironment.id });
      await pool.setBinding(ctx(owner), target.id, { mode: "pool_account", accountId: created.id });
      await expect(pool.remove(ctx(owner), created.id)).rejects.toMatchObject({
        status: 409,
        details: { code: "ai_account_in_use", bindings: [{ agentId: target.id, companyId }], otherCompanies: 0 },
      });
      await pool.remove(ctx(owner), created.id, { release: true });
      const [binding] = await db.select().from(aiAccountAgentBindings).where(eq(aiAccountAgentBindings.agentId, target.id));
      expect(binding).toMatchObject({ mode: "pool_account", accountId: null });
      expect((await pool.getAgentBinding(ctx(owner), target.id)).state).toBe("unassigned");
    });

    it("binds through the service, wakes the agent's waits, and keeps running runs on their account", async () => {
      const companyId = await company();
      await user("owner");
      await member(companyId, "owner");
      const owner = board("owner", [[companyId, "operator"]]);
      const created = await pool.create(ctx(owner), { label: "Bound", credentialType: "subscription", value: sub(`b-${tag()}`) });
      const target = await agent(companyId, { defaultEnvironmentId: localEnvironment.id });
      const waiting = await waitingRun(target, { reason: "unassigned" });
      const [running] = await db.insert(heartbeatRuns).values({ companyId, agentId: target.id, status: "running" }).returning();
      const bound = await pool.setBinding(ctx(owner), target.id, { mode: "pool_account", accountId: created.id });
      expect(bound.runningRunIds).toEqual([running!.id]);
      // Usage counts the cost events of runs attributed to the account.
      const [poolRun] = await db.insert(heartbeatRuns).values({
        companyId, agentId: target.id, status: "succeeded",
        contextSnapshot: { aiConnection: { mode: "pool_account", accountId: created.id } },
      }).returning();
      await db.insert(costEvents).values({
        companyId, agentId: target.id, heartbeatRunId: poolRun!.id, provider: "anthropic", model: "claude", inputTokens: 10, outputTokens: 5, costCents: 7, occurredAt: new Date(),
      });
      const [mine] = (await pool.listMine(ctx(owner))).accounts;
      expect(mine!.usage.lastFiveHours).toMatchObject({ runs: 1, inputTokens: 10, outputTokens: 5, costCents: 7 });
      expect(mine!.usedBy).toEqual([expect.objectContaining({ companyId, agents: [expect.objectContaining({ agentId: target.id })] })]);
      expect(await dueAtOf(waiting.id)).toBeLessThanOrEqual(Date.now());
      const entries = await db.select().from(activityLog).where(and(eq(activityLog.entityId, target.id), eq(activityLog.action, "ai_account.binding_updated")));
      expect(entries).toHaveLength(1);
      expect(entries[0]!.companyId).toBe(companyId);
    });
  });
});
