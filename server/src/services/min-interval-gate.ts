/**
 * Fork: lets a duty that rides an existing scheduler tick start at most once
 * per interval. It adds no timer; the tick still decides when to ask.
 *
 * Used for the decision retention sweep, which rebuilds the full attention
 * feed of every active company only to archive items idle for 90 days.
 * `intervalMs <= 0` allows every request, which is the upstream behaviour.
 */
export function createMinIntervalGate(input: { intervalMs: number; now?: () => number }) {
  const now = input.now ?? Date.now;
  let lastStartedAt: number | null = null;
  return {
    /** True, and marks the start, when the duty may run now. The first request always runs. */
    tryStart() {
      const at = now();
      if (input.intervalMs > 0 && lastStartedAt !== null && at - lastStartedAt < input.intervalMs) return false;
      lastStartedAt = at;
      return true;
    },
  };
}
