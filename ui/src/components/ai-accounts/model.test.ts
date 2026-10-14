import { describe, expect, it } from "vitest";
import type { AiAccountHostEnvironmentSummary } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import {
  aiAccountErrorMessage,
  aiAccountState,
  environmentChoicesForHost,
  formatUsageWindow,
  hostIsFull,
  importableConnections,
  maskEmail,
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
