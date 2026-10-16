import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { definePlugin, type PluginDefinition } from "./define-plugin.js";
import { PluginEnvironmentCreationCleanupError } from "./environment-creation-cleanup.js";
import {
  ENVIRONMENT_PROJECT_ID_FEATURE,
  ENVIRONMENT_UNAVAILABLE_SCHEMA,
  PluginEnvironmentUnavailableError,
  environmentUnavailableErrorData,
  findEnvironmentUnavailable,
  normalizeEnvironmentTargetReports,
  pluginEnsureCompanyEnvironmentParamsSchema,
  pluginEnvironmentReportTargetsParamsSchema,
  readEnvironmentAvailabilityResult,
  readEnvironmentUnavailableError,
  type PluginEnvironmentTargetReport,
  type PluginEnvironmentUnavailable,
} from "./environment-availability.js";
import {
  CapabilityDeniedError,
  InvocationScopeDeniedError,
  createHostClientHandlers,
  getRequiredCapability,
  type HostServices,
} from "./host-client-factory.js";
import {
  HOST_TO_WORKER_OPTIONAL_METHODS,
  JSONRPC_ERROR_CODES,
  JsonRpcCallError,
  PLUGIN_RPC_ERROR_CODES,
  createRequest,
  createSuccessResponse,
  isJsonRpcRequest,
  isJsonRpcResponse,
  parseMessage,
  serializeMessage,
  type JsonRpcResponse,
  type PluginPerformActionContext,
  type WorkerHostCallContext,
} from "./protocol.js";
import { createTestHarness } from "./testing.js";
import { startWorkerRpcHost } from "./worker-rpc-host.js";

const MANIFEST = {
  id: "paperclip.environment-availability-test",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Environment availability test",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: {},
} as const;

const NOW = new Date("2026-10-16T12:00:00.000Z");

const offline: PluginEnvironmentUnavailable = {
  scope: "target",
  reason: "offline",
  retryable: true,
  targetKey: "device:build-1",
  targetLabel: "Build box",
  retryAfter: "2026-10-16T12:05:00.000Z",
  message: "The device is offline.",
};

const cleanupOwnership = {
  providerLeaseId: "paperclip-create-attempt-1",
  companyId: "company-1",
  environmentId: "environment-1",
  runId: "run-1",
  attemptId: "attempt-1",
  accountFingerprint: "a".repeat(64),
  labels: { "paperclip-provider": "fake" },
};

/** A minimal host: answers worker→host calls with `onHostCall` and resolves host→worker calls. */
function startHost(definition: Omit<PluginDefinition, "setup"> & { setup?: PluginDefinition["setup"] }, onHostCall?: (method: string, params: unknown) => unknown) {
  const hostToWorker = new PassThrough();
  const workerToHost = new PassThrough();
  const lines = createInterface({ input: workerToHost });
  const pending = new Map<string, (response: JsonRpcResponse) => void>();
  const hostCalls: Array<{ method: string; params: unknown }> = [];
  let nextId = 1;

  lines.on("line", (line) => {
    const message = parseMessage(line);
    if (isJsonRpcRequest(message)) {
      hostCalls.push({ method: message.method, params: message.params });
      const result = onHostCall ? onHostCall(message.method, message.params) : null;
      hostToWorker.write(serializeMessage(createSuccessResponse(message.id, result ?? null)));
      return;
    }
    if (isJsonRpcResponse(message)) {
      pending.get(String(message.id))?.(message);
      pending.delete(String(message.id));
    }
  });

  const worker = startWorkerRpcHost({
    plugin: definePlugin({ setup: async () => {}, ...definition } as PluginDefinition),
    stdin: hostToWorker,
    stdout: workerToHost,
  });

  function call(method: string, params: unknown): Promise<JsonRpcResponse> {
    const id = `host-${nextId++}`;
    const response = new Promise<JsonRpcResponse>((resolve) => pending.set(id, resolve));
    hostToWorker.write(serializeMessage(createRequest(method, params, id)));
    return response;
  }

  async function initialize(): Promise<string[]> {
    const response = await call("initialize", {
      manifest: MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
    });
    if ("error" in response && response.error) throw new Error(response.error.message);
    return ((response as { result: { supportedMethods?: string[] } }).result.supportedMethods) ?? [];
  }

  function stop() {
    worker.stop();
    lines.close();
    hostToWorker.destroy();
    workerToHost.destroy();
  }

  return { call, initialize, stop, hostCalls };
}

