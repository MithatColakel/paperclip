import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AgentAiAccountBindingSummary,
  CompanyAiAccountOption,
  CompanyAiAccountsResponse,
  SetAgentAiAccount,
  SetAgentAiAccountResponse,
} from "@paperclipai/shared";
import { getAdapterLabel } from "@/adapters/adapter-display-registry";
import { aiAccountPoolApi, aiAccountPoolKeys, invalidateAiAccountPoolQueries } from "@/api/ai-account-pool";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  accountOptionsWithCurrent,
  accountSelectValueForBinding,
  deviceDisplayName,
  isCurrentSelection,
} from "@/lib/agent-claude-account";
import {
  AI_ACCOUNT_BINDING_STATE_TEXT,
  POOL_BADGE_TONE_CLASS,
  aiAccountPoolErrorMessage,
  aiAccountSelectionWarningText,
  canChooseDeviceLogin,
  formatResetTime,
  isEstimatedSource,
  readAiAccountPoolError,
} from "@/lib/ai-account-pool";
import { Link } from "@/lib/router";
import { agentUrl, cn } from "@/lib/utils";
import { AccountSelect } from "./AccountSelect";

const WARNING_TEXT_CLASS = "text-amber-700 dark:text-amber-300";

/**
 * Spec 5.1: a company admin changes any binding; an owner switches an agent to
 * the device login or clears it only while it runs on one of the owner's own
 * accounts. Clearing follows the same rule as choosing the device login.
 */
function canClearBinding(binding: AgentAiAccountBindingSummary, canBindAny: boolean): boolean {
  return binding.mode !== null && binding.canChange && canChooseDeviceLogin({ canBindAny, binding });
}

function devicesText(binding: AgentAiAccountBindingSummary): string {
  const devices = binding.devices.map(deviceDisplayName);
  if (devices.length === 0) return binding.pinned ? "No known device" : "Device depends on the project";
  return binding.pinned ? devices.join(", ") : `Varies by project: ${devices.join(", ")}`;
}

/** What the binding means for the agent's tasks, when that needs saying. */
function bindingStatus(binding: AgentAiAccountBindingSummary, now?: Date): { text: string; warning: boolean } | null {
  switch (binding.state) {
    case "unbound":
      return { text: AI_ACCOUNT_BINDING_STATE_TEXT.unbound, warning: false };
    case "unassigned":
      return { text: AI_ACCOUNT_BINDING_STATE_TEXT.unassigned, warning: true };
    case "account_unavailable":
      // The picker already names it (see accountSelectValueForBinding).
      return { text: "Its tasks wait until someone chooses another account.", warning: true };
    case "device_login":
      return null;
    case "pool_account": {
      const account = binding.account;
      switch (account?.state) {
        case "limited": {
          const until = formatResetTime(account.exhaustedUntil, { now, estimated: isEstimatedSource(account.limitSource) });
          return { text: until ? `At its limit until ${until}. Tasks wait for the reset.` : "At its limit. Tasks wait for the reset.", warning: true };
        }
        case "signed_out":
          return { text: "Signed out. Tasks wait until its owner replaces the token.", warning: true };
        case "withdrawn":
          return { text: "Paused by its owner. Tasks wait until the owner resumes it.", warning: true };
        case "admin_disabled":
          return { text: "Disabled by an instance admin. Tasks wait until an admin turns it back on.", warning: true };
        default:
          return null;
      }
    }
  }
}

/** A refused change, with the environment or device a 422 names. */
function bindingErrorText(error: unknown): string {
  const message = aiAccountPoolErrorMessage(error);
  const info = readAiAccountPoolError(error);
  if (info?.code !== "ai_account_incompatible") return message;
  const where = [info.details?.deviceName, info.details?.environmentName]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return where ? `${where}: ${message}` : message;
}

/** The saved note: the change applies from the next run; running runs keep their account. */
function savedText(response: SetAgentAiAccountResponse, now?: Date): string {
  const parts = ["Saved. It applies from the agent's next run."];
  const running = response.runningRunIds.length;
  if (running === 1) parts.push("The run in progress keeps its account.");
  if (running > 1) parts.push(`The ${running} runs in progress keep their account.`);
  for (const warning of response.warnings) {
    parts.push(aiAccountSelectionWarningText(warning, response.account ?? {}, now));
  }
  return parts.join(" ");
}

function AgentName({ binding }: { binding: AgentAiAccountBindingSummary }) {
  return (
    <Link
      to={agentUrl({ id: binding.agentId, name: binding.agentName })}
      className="truncate text-sm font-medium hover:underline"
    >
      {binding.agentName}
    </Link>
  );
}

/**
 * Fork: every Claude agent of the company with the account it uses. Each row
 * changes the binding in place (`AccountSelect`); the server's refusals show
 * on the row. Migrated bindings wait for a company admin's review.
 */
