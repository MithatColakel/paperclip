import { describe, expect, it } from "vitest";
import { AI_ACCOUNT_HOST_KINDS, type AiAccountHostEnvironmentSummary } from "@paperclipai/shared";
import type { CurrentBoardAccess } from "@/api/access";
import { ApiError } from "@/api/client";
import { EXECUTION_DEVICE_KIND_LABELS } from "@/lib/ai-account-pool";
import { formatDateTime } from "@/lib/utils";
import {
  HOST_KIND_DESCRIPTIONS,
  HOST_KIND_DRIVERS,
  HOST_KIND_LABELS,
  MIGRATION_OUTCOME_LABELS,
  MIGRATION_RULE_LABELS,
  acceptedCredentialTypesText,
  accountOwnerText,
  aiAccountErrorMessage,
  aiAccountState,
  companyAgentCountsText,
  deviceLinkPlan,
  environmentChoicesForHost,
  formatUsageWindow,
  formatWaitHours,
  hostIsFull,
  importableConnections,
  isCompanyAdminAccess,
  isCompanyViewerAccess,
  maskEmail,
  migrationStatusText,
  notifyAfterHoursFromSelect,
  notifyAfterOptions,
  notifyAfterSelectValue,
  parseDeviceTargetKey,
  projectChipLabel,
  projectChoicesByCompany,
} from "./model";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const base = { status: "active" as const, statusMessage: null, exhaustedUntil: null, limitReason: null };

describe("aiAccountState", () => {
  it("is available without a current limit", () => {
    expect(aiAccountState(base, NOW)).toEqual({ kind: "available" });
    expect(aiAccountState({ ...base, exhaustedUntil: "2026-10-14T11:00:00Z", limitReason: "provider_quota" }, NOW))
      .toEqual({ kind: "available" });
  });

  it("is limited until a future reset, with its reason", () => {
    expect(aiAccountState({ ...base, exhaustedUntil: "2026-10-14T13:00:00Z", limitReason: "credit_balance" }, NOW))
      .toEqual({ kind: "limited", until: "2026-10-14T13:00:00Z", reason: "credit_balance" });
  });

  it("puts sign-in failures and switched-off accounts ahead of limits", () => {
    const limited = { exhaustedUntil: "2026-10-14T13:00:00Z", limitReason: "manual" as const };
    expect(aiAccountState({ ...base, ...limited, status: "auth_failed", statusMessage: "Token revoked" }, NOW))
      .toEqual({ kind: "auth_failed", message: "Token revoked" });
    expect(aiAccountState({ ...base, ...limited, status: "disabled" }, NOW)).toEqual({ kind: "disabled" });
    expect(aiAccountState({ ...base, poolEnabled: false }, NOW)).toEqual({ kind: "out_of_pool" });
    expect(aiAccountState({ ...base, poolEnabled: false, ...limited }, NOW)).toMatchObject({ kind: "limited" });
  });
});

describe("maskEmail", () => {
  it("keeps the first two letters and the domain", () => {
    expect(maskEmail("mithat@example.com")).toBe("mi•••@example.com");
    expect(maskEmail("a@example.com")).toBe("a•••@example.com");
    expect(maskEmail("team-account")).toBe("te•••");
    expect(maskEmail("  ")).toBeNull();
    expect(maskEmail(null)).toBeNull();
  });
});

describe("hostIsFull", () => {
  it("uses the lower of the host limit and the instance ceiling", () => {
    const accounts = [{}, {}] as never[];
    expect(hostIsFull({ maxAccounts: 2, accounts }, 3)).toBe(true);
    expect(hostIsFull({ maxAccounts: 3, accounts }, 3)).toBe(false);
    expect(hostIsFull({ maxAccounts: 5, accounts: [{}, {}, {}] as never[] }, 3)).toBe(true);
  });
});

