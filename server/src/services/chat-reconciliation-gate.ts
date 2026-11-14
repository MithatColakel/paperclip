import type { LiveEvent } from "@paperclipai/shared";

/**
 * Fork: keeps the per-second chat reconciliation quiet on an instance without
 * chat channels.
 *
 * Every reconciliation lane (provider runtimes, voice sessions, GitHub webhook
 * recovery, run milestones, publication maintenance) reads chat endpoint rows.
 * With no endpoint row and no provider runtime held in memory, each lane only
 * proves that it is still idle, and Postgres re-plans those multi-join queries
 * on every tick. The gate replaces that with one cheap existence check: on a
 * slow cadence, and right after a tool connection or chat endpoint changes.
 *
 * Trigger: `tick()` on the existing chat timer, `wake()` on channel changes.
 * Source of truth: the chat service's `hasReconcilableChannelState()`.
 * Quiet when: the last check found no channel state; ticks then run no SQL
 * until the next recheck is due or a change wakes the gate.
 * A failed check counts as active, so an error keeps today's behaviour.
 */
export function createChatReconciliationGate(input: {
  hasChannelState: () => Promise<boolean>;
  recheckMs: number;
  now?: () => number;
  onError?: (error: unknown) => void;
}) {
  const now = input.now ?? Date.now;
  // null until the first check settles: nothing runs on an unknown answer
  // except the caller's own startup pass.
  let active: boolean | null = null;
  let checkedAt = 0;
  let stale = true;
  let checking: Promise<void> | null = null;
  let stopped = false;

  const recheck = () => {
    if (checking || stopped) return;
    stale = false;
    checking = input
      .hasChannelState()
      .then(
        (value) => {
          active = value;
        },
        (error) => {
          active = true;
          input.onError?.(error);
        },
      )
      .finally(() => {
        checkedAt = now();
        checking = null;
      });
  };

  return {
    /** Runs `reconcile` while channel state exists; otherwise stays quiet. */
    tick(reconcile: () => void) {
      if (stopped) return;
      if (stale || now() - checkedAt >= input.recheckMs) recheck();
      if (active === true) reconcile();
    },
    /** False only when the last check found no channel state. */
    mayHaveChannels() {
      return active !== false;
    },
    /** A channel may have appeared or gone; recheck on the next tick. */
    wake() {
      stale = true;
    },
    stop() {
      stopped = true;
    },
    /** Test seam: settles an in-flight check. */
    async settled() {
      await checking;
    },
  };
}

/**
 * Chat endpoints are created, paused and removed under a tool connection and
 * logged as `tool_connection` activity (`chat_endpoint.created`, email channel
 * audits). Any such change may add or remove the instance's first channel.
 */
export function isChatChannelStateSignal(
  event: Pick<LiveEvent, "type" | "payload">,
): boolean {
  if (event.type !== "activity.logged") return false;
  const payload = event.payload as Record<string, unknown>;
  if (payload.entityType === "tool_connection") return true;
  const action = payload.action;
  return typeof action === "string" && (action.startsWith("chat_endpoint.") || action.startsWith("chat."));
}
