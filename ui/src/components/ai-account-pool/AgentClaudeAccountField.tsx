import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import type {
  Agent,
  AgentAiAccountBindingDetail,
  AgentAiAccountBindingSummary,
  AiRuntimeConnectionBinding,
  EnvironmentAvailabilitySummary,
  HeartbeatRun,
  SetAgentAiAccount,
} from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { aiAccountPoolApi, aiAccountPoolKeys, invalidateAiAccountPoolQueries } from "@/api/ai-account-pool";
import { aiConnectionsApi } from "@/api/ai-connections";
import { ApiError } from "@/api/client";
import { executionDeviceKeys, executionDevicesApi } from "@/api/execution-devices";
import { heartbeatsApi } from "@/api/heartbeats";
import { Field } from "@/components/agent-config-primitives";
import { InlineBanner } from "@/components/InlineBanner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToastActions } from "@/context/ToastContext";
import {
  AGENT_CLAUDE_ACCOUNT_LOCKED_TEXT,
  AI_ACCOUNT_BINDING_STATE_SHORT_TEXT,
  accountOptionsWithCurrent,
  accountSelectValueForBinding,
  agentAiConnection,
  agentClaudeAccountUsageText,
  agentDevicePhrase,
  agentDeviceSummary,
  bindingSavedToast,
  bindingWaitReason,
  bindingWaitTone,
  currentAiConnectionChoice,
  currentResourceWaitRun,
  deviceAvailabilityNotes,
  deviceDisplayName,
  isCurrentSelection,
  usesPoolAccounts,
  type ClaudeEnvironmentCredential,
  type CurrentAiConnectionChoice,
} from "@/lib/agent-claude-account";
import {
  EXECUTION_DEVICE_KIND_LABELS,
  POOL_BADGE_TONE_CLASS,
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

/** The Claude account field's anchor: the overview's Change link lands on `#claude-account`. */
export const AGENT_CLAUDE_ACCOUNT_FIELD_ID = "claude-account";

const FIELD_HINT = `Which Claude account this agent's runs use, or the device's own login. ${POOL_PRODUCT_LINE}`;

/** The field saves on its own; the rest of the form waits for its Save button. */
const SAVES_AT_ONCE_TEXT = "A change here saves at once, without the Save button, and applies from the agent's next run.";

/** Where a person connects or reconnects their own AI connection. */
const AI_CONNECTIONS_HREF = "/apps";

const NO_CREDENTIALS: readonly ClaudeEnvironmentCredential[] = [];

/** The agent's selection. The field, the left-over notice and the overview rows share one request. */
function useAgentBinding(agentId: string, enabled = true) {
  return useQuery({
    queryKey: aiAccountPoolKeys.agent(agentId),
    queryFn: () => aiAccountPoolApi.getAgentBinding(agentId),
    enabled,
    retry: false,
  });
}

/**
 * Fork: whether an existing Claude agent has a Claude account selection (a
 * pool account, or explicitly the device's own login), as its Claude account
 * field loaded it. It never fetches on its own, so it is false until the
 * field has loaded. Pass null for an agent without the field.
 */
export function useHasClaudeAccountSelection(agentId: string | null): boolean {
  const bindingQuery = useAgentBinding(agentId ?? "", false);
  return agentId !== null && (bindingQuery.data?.mode ?? null) !== null;
}

/**
 * The agent's AI connection while its runs use it (the agent has no
 * selection), as the field and the overview name it. The company's AI
 * connections, as this viewer reads them, name a shared connection and the
 * viewer's own default behind a responsible-user connection.
 */
function useCurrentAiConnection(
  agent: Pick<Agent, "id" | "companyId">,
  binding: AgentAiAccountBindingSummary | null,
  aiConnection: AiRuntimeConnectionBinding | null,
): CurrentAiConnectionChoice | null {
  const applies = binding !== null && binding.mode === null && aiConnection !== null;
  const connectionsQuery = useQuery({
    queryKey: ["ai-connections", agent.companyId, agent.id],
    queryFn: () => aiConnectionsApi.list(agent.companyId, agent.id),
    enabled: applies,
    retry: false,
  });
  const devicePhrase = binding ? agentDevicePhrase(binding) : null;
  return useMemo(
    () => (applies && aiConnection
      ? currentAiConnectionChoice(aiConnection, { companyId: agent.companyId, list: connectionsQuery.data, devicePhrase })
      : null),
    [agent.companyId, aiConnection, applies, connectionsQuery.data, devicePhrase],
  );
}

/**
 * Whether the viewer has saved a Claude login under My secrets, from the
 * request the saved-login bind shares; null while unknown.
 */
function useSavedClaudeLogin(companyId: string, enabled: boolean): boolean | null {
  const statusQuery = useQuery({
    queryKey: ["claude-oauth-token-status", companyId],
    queryFn: async () => {
      try {
        return await agentsApi.getClaudeOAuthTokenStatus(companyId);
      } catch (error) {
        // The route answers 404 while the viewer has saved none.
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled,
    retry: false,
  });
  return statusQuery.data === undefined ? null : statusQuery.data !== null;
}

/** The next step when the viewer's own connection behind a responsible-user connection cannot serve their tasks. */
function OwnConnectionFix({ fix }: { fix: NonNullable<CurrentAiConnectionChoice["ownConnectionFix"]> }) {
  return (
    <>
      {` Your tasks cannot run until you ${fix === "connect" ? "connect one" : "reconnect it"} under `}
      <Link to={AI_CONNECTIONS_HREF} className="underline underline-offset-2 hover:text-foreground">Apps</Link>
      {" or choose a Claude account above."}
    </>
  );
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

function ErrorLine({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p role="alert" className="text-sm text-destructive">{aiAccountPoolErrorMessage(error)}</p>
      {onRetry ? <Button type="button" variant="outline" size="sm" onClick={onRetry}>Try again</Button> : null}
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

export interface AgentClaudeAccountFieldProps {
  agent: Pick<Agent, "id" | "name" | "companyId" | "adapterType">;
  /**
   * The agent's saved AI connection (`runtimeConfig.aiConnection`). Runs use
   * it while the agent has no selection, and the field offers it only then.
   */
  aiConnection?: AiRuntimeConnectionBinding | null;
  /**
   * The Claude credential variables the agent's own environment sets (see
   * `claudeEnvironmentCredentials`). Without an account or an AI connection,
   * runs use them ahead of the device's own login, and they still apply with
   * the device's own login chosen.
   */
  environmentCredentials?: readonly ClaudeEnvironmentCredential[];
  /** The field's anchor; the page scrolls to the field when the URL's hash names it. */
  id?: string;
  className?: string;
  /** Pins the clock for reset times. */
  now?: Date;
}

/**
 * Fork: the Claude account field of a Claude agent's configuration, in the
 * Adapter section in place of the AI connection field. A Claude agent uses
 * one pool account, or explicitly its device's own login; with neither it
 * uses its AI connection, which the field then shows as the current choice,
 * and offers only while it is current, else the Claude credential variables
 * of its own environment, else the device's own login. The text under the
 * picker says which, and the next step where runs cannot work for the
 * viewer. A choice saves at once, apart from the rest of the form, and
 * applies from the agent's next run; a running run keeps its account, and
 * Paperclip never moves a task to another account.
 *
 * Company admins may choose any eligible account; an account's owner may
 * choose their own, and switch away only from their own (decision D4). The
 * server stays authoritative and its refusals show inline.
 */
export function AgentClaudeAccountField({
  agent,
  aiConnection = null,
  environmentCredentials = NO_CREDENTIALS,
  id = AGENT_CLAUDE_ACCOUNT_FIELD_ID,
  className,
  now,
}: AgentClaudeAccountFieldProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [actionError, setActionError] = useState<unknown>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const scrolledRef = useRef(false);

  const bindingQuery = useAgentBinding(agent.id);
  const binding = bindingQuery.data ?? null;
  // The binding itself says whether the caller is a company admin (spec 5.1)
  // and which accounts this agent can take (selectable, reason, warning,
  // already on its device), so no second request is needed.
  const canBindAny = binding?.canBindAny ?? false;
  const options = useMemo(
    () => (binding ? accountOptionsWithCurrent(binding.options, binding.account) : []),
    [binding],
  );
  const availability = useDeviceAvailability(agent.companyId, (binding?.devices.length ?? 0) > 0);

  // Without a selection the AI connection applies, so it is the current choice.
  const currentConnection = useCurrentAiConnection(agent, binding, aiConnection);
  // Without either, the agent's own credential variables apply; a saved login there is each task's responsible person's.
  const savedLoginsApply = binding?.state === "unbound" && currentConnection === null
    && environmentCredentials.some((credential) => credential.savedLogin);
  const savedClaudeLogin = useSavedClaudeLogin(agent.companyId, savedLoginsApply);

  // Best effort: the waits themselves show on each task, the run list and the device page.
  const runsQuery = useQuery({
    queryKey: [...queryKeys.heartbeats(agent.companyId, agent.id), "resource-wait"],
    queryFn: () => heartbeatsApi.list(agent.companyId, agent.id, RECENT_RUNS_LIMIT, { summary: true }),
    enabled: binding !== null,
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
  const review = useMutation({
    mutationFn: () => aiAccountPoolApi.reviewAgentBinding(agent.id),
    onMutate: () => setActionError(null),
    onSuccess: () => void refresh(),
    onError: (error) => setActionError(error),
  });
  const busy = save.isPending || review.isPending;

  // The overview's Change link lands here: once the field has loaded, bring it into view.
  const loaded = !bindingQuery.isPending;
  useEffect(() => {
    if (!loaded || scrolledRef.current || window.location.hash !== `#${id}`) return;
    scrolledRef.current = true;
    // jsdom has no scrollIntoView.
    fieldRef.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }, [id, loaded]);

  return (
    <div id={id} ref={fieldRef} className={cn("min-w-0 space-y-2", className)} data-agent-claude-account="">
      <Field label="Claude account" hint={FIELD_HINT}>
        {bindingQuery.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">Loading…</p>
        ) : !binding ? (
          <ErrorLine error={bindingQuery.error ?? new Error("Could not load the Claude account.")} onRetry={() => void bindingQuery.refetch()} />
        ) : (
          <div className="space-y-1.5">
            <AccountSelect
              options={options}
              canBindAny={canBindAny}
              value={currentConnection ? { mode: "ai_connection" } : accountSelectValueForBinding(binding)}
              currentAiConnection={currentConnection}
              onChange={(selection) => {
                if (!isCurrentSelection(selection, binding)) save.mutate(selection);
              }}
              includeDeviceLogin
              canSetDeviceLogin={canChooseDeviceLogin({ canBindAny, binding })}
              showActiveState
              disabled={!binding.canChange || busy}
              aria-label={`Claude account for ${agent.name}`}
              now={now}
            />
            <p className="text-xs" data-claude-account-usage="">
              {agentClaudeAccountUsageText(binding, { aiConnection: currentConnection, environmentCredentials, savedClaudeLogin })}
              {currentConnection?.ownConnectionFix ? <OwnConnectionFix fix={currentConnection.ownConnectionFix} /> : null}
            </p>
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <p className="text-xs text-muted-foreground">
                {binding.canChange ? SAVES_AT_ONCE_TEXT : AGENT_CLAUDE_ACCOUNT_LOCKED_TEXT}
              </p>
              <Link
                to="/company/settings/claude-accounts"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <Plus className="size-3" aria-hidden="true" />
                Add account
              </Link>
            </div>
          </div>
        )}
      </Field>
      {binding ? (
        <>
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
        </>
      ) : null}
    </div>
  );
}

/**
 * Fork: a Claude account selection left from when the agent ran Claude.
 * Another adapter takes no pool account, so the selection no longer applies,
 * but it still holds a slot on its device; the Adapter section offers to
 * remove it. Renders nothing otherwise.
 */
export function AgentClaudeAccountLeftOver({ agentId, className }: { agentId: string; className?: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [actionError, setActionError] = useState<unknown>(null);
  const bindingQuery = useAgentBinding(agentId);
  const binding = bindingQuery.data ?? null;
  const remove = useMutation({
    mutationFn: () => aiAccountPoolApi.clearAgentBinding(agentId),
    onMutate: () => setActionError(null),
    onSuccess: () => {
      pushToast({
        title: "Claude account selection removed",
        body: "It no longer counts toward its device's Claude account limit.",
        tone: "success",
      });
      void invalidateAiAccountPoolQueries(queryClient);
    },
    onError: (error) => setActionError(error),
  });
  if (!binding || binding.supported || binding.mode === null) return null;
  // Removing follows the device-login rule: a company admin, or the owner while the agent is on their own account.
  const canRemove = binding.canChange && canChooseDeviceLogin({ canBindAny: binding.canBindAny ?? false, binding });
  return (
    <div className={cn("min-w-0 space-y-2", className)} data-agent-claude-account-left-over="">
      <InlineBanner
        tone="warning"
        compact
        title="A Claude account selection is left over"
        actions={canRemove ? (
          <Button type="button" variant="outline" size="sm" disabled={remove.isPending} onClick={() => remove.mutate()}>
            Remove
          </Button>
        ) : null}
      >
        This agent no longer runs on Claude, so the selection does not apply. It still counts toward its device's
        Claude account limit until it is removed.
      </InlineBanner>
      <ErrorLine error={actionError} />
    </div>
  );
}

export interface AgentClaudeAccountOverviewRowsProps {
  /** With its `runtimeConfig`, the row names the agent's AI connection while that is what its runs use. */
  agent: Pick<Agent, "id" | "companyId" | "adapterType"> & Partial<Pick<Agent, "runtimeConfig">>;
  /** The page's own summary row, so these rows match their neighbours. */
  Row: ComponentType<{ label: string; children: ReactNode }>;
  /** Where the account is chosen: the agent's Configuration view, at its Claude account field. */
  changeHref?: string;
  now?: Date;
}

/**
 * Fork: the overview's Device and Claude account rows for a Claude agent. A
 * device that is not available says so, e.g. `Offline since 13:02`. Without a
 * selection, the account row names the agent's AI connection as the field
 * does (e.g. "Responsible user's connection"), else "Not set". Someone who
 * may change the account gets a Change link to `changeHref`. The account row
 * wraps on a narrow card, so the link never widens it past the card.
 */
export function AgentClaudeAccountOverviewRows({ agent, Row, changeHref, now }: AgentClaudeAccountOverviewRowsProps) {
  const isClaude = usesPoolAccounts(agent.adapterType);
  const bindingQuery = useAgentBinding(agent.id, isClaude);
  const binding = bindingQuery.data;
  const availability = useDeviceAvailability(binding?.companyId, isClaude && (binding?.devices.length ?? 0) > 0);
  const aiConnection = useMemo(() => agentAiConnection(agent.runtimeConfig), [agent.runtimeConfig]);
  const currentConnection = useCurrentAiConnection(agent, isClaude ? binding ?? null : null, aiConnection);
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
        <span className="flex min-w-0 flex-wrap items-center justify-end gap-1">
          {account ? (
            <>
              <span className="max-w-48 truncate text-sm">{account.label}</span>
              {account.state !== "active" ? <AiAccountStateBadge display={aiAccountStateDisplay(account, now)} /> : null}
            </>
          ) : currentConnection ? (
            <span className="max-w-64 truncate text-sm">{currentConnection.label}</span>
          ) : (
            <span className="text-sm">{AI_ACCOUNT_BINDING_STATE_SHORT_TEXT[binding.state]}</span>
          )}
          {changeHref && binding.canChange ? (
            <span className="flex items-center gap-1">
              <span aria-hidden="true" className="text-xs text-muted-foreground">·</span>
              <Link
                to={changeHref}
                aria-label="Change the Claude account"
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Change
              </Link>
            </span>
          ) : null}
        </span>
      </Row>
    </>
  );
}
