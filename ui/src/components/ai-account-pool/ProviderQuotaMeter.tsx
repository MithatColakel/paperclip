import type { AiAccountProviderQuota, AiAccountProviderQuotaWindow } from "@paperclipai/shared";
import { formatResetTime } from "@/lib/ai-account-pool";
import { cn } from "@/lib/utils";

const WINDOW_LABELS: Record<string, string> = {
  five_hour: "5-hour limit",
  seven_day: "Weekly limit",
  seven_day_opus: "Weekly Opus limit",
  seven_day_sonnet: "Weekly Sonnet limit",
  seven_day_oauth_apps: "Weekly OAuth apps limit",
};

const WINDOW_ORDER = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_oauth_apps"];

export function providerQuotaWindowLabel(id: string): string {
  const known = WINDOW_LABELS[id];
  if (known) return known;
  const words = id.replaceAll("_", " ").trim();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} limit`;
}

function orderedWindows(windows: readonly AiAccountProviderQuotaWindow[]): AiAccountProviderQuotaWindow[] {
  const rank = (id: string) => {
    const index = WINDOW_ORDER.indexOf(id);
    return index === -1 ? WINDOW_ORDER.length : index;
  };
  return [...windows].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

function fillClass(usedPercent: number, rejected: boolean): string {
  if (rejected || usedPercent >= 90) return "bg-(--status-task-blocked)";
  if (usedPercent >= 70) return "bg-(--status-task-todo)";
  return "bg-primary/70";
}

function percentText(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** How old the reading is, measured against the same `now` as the resets. */
function readingAge(observedAt: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(observedAt).getTime()) / 60_000));
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Fork: the account's official Claude usage as Claude Code reported it during
 * the latest run on the account. It counts all use of the account, also
 * outside Paperclip, but it is only as fresh as that run. Display only.
 */
export function ProviderQuotaMeter({ quota, now }: { quota: AiAccountProviderQuota | null; now?: Date }) {
  if (!quota) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="provider-quota">
        Claude quota: no reading yet. It appears after the next run on this account.
      </p>
    );
  }
  const current = now ?? new Date();
  const nowMs = current.getTime();
  return (
    <div className="space-y-2" data-testid="provider-quota">
      {orderedWindows(quota.windows).map((window) => {
        const label = providerQuotaWindowLabel(window.id);
        const resetAt = window.resetsAt ? new Date(window.resetsAt) : null;
        const resetPassed = resetAt !== null && resetAt.getTime() <= nowMs;
        const rejected = window.status === "rejected";
        const used = window.usedPercent;
        const valueText = resetPassed
          ? "Reset"
          : rejected
            ? "Limit reached"
            : used !== null
              ? `${percentText(used)}% used`
              : "No reading";
        return (
          <div key={window.id} className="space-y-1" data-testid={`provider-quota-${window.id}`}>
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="font-medium text-foreground">{label}</span>
              <span className={cn("tabular-nums", rejected && !resetPassed ? "text-destructive" : "text-muted-foreground")}>
                {valueText}
              </span>
            </div>
            {!resetPassed && used !== null ? (
              <div
                className="h-2 overflow-hidden bg-muted"
                role="progressbar"
                aria-label={`${label} used`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.min(100, Math.max(0, used))}
              >
                <div
                  className={cn("h-full transition-(--tp-width) duration-200", fillClass(used, rejected))}
                  style={{ width: `${Math.min(100, Math.max(0, used))}%` }}
                />
              </div>
            ) : null}
            {resetAt ? (
              <p className="text-xs text-muted-foreground">
                {resetPassed
                  ? `Reset ${formatResetTime(resetAt, { now: current })}. The next run brings a new reading.`
                  : `Resets ${formatResetTime(resetAt, { now: current })}`}
              </p>
            ) : null}
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">
        Reported by Claude Code in a run {readingAge(quota.observedAt, current)}
        {quota.usingOverage ? "; extra usage is in use" : ""}. It includes use outside Paperclip.
      </p>
    </div>
  );
}