describe("environmentChoicesForHost", () => {
  const env = (id: string, driver: string): AiAccountHostEnvironmentSummary => ({ id, name: id, driver, companyId: null });

  it("offers the host's own environments plus unmapped ones with a fitting driver", () => {
    const local = env("local-b", "local");
    const ssh = env("runner", "ssh");
    const sandbox = env("sandbox", "sandbox");
    expect(environmentChoicesForHost({ kind: "server", environments: [env("local-a", "local")] }, [local, ssh, sandbox])
      .map((choice) => choice.id)).toEqual(["local-a", "local-b"]);
    expect(environmentChoicesForHost({ kind: "ssh_host", environments: [] }, [local, ssh, sandbox])
      .map((choice) => choice.id)).toEqual(["runner"]);
    expect(environmentChoicesForHost({ kind: "mac", environments: [ssh] }, [ssh])
      .map((choice) => choice.id)).toEqual(["runner"]);
  });

  it("lets a computer reached over SSH take plugin environments too, and a plugin device only those (spec 6.1)", () => {
    const ssh = env("runner", "ssh");
    const sandbox = env("sandbox", "sandbox");
    const local = env("local", "local");
    expect(environmentChoicesForHost({ kind: "mac", environments: [] }, [local, ssh, sandbox])
      .map((choice) => choice.id)).toEqual(["runner", "sandbox"]);
    expect(environmentChoicesForHost({ kind: "external", environments: [] }, [local, ssh, sandbox])
      .map((choice) => choice.id)).toEqual(["sandbox"]);
    expect(HOST_KIND_DRIVERS).toEqual({
      server: ["local"],
      ssh_host: ["ssh"],
      mac: ["ssh", "sandbox"],
      external: ["sandbox"],
    });
  });
});

describe("device kind wording", () => {
  it("uses the device pages' generic names and never names a product", () => {
    expect(HOST_KIND_LABELS).toEqual(EXECUTION_DEVICE_KIND_LABELS);
    for (const kind of AI_ACCOUNT_HOST_KINDS) {
      expect(`${HOST_KIND_LABELS[kind]} ${HOST_KIND_DESCRIPTIONS[kind]}`).not.toMatch(/\bmacs?\b/i);
    }
  });
});

describe("importableConnections", () => {
  const connection = (overrides: Record<string, unknown>) => ({
    id: "c", grantId: "g", companyId: "co", provider: "anthropic", method: "subscription", name: "Mine",
    ownership: "personal", ownerUserId: "me", isDefault: false, status: "connected", ...overrides,
  });

  it("keeps only the user's own Claude connections of the chosen type", () => {
    const list = {
      currentUserId: "me",
      connections: [
        connection({ id: "own-sub" }),
        connection({ id: "own-key", method: "api_key" }),
        connection({ id: "shared", ownership: "shared", ownerUserId: undefined }),
        connection({ id: "someone-else", ownerUserId: "other" }),
        connection({ id: "openai", provider: "openai" }),
      ],
    } as never;
    expect(importableConnections(list, "subscription").map((item) => item.id)).toEqual(["own-sub"]);
    expect(importableConnections(list, "api_key").map((item) => item.id)).toEqual(["own-key"]);
    expect(importableConnections(undefined, "subscription")).toEqual([]);
  });
});

describe("aiAccountErrorMessage", () => {
  it("prefers field-level validation messages", () => {
    const error = new ApiError("Validation error", 400, {
      error: "Validation error",
      details: [{ message: "A subscription token from `claude setup-token` starts with sk-ant-oat" }],
    });
    expect(aiAccountErrorMessage(error)).toBe("A subscription token from `claude setup-token` starts with sk-ant-oat");
  });

  it("passes conflict and other server messages through", () => {
    const error = new ApiError("Paperclip server already has 3 accounts, the most a host can have", 409, {});
    expect(aiAccountErrorMessage(error)).toBe("Paperclip server already has 3 accounts, the most a host can have");
    expect(aiAccountErrorMessage(null)).toBeNull();
  });
});

describe("project reservations", () => {
  const project = (id: string, name: string, companyId: string, companyName: string, issuePrefix: string) =>
    ({ id, name, companyId, companyName, issuePrefix });

  it("labels a project with its issue prefix", () => {
    expect(projectChipLabel(project("p", "Mobile app", "c", "Cleanio", "CLE"))).toBe("CLE · Mobile app");
  });

  it("groups projects by company in name order and keeps reserved projects missing from the list", () => {
    const web = project("web", "Website", "a", "Cleanio", "CLE");
    const mobile = project("mobile", "Mobile app", "a", "Cleanio", "CLE");
    const vpn = project("vpn", "VPN core", "b", "Presto", "PRE");
    const archived = project("old", "Old site", "a", "Cleanio", "CLE");
    expect(projectChoicesByCompany([vpn, web, mobile], [archived, web]).map((group) => [
      group.companyName,
      group.projects.map((item) => item.id),
    ])).toEqual([
      ["Cleanio", ["mobile", "old", "web"]],
      ["Presto", ["vpn"]],
    ]);
  });
});

