import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  environments,
  instanceSettings,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { environmentService } from "../services/environments.ts";
import { resolveInheritedEnvironmentDefaults } from "../services/environment-defaults.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres environment company scope tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("environment company scope", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof environmentService>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("environment-company-scope");
    stopDb = started.stop;
    db = createDb(started.connectionString);
    svc = environmentService(db);
  });

  afterEach(async () => {
    await db.delete(projects);
    await db.delete(agents);
    await db.update(companies).set({ defaultEnvironmentId: null });
    await db.delete(instanceSettings);
    await db.delete(environments);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany(name: string) {
    const id = randomUUID();
    await db.insert(companies).values({ id, name, issuePrefix: name.slice(0, 3).toUpperCase() });
    return id;
  }

  async function seedEnvironment(input: {
    name: string;
    companyId?: string | null;
    driver?: string;
    status?: string;
    config?: Record<string, unknown>;
  }) {
    const id = randomUUID();
    await db.insert(environments).values({
      id,
      name: input.name,
      companyId: input.companyId ?? null,
      driver: input.driver ?? "sandbox",
      status: input.status ?? "active",
      config: input.config ?? { provider: "mac-fleet", deviceId: input.name },
    });
    return id;
  }

  it("lists shared environments plus the company's own, never another company's", async () => {
    const acme = await seedCompany("Acme");
    const other = await seedCompany("Other");
    const shared = await seedEnvironment({ name: "shared-runner" });
    const acmeMac = await seedEnvironment({ name: "acme-mac", companyId: acme });
    const otherMac = await seedEnvironment({ name: "other-mac", companyId: other });

    const listed = (await svc.list(acme, {})).map((environment) => environment.id);
    const listedForOther = (await svc.list(other, {})).map((environment) => environment.id);
    const listedForInstance = (await svc.list({})).map((environment) => environment.id);

    expect(listed).toEqual(expect.arrayContaining([shared, acmeMac]));
    expect(listed).not.toContain(otherMac);
    expect(listedForOther).toEqual(expect.arrayContaining([shared, otherMac]));
    expect(listedForOther).not.toContain(acmeMac);
    // Without a company (instance-level callers) every environment is listed.
    expect(listedForInstance).toEqual(expect.arrayContaining([shared, acmeMac, otherMac]));
    const listedRows = await svc.list(acme, {});
    expect(listedRows.find((environment) => environment.id === acmeMac)?.companyId).toBe(acme);
  });

  it("counts what still points at an environment from outside a company", async () => {
    const acme = await seedCompany("Acme");
    const other = await seedCompany("Other");
    const shared = await seedEnvironment({ name: "shared-runner" });
    await db.insert(agents).values([
      { companyId: acme, name: "Acme agent", defaultEnvironmentId: shared },
      { companyId: other, name: "Other agent", defaultEnvironmentId: shared },
    ]);
    await db.insert(projects).values({ companyId: other, name: "Other project", defaultEnvironmentId: shared });
    await db.update(companies).set({ defaultEnvironmentId: shared });

    expect(await svc.countReferencesOutsideCompany(shared, acme)).toEqual({
      agents: 1,
      projects: 1,
      companies: 1,
      instanceDefault: false,
    });
  });

  it("resolves project and company defaults, skipping ones the agent cannot use", async () => {
    const acme = await seedCompany("Acme");
    const other = await seedCompany("Other");
    const acmeMac = await seedEnvironment({ name: "acme-mac", companyId: acme });
    const otherMac = await seedEnvironment({ name: "other-mac", companyId: other });
    const archived = await seedEnvironment({ name: "archived-runner", status: "archived" });
    const [project] = await db
      .insert(projects)
      .values({ companyId: acme, name: "iOS", defaultEnvironmentId: acmeMac })
      .returning();
    await db.update(companies).set({ defaultEnvironmentId: archived }).where(eq(companies.id, acme));

    expect(
      await resolveInheritedEnvironmentDefaults(db, svc, {
        companyId: acme,
        adapterType: "claude_local",
        projectId: project!.id,
      }),
    ).toEqual({ projectDefaultEnvironmentId: acmeMac, companyDefaultEnvironmentId: null });

    // Another company's device never becomes an inherited default.
    await db.update(projects).set({ defaultEnvironmentId: otherMac });
    expect(
      await resolveInheritedEnvironmentDefaults(db, svc, {
        companyId: acme,
        adapterType: "claude_local",
        projectId: project!.id,
      }),
    ).toEqual({ projectDefaultEnvironmentId: null, companyDefaultEnvironmentId: null });

    // A local-only adapter skips a remote company default.
    await db.update(companies).set({ defaultEnvironmentId: acmeMac }).where(eq(companies.id, acme));
    expect(
      await resolveInheritedEnvironmentDefaults(db, svc, { companyId: acme, adapterType: "http" }),
    ).toEqual({ projectDefaultEnvironmentId: null, companyDefaultEnvironmentId: null });
    expect(
      await resolveInheritedEnvironmentDefaults(db, svc, { companyId: acme, adapterType: "claude_local" }),
    ).toEqual({ projectDefaultEnvironmentId: null, companyDefaultEnvironmentId: acmeMac });
  });

  it("clears company and project defaults when their environment is deleted", async () => {
    const acme = await seedCompany("Acme");
    const mac = await seedEnvironment({ name: "acme-mac", companyId: acme });
    await db.insert(projects).values({ companyId: acme, name: "iOS", defaultEnvironmentId: mac });
    await db.update(companies).set({ defaultEnvironmentId: mac }).where(eq(companies.id, acme));

    await svc.remove(mac);

    const [company] = await db.select().from(companies);
    const [project] = await db.select().from(projects);
    expect(company?.defaultEnvironmentId).toBeNull();
    expect(project?.defaultEnvironmentId).toBeNull();
  });
});