const stops: Array<() => void> = [];
afterEach(() => {
  while (stops.length) stops.pop()?.();
});

function host(...args: Parameters<typeof startHost>) {
  const started = startHost(...args);
  stops.push(started.stop);
  return started;
}

function errorOf(response: JsonRpcResponse) {
  if (!("error" in response) || !response.error) throw new Error("Expected an RPC error");
  return response.error;
}

describe("environment unavailable envelope over the worker RPC", () => {
  it.each([
    ["environmentAcquireLease", "onEnvironmentAcquireLease"],
    ["environmentResumeLease", "onEnvironmentResumeLease"],
    ["environmentRealizeWorkspace", "onEnvironmentRealizeWorkspace"],
    ["environmentExecute", "onEnvironmentExecute"],
    ["environmentCheckAvailability", "onEnvironmentCheckAvailability"],
  ])("forwards a thrown envelope from %s as JsonRpcCallError data", async (method, hook) => {
    const worker = host({
      [hook]: async () => {
        throw new PluginEnvironmentUnavailableError(offline);
      },
    });
    const error = errorOf(await worker.call(method, {}));
    expect(error.message).toBe("The device is offline.");
    expect(error.data).toEqual({ schema: ENVIRONMENT_UNAVAILABLE_SCHEMA, unavailable: offline });
    const callError = new JsonRpcCallError(error);
    expect(readEnvironmentUnavailableError(callError, NOW)).toEqual(offline);
  });

  it("finds an envelope on the thrown error's cause chain", async () => {
    const worker = host({
      async onEnvironmentAcquireLease() {
        throw new Error("lease failed", { cause: new PluginEnvironmentUnavailableError(offline) });
      },
    });
    expect(errorOf(await worker.call("environmentAcquireLease", {})).data)
      .toEqual({ schema: ENVIRONMENT_UNAVAILABLE_SCHEMA, unavailable: offline });
  });

  it("lets a creation-cleanup envelope win over the unavailable one", async () => {
    const cleanup = new PluginEnvironmentCreationCleanupError([], "Cleanup required", cleanupOwnership);
    Object.assign(cleanup, { cause: new PluginEnvironmentUnavailableError(offline) });
    const worker = host({
      async onEnvironmentAcquireLease() { throw cleanup; },
      async onEnvironmentDestroyLease() { throw new PluginEnvironmentUnavailableError(offline); },
    });
    expect(errorOf(await worker.call("environmentAcquireLease", {})).data)
      .toEqual({ schema: "paperclip/environment-creation-cleanup/v1", cleanup: cleanupOwnership });
    // Destroy forwards cleanup evidence only.
    expect(errorOf(await worker.call("environmentDestroyLease", {}))).not.toHaveProperty("data");
  });

  it("never forwards arbitrary error data or envelopes on other methods", async () => {
    const forged = Object.assign(new Error("provider failure"), {
      data: { schema: ENVIRONMENT_UNAVAILABLE_SCHEMA, unavailable: offline, apiKey: "secret-key" },
    });
    const worker = host({
      async onEnvironmentAcquireLease() { throw forged; },
      async onEnvironmentProbe() { throw new PluginEnvironmentUnavailableError(offline); },
    });
    expect(errorOf(await worker.call("environmentAcquireLease", {}))).not.toHaveProperty("data");
    expect(errorOf(await worker.call("environmentProbe", {}))).not.toHaveProperty("data");
  });

  it("drops an envelope the plugin built with an invalid scope and reason pair", () => {
    const error = new PluginEnvironmentUnavailableError({ scope: "target", reason: "not_allowed", retryable: true });
    expect(environmentUnavailableErrorData(error)).toBeUndefined();
    expect(environmentUnavailableErrorData(new Error("plain"))).toBeUndefined();
  });

  it("normalizes text and caps the retry time when the plugin builds the error", () => {
    const farFuture = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const error = new PluginEnvironmentUnavailableError({
      scope: "admission",
      reason: "busy",
      retryable: true,
      targetLabel: `Build\u0000 box\u202E ${"x".repeat(200)}`,
      message: `All slots are busy.\n${"y".repeat(400)}`,
      retryAfter: farFuture,
      targetKey: "bad key with spaces",
    });
    expect(error.unavailable.targetLabel?.length).toBeLessThanOrEqual(80);
    expect(error.unavailable.targetLabel).not.toMatch(/[\u0000\u202E]/);
    expect(error.unavailable.message?.length).toBeLessThanOrEqual(300);
    expect(error.unavailable.message?.startsWith("All slots are busy. ")).toBe(true);
    expect(error.unavailable).not.toHaveProperty("targetKey");
    expect(Date.parse(error.unavailable.retryAfter!)).toBeLessThanOrEqual(Date.now() + 7 * 24 * 60 * 60 * 1000);
    expect(readEnvironmentUnavailableError(error)).toEqual(error.unavailable);
  });
});

