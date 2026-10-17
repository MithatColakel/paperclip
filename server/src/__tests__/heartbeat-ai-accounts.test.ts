import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  aiAccountAgentBindings,
  aiAccountHosts,
  aiAccountProjects,
  aiAccountRunSlots,
  aiAccounts,
  aiConnectionQuotaStates,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  environments,
  heartbeatRuns,
  issues,
  plugins,
  projects,
  resourceWaitEpisodes,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import {
  AI_CREDENTIAL_REF_ENV_KEY,
  POOL_RUN_REMOVED_ENV_KEYS,
  readResourceWaitContext,
} from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createRunDispatch } from "../modules/run-dispatch/index.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { credentialRefForAccount } from "../services/ai-account-credentials.js";
import { pluginTargetKey } from "../services/execution-devices.js";
import {
  createHeartbeatAiAccounts,
  dropStaleAttribution,
  estimatedLimitMs,
  injectPoolCredential,
  previewCredentialPlan,
  projectSettingsConflicts,
  readBinding,
  type CompanyPoolRetryOptions,
  type CredentialPlanUse,
} from "../services/heartbeat-ai-accounts.js";
import {
  ConfigurationRefusal,
  ResourceWaitDeferral,
  accountWaitDeferral,
  createResourceWaits,
  resourceWaitJitterMs,
  type ResourceWaitDeps,
  type ResourceWaitIssueNotice,
  type ResourceWaitScheduleOptions,
} from "../services/resource-waits/index.js";

