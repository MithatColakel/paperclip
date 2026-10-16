import { describe, expect, it } from "vitest";
import {
  AI_ACCOUNT_PLAN_WAIT_REASONS,
  AI_ACCOUNT_UNSELECTABLE_REASONS,
  AI_CREDENTIAL_REF_PATTERN,
  DEVICE_POOL_ACCOUNT_LIMIT,
  POOL_RUN_LEGACY_ROUTING_ENV_KEYS,
  POOL_RUN_REMOVED_ENV_KEYS,
  createMyAiAccountSchema,
  credentialTypeOfValue,
  deriveAiAccountState,
  findPoolRunForbiddenEnvKeys,
  findPoolRunSettingsConflicts,
  isPoolRunForbiddenEnvKey,
  LOCAL_EXECUTION_DEVICE_KEY,
  linkDeviceTargetSchema,
  replaceAiAccountCredentialSchema,
  setAgentAiAccountSchema,
  updateExecutionDeviceSchema,
  updateExecutionWaitSettingsSchema,
  updateInstanceAiAccountSchema,
  updateMyAiAccountSchema,
  sshExecutionDeviceKey,
} from "./ai-account-pool.js";
import { AI_ACCOUNT_HOST_CREATABLE_KINDS, AI_ACCOUNT_HOST_KINDS, createAiAccountHostSchema } from "./ai-account-hosts.js";
import {
  AI_ACCOUNT_WAIT_REASONS,
  RESOURCE_WAIT_ERROR_CODES,
  RESOURCE_WAIT_KINDS,
  RESOURCE_WAIT_LANE_BY_KIND,
  RESOURCE_WAIT_NOTICE_POLICY,
  RESOURCE_WAIT_REASONS,
  RESOURCE_WAIT_RETRY_REASONS,
  buildResourceWaitContext,
  isResourceWaitErrorCode,
  isResourceWaitReason,
  isResourceWaitRetryReason,
  readResourceWaitContext,
} from "./resource-waits.js";
import { ATTENTION_SOURCE_KINDS } from "./types/attention.js";

const subscriptionToken = `sk-ant-oat01-${"Ab3_-".repeat(19)}`;
const apiKey = `sk-ant-api03-${"Zx9_-".repeat(19)}`;
const companyId = "00000000-0000-4000-8000-000000000001";
const connectionId = "00000000-0000-4000-8000-000000000002";
const accountId = "00000000-0000-4000-8000-000000000003";

describe("createMyAiAccountSchema", () => {
  const base = { label: "Max 1", credentialType: "subscription" as const };

  it("accepts a pasted subscription token and a pasted API key", () => {
    expect(createMyAiAccountSchema.parse({ ...base, value: subscriptionToken }).value).toBe(subscriptionToken);
    expect(createMyAiAccountSchema.safeParse({ label: "Console", credentialType: "api_key", value: apiKey }).success).toBe(true);
  });

  it("accepts a server_env import and an ai_connection import", () => {
    expect(createMyAiAccountSchema.parse({ ...base, importFrom: { kind: "server_env" } }).importFrom)
      .toEqual({ kind: "server_env" });
    expect(createMyAiAccountSchema.parse({
      ...base,
      importFrom: { kind: "ai_connection", companyId, connectionId },
      emailHint: "owner@example.com",
      plan: "Max",
    }).importFrom).toEqual({ kind: "ai_connection", companyId, connectionId });
  });

  it.each([
    ["a subscription with an API key prefix", { ...base, value: apiKey }],
    ["an API key with a subscription prefix", { label: "Console", credentialType: "api_key", value: subscriptionToken }],
    ["a value with a line break", { ...base, value: `${subscriptionToken.slice(0, 40)}\n${subscriptionToken.slice(40)}` }],
    ["both a value and an import", { ...base, value: subscriptionToken, importFrom: { kind: "server_env" } }],
    ["neither a value nor an import", base],
    ["an unknown key", { ...base, value: subscriptionToken, owner: "someone-else" }],
    ["an unknown key inside the import", { ...base, importFrom: { kind: "server_env", envKey: "OTHER_KEY" } }],
    ["an ai_connection import without ids", { ...base, importFrom: { kind: "ai_connection" } }],
    ["an unknown import kind", { ...base, importFrom: { kind: "device_vault" } }],
    ["an empty label", { ...base, label: " ", value: subscriptionToken }],
    ["a label that is too long", { ...base, label: "x".repeat(81), value: subscriptionToken }],
  ])("rejects %s", (_label, input) => {
    expect(createMyAiAccountSchema.safeParse(input).success).toBe(false);
  });
});