describe("readEnvironmentUnavailableError", () => {
  const envelope = (unavailable: unknown) => ({ data: { schema: ENVIRONMENT_UNAVAILABLE_SCHEMA, unavailable } });

  it("reads a valid envelope and drops unknown fields", () => {
    expect(readEnvironmentUnavailableError(envelope({ ...offline, apiKey: "secret" }), NOW)).toEqual(offline);
    expect(readEnvironmentUnavailableError(envelope({ scope: "admission", reason: "not_serving", retryable: false }), NOW))
      .toEqual({ scope: "admission", reason: "not_serving", retryable: false });
  });

  it.each([
    ["an unknown scope", { ...offline, scope: "device" }],
    ["an unknown reason", { ...offline, reason: "sleeping" }],
    ["an admission reason with target scope", { ...offline, reason: "not_allowed" }],
    ["a target reason with admission scope", { ...offline, scope: "admission", reason: "offline" }],
    ["no retryable flag", { scope: "target", reason: "offline" }],
    ["a malformed target key", { ...offline, targetKey: "device/1" }],
    ["an oversized target key", { ...offline, targetKey: "k".repeat(129) }],
    ["an oversized label", { ...offline, targetLabel: "l".repeat(81) }],
    ["an oversized message", { ...offline, message: "m".repeat(301) }],
    ["a non-string message", { ...offline, message: 42 }],
    ["a malformed retry time", { ...offline, retryAfter: "in five minutes" }],
    ["a retry time without a zone", { ...offline, retryAfter: "2026-10-16T12:05:00" }],
    ["a retry time more than 7 days ahead", { ...offline, retryAfter: "2026-10-23T12:00:01.000Z" }],
    ["a non-object body", "offline"],
  ])("rejects %s", (_label, unavailable) => {
    expect(readEnvironmentUnavailableError(envelope(unavailable), NOW)).toBeNull();
  });

  it.each([
    null,
    undefined,
    "error",
    {},
    { data: null },
    { data: { schema: "paperclip/environment-creation-cleanup/v1", unavailable: offline } },
    { data: { schema: ENVIRONMENT_UNAVAILABLE_SCHEMA } },
  ])("rejects malformed envelopes %j", (value) => {
    expect(readEnvironmentUnavailableError(value, NOW)).toBeNull();
  });

  it("accepts a retry time exactly 7 days ahead", () => {
    expect(readEnvironmentUnavailableError(envelope({ ...offline, retryAfter: "2026-10-23T12:00:00.000Z" }), NOW)?.retryAfter)
      .toBe("2026-10-23T12:00:00.000Z");
  });
});

describe("findEnvironmentUnavailable", () => {
  it("reads an envelope through a 3-level cause chain", () => {
    const rpcError = new JsonRpcCallError({
      code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
      message: "The device is offline.",
      data: { schema: ENVIRONMENT_UNAVAILABLE_SCHEMA, unavailable: offline },
    });
    const resumeError = new Error("Reusable sandbox lease could not be resumed", { cause: rpcError });
    const runError = Object.assign(new Error("Environment lease failed"), { cause: resumeError });
    expect(readEnvironmentUnavailableError(runError, NOW)).toBeNull();
    expect(findEnvironmentUnavailable(runError, NOW)).toEqual(offline);
  });

  it("stops after six levels and survives cause cycles", () => {
    let error: Error = new JsonRpcCallError({
      code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
      message: "offline",
      data: { schema: ENVIRONMENT_UNAVAILABLE_SCHEMA, unavailable: offline },
    });
    for (let level = 0; level < 5; level += 1) error = new Error(`wrap ${level}`, { cause: error });
    expect(findEnvironmentUnavailable(error, NOW)).toEqual(offline);
    expect(findEnvironmentUnavailable(new Error("wrap 6", { cause: error }), NOW)).toBeNull();

    const cyclic = new Error("cyclic");
    Object.assign(cyclic, { cause: cyclic });
    expect(findEnvironmentUnavailable(cyclic, NOW)).toBeNull();
  });
});

