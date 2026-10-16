import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  aiAccountAgentBindings,
  aiAccountHostEnvironments,
  aiAccountHosts,
  aiAccountRunSlots,
  aiAccounts,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  environmentAvailability,
  environments,
  heartbeatRuns,
  instanceSettings,
  issues,
  plugins,
  projects,
  resourceWaitEpisodes,
} from "@paperclipai/db";
import type { PluginEnvironmentTargetReport } from "@paperclipai/plugin-sdk";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  acceptedCredentialTypes,
  boundAccountsByDevice,
  candidateDevicesForAgent,
  candidateEnvironmentIds,
  capOf,
  deviceForEnvironment,
  devicesForEnvironmentIds,
  detailForCompany,
  environmentsForDevice,
  environmentsMatchingTarget,
  executionDeviceService,
  insertRunSlot,
  isSoleProviderPlugin,
  likelyDuplicates,
  linkTarget,
  markOverLimitIfNeeded,
  parsePluginTargetKey,
  pluginTargetKey,
  pruneRunSlots,
  runningPoolAccountsOnDevice,
  soleProviderPlugin,
  sshHostOfDeviceKey,
  summariesForCompany,
  summariesForInstance,
  targetAvailabilityOf,
  upsertPluginTargetByTargetKey,
  wouldExceedDeviceCap,
} from "../services/execution-devices.js";
import {
  availabilityBackoffMs,
  clipAvailabilityLabel,
  clipAvailabilityMessage,
  environmentAvailabilityService,
  isAvailabilityCheckDue,
  isFreshlyUnavailable,
  nextAvailabilityCheckAt,
} from "../services/environment-availability.js";

const now = new Date("2026-10-16T12:00:00.000Z");
const minutes = (n: number) => new Date(now.getTime() + n * 60_000);

