import { describe, expect, it, vi } from "vitest";
import {
  createChatReconciliationGate,
  isChatChannelStateSignal,
} from "../services/chat-reconciliation-gate.ts";

function harness(initial: boolean | Error, recheckMs = 30_000) {
  let clock = 1_000_000;
  let answer: boolean | Error = initial;
  const hasChannelState = vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const onError = vi.fn();
  const reconcile = vi.fn();
  const gate = createChatReconciliationGate({
    hasChannelState,
    recheckMs,
    now: () => clock,
    onError,
  });
  const tick = async (advanceMs = 1_000) => {
    clock += advanceMs;
    gate.tick(reconcile);
    await gate.settled();
  };
  return {
    gate,
    hasChannelState,
    onError,
    reconcile,
    tick,
    set: (value: boolean | Error) => {
      answer = value;
    },
  };
}

describe("createChatReconciliationGate", () => {
  it("stays quiet without channel state and only rechecks on the slow cadence", async () => {
    const h = harness(false);
    expect(h.gate.mayHaveChannels()).toBe(true);

    await h.tick();
    expect(h.hasChannelState).toHaveBeenCalledTimes(1);
    expect(h.gate.mayHaveChannels()).toBe(false);

    // 29 one-second ticks inside the recheck window: no reconcile, no new check.
    for (let i = 0; i < 29; i += 1) await h.tick();
    expect(h.reconcile).not.toHaveBeenCalled();
    expect(h.hasChannelState).toHaveBeenCalledTimes(1);

    await h.tick();
    expect(h.hasChannelState).toHaveBeenCalledTimes(2);
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  it("rechecks on the next tick after a wake and resumes reconciling when a channel appears", async () => {
    const h = harness(false);
    await h.tick();
    await h.tick();
    expect(h.hasChannelState).toHaveBeenCalledTimes(1);

    h.set(true);
    h.gate.wake();
    await h.tick();
    expect(h.hasChannelState).toHaveBeenCalledTimes(2);
    expect(h.gate.mayHaveChannels()).toBe(true);

    await h.tick();
    await h.tick();
    expect(h.reconcile).toHaveBeenCalledTimes(2);
  });

  it("reconciles on every tick while channel state exists and goes quiet once it is gone", async () => {
    const h = harness(true);
    await h.tick();
    for (let i = 0; i < 10; i += 1) await h.tick();
    expect(h.reconcile).toHaveBeenCalledTimes(10);
    expect(h.hasChannelState).toHaveBeenCalledTimes(1);

    h.set(false);
    await h.tick(30_000);
    const callsWhenRemoved = h.reconcile.mock.calls.length;
    for (let i = 0; i < 5; i += 1) await h.tick();
    expect(h.reconcile).toHaveBeenCalledTimes(callsWhenRemoved);
    expect(h.gate.mayHaveChannels()).toBe(false);
  });

  it("keeps reconciling when the check fails", async () => {
    const error = new Error("database unavailable");
    const h = harness(error);
    await h.tick();
    await h.tick();
    expect(h.onError).toHaveBeenCalledWith(error);
    expect(h.reconcile).toHaveBeenCalled();
    expect(h.gate.mayHaveChannels()).toBe(true);
  });

  it("starts at most one check at a time", async () => {
    let release!: (value: boolean) => void;
    const hasChannelState = vi.fn(
      () => new Promise<boolean>((resolve) => { release = resolve; }),
    );
    const gate = createChatReconciliationGate({ hasChannelState, recheckMs: 0 });
    const reconcile = vi.fn();
    gate.tick(reconcile);
    gate.tick(reconcile);
    gate.wake();
    gate.tick(reconcile);
    expect(hasChannelState).toHaveBeenCalledTimes(1);
    release(true);
    await gate.settled();
    gate.tick(reconcile);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("does nothing after stop", async () => {
    const h = harness(true);
    h.gate.stop();
    await h.tick();
    expect(h.hasChannelState).not.toHaveBeenCalled();
    expect(h.reconcile).not.toHaveBeenCalled();
  });
});

describe("isChatChannelStateSignal", () => {
  it("wakes on tool connection and chat endpoint activity only", () => {
    expect(isChatChannelStateSignal({
      type: "activity.logged",
      payload: { action: "chat_endpoint.created", entityType: "tool_connection" },
    })).toBe(true);
    expect(isChatChannelStateSignal({
      type: "activity.logged",
      payload: { action: "chat.setup_completed", entityType: "company" },
    })).toBe(true);
    expect(isChatChannelStateSignal({
      type: "activity.logged",
      payload: { action: "issue.comment_added", entityType: "issue" },
    })).toBe(false);
    expect(isChatChannelStateSignal({
      type: "heartbeat.run.event",
      payload: { eventType: "run.presentation.resolved" },
    })).toBe(false);
  });
});