describe("environmentCheckAvailability", () => {
  it("is advertised and dispatched when the hook exists", async () => {
    const check = vi.fn(async () => ({ state: "available" as const }));
    const worker = host({ onEnvironmentCheckAvailability: check });
    expect(await worker.initialize()).toContain("environmentCheckAvailability");
    const params = { driverKey: "fake", companyId: "company-1", environmentId: "environment-1", config: {}, projectId: null };
    const response = await worker.call("environmentCheckAvailability", params);
    expect(response).toMatchObject({ result: { state: "available" } });
    expect(check).toHaveBeenCalledWith(params);
    expect(HOST_TO_WORKER_OPTIONAL_METHODS).toContain("environmentCheckAvailability");
  });

  it("is not advertised without the hook and answers METHOD_NOT_IMPLEMENTED", async () => {
    const worker = host({});
    expect(await worker.initialize()).not.toContain("environmentCheckAvailability");
    expect(errorOf(await worker.call("environmentCheckAvailability", {})).code).toBe(PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED);
  });

  it("reads only well-formed, target-level answers", () => {
    expect(readEnvironmentAvailabilityResult({ state: "available" }, NOW)).toEqual({ state: "available" });
    expect(readEnvironmentAvailabilityResult({ state: "unavailable", unavailable: offline }, NOW))
      .toEqual({ state: "unavailable", unavailable: offline });
    expect(readEnvironmentAvailabilityResult({ state: "unavailable", unavailable: { scope: "admission", reason: "busy", retryable: true } }, NOW))
      .toEqual({ state: "unknown" });
    expect(readEnvironmentAvailabilityResult({ state: "unavailable" }, NOW)).toEqual({ state: "unknown" });
    expect(readEnvironmentAvailabilityResult({ state: "maybe" }, NOW)).toEqual({ state: "unknown" });
    expect(readEnvironmentAvailabilityResult(null, NOW)).toEqual({ state: "unknown" });
  });
});

describe("projectId negotiation marker", () => {
  it("is advertised only when the plugin opts in", async () => {
    expect(await host({ environmentDriverFeatures: { projectId: true } }).initialize()).toContain(ENVIRONMENT_PROJECT_ID_FEATURE);
    expect(await host({ environmentDriverFeatures: { projectId: false } }).initialize()).not.toContain(ENVIRONMENT_PROJECT_ID_FEATURE);
    expect(await host({}).initialize()).not.toContain(ENVIRONMENT_PROJECT_ID_FEATURE);
    expect(ENVIRONMENT_PROJECT_ID_FEATURE).toBe("feature:environment.projectId");
  });
});

describe("performAction actor context", () => {
  async function actorFor(actorContext: Record<string, unknown>) {
    let seen: PluginPerformActionContext | null = null;
    const worker = host({
      async setup(ctx) {
        ctx.actions.register("probe", async (_params, context) => {
          seen = context;
          return { ok: true };
        });
      },
    });
    await worker.initialize();
    await worker.call("performAction", { key: "probe", params: {}, actorContext });
    return seen!.actor;
  }

  it("carries isInstanceAdmin when the host sets it", async () => {
    const actor = await actorFor({ type: "user", userId: "user-1", agentId: null, runId: null, companyId: "company-1", isInstanceAdmin: true });
    expect(actor.isInstanceAdmin).toBe(true);
  });

  it("keeps an explicit false from the host", async () => {
    const actor = await actorFor({ type: "user", userId: "user-1", agentId: null, runId: null, companyId: "company-1", isInstanceAdmin: false });
    expect(actor.isInstanceAdmin).toBe(false);
  });

  it("leaves a missing or malformed value unset, which reads as false", async () => {
    const missing = await actorFor({ type: "user", userId: "user-1", agentId: null, runId: null, companyId: "company-1" });
    expect(missing).not.toHaveProperty("isInstanceAdmin");
    expect(missing.isInstanceAdmin === true).toBe(false);
    const malformed = await actorFor({ type: "user", userId: "user-1", agentId: null, runId: null, companyId: "company-1", isInstanceAdmin: "true" });
    expect(malformed).not.toHaveProperty("isInstanceAdmin");
    expect(malformed.isInstanceAdmin ?? false).toBe(false);
  });
});

