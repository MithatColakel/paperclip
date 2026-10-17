import { useId, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Agent,
  AgentAiAccountBindingDetail,
  AgentAiAccountBindingSummary,
  EnvironmentAvailabilitySummary,
  HeartbeatRun,
  SetAgentAiAccount,
} from "@paperclipai/shared";
import { aiAccountPoolApi, aiAccountPoolKeys, invalidateAiAccountPoolQueries } from "@/api/ai-account-pool";
import { executionDeviceKeys, executionDevicesApi } from "@/api/execution-devices";
import { heartbeatsApi } from "@/api/heartbeats";
import { InlineBanner } from "@/components/InlineBanner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToastActions } from "@/context/ToastContext";
import {
  AGENT_CLAUDE_ACCOUNT_LOCKED_TEXT,
  AI_ACCOUNT_BINDING_STATE_SHORT_TEXT,
  accountOptionsWithCurrent,
  accountSelectValueForBinding,
  agentDeviceSummary,
  aiConnectionOverrideText,
  bindingSavedToast,
  bindingWaitReason,
  bindingWaitTone,
  currentResourceWaitRun,
  deviceAvailabilityNotes,
  deviceDisplayName,
  isCurrentSelection,
  usesPoolAccounts,
} from "@/lib/agent-claude-account";
import {
  AI_ACCOUNT_BINDING_STATE_TEXT,
  EXECUTION_DEVICE_KIND_LABELS,
  POOL_BADGE_TONE_CLASS,
  POOL_CREDENTIAL_TYPE_LABELS,
  POOL_PRODUCT_LINE,
  aiAccountPoolErrorMessage,
  aiAccountStateDisplay,
  canChooseDeviceLogin,
  deviceAvailabilityDisplay,
  type PoolBadgeTone,
} from "@/lib/ai-account-pool";
import { queryKeys } from "@/lib/queryKeys";
import {
  describeRunResourceWait,
  readRunResourceWait,
  resourceWaitReasonLabel,
  resourceWaitReasonText,
} from "@/lib/resource-wait";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { AccountSelect, AiAccountStateBadge } from "./AccountSelect";

/** Enough recent runs to find a wait: a waiting run is re-armed in place, not replaced. */
const RECENT_RUNS_LIMIT = 25;

/** The agent's selection. The card, the overview rows and the AI connection note share one request. */
function useAgentBinding(agentId: string, enabled = true) {
  return useQuery({
    queryKey: aiAccountPoolKeys.agent(agentId),
    queryFn: () => aiAccountPoolApi.getAgentBinding(agentId),
    enabled,
    retry: false,
  });
}

const NO_AVAILABILITY: ReadonlyMap<string, EnvironmentAvailabilitySummary> = new Map();

/**
 * Each device's availability by id, from the company's device list (the
 * Devices page shares the request). Best effort: a device the list does not
 * include, or a failed request, shows no availability.
 */
function useDeviceAvailability(companyId: string | null | undefined, enabled: boolean) {
  const devicesQuery = useQuery({
    queryKey: executionDeviceKeys.company(companyId ?? ""),
    queryFn: () => executionDevicesApi.list(companyId!),
    enabled: enabled && Boolean(companyId),
    retry: false,
  });
  return useMemo(
    () => devicesQuery.data
      ? new Map(devicesQuery.data.devices.map((device) => [device.id, device.availability]))
      : NO_AVAILABILITY,
    [devicesQuery.data],
  );
}

/** A device's availability, styled as on the Devices page. */
function AvailabilityBadge({
  state,
  label,
  tone,
}: {
  state: EnvironmentAvailabilitySummary["state"];
  label: string;
  tone: PoolBadgeTone;
}) {
  return (
    <Badge variant="outline" data-device-availability={state} className={cn("font-normal", POOL_BADGE_TONE_CLASS[tone])}>
      {label}
    </Badge>
  );
}

function CardFrame({ headingId, className, children }: { headingId: string; className?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={headingId} className={cn("min-w-0", className)} data-agent-claude-account="">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 id={headingId} className="text-sm font-medium">Claude account</h3>
        <Link
          to="/company/settings/claude-accounts"
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Manage accounts
        </Link>
      </div>
      <div className="space-y-3 rounded-lg border border-border p-4">{children}</div>
    </section>
  );
}

function ErrorLine({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p role="alert" className="text-sm text-destructive">{aiAccountPoolErrorMessage(error)}</p>
      {onRetry ? <Button type="button" variant="outline" size="sm" onClick={onRetry}>Try again</Button> : null}
    </div>
  );
}

