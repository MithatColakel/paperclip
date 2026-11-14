import { describe, expect, it } from "vitest";
import { createMinIntervalGate } from "../services/min-interval-gate.ts";

describe("createMinIntervalGate", () => {
  it("runs the first request and then at most once per interval", () => {
    let clock = 1_000;
    const gate = createMinIntervalGate({ intervalMs: 900_000, now: () => clock });
    expect(gate.tryStart()).toBe(true);
    for (let tick = 0; tick < 29; tick += 1) {
      clock += 30_000;
      expect(gate.tryStart()).toBe(false);
    }
    clock += 30_000;
    expect(gate.tryStart()).toBe(true);
    clock += 30_000;
    expect(gate.tryStart()).toBe(false);
  });

  it("allows every request when the interval is unset or not positive", () => {
    for (const intervalMs of [0, -1, Number.NaN]) {
      const gate = createMinIntervalGate({ intervalMs, now: () => 0 });
      expect(gate.tryStart()).toBe(true);
      expect(gate.tryStart()).toBe(true);
    }
  });
});