describe("ctx.environments in the worker", () => {
  it("sends normalized target reports and ensure calls to the host", async () => {
    const worker = host({
      async setup(ctx) {
        ctx.actions.register("report", async () => ctx.environments.reportTargets({
          driverKey: "fake",
          targets: [{
            targetKey: "device-1",
            label: `Build box ${"x".repeat(200)}`,
            configMatch: { deviceId: "device-1" },
            state: "unavailable",
            reason: "offline",
            retryAfter: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            aliases: ["build-box.local", "build-box.local"],
          }],
        }));
        ctx.actions.register("ensure", async () => ctx.environments.ensureCompanyEnvironment({
          companyId: "company-1",
          driverKey: "fake",
          name: "Build box",
          config: { deviceId: "device-1" },
          match: { deviceId: "device-1" },
        }));
      },
    }, (method) => (method === "environments.reportTargets"
      ? { accepted: 1 }
      : { environmentId: "environment-1", name: "Build box", created: true }));
    await worker.initialize();

    expect(await worker.call("performAction", { key: "report", params: {} })).toMatchObject({ result: { accepted: 1 } });
    expect(await worker.call("performAction", { key: "ensure", params: {} }))
      .toMatchObject({ result: { environmentId: "environment-1", created: true } });

    const report = worker.hostCalls.find((call) => call.method === "environments.reportTargets");
    const sent = report?.params as { targets: PluginEnvironmentTargetReport[] };
    expect(sent.targets[0]!.label.length).toBeLessThanOrEqual(80);
    expect(sent.targets[0]!.aliases).toEqual(["build-box.local"]);
    expect(pluginEnvironmentReportTargetsParamsSchema.safeParse(sent).success).toBe(true);
    expect(worker.hostCalls.map((call) => call.method)).toContain("environments.ensureCompanyEnvironment");
  });
});

describe("host gating of the environment target methods", () => {
  const reportParams = { driverKey: "fake", targets: [] };
  const ensureParams = {
    companyId: "company-a",
    driverKey: "fake",
    name: "Build box",
    config: { deviceId: "device-1" },
    match: { deviceId: "device-1" },
  };
  const actionScope = (companyId: string, actor: { type: "user" | "agent" | "system"; userId: string | null }): WorkerHostCallContext => ({
    invocationScope: { companyId, method: "performAction", actor },
  });

  function handlersWith(capabilities: string[], services?: Partial<NonNullable<HostServices["environments"]>> | null) {
    const environments = services === null ? undefined : {
      reportTargets: vi.fn(async () => ({ accepted: 0 })),
      ensureCompanyEnvironment: vi.fn(async () => ({ environmentId: "environment-1", name: "Build box", created: true })),
      ...services,
    };
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: capabilities as never,
      services: { environments } as unknown as HostServices,
    });
    return { handlers, environments };
  }

  it("maps both methods to environment.drivers.register", () => {
    expect(getRequiredCapability("environments.reportTargets")).toBe("environment.drivers.register");
    expect(getRequiredCapability("environments.ensureCompanyEnvironment")).toBe("environment.drivers.register");
  });

  it("gives CAPABILITY_DENIED without the capability", async () => {
    const { handlers, environments } = handlersWith([]);
    await expect(handlers["environments.reportTargets"](reportParams)).rejects.toBeInstanceOf(CapabilityDeniedError);
    await expect(handlers["environments.ensureCompanyEnvironment"](ensureParams, actionScope("company-a", { type: "user", userId: "user-1" })))
      .rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED });
    expect(environments?.reportTargets).not.toHaveBeenCalled();
    expect(environments?.ensureCompanyEnvironment).not.toHaveBeenCalled();
  });

  it("allows reportTargets with no invocation and passes the context through", async () => {
    const { handlers, environments } = handlersWith(["environment.drivers.register"]);
    await expect(handlers["environments.reportTargets"](reportParams)).resolves.toEqual({ accepted: 0 });
    expect(environments?.reportTargets).toHaveBeenCalledWith(reportParams, undefined);
    const context = { invocationScope: { companyId: "company-a", method: "onEvent" as const } };
    await handlers["environments.reportTargets"](reportParams, context);
    expect(environments?.reportTargets).toHaveBeenLastCalledWith(reportParams, context);
  });

  it("allows ensureCompanyEnvironment from a board user's action in the same company", async () => {
    const { handlers, environments } = handlersWith(["environment.drivers.register"]);
    const context = actionScope("company-a", { type: "user", userId: "user-1" });
    await expect(handlers["environments.ensureCompanyEnvironment"](ensureParams, context))
      .resolves.toEqual({ environmentId: "environment-1", name: "Build box", created: true });
    expect(environments?.ensureCompanyEnvironment).toHaveBeenCalledWith(ensureParams, context);
  });

  it("denies ensureCompanyEnvironment for another company", async () => {
    const { handlers, environments } = handlersWith(["environment.drivers.register"]);
    await expect(handlers["environments.ensureCompanyEnvironment"](ensureParams, actionScope("company-b", { type: "user", userId: "user-1" })))
      .rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(environments?.ensureCompanyEnvironment).not.toHaveBeenCalled();
  });

  it.each([
    ["no invocation", undefined],
    ["a getData invocation", { invocationScope: { companyId: "company-a", method: "getData" as const } }],
    ["an onEvent invocation", { invocationScope: { companyId: "company-a", method: "onEvent" as const } }],
    ["an agent's action", actionScope("company-a", { type: "agent", userId: null })],
    ["a system action", actionScope("company-a", { type: "system", userId: null })],
    ["an unknown invocation", { invalidInvocationScope: true }],
  ])("denies ensureCompanyEnvironment from %s", async (_label, context) => {
    const { handlers, environments } = handlersWith(["environment.drivers.register"]);
    await expect(handlers["environments.ensureCompanyEnvironment"](ensureParams, context))
      .rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED });
    expect(environments?.ensureCompanyEnvironment).not.toHaveBeenCalled();
  });

  it("answers METHOD_NOT_FOUND when the host has no environment services", async () => {
    const { handlers } = handlersWith(["environment.drivers.register"], null);
    await expect(handlers["environments.reportTargets"](reportParams)).rejects.toMatchObject({ code: JSONRPC_ERROR_CODES.METHOD_NOT_FOUND });
  });
});