export function BindingsTable({
  companyId,
  bindings,
  accounts,
  now,
}: {
  companyId: string;
  bindings: readonly AgentAiAccountBindingSummary[];
  /** The company's eligible accounts, shown until an agent's own list loads. */
  accounts: CompanyAiAccountsResponse | undefined;
  now?: Date;
}) {
  const queryClient = useQueryClient();
  const [reviewOnly, setReviewOnly] = useState(false);
  const canBindAny = accounts?.canBindAny ?? false;
  const companyOptions = accounts?.accounts ?? [];
  const claudeAgents = bindings.filter((binding) => binding.supported);
  const otherAdapters = bindings.filter((binding) => !binding.supported);
  const toReview = bindings.filter((binding) => binding.needsReview);
  const claudeToReview = claudeAgents.filter((binding) => binding.needsReview);
  const showReviewOnly = reviewOnly && claudeToReview.length > 0;
  const rows = showReviewOnly ? claudeToReview : claudeAgents;

  const confirmAll = useMutation({
    mutationFn: async (agentIds: string[]) => {
      const results = await Promise.allSettled(agentIds.map((agentId) => aiAccountPoolApi.reviewAgentBinding(agentId)));
      const failed = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed.length > 0) {
        throw new Error(
          `Could not confirm ${failed.length} of ${agentIds.length} assignments. ${aiAccountPoolErrorMessage(failed[0]!.reason)}`,
        );
      }
    },
    onSettled: () => invalidateAiAccountPoolQueries(queryClient),
  });

  return (
    <div className="space-y-3">
      {toReview.length > 0 && (
        <div
          role="region"
          aria-label="Review migrated assignments"
          className={cn("flex flex-wrap items-start justify-between gap-3 rounded-md border px-3 py-2", POOL_BADGE_TONE_CLASS.info)}
        >
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium">Review migrated assignments ({toReview.length})</p>
            <p className="text-xs">
              Paperclip chose these accounts when agents moved to their own Claude accounts. Check each one and change it if
              needed.{canBindAny ? " Then confirm it." : " A company admin confirms them."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {claudeToReview.length > 0 && (
              <Button type="button" size="sm" variant="outline" onClick={() => setReviewOnly((value) => !value)}>
                {showReviewOnly ? "Show all agents" : "Show only these"}
              </Button>
            )}
            {canBindAny && (
              <Button
                type="button"
                size="sm"
                disabled={confirmAll.isPending}
                onClick={() => {
                  confirmAll.reset();
                  confirmAll.mutate(toReview.map((binding) => binding.agentId));
                }}
              >
                {confirmAll.isPending ? "Confirming…" : "Confirm all"}
              </Button>
            )}
          </div>
          {confirmAll.error ? (
            <p role="alert" className="w-full text-xs text-destructive">
              {confirmAll.error.message}
            </p>
          ) : null}
        </div>
      )}

      {rows.length > 0 ? (
        <ul className="divide-y divide-border rounded-md border border-border">
          {rows.map((binding) => (
            <BindingRow
              key={binding.agentId}
              binding={binding}
              companyId={companyId}
              companyOptions={companyOptions}
              canBindAny={canBindAny}
              now={now}
            />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">This company has no Claude agents yet.</p>
      )}

      {otherAdapters.length > 0 && (
        <div className="space-y-2" role="region" aria-label="Agents on another adapter">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">Agents on another adapter</p>
            <p className="text-xs text-muted-foreground">
              These agents no longer run Claude but still have a Claude account assigned, which keeps a slot on their
              device. Remove the assignment to free it.
            </p>
          </div>
          <ul className="divide-y divide-border rounded-md border border-border">
            {otherAdapters.map((binding) => (
              <OtherAdapterRow key={binding.agentId} binding={binding} canBindAny={canBindAny} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function BindingRow({
  binding,
  companyId,
  companyOptions,
  canBindAny,
  now,
}: {
  binding: AgentAiAccountBindingSummary;
  companyId: string;
  companyOptions: readonly CompanyAiAccountOption[];
  canBindAny: boolean;
  now?: Date;
}) {
  const queryClient = useQueryClient();
  // The agent's own list (selectability, warnings, accounts already on its
  // device) loads once someone reaches for the picker, not for every row.
  const [wantsOptions, setWantsOptions] = useState(false);
  const agentAccounts = useQuery({
    queryKey: aiAccountPoolKeys.companyAccounts(companyId, binding.agentId),
    queryFn: () => aiAccountPoolApi.listCompanyAccounts(companyId, { agentId: binding.agentId }),
    enabled: wantsOptions && binding.canChange,
    retry: false,
  });
  const [saved, setSaved] = useState<SetAgentAiAccountResponse | null>(null);
  const invalidate = () => invalidateAiAccountPoolQueries(queryClient);
  const save = useMutation({
    mutationFn: (selection: SetAgentAiAccount) => aiAccountPoolApi.setAgentBinding(binding.agentId, selection),
    onSuccess: (response) => setSaved(response),
    onSettled: invalidate,
  });
  const clear = useMutation({
    mutationFn: () => aiAccountPoolApi.clearAgentBinding(binding.agentId),
    onSettled: invalidate,
  });
  const review = useMutation({
    mutationFn: () => aiAccountPoolApi.reviewAgentBinding(binding.agentId),
    onSettled: invalidate,
  });

  const rowCanBindAny = agentAccounts.data?.canBindAny ?? canBindAny;
  const baseOptions = agentAccounts.data?.accounts ?? companyOptions;
  const options = useMemo(() => accountOptionsWithCurrent(baseOptions, binding.account), [baseOptions, binding.account]);
  const busy = save.isPending || clear.isPending;
  const status = bindingStatus(binding, now);
  const changeError = save.error ?? clear.error ?? review.error;
  const failure = changeError
    ? bindingErrorText(changeError)
    : agentAccounts.error
      ? `Could not load the accounts this agent can use. ${aiAccountPoolErrorMessage(agentAccounts.error)}`
      : null;

  function resetFeedback() {
    setSaved(null);
    save.reset();
    clear.reset();
    review.reset();
  }

  function change(selection: SetAgentAiAccount) {
    if (isCurrentSelection(selection, binding)) return;
    resetFeedback();
    save.mutate(selection);
  }

  const reachForPicker = () => setWantsOptions(true);

  return (
    <li aria-label={binding.agentName} data-binding-state={binding.state} className="space-y-2 px-3 py-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <AgentName binding={binding} />
            {binding.needsReview && (
              <Badge variant="outline" className={POOL_BADGE_TONE_CLASS.info}>
                Review
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{devicesText(binding)}</p>
        </div>
        <div className="flex w-full items-center gap-2 sm:w-80">
          <div
            className="min-w-0 flex-1"
            onPointerDownCapture={reachForPicker}
            onClickCapture={reachForPicker}
            onFocusCapture={reachForPicker}
            onKeyDownCapture={reachForPicker}
          >
            <AccountSelect
              options={options}
              canBindAny={rowCanBindAny}
              value={accountSelectValueForBinding(binding)}
              onChange={change}
              includeDeviceLogin
              canSetDeviceLogin={canChooseDeviceLogin({ canBindAny: rowCanBindAny, binding })}
              disabled={!binding.canChange || busy}
              loading={agentAccounts.isLoading}
              aria-label={`Claude account of ${binding.agentName}`}
              now={now}
            />
          </div>
          {canClearBinding(binding, rowCanBindAny) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              title="Back to the agent's AI connection or the device's own login"
              aria-label={`Clear the Claude account of ${binding.agentName}`}
              onClick={() => {
                resetFeedback();
                clear.mutate();
              }}
            >
              Clear
            </Button>
          )}
        </div>
      </div>

      {status && <p className={cn("text-xs", status.warning ? WARNING_TEXT_CLASS : "text-muted-foreground")}>{status.text}</p>}
      {binding.overridesAiConnection && (
        <p className="text-xs text-muted-foreground">It replaces the AI connection set in the agent's configuration.</p>
      )}
      {!binding.canChange && (
        <p className="text-xs text-muted-foreground">Only a company admin or the owner of its current account can change this.</p>
      )}

      {binding.needsReview && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground">
            {binding.migrationNote ?? "Chosen automatically when agents moved to their own Claude accounts."}
          </p>
          {rowCanBindAny && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={review.isPending}
              aria-label={`Confirm the Claude account of ${binding.agentName}`}
              onClick={() => {
                review.reset();
                review.mutate();
              }}
            >
              {review.isPending ? "Confirming…" : "Confirm"}
            </Button>
          )}
        </div>
      )}

      {saved && !busy && (
        <p role="status" className="text-xs text-muted-foreground">
          {savedText(saved, now)}
        </p>
      )}
      {failure && (
        <p role="alert" className="text-xs text-destructive">
          {failure}
        </p>
      )}
    </li>
  );
}

/**
 * A pool binding left on an agent that moved to another adapter. It still
 * takes a slot on its device, so it can be removed here.
 */
function OtherAdapterRow({ binding, canBindAny }: { binding: AgentAiAccountBindingSummary; canBindAny: boolean }) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => aiAccountPoolApi.clearAgentBinding(binding.agentId),
    onSettled: () => invalidateAiAccountPoolQueries(queryClient),
  });
  const account = binding.account?.label ?? AI_ACCOUNT_BINDING_STATE_TEXT[binding.state];
  return (
    <li aria-label={binding.agentName} className="space-y-1 px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <AgentName binding={binding} />
          <p className="text-xs text-muted-foreground">
            {[getAdapterLabel(binding.adapterType), account, devicesText(binding)].join(" · ")}
          </p>
        </div>
        {canClearBinding(binding, canBindAny) ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={remove.isPending}
            aria-label={`Remove the Claude account of ${binding.agentName}`}
            onClick={() => {
              remove.reset();
              remove.mutate();
            }}
          >
            {remove.isPending ? "Removing…" : "Remove"}
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">A company admin can remove it.</span>
        )}
      </div>
      {remove.error ? (
        <p role="alert" className="text-xs text-destructive">
          {aiAccountPoolErrorMessage(remove.error)}
        </p>
      ) : null}
    </li>
  );
}
