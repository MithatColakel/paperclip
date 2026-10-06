import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { environmentRoutes } from "../routes/environments.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  clearExecutionWorkspaceEnvironmentSelection: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  clearExecutionWorkspaceEnvironmentSelection: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  listCompanyIds: vi.fn(),
  getExperimental: vi.fn(),
}));

const mockEnvironmentService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  hasUnresolvedPendingCleanupLeases: vi.fn(),
  countReferencesOutsideCompany: vi.fn(),
}));

const mockEnvironmentCustomImageService = vi.hoisted(() => ({
  getOverview: vi.fn(),
  getActiveTemplate: vi.fn(),
  getSessionById: vi.fn(),
  startSetupSession: vi.fn(),
  refreshSetupSession: vi.fn(),
  finishSetupSession: vi.fn(),
  cancelSetupSession: vi.fn(),
  rollbackTemplate: vi.fn(),
  disableTemplate: vi.fn(),
  cleanupExpiredSetupSessions: vi.fn(),
}));

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  clearEnvironmentSelection: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

const mockSecretService = vi.hoisted(() => ({
  create: vi.fn(),
  normalizeEnvBindingsForPersistence: vi.fn(),
  listBindingCompanyIdsForTarget: vi.fn(),
  resolveSecretValueForEphemeralAccess: vi.fn(),
  syncEnvBindingsForTarget: vi.fn(),
  syncSecretRefsForTarget: vi.fn(),
  replaceSecretRefsForInstanceTarget: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  instanceSettingsService: () => mockInstanceSettingsService,
  environmentCustomImageService: () => mockEnvironmentCustomImageService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => mockEnvironmentService,
}));

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: () => mockExecutionWorkspaceService,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/plugin-environment-driver.js", () => ({
  // The runtime reads this published constant at import time. Mirror the real
  // value so the mocked module keeps the same reusable-lease method contract.
  REUSABLE_LEASE_WORKER_METHODS: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"],
  listReadyPluginEnvironmentDrivers: vi.fn(async () => []),
  resolvePluginSandboxProviderDriverByKey: vi.fn(async () => null),
  validatePluginEnvironmentDriverConfig: vi.fn(async ({ config }) => config),
  validatePluginSandboxProviderConfig: vi.fn(async ({ provider, config }) => ({
    normalizedConfig: config,
    pluginId: `plugin-${provider}`,
    pluginKey: `plugin.${provider}`,
    driver: {
      driverKey: provider,
      kind: "sandbox_provider",
      displayName: provider,
      configSchema: { type: "object" },
    },
  })),
  startPluginEnvironmentInteractiveSetup: vi.fn(),
  getPluginEnvironmentInteractiveSetup: vi.fn(),
  capturePluginEnvironmentTemplate: vi.fn(),
  cancelPluginEnvironmentInteractiveSetup: vi.fn(),
  deletePluginEnvironmentTemplate: vi.fn(),
}));

function createEnvironment(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-06-20T00:00:00.000Z");
  return {
    id: "env-1",
    name: "Local",
    description: "Default execution environment",
    driver: "local",
    status: "active" as const,
    config: {},
    envVars: {},
    metadata: { managedByPaperclip: true },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { actor: Record<string, unknown> }).actor = actor;
    next();
  });
  app.use("/api", environmentRoutes({
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  } as never));
  app.use(errorHandler);
  return app;
}

const OWNER_COMPANY_ID = "11111111-1111-4111-8111-111111111111";