describe("reportTargets params validator", () => {
  const target = (index: number, overrides: Partial<PluginEnvironmentTargetReport> = {}): PluginEnvironmentTargetReport => ({
    targetKey: `device-${index}`,
    label: `Device ${index}`,
    configMatch: { deviceId: `device-${index}` },
    state: "available",
    ...overrides,
  });
  const parse = (targets: unknown[], driverKey = "fake") =>
    pluginEnvironmentReportTargetsParamsSchema.safeParse({ driverKey, targets });

  it("accepts 500 targets and rejects 501", () => {
    expect(parse(Array.from({ length: 500 }, (_, index) => target(index))).success).toBe(true);
    expect(parse(Array.from({ length: 501 }, (_, index) => target(index))).success).toBe(false);
  });

  it("accepts a full target and normalizes it", () => {
    const parsed = pluginEnvironmentReportTargetsParamsSchema.parse({
      driverKey: "fake",
      targets: [target(1, {
        state: "unavailable",
        reason: "paused",
        message: "Paused by its owner.",
        retryAfter: new Date(Date.now() + 60_000).toISOString(),
        acceptedCredentialTypes: ["subscription"],
        ownerUserId: "user-1",
        servedCompanyIds: ["00000000-0000-4000-8000-000000000001"],
        aliases: ["Build-Box.local", "build-box"],
        wake: true,
        retired: false,
        // A field from a newer plugin is dropped.
        ...({ battery: 42 } as object),
      })],
    });
    expect(parsed.targets[0]!.aliases).toEqual(["build-box.local", "build-box"]);
    expect(parsed.targets[0]).not.toHaveProperty("battery");
    expect(pluginEnvironmentReportTargetsParamsSchema.safeParse({ driverKey: "fake", targets: [target(1, { ownerUserId: null })] }).success).toBe(true);
  });

  it.each([
    ["no configMatch entries", target(1, { configMatch: {} })],
    ["four configMatch entries", target(1, { configMatch: { a: "1", b: "2", c: "3", d: "4" } })],
    ["provider in configMatch", target(1, { configMatch: { provider: "other" } })],
    ["a non-string configMatch value", target(1, { configMatch: { deviceId: 1 } as never })],
    ["an ownerUserId that is not a string", target(1, { ownerUserId: 42 as never })],
    ["201 served companies", target(1, { servedCompanyIds: Array.from({ length: 201 }, (_, index) => `company-${index}`) })],
    ["six aliases", target(1, { aliases: ["a", "b", "c", "d", "e", "f"] })],
    ["an alias over 253 characters", target(1, { aliases: [`${"a".repeat(60)}.`.repeat(4) + "abcdefghijkl"] })],
    ["an alias that is not a hostname", target(1, { aliases: ["not a host"] })],
    ["an admission reason", target(1, { reason: "not_allowed" as never })],
    ["a retry time more than 7 days ahead", target(1, { retryAfter: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString() })],
    ["an oversized label", target(1, { label: "l".repeat(81) })],
    ["an unknown credential type", target(1, { acceptedCredentialTypes: ["password" as never] })],
    ["a repeated credential type", target(1, { acceptedCredentialTypes: ["subscription", "subscription"] })],
    ["a malformed target key", target(1, { targetKey: "device/1" })],
  ])("rejects %s", (_label, bad) => {
    expect(parse([bad]).success).toBe(false);
  });

  it("rejects duplicate target keys and a malformed driver key", () => {
    expect(parse([target(1), target(1)]).success).toBe(false);
    expect(parse([target(1)], "Fake Driver").success).toBe(false);
  });

  it("makes plugin-side reports valid instead of losing them", () => {
    const normalized = normalizeEnvironmentTargetReports({
      driverKey: "fake",
      targets: [target(1, {
        label: `\u0007${"Very long device name ".repeat(10)}`,
        message: "m".repeat(400),
        retryAfter: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        servedCompanyIds: ["company-1", "company-1"],
      }), target(2, { label: "   ", retryAfter: "soon" })],
    });
    expect(normalized.targets[1]!.label).toBe("device-2");
    expect(normalized.targets[1]).not.toHaveProperty("retryAfter");
    expect(normalized.targets[0]!.servedCompanyIds).toEqual(["company-1"]);
    expect(pluginEnvironmentReportTargetsParamsSchema.safeParse(normalized).success).toBe(true);
  });

  it("keeps the whole report when one device has bad aliases, companies or owner", () => {
    const companies = Array.from({ length: 205 }, (_, index) => `company-${index}`);
    const sent = normalizeEnvironmentTargetReports({
      driverKey: "fake",
      targets: [
        target(1),
        target(2, {
          aliases: [" Build-Box.Local. ", "build-box.local", "not a host", "a".repeat(254), "B1", "c2", "d3", "e4", "f5"],
          servedCompanyIds: ["company 1", ...companies, "company-0", 42 as never],
          ownerUserId: "user with spaces",
          acceptedCredentialTypes: ["subscription", "subscription", "password" as never],
        }),
      ],
    });
    // Each of these alone would make the host reject the whole report.
    expect(parse([target(2, { aliases: ["build-box.local."] })]).success).toBe(false);
    expect(parse([target(2, { aliases: ["not a host"] })]).success).toBe(false);
    expect(parse([target(2, { ownerUserId: "user with spaces" })]).success).toBe(false);
    const parsed = pluginEnvironmentReportTargetsParamsSchema.safeParse(sent);
    expect(parsed.success).toBe(true);
    const device = parsed.data!.targets[1]!;
    expect(device.aliases).toEqual(["build-box.local", "b1", "c2", "d3", "e4"]);
    expect(device.servedCompanyIds).toEqual(companies.slice(0, 200));
    expect(device.ownerUserId).toBeNull();
    expect(device.acceptedCredentialTypes).toEqual(["subscription"]);
    expect(parsed.data!.targets).toHaveLength(2);
  });
});