describe("owner and admin account validators", () => {
  it("accepts owner edits and rejects unknown keys", () => {
    expect(updateMyAiAccountSchema.parse({ label: "Max 2", status: "disabled", clearProjectRestriction: true }))
      .toEqual({ label: "Max 2", status: "disabled", clearProjectRestriction: true });
    expect(updateMyAiAccountSchema.safeParse({ status: "auth_failed" }).success).toBe(false);
    expect(updateMyAiAccountSchema.safeParse({ clearProjectRestriction: false }).success).toBe(false);
    expect(updateMyAiAccountSchema.safeParse({ poolEnabled: false }).success).toBe(false);
    expect(updateMyAiAccountSchema.safeParse({ ownerUserId: "user-2" }).success).toBe(false);
  });

  it("replaces a credential only with a known prefix", () => {
    expect(replaceAiAccountCredentialSchema.safeParse({ value: subscriptionToken }).success).toBe(true);
    expect(replaceAiAccountCredentialSchema.safeParse({ value: apiKey }).success).toBe(true);
    expect(replaceAiAccountCredentialSchema.safeParse({ value: "sk-other-0123456789abcdefghij" }).success).toBe(false);
    expect(replaceAiAccountCredentialSchema.safeParse({ value: subscriptionToken, credentialType: "api_key" }).success).toBe(false);
  });

  it("accepts an instance PATCH with ownerUserId and rejects unknown keys", () => {
    expect(updateInstanceAiAccountSchema.parse({ ownerUserId: "user-2" })).toEqual({ ownerUserId: "user-2" });
    expect(updateInstanceAiAccountSchema.parse({ adminDisabled: true, reason: "Shared outside the team" }))
      .toEqual({ adminDisabled: true, reason: "Shared outside the team" });
    expect(updateInstanceAiAccountSchema.safeParse({ ownerUserId: " " }).success).toBe(false);
    expect(updateInstanceAiAccountSchema.safeParse({ status: "active" }).success).toBe(false);
    expect(updateInstanceAiAccountSchema.safeParse({ adminDisabled: "yes" }).success).toBe(false);
  });
});