describe("formatUsageWindow", () => {
  it("counts runs and formats tokens compactly, with cached input apart", () => {
    expect(formatUsageWindow({ runs: 1, inputTokens: 12_345_678, cachedInputTokens: 0, outputTokens: 840_000, costCents: 0 }))
      .toEqual({ summary: "1 run · 12.3M in · 840.0k out", cached: null });
    expect(formatUsageWindow({ runs: 2, inputTokens: 500, cachedInputTokens: 2_500, outputTokens: 0, costCents: 9 }))
      .toEqual({ summary: "2 runs · 500 in · 0 out", cached: "+ 2.5k cached" });
  });
});

describe("linking one machine reached two ways", () => {
  const PLUGIN = "0b9a3c52-1f0e-4a77-9b51-6d9c2a1e4f10";
  const external = { id: "dev-ext", name: "Studio", kind: "external" as const, targetKey: `target:${PLUGIN}:remote-box:box:studio` };
  const ssh = { id: "dev-ssh", name: "SSH · tunnel", kind: "ssh_host" as const, targetKey: null };

  it("splits a target key as the server does, keeping colons in the plugin's own key", () => {
    expect(parseDeviceTargetKey(external.targetKey)).toEqual({ pluginId: PLUGIN, provider: "remote-box", targetKey: "box:studio" });
    expect(parseDeviceTargetKey("ssh:10.0.0.5:22")).toBeNull();
    expect(parseDeviceTargetKey(`target:not-a-uuid:remote-box:x`)).toBeNull();
    expect(parseDeviceTargetKey(null)).toBeNull();
  });

  it("links the device reached over SSH to the plugin device's target, in either order", () => {
    const plan = {
      device: { id: "dev-ssh", name: "SSH · tunnel" },
      target: { id: "dev-ext", name: "Studio" },
      input: { pluginId: PLUGIN, provider: "remote-box", targetKey: "box:studio" },
    };
    expect(deviceLinkPlan(ssh, external)).toEqual(plan);
    expect(deviceLinkPlan(external, { ...ssh, kind: "mac" })).toEqual(plan);
  });

  it("refuses pairs the server would refuse", () => {
    expect(deviceLinkPlan({ ...ssh, kind: "server" }, external)).toBeNull();
    expect(deviceLinkPlan({ ...ssh, targetKey: "target:other" }, external)).toBeNull();
    expect(deviceLinkPlan(ssh, { ...external, targetKey: null })).toBeNull();
    expect(deviceLinkPlan(ssh, { ...ssh, id: "dev-ssh-2" })).toBeNull();
  });
});

describe("device and account text", () => {
  it("names a restricted credential type only", () => {
    expect(acceptedCredentialTypesText(null)).toBeNull();
    expect(acceptedCredentialTypesText(["subscription", "api_key"])).toBeNull();
    expect(acceptedCredentialTypesText(["subscription"])).toBe("Takes subscription accounts only");
    expect(acceptedCredentialTypesText(["api_key"])).toBe("Takes API key accounts only");
    expect(acceptedCredentialTypesText([])).toBe("Takes no Claude accounts");
  });

  it("counts agents per company", () => {
    expect(companyAgentCountsText([])).toBeNull();
    expect(companyAgentCountsText([
      { companyName: "Cleanio", agentCount: 2 },
      { companyName: "Presto", agentCount: 1 },
    ])).toBe("Cleanio: 2 agents · Presto: 1 agent");
  });

  it("shows the owner, or that a legacy account has none", () => {
    expect(accountOwnerText({ userId: "u", name: "Ada", email: "ada@example.com" })).toBe("Ada · ada@example.com");
    expect(accountOwnerText({ userId: "u", name: null, email: "ad•••@example.com" })).toBe("ad•••@example.com");
    expect(accountOwnerText({ userId: "u", name: " ", email: null })).toBe("Unknown user");
    expect(accountOwnerText(null)).toBe("No owner");
  });
});