/** The chosen account's owner, type and state, or the selection in words. */
function SelectionState({ binding, now }: { binding: AgentAiAccountBindingSummary; now?: Date }) {
  const account = binding.state === "pool_account" ? binding.account : null;
  if (!account) {
    return (
      <p className="text-xs text-muted-foreground" data-binding-state={binding.state}>
        {AI_ACCOUNT_BINDING_STATE_TEXT[binding.state]}
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-binding-state={binding.state}>
      <span>{account.ownedByMe ? "Yours" : `Owner: ${account.ownerName?.trim() || "another member"}`}</span>
      <span aria-hidden="true">·</span>
      <span>{POOL_CREDENTIAL_TYPE_LABELS[account.credentialType]}</span>
      <AiAccountStateBadge display={aiAccountStateDisplay(account, now)} />
    </div>
  );
}

/** The agent's devices, each with its availability when the company's device list has it. */
function DeviceList({
  binding,
  availability,
  now,
}: {
  binding: AgentAiAccountBindingSummary;
  availability: ReadonlyMap<string, EnvironmentAvailabilitySummary>;
  now?: Date;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs text-muted-foreground">{binding.pinned ? "Device" : "Devices (varies by project)"}</div>
      {binding.devices.length === 0 ? (
        <p className="text-sm text-muted-foreground">Unknown</p>
      ) : (
        <ul className="space-y-1">
          {binding.devices.map((device) => {
            const state = availability.get(device.id);
            const display = state ? deviceAvailabilityDisplay(state, now) : null;
            return (
              <li key={device.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" data-device={device.id}>
                <span className="min-w-0 break-words">{deviceDisplayName(device)}</span>
                <span className="text-xs text-muted-foreground">{EXECUTION_DEVICE_KIND_LABELS[device.kind]}</span>
                {state && display ? <AvailabilityBadge state={state.state} label={display.label} tone={display.tone} /> : null}
              </li>
            );
          })}
        </ul>
      )}
      {!binding.pinned && binding.devices.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          This agent has no pinned environment, so its device depends on the task's project.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The wait this agent is in now (its newest waiting run), or the account wait
 * its next run would hit. Waits resolve on their own or name the fix.
 */
function WaitNotice({
  binding,
  agentName,
  current,
  waitRun,
  now,
}: {
  binding: AgentAiAccountBindingSummary;
  agentName: string;
  current: { run: HeartbeatRun; waiting: number } | null;
  waitRun: HeartbeatRun | null;
  now?: Date;
}) {
  if (current) {
    // The run list carries the lane only; the run itself carries the reason.
    const run = waitRun ?? current.run;
    const copy = describeRunResourceWait(run, { agentName, now });
    if (copy) {
      const reason = readRunResourceWait(run)?.wait?.reason ?? null;
      const others = current.waiting > 1 ? ` ${current.waiting} of this agent's tasks are waiting.` : "";
      return (
        <InlineBanner tone={copy.tone} compact title={copy.title}>
          {`${reason ? resourceWaitReasonText(reason) : copy.detail}${others}`}
        </InlineBanner>
      );
    }
  }
  const reason = bindingWaitReason(binding);
  if (reason) {
    return (
      <InlineBanner tone={bindingWaitTone(reason)} compact title={`Tasks wait: ${resourceWaitReasonLabel(reason)}`}>
        {resourceWaitReasonText(reason)}
      </InlineBanner>
    );
  }
  if (binding.supported && binding.state === "account_unavailable") {
    return (
      <InlineBanner tone="warning" compact title="The account is no longer available in this company">
        Its tasks wait until another account is chosen for this agent, or it is switched to the device's own login.
      </InlineBanner>
    );
  }
  return null;
}

export interface AgentClaudeAccountCardProps {
  agent: Pick<Agent, "id" | "name" | "companyId" | "adapterType">;
  className?: string;
  /** Pins the clock for reset times. */
  now?: Date;
}

/**
 * Fork: the agent page's Claude account. A Claude agent uses one pool account,
 * or explicitly its device's own login. The choice saves at once and applies
 * from the agent's next run; a running run keeps its account, and Paperclip
 * never moves a task to another account.
 *
 * Company admins may choose any eligible account; an account's owner may
 * choose their own, and switch away only from their own (decision D4). The
 * server stays authoritative and its refusals show inline.
 *
 * Another adapter takes no pool account, so the card stays hidden there,
 * unless a selection is left from when the agent used Claude: it still holds
 * a device slot, so the card offers to remove it.
 */
export function AgentClaudeAccountCard({ agent, className, now }: AgentClaudeAccountCardProps) {
  const headingId = useId();
  const isClaude = usesPoolAccounts(agent.adapterType);
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [actionError, setActionError] = useState<unknown>(null);

  const bindingQuery = useAgentBinding(agent.id);
  const binding = bindingQuery.data ?? null;
  const supported = isClaude && binding?.supported !== false;
  // A selection left from when the agent ran Claude; it can only be removed.
  const leftOver = !supported && binding !== null && binding.mode !== null;
  // The binding itself says whether the caller is a company admin (spec 5.1)
  // and which accounts this agent can take (selectable, reason, warning,
  // already on its device), so no second request is needed.
  const canBindAny = binding?.canBindAny ?? false;
  const options = useMemo(
    () => (binding ? accountOptionsWithCurrent(binding.options, binding.account) : []),
    [binding],
  );
  const availability = useDeviceAvailability(agent.companyId, supported && (binding?.devices.length ?? 0) > 0);

  // Best effort: the waits themselves show on each task, the run list and the device page.
  const runsQuery = useQuery({
    queryKey: [...queryKeys.heartbeats(agent.companyId, agent.id), "resource-wait"],
    queryFn: () => heartbeatsApi.list(agent.companyId, agent.id, RECENT_RUNS_LIMIT, { summary: true }),
    enabled: isClaude,
    retry: false,
  });
  const current = useMemo(() => currentResourceWaitRun(runsQuery.data ?? []), [runsQuery.data]);
  const waitRunQuery = useQuery({
    queryKey: queryKeys.runDetail(current?.run.id ?? "none"),
    queryFn: () => heartbeatsApi.get(current!.run.id),
    enabled: Boolean(current),
    retry: false,
  });

  const refresh = () => invalidateAiAccountPoolQueries(queryClient);
  const save = useMutation({
    mutationFn: (selection: SetAgentAiAccount) => aiAccountPoolApi.setAgentBinding(agent.id, selection),
    onMutate: () => setActionError(null),
    onSuccess: ({ appliesFrom: _appliesFrom, runningRunIds, warnings, ...summary }) => {
      // Show the saved choice at once; the refresh below brings the options up to date.
      queryClient.setQueryData<AgentAiAccountBindingDetail>(aiAccountPoolKeys.agent(agent.id), (previous) =>
        previous ? { ...previous, ...summary } : previous,
      );
      pushToast(bindingSavedToast({ runningRunIds, warnings, account: summary.account }, now));
      void refresh();
    },
    onError: (error) => setActionError(error),
  });
  const clear = useMutation({
    mutationFn: () => aiAccountPoolApi.clearAgentBinding(agent.id),
    onMutate: () => setActionError(null),
    onSuccess: () => {
      pushToast({
        title: "Claude account selection cleared",
        body: "From the agent's next run, its AI connection or the device's own login applies.",
        tone: "success",
      });
      void refresh();
    },
    onError: (error) => setActionError(error),
  });
  const review = useMutation({
    mutationFn: () => aiAccountPoolApi.reviewAgentBinding(agent.id),
    onMutate: () => setActionError(null),
    onSuccess: () => void refresh(),
    onError: (error) => setActionError(error),
  });
  const busy = save.isPending || clear.isPending || review.isPending;

  // Clearing follows the device-login rule: a company admin, or the owner while the agent is on their own account.
  const canClear = Boolean(
    binding && binding.mode !== null && binding.canChange && canChooseDeviceLogin({ canBindAny, binding }),
  );
  const clearButton = canClear ? (
    <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => clear.mutate()}>
      {supported ? "Clear" : "Remove"}
    </Button>
  ) : null;

  if (!supported) {
    if (!leftOver) return null;
    return (
      <CardFrame headingId={headingId} className={className}>
        <InlineBanner tone="warning" compact title="A Claude account selection is left over" actions={clearButton}>
          This agent no longer runs on Claude, so the selection does not apply. It still counts toward its
          device's Claude account limit until it is removed.
        </InlineBanner>
        <ErrorLine error={actionError} />
      </CardFrame>
    );
  }

  return (
    <CardFrame headingId={headingId} className={className}>
      <p className="text-sm text-muted-foreground">
        Which Claude account this agent's runs use, or the device's own login. A change saves at once and applies
        from the agent's next run.
      </p>
      {bindingQuery.isLoading ? (
        <p role="status" className="text-sm text-muted-foreground">Loading…</p>
      ) : !binding ? (
        <ErrorLine error={bindingQuery.error ?? new Error("Could not load the Claude account.")} onRetry={() => void bindingQuery.refetch()} />
      ) : (
        <>
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-0 flex-1 sm:max-w-md">
                <AccountSelect
                  options={options}
                  canBindAny={canBindAny}
                  value={accountSelectValueForBinding(binding)}
                  onChange={(selection) => {
                    if (!isCurrentSelection(selection, binding)) save.mutate(selection);
                  }}
                  includeDeviceLogin
                  canSetDeviceLogin={canChooseDeviceLogin({ canBindAny, binding })}
                  disabled={!binding.canChange || busy}
                  aria-label={`Claude account for ${agent.name}`}
                  now={now}
                />
              </div>
              {clearButton}
            </div>
            <SelectionState binding={binding} now={now} />
            {!binding.canChange ? <p className="text-xs text-muted-foreground">{AGENT_CLAUDE_ACCOUNT_LOCKED_TEXT}</p> : null}
          </div>
          <ErrorLine error={actionError} />
          <DeviceList binding={binding} availability={availability} now={now} />
          <WaitNotice
            binding={binding}
            agentName={agent.name}
            current={current}
            waitRun={waitRunQuery.data ?? null}
            now={now}
          />
          {binding.needsReview ? (
            <InlineBanner
              tone="info"
              compact
              title="Review this migrated assignment"
              actions={canBindAny ? (
                <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => review.mutate()}>
                  Confirm
                </Button>
              ) : null}
            >
              {`${binding.migrationNote?.trim() || "Paperclip chose this when accounts moved to their owners. Check that it is right for this agent."}${canBindAny ? "" : " A company admin confirms it."}`}
            </InlineBanner>
          ) : null}
          {binding.overridesAiConnection ? (
            <p className="text-xs text-muted-foreground">
              This selection overrides the AI connection set in the agent's configuration.
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">{POOL_PRODUCT_LINE}</p>
        </>
      )}
    </CardFrame>
  );
}

export interface AgentClaudeAccountOverviewRowsProps {
  agent: Pick<Agent, "id" | "adapterType">;
  /** The page's own summary row, so these rows match their neighbours. */
  Row: ComponentType<{ label: string; children: ReactNode }>;
  now?: Date;
}

/**
 * Fork: the overview's Device and Claude account rows for a Claude agent. A
 * device that is not available says so, e.g. `Offline since 13:02`.
 */
export function AgentClaudeAccountOverviewRows({ agent, Row, now }: AgentClaudeAccountOverviewRowsProps) {
  const isClaude = usesPoolAccounts(agent.adapterType);
  const bindingQuery = useAgentBinding(agent.id, isClaude);
  const binding = bindingQuery.data;
  const availability = useDeviceAvailability(binding?.companyId, isClaude && (binding?.devices.length ?? 0) > 0);
  if (!isClaude) return null;
  if (!binding) {
    return (
      <Row label="Claude account">
        {bindingQuery.error ? (
          <span className="text-sm text-destructive" title={aiAccountPoolErrorMessage(bindingQuery.error)}>
            Could not load
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">Loading…</span>
        )}
      </Row>
    );
  }
  const account = binding.state === "pool_account" ? binding.account : null;
  return (
    <>
      <Row label="Device">
        <span className="max-w-64 truncate text-sm">{agentDeviceSummary(binding)}</span>
        {deviceAvailabilityNotes(binding.devices, availability, now).map((note) => (
          <AvailabilityBadge key={note.deviceId} state={note.state} label={note.label} tone={note.tone} />
        ))}
      </Row>
      <Row label="Claude account">
        {account ? (
          <>
            <span className="max-w-48 truncate text-sm">{account.label}</span>
            {account.state !== "active" ? <AiAccountStateBadge display={aiAccountStateDisplay(account, now)} /> : null}
          </>
        ) : (
          <span className="text-sm">{AI_ACCOUNT_BINDING_STATE_SHORT_TEXT[binding.state]}</span>
        )}
      </Row>
    </>
  );
}

/**
 * Fork: the note on the AI connection field while a Claude account selection
 * exists. That selection, not the field, decides the agent's credential.
 */
export function AiConnectionOverrideNote({ agentId, adapterType }: { agentId: string; adapterType: string }) {
  const isClaude = usesPoolAccounts(adapterType);
  const bindingQuery = useAgentBinding(agentId, isClaude);
  const text = isClaude && bindingQuery.data ? aiConnectionOverrideText(bindingQuery.data) : null;
  if (!text) return null;
  return (
    <InlineBanner tone="info" compact title="Overridden by the Claude account selection">
      {text}
    </InlineBanner>
  );
}
