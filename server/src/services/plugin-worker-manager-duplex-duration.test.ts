import { describe, expect, it } from "vitest";
import {
  DEFAULT_DUPLEX_CHANNEL_MAX_DURATION_MS,
  resolveDuplexChannelMaxDurationMs,
} from "./plugin-worker-manager.js";

describe("duplex channel route lifetime", () => {
  it("defaults to 6 hours so a Mac run longer than an hour keeps its API channel", () => {
    expect(DEFAULT_DUPLEX_CHANNEL_MAX_DURATION_MS).toBe(6 * 60 * 60 * 1000);
    expect(resolveDuplexChannelMaxDurationMs(undefined)).toBe(DEFAULT_DUPLEX_CHANNEL_MAX_DURATION_MS);
    expect(resolveDuplexChannelMaxDurationMs("")).toBe(DEFAULT_DUPLEX_CHANNEL_MAX_DURATION_MS);
  });

  it("takes an operator value inside 1 minute to 24 hours", () => {
    expect(resolveDuplexChannelMaxDurationMs("3600000")).toBe(3_600_000);
    expect(resolveDuplexChannelMaxDurationMs(" 14400000 ")).toBe(14_400_000);
    expect(resolveDuplexChannelMaxDurationMs("60000")).toBe(60_000);
    expect(resolveDuplexChannelMaxDurationMs("86400000")).toBe(86_400_000);
  });

  it("keeps the bound when the value is invalid or out of range", () => {
    for (const raw of ["0", "59999", "86400001", "-1", "1e7", "6h", "abc", "1.5"]) {
      expect(resolveDuplexChannelMaxDurationMs(raw)).toBe(DEFAULT_DUPLEX_CHANNEL_MAX_DURATION_MS);
    }
  });
});