describe("binding, device and wait-settings validators", () => {
  it("binds a pool account or the device login", () => {
    expect(setAgentAiAccountSchema.parse({ mode: "pool_account", accountId })).toEqual({ mode: "pool_account", accountId });
    expect(setAgentAiAccountSchema.parse({ mode: "device_login" })).toEqual({ mode: "device_login" });
    expect(setAgentAiAccountSchema.safeParse({ mode: "pool_account" }).success).toBe(false);
    expect(setAgentAiAccountSchema.safeParse({ mode: "device_login", accountId }).success).toBe(false);
    expect(setAgentAiAccountSchema.safeParse({ mode: "company_pool" }).success).toBe(false);
  });

  it("bounds the device account limit", () => {
    expect(DEVICE_POOL_ACCOUNT_LIMIT).toBe(3);
    expect(updateExecutionDeviceSchema.safeParse({ maxAccounts: 3, name: "Build box" }).success).toBe(true);
    expect(updateExecutionDeviceSchema.safeParse({ maxAccounts: 0 }).success).toBe(false);
    expect(updateExecutionDeviceSchema.safeParse({ maxAccounts: 4 }).success).toBe(false);
    expect(updateExecutionDeviceSchema.safeParse({ maxAccounts: 1.5 }).success).toBe(false);
    expect(updateExecutionDeviceSchema.safeParse({ kind: "external" }).success).toBe(false);
  });

  it("bounds the notify-after hours", () => {
    expect(updateExecutionWaitSettingsSchema.safeParse({ notifyAfterHours: null }).success).toBe(true);
    expect(updateExecutionWaitSettingsSchema.safeParse({ notifyAfterHours: 0, notifyPmOnDeviceWait: true }).success).toBe(true);
    expect(updateExecutionWaitSettingsSchema.safeParse({ notifyAfterHours: 168 }).success).toBe(true);
    expect(updateExecutionWaitSettingsSchema.safeParse({ notifyAfterHours: 169 }).success).toBe(false);
    expect(updateExecutionWaitSettingsSchema.safeParse({ notifyAfterHours: -1 }).success).toBe(false);
    expect(updateExecutionWaitSettingsSchema.safeParse({ instanceDefaultHours: 12 }).success).toBe(false);
  });

  it("links a device to a plugin target", () => {
    const pluginId = "00000000-0000-4000-8000-000000000004";
    expect(linkDeviceTargetSchema.safeParse({ pluginId, provider: "fleet-provider", targetKey: "device:abc-123" }).success).toBe(true);
    expect(linkDeviceTargetSchema.safeParse({ pluginId, provider: "Fleet Provider", targetKey: "abc" }).success).toBe(false);
    expect(linkDeviceTargetSchema.safeParse({ pluginId, provider: "fleet", targetKey: "a/b" }).success).toBe(false);
    expect(linkDeviceTargetSchema.safeParse({ pluginId: "plugin", provider: "fleet", targetKey: "abc" }).success).toBe(false);
  });

  it("knows external devices", () => {
    expect(AI_ACCOUNT_HOST_KINDS).toContain("external");
  });

  it("adds hosts by hand of every kind but external", () => {
    expect(AI_ACCOUNT_HOST_CREATABLE_KINDS).toEqual(["server", "ssh_host", "mac"]);
    for (const kind of AI_ACCOUNT_HOST_CREATABLE_KINDS) {
      expect(createAiAccountHostSchema.safeParse({ name: "Build box", kind }).success).toBe(true);
    }
    expect(createAiAccountHostSchema.safeParse({ name: "Build box", kind: "external" }).success).toBe(false);
    expect(createAiAccountHostSchema.safeParse({ name: "Build box", kind: "laptop" }).success).toBe(false);
  });
});

describe("execution device keys", () => {
  it.each([
    [{ host: "Runner.Example.COM", port: 22 }, "ssh:runner.example.com:22"],
    [{ host: " runner.example.com " }, "ssh:runner.example.com:22"],
    [{ host: "mini.example.com", port: "0022" }, "ssh:mini.example.com:22"],
    [{ host: "mini.example.com", port: " 2222 " }, "ssh:mini.example.com:2222"],
    [{ host: "mini.example.com", port: "" }, "ssh:mini.example.com:22"],
    [{ host: "mini.example.com", port: null }, "ssh:mini.example.com:22"],
    [{ host: "mini.example.com", port: 65535 }, "ssh:mini.example.com:65535"],
    // Only spaces are trimmed, as Postgres btrim does.
    [{ host: "\tTabbed.example" }, "ssh:\ttabbed.example:22"],
    [{ host: "   " }, null],
    [{ host: 42, port: 22 }, null],
    [{ port: 22 }, null],
    [{ host: "mini.example.com", port: "22a" }, null],
    [{ host: "mini.example.com", port: 22.5 }, null],
    [{ host: "mini.example.com", port: 123456 }, null],
    [{ host: "mini.example.com", port: -22 }, null],
    [{ host: "mini.example.com", port: true }, null],
  ])("derives the key of %j", (config, expected) => {
    expect(sshExecutionDeviceKey((config as { host?: unknown }).host, (config as { port?: unknown }).port)).toBe(expected);
  });

  it("names the Local device", () => {
    expect(LOCAL_EXECUTION_DEVICE_KEY).toBe("local");
  });
});