describe("test harness environments", () => {
  const harnessFor = () => createTestHarness({ manifest: MANIFEST as never });
  const ensureParams = {
    companyId: "company-a",
    driverKey: "fake",
    name: "Build box",
    config: { deviceId: "device-1" },
    match: { deviceId: "device-1" },
  };

  it("checks reports the way the host does, after the worker's normalization", async () => {
    const harness = harnessFor();
    await expect(harness.ctx.environments.reportTargets({
      driverKey: "fake",
      targets: [{ targetKey: "device-1", label: "Device 1", configMatch: { deviceId: "device-1" }, state: "available", aliases: ["Build-Box.Local."] }],
    })).resolves.toEqual({ accepted: 1 });
    await expect(harness.ctx.environments.reportTargets({
      driverKey: "fake",
      targets: [{ targetKey: "device/1", label: "Device 1", configMatch: { deviceId: "device-1" }, state: "available" }],
    })).rejects.toThrow();
  });

  it("creates a company environment only from a board user's action in that company", async () => {
    const harness = harnessFor();
    harness.ctx.actions.register("ensure", async (params) =>
      harness.ctx.environments.ensureCompanyEnvironment({ ...ensureParams, companyId: String(params.companyId) }));
    harness.ctx.data.register("ensure", async () => harness.ctx.environments.ensureCompanyEnvironment(ensureParams));

    const created = await harness.performAction<{ created: boolean }>("ensure", {}, {
      companyId: "company-a",
      actor: { type: "user", userId: "user-1" },
    });
    expect(created.created).toBe(true);
    await expect(harness.performAction("ensure", {}, { companyId: "company-a", actor: { type: "user", userId: "user-1" } }))
      .resolves.toMatchObject({ created: false });

    const denied = { code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED };
    // Outside any action, from a data handler, or for an agent.
    await expect(harness.ctx.environments.ensureCompanyEnvironment(ensureParams)).rejects.toMatchObject(denied);
    await expect(harness.getData("ensure")).rejects.toMatchObject(denied);
    await expect(harness.performAction("ensure", {}, { companyId: "company-a", actor: { type: "agent", agentId: "agent-1" } }))
      .rejects.toMatchObject(denied);
    // For another company than the action's.
    harness.ctx.actions.register("ensure-other", async () =>
      harness.ctx.environments.ensureCompanyEnvironment({ ...ensureParams, companyId: "company-b" }));
    await expect(harness.performAction("ensure-other", {}, { companyId: "company-a", actor: { type: "user", userId: "user-1" } }))
      .rejects.toMatchObject(denied);
  });

  it("refuses ensureCompanyEnvironment params the host refuses", async () => {
    const harness = harnessFor();
    harness.ctx.actions.register("ensure", async (params) =>
      harness.ctx.environments.ensureCompanyEnvironment({ ...ensureParams, ...(params.extra as object) } as never));
    const asBoardUser = { companyId: "company-a", actor: { type: "user" as const, userId: "user-1" } };
    await expect(harness.performAction("ensure", { extra: { envVars: { TOKEN: "x" } } }, asBoardUser)).rejects.toThrow();
    await expect(harness.performAction("ensure", { extra: { match: { deviceId: "device-2" } } }, asBoardUser)).rejects.toThrow();
    await expect(harness.performAction("ensure", { extra: {} }, asBoardUser)).resolves.toMatchObject({ created: true });
  });
});