describe("company admin and viewer access (decisions D4 and D10)", () => {
  const access = (overrides: Partial<CurrentBoardAccess>): CurrentBoardAccess => ({
    user: null,
    userId: "me",
    isInstanceAdmin: false,
    companyIds: [],
    memberships: [],
    source: "session",
    keyId: null,
    ...overrides,
  });
  const member = (membershipRole: "owner" | "admin" | "operator" | "viewer", status: "active" | "suspended" = "active") =>
    access({ companyIds: ["c"], memberships: [{ companyId: "c", membershipRole, status }] });

  it("treats the local board, owners, admins and instance admins with company access as company admins", () => {
    expect(isCompanyAdminAccess("c", access({ source: "local_implicit" }))).toBe(true);
    expect(isCompanyAdminAccess("c", member("owner"))).toBe(true);
    expect(isCompanyAdminAccess("c", member("admin"))).toBe(true);
    expect(isCompanyAdminAccess("c", { ...member("viewer"), isInstanceAdmin: true })).toBe(true);
    expect(isCompanyAdminAccess("c", member("operator"))).toBe(false);
    expect(isCompanyAdminAccess("c", member("admin", "suspended"))).toBe(false);
    // An instance admin who is not a member of the company is not its admin.
    expect(isCompanyAdminAccess("c", access({ isInstanceAdmin: true }))).toBe(false);
    expect(isCompanyAdminAccess("c", undefined)).toBe(false);
    expect(isCompanyAdminAccess(null, member("owner"))).toBe(false);
  });

  it("knows a viewer only from an active viewer membership", () => {
    expect(isCompanyViewerAccess("c", member("viewer"))).toBe(true);
    expect(isCompanyViewerAccess("c", member("operator"))).toBe(false);
    expect(isCompanyViewerAccess("c", { ...member("viewer"), isInstanceAdmin: true })).toBe(false);
    expect(isCompanyViewerAccess("c", undefined)).toBe(false);
  });
});

describe("wait notice settings", () => {
  it("formats hours and days", () => {
    expect(formatWaitHours(1)).toBe("1 hour");
    expect(formatWaitHours(24)).toBe("24 hours");
    expect(formatWaitHours(48)).toBe("2 days");
    expect(formatWaitHours(168)).toBe("7 days");
    expect(formatWaitHours(36)).toBe("36 hours");
  });

  it("maps null to the instance default and 0 to never, both ways", () => {
    expect(notifyAfterSelectValue(null)).toBe("default");
    expect(notifyAfterSelectValue(0)).toBe("never");
    expect(notifyAfterSelectValue(12)).toBe("12");
    expect(notifyAfterHoursFromSelect("default")).toBeNull();
    expect(notifyAfterHoursFromSelect("never")).toBe(0);
    expect(notifyAfterHoursFromSelect("72")).toBe(72);
    expect(() => notifyAfterHoursFromSelect("soon")).toThrow();
  });

  it("offers the default first, the presets plus a stored custom value, then never", () => {
    const options = notifyAfterOptions({ notifyAfterHours: 5, instanceDefaultHours: 24 });
    expect(options[0]).toEqual({ value: "default", label: "Instance default (24 hours)" });
    expect(options.at(-1)).toEqual({ value: "never", label: "Never" });
    expect(options.map((option) => option.value)).toContain("5");
    expect(options.map((option) => option.value).slice(1, -1)).toEqual(["1", "2", "4", "5", "8", "12", "24", "48", "72", "168"]);
    expect(notifyAfterOptions({ notifyAfterHours: null, instanceDefaultHours: 0 })[0]!.label).toBe("Instance default (never)");
  });
});

describe("migration report text", () => {
  it("states the job's status", () => {
    expect(migrationStatusText({ status: "pending", attempts: 0, completedAt: null, lastError: null })).toBe("Not run yet.");
    expect(migrationStatusText({ status: "running", attempts: 1, completedAt: null, lastError: null })).toBe("Running now…");
    expect(migrationStatusText({ status: "completed", attempts: 1, completedAt: "2026-10-16T10:02:00.000Z", lastError: null }))
      .toBe(`Completed ${formatDateTime("2026-10-16T10:02:00.000Z")} · 1 attempt`);
    expect(migrationStatusText({ status: "failed", attempts: 2, completedAt: null, lastError: "lock timeout" }))
      .toBe("Failed after 2 attempts: lock timeout");
  });

  it("labels every rule and outcome", () => {
    expect(Object.keys(MIGRATION_RULE_LABELS).sort()).toEqual(["agent_history", "company_history", "company_pool_fingerprint", "reservation"]);
    expect(MIGRATION_OUTCOME_LABELS).toEqual({ bound: "Assigned", unassigned: "Waiting for an account", unbound: "Not assigned" });
  });
});