describe("pool run environment matchers", () => {
  it.each(["ANTHROPIC_BASE_URL", "ANTHROPIC_BEDROCK_BASE_URL", "CLAUDE_CODE_API_BASE_URL", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_BEDROCK", "https_proxy", "HTTPS_PROXY", "Http_Proxy", "all_proxy", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED"])(
    "flags %s",
    (key) => {
      expect(isPoolRunForbiddenEnvKey(key)).toBe(true);
    },
  );

  it.each(["ANTHROPIC_MODEL", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "NO_PROXY", "BASE_URL", "MY_ANTHROPIC_BASE_URL", "node_extra_ca_certs"])(
    "does not flag %s",
    (key) => {
      expect(isPoolRunForbiddenEnvKey(key)).toBe(false);
    },
  );

  it("covers the legacy routing list", () => {
    for (const key of POOL_RUN_LEGACY_ROUTING_ENV_KEYS) expect(isPoolRunForbiddenEnvKey(key)).toBe(true);
  });

  it("reports only keys that are set", () => {
    expect(findPoolRunForbiddenEnvKeys({
      ANTHROPIC_BASE_URL: "https://proxy.example",
      https_proxy: "http://127.0.0.1:8080",
      CLAUDE_CODE_USE_VERTEX: "",
      NODE_EXTRA_CA_CERTS: false,
      HTTP_PROXY: null,
      ANTHROPIC_MODEL: "claude-opus",
    })).toEqual(["ANTHROPIC_BASE_URL", "https_proxy"]);
    expect(findPoolRunForbiddenEnvKeys(null)).toEqual([]);
  });

  it("finds helper keys and routing overrides in Claude settings", () => {
    expect(findPoolRunSettingsConflicts({
      apiKeyHelper: "/usr/local/bin/key",
      env: { ANTHROPIC_BASE_URL: "https://proxy.example", ANTHROPIC_MODEL: "claude-opus" },
      permissions: { allow: [] },
    })).toEqual(["apiKeyHelper", "env.ANTHROPIC_BASE_URL"]);
    expect(findPoolRunSettingsConflicts({ awsCredentialExport: "", env: [] })).toEqual([]);
    expect(findPoolRunSettingsConflicts("not settings")).toEqual([]);
  });

  it("lists the credential carriers to delete", () => {
    expect(POOL_RUN_REMOVED_ENV_KEYS).toHaveLength(10);
    expect(POOL_RUN_REMOVED_ENV_KEYS).toContain("CLAUDE_SECURESTORAGE_CONFIG_DIR");
    expect(POOL_RUN_REMOVED_ENV_KEYS).toContain("ANTHROPIC_UNIX_SOCKET");
  });

  it("recognises credential types and the credential reference", () => {
    expect(credentialTypeOfValue(subscriptionToken)).toBe("subscription");
    expect(credentialTypeOfValue(apiKey)).toBe("api_key");
    expect(credentialTypeOfValue("sk-other")).toBeNull();
    expect(AI_CREDENTIAL_REF_PATTERN.test("0123456789abcdef")).toBe(true);
    expect(AI_CREDENTIAL_REF_PATTERN.test("0123456789ABCDEF")).toBe(false);
  });
});

describe("account states and reasons", () => {
  const now = new Date("2026-10-16T12:00:00.000Z");

  it("derives the badge state in precedence order", () => {
    expect(deriveAiAccountState({ status: "disabled", adminDisabledAt: now.toISOString() }, now)).toBe("admin_disabled");
    expect(deriveAiAccountState({ status: "disabled" }, now)).toBe("withdrawn");
    expect(deriveAiAccountState({ status: "auth_failed", exhaustedUntil: "2026-10-16T13:00:00.000Z" }, now)).toBe("signed_out");
    expect(deriveAiAccountState({ status: "active", exhaustedUntil: "2026-10-16T13:00:00.000Z" }, now)).toBe("limited");
    expect(deriveAiAccountState({ status: "active", exhaustedUntil: "2026-10-16T11:00:00.000Z" }, now)).toBe("active");
  });

  it("covers every planCredential reason in the unselectable reasons and the account lane", () => {
    for (const reason of AI_ACCOUNT_PLAN_WAIT_REASONS) {
      expect(AI_ACCOUNT_UNSELECTABLE_REASONS).toContain(reason);
      expect(AI_ACCOUNT_WAIT_REASONS).toContain(reason);
    }
  });
});