// Remote project-settings scans never leave this test: the target process runner is stubbed.
// With `shellHome` set, the scan script itself runs in a local `sh` with that HOME.
const remoteStub = vi.hoisted(() => ({
  calls: [] as Array<{ args: string[] }>,
  exitCodes: {} as Record<string, number>,
  shellHome: null as string | null,
}));
vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>();
  const { spawnSync } = await import("node:child_process");
  return {
    ...actual,
    runAdapterExecutionTargetProcess: async (_runId: string, _target: unknown, command: string, args: string[]) => {
      remoteStub.calls.push({ args });
      const name = args[2] ?? "";
      if (remoteStub.shellHome && name === "ai-pool-routing-check") {
        const result = spawnSync(command, args, { env: { HOME: remoteStub.shellHome, PATH: process.env.PATH ?? "/usr/bin:/bin" }, encoding: "utf8" });
        return { exitCode: result.status, signal: null, timedOut: false, stdout: "", stderr: "" };
      }
      return { exitCode: remoteStub.exitCodes[name] ?? 0, signal: null, timedOut: false, stdout: "", stderr: "" };
    },
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat AI account tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type AgentRow = typeof agents.$inferSelect;
type RunRow = typeof heartbeatRuns.$inferSelect;
type EnvironmentRow = typeof environments.$inferSelect;

const HOUR = 60 * 60 * 1000;
const TEST_MASTER_KEY = "ab".repeat(32);

describeEmbeddedPostgres("heartbeat AI accounts (database)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let localEnvironment: EnvironmentRow;
  let previousMasterKey: string | undefined;

  beforeAll(async () => {
    previousMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = TEST_MASTER_KEY;
    database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-ai-accounts-");
    db = createDb(database.connectionString);
  }, 120_000);

  afterAll(async () => {
    if (previousMasterKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY = previousMasterKey;
    // A checkpoint leaves the shutdown little to write, so the data directory goes in time.
    await db?.execute(sql`checkpoint`).catch(() => undefined);
    await database?.cleanup();
  });

  beforeEach(async () => {
    remoteStub.calls = [];
    remoteStub.exitCodes = {};
    remoteStub.shellHome = null;
    await db.execute(sql`truncate table companies, plugins, ai_account_hosts, ai_accounts, environments, "user" cascade`);
    [localEnvironment] = await db.insert(environments).values({ name: "Local", driver: "local" }).returning();
  });

  const tag = () => randomUUID().slice(0, 8);
  const at = (base: Date, ms: number) => new Date(base.getTime() + ms);

  async function company() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: `Company ${tag()}`, issuePrefix: `H${id.replaceAll("-", "").slice(0, 7).toUpperCase()}` });
    return id;
  }

  async function user(id = `user-${tag()}`) {
    const now = new Date();
    await db.insert(authUsers).values({ id, name: id, email: `${id}@example.com`, emailVerified: true, createdAt: now, updatedAt: now }).onConflictDoNothing();
    return id;
  }

  async function member(companyId: string, userId: string) {
    await user(userId);
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
  }

  async function agent(companyId: string, overrides: Partial<typeof agents.$inferInsert> = {}): Promise<AgentRow> {
    const [row] = await db.insert(agents).values({
      companyId,
      name: `Agent ${tag()}`,
      adapterType: "claude_local",
      status: "active",
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      ...overrides,
    }).returning();
    return row!;
  }

  async function account(ownerUserId: string, overrides: Partial<typeof aiAccounts.$inferInsert> = {}, value = `sk-ant-oat01-${tag()}${tag()}`) {
    const prepared = await localEncryptedProvider.createSecret({ value });
    const [row] = await db.insert(aiAccounts).values({
      credentialType: "subscription",
      label: `Max ${tag()}`,
      ownerUserId,
      createdByUserId: ownerUserId,
      credentialMaterial: prepared.material as Record<string, unknown>,
      credentialFingerprint: randomUUID(),
      ...overrides,
    }).returning();
    return row!;
  }

  async function bind(agentRow: AgentRow, accountId: string | null, mode: "pool_account" | "device_login" = "pool_account") {
    await db.insert(aiAccountAgentBindings).values({ agentId: agentRow.id, companyId: agentRow.companyId, mode, accountId })
      .onConflictDoUpdate({ target: aiAccountAgentBindings.agentId, set: { mode, accountId, updatedAt: new Date() } });
  }

  async function environment(driver: "ssh" | "sandbox", config: Record<string, unknown>): Promise<EnvironmentRow> {
    const [row] = await db.insert(environments).values({ name: `${driver} ${tag()}`, driver, config }).returning();
    return row!;
  }

  async function plugin(provider: string) {
    const pluginKey = `test.${provider}.${tag()}`;
    const [row] = await db.insert(plugins).values({
      pluginKey,
      packageName: pluginKey,
      version: "1.0.0",
      status: "ready",
      manifestJson: {
        id: pluginKey,
        displayName: `Plugin ${provider}`,
        environmentDrivers: [{ driverKey: provider, kind: "sandbox_provider", displayName: provider }],
      } as never,
    }).returning();
    return row!;
  }

  /** A plugin-reported device whose target runs the sandbox environments matching `{deviceId}`. */
  async function targetDevice(input: { pluginId: string; deviceKey: string; types: string[]; reportedAt: Date; ownerUserId?: string | null }) {
    const [row] = await db.insert(aiAccountHosts).values({
      name: `Device ${tag()}`,
      kind: "external",
      targetKey: pluginTargetKey(input.pluginId, "box", input.deviceKey),
      targetProvider: "box",
      targetMatch: { deviceId: input.deviceKey },
      managedByPluginId: input.pluginId,
      targetState: { state: "available", acceptedCredentialTypes: input.types },
      targetReportedAt: input.reportedAt,
      ownerUserId: input.ownerUserId ?? null,
      ownerSource: input.ownerUserId ? "plugin" : null,
    }).returning();
    return row!;
  }

  async function sshDevice(maxAccounts = 3) {
    const env = await environment("ssh", { host: `runner-${tag()}.invalid`, port: 22, username: "runner" });
    return { env, maxAccounts };
  }

  async function run(agentRow: AgentRow, overrides: Partial<typeof heartbeatRuns.$inferInsert> = {}): Promise<RunRow> {
    const [row] = await db.insert(heartbeatRuns).values({
      companyId: agentRow.companyId,
      agentId: agentRow.id,
      invocationSource: "automation",
      status: "running",
      startedAt: new Date(),
      contextSnapshot: {},
      ...overrides,
    }).returning();
    return row!;
  }

  async function runRow(id: string): Promise<RunRow> {
    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
    return row!;
  }

  async function accountRow(id: string) {
    const [row] = await db.select().from(aiAccounts).where(eq(aiAccounts.id, id));
    return row!;
  }

  function makeDeps() {
    const calls = {
      events: [] as Array<{ runId: string; message?: string; payload?: Record<string, unknown> }>,
      notices: [] as ResourceWaitIssueNotice[],
      scheduled: [] as Array<ResourceWaitScheduleOptions | CompanyPoolRetryOptions>,
    };
    const runDispatch = createRunDispatch(db);
    const scheduleBoundedRetryForRun = async (
      source: RunRow,
      _agent: AgentRow,
      opts: ResourceWaitScheduleOptions | CompanyPoolRetryOptions,
    ) => {
      calls.scheduled.push(opts);
      const issueId = typeof source.contextSnapshot?.issueId === "string" ? source.contextSnapshot.issueId : null;
      const contextPatch = "contextPatch" in opts ? opts.contextPatch : {};
      const [successor] = await db.insert(heartbeatRuns).values({
        companyId: source.companyId,
        agentId: source.agentId,
        invocationSource: "automation",
        status: "scheduled_retry",
        retryOfRunId: source.id,
        scheduledRetryAt: new Date(opts.now.getTime() + opts.delayMs),
        scheduledRetryAttempt: opts.maxAttempts,
        scheduledRetryReason: opts.retryReason,
        contextSnapshot: { ...source.contextSnapshot, retryReason: opts.retryReason, wakeReason: opts.wakeReason, ...contextPatch },
      }).returning();
      if (issueId) {
        await db.update(issues).set({ executionRunId: successor!.id })
          .where(and(eq(issues.id, issueId), eq(issues.executionRunId, source.id)));
      }
      return { outcome: "scheduled" as const, run: successor! };
    };
    const appendRunEvent = async (target: RunRow, event: { message?: string; payload?: Record<string, unknown> }) => {
      calls.events.push({ runId: target.id, message: event.message, payload: event.payload });
    };
    const waitDeps: ResourceWaitDeps = {
      async setRunStatusIfRunning(runId, status, patch) {
        const [row] = await db.update(heartbeatRuns).set({ ...patch, status, updatedAt: new Date() })
          .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "running"))).returning();
        return { run: row ?? null, updated: Boolean(row) };
      },
      async setWakeupStatus() {},
      async getRun(runId) {
        const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        return row ?? null;
      },
      async getAgent(agentId) {
        const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
        return row ?? null;
      },
      scheduleBoundedRetryForRun,
      appendRunEvent,
      async releaseIssueExecutionAndPromote() {},
      async finalizeAgentStatus() {},
      async enqueueWakeup() {
        return null;
      },
      async addIssueSystemNotice(input) {
        calls.notices.push(input);
        return null;
      },
      evaluateScheduledRetryGate: (input) => runDispatch.evaluateScheduledRetryGate(input),
    };
    return { calls, waitDeps, deps: { appendRunEvent, scheduleBoundedRetryForRun } };
  }

  function service(deps = makeDeps()) {
    const resourceWaits = createResourceWaits({
      db,
      deps: deps.waitDeps,
      environmentWaitsEnabled: true,
      random: () => 0.5,
      deploymentMode: "authenticated",
    });
    const accounts = createHeartbeatAiAccounts({ db, resourceWaits, deps: deps.deps, deploymentMode: "authenticated" });
    return { accounts, resourceWaits, calls: deps.calls };
  }

  /** A company with an owner who is a member, their account, and a pool-bound agent pinned to `env`. */
  async function poolFixture(input: { env?: EnvironmentRow; accountOverrides?: Partial<typeof aiAccounts.$inferInsert> } = {}) {
    const companyId = await company();
    const ownerId = await user();
    await member(companyId, ownerId);
    const pool = await account(ownerId, input.accountOverrides);
    const env = input.env ?? localEnvironment;
    const worker = await agent(companyId, { defaultEnvironmentId: env.id });
    await bind(worker, pool.id);
    return { companyId, ownerId, pool, env, worker };
  }

  async function plan(accounts: ReturnType<typeof service>["accounts"], input: { worker: AgentRow; env: EnvironmentRow | null; runRow?: RunRow; now?: Date }) {
    const target = input.runRow ?? await run(input.worker);
    const binding = await accounts.readBinding({ agent: input.worker, run: target });
    return accounts.planCredential({ run: target, agent: input.worker, binding, environment: input.env, epochs: binding.epochs, now: input.now });
  }

  async function expectWait(promise: Promise<unknown>) {
    const error = await promise.then(() => null, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ResourceWaitDeferral);
    return error as ResourceWaitDeferral;
  }

  async function expectRefusal(promise: Promise<unknown>) {
    const error = await promise.then(() => null, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ConfigurationRefusal);
    return error as ConfigurationRefusal;
  }

  // -------------------------------------------------------------------------

  describe("readBinding", () => {
    it("reads the fork row for claude_local agents only, and keeps a persisted native run on its own account", async () => {
      const { worker, pool } = await poolFixture();
      expect(await readBinding(db, { agent: worker })).toMatchObject({ source: "pool", mode: "pool_account", accountId: pool.id, persisted: null });
      await bind(worker, null, "device_login");
      expect(await readBinding(db, { agent: worker })).toMatchObject({ source: "device_login" });

      const other = await agent(worker.companyId, { adapterType: "codex_local" });
      await bind(other, pool.id);
      expect(await readBinding(db, { agent: other })).toMatchObject({ source: "none", mode: "pool_account" });

      const attribution = { mode: "pool_account", accountId: pool.id, hostId: randomUUID(), runId: randomUUID() };
      const native = { runtimeMode: "native", runnerProfileJson: { nativeExecutionInput: {} }, contextSnapshot: { aiConnection: attribution } };
      // A device_login binding does not move a resumed native run off its account (row 0).
      expect(await readBinding(db, { agent: worker, run: native })).toMatchObject({ source: "pool", persisted: { accountId: pool.id } });
      // A native run that started without a pool account keeps its own credential.
      await bind(worker, pool.id);
      expect(await readBinding(db, { agent: worker, run: { ...native, contextSnapshot: {} } })).toMatchObject({ source: "none", persisted: null });
      expect((await readBinding(db, { agent: worker })).epochs.bindingUpdatedAt).not.toBeNull();
    });

    it("keeps a resumed native run that saved an upstream connection on the upstream path, whatever the binding row says", async () => {
      const { worker, pool } = await poolFixture();
      const native = (aiConnection?: Record<string, unknown>) => ({
        runtimeMode: "native",
        runnerProfileJson: { nativeExecutionInput: {} },
        contextSnapshot: aiConnection ? { aiConnection } : {},
      });
      await bind(worker, null, "device_login");
      // A device_login row must not move it onto the device's own login: the upstream identity check decides.
      for (const mode of ["responsible_user", "shared", "company_pool"]) {
        expect(await readBinding(db, { agent: worker, run: native({ mode, provider: "anthropic", connectionId: randomUUID() }) }))
          .toMatchObject({ source: "none", mode: "device_login", persisted: null });
      }
      // Without a saved connection the row applies; a pool attribution stays row 0.
      expect(await readBinding(db, { agent: worker, run: native() })).toMatchObject({ source: "device_login" });
      expect(await readBinding(db, { agent: worker, run: native({ mode: "pool_account", accountId: pool.id, runId: randomUUID() }) }))
        .toMatchObject({ source: "pool", persisted: { accountId: pool.id } });
      await bind(worker, pool.id);
      expect(await readBinding(db, { agent: worker, run: native({ mode: "responsible_user", provider: "anthropic" }) })).toMatchObject({ source: "none" });
      // A run that is not a persisted native one follows the row.
      expect(await readBinding(db, { agent: worker, run: { ...native({ mode: "responsible_user" }), runtimeMode: "legacy" } })).toMatchObject({ source: "pool" });
    });
  });

  describe("planCredential", () => {
    it("uses the bound account on the Local server device and on a device another user owns", async () => {
      const { accounts } = service();
      const local = await poolFixture();
      const usedLocally = await plan(accounts, { worker: local.worker, env: local.env }) as CredentialPlanUse;
      expect(usedLocally).toMatchObject({ kind: "use", accountId: local.pool.id, persisted: false, probe: false });
      expect(usedLocally.device).toMatchObject({ kind: "server", externalKey: "local" });

      const provider = await plugin("box");
      const stranger = await user();
      const owned = await targetDevice({ pluginId: provider.id, deviceKey: "d-1", types: ["subscription"], reportedAt: new Date(), ownerUserId: stranger });
      const sandbox = await environment("sandbox", { provider: "box", deviceId: "d-1" });
      const remote = await poolFixture({ env: sandbox });
      const usedRemotely = await plan(accounts, { worker: remote.worker, env: sandbox }) as CredentialPlanUse;
      expect(usedRemotely).toMatchObject({ kind: "use", accountId: remote.pool.id });
      expect(usedRemotely.device?.id).toBe(owned.id);
      expect(usedRemotely.epochs).toMatchObject({ accountId: remote.pool.id, deviceId: owned.id, environmentId: sandbox.id });
    });

    it("returns none for device_login and unbound agents", async () => {
      const { accounts } = service();
      const { worker } = await poolFixture();
      await bind(worker, null, "device_login");
      expect(await plan(accounts, { worker, env: localEnvironment })).toEqual({ kind: "none" });
      await db.delete(aiAccountAgentBindings).where(eq(aiAccountAgentBindings.agentId, worker.id));
      expect(await plan(accounts, { worker, env: localEnvironment })).toEqual({ kind: "none" });
    });

    it("waits unassigned without an account, also after the account was deleted", async () => {
      const { accounts } = service();
      const { worker, pool } = await poolFixture();
      await bind(worker, null);
      const unbound = await expectWait(plan(accounts, { worker, env: localEnvironment }));
      expect(unbound.wait).toMatchObject({ kind: "ai_account", reason: "unassigned", accountId: null, environmentId: localEnvironment.id });
      await bind(worker, pool.id);
      await db.delete(aiAccounts).where(eq(aiAccounts.id, pool.id));
      expect((await expectWait(plan(accounts, { worker, env: localEnvironment }))).wait.reason).toBe("unassigned");
    });

    it("waits owner_not_member without the account's label", async () => {
      const { accounts } = service();
      const { worker, pool, ownerId } = await poolFixture();
      await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.principalId, ownerId));
      const deferral = await expectWait(plan(accounts, { worker, env: localEnvironment }));
      expect(deferral.wait).toMatchObject({ reason: "owner_not_member", accountId: pool.id, accountLabel: null });
    });

    it("walks rows 3 to 6 in order: reserved_elsewhere, withdrawn by an admin or the owner, signed_out", async () => {
      const { accounts } = service();
      const { worker, pool } = await poolFixture();
      const elsewhere = await company();
      const [foreign] = await db.insert(projects).values({ companyId: elsewhere, name: "Elsewhere" }).returning();
      await db.insert(aiAccountProjects).values({ accountId: pool.id, projectId: foreign!.id });
      await db.update(aiAccounts).set({ adminDisabledAt: new Date(), status: "auth_failed" }).where(eq(aiAccounts.id, pool.id));
      expect((await expectWait(plan(accounts, { worker, env: localEnvironment }))).wait).toMatchObject({ reason: "reserved_elsewhere", accountLabel: pool.label });

      await db.delete(aiAccountProjects).where(eq(aiAccountProjects.accountId, pool.id));
      expect((await expectWait(plan(accounts, { worker, env: localEnvironment }))).wait.reason).toBe("withdrawn");
      await db.update(aiAccounts).set({ adminDisabledAt: null, status: "disabled" }).where(eq(aiAccounts.id, pool.id));
      expect((await expectWait(plan(accounts, { worker, env: localEnvironment }))).wait.reason).toBe("withdrawn");
      await db.update(aiAccounts).set({ status: "auth_failed" }).where(eq(aiAccounts.id, pool.id));
      expect((await expectWait(plan(accounts, { worker, env: localEnvironment }))).wait.reason).toBe("signed_out");
    });

    it("waits device_unknown when the environment maps to no device, before a limit", async () => {
      const { accounts } = service();
      const unmapped = await environment("sandbox", { provider: "nowhere", deviceId: "d-9" });
      const { worker } = await poolFixture({
        env: unmapped,
        accountOverrides: { exhaustedUntil: at(new Date(), HOUR), limitSource: "estimated", limitStrikes: 1 },
      });
      const deferral = await expectWait(plan(accounts, { worker, env: unmapped }));
      expect(deferral.wait).toMatchObject({ reason: "device_unknown", environmentId: unmapped.id, deviceId: null });
      expect((await expectWait(plan(accounts, { worker, env: null }))).wait.reason).toBe("device_unknown");
    });

    it("waits credential_type_unsupported when the target does not take the type, and when its report is stale", async () => {
      const { accounts } = service();
      const provider = await plugin("box");
      const now = new Date();
      const device = await targetDevice({ pluginId: provider.id, deviceKey: "d-1", types: ["subscription"], reportedAt: now });
      const sandbox = await environment("sandbox", { provider: "box", deviceId: "d-1" });
      const { worker } = await poolFixture({ env: sandbox, accountOverrides: { credentialType: "api_key" } });
      expect((await expectWait(plan(accounts, { worker, env: sandbox, now }))).wait)
        .toMatchObject({ reason: "credential_type_unsupported", deviceId: device.id, environmentId: sandbox.id });

      await db.update(aiAccountHosts).set({ targetState: { state: "available", acceptedCredentialTypes: ["subscription", "api_key"] } })
        .where(eq(aiAccountHosts.id, device.id));
      expect(await plan(accounts, { worker, env: sandbox, now })).toMatchObject({ kind: "use" });
      // A report older than 15 minutes counts as subscription only.
      await db.update(aiAccountHosts).set({ targetReportedAt: at(now, -16 * 60_000) }).where(eq(aiAccountHosts.id, device.id));
      expect((await expectWait(plan(accounts, { worker, env: sandbox, now }))).wait.reason).toBe("credential_type_unsupported");
    });

    it("waits for a limit until the reset plus the run's jitter, with the source of the reset", async () => {
      const { accounts } = service();
      const now = new Date();
      const reset = at(now, 3 * HOUR);
      const { worker, pool } = await poolFixture({ accountOverrides: { exhaustedUntil: reset, limitSource: "provider", limitReason: "provider_quota", limitStrikes: 1 } });
      const target = await run(worker);
      const deferral = await expectWait(plan(accounts, { worker, env: localEnvironment, runRow: target, now }));
      expect(deferral.wait).toMatchObject({ reason: "usage_limit", accountId: pool.id, resumeAtSource: "provider" });
      expect(deferral.wait.resumeAt!.getTime()).toBe(reset.getTime() + resourceWaitJitterMs(target.id));
      expect(deferral.epochs).toMatchObject({ agentId: worker.id, accountId: pool.id, environmentId: localEnvironment.id });

      await db.update(aiAccounts).set({ limitReason: "credit_balance", limitSource: "estimated" }).where(eq(aiAccounts.id, pool.id));
      expect((await expectWait(plan(accounts, { worker, env: localEnvironment, now }))).wait)
        .toMatchObject({ reason: "credit_balance", resumeAtSource: "estimated" });
    });

    it("lets one run probe an estimated limit once it passed; a fresh run waits for the probe", async () => {
      const { accounts } = service();
      const now = new Date();
      const { worker, pool } = await poolFixture({
        accountOverrides: { exhaustedUntil: at(now, -60_000), limitSource: "estimated", limitReason: "provider_quota", limitStrikes: 1 },
      });
      const probe = await run(worker);
      expect(await plan(accounts, { worker, env: localEnvironment, runRow: probe, now })).toMatchObject({ kind: "use", probe: true });
      expect((await accountRow(pool.id)).limitProbeRunId).toBe(probe.id);

      const fresh = await run(worker);
      const waiting = await expectWait(plan(accounts, { worker, env: localEnvironment, runRow: fresh, now }));
      expect(waiting.wait).toMatchObject({ reason: "usage_limit", resumeAt: null });
      expect(await previewCredentialPlan(db, { agent: worker, environment: localEnvironment, now, deploymentMode: "authenticated" }))
        .toMatchObject({ outcome: "wait", reason: "usage_limit" });

      // Once the probe run ended, the next run takes the probe.
      await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, probe.id));
      expect(await plan(accounts, { worker, env: localEnvironment, runRow: fresh, now })).toMatchObject({ kind: "use", probe: true });
    });

    it("keeps a persisted native run on its account, and refuses it once the owner left or the account was withdrawn", async () => {
      const deps = makeDeps();
      const { accounts } = service(deps);
      const { worker, pool, ownerId } = await poolFixture({
        accountOverrides: { exhaustedUntil: at(new Date(), HOUR), limitSource: "estimated", limitStrikes: 2 },
      });
      const nativeRun = (contextAccountId: string) => run(worker, {
        runtimeMode: "native",
        runnerProfileJson: { nativeExecutionInput: { binding: {} } },
        contextSnapshot: { aiConnection: { mode: "pool_account", accountId: contextAccountId, hostId: randomUUID(), runId: randomUUID() } },
      });
      await bind(worker, null, "device_login");
      const resumed = await nativeRun(pool.id);
      // A limit never makes a persisted run wait; the binding change does not move it either.
      expect(await plan(accounts, { worker, env: localEnvironment, runRow: resumed })).toMatchObject({ kind: "use", persisted: true, accountId: pool.id });

      await db.update(companyMemberships).set({ status: "archived" }).where(eq(companyMemberships.principalId, ownerId));
      const left = await expectRefusal(plan(accounts, { worker, env: localEnvironment, runRow: await nativeRun(pool.id) }));
      expect(left.reason).toBe("ai_connection_changed");
      expect(left.resultJson.configurationIncomplete).toMatchObject({ reason: "ai_connection_changed", actionUrl: `/agents/${worker.id}/runtime` });

      await db.update(companyMemberships).set({ status: "active" }).where(eq(companyMemberships.principalId, ownerId));
      await db.update(aiAccounts).set({ status: "disabled" }).where(eq(aiAccounts.id, pool.id));
      expect((await expectRefusal(plan(accounts, { worker, env: localEnvironment, runRow: await nativeRun(pool.id) }))).reason)
        .toBe("ai_connection_changed");
    });

    it("previews without creating a device, claiming a probe or reading epochs", async () => {
      const ssh = await environment("ssh", { host: "build.invalid", port: 2222 });
      const { worker, pool } = await poolFixture({ env: ssh });
      expect(await previewCredentialPlan(db, { agent: worker, environment: ssh, deploymentMode: "authenticated" }))
        .toEqual({ outcome: "use", accountId: pool.id, deviceId: null, deviceName: null });
      expect(await db.select().from(aiAccountHosts)).toEqual([]);
      await bind(worker, null, "device_login");
      expect(await previewCredentialPlan(db, { agent: worker, environment: ssh })).toEqual({ outcome: "none", reason: "device_login" });
    });
  });

  // -------------------------------------------------------------------------

  describe("acquire and inject", () => {
    it("writes the slot and the attribution, decrypts after commit, and injects with pool hygiene", async () => {
      const deps = makeDeps();
      const { accounts } = service(deps);
      const companyId = await company();
      const ownerId = await user();
      await member(companyId, ownerId);
      const token = `sk-ant-oat01-${randomUUID()}`;
      const pool = await account(ownerId, {}, token);
      const worker = await agent(companyId);
      await bind(worker, pool.id);
      const target = await run(worker, { contextSnapshot: { issueId: null, keep: "me" } });
      const planned = await plan(accounts, { worker, env: localEnvironment, runRow: target }) as CredentialPlanUse;
      const credential = await accounts.acquire({ run: target, plan: planned });

      expect(credential.value).toBe(token);
      expect(JSON.stringify(credential)).not.toContain(token);
      expect({ ...credential }).not.toHaveProperty("value");
      expect(credential).toMatchObject({ envKey: "CLAUDE_CODE_OAUTH_TOKEN", credentialRef: credentialRefForAccount(pool.id) });
      const [slot] = await db.select().from(aiAccountRunSlots).where(eq(aiAccountRunSlots.runId, target.id));
      expect(slot).toMatchObject({ accountId: pool.id, deviceId: planned.device!.id, companyId });
      const stored = await runRow(target.id);
      expect(stored.contextSnapshot).toMatchObject({
        keep: "me",
        aiConnection: {
          mode: "pool_account",
          provider: "anthropic",
          method: "subscription",
          accountId: pool.id,
          accountName: pool.label,
          ownerUserId: ownerId,
          hostId: planned.device!.id,
          credentialRef: credentialRefForAccount(pool.id),
          runId: target.id,
        },
      });
      expect(JSON.stringify(stored.contextSnapshot)).not.toContain(token);
      expect((await accountRow(pool.id)).lastUsedAt).not.toBeNull();

      const config: Record<string, unknown> = {
        env: {
          ANTHROPIC_API_KEY: "sk-ant-api-inherited",
          ANTHROPIC_AUTH_TOKEN: "inherited",
          CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
          CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "refresh",
          ANTHROPIC_UNIX_SOCKET: "/tmp/socket",
          KEEP: "1",
        },
      };
      const secretKeys = new Set<string>();
      const context: Record<string, unknown> = {};
      await accounts.inject({ run: target, config, secretKeys, context, credential });
      const env = config.env as Record<string, unknown>;
      expect(env).toMatchObject({ ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: token, KEEP: "1" });
      expect(env[AI_CREDENTIAL_REF_ENV_KEY]).toBe(credentialRefForAccount(pool.id));
      for (const key of POOL_RUN_REMOVED_ENV_KEYS) expect(env).not.toHaveProperty(key);
      expect([...secretKeys].sort()).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]);
      expect(context.aiConnection).toMatchObject({ mode: "pool_account", accountId: pool.id, runId: target.id });
      expect(JSON.stringify(context)).not.toContain(token);
      const event = deps.calls.events.find((entry) => entry.runId === target.id);
      expect(event?.message).toBe(`Using Claude account "${pool.label}" (subscription) on Paperclip server`);
      expect(JSON.stringify(deps.calls.events)).not.toContain(token);
    });

    it("injects an API key in ANTHROPIC_API_KEY", () => {
      const config: Record<string, unknown> = { env: { CLAUDE_CODE_OAUTH_TOKEN: "x" } };
      const credential = {
        attribution: { mode: "pool_account", accountId: "a", runId: "r" },
        envKey: "ANTHROPIC_API_KEY",
        credentialRef: "0123456789abcdef",
      } as never as Parameters<typeof injectPoolCredential>[0]["credential"];
      Object.defineProperty(credential, "value", { value: "sk-ant-api-secret", enumerable: false });
      injectPoolCredential({ config, secretKeys: new Set(), context: {}, credential });
      expect(config.env).toMatchObject({ ANTHROPIC_API_KEY: "sk-ant-api-secret", CLAUDE_CODE_OAUTH_TOKEN: "", ANTHROPIC_AUTH_TOKEN: "" });
    });

    it("defers the fourth distinct account on a device and admits an account that already runs there", async () => {
      const { accounts } = service();
      const companyId = await company();
      const ownerId = await user();
      await member(companyId, ownerId);
      const pools = [await account(ownerId), await account(ownerId), await account(ownerId), await account(ownerId)];
      const workers: AgentRow[] = [];
      for (const pool of pools) {
        const worker = await agent(companyId);
        await bind(worker, pool.id);
        workers.push(worker);
      }
      for (const worker of workers.slice(0, 3)) {
        const target = await run(worker);
        await accounts.acquire({ run: target, plan: await plan(accounts, { worker, env: localEnvironment, runRow: target }) as CredentialPlanUse });
      }
      const fourth = await run(workers[3]!);
      const planned = await plan(accounts, { worker: workers[3]!, env: localEnvironment, runRow: fourth }) as CredentialPlanUse;
      const deferral = await expectWait(accounts.acquire({ run: fourth, plan: planned }));
      expect(deferral.wait).toMatchObject({ kind: "device_slots", reason: "slots_full", accountId: pools[3]!.id, deviceId: planned.device!.id });
      expect(await db.select().from(aiAccountRunSlots).where(eq(aiAccountRunSlots.runId, fourth.id))).toEqual([]);
      expect((await runRow(fourth.id)).contextSnapshot).not.toHaveProperty("aiConnection");

      // A second run on an account that already runs there takes no new slot.
      const again = await run(workers[0]!);
      await expect(accounts.acquire({ run: again, plan: await plan(accounts, { worker: workers[0]!, env: localEnvironment, runRow: again }) as CredentialPlanUse }))
        .resolves.toMatchObject({ credentialRef: credentialRefForAccount(pools[0]!.id) });
      // A finished run's slot stops counting by itself.
      const [firstSlot] = await db.select().from(aiAccountRunSlots).where(eq(aiAccountRunSlots.accountId, pools[1]!.id));
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, firstSlot!.runId));
      await expect(accounts.acquire({ run: fourth, plan: planned })).resolves.toBeDefined();
    });

    it("admits exactly one of two new accounts racing for a device's last slot", async () => {
      const { accounts } = service();
      const companyId = await company();
      const ownerId = await user();
      await member(companyId, ownerId);
      const workers: AgentRow[] = [];
      for (let index = 0; index < 4; index += 1) {
        const worker = await agent(companyId);
        await bind(worker, (await account(ownerId)).id);
        workers.push(worker);
      }
      // Two accounts already run on the server device (cap 3): one slot is left.
      for (const worker of workers.slice(0, 2)) {
        const target = await run(worker);
        await accounts.acquire({ run: target, plan: await plan(accounts, { worker, env: localEnvironment, runRow: target }) as CredentialPlanUse });
      }
      const racers: Array<{ target: RunRow; planned: CredentialPlanUse }> = [];
      for (const worker of workers.slice(2)) {
        const target = await run(worker);
        racers.push({ target, planned: await plan(accounts, { worker, env: localEnvironment, runRow: target }) as CredentialPlanUse });
      }
      const deviceId = racers[0]!.planned.device!.id;
      // Both acquires queue on the device row lock at the same time, then run one after the other.
      const started: { race?: Promise<Array<PromiseSettledResult<unknown>>> } = {};
      await db.transaction(async (tx) => {
        await tx.execute(sql`select id from ai_account_hosts where id = ${deviceId} for update`);
        started.race = Promise.allSettled(racers.map(({ target, planned }) => accounts.acquire({ run: target, plan: planned })));
        await new Promise((resolve) => setTimeout(resolve, 200));
      });
      const race = await started.race!;
      expect(race.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const rejected = race.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toBeInstanceOf(ResourceWaitDeferral);
      expect((rejected[0]!.reason as ResourceWaitDeferral).wait).toMatchObject({ kind: "device_slots", reason: "slots_full", deviceId });
      const slots = await db.select().from(aiAccountRunSlots).where(inArray(aiAccountRunSlots.runId, racers.map(({ target }) => target.id)));
      expect(slots).toHaveLength(1);
      expect(await db.selectDistinct({ accountId: aiAccountRunSlots.accountId }).from(aiAccountRunSlots).where(eq(aiAccountRunSlots.deviceId, deviceId)))
        .toHaveLength(3);
    });

    it("does not count a copied attribution; counts a legacy host-pool run until its copy is dropped", async () => {
      const { accounts } = service();
      const { worker, pool, companyId, ownerId } = await poolFixture();
      const planned = await plan(accounts, { worker, env: localEnvironment }) as CredentialPlanUse;
      const deviceId = planned.device!.id;
      await db.update(aiAccountHosts).set({ maxAccounts: 1 }).where(eq(aiAccountHosts.id, deviceId));
      const other = await account(ownerId);
      const otherAgent = await agent(companyId);

      // A retry that copied another run's pool attribution, running: not counted.
      await run(otherAgent, { contextSnapshot: { aiConnection: { mode: "pool_account", accountId: other.id, hostId: deviceId, runId: randomUUID() } } });
      const first = await run(worker);
      await expect(accounts.acquire({ run: first, plan: planned })).resolves.toBeDefined();
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, first.id));

      // A legacy host-pool run in flight from the previous image: counted.
      const legacy = await run(otherAgent, { contextSnapshot: { aiConnection: { mode: "host_pool", accountId: other.id, hostId: deviceId } } });
      const second = await run(worker);
      expect((await expectWait(accounts.acquire({ run: second, plan: planned }))).wait.reason).toBe("slots_full");
      // The same attribution copied into a just-claimed retry is dropped before acquire, and stops counting.
      const context = { ...legacy.contextSnapshot };
      expect(await dropStaleAttribution(db, { run: legacy, context })).toBe(true);
      expect(context).not.toHaveProperty("aiConnection");
      expect((await runRow(legacy.id)).contextSnapshot).not.toHaveProperty("aiConnection");
      await expect(accounts.acquire({ run: second, plan: planned })).resolves.toMatchObject({ credentialRef: credentialRefForAccount(pool.id) });
    });

    it("keeps a run's own attribution and a persisted run's attribution", async () => {
      const { worker } = await poolFixture();
      const own = await run(worker);
      await db.update(heartbeatRuns).set({ contextSnapshot: { aiConnection: { mode: "pool_account", accountId: randomUUID(), runId: own.id } } })
        .where(eq(heartbeatRuns.id, own.id));
      const ownRow = await runRow(own.id);
      expect(await dropStaleAttribution(db, { run: ownRow, context: { ...ownRow.contextSnapshot } })).toBe(false);
      const copied = await run(worker, { contextSnapshot: { aiConnection: { mode: "host_pool", accountId: randomUUID(), hostId: randomUUID() } } });
      expect(await dropStaleAttribution(db, { run: copied, context: { ...copied.contextSnapshot }, persistedNativeExecutionInput: true })).toBe(false);
    });

    it("re-checks the account under the device lock", async () => {
      const { accounts } = service();
      const { worker, pool } = await poolFixture();
      const target = await run(worker);
      const planned = await plan(accounts, { worker, env: localEnvironment, runRow: target }) as CredentialPlanUse;
      await db.update(aiAccounts).set({ exhaustedUntil: at(new Date(), HOUR), limitSource: "provider" }).where(eq(aiAccounts.id, pool.id));
      expect((await expectWait(accounts.acquire({ run: target, plan: planned }))).wait).toMatchObject({ reason: "usage_limit", resumeAtSource: "provider" });
      await db.update(aiAccounts).set({ exhaustedUntil: null, status: "disabled" }).where(eq(aiAccounts.id, pool.id));
      expect((await expectWait(accounts.acquire({ run: target, plan: planned }))).wait.reason).toBe("withdrawn");
      expect(await db.select().from(aiAccountRunSlots)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------

  describe("routing guard", () => {
    const matcherKeys = [
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_VERTEX_BASE_URL",
      "ANTHROPIC_SOMETHING_NEW_BASE_URL",
      "CLAUDE_CODE_API_BASE_URL",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_GATEWAY",
      "HTTP_PROXY",
      "https_proxy",
      "All_Proxy",
      "NODE_EXTRA_CA_CERTS",
      "NODE_TLS_REJECT_UNAUTHORIZED",
    ];

    async function guardFixture() {
      const { accounts } = service();
      const { worker } = await poolFixture();
      const target = await run(worker);
      return { accounts, worker, target };
    }

    it.each(matcherKeys)("refuses %s in the run environment", async (key) => {
      const { accounts, worker, target } = await guardFixture();
      const refusal = await expectRefusal(accounts.assertRoutingCompatible({
        run: target,
        agent: worker,
        config: { env: { [key]: "http://elsewhere.invalid" } },
        checkProjectSettings: false,
      }));
      expect(refusal.reason).toBe("ai_connection_incompatible");
      expect(refusal.message).toContain(key);
      expect(refusal.message).not.toContain("elsewhere.invalid");
    });

    it("refuses an override in a raw layer, a secret reference included, and passes a blank one", async () => {
      const { accounts, worker, target } = await guardFixture();
      await expectRefusal(accounts.assertRoutingCompatible({
        run: target,
        agent: worker,
        config: { env: {} },
        envLayers: [{ HTTPS_PROXY: { type: "secret_ref", secretId: randomUUID() } }],
        checkProjectSettings: false,
      }));
      await expect(accounts.assertRoutingCompatible({
        run: target,
        agent: worker,
        config: { env: { ANTHROPIC_BASE_URL: "", KEEP: "1" } },
        envLayers: [{ ANTHROPIC_BASE_URL: { type: "plain", value: "" } }],
        checkProjectSettings: false,
      })).resolves.toBeUndefined();
    });

    it("refuses project settings with a routing env block or a credential helper, and authentication arguments", async () => {
      const { accounts, worker, target } = await guardFixture();
      const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-pool-routing-"));
      try {
        const project = path.join(root, "project");
        await mkdir(path.join(project, ".claude"), { recursive: true });
        const check = () => accounts.assertRoutingCompatible({ run: target, agent: worker, config: { env: {}, cwd: project } });
        await writeFile(path.join(project, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash"] }, env: { FOO: "1" } }));
        await expect(check()).resolves.toBeUndefined();

        for (const settings of [
          { env: { ANTHROPIC_BASE_URL: "https://proxy.invalid" } },
          { env: { https_proxy: "http://proxy.invalid" } },
          { apiKeyHelper: "/bin/echo key" },
          { awsAuthRefresh: "aws sso login" },
          { awsCredentialExport: "/bin/creds" },
        ]) {
          await writeFile(path.join(project, ".claude", "settings.json"), JSON.stringify(settings));
          const refusal = await expectRefusal(check());
          expect(refusal.reason).toBe("ai_connection_incompatible");
          expect(refusal.message).not.toContain("proxy.invalid");
        }
        await writeFile(path.join(project, ".claude", "settings.json"), "{}");
        await writeFile(path.join(project, ".claude", "settings.local.json"), `{ "awsCredentialExport": "x", }`);
        expect((await expectRefusal(check())).message).toContain("awsCredentialExport");

        await rm(path.join(project, ".claude", "settings.local.json"));
        await expectRefusal(accounts.assertRoutingCompatible({ run: target, agent: worker, config: { env: {}, cwd: project, extraArgs: ["--settings", "x.json"] } }));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("scans a remote target's settings by exit code only", async () => {
      const { accounts, worker, target } = await guardFixture();
      const remote = { kind: "remote", transport: "ssh", remoteCwd: "/srv/work" } as never;
      await expect(accounts.assertRoutingCompatible({ run: target, agent: worker, config: { env: {} }, target: remote })).resolves.toBeUndefined();
      const scan = remoteStub.calls.find((call) => call.args[2] === "ai-pool-routing-check");
      expect(scan?.args.slice(3)).toEqual(["/srv/work", expect.stringContaining("apiKeyHelper"), ".claude/settings.json", ".claude/settings.local.json"]);
      for (const key of POOL_RUN_REMOVED_ENV_KEYS) expect(scan?.args[4]).toContain(key);
      expect(scan?.args[1]).toContain("home=${HOME%/}");

      remoteStub.exitCodes["ai-pool-routing-check"] = 42;
      expect((await expectRefusal(accounts.assertRoutingCompatible({ run: target, agent: worker, config: { env: {} }, target: remote }))).reason)
        .toBe("ai_connection_incompatible");
      remoteStub.exitCodes["ai-pool-routing-check"] = 43;
      expect((await expectRefusal(accounts.assertRoutingCompatible({ run: target, agent: worker, config: { env: {} }, target: remote }))).message)
        .toContain("could not be checked");
    });

    it("refuses a credential carrier in a project settings env block, an empty one included", async () => {
      const { accounts, worker, target } = await guardFixture();
      const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-pool-carriers-"));
      try {
        const project = path.join(root, "project");
        await mkdir(path.join(project, ".claude"), { recursive: true });
        const check = () => accounts.assertRoutingCompatible({ run: target, agent: worker, config: { env: {}, cwd: project } });
        // The CLI applies the block itself, so a carrier the run env lost would come back from it.
        for (const [key, value] of [["ANTHROPIC_UNIX_SOCKET", "/tmp/proxy.sock"], ["CLAUDE_SECURESTORAGE_CONFIG_DIR", ""]] as const) {
          await writeFile(path.join(project, ".claude", "settings.json"), JSON.stringify({ env: { [key]: value } }));
          const refusal = await expectRefusal(check());
          expect(refusal.reason).toBe("ai_connection_incompatible");
          expect(refusal.message).toContain(`env.${key}`);
          expect(refusal.message).not.toContain("proxy.sock");
        }
        // A file that does not parse is matched by key name.
        await writeFile(path.join(project, ".claude", "settings.json"), `{ "env": { "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST": "1", } }`);
        expect((await expectRefusal(check())).message).toContain("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
      for (const key of POOL_RUN_REMOVED_ENV_KEYS) {
        expect(projectSettingsConflicts(JSON.stringify({ env: { [key]: null } }))).toEqual([`env.${key}`]);
      }
      expect(projectSettingsConflicts(JSON.stringify({ env: { KEEP: "1" }, permissions: { allow: ["Bash"] } }))).toEqual([]);
    });

    it("skips the remote user's own ~/.claude settings on the target, but scans the home directory as the project", async () => {
      const { accounts, worker, target } = await guardFixture();
      const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-pool-remote-home-"));
      try {
        const home = path.join(root, "home");
        const project = path.join(home, "work", "project");
        await mkdir(path.join(home, ".claude"), { recursive: true });
        await mkdir(path.join(project, ".claude"), { recursive: true });
        // The remote user routes through a proxy; claude-local points a remote pool run at the account's own config directory.
        await writeFile(path.join(home, ".claude", "settings.json"), JSON.stringify({ env: { HTTPS_PROXY: "http://proxy.invalid" } }));
        remoteStub.shellHome = home;
        const check = (remoteCwd: string) => accounts.assertRoutingCompatible({
          run: target,
          agent: worker,
          config: { env: {} },
          target: { kind: "remote", transport: "ssh", remoteCwd } as never,
        });
        await expect(check(project)).resolves.toBeUndefined();
        const conflict = "The project's Claude settings set a provider routing or credential key";
        expect((await expectRefusal(check(home))).message).toContain(conflict);
        // The project's own file is still scanned on the target, a credential carrier included.
        await writeFile(path.join(project, ".claude", "settings.local.json"), JSON.stringify({ env: { ANTHROPIC_UNIX_SOCKET: "/tmp/x.sock" } }));
        expect((await expectRefusal(check(project))).message).toContain(conflict);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("skips the server user's own ~/.claude settings for a remote run checked before its workspace exists, never for a Local run", async () => {
      const { accounts, worker, target } = await guardFixture();
      const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-pool-server-home-"));
      const previousHome = process.env.HOME;
      try {
        const home = path.join(root, "home");
        const project = path.join(home, "workspaces", "project");
        await mkdir(path.join(home, ".claude"), { recursive: true });
        await mkdir(project, { recursive: true });
        await writeFile(path.join(home, ".claude", "settings.json"), JSON.stringify({ env: { HTTP_PROXY: "http://proxy.invalid" } }));
        process.env.HOME = home;
        expect(os.homedir()).toBe(home);
        const check = (cwd: string, targetIsRemote?: boolean) => accounts.assertRoutingCompatible({
          run: target,
          agent: worker,
          config: { env: {}, cwd },
          ...(targetIsRemote === undefined ? {} : { targetIsRemote }),
        });
        await expect(check(project, true)).resolves.toBeUndefined();
        // A Local run reads the server user's own settings.
        expect((await expectRefusal(check(project))).message).toContain("env.HTTP_PROXY");
        expect((await expectRefusal(check(home, true))).message).toContain("env.HTTP_PROXY");
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        await rm(root, { recursive: true, force: true });
      }
    });

    it("ends the run's open wait episode as refused", async () => {
      const { accounts, worker, target } = await guardFixture();
      const [episode] = await db.insert(resourceWaitEpisodes).values({
        companyId: worker.companyId,
        agentId: worker.id,
        kind: "ai_account",
        reason: "usage_limit",
        scope: "account",
        resourceKey: `account:${randomUUID()}`,
        since: new Date(),
        currentRunId: target.id,
      }).returning();
      await expectRefusal(accounts.assertRoutingCompatible({ run: target, agent: worker, config: { env: { ANTHROPIC_BASE_URL: "x" } }, checkProjectSettings: false }));
      const [ended] = await db.select().from(resourceWaitEpisodes).where(eq(resourceWaitEpisodes.id, episode!.id));
      expect(ended).toMatchObject({ resolution: "refused" });
    });
  });

  // -------------------------------------------------------------------------

  /** A finished run that used `poolId` on the server device, with what the adapter recorded. */
  async function failedPoolRun(input: {
    worker: AgentRow;
    poolId: string;
    deviceId?: string | null;
    errorCode?: string;
    resultJson?: Record<string, unknown>;
    error?: string;
    issueId?: string;
    mode?: "pool_account" | "host_pool";
  }) {
    const id = randomUUID();
    const attribution = input.mode === "host_pool"
      ? { mode: "host_pool", accountId: input.poolId, hostId: input.deviceId ?? null, hostName: "Paperclip server" }
      : { mode: "pool_account", accountId: input.poolId, hostId: input.deviceId ?? null, hostName: "Paperclip server", runId: id };
    return run(input.worker, {
      id,
      status: "failed",
      finishedAt: new Date(),
      errorCode: input.errorCode ?? "provider_quota",
      error: input.error ?? "Claude run failed: You've hit your limit",
      resultJson: input.resultJson ?? { errorFamily: "provider_quota" },
      contextSnapshot: {
        ...(input.issueId ? { issueId: input.issueId } : {}),
        aiConnection: attribution,
        paperclipEnvironment: { id: localEnvironment.id, name: localEnvironment.name, driver: "local" },
      },
    });
  }

  async function serverDeviceId() {
    const { accounts } = service();
    const probe = await poolFixture();
    return ((await plan(accounts, { worker: probe.worker, env: localEnvironment })) as CredentialPlanUse).device!.id;
  }

  describe("handleRunLimit", () => {
    it("leaves a transcript-only match to the transient lane without touching the account", async () => {
      const { accounts, calls } = service();
      const { worker, pool } = await poolFixture();
      const before = await accountRow(pool.id);
      const failed = await failedPoolRun({ worker, poolId: pool.id });
      const outcome = await accounts.handleRunLimit({ run: failed, agent: worker, provenance: { classificationSource: "transcript" } });
      expect(outcome).toMatchObject({ handled: false, reason: "transcript_only" });
      expect(await accountRow(pool.id)).toEqual(before);
      expect(calls.scheduled).toEqual([]);
      // A copied attribution is never this run's account.
      const copied = await run(worker, {
        status: "failed",
        errorCode: "provider_quota",
        resultJson: { errorFamily: "provider_quota" },
        contextSnapshot: { aiConnection: { mode: "pool_account", accountId: pool.id, runId: randomUUID() } },
      });
      expect(await accounts.handleRunLimit({ run: copied, agent: worker })).toMatchObject({ handled: false, reason: "not_pool_run" });
    });

    it("clamps a typed reset a year out to 7 d + 1 h as an estimate and waits for it", async () => {
      const { accounts, calls } = service();
      const deviceId = await serverDeviceId();
      const { worker, pool } = await poolFixture();
      const now = new Date();
      const failed = await failedPoolRun({
        worker,
        poolId: pool.id,
        deviceId,
        resultJson: { errorFamily: "provider_quota", providerQuotaRetryNotBefore: at(now, 365 * 24 * HOUR).toISOString() },
      });
      const outcome = await accounts.handleRunLimit({ run: failed, agent: worker, now });
      const clamped = at(now, 7 * 24 * HOUR + HOUR);
      expect(outcome).toMatchObject({ handled: true, reason: "usage_limit", limitSource: "estimated", strikes: 1 });
      expect(outcome.until!.getTime()).toBe(clamped.getTime());
      expect(await accountRow(pool.id)).toMatchObject({ limitSource: "estimated", limitStrikes: 1, limitReason: "provider_quota", limitRunId: failed.id, limitProbeRunId: null });
      const successor = await runRow(outcome.successorRunId!);
      expect(successor).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: "ai_account_wait" });
      const context = readResourceWaitContext(successor.contextSnapshot?.resourceWait);
      expect(context).toMatchObject({ kind: "ai_account", reason: "usage_limit", accountId: pool.id, deviceId, environmentId: localEnvironment.id, resumeAtSource: "estimated" });
      expect(new Date(context!.resumeAt!).getTime()).toBe(clamped.getTime() + resourceWaitJitterMs(failed.id));
      expect(calls.scheduled[0]).toMatchObject({ retryReason: "ai_account_wait" });

      // A typed reset in reach is the provider's.
      const { worker: worker2, pool: pool2 } = await poolFixture();
      const typed = at(now, 3 * HOUR);
      const failed2 = await failedPoolRun({ worker: worker2, poolId: pool2.id, resultJson: { errorFamily: "provider_quota", providerQuotaRetryNotBefore: typed.toISOString() } });
      expect(await accounts.handleRunLimit({ run: failed2, agent: worker2, now })).toMatchObject({ handled: true, until: typed, limitSource: "provider" });
    });

    it("takes the adapter result's own provenance over the row: a provider reset, or none at all", async () => {
      const { accounts } = service();
      const now = new Date();
      const reset = at(now, 2 * HOUR);
      // The row names no reset and a transcript source; heartbeat passes the adapter's fields (hook H9).
      const { worker, pool } = await poolFixture();
      const failed = await failedPoolRun({ worker, poolId: pool.id, resultJson: { errorFamily: "provider_quota", classificationSource: "transcript" } });
      const typed = await accounts.handleRunLimit({
        run: failed,
        agent: worker,
        now,
        provenance: { errorFamily: "provider_quota", classificationSource: "terminal", retryNotBefore: reset.toISOString(), retryNotBeforeSource: "provider_terminal" },
      });
      expect(typed).toMatchObject({ handled: true, reason: "usage_limit", limitSource: "provider", until: reset, strikes: 1 });
      expect(await accountRow(pool.id)).toMatchObject({ exhaustedUntil: reset, limitSource: "provider" });

      // A reset the provider did not give is no reset, even one the row stores: the estimate applies.
      const { worker: worker2, pool: pool2 } = await poolFixture();
      const failed2 = await failedPoolRun({
        worker: worker2,
        poolId: pool2.id,
        resultJson: { errorFamily: "provider_quota", providerQuotaRetryNotBefore: reset.toISOString(), retryNotBefore: reset.toISOString(), retryNotBeforeSource: "provider_terminal" },
      });
      const estimated = await accounts.handleRunLimit({
        run: failed2,
        agent: worker2,
        now,
        provenance: { errorFamily: "provider_quota", classificationSource: "terminal", retryNotBefore: reset, retryNotBeforeSource: null },
      });
      expect(estimated).toMatchObject({ handled: true, limitSource: "estimated", strikes: 1 });
      expect(estimated.until!.getTime()).toBe(now.getTime() + HOUR);
    });

    it("estimates 1 h, 2 h, 4 h, 8 h, then 12 h across failed probes; a hit during the limit counts no strike", async () => {
      const { accounts } = service();
      const { worker, pool } = await poolFixture();
      let now = new Date();
      const rests: number[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const failed = await failedPoolRun({ worker, poolId: pool.id });
        const outcome = await accounts.handleRunLimit({ run: failed, agent: worker, now });
        rests.push(outcome.until!.getTime() - now.getTime());
        if (attempt === 0) {
          // A run that was already running hits the same limit: no new strike, about the same reset.
          const concurrent = await failedPoolRun({ worker, poolId: pool.id });
          const later = at(now, 60_000);
          const again = await accounts.handleRunLimit({ run: concurrent, agent: worker, now: later });
          expect(again.strikes).toBe(1);
          expect(again.until!.getTime()).toBe(later.getTime() + HOUR);
        }
        // The next probe fails after this limit (and the concurrent hit's) has passed.
        now = at(outcome.until!, 2 * 60_000);
      }
      expect(rests).toEqual([HOUR, 2 * HOUR, 4 * HOUR, 8 * HOUR, 12 * HOUR, 12 * HOUR]);
      expect(estimatedLimitMs(0)).toBe(HOUR);
      expect(estimatedLimitMs(4)).toBe(12 * HOUR);
      expect((await accountRow(pool.id)).limitStrikes).toBe(6);
    });

    it("lets a provider value overwrite an estimate, but not the other way round", async () => {
      const { accounts } = service();
      const { worker, pool } = await poolFixture();
      const now = new Date();
      await accounts.handleRunLimit({ run: await failedPoolRun({ worker, poolId: pool.id }), agent: worker, now });
      expect((await accountRow(pool.id)).exhaustedUntil!.getTime()).toBe(now.getTime() + HOUR);
      const typed = at(now, 30 * 60_000);
      await accounts.handleRunLimit({
        run: await failedPoolRun({ worker, poolId: pool.id, resultJson: { errorFamily: "provider_quota", providerQuotaRetryNotBefore: typed.toISOString() } }),
        agent: worker,
        now: at(now, 1000),
      });
      expect(await accountRow(pool.id)).toMatchObject({ exhaustedUntil: typed, limitSource: "provider", limitStrikes: 1 });
      await accounts.handleRunLimit({ run: await failedPoolRun({ worker, poolId: pool.id }), agent: worker, now: at(now, 2000) });
      expect(await accountRow(pool.id)).toMatchObject({ exhaustedUntil: typed, limitSource: "provider" });
      // A credit balance rests 24 h.
      const { worker: spender, pool: apiKey } = await poolFixture({ accountOverrides: { credentialType: "api_key" } });
      const credit = await accounts.handleRunLimit({
        run: await failedPoolRun({ worker: spender, poolId: apiKey.id, error: "Credit balance is too low" }),
        agent: spender,
        now,
      });
      expect(credit).toMatchObject({ handled: true, reason: "credit_balance" });
      expect(credit.until!.getTime()).toBe(now.getTime() + 24 * HOUR);
    });

    it("logs limit_reached once per limit episode, and a failed probe keeps one episode and one notice", async () => {
      const { accounts, calls } = service();
      const { worker, pool, companyId } = await poolFixture();
      const [task] = await db.insert(issues).values({ companyId, title: "Task", status: "in_progress", priority: "medium", assigneeAgentId: worker.id }).returning();
      const now = new Date();
      const first = await failedPoolRun({ worker, poolId: pool.id, issueId: task!.id });
      await db.update(issues).set({ executionRunId: first.id }).where(eq(issues.id, task!.id));
      const outcome = await accounts.handleRunLimit({ run: first, agent: worker, now });
      expect(outcome.handled).toBe(true);
      await accounts.handleRunLimit({ run: await failedPoolRun({ worker, poolId: pool.id }), agent: worker, now: at(now, 1000) });
      const limitActivity = () => db.select().from(activityLog).where(and(eq(activityLog.action, "ai_account.limit_reached"), eq(activityLog.entityId, pool.id)));
      expect(await limitActivity()).toHaveLength(1);
      expect((await limitActivity())[0]!.details).toMatchObject({ account: pool.label, reason: "provider_quota", strikes: 1 });

      // The successor became the probe after the reset and hit the limit again.
      const probeId = outcome.successorRunId!;
      const probeRow = await runRow(probeId);
      await db.update(heartbeatRuns).set({
        status: "failed",
        errorCode: "provider_quota",
        resultJson: { errorFamily: "provider_quota" },
        contextSnapshot: { ...probeRow.contextSnapshot, aiConnection: { mode: "pool_account", accountId: pool.id, runId: probeId } },
      }).where(eq(heartbeatRuns.id, probeId));
      const later = at(outcome.until!, 60_000);
      const again = await accounts.handleRunLimit({ run: await runRow(probeId), agent: worker, now: later });
      expect(again).toMatchObject({ handled: true, episodeId: outcome.episodeId, strikes: 2 });
      expect(await db.select().from(resourceWaitEpisodes).where(eq(resourceWaitEpisodes.issueId, task!.id))).toHaveLength(1);
      expect(calls.notices.filter((notice) => notice.issueId === task!.id)).toHaveLength(1);
      expect(await limitActivity()).toHaveLength(1);

      // A success ends the limit episode; the next limit is a new one.
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, again.successorRunId!));
      const successRun = await failedPoolRun({ worker, poolId: pool.id });
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, successRun.id));
      await accounts.noteAccountRunSucceeded({ run: await runRow(successRun.id), now: at(later, 5 * HOUR) });
      await accounts.handleRunLimit({ run: await failedPoolRun({ worker, poolId: pool.id }), agent: worker, now: at(later, 6 * HOUR) });
      expect(await limitActivity()).toHaveLength(2);
    });

    it("handles a legacy host-pool run the same way, without failing over", async () => {
      const { accounts } = service();
      const { worker, pool } = await poolFixture();
      const legacy = await failedPoolRun({ worker, poolId: pool.id, mode: "host_pool" });
      expect(await accounts.handleProviderLimit({ run: legacy, agent: worker })).toMatchObject({ handled: true, via: "pool_account" });
      expect((await accountRow(pool.id)).limitStrikes).toBe(1);
    });
  });

  // -------------------------------------------------------------------------

  describe("noteAccountRunSucceeded", () => {
    it("clears strikes, a passed limit, the suspicion and the probe, wakes the account's waits and ends the probe's episode", async () => {
      const { accounts, resourceWaits } = service();
      const now = new Date();
      const { worker, pool } = await poolFixture({
        accountOverrides: {
          exhaustedUntil: at(now, -60_000),
          limitSource: "estimated",
          limitStrikes: 2,
          limitEpisodeStartedAt: at(now, -3 * HOUR),
          authSuspectAt: at(now, -HOUR),
        },
      });
      const other = await agent(worker.companyId);
      await bind(other, pool.id);
      // A run held on the account's limit, due later.
      const failed = await failedPoolRun({ worker: other, poolId: pool.id });
      const held = await resourceWaits.scheduleResourceWait({
        run: failed,
        wait: accountWaitDeferral({ reason: "usage_limit", accountId: pool.id, accountLabel: pool.label, resumeAt: at(now, HOUR) }).wait,
        now,
        releaseIfUnscheduled: false,
      });
      expect((await runRow(held.successorRunId!)).scheduledRetryAt!.getTime()).toBeGreaterThan(now.getTime());

      // The probe: the current run of its own limit episode.
      const probe = await run(worker, { status: "succeeded" });
      await db.update(heartbeatRuns).set({ contextSnapshot: { aiConnection: { mode: "pool_account", accountId: pool.id, runId: probe.id } } })
        .where(eq(heartbeatRuns.id, probe.id));
      await db.update(aiAccounts).set({ limitProbeRunId: probe.id }).where(eq(aiAccounts.id, pool.id));
      const [probeEpisode] = await db.insert(resourceWaitEpisodes).values({
        companyId: worker.companyId,
        agentId: worker.id,
        kind: "ai_account",
        reason: "usage_limit",
        scope: "account",
        resourceKey: `account:${pool.id}`,
        accountId: pool.id,
        since: at(now, -2 * HOUR),
        currentRunId: probe.id,
      }).returning();

      const outcome = await accounts.noteAccountRunSucceeded({ run: await runRow(probe.id), now });
      expect(outcome).toMatchObject({ cleared: true, episodeResolved: true });
      expect(outcome.woken).toBeGreaterThanOrEqual(1);
      expect(await accountRow(pool.id)).toMatchObject({
        limitStrikes: 0,
        exhaustedUntil: null,
        limitSource: null,
        limitEpisodeStartedAt: null,
        limitProbeRunId: null,
        authSuspectAt: null,
      });
      expect((await runRow(held.successorRunId!)).scheduledRetryAt!.getTime()).toBeLessThanOrEqual(now.getTime() + 120_000);
      const [ended] = await db.select().from(resourceWaitEpisodes).where(eq(resourceWaitEpisodes.id, probeEpisode!.id));
      expect(ended).toMatchObject({ resolution: "resolved" });

      // Nothing to clear, nothing to wake.
      const plain = await run(worker, { status: "succeeded" });
      await db.update(heartbeatRuns).set({ contextSnapshot: { aiConnection: { mode: "pool_account", accountId: pool.id, runId: plain.id } } }).where(eq(heartbeatRuns.id, plain.id));
      expect(await accounts.noteAccountRunSucceeded({ run: await runRow(plain.id), now })).toEqual({ cleared: false, woken: 0, episodeResolved: false });
    });

    /** An account under the single probe (an estimated limit passed, two strikes), and a finished probe that held it with its own wait episode. */
    async function endedProbe(end: Partial<typeof heartbeatRuns.$inferInsert>) {
      const now = new Date();
      const { worker, pool } = await poolFixture({
        accountOverrides: {
          exhaustedUntil: at(now, -60_000),
          limitSource: "estimated",
          limitReason: "provider_quota",
          limitStrikes: 2,
          limitEpisodeStartedAt: at(now, -3 * HOUR),
          authSuspectAt: at(now, -HOUR),
        },
      });
      const id = randomUUID();
      const probe = await run(worker, {
        id,
        finishedAt: now,
        contextSnapshot: { aiConnection: { mode: "pool_account", accountId: pool.id, runId: id } },
        ...end,
      });
      await db.update(aiAccounts).set({ limitProbeRunId: id }).where(eq(aiAccounts.id, pool.id));
      const [episode] = await db.insert(resourceWaitEpisodes).values({
        companyId: worker.companyId,
        agentId: worker.id,
        kind: "ai_account",
        reason: "usage_limit",
        scope: "account",
        resourceKey: `account:${pool.id}`,
        accountId: pool.id,
        since: at(now, -2 * HOUR),
        currentRunId: id,
      }).returning();
      return { now, worker, pool, probe, episode: episode! };
    }

    async function episodeRow(id: string) {
      const [row] = await db.select().from(resourceWaitEpisodes).where(eq(resourceWaitEpisodes.id, id));
      return row!;
    }

    const served = { inputTokens: 1200, cachedInputTokens: 0, outputTokens: 80 };

    it("treats a probe that failed or timed out for another reason after the provider served it as a success", async () => {
      for (const end of [
        { status: "failed", errorCode: "max_turns_exhausted", error: "Claude stopped after the maximum number of turns", usageJson: served },
        { status: "timed_out", errorCode: "acpx_timeout", error: "Timed out after 600s", usageJson: { inputTokens: 0, cachedInputTokens: 900, outputTokens: 0 } },
        // A limit phrase only in the transcript is no limit (W16), and the provider served the run.
        { status: "failed", errorCode: "claude_transient_upstream", resultJson: { errorFamily: "transient_upstream", classificationSource: "transcript" }, usageJson: { ...served, costUsd: 0.02 } },
      ] as const) {
        const { accounts, resourceWaits } = service();
        const { now, worker, pool, probe, episode } = await endedProbe(end);
        // Another agent's run waits for the account.
        const other = await agent(worker.companyId);
        await bind(other, pool.id);
        const held = await resourceWaits.scheduleResourceWait({
          run: await failedPoolRun({ worker: other, poolId: pool.id }),
          wait: accountWaitDeferral({ reason: "usage_limit", accountId: pool.id, accountLabel: pool.label, resumeAt: at(now, HOUR) }).wait,
          now,
          releaseIfUnscheduled: false,
        });
        const outcome = await accounts.noteAccountRunSucceeded({ run: await runRow(probe.id), now });
        expect(outcome).toMatchObject({ cleared: true, episodeResolved: true });
        expect(outcome.woken).toBeGreaterThanOrEqual(1);
        expect(await accountRow(pool.id)).toMatchObject({
          limitStrikes: 0,
          exhaustedUntil: null,
          limitSource: null,
          limitEpisodeStartedAt: null,
          limitProbeRunId: null,
          authSuspectAt: null,
        });
        expect((await runRow(held.successorRunId!)).scheduledRetryAt!.getTime()).toBeLessThanOrEqual(now.getTime() + 120_000);
        expect(await episodeRow(episode.id)).toMatchObject({ resolution: "resolved" });
      }
    });

    it("changes nothing for a cancelled probe, a limit, a sign-in failure, or a failure before the provider served the run", async () => {
      for (const end of [
        // A stop after provider work, and a wait's deferral.
        { status: "cancelled", usageJson: served },
        { status: "cancelled", errorCode: "ai_account_unavailable" },
        // No tokens: a workspace or spawn failure, an unreachable provider, a timeout that recorded no usage.
        { status: "failed", errorCode: "workspace_unavailable", error: "The workspace could not be prepared" },
        { status: "failed", errorCode: null, error: "API Error: Connection error.", resultJson: { type: "result", is_error: true }, usageJson: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } },
        { status: "timed_out", errorCode: "timeout", error: "Timed out after 600s" },
        // The limit and sign-in handlers own these.
        { status: "failed", errorCode: "provider_quota", resultJson: { errorFamily: "provider_quota" }, usageJson: served },
        { status: "failed", errorCode: "claude_auth_required", usageJson: served },
        { status: "failed", errorCode: "device_slots_full", usageJson: served },
        { status: "interrupted", usageJson: served },
      ] as const) {
        const { accounts } = service();
        const { now, pool, probe, episode } = await endedProbe(end);
        const before = await accountRow(pool.id);
        expect(await accounts.noteAccountRunSucceeded({ run: await runRow(probe.id), now })).toEqual({ cleared: false, woken: 0, episodeResolved: false });
        expect(await accountRow(pool.id)).toEqual(before);
        expect(await episodeRow(episode.id)).toMatchObject({ resolvedAt: null });
      }
    });

    it("ends a lane run's wait when it no longer carries a pool attribution", async () => {
      const { accounts } = service();
      // The agent was moved to its device's own login while the run waited.
      const { now, pool, probe, episode } = await endedProbe({ status: "succeeded", contextSnapshot: {} });
      const before = await accountRow(pool.id);
      expect(await accounts.noteAccountRunSucceeded({ run: await runRow(probe.id), now })).toEqual({ cleared: false, woken: 0, episodeResolved: true });
      expect(await accountRow(pool.id)).toEqual(before);
      expect(await episodeRow(episode.id)).toMatchObject({ resolution: "resolved" });
      expect(await db.select().from(resourceWaitEpisodes).where(isNull(resourceWaitEpisodes.resolvedAt))).toEqual([]);
    });

    it("keeps a typed reset that is still ahead", async () => {
      const { accounts } = service();
      const now = new Date();
      const reset = at(now, HOUR);
      const { worker, pool } = await poolFixture({ accountOverrides: { exhaustedUntil: reset, limitSource: "provider", limitStrikes: 1 } });
      const done = await run(worker, { status: "succeeded" });
      await db.update(heartbeatRuns).set({ contextSnapshot: { aiConnection: { mode: "pool_account", accountId: pool.id, runId: done.id } } }).where(eq(heartbeatRuns.id, done.id));
      await accounts.noteAccountRunSucceeded({ run: await runRow(done.id), now });
      expect(await accountRow(pool.id)).toMatchObject({ exhaustedUntil: reset, limitSource: "provider", limitStrikes: 0 });
    });
  });

  // -------------------------------------------------------------------------

  describe("handleRunAuthFailure", () => {
    const authFailure = (worker: AgentRow, poolId: string, resultJson: Record<string, unknown> = {}) =>
      failedPoolRun({ worker, poolId, errorCode: "claude_auth_required", error: "Invalid API key · Please run /login", resultJson });

    it("only suspects on the first untyped failure, and marks the account on a second failure of another run within 2 h", async () => {
      const { accounts, calls } = service();
      const { worker, pool } = await poolFixture();
      const now = new Date();
      const first = await authFailure(worker, pool.id);
      const suspected = await accounts.handleRunAuthFailure({ run: first, agent: worker, now });
      expect(suspected).toMatchObject({ handled: true, reason: "auth_unconfirmed" });
      const afterFirst = await accountRow(pool.id);
      expect(afterFirst).toMatchObject({ status: "active", authSuspectRunId: first.id });
      expect(afterFirst.authSuspectAt!.getTime()).toBe(now.getTime());
      const context = readResourceWaitContext((await runRow(suspected.successorRunId!)).contextSnapshot?.resourceWait);
      expect(context).toMatchObject({ reason: "auth_unconfirmed", resumeAtSource: "check" });
      expect(new Date(context!.resumeAt!).getTime()).toBe(now.getTime() + 10 * 60_000);

      // The same run again does not count as a second strike.
      expect(await accounts.handleRunAuthFailure({ run: first, agent: worker, now: at(now, 1000) })).toMatchObject({ reason: "auth_unconfirmed" });
      expect((await accountRow(pool.id)).status).toBe("active");

      const second = await authFailure(worker, pool.id);
      const marked = await accounts.handleRunAuthFailure({ run: second, agent: worker, now: at(now, 30 * 60_000) });
      expect(marked).toMatchObject({ handled: true, reason: "signed_out" });
      expect(await accountRow(pool.id)).toMatchObject({ status: "auth_failed", authSuspectAt: null, statusMessage: "Invalid API key · Please run /login" });
      expect(await db.select().from(activityLog).where(eq(activityLog.action, "ai_account.signed_out"))).toHaveLength(1);
      expect(calls.notices).toEqual([]);
    });

    it("signs the account out when two runs' untyped sign-in failures are handled at the same time", async () => {
      const { accounts } = service();
      const { worker, pool, companyId } = await poolFixture();
      const other = await agent(companyId);
      await bind(other, pool.id);
      const now = new Date();
      const first = await authFailure(worker, pool.id);
      const second = await authFailure(other, pool.id);
      const outcomes = await Promise.all([
        accounts.handleRunAuthFailure({ run: first, agent: worker, now }),
        accounts.handleRunAuthFailure({ run: second, agent: other, now }),
      ]);
      expect(outcomes.map((outcome) => outcome.reason).sort()).toEqual(["auth_unconfirmed", "signed_out"]);
      expect(outcomes.every((outcome) => outcome.handled)).toBe(true);
      expect(await accountRow(pool.id)).toMatchObject({ status: "auth_failed", authSuspectAt: null, authSuspectRunId: null });
      expect(await db.select().from(activityLog).where(and(eq(activityLog.action, "ai_account.signed_out"), eq(activityLog.entityId, pool.id))))
        .toHaveLength(1);
    });

    it("marks the account at once on a typed 401, and suspects again after the 2 h window", async () => {
      const { accounts } = service();
      const { worker, pool } = await poolFixture();
      expect(await accounts.handleRunAuthFailure({ run: await authFailure(worker, pool.id, { api_error_status: 401 }), agent: worker }))
        .toMatchObject({ reason: "signed_out" });
      expect((await accountRow(pool.id)).status).toBe("auth_failed");

      const { worker: worker2, pool: pool2 } = await poolFixture();
      const now = new Date();
      await accounts.handleRunAuthFailure({ run: await authFailure(worker2, pool2.id), agent: worker2, now });
      expect(await accounts.handleRunAuthFailure({ run: await authFailure(worker2, pool2.id), agent: worker2, now: at(now, 3 * HOUR) }))
        .toMatchObject({ reason: "auth_unconfirmed" });
      expect((await accountRow(pool2.id)).status).toBe("active");
    });

    it("leaves a transcript-only match and a non-pool run to the normal path", async () => {
      const { accounts } = service();
      const { worker, pool } = await poolFixture();
      expect(await accounts.handleRunAuthFailure({ run: await authFailure(worker, pool.id), agent: worker, provenance: { classificationSource: "transcript" } }))
        .toMatchObject({ handled: false, reason: "transcript_only" });
      expect((await accountRow(pool.id)).authSuspectAt).toBeNull();
      const plainRun = await run(worker, { status: "failed", errorCode: "claude_auth_required" });
      expect(await accounts.handleRunAuthFailure({ run: plainRun, agent: worker })).toMatchObject({ handled: false, reason: "not_pool_run" });
    });
  });

  // -------------------------------------------------------------------------

  describe("handleCompanyPoolLimit", () => {
    async function companyPoolRun(input: { resetAt: Date }) {
      const { worker, companyId } = await poolFixture();
      const [application] = await db.insert(toolApplications).values({
        companyId, applicationKey: `ai-${tag()}`, name: "Claude", type: "rest_api", status: "active",
      }).returning();
      const [connection] = await db.insert(toolConnections).values({
        companyId, applicationId: application!.id, name: "Claude Max", uid: `claude-${tag()}`, connectionPurpose: "ai", transport: "runtime_auth", status: "active", enabled: true,
      }).returning();
      const failed = await run(worker, {
        status: "failed",
        errorCode: "provider_quota",
        resultJson: { errorFamily: "provider_quota", providerQuotaRetryNotBefore: input.resetAt.toISOString() },
        contextSnapshot: { aiConnection: { mode: "company_pool", provider: "anthropic", connectionId: connection!.id, poolPriority: 0 } },
      });
      return { worker, companyId, connectionId: connection!.id, failed };
    }

    it("marks the member exhausted and waits in ai_connection_pool_wait until its reset", async () => {
      const { accounts, calls } = service();
      const now = new Date();
      const reset = at(now, 3 * HOUR);
      const { worker, companyId, connectionId, failed } = await companyPoolRun({ resetAt: reset });
      const outcome = await accounts.handleProviderLimit({ run: failed, agent: worker, now });
      expect(outcome).toMatchObject({ handled: true, via: "company_pool" });
      const [state] = await db.select().from(aiConnectionQuotaStates)
        .where(and(eq(aiConnectionQuotaStates.companyId, companyId), eq(aiConnectionQuotaStates.connectionId, connectionId)));
      expect(state).toMatchObject({ exhaustedUntil: reset, reason: "provider_quota", source: "run_failure", lastRunId: failed.id });
      expect(calls.scheduled).toHaveLength(1);
      expect(calls.scheduled[0]).toMatchObject({ retryReason: "ai_connection_pool_wait", wakeReason: "ai_connection_pool_retry" });
      expect(calls.scheduled[0]!.delayMs).toBe(3 * HOUR + resourceWaitJitterMs(failed.id));
      expect(await db.select().from(activityLog).where(eq(activityLog.action, "ai_connection.pool_limit_reached"))).toHaveLength(1);
    });

    it("waits for the member's later stored reset", async () => {
      const { accounts, calls } = service();
      const now = new Date();
      const { worker, companyId, connectionId, failed } = await companyPoolRun({ resetAt: at(now, HOUR) });
      await db.insert(aiConnectionQuotaStates).values({ companyId, connectionId, exhaustedUntil: at(now, 5 * HOUR), reason: "provider_quota", source: "run_failure" });
      const outcome = await accounts.handleCompanyPoolLimit({ run: failed, agent: worker, now });
      expect(outcome.until!.getTime()).toBe(now.getTime() + 5 * HOUR);
      expect(calls.scheduled[0]!.delayMs).toBe(5 * HOUR + resourceWaitJitterMs(failed.id));
    });
  });

});
