import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  chatEndpoints,
  companies,
  companyMemberships,
  createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  environments,
  principalPermissionGrants,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { voiceInboundService } from "../services/voice/voice-inbound-service.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) {
  console.warn(`Skipping embedded Postgres voice sandbox scope tests on this host: ${support.reason ?? "unsupported environment"}`);
}

// Fork: environments.company_id limits an environment to one company, so a phone
// line's low-trust sandbox choices are the shared sandboxes plus the company's own.
(support.supported ? describe : describe.skip)("voice phone line sandbox choices", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-voice-sandbox-scope-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await database?.cleanup(); });

  async function seedCompany(name: string) {
    const id = randomUUID();
    await db.insert(companies).values({ id, name, issuePrefix: `V${id.slice(0, 7).toUpperCase()}` });
    return id;
  }

  it("never lists another company's sandbox and refuses saving it", async () => {
    await instanceSettingsService(db).updateExperimental({ enableChatConnectors: true });
    const companyId = await seedCompany("Voice company");
    const otherCompanyId = await seedCompany("Other company");
    const callerId = randomUUID(), agentId = randomUUID(), applicationId = randomUUID(), connectionId = randomUUID(), endpointId = randomUUID();
    // A connection manager who is not an instance admin.
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: callerId, status: "active", membershipRole: "member" });
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: callerId, permissionKey: "tools:manage_connections" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Voice agent", role: "operator", status: "idle", adapterType: "paperclip_runner" });
    await db.insert(toolApplications).values({ id: applicationId, companyId, applicationKey: `chat:speko:${endpointId}`, name: "Speko", type: "chat", status: "active" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Speko", uid: endpointId, connectionPurpose: "channel", transport: "voice", config: { provider: "speko" }, status: "active", enabled: true });
    await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, provider: "speko", publicId: randomUUID(), assignedAgentId: agentId, status: "active", setup: { step: "complete", runtimeGeneration: 1 } });
    const shared = randomUUID(), own = randomUUID(), foreign = randomUUID();
    await db.insert(environments).values([
      { id: shared, name: "Shared sandbox", driver: "sandbox", config: { provider: "daytona" } },
      { id: own, name: "Own Mac", companyId, driver: "sandbox", config: { provider: "mac-fleet" } },
      { id: foreign, name: "Other company's Mac", companyId: otherCompanyId, driver: "sandbox", config: { provider: "mac-fleet" } },
    ]);
    const inbound = voiceInboundService(db, {
      allowLocalBoard: false,
      credentials: vi.fn(async () => ({ apiKey: "server-only-key", agentId: "agent_test" })),
      provider: (() => ({ listPhoneNumbers: vi.fn(async () => []) })) as never,
      start: vi.fn() as never,
      voicePrompt: "",
      lowTrustVoicePrompt: "",
    });
    const caller = { id: callerId, authority: "member" as const };

    const configuration = await inbound.configuration(companyId, endpointId, caller);
    expect(configuration.sandboxEnvironments).toEqual(expect.arrayContaining([
      { id: shared, name: "Shared sandbox" },
      { id: own, name: "Own Mac" },
    ]));
    expect(configuration.sandboxEnvironments.map((environment) => environment.id)).not.toContain(foreign);
    expect(JSON.stringify(configuration)).not.toContain("Other company's Mac");
    await expect(inbound.saveConfiguration(companyId, endpointId, caller, { numberId: "number", enabled: false, lowTrustEnvironmentId: foreign }))
      .rejects.toMatchObject({ status: 422, message: "Environment belongs to another company." });
  });
});