describe("execution device helpers", () => {
  it("caps a device at min(max_accounts, 3) and lets a running account in without a new slot", () => {
    expect(capOf({ maxAccounts: 3 })).toBe(3);
    expect(capOf({ maxAccounts: 1 })).toBe(1);
    expect(capOf({ maxAccounts: 9 })).toBe(3);
    const inUse = new Set(["a", "b", "c"]);
    expect(wouldExceedDeviceCap({ cap: 3, inUse, accountId: "d" })).toBe(true);
    expect(wouldExceedDeviceCap({ cap: 3, inUse, accountId: "a" })).toBe(false);
    expect(wouldExceedDeviceCap({ cap: 3, inUse: new Set(["a"]), accountId: "d" })).toBe(false);
  });

  it("builds and parses plugin target keys and SSH device keys", () => {
    const pluginId = "6f1e7c9a-3b2d-4c5e-8f90-1a2b3c4d5e6f";
    const key = pluginTargetKey(pluginId, "box", "device:42");
    expect(key).toBe(`target:${pluginId}:box:device:42`);
    expect(parsePluginTargetKey(key)).toEqual({ pluginId, provider: "box", targetKey: "device:42" });
    expect(parsePluginTargetKey("ssh:host:22")).toBeNull();
    expect(sshHostOfDeviceKey("ssh:runner.example.com:22")).toBe("runner.example.com");
    expect(sshHostOfDeviceKey("ssh:fe80::1:2222")).toBe("fe80::1");
    expect(sshHostOfDeviceKey("local")).toBeNull();
  });

  it("accepts any credential on Local and SSH, and only what a fresh sandbox report lists", () => {
    const fresh = { targetReportedAt: minutes(-5), targetState: { state: "available", acceptedCredentialTypes: ["api_key", "subscription"] } };
    expect(acceptedCredentialTypes({ driver: "local" }, null, now)).toBeNull();
    expect(acceptedCredentialTypes({ driver: "ssh" }, null, now)).toBeNull();
    expect(acceptedCredentialTypes({ driver: "sandbox" }, fresh, now)).toEqual(["subscription", "api_key"]);
    // A report older than 15 minutes, a report without a list, or no device means subscription only.
    expect(acceptedCredentialTypes({ driver: "sandbox" }, { ...fresh, targetReportedAt: minutes(-16) }, now)).toEqual(["subscription"]);
    expect(acceptedCredentialTypes({ driver: "sandbox" }, { targetReportedAt: minutes(-1), targetState: { state: "available" } }, now)).toEqual(["subscription"]);
    expect(acceptedCredentialTypes({ driver: "sandbox" }, null, now)).toEqual(["subscription"]);
  });

  it("backs off from 30 s to 10 min with ±20 % jitter, never before retryAfter", () => {
    expect(availabilityBackoffMs(0, () => 0.5)).toBe(30_000);
    expect(availabilityBackoffMs(0, () => 0)).toBe(24_000);
    expect(availabilityBackoffMs(0, () => 1)).toBe(36_000);
    expect(availabilityBackoffMs(3, () => 0.5)).toBe(240_000);
    expect(availabilityBackoffMs(5, () => 0.5)).toBe(600_000);
    expect(availabilityBackoffMs(40, () => 1)).toBe(720_000);
    expect(nextAvailabilityCheckAt({ failures: 0, now, random: () => 0.5 })).toEqual(new Date(now.getTime() + 30_000));
    expect(nextAvailabilityCheckAt({ failures: 0, now, retryAfter: minutes(20), random: () => 0.5 })).toEqual(minutes(20));
  });

  it("trusts an unavailable row for 10 minutes and treats a NULL next check as due", () => {
    const row = { state: "unavailable" as const, checkedAt: now, nextCheckAt: null };
    expect(isFreshlyUnavailable(row, minutes(10))).toBe(true);
    expect(isFreshlyUnavailable(row, minutes(11))).toBe(false);
    expect(isFreshlyUnavailable({ ...row, state: "available" }, now)).toBe(false);
    expect(isAvailabilityCheckDue(row, now)).toBe(true);
    expect(isAvailabilityCheckDue({ nextCheckAt: minutes(5) }, now)).toBe(false);
    expect(isAvailabilityCheckDue({ nextCheckAt: minutes(5) }, minutes(5))).toBe(true);
  });

  it("cleans and clips labels and messages", () => {
    expect(clipAvailabilityLabel(`  Build\u0000 box\u202E ${"x".repeat(200)}`)!.length).toBeLessThanOrEqual(80);
    expect(clipAvailabilityLabel("  Build\n\tbox  ")).toBe("Build box");
    expect(clipAvailabilityLabel("   ")).toBeNull();
    const message = clipAvailabilityMessage(`line one\r\nline two ${"y".repeat(600)}`)!;
    expect(message.length).toBeLessThanOrEqual(300);
    expect(message.startsWith("line one line two")).toBe(true);
    expect(clipAvailabilityMessage(42)).toBeNull();
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres execution device tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("execution devices (database)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let localEnvironment: typeof environments.$inferSelect;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-execution-devices-");
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

  async function company(name = `Company ${tag()}`) {
    const id = randomUUID();
    await db.insert(companies).values({ id, name, issuePrefix: `C${id.replaceAll("-", "").slice(0, 7).toUpperCase()}` });
    return id;
  }

  async function user(id: string, email = `${id}@example.com`) {
    const at = new Date();
    await db.insert(authUsers).values({ id, name: `User ${id}`, email, emailVerified: true, createdAt: at, updatedAt: at });
    return id;
  }

  async function member(companyId: string, userId: string) {
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
  }

  async function agent(companyId: string, overrides: Partial<typeof agents.$inferInsert> = {}) {
    const [row] = await db.insert(agents).values({ companyId, name: `Agent ${tag()}`, adapterType: "claude_local", ...overrides }).returning();
    return row!;
  }

  async function environment(driver: "ssh" | "sandbox", config: Record<string, unknown>, overrides: Partial<typeof environments.$inferInsert> = {}) {
    const [row] = await db.insert(environments).values({ name: `${driver} ${tag()}`, driver, config, ...overrides }).returning();
    return row!;
  }

  async function plugin(provider: string, pluginKey = `test.${provider}.${tag()}`) {
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

  async function account(ownerUserId: string | null, label = `Account ${tag()}`) {
    const [row] = await db.insert(aiAccounts).values({
      credentialType: "subscription",
      label,
      ownerUserId,
      createdByUserId: ownerUserId,
      credentialMaterial: { provider: "local_encrypted", ciphertext: tag() },
      credentialFingerprint: randomUUID(),
    }).returning();
    return row!;
  }

  async function bind(agentRow: { id: string; companyId: string }, accountId: string | null, mode: "pool_account" | "device_login" = "pool_account") {
    await db.insert(aiAccountAgentBindings).values({ agentId: agentRow.id, companyId: agentRow.companyId, mode, accountId });
  }

  async function run(agentRow: { id: string; companyId: string }, status: string, overrides: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const [row] = await db.insert(heartbeatRuns).values({ companyId: agentRow.companyId, agentId: agentRow.id, status, ...overrides }).returning();
    return row!;
  }

  function report(overrides: Partial<PluginEnvironmentTargetReport> = {}): PluginEnvironmentTargetReport {
    return {
      targetKey: "d-1",
      label: "Build box",
      configMatch: { deviceId: "d-1" },
      state: "available",
      acceptedCredentialTypes: ["subscription", "api_key"],
      ...overrides,
    };
  }

  async function device(id: string) {
    const [row] = await db.select().from(aiAccountHosts).where(eq(aiAccountHosts.id, id));
    return row ?? null;
  }

  describe("device of an environment", () => {
    it("maps the Local environment to the server device, a pool device created once", async () => {
      const server = await deviceForEnvironment(db, localEnvironment);
      expect(server).toMatchObject({ kind: "server", externalKey: "local", name: "Paperclip server" });
      expect((await deviceForEnvironment(db, localEnvironment))!.id).toBe(server!.id);
      expect(acceptedCredentialTypes(localEnvironment, server, now)).toBeNull();
      const companyId = await company();
      const builder = await agent(companyId);
      const candidates = await candidateDevicesForAgent(db, builder);
      expect(candidates.map((candidate) => [candidate.environmentId, candidate.device?.id])).toEqual([[localEnvironment.id, server!.id]]);
    });

    it("keys SSH devices as migration 0310 does and names new ones after the environment", async () => {
      // A device whose key the 0310 backfill set.
      const [mini] = await db.insert(aiAccountHosts).values({ name: "Mini", kind: "mac", externalKey: "ssh:mini.example.com:2222" }).returning();
      const tunnel = await environment("ssh", { host: " MINI.example.com ", port: "2222", username: "runner" });
      expect((await deviceForEnvironment(db, tunnel))!.id).toBe(mini!.id);

      const first = await environment("ssh", { host: "Runner.Example.com" });
      const created = await deviceForEnvironment(db, first);
      expect(created).toMatchObject({ kind: "ssh_host", externalKey: "ssh:runner.example.com:22", name: `SSH · ${first.name}` });
      const second = await environment("ssh", { host: "runner.example.com", port: 22 });
      expect((await deviceForEnvironment(db, second))!.id).toBe(created!.id);

      // No usable host means no device.
      expect(await deviceForEnvironment(db, await environment("ssh", { host: "   " }))).toBeNull();
      expect(await deviceForEnvironment(db, await environment("ssh", { host: "box.example.com", port: "22a" }))).toBeNull();

      // Names stay unique with a suffix.
      const clash = await environment("ssh", { host: "other.example.com" });
      await db.insert(aiAccountHosts).values({ name: `SSH · ${clash.name}`, kind: "ssh_host" });
      expect(await deviceForEnvironment(db, clash)).toMatchObject({ name: `SSH · ${clash.name} (2)`, externalKey: "ssh:other.example.com:22" });

      // Without `create`, an unseen host stays deviceless.
      const unseen = await environment("ssh", { host: "unseen.example.com" });
      expect(await deviceForEnvironment(db, unseen, { create: false })).toBeNull();
      expect(await db.select().from(aiAccountHosts).where(eq(aiAccountHosts.externalKey, "ssh:unseen.example.com:22"))).toEqual([]);
    });

    it("lets an explicit mapping win over a derived key", async () => {
      const ssh = await environment("ssh", { host: "runner.example.com" });
      const derived = await deviceForEnvironment(db, ssh);
      const [tunnel] = await db.insert(aiAccountHosts).values({ name: "Mapped tunnel", kind: "mac" }).returning();
      await db.insert(aiAccountHostEnvironments).values({ environmentId: ssh.id, hostId: tunnel!.id });
      expect((await deviceForEnvironment(db, ssh))!.id).toBe(tunnel!.id);
      expect((await environmentsForDevice(db, tunnel!.id)).map((entry) => [entry.environment.id, entry.via])).toEqual([[ssh.id, "mapping"]]);
      expect(await environmentsForDevice(db, derived!.id)).toEqual([]);
      expect((await devicesForEnvironmentIds(db, [ssh.id, randomUUID()])).get(ssh.id)!.id).toBe(tunnel!.id);
    });

    it("matches sandbox environments to targets of the provider's only installed plugin", async () => {
      const provider = await plugin("box");
      const ownerId = await user("owner-1");
      const result = await upsertPluginTargetByTargetKey(db, {
        pluginId: provider.id,
        provider: "box",
        target: report({ ownerUserId: ownerId, servedCompanyIds: ["c-1"], aliases: ["Mini.Example.com"] }),
        now,
      });
      expect(result).toMatchObject({ created: true, reclaimed: false });
      expect(result.device).toMatchObject({
        kind: "external",
        name: "Build box",
        targetKey: pluginTargetKey(provider.id, "box", "d-1"),
        targetProvider: "box",
        targetMatch: { deviceId: "d-1" },
        managedByPluginId: provider.id,
        ownerUserId: ownerId,
        ownerSource: "plugin",
      });
      expect(result.state).toMatchObject({ state: "available", servedCompanyIds: ["c-1"], aliases: ["mini.example.com"], acceptedCredentialTypes: ["subscription", "api_key"] });

      const sandbox = await environment("sandbox", { provider: "box", deviceId: "d-1", reuseLease: true });
      const other = await environment("sandbox", { provider: "box", deviceId: "d-2" });
      const unknownProvider = await environment("sandbox", { provider: "elsewhere", deviceId: "d-1" });
      const mapped = await executionDeviceService(db).devicesForEnvironments([sandbox, other, unknownProvider]);
      expect(mapped.get(sandbox.id)!.id).toBe(result.device.id);
      expect(mapped.get(other.id)).toBeNull();
      expect(mapped.get(unknownProvider.id)).toBeNull();
      expect(acceptedCredentialTypes(sandbox, mapped.get(sandbox.id), minutes(10))).toEqual(["subscription", "api_key"]);
      expect(acceptedCredentialTypes(sandbox, mapped.get(sandbox.id), minutes(16))).toEqual(["subscription"]);
      expect((await environmentsMatchingTarget(db, { provider: "box", match: { deviceId: "d-1" }, deviceId: result.device.id })).map((row) => row.id))
        .toEqual([sandbox.id]);

      // A second plugin declaring the same provider makes the provider ambiguous.
      expect(await isSoleProviderPlugin(db, provider.id, "box")).toBe(true);
      const rival = await plugin("box");
      expect(await soleProviderPlugin(db, "box")).toBeNull();
      expect(await isSoleProviderPlugin(db, provider.id, "box")).toBe(false);
      expect(await deviceForEnvironment(db, sandbox)).toBeNull();
      await db.update(plugins).set({ status: "uninstalled" }).where(eq(plugins.id, rival.id));
      expect((await deviceForEnvironment(db, sandbox))!.id).toBe(result.device.id);

      // An unknown owner leaves the device unowned.
      const unowned = await upsertPluginTargetByTargetKey(db, { pluginId: provider.id, provider: "box", target: report({ ownerUserId: "ghost" }), now });
      expect(unowned.device).toMatchObject({ ownerUserId: null, ownerSource: null });
      expect(unowned.changes.ownerChanged).toBe(true);
    });

    it("writes a target's state only where it is the most specific match", async () => {
      const provider = await plugin("box");
      const upsert = (targetKey: string, configMatch: Record<string, string>) =>
        upsertPluginTargetByTargetKey(db, { pluginId: provider.id, provider: "box", target: report({ targetKey, label: targetKey, configMatch }), now });
      const broad = (await upsert("pool-a", { pool: "a" })).device;
      const narrow = (await upsert("pool-a-host-b", { pool: "a", host: "b" })).device;
      const onNarrow = await environment("sandbox", { provider: "box", pool: "a", host: "b" });
      const onBroad = await environment("sandbox", { provider: "box", pool: "a", host: "c" });
      // A mapping places an environment for the cap; its leases still reach the target its config names.
      const [tunnel] = await db.insert(aiAccountHosts).values({ name: "Tunnel", kind: "mac" }).returning();
      const mapped = await environment("sandbox", { provider: "box", pool: "a", host: "b" });
      await db.insert(aiAccountHostEnvironments).values({ environmentId: mapped.id, hostId: tunnel!.id });
      expect((await deviceForEnvironment(db, onNarrow))!.id).toBe(narrow.id);
      expect((await deviceForEnvironment(db, mapped))!.id).toBe(tunnel!.id);

      const ids = async (match: Record<string, string>, deviceId: string) =>
        (await environmentsMatchingTarget(db, { provider: "box", match, deviceId })).map((row) => row.id).sort();
      expect(await ids({ pool: "a" }, broad.id)).toEqual([onBroad.id]);
      expect(await ids({ pool: "a", host: "b" }, narrow.id)).toEqual([onNarrow.id, mapped.id].sort());
      expect(await ids({ pool: "a" }, tunnel!.id)).toEqual([]);
    });

    it("reports what changed between two target reports", async () => {
      const provider = await plugin("box");
      const upsert = (target: PluginEnvironmentTargetReport, at = now) =>
        upsertPluginTargetByTargetKey(db, { pluginId: provider.id, provider: "box", target, now: at });
      const first = await upsert(report({ state: "unavailable", reason: "offline", message: "Asleep\u0000 since noon", acceptedCredentialTypes: undefined }));
      expect(first.state).toMatchObject({ state: "unavailable", reason: "offline", message: "Asleep since noon", acceptedCredentialTypes: null });
      expect(first.acceptedCredentialTypes.after).toEqual(["subscription"]);
      const back = await upsert(report({ acceptedCredentialTypes: ["subscription", "api_key"] }), minutes(1));
      expect(back.created).toBe(false);
      expect(back.device.id).toBe(first.device.id);
      expect(back.changes).toMatchObject({ becameAvailable: true, acceptedCredentialTypesChanged: true, configMatchChanged: false, ownerChanged: false });
      const ownerId = await user("owner-2");
      const ownerOnly = await upsert(report({ ownerUserId: ownerId }), minutes(2));
      expect(ownerOnly.changes).toEqual({
        becameAvailable: false,
        becameUnavailable: false,
        becameRetired: false,
        acceptedCredentialTypesChanged: false,
        configMatchChanged: false,
        ownerChanged: true,
      });
      const moved = await upsert(report({ configMatch: { deviceId: "d-1", slot: "a" }, ownerUserId: ownerId }), minutes(3));
      expect(moved.changes.configMatchChanged).toBe(true);
      const retired = await upsert(report({ retired: true, ownerUserId: ownerId }), minutes(4));
      expect(retired.changes.becameRetired).toBe(true);
      expect(targetAvailabilityOf(retired.device, minutes(4))).toMatchObject({ state: "retired", label: "Build box", targetKey: retired.device.targetKey });
    });
  });

  describe("candidates and bound accounts", () => {
    it("follows the run-time environment fallback for unpinned agents", async () => {
      const companyId = await company();
      const otherCompanyId = await company();
      const companyDefault = await environment("ssh", { host: "company.example.com" });
      const projectDefault = await environment("ssh", { host: "project.example.com" });
      const archivedDefault = await environment("ssh", { host: "archived.example.com" });
      const foreign = await environment("ssh", { host: "foreign.example.com" }, { companyId: otherCompanyId });
      const instanceDefault = await environment("ssh", { host: "instance.example.com" });
      await db.insert(projects).values([
        { companyId, name: "Live", defaultEnvironmentId: projectDefault.id },
        { companyId, name: "Archived", defaultEnvironmentId: archivedDefault.id, archivedAt: now },
        { companyId, name: "Foreign default", defaultEnvironmentId: foreign.id },
        { companyId, name: "No default" },
      ]);
      const unpinned = await agent(companyId);
      expect(await candidateEnvironmentIds(db, unpinned)).toEqual([projectDefault.id, localEnvironment.id]);
      await db.insert(instanceSettings).values({ singletonKey: "default", defaultEnvironmentId: instanceDefault.id });
      expect(await candidateEnvironmentIds(db, unpinned)).toEqual([projectDefault.id, instanceDefault.id]);
      await db.update(companies).set({ defaultEnvironmentId: companyDefault.id }).where(eq(companies.id, companyId));
      expect(await candidateEnvironmentIds(db, unpinned)).toEqual([projectDefault.id, companyDefault.id]);
      // A pin is the only candidate, and a proposed pin can be evaluated before it is written.
      expect(await candidateEnvironmentIds(db, { ...unpinned, defaultEnvironmentId: foreign.id })).toEqual([foreign.id]);
      const devices = await candidateDevicesForAgent(db, unpinned);
      expect(devices.map((candidate) => candidate.device?.externalKey)).toEqual(["ssh:project.example.com:22", "ssh:company.example.com:22"]);
    });

    it("counts every company's pool bindings on a device, without terminated or device-login agents", async () => {
      const companyA = await company();
      const companyB = await company();
      const [x, y, w, z, v] = await Promise.all(["X", "Y", "W", "Z", "V"].map((label) => account(null, label)));
      const a1 = await agent(companyA);
      const b1 = await agent(companyB, { defaultEnvironmentId: localEnvironment.id });
      const a2 = await agent(companyA);
      const terminated = await agent(companyA, { status: "terminated" });
      const ownLogin = await agent(companyA);
      const paused = await agent(companyB, { status: "paused" });
      // Moved to an adapter that runs only locally: its binding applies again once it moves back.
      const otherAdapter = await agent(companyA, { adapterType: "process" });
      const unassigned = await agent(companyB);
      await bind(a1, x!.id);
      await bind(b1, y!.id);
      await bind(a2, y!.id);
      await bind(terminated, z!.id);
      await bind(ownLogin, null, "device_login");
      await bind(paused, w!.id);
      await bind(otherAdapter, v!.id);
      await bind(unassigned, null);

      const server = (await deviceForEnvironment(db, localEnvironment))!;
      const bound = await boundAccountsByDevice(db);
      expect([...bound.get(server.id)!.accountIds].sort()).toEqual([x!.id, y!.id, w!.id, v!.id].sort());
      expect(bound.get(server.id)!.bindings).toHaveLength(5);
      const withoutA1 = await boundAccountsByDevice(db, { deviceIds: [server.id], excludeAgentId: a1.id });
      expect([...withoutA1.get(server.id)!.accountIds].sort()).toEqual([y!.id, w!.id, v!.id].sort());

      // A project default adds that project's device to every unpinned agent of the company, the
      // agent on another adapter included: it is placed as a claude_local agent would be.
      const ssh = await environment("ssh", { host: "project.example.com" });
      await db.insert(projects).values({ companyId: companyA, name: "Remote", defaultEnvironmentId: ssh.id });
      const sshDevice = (await deviceForEnvironment(db, ssh))!;
      const afterProject = await boundAccountsByDevice(db, { deviceIds: [sshDevice.id, server.id] });
      expect([...afterProject.get(sshDevice.id)!.accountIds].sort()).toEqual([x!.id, y!.id, v!.id].sort());
      expect(afterProject.get(server.id)!.accountIds.size).toBe(4);

      // Lowering the cap below the bound accounts flags the device once; making room clears the flag.
      await db.update(aiAccountHosts).set({ maxAccounts: 2 }).where(eq(aiAccountHosts.id, server.id));
      const [flagged] = await markOverLimitIfNeeded(db, [server.id], { now });
      expect(flagged).toMatchObject({ deviceId: server.id, limit: 2, inUse: 4, overLimit: true, change: "flagged", overLimitAt: now });
      expect(flagged!.companyIds).toEqual([companyA, companyB].sort());
      expect((await markOverLimitIfNeeded(db, [server.id], { now: minutes(1) }))[0]).toMatchObject({ overLimit: true, change: null, overLimitAt: now });
      await db.update(aiAccountHosts).set({ maxAccounts: 3 }).where(eq(aiAccountHosts.id, server.id));
      expect((await markOverLimitIfNeeded(db, [server.id], { now: minutes(2) }))[0]).toMatchObject({ inUse: 4, overLimit: true, change: null });
      await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, otherAdapter.id));
      expect((await markOverLimitIfNeeded(db, null, { now: minutes(3) })).find((check) => check.deviceId === server.id))
        .toMatchObject({ inUse: 3, overLimit: false, change: "cleared", overLimitAt: null });
      expect((await device(server.id))!.overLimitAt).toBeNull();
    });
  });

  describe("running set and slots", () => {
    it("counts slots of running runs and legacy host-pool runs in flight", async () => {
      const companyId = await company();
      const builder = await agent(companyId);
      const server = (await deviceForEnvironment(db, localEnvironment))!;
      const [elsewhere] = await db.insert(aiAccountHosts).values({ name: "Elsewhere", kind: "ssh_host" }).returning();
      const [x, y, z, q] = await Promise.all(["X", "Y", "Z", "Q"].map((label) => account(null, label)));

      const running = await run(builder, "running");
      const finished = await run(builder, "succeeded", { finishedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });
      const recent = await run(builder, "failed", { finishedAt: new Date() });
      await insertRunSlot(db, { runId: running.id, companyId, deviceId: server.id, accountId: q!.id });
      // A re-acquire by the same run replaces its slot.
      await insertRunSlot(db, { runId: running.id, companyId, deviceId: server.id, accountId: x!.id });
      await insertRunSlot(db, { runId: finished.id, companyId, deviceId: server.id, accountId: y!.id });
      await insertRunSlot(db, { runId: recent.id, companyId, deviceId: server.id, accountId: y!.id });
      const hostPool = (accountId: string, hostId: string) => ({ contextSnapshot: { aiConnection: { mode: "host_pool", accountId, hostId, scope: "shared" } } });
      const legacy = await run(builder, "running", hostPool(z!.id, server.id));
      await run(builder, "queued", hostPool(y!.id, server.id));
      await run(builder, "running", hostPool(y!.id, elsewhere!.id));
      // A copied pool attribution never counts: only slots do.
      await run(builder, "running", { contextSnapshot: { aiConnection: { mode: "pool_account", accountId: y!.id, hostId: server.id, runId: randomUUID() } } });

      expect([...await runningPoolAccountsOnDevice(db, server.id)].sort()).toEqual([x!.id, z!.id].sort());
      expect([...await runningPoolAccountsOnDevice(db, server.id, running.id)]).toEqual([z!.id]);
      expect([...await runningPoolAccountsOnDevice(db, server.id, legacy.id)]).toEqual([x!.id]);
      expect([...await runningPoolAccountsOnDevice(db, elsewhere!.id)]).toEqual([y!.id]);

      expect(await pruneRunSlots(db)).toBe(1);
      const slots = await db.select({ runId: aiAccountRunSlots.runId, accountId: aiAccountRunSlots.accountId }).from(aiAccountRunSlots);
      expect(slots.map((slot) => slot.runId).sort()).toEqual([running.id, recent.id].sort());
      expect(slots.find((slot) => slot.runId === running.id)!.accountId).toBe(x!.id);
    });
  });

  describe("plugin target linking", () => {
    it("merges an earlier external target row into an existing SSH-reached device, and later reports update that row", async () => {
      const companyId = await company();
      const builder = await agent(companyId);
      const provider = await plugin("box");
      const [tunnel] = await db.insert(aiAccountHosts).values({ name: "Mini", kind: "mac", externalKey: "ssh:mini.example.com:22" }).returning();
      const external = (await upsertPluginTargetByTargetKey(db, {
        pluginId: provider.id,
        provider: "box",
        target: report({ aliases: ["mini.example.com"] }),
        now,
      })).device;
      const mappedSandbox = await environment("sandbox", { provider: "box", deviceId: "d-9" });
      await db.insert(aiAccountHostEnvironments).values({ environmentId: mappedSandbox.id, hostId: external.id });
      const pooled = await account(null);
      const active = await run(builder, "running");
      await insertRunSlot(db, { runId: active.id, companyId, deviceId: external.id, accountId: pooled!.id });
      const [episode] = await db.insert(resourceWaitEpisodes).values({
        companyId,
        agentId: builder.id,
        kind: "environment",
        reason: "offline",
        scope: "target",
        resourceKey: `environment:${mappedSandbox.id}`,
        environmentId: mappedSandbox.id,
        deviceId: external.id,
        since: now,
      }).returning();

      const linked = await linkTarget(db, tunnel!.id, { pluginId: provider.id, provider: "box", targetKey: "d-1" }, { now: minutes(1) });
      expect(linked).toMatchObject({ changed: true, mergedDeviceIds: [external.id] });
      expect(linked.limit).toMatchObject({ deviceId: tunnel!.id, limit: 3, inUse: 0, overLimit: false, change: null });
      expect(linked.device).toMatchObject({
        id: tunnel!.id,
        kind: "mac",
        name: "Mini",
        externalKey: "ssh:mini.example.com:22",
        targetKey: pluginTargetKey(provider.id, "box", "d-1"),
        targetProvider: "box",
        targetMatch: { deviceId: "d-1" },
        managedByPluginId: provider.id,
      });
      expect(await device(external.id)).toBeNull();
      expect((await db.select().from(aiAccountHostEnvironments).where(eq(aiAccountHostEnvironments.environmentId, mappedSandbox.id)))[0]!.hostId).toBe(tunnel!.id);
      expect((await db.select().from(aiAccountRunSlots).where(eq(aiAccountRunSlots.runId, active.id)))[0]!.deviceId).toBe(tunnel!.id);
      expect((await db.select().from(resourceWaitEpisodes).where(eq(resourceWaitEpisodes.id, episode!.id)))[0]!.deviceId).toBe(tunnel!.id);
      expect([...await runningPoolAccountsOnDevice(db, tunnel!.id)]).toEqual([pooled!.id]);
      const sandbox = await environment("sandbox", { provider: "box", deviceId: "d-1" });
      expect((await deviceForEnvironment(db, sandbox))!.id).toBe(tunnel!.id);

      // The next report updates the linked row instead of inserting an external one.
      const reported = await upsertPluginTargetByTargetKey(db, { pluginId: provider.id, provider: "box", target: report({ state: "unavailable", reason: "offline" }), now: minutes(2) });
      expect(reported).toMatchObject({ created: false, reclaimed: false });
      expect(reported.device.id).toBe(tunnel!.id);
      expect(reported.changes.becameUnavailable).toBe(true);
      expect(await db.select().from(aiAccountHosts).where(eq(aiAccountHosts.kind, "external"))).toEqual([]);

      // Linking again is a no-op; other targets and other devices are refused.
      expect(await linkTarget(db, tunnel!.id, { pluginId: provider.id, provider: "box", targetKey: "d-1" })).toMatchObject({ changed: false, mergedDeviceIds: [] });
      await expect(linkTarget(db, tunnel!.id, { pluginId: provider.id, provider: "box", targetKey: "d-2" })).rejects.toMatchObject({ status: 409 });
      const [otherTunnel] = await db.insert(aiAccountHosts).values({ name: "Other", kind: "mac" }).returning();
      await expect(linkTarget(db, otherTunnel!.id, { pluginId: provider.id, provider: "box", targetKey: "d-1" })).rejects.toMatchObject({ status: 409 });
      await expect(linkTarget(db, otherTunnel!.id, { pluginId: randomUUID(), provider: "box", targetKey: "d-3" })).rejects.toMatchObject({ status: 404 });
      await expect(linkTarget(db, otherTunnel!.id, { pluginId: provider.id, provider: "other", targetKey: "d-3" })).rejects.toMatchObject({ status: 404 });
      const server = (await deviceForEnvironment(db, localEnvironment))!;
      await expect(linkTarget(db, server.id, { pluginId: provider.id, provider: "box", targetKey: "d-3" })).rejects.toMatchObject({ status: 409 });
      await expect(linkTarget(db, randomUUID(), { pluginId: provider.id, provider: "box", targetKey: "d-3" })).rejects.toMatchObject({ status: 404 });
    });

    it("lets a reinstalled plugin re-claim its targets, but never an installed plugin's", async () => {
      const original = await plugin("box", "test.box");
      const first = await upsertPluginTargetByTargetKey(db, { pluginId: original.id, provider: "box", target: report({ targetKey: "d-7", configMatch: { deviceId: "d-7" } }), now });
      // Removed with its data, then installed again: a new plugin id.
      await db.delete(plugins).where(eq(plugins.id, original.id));
      const reinstalled = await plugin("box", "test.box");
      const again = await upsertPluginTargetByTargetKey(db, { pluginId: reinstalled.id, provider: "box", target: report({ targetKey: "d-7", configMatch: { deviceId: "d-7" } }), now: minutes(1) });
      expect(again).toMatchObject({ created: false, reclaimed: true });
      expect(again.device).toMatchObject({ id: first.device.id, name: "Build box", targetKey: pluginTargetKey(reinstalled.id, "box", "d-7"), managedByPluginId: reinstalled.id });
      expect(again.changes.configMatchChanged).toBe(true);

      // A plugin that is still installed keeps its row.
      const rival = await plugin("box");
      const separate = await upsertPluginTargetByTargetKey(db, { pluginId: rival.id, provider: "box", target: report({ targetKey: "d-7", configMatch: { deviceId: "d-7" } }), now: minutes(2) });
      expect(separate).toMatchObject({ created: true, reclaimed: false });
      expect(separate.device.id).not.toBe(first.device.id);
      expect(separate.device.name).toBe("Build box (2)");
      expect((await device(first.device.id))!.managedByPluginId).toBe(reinstalled.id);
    });

    it("flags an external device whose alias or label matches an SSH device as a likely duplicate", async () => {
      const provider = await plugin("box");
      const [mini] = await db.insert(aiAccountHosts).values({ name: "Mini", kind: "mac", externalKey: "ssh:mini.example.com:22" }).returning();
      const studioEnvironment = await environment("ssh", { host: "10.0.0.7" }, { name: "Studio" });
      const studio = (await deviceForEnvironment(db, studioEnvironment))!;
      const byAlias = (await upsertPluginTargetByTargetKey(db, { pluginId: provider.id, provider: "box", target: report({ aliases: ["mini.example.com"] }), now })).device;
      const byLabel = (await upsertPluginTargetByTargetKey(db, { pluginId: provider.id, provider: "box", target: report({ targetKey: "d-2", label: "studio", configMatch: { deviceId: "d-2" } }), now })).device;
      const gone = (await upsertPluginTargetByTargetKey(db, { pluginId: provider.id, provider: "box", target: report({ targetKey: "d-3", label: "Studio", configMatch: { deviceId: "d-3" }, retired: true }), now })).device;
      const hints = await likelyDuplicates(db);
      expect(hints.get(byAlias.id)).toEqual([{ deviceId: mini!.id, deviceName: "Mini", matchedBy: "alias" }]);
      expect(hints.get(mini!.id)).toEqual([{ deviceId: byAlias.id, deviceName: byAlias.name, matchedBy: "alias" }]);
      expect(hints.get(byLabel.id)).toEqual([{ deviceId: studio.id, deviceName: studio.name, matchedBy: "label" }]);
      expect(hints.get(gone.id)).toBeUndefined();
      // Once linked, the machine is no longer suggested.
      await linkTarget(db, mini!.id, { pluginId: provider.id, provider: "box", targetKey: "d-1" });
      const after = await likelyDuplicates(db);
      expect(after.get(mini!.id)).toBeUndefined();
      expect(after.get(studio.id)).toEqual([{ deviceId: byLabel.id, deviceName: byLabel.name, matchedBy: "label" }]);
    });
  });

  describe("availability registry", () => {
    it("keeps the outage start, backs off, and trusts a row for 10 minutes", async () => {
      const ssh = await environment("ssh", { host: "runner.example.com" });
      const registry = environmentAvailabilityService(db);
      const first = await registry.markUnavailable(ssh.id, { reason: "unreachable", source: "lease_error", label: "Runner", now, random: () => 0.5 });
      expect(first).toMatchObject({ previousState: null, state: "unavailable", changed: true, becameUnavailable: true });
      expect(first!.row).toMatchObject({ unavailableSince: now, checkedAt: now, checkFailures: 0, nextCheckAt: new Date(now.getTime() + 30_000), source: "lease_error" });
      expect(isFreshlyUnavailable(first!.row, minutes(10))).toBe(true);
      expect(isFreshlyUnavailable(first!.row, minutes(11))).toBe(false);

      const second = await registry.recordCheckFailure(ssh.id, { now: minutes(1), random: () => 0.5 });
      expect(second).toMatchObject({ changed: false });
      expect(second!.row).toMatchObject({ unavailableSince: now, checkedAt: minutes(1), checkFailures: 1, reason: "unreachable", label: "Runner", source: "check" });
      expect(second!.row.nextCheckAt).toEqual(new Date(minutes(1).getTime() + 60_000));
      // An admission reason is one run's wait, not the target's outage: no writer records it.
      const epoch = await registry.readWakeEpoch(ssh.id);
      expect(await registry.markUnavailable(ssh.id, { reason: "not_serving", source: "lease_error", now: minutes(2) })).toBeNull();
      expect(await registry.recordCheckFailure(ssh.id, { reason: "throttled", now: minutes(2) })).toBeNull();
      expect(await registry.applyTargetState([ssh.id], { state: "unavailable", reason: "stopped" }, { now: minutes(2) })).toEqual([]);
      expect(await registry.get(ssh.id)).toMatchObject({ reason: "unreachable", checkFailures: 1, checkedAt: minutes(1) });
      expect(await registry.readWakeEpoch(ssh.id)).toBe(epoch);
      const quiet = await environment("ssh", { host: "quiet-admission.example.com" });
      expect(await registry.markUnavailable(quiet.id, { reason: "busy", source: "lease_error", now })).toBeNull();
      expect(await registry.get(quiet.id)).toBeNull();
      // An unknown reason is recorded as `other`; retryAfter delays the next check.
      const third = await registry.markUnavailable(ssh.id, { reason: "lost-signal", source: "probe", retryAfter: minutes(30), now: minutes(2) });
      expect(third!.row).toMatchObject({ reason: "other", checkFailures: 2, retryAfter: minutes(30), nextCheckAt: minutes(30) });
      expect((await registry.markUnavailable(ssh.id, { reason: "other", source: "probe", now: minutes(3) }))!.row.reason).toBe("other");
    });

    it("treats a NULL next check as due and honours force", async () => {
      const registry = environmentAvailabilityService(db);
      const due = await environment("ssh", { host: "due.example.com" });
      const later = await environment("ssh", { host: "later.example.com" });
      const healthy = await environment("ssh", { host: "healthy.example.com" });
      await registry.markUnavailable(due.id, { reason: "offline", source: "lease_error", now });
      await registry.markUnavailable(later.id, { reason: "offline", source: "lease_error", now, retryAfter: minutes(60) });
      await registry.bumpEpoch([healthy.id], { now });
      await db.update(environmentAvailability).set({ nextCheckAt: null }).where(eq(environmentAvailability.environmentId, due.id));
      expect((await registry.dueChecks({ now: minutes(1) })).map((row) => row.environmentId)).toEqual([due.id]);
      expect((await registry.dueChecks({ now: minutes(1), force: true })).map((row) => row.environmentId).sort()).toEqual([due.id, later.id].sort());
      expect(await registry.dueChecks({ now: minutes(1), withWaitsOnly: true })).toEqual([]);
      // A deferral against an unavailable row makes it due now.
      expect(await registry.setDueNow([later.id, healthy.id], { now: minutes(2) })).toBe(1);
      expect((await registry.dueChecks({ now: minutes(2) })).map((row) => row.environmentId).sort()).toEqual([due.id, later.id].sort());
    });

    it("bumps the wake epoch on every write, also across a delete and a re-insert", async () => {
      const registry = environmentAvailabilityService(db);
      const ssh = await environment("ssh", { host: "epoch.example.com" });
      expect(await registry.readWakeEpoch(ssh.id)).toBe(0);
      const epochs: number[] = [];
      const record = async () => epochs.push(await registry.readWakeEpoch(ssh.id));
      await registry.markUnavailable(ssh.id, { reason: "offline", source: "lease_error", now });
      await record();
      await registry.recordCheckFailure(ssh.id, { now });
      await record();
      await registry.setDueNow([ssh.id], { now });
      await record();
      await registry.bumpEpoch([ssh.id], { now });
      await record();
      const available = await registry.markAvailable(ssh.id, { source: "lease_error", now });
      expect(available.changed).toBe(true);
      await record();
      await registry.applyTargetState([ssh.id], { state: "unavailable", reason: "paused" }, { now });
      await record();
      await registry.markRetired([ssh.id], { now });
      await record();
      await registry.applyTargetState([ssh.id], { state: "available" }, { now });
      await record();
      for (let index = 1; index < epochs.length; index += 1) expect(epochs[index]!).toBeGreaterThan(epochs[index - 1]!);
      // Without a due row, setDueNow writes nothing; without bumpEpoch it leaves the epoch.
      const before = await registry.readWakeEpoch(ssh.id);
      expect(await registry.setDueNow([ssh.id], { now })).toBe(0);
      await registry.markUnavailable(ssh.id, { reason: "offline", source: "lease_error", now });
      const marked = await registry.readWakeEpoch(ssh.id);
      expect(marked).toBeGreaterThan(before);
      await registry.setDueNow([ssh.id], { now, bumpEpoch: false });
      expect(await registry.readWakeEpoch(ssh.id)).toBe(marked);
      // A deleted and re-created row still moves forward.
      expect(await registry.deleteIfNoWaits(ssh.id)).toBe(true);
      expect(await registry.readWakeEpoch(ssh.id)).toBe(0);
      const recreated = await registry.bumpEpoch([ssh.id], { now });
      expect(recreated.get(ssh.id)!).toBeGreaterThan(marked);
      expect(await registry.get(ssh.id)).toMatchObject({ state: "available", source: "check" });
    });

    it("writes only real transitions to available, and keeps retired rows", async () => {
      const registry = environmentAvailabilityService(db);
      const ssh = await environment("ssh", { host: "retired.example.com" });
      expect(await registry.markAvailable(ssh.id, { source: "lease_error", now })).toEqual({ changed: false, result: null });
      expect(await registry.get(ssh.id)).toBeNull();
      // A wait may still name a deleted environment: writes for it are skipped.
      const deleted = randomUUID();
      expect(await registry.markUnavailable(deleted, { reason: "offline", source: "lease_error", now })).toBeNull();
      expect(await registry.bumpEpoch([deleted], { now })).toEqual(new Map());
      expect(await registry.markRetired([deleted], { now })).toEqual([]);
      const [retired] = await registry.markRetired([ssh.id], { label: "Old mini", message: "Removed from the fleet", now });
      expect(retired).toMatchObject({ previousState: null, state: "retired", becameRetired: true });
      expect(await registry.markUnavailable(ssh.id, { reason: "offline", source: "lease_error", now })).toBeNull();
      expect(await registry.recordCheckFailure(ssh.id, { now })).toBeNull();
      expect((await registry.markAvailable(ssh.id, { source: "check", now })).changed).toBe(false);
      expect(await registry.deleteIfNoWaits(ssh.id)).toBe(false);
      expect(await registry.deleteRowsWithoutWaits({ now })).toEqual([]);
      expect((await registry.get(ssh.id))!.state).toBe("retired");
      // Only a report brings the target back.
      const [back] = await registry.applyTargetState([ssh.id], { state: "available", acceptedCredentialTypes: ["subscription"] }, { now });
      expect(back).toMatchObject({ previousState: "retired", state: "available", becameAvailable: true, acceptedCredentialTypesChanged: true });
      expect(back!.row).toMatchObject({ label: "Old mini", acceptedCredentialTypes: ["subscription"], checkFailures: 0, nextCheckAt: null });
    });

    it("deletes a row only once no open environment wait references it", async () => {
      const registry = environmentAvailabilityService(db);
      const companyId = await company();
      const builder = await agent(companyId);
      const ssh = await environment("ssh", { host: "waits.example.com" });
      const quiet = await environment("ssh", { host: "quiet.example.com" });
      await registry.markUnavailable(ssh.id, { reason: "offline", source: "lease_error", now });
      await registry.markUnavailable(quiet.id, { reason: "offline", source: "lease_error", now });
      const [episode] = await db.insert(resourceWaitEpisodes).values({
        companyId,
        agentId: builder.id,
        kind: "environment",
        reason: "offline",
        scope: "target",
        resourceKey: `environment:${ssh.id}`,
        environmentId: ssh.id,
        since: now,
      }).returning();
      expect((await registry.dueChecks({ now: minutes(5), withWaitsOnly: true })).map((row) => row.environmentId)).toEqual([ssh.id]);
      expect(await registry.deleteIfNoWaits(ssh.id)).toBe(false);
      expect(await registry.deleteRowsWithoutWaits({ now: minutes(5), minAgeMs: 10 * 60_000 })).toEqual([]);
      expect(await registry.deleteRowsWithoutWaits({ now: minutes(5) })).toEqual([quiet.id]);
      await db.update(resourceWaitEpisodes).set({ resolvedAt: minutes(6), resolution: "resolved" }).where(eq(resourceWaitEpisodes.id, episode!.id));
      expect(await registry.deleteIfNoWaits(ssh.id)).toBe(true);
      expect(await registry.get(ssh.id)).toBeNull();
    });

    it("cleans text in every writer and seeds rows from a stored report", async () => {
      const registry = environmentAvailabilityService(db);
      const provider = await plugin("box");
      const ssh = await environment("ssh", { host: "text.example.com" });
      const longLabel = `Build\u0007 ${"m".repeat(200)}`;
      const longMessage = `Offline\u0000\nsince ${"z".repeat(600)}`;
      await registry.markUnavailable(ssh.id, { reason: "offline", source: "lease_error", label: longLabel, message: longMessage, targetKey: "bad key with spaces", now });
      const row = (await registry.get(ssh.id))!;
      expect(row.label!.length).toBeLessThanOrEqual(80);
      expect(row.label!.startsWith("Build m")).toBe(true);
      expect(row.message!.length).toBeLessThanOrEqual(300);
      expect(row.message!.startsWith("Offline since")).toBe(true);
      expect(row.targetKey).toBeNull();
      await registry.applyTargetState([ssh.id], { state: "unavailable", label: longLabel, message: longMessage, reason: "offline" }, { now });
      expect((await registry.get(ssh.id))!.label!.length).toBeLessThanOrEqual(80);

      const reported = await upsertPluginTargetByTargetKey(db, {
        pluginId: provider.id,
        provider: "box",
        target: report({ state: "unavailable", reason: "maintenance", message: longMessage, acceptedCredentialTypes: ["subscription"] }),
        now: minutes(-20),
      });
      const sandbox = await environment("sandbox", { provider: "box", deviceId: "d-1" });
      const seeded = await registry.seedFromTarget(sandbox.id, targetAvailabilityOf(reported.device, now), { now });
      expect(seeded!.row).toMatchObject({
        state: "unavailable",
        reason: "maintenance",
        label: "Build box",
        targetKey: reported.device.targetKey,
        acceptedCredentialTypes: ["subscription"],
        checkedAt: minutes(-20),
        source: "plugin_report",
      });
      expect(seeded!.row.message!.length).toBeLessThanOrEqual(300);
      // A stale report is never trusted by preflight.
      expect(isFreshlyUnavailable(seeded!.row, now)).toBe(false);
      expect(await registry.seedFromTarget(sandbox.id, null)).toBeNull();
    });
  });

  describe("summaries", () => {
    it("never returns another company's account labels", async () => {
      const companyA = await company("Alpha Co");
      const companyB = await company("Bravo Co");
      const userA = await user("user-a");
      const userB = await user("user-b");
      await member(companyA, userA);
      await member(companyB, userB);
      const alpha = await account(userA, "Alpha secret label");
      const bravo = await account(userB, "Bravo private label");
      const a1 = await agent(companyA, { name: "Alpha builder" });
      const a2 = await agent(companyA, { name: "Alpha reviewer" });
      const b1 = await agent(companyB, { name: "Bravo builder" });
      await bind(a1, alpha!.id);
      await bind(a2, bravo!.id);
      await bind(b1, bravo!.id);
      const server = (await deviceForEnvironment(db, localEnvironment))!;

      const provider = await plugin("box");
      const ownerId = await user("device-owner", "device-owner@example.com");
      const pluginDevice = (await upsertPluginTargetByTargetKey(db, {
        pluginId: provider.id,
        provider: "box",
        target: report({ ownerUserId: ownerId, servedCompanyIds: [companyA.toUpperCase()] }),
        now,
      })).device;
      // Company B also has an agent pinned to an SSH host no device exists for yet.
      const bravoHost = await environment("ssh", { host: "bravo.example.com" }, { companyId: companyB });
      await agent(companyB, { name: "Bravo remote", defaultEnvironmentId: bravoHost.id });
      const issueId = randomUUID();
      await db.insert(issues).values({ id: issueId, companyId: companyA, title: "Waiting task", identifier: `ALP-${tag()}` });
      const waiting = await run(a1, "scheduled_retry");
      await db.insert(resourceWaitEpisodes).values({
        companyId: companyA,
        agentId: a1.id,
        issueId,
        kind: "device_slots",
        reason: "slots_full",
        scope: "device",
        resourceKey: `device:${server.id}`,
        deviceId: server.id,
        currentRunId: waiting.id,
        since: now,
      });

      const forA = await summariesForCompany(db, companyA, { now });
      expect(forA.map((summary) => summary.id).sort()).toEqual([server.id, pluginDevice.id].sort());
      const serverForA = forA.find((summary) => summary.id === server.id)!;
      expect(serverForA).toMatchObject({ kind: "server", limit: 3, inUse: 2, otherCompaniesAccounts: 1, ownLoginAgents: 0, waitingCount: 1, overLimit: false });
      expect(serverForA.accounts).toEqual([{ id: alpha!.id, label: "Alpha secret label", credentialType: "subscription", state: "active" }]);
      expect(serverForA.agents.map((entry) => [entry.agentName, entry.accountId])).toEqual([["Alpha builder", alpha!.id], ["Alpha reviewer", null]]);
      expect(serverForA.environments.map((entry) => [entry.id, entry.explicit])).toEqual([[localEnvironment.id, false]]);
      expect(JSON.stringify(forA)).not.toContain("Bravo private label");
      expect(JSON.stringify(forA)).not.toContain(bravo!.id);
      // Reading company A's devices never creates company B's.
      expect(await db.select().from(aiAccountHosts).where(eq(aiAccountHosts.externalKey, "ssh:bravo.example.com:22"))).toEqual([]);
      const pluginForA = forA.find((summary) => summary.id === pluginDevice.id)!;
      expect(pluginForA).toMatchObject({
        kind: "external",
        managedByPluginName: "Plugin box",
        owner: { userId: ownerId, name: "User device-owner", email: "device-owner@example.com" },
        acceptedCredentialTypes: ["subscription", "api_key"],
        availability: { state: "available" },
      });

      const forB = await summariesForCompany(db, companyB, { now });
      const bravoDevice = (await db.select().from(aiAccountHosts).where(eq(aiAccountHosts.externalKey, "ssh:bravo.example.com:22")))[0]!;
      expect(forB.map((summary) => summary.id).sort()).toEqual([server.id, bravoDevice.id].sort());
      const serverForB = forB.find((summary) => summary.id === server.id)!;
      expect(serverForB).toMatchObject({ inUse: 2, otherCompaniesAccounts: 1, waitingCount: 0 });
      expect(serverForB.accounts.map((entry) => entry.label)).toEqual(["Bravo private label"]);
      expect(forB.find((summary) => summary.id === bravoDevice.id)).toMatchObject({ name: `SSH · ${bravoHost.name}`, inUse: 0, ownLoginAgents: 1 });
      expect(JSON.stringify(forB)).not.toContain("Alpha secret label");
      expect(await detailForCompany(db, companyB, pluginDevice.id, { now })).toBeNull();

      const detail = (await detailForCompany(db, companyA, server.id, { now }))!;
      expect(detail.waits).toEqual([expect.objectContaining({
        runId: waiting.id,
        agentId: a1.id,
        agentName: "Alpha builder",
        issueId,
        issueTitle: "Waiting task",
        kind: "device_slots",
        reason: "slots_full",
        since: now.toISOString(),
      })]);

      const instance = await summariesForInstance(db, { now });
      const serverForInstance = instance.find((summary) => summary.id === server.id)!;
      expect(serverForInstance.accounts.map((entry) => [entry.label, entry.owner?.userId])).toEqual([
        ["Alpha secret label", userA],
        ["Bravo private label", userB],
      ]);
      expect(serverForInstance.companies.map((entry) => [entry.companyName, entry.agentCount])).toEqual([["Alpha Co", 2], ["Bravo Co", 1]]);
      expect(serverForInstance).toMatchObject({ externalKey: "local", limit: 3, inUse: 2, maxAccounts: 3 });
      expect(instance.find((summary) => summary.id === pluginDevice.id)).toMatchObject({
        servedCompanyIds: [companyA.toUpperCase()],
        targetKey: pluginDevice.targetKey,
        owner: { userId: ownerId },
      });
    });

    it("shows a local board account's label in every company in local_trusted mode", async () => {
      const companyId = await company();
      await user("local-board");
      const local = await account("local-board", "Local board account");
      await bind(await agent(companyId), local!.id);
      expect((await summariesForCompany(db, companyId, { now }))[0]!.accounts).toEqual([]);
      const trusted = await summariesForCompany(db, companyId, { now, deploymentMode: "local_trusted" });
      expect(trusted[0]!.accounts.map((entry) => entry.label)).toEqual(["Local board account"]);
    });

    it("shows the longest outage of a device's environments on its badge", async () => {
      const companyId = await company();
      const ssh = await environment("ssh", { host: "badge.example.com" });
      await agent(companyId, { defaultEnvironmentId: ssh.id });
      const registry = environmentAvailabilityService(db);
      await registry.markUnavailable(ssh.id, { reason: "unreachable", source: "lease_error", label: "Badge", now });
      const [summary] = await summariesForCompany(db, companyId, { now });
      expect(summary).toMatchObject({ kind: "ssh_host", acceptedCredentialTypes: null });
      expect(summary!.availability).toMatchObject({ state: "unavailable", reason: "unreachable", unavailableSince: now.toISOString() });
      expect(summary!.environments[0]!.availability).toMatchObject({ state: "unavailable", acceptedCredentialTypes: null });
    });

    it("keeps an SSH row's label and message, which can name the host, to the instance view", async () => {
      const companyId = await company();
      const ssh = await environment("ssh", { host: "10.1.2.3", port: 2222 });
      await agent(companyId, { defaultEnvironmentId: ssh.id });
      const stderr = "ssh: connect to host 10.1.2.3 port 2222: Connection refused";
      await environmentAvailabilityService(db).markUnavailable(ssh.id, {
        reason: "unreachable",
        source: "lease_error",
        label: "10.1.2.3:2222",
        message: stderr,
        now,
      });

      const [summary] = await summariesForCompany(db, companyId, { now });
      expect(summary!.availability).toMatchObject({ state: "unavailable", reason: "unreachable", label: null, message: null, unavailableSince: now.toISOString() });
      expect(summary!.environments[0]!.availability).toMatchObject({ state: "unavailable", reason: "unreachable", label: null, message: null });
      const detail = await detailForCompany(db, companyId, summary!.id, { now });
      expect(detail!.environments[0]!.availability.message).toBeNull();
      expect(JSON.stringify([summary, detail])).not.toContain("10.1.2.3");

      const instance = (await summariesForInstance(db, { now })).find((entry) => entry.id === summary!.id)!;
      expect(instance.availability).toMatchObject({ label: "10.1.2.3:2222", message: stderr });
      expect(instance.environments[0]!.availability.message).toBe(stderr);
    });
  });

  it("tolerates open waits that point at a deleted device", async () => {
    // Episodes reference devices without a foreign key; deleting a device leaves the id dangling.
    const companyId = await company();
    const builder = await agent(companyId);
    const [gone] = await db.insert(aiAccountHosts).values({ name: "Gone", kind: "ssh_host" }).returning();
    await db.insert(resourceWaitEpisodes).values({
      companyId,
      agentId: builder.id,
      kind: "device_slots",
      reason: "slots_full",
      scope: "device",
      resourceKey: `device:${gone!.id}`,
      deviceId: gone!.id,
      since: now,
    });
    await db.delete(aiAccountHosts).where(eq(aiAccountHosts.id, gone!.id));
    expect(await summariesForCompany(db, companyId, { now })).toHaveLength(1);
    expect(await db.select().from(resourceWaitEpisodes).where(and(eq(resourceWaitEpisodes.companyId, companyId), isNull(resourceWaitEpisodes.resolvedAt)))).toHaveLength(1);
  });
});
