import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { companies, createDb, environments, instanceSettings } from "@paperclipai/db";

// An empty Paperclip home, so the developer's adapter store (external overrides,
// disabled adapters) cannot change which runners are available here.
const harness = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const previousHome = process.env.PAPERCLIP_HOME;
  const home = mkdtempSync(join(tmpdir(), "paperclip-runner-target-"));
  process.env.PAPERCLIP_HOME = home;
  return { previousHome, home, ssh: vi.fn() };
});
vi.mock("@paperclipai/adapter-utils/ssh", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@paperclipai/adapter-utils/ssh")>()),
  runSshCommand: harness.ssh,
}));

import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { resolveAgentRunnerTargetForCompany, resolveNewAgentRunnerForCompany } from "../services/agent-runner-selection.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) {
  console.warn(`Skipping embedded Postgres runner target tests on this host: ${support.reason ?? "unsupported environment"}`);
}

const QUALIFIED = "Linux\nx86_64\nglibc\nglibc 2.41\n";
const OLD_GLIBC = "Linux\nx86_64\nglibc\nglibc 2.38\n";

// Fork: a new agent's runner is chosen for the environment its runs go to:
// its own pin, then the company default, then the instance default.
(support.supported ? describe : describe.skip)("runner target follows dispatch's environment order", () => {
  let db!: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  const platformByHost = new Map<string, string>();

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-runner-target-");
    db = createDb(database.connectionString);
  }, 120_000);

  beforeEach(() => {
    platformByHost.clear();
    harness.ssh.mockReset().mockImplementation(async (config: { host: string }) => {
      const stdout = platformByHost.get(config.host);
      if (stdout === undefined) throw new Error(`ssh: connect to host ${config.host}: Connection refused`);
      return { stdout, stderr: "", exitCode: 0 };
    });
  });

  afterEach(async () => {
    await db.update(companies).set({ defaultEnvironmentId: null });
    await db.delete(instanceSettings);
    await db.delete(environments);
    await db.delete(companies);
  });

  afterAll(async () => {
    await database?.cleanup();
    if (harness.previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = harness.previousHome;
    rmSync(harness.home, { recursive: true, force: true });
  });

  async function seedCompany(name: string) {
    const id = randomUUID();
    await db.insert(companies).values({ id, name, issuePrefix: `R${id.replace(/-/g, "").slice(0, 6).toUpperCase()}` });
    return id;
  }

  async function seedSshDevice(host: string, input: { companyId?: string | null; status?: string; platform?: string } = {}) {
    const id = randomUUID();
    await db.insert(environments).values({
      id,
      name: host,
      companyId: input.companyId ?? null,
      driver: "ssh",
      status: input.status ?? "active",
      config: { host, username: "paperclip", remoteWorkspacePath: "/workspace" },
    });
    if (input.platform) platformByHost.set(host, input.platform);
    return id;
  }

  const probedHosts = () => harness.ssh.mock.calls.map(([config]) => (config as { host: string }).host);

  it("chooses the Codex runner on the company default device ahead of the instance default", async () => {
    const companyId = await seedCompany("Acme");
    const companyDevice = await seedSshDevice("company-device.example.invalid", { platform: OLD_GLIBC });
    const instanceDevice = await seedSshDevice("instance-device.example.invalid", { platform: QUALIFIED });
    await db.update(companies).set({ defaultEnvironmentId: companyDevice }).where(eq(companies.id, companyId));
    await instanceSettingsService(db).update({ defaultEnvironmentId: instanceDevice });

    expect((await resolveNewAgentRunnerForCompany(db, companyId, { adapterType: "codex_local", defaultEnvironmentId: null })).adapterType).toBe("codex_local");
    // Discovery for an agent without its own environment uses the same device.
    expect(await resolveAgentRunnerTargetForCompany(db, companyId)).toMatchObject({ driver: "ssh", platform: "linux", glibcVersion: "glibc 2.38" });
    expect(probedHosts()).toEqual(["company-device.example.invalid", "company-device.example.invalid"]);

    // The agent's own environment still wins.
    expect((await resolveNewAgentRunnerForCompany(db, companyId, { adapterType: "codex_local", defaultEnvironmentId: instanceDevice })).adapterType).toBe("paperclip_runner");
  });

  it.each(["archived", "another company's"])("skips a company default the agent cannot use (%s) and uses the instance default", async (kind) => {
    const companyId = await seedCompany("Acme");
    const otherCompanyId = await seedCompany("Other");
    const companyDevice = await seedSshDevice("company-device.example.invalid", {
      platform: OLD_GLIBC,
      ...(kind === "archived" ? { status: "archived" } : { companyId: otherCompanyId }),
    });
    const instanceDevice = await seedSshDevice("instance-device.example.invalid", { platform: QUALIFIED });
    await db.update(companies).set({ defaultEnvironmentId: companyDevice }).where(eq(companies.id, companyId));
    await instanceSettingsService(db).update({ defaultEnvironmentId: instanceDevice });

    expect((await resolveNewAgentRunnerForCompany(db, companyId, { adapterType: "codex_local" })).adapterType).toBe("paperclip_runner");
    expect(probedHosts()).toEqual(["instance-device.example.invalid"]);
  });

  it("refuses another company's environment before resolving credentials or probing it", async () => {
    const companyId = await seedCompany("Acme");
    const otherCompanyId = await seedCompany("Other");
    const limited = await seedSshDevice("other-company-mac.example.invalid", { companyId: otherCompanyId, platform: QUALIFIED });
    const refusal = { status: 422, message: "Environment belongs to another company." };

    await expect(resolveNewAgentRunnerForCompany(db, companyId, { adapterType: "codex_local", defaultEnvironmentId: limited })).rejects.toMatchObject(refusal);
    await expect(resolveNewAgentRunnerForCompany(db, companyId, { adapterType: "claude_local", runner: "paperclip", defaultEnvironmentId: limited })).rejects.toMatchObject(refusal);
    await expect(resolveAgentRunnerTargetForCompany(db, companyId, limited)).rejects.toMatchObject(refusal);
    expect(harness.ssh).not.toHaveBeenCalled();
    // The owning company still reaches it.
    expect((await resolveNewAgentRunnerForCompany(db, otherCompanyId, { adapterType: "codex_local", defaultEnvironmentId: limited })).adapterType).toBe("paperclip_runner");
  });

  it("keeps a new Claude agent on Legacy without probing an offline company default", async () => {
    const companyId = await seedCompany("Acme");
    const offlineMac = await seedSshDevice("offline-mac.example.invalid");
    await db.update(companies).set({ defaultEnvironmentId: offlineMac }).where(eq(companies.id, companyId));

    for (const runner of [undefined, "auto"] as const) {
      expect(await resolveNewAgentRunnerForCompany(db, companyId, { adapterType: "claude_local", runner, adapterConfig: { model: "claude-opus-5-5" } }))
        .toEqual({ adapterType: "claude_local", adapterConfig: { model: "claude-opus-5-5" } });
    }
    expect(harness.ssh).not.toHaveBeenCalled();
    // An explicit Paperclip Runner choice is checked on that device.
    await expect(resolveNewAgentRunnerForCompany(db, companyId, { adapterType: "claude_local", runner: "paperclip" }))
      .rejects.toMatchObject({ status: 422, details: { code: "agent_runner_platform_probe_failed" } });
    expect(probedHosts()).toEqual(["offline-mac.example.invalid"]);
  });
});