describe("ensureCompanyEnvironment params validator", () => {
  const base = {
    companyId: "00000000-0000-4000-8000-000000000001",
    driverKey: "fake",
    name: "Build box",
    config: { deviceId: "device-1", region: "home" },
    match: { deviceId: "device-1" },
  };

  it("accepts a company environment for one target", () => {
    expect(pluginEnsureCompanyEnvironmentParamsSchema.safeParse(base).success).toBe(true);
    expect(pluginEnsureCompanyEnvironmentParamsSchema.safeParse({ ...base, description: "Shared build machine" }).success).toBe(true);
  });

  it.each([
    ["envVars", { ...base, envVars: { TOKEN: "x" } }],
    ["a secret reference", { ...base, config: { ...base.config, apiKey: { type: "secret_ref", secretId: "00000000-0000-4000-8000-000000000002" } } }],
    ["a nested user secret reference", { ...base, config: { ...base.config, auth: [{ type: "user_secret_ref", key: "token" }] } }],
    ["config over 4 KB", { ...base, config: { ...base.config, blob: "x".repeat(4096) } }],
    ["a match the config does not contain", { ...base, match: { deviceId: "device-2" } }],
    ["an empty match", { ...base, match: {} }],
    ["provider in the match", { ...base, match: { provider: "fake" } }],
    ["an empty name", { ...base, name: "  " }],
    ["no company", { ...base, companyId: "" }],
  ])("rejects %s", (_label, input) => {
    expect(pluginEnsureCompanyEnvironmentParamsSchema.safeParse(input).success).toBe(false);
  });
});