describe("environment instance routes", () => {
  beforeEach(() => {
    mockIssueService.clearExecutionWorkspaceEnvironmentSelection.mockReset();
    mockProjectService.clearExecutionWorkspaceEnvironmentSelection.mockReset();
    mockInstanceSettingsService.listCompanyIds.mockReset();
    mockInstanceSettingsService.getExperimental.mockReset();
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableManagedSandboxOnly: false });
    mockEnvironmentService.list.mockReset();
    mockEnvironmentService.getById.mockReset();
    mockEnvironmentService.create.mockReset();
    mockEnvironmentService.update.mockReset();
    mockEnvironmentService.hasUnresolvedPendingCleanupLeases.mockReset();
    mockEnvironmentService.hasUnresolvedPendingCleanupLeases.mockResolvedValue(false);
    mockEnvironmentService.countReferencesOutsideCompany.mockReset();
    mockEnvironmentService.countReferencesOutsideCompany.mockResolvedValue({
      agents: 0,
      projects: 0,
      companies: 0,
      instanceDefault: false,
    });
    Object.values(mockEnvironmentCustomImageService).forEach((mock) => mock.mockReset());
    mockEnvironmentCustomImageService.getOverview.mockResolvedValue({
      activeTemplate: null,
      activeSession: null,
      latestSession: null,
    });
    mockEnvironmentCustomImageService.getActiveTemplate.mockResolvedValue(null);
    mockEnvironmentCustomImageService.getSessionById.mockResolvedValue(null);
    mockExecutionWorkspaceService.clearEnvironmentSelection.mockReset();
    mockLogActivity.mockReset();
    mockSecretService.create.mockReset();
    mockSecretService.normalizeEnvBindingsForPersistence.mockReset();
    mockSecretService.listBindingCompanyIdsForTarget.mockReset();
    mockSecretService.resolveSecretValueForEphemeralAccess.mockReset();
    mockSecretService.syncEnvBindingsForTarget.mockReset();
    mockSecretService.syncSecretRefsForTarget.mockReset();
    mockSecretService.replaceSecretRefsForInstanceTarget.mockReset();
    mockSecretService.replaceSecretRefsForInstanceTarget.mockResolvedValue([]);

    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1", "company-2"]);
    mockEnvironmentService.list.mockResolvedValue([]);
    mockEnvironmentService.create.mockResolvedValue(createEnvironment());
    mockSecretService.normalizeEnvBindingsForPersistence.mockImplementation(async (_companyId, env) => env ?? {});
    mockSecretService.listBindingCompanyIdsForTarget.mockResolvedValue([]);
    mockSecretService.syncEnvBindingsForTarget.mockResolvedValue([]);
    mockSecretService.syncSecretRefsForTarget.mockResolvedValue([]);
  });

  it("lists the instance environment catalog for a local board actor", async () => {
    mockEnvironmentService.list.mockResolvedValue([createEnvironment()]);
    const app = createApp({
      type: "board",
      userId: "board-1",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app).get("/api/companies/company-1/environments?driver=local");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    // With a company the catalog is the shared environments plus the company's own.
    expect(mockEnvironmentService.list).toHaveBeenCalledWith("company-1", {
      status: undefined,
      driver: "local",
    });
  });

  it("allows non-admin board members with company access to read the shared environment catalog", async () => {
    mockEnvironmentService.list.mockResolvedValue([createEnvironment()]);
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "member", status: "active" }],
      isInstanceAdmin: false,
    });

    const res = await request(app).get("/api/companies/company-1/environments");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(mockEnvironmentService.list).toHaveBeenCalledTimes(1);
  });

  it("shows members the sandbox provider but not another company's environment", async () => {
    const member = {
      type: "board",
      userId: "user-1",
      source: "session",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "member", status: "active" }],
      isInstanceAdmin: false,
    };
    mockEnvironmentService.getById.mockResolvedValue(createEnvironment({
      id: "env-mac",
      name: "Build Mac",
      driver: "sandbox",
      companyId: "company-1",
      config: { provider: "mac-fleet", deviceId: "device-1", apiKey: "secret" },
      metadata: { note: "private" },
    }));
    const own = await request(createApp(member)).get("/api/environments/env-mac");
    expect(own.status).toBe(200);
    // Pickers need the provider to know an adapter can run there; nothing else leaks.
    expect(own.body.config).toEqual({ provider: "mac-fleet" });
    expect(own.body.metadata).toBeNull();

    mockEnvironmentService.getById.mockResolvedValue(createEnvironment({
      id: "env-other",
      driver: "sandbox",
      companyId: "company-2",
      config: { provider: "mac-fleet" },
    }));
    const other = await request(createApp(member)).get("/api/environments/env-other");
    expect(other.status).toBe(404);
  });

  it("rejects company agents from enumerating the shared environment catalog", async () => {
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app).get("/api/companies/company-1/environments");

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Board access required");
  });

  it("rejects non-admin signed-in board members from mutating instance environments", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      companyIds: ["company-1"],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/companies/company-1/environments")
      .send({
        name: "Shared Local",
        driver: "local",
        config: {},
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Instance admin");
    expect(mockEnvironmentService.create).not.toHaveBeenCalled();
  });

  it("creates an instance-scoped environment and logs the mutation to every company", async () => {
    const app = createApp({
      type: "board",
      userId: "board-1",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .post("/api/companies/company-1/environments")
      .send({
        name: "Shared Local",
        driver: "local",
        config: {},
      });

    expect(res.status).toBe(201);
    expect(mockEnvironmentService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Shared Local",
        driver: "local",
        status: "active",
      }),
      undefined,
      { db: expect.anything() },
    );
    expect(mockSecretService.replaceSecretRefsForInstanceTarget).toHaveBeenCalledWith(
      { targetType: "environment", targetId: "env-1" },
      [],
      { db: expect.anything() },
    );
    expect(mockSecretService.syncEnvBindingsForTarget).toHaveBeenCalledWith(
      "company-1",
      { targetType: "environment", targetId: "env-1" },
      {},
      { db: expect.anything() },
    );
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
    expect(mockLogActivity.mock.calls.map((call) => call[1].companyId)).toEqual(["company-1", "company-2"]);
  });

  it("creates a company-only environment and logs it only to that company", async () => {
    mockEnvironmentService.create.mockResolvedValue(createEnvironment({
      id: "env-mac",
      name: "Build Mac",
      driver: "ssh",
      companyId: OWNER_COMPANY_ID,
      config: { host: "mac.local", username: "builder", remoteWorkspacePath: "/Users/builder/work" },
      metadata: null,
    }));
    const app = createApp({ type: "board", userId: "board-1", source: "local_implicit", isInstanceAdmin: true });

    const res = await request(app)
      .post(`/api/companies/${OWNER_COMPANY_ID}/environments`)
      .send({
        name: "Build Mac",
        driver: "ssh",
        companyId: OWNER_COMPANY_ID,
        config: { host: "mac.local", username: "builder", remoteWorkspacePath: "/Users/builder/work" },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockEnvironmentService.create).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: OWNER_COMPANY_ID }),
      undefined,
      { db: expect.anything() },
    );
    expect(mockLogActivity.mock.calls.map((call) => call[1].companyId)).toEqual([OWNER_COMPANY_ID]);
  });

  it("refuses to limit an environment to a different company or to limit the local host", async () => {
    const app = createApp({ type: "board", userId: "board-1", source: "local_implicit", isInstanceAdmin: true });

    const foreign = await request(app)
      .post(`/api/companies/${OWNER_COMPANY_ID}/environments`)
      .send({ name: "Build Mac", driver: "ssh", companyId: "22222222-2222-4222-8222-222222222222", config: {} });
    expect(foreign.status).toBe(422);

    const local = await request(app)
      .post(`/api/companies/${OWNER_COMPANY_ID}/environments`)
      .send({ name: "Local", driver: "local", companyId: OWNER_COMPANY_ID, config: {} });
    expect(local.status).toBe(422);
    expect(mockEnvironmentService.create).not.toHaveBeenCalled();
  });

  it("refuses to limit a shared environment while other companies still use it", async () => {
    mockEnvironmentService.getById.mockResolvedValue(createEnvironment({
      id: "env-runner",
      name: "Runner",
      driver: "ssh",
      companyId: null,
      metadata: null,
    }));
    mockEnvironmentService.countReferencesOutsideCompany.mockResolvedValue({
      agents: 2,
      projects: 0,
      companies: 0,
      instanceDefault: false,
    });
    const app = createApp({ type: "board", userId: "board-1", source: "local_implicit", isInstanceAdmin: true });

    const res = await request(app)
      .patch("/api/environments/env-runner")
      .send({ companyId: OWNER_COMPANY_ID });

    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ code: "environment_used_by_other_companies", agents: 2 });
    expect(mockEnvironmentService.countReferencesOutsideCompany).toHaveBeenCalledWith("env-runner", OWNER_COMPANY_ID);
    expect(mockEnvironmentService.update).not.toHaveBeenCalled();
  });

  it("normalizes and syncs environment envVars on create", async () => {
    const envVars = {
      ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111", version: "latest" },
    };
    mockSecretService.normalizeEnvBindingsForPersistence.mockResolvedValue(envVars);
    mockEnvironmentService.create.mockResolvedValue(createEnvironment({ envVars }));
    const app = createApp({
      type: "board",
      userId: "board-1",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .post("/api/companies/company-1/environments")
      .send({
        name: "Shared Local",
        driver: "local",
        config: {},
        envVars,
      });

    expect(res.status).toBe(201);
    expect(mockSecretService.normalizeEnvBindingsForPersistence).toHaveBeenCalledWith(
      "company-1",
      envVars,
      expect.objectContaining({ fieldPath: "envVars" }),
    );
    expect(mockEnvironmentService.create).toHaveBeenCalledWith(
      expect.objectContaining({ envVars }),
      undefined,
      { db: expect.anything() },
    );
    expect(mockSecretService.syncEnvBindingsForTarget).toHaveBeenCalledWith(
      "company-1",
      { targetType: "environment", targetId: "env-1" },
      envVars,
      { db: expect.anything() },
    );
  });

  it("returns full environment details for an instance admin", async () => {
    mockEnvironmentService.getById.mockResolvedValue(createEnvironment({ config: { shell: "zsh" } }));
    const app = createApp({
      type: "board",
      userId: "board-1",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app).get("/api/environments/env-1");

    expect(res.status).toBe(200);
    expect(res.body.config).toEqual({ shell: "zsh" });
  });
});
