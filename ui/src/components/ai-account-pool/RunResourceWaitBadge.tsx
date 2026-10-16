import { describeResourceWaitRunState, type ResourceWaitRunLike } from "@/lib/resource-wait";
import { cn } from "@/lib/utils";

/**
 * Fork: "Waited", "Waiting" or "Resumed" on a run row that took part in a
 * resource wait. A deferral started no provider work, so it reads as a wait,
 * never as a failure or a retry. Other runs get no badge.
 */
export function RunResourceWaitBadge({ run, className }: { run: ResourceWaitRunLike; className?: string }) {
  const state = describeResourceWaitRunState(run);
  if (!state) return null;
  return (
    <span
      className={cn("shrink-0 rounded-md border px-1.5 text-(length:--text-nano) font-medium", state.tone, className)}
      title={state.detail ?? undefined}
      data-run-wait={state.kind}
    >
      {state.badgeLabel}
    </span>
  );
}