describe("resource wait guards", () => {
  it("recognises the lanes", () => {
    for (const lane of RESOURCE_WAIT_RETRY_REASONS) expect(isResourceWaitRetryReason(lane)).toBe(true);
    expect(isResourceWaitRetryReason("workspace_busy")).toBe(false);
    expect(isResourceWaitRetryReason("ai_connection_pool_wait")).toBe(false);
    expect(isResourceWaitRetryReason(undefined)).toBe(false);
    for (const kind of RESOURCE_WAIT_KINDS) expect(RESOURCE_WAIT_RETRY_REASONS).toContain(RESOURCE_WAIT_LANE_BY_KIND[kind]);
  });

  it("recognises the error codes", () => {
    for (const code of RESOURCE_WAIT_ERROR_CODES) expect(isResourceWaitErrorCode(code)).toBe(true);
    expect(isResourceWaitErrorCode("workspace_busy")).toBe(false);
    expect(isResourceWaitErrorCode("setup_failed")).toBe(false);
    expect(isResourceWaitErrorCode(null)).toBe(false);
  });

  it("gives every reason a notice policy", () => {
    for (const reason of RESOURCE_WAIT_REASONS) {
      expect(isResourceWaitReason(reason)).toBe(true);
      expect(RESOURCE_WAIT_NOTICE_POLICY[reason]).toBeDefined();
    }
    expect(RESOURCE_WAIT_NOTICE_POLICY.stopped).toBe("never");
    expect(RESOURCE_WAIT_NOTICE_POLICY.usage_limit).toBe("immediate");
    expect(RESOURCE_WAIT_NOTICE_POLICY.offline).toBe("after_threshold");
  });

  it("adds the resource wait attention kind", () => {
    expect(ATTENTION_SOURCE_KINDS).toContain("resource_wait_alert");
  });
});

describe("readResourceWaitContext", () => {
  const context = {
    version: 1,
    episodeId: "episode-1",
    kind: "environment",
    reason: "offline",
    scope: "target",
    environmentId: "environment-1",
    environmentName: "Build box",
    deviceId: "device-1",
    deviceName: "Build box",
    accountId: null,
    accountLabel: null,
    resumeAt: null,
    resumeAtSource: null,
    message: "The device is offline.",
  };

  it("reads a version 1 context", () => {
    expect(readResourceWaitContext(context)).toEqual(context);
    expect(readResourceWaitContext({
      ...context,
      kind: "ai_account",
      reason: "usage_limit",
      scope: "account",
      resumeAt: "2026-10-16T18:00:00.000Z",
      resumeAtSource: "estimated",
    })?.resumeAtSource).toBe("estimated");
  });

  it.each([
    ["another version", { ...context, version: 2 }],
    ["no episode", { ...context, episodeId: "" }],
    ["a reason of another kind", { ...context, reason: "usage_limit" }],
    ["a scope of another kind", { ...context, scope: "account" }],
    ["an unknown resume source", { ...context, resumeAt: "2026-10-16T18:00:00.000Z", resumeAtSource: "guess" }],
    ["an unparseable resume time", { ...context, resumeAt: "soon" }],
    ["a non-string name", { ...context, environmentName: 42 }],
    ["a non-object", "offline"],
  ])("rejects %s", (_label, value) => {
    expect(readResourceWaitContext(value)).toBeNull();
  });

  it("cuts long names and messages instead of losing the wait", () => {
    const longName = `Build ${"box ".repeat(61)}`.trim();
    expect(longName.length).toBeGreaterThan(240);
    const read = readResourceWaitContext({
      ...context,
      environmentName: longName,
      deviceName: "d".repeat(250),
      accountLabel: `${"a".repeat(199)}\u{1F600}`,
      message: "x".repeat(301),
    });
    expect(read).not.toBeNull();
    expect(read!.environmentName).toBe(longName.slice(0, 200).trimEnd());
    expect(read!.deviceName).toBe("d".repeat(200));
    // A cut never splits a surrogate pair.
    expect(read!.accountLabel).toBe("a".repeat(199));
    expect(read!.message).toBe("x".repeat(300));
  });

  it("builds a context the reader accepts, with long text cut", () => {
    const built = buildResourceWaitContext({
      episodeId: "episode-1",
      kind: "environment",
      reason: "offline",
      scope: "target",
      environmentId: "environment-1",
      environmentName: `  ${"e".repeat(250)}  `,
      deviceId: null,
      deviceName: "   ",
      accountId: null,
      accountLabel: null,
      resumeAt: null,
      resumeAtSource: null,
      message: "m".repeat(400),
    });
    expect(built).toMatchObject({ version: 1, environmentName: "e".repeat(200), deviceName: null, message: "m".repeat(300) });
    expect(readResourceWaitContext(built)).toEqual(built);
  });
});
