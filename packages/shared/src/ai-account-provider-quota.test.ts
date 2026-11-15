import { describe, expect, it } from "vitest";
import { AI_ACCOUNT_PROVIDER_QUOTA_MAX_WINDOWS, normalizeAiAccountProviderQuota } from "./ai-account-hosts.js";

describe("normalizeAiAccountProviderQuota", () => {
  it("keeps a valid report and drops unknown fields", () => {
    expect(normalizeAiAccountProviderQuota({
      status: "allowed",
      usingOverage: false,
      runId: "should-not-survive",
      windows: [{ id: "seven_day", usedPercent: 32.04, resetsAt: "2026-11-20T06:00:00Z", status: "allowed", raw: "x" }],
    })).toEqual({
      status: "allowed",
      usingOverage: false,
      windows: [{ id: "seven_day", usedPercent: 32, resetsAt: "2026-11-20T06:00:00.000Z", status: "allowed" }],
    });
  });

  it("drops bad windows, duplicates and bad values, and caps the window count", () => {
    const windows = [
      { id: "five_hour", usedPercent: -1, resetsAt: "not a date", status: "Not A Word" },
      { id: "five_hour", usedPercent: 50 },
      { id: "Bad Id", usedPercent: 10 },
      "junk",
      ...Array.from({ length: 12 }, (_, index) => ({ id: `w${index}`, usedPercent: 1 })),
    ];
    const normalized = normalizeAiAccountProviderQuota({ status: 7, usingOverage: "yes", windows });
    expect(normalized?.status).toBeNull();
    expect(normalized?.usingOverage).toBeNull();
    expect(normalized?.windows[0]).toEqual({ id: "five_hour", usedPercent: null, resetsAt: null, status: null });
    expect(normalized?.windows).toHaveLength(AI_ACCOUNT_PROVIDER_QUOTA_MAX_WINDOWS);
  });

  it("returns null without a readable window", () => {
    for (const value of [null, undefined, "x", [], {}, { windows: [] }, { windows: [{ id: "" }] }]) {
      expect(normalizeAiAccountProviderQuota(value)).toBeNull();
    }
  });
});
