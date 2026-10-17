import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Clock, Loader2, RefreshCw } from "lucide-react";
import type { IssueScheduledRetry } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { InlineBanner } from "@/components/InlineBanner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";
import {
  RESOURCE_WAIT_TONE_CLASS,
  describeResourceWaitCheckNow,
  describeResourceWaitRunGroup,
  describeScheduledResourceWait,
  scheduledResourceWait,
  type ResourceWaitCheckNowTone,
  type ResourceWaitCopy,
  type ResourceWaitLedgerRunLike,
} from "@/lib/resource-wait";
import { Link } from "@/lib/router";
import { cn, relativeTime } from "@/lib/utils";

/**
 * Fork: the waiting UI. A task whose run waits for an execution device, a
 * Claude account or a device account slot shows the wait, starts on its own,
 * and offers "Check now" (the existing retry-now route, which re-checks the
 * resource first and answers 409 while it is still unavailable).
 */

function waitIcon(copy: ResourceWaitCopy) {
  return copy.tone === "warning" ? AlertTriangle : Clock;
}

function useResourceWaitCheckNow(issueId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => issuesApi.retryScheduledRetryNow(issueId),
    onSettled: () => {
      for (const queryKey of [
        queryKeys.issues.detail(issueId),
        queryKeys.issues.activity(issueId),
        queryKeys.issues.runs(issueId),
        queryKeys.issues.liveRuns(issueId),
        queryKeys.issues.activeRun(issueId),
      ]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}

const CHECK_NOW_RESULT_CLASS: Record<ResourceWaitCheckNowTone, string> = {
  neutral: "text-muted-foreground",
  success: "text-emerald-700 dark:text-emerald-300",
  error: "text-red-700 dark:text-red-300",
};

/** "Check now" on a waiting task; the answer shows in place, never as a toast. */
export function ResourceWaitCheckNowButton({ issueId, className }: { issueId: string; className?: string }) {
  const check = useResourceWaitCheckNow(issueId);
  const result = check.isPending ? null : describeResourceWaitCheckNow(check.data, check.error);
  return (
    <div className={cn("flex flex-col items-stretch gap-1 sm:items-end", className)}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0 shadow-none"
        onClick={() => check.mutate()}
        disabled={check.isPending || result?.tone === "success"}
        data-testid="resource-wait-check-now"
      >
        {check.isPending ? (
          <span className="inline-flex items-center gap-1.5">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            Checking…
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Check now
          </span>
        )}
      </Button>
      {result ? (
        <span
          role="status"
          data-testid="resource-wait-check-now-result"
          className={cn("text-xs sm:text-right", CHECK_NOW_RESULT_CLASS[result.tone])}
        >
          {result.text}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The waiting card: what the task waits for, the fix when a person has to act,
 * whose run waits, and "Check now". The waiting run may be another agent's
 * than the assignee's (a mentioned agent's reply, or a wait that took the
 * issue's wait over), and a wait that joined another one may have no start
 * time of its own; the copy assumes neither.
 */
export function ResourceWaitBanner({
  issueId,
  scheduledRetry,
  className,
}: {
  issueId: string;
  scheduledRetry: IssueScheduledRetry | null | undefined;
  className?: string;
}) {
  const scheduled = scheduledResourceWait(scheduledRetry);
  if (!scheduled || !scheduledRetry) return null;
  const copy = describeScheduledResourceWait(scheduled);
  const agentName = scheduled.agentName?.trim();
  return (
    <div
      data-testid="resource-wait-banner"
      data-wait-kind={copy.kind}
      data-wait-reason={copy.reason ?? undefined}
      className={className}
    >
      <InlineBanner
        tone={copy.tone}
        icon={waitIcon(copy)}
        title={copy.title}
        actions={<ResourceWaitCheckNowButton issueId={issueId} />}
      >
        {copy.detail}
        <span className="mt-1 block text-xs" data-testid="resource-wait-run">
          Waiting run{" "}
          <Link to={`/agents/${scheduledRetry.agentId}/runs/${scheduledRetry.runId}`} className="font-mono hover:underline">
            {scheduledRetry.runId.slice(0, 8)}
          </Link>
          {agentName ? ` by ${agentName}` : null}
        </span>
      </InlineBanner>
    </div>
  );
}

/** The task-row chip, e.g. "Waiting for device: Build box" or "Waiting for limit reset: 18:00". */
export function ResourceWaitChip({
  scheduledRetry,
  selected = false,
}: {
  scheduledRetry: IssueScheduledRetry | null | undefined;
  selected?: boolean;
}) {
  const scheduled = scheduledResourceWait(scheduledRetry);
  if (!scheduled) return null;
  const copy = describeScheduledResourceWait(scheduled);
  const Icon = waitIcon(copy);
  return (
    <Badge
      variant="outline"
      data-testid="issue-row-resource-wait"
      data-wait-kind={copy.kind}
      role="status"
      aria-label={copy.title}
      title={`${copy.title}. ${copy.detail}`}
      className={cn(
        "shrink-0 gap-0.5 text-(length:--text-nano)",
        RESOURCE_WAIT_TONE_CLASS[copy.tone],
        selected ? "!border-muted-foreground !text-muted-foreground" : null,
      )}
    >
      <Icon className="h-2.5 w-2.5" aria-hidden />
      {copy.chip}
    </Badge>
  );
}

/** The properties-panel value of the "Waiting" row, e.g. "device Build box (offline since 13:02)". */
export function ResourceWaitPropertyValue({ scheduledRetry }: { scheduledRetry: IssueScheduledRetry | null | undefined }) {
  const scheduled = scheduledResourceWait(scheduledRetry);
  if (!scheduled) return null;
  const copy = describeScheduledResourceWait(scheduled);
  // Every title starts with "Waiting for"; the row label already says it.
  const value = copy.title.replace(/^Waiting for /, "");
  return (
    <span
      data-testid="issue-properties-resource-wait"
      className="min-w-0 truncate text-sm text-muted-foreground"
      title={`${copy.title}. ${copy.detail}`}
    >
      {value}
    </span>
  );
}

const LEDGER_RUN_LINKS = 5;

/** One run-ledger entry for consecutive wait runs: "Waited: device offline", instead of a column of cancellations. */
export function ResourceWaitLedgerEntry({
  runs,
  agentName,
  timestamp,
}: {
  runs: readonly ResourceWaitLedgerRunLike[];
  agentName: string;
  timestamp: string;
}) {
  const display = describeResourceWaitRunGroup(runs, { agentName });
  const shown = runs.slice(0, LEDGER_RUN_LINKS);
  return (
    <article
      data-testid="run-ledger-resource-wait"
      className="space-y-1.5 rounded-lg border border-border/60 px-3 py-2 text-xs text-muted-foreground"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="font-medium text-foreground">{display.label}</span>
        <span>by {agentName}</span>
        {display.attempts > 1 ? (
          <span className="rounded-md border border-border px-1.5 py-0.5 text-(length:--text-micro)">
            {display.attempts} attempts
          </span>
        ) : null}
        {display.duration ? (
          <span>{display.waiting ? `${display.duration} so far` : `for ${display.duration}`}</span>
        ) : null}
        <span className="ml-auto shrink-0">{relativeTime(timestamp)}</span>
      </div>
      {display.waiting && display.detail ? <p className="break-words">{display.detail}</p> : null}
      <p>
        {runs.length === 1 ? "Run " : "Runs "}
        {shown.map((run, index) => (
          <span key={run.runId}>
            {index > 0 ? ", " : null}
            <Link to={`/agents/${run.agentId}/runs/${run.runId}`} className="font-mono text-foreground hover:underline">
              {run.runId.slice(0, 8)}
            </Link>
          </span>
        ))}
        {runs.length > shown.length ? ` and ${runs.length - shown.length} more` : null}
      </p>
    </article>
  );
}
