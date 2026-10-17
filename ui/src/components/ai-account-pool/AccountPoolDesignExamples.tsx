import { useState, type ReactNode } from "react";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  AgentAiAccountBindingDetail,
  AiAccountLimitSource,
  AiAccountState,
  CompanyAiAccountOption,
  CompanyExecutionDevicesResponse,
  EnvironmentAvailabilitySummary,
  ExecutionDeviceKind,
  ExecutionDeviceRef,
  ExecutionDeviceSummary,
  InstanceExecutionDeviceSummary,
  InstanceExecutionDevicesResponse,
  IssueScheduledRetry,
  ResourceWaitContext,
  ResourceWaitRetryReason,
  ScheduledRetryResourceWait,
} from "@paperclipai/shared";
import { aiAccountPoolKeys } from "@/api/ai-account-pool";
import { executionDeviceKeys } from "@/api/execution-devices";
import { DeviceLinkDialog, type DeviceLinkRequest } from "@/components/ai-accounts/DeviceLinkDialog";
import {
  ResourceWaitBanner,
  ResourceWaitChip,
  ResourceWaitLedgerEntry,
  ResourceWaitPropertyValue,
} from "@/components/ResourceWaitBanner";
import { Button } from "@/components/ui/button";
import {
  aiAccountStateDisplay,
  canChooseDeviceLogin,
  type AccountSelectValue,
} from "@/lib/ai-account-pool";
import { queryKeys } from "@/lib/queryKeys";
import type { ResourceWaitLedgerRunLike, ResourceWaitRunLike } from "@/lib/resource-wait";
import { AccountSelect, AiAccountStateBadge } from "./AccountSelect";
import { AgentClaudeAccountCard } from "./AgentClaudeAccountCard";
import { RunResourceWaitBadge } from "./RunResourceWaitBadge";

/**
 * Fork: the /design-guide examples of the Claude account pool and the
 * waiting UI: the agent page's account card, the account picker and state
 * badge, a waiting task's banner, chip, property value and run-ledger entry
 * (with "Check now"), the run badge of a resource wait, and the dialog that
 * links one machine reached two ways. Each reads sample data from its own
 * query cache, which never refetches and stops every save and check before it
 * reaches the server.
 */

const COMPANY_ID = "design-company";
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
/**
 * How far ahead seeded entries count as updated, so even a query with its own
 * short `staleTime` never loads from the server. It stays below the longest
 * timer a browser keeps (about 24.8 days).
 */
const FRESH_FOR_MS = 20 * 24 * HOUR_MS;

const AVAILABLE: EnvironmentAvailabilitySummary = {
  state: "available",
  reason: null,
  label: null,
  message: null,
  unavailableSince: null,
  retryAfter: null,
  checkedAt: null,
  acceptedCredentialTypes: null,
};

const BUILD_BOX: ExecutionDeviceRef = {
  id: "design-device-build",
  name: "Build box",
  kind: "ssh_host",
  owner: { userId: "design-user-ada", name: "Ada", email: "ada@example.com" },
};
const SERVER: ExecutionDeviceRef = { id: "design-device-server", name: "Paperclip server", kind: "server", owner: null };
const ME = { userId: "design-user-me", name: "Me", email: "me@example.com" };

function option(overrides: Partial<CompanyAiAccountOption>): CompanyAiAccountOption {
  return {
    id: "design-account",
    label: "Account",
    credentialType: "subscription",
    plan: "Max",
    owner: { userId: "design-user-ada", name: "Ada", email: "ad•••@example.com" },
    ownedByMe: false,
    state: "active",
    exhaustedUntil: null,
    limitSource: null,
    canBind: true,
    agents: [],
    devices: [],
    selectable: true,
    reason: null,
    warning: null,
    onAgentDevice: false,
    ...overrides,
  };
}

function binding(overrides: Partial<AgentAiAccountBindingDetail>): AgentAiAccountBindingDetail {
  return {
    agentId: "design-agent",
    agentName: "Coder",
    companyId: COMPANY_ID,
    adapterType: "claude_local",
    supported: true,
    state: "unbound",
    mode: null,
    account: null,
    source: null,
    migrationNote: null,
    reviewedAt: null,
    needsReview: false,
    devices: [BUILD_BOX],
    pinned: true,
    overridesAiConnection: false,
    canChange: true,
    updatedAt: null,
    options: [],
    canBindAny: true,
    ...overrides,
  };
}

function companyDevice(device: ExecutionDeviceRef, availability: EnvironmentAvailabilitySummary): ExecutionDeviceSummary {
  return {
    ...device,
    managedByPluginId: null,
    managedByPluginName: null,
    limit: 3,
    inUse: 2,
    overLimit: false,
    overLimitSince: null,
    availability,
    environments: [],
    accounts: [],
    otherCompaniesAccounts: 0,
    agents: [],
    ownLoginAgents: 0,
    acceptedCredentialTypes: null,
    duplicateHints: [],
    waitingCount: 0,
  };
}

function instanceDevice(
  id: string,
  name: string,
  kind: ExecutionDeviceKind,
  targetKey: string | null,
): InstanceExecutionDeviceSummary {
  return {
    id,
    name,
    kind,
    maxAccounts: 3,
    limit: 3,
    inUse: 1,
    overLimit: false,
    overLimitSince: null,
    externalKey: kind === "ssh_host" ? "ssh:build.example.com:22" : null,
    targetKey,
    targetProvider: targetKey ? "example-provider" : null,
    targetMatch: null,
    targetReportedAt: null,
    managedByPluginId: null,
    managedByPluginName: null,
    owner: null,
    aliases: [],
    servedCompanyIds: [],
    availability: AVAILABLE,
    acceptedCredentialTypes: null,
    environments: [],
    accounts: [],
    companies: [],
    duplicateHints: [],
    createdAt: new Date(0).toISOString(),
  };
}

const LIMITED_AGENT = { id: "design-agent-limited", name: "Coder", companyId: COMPANY_ID, adapterType: "claude_local" };
const MIGRATED_AGENT = { id: "design-agent-migrated", name: "Reviewer", companyId: COMPANY_ID, adapterType: "claude_local" };
const DEVICE_LOGIN_AGENT = { id: "design-agent-device-login", name: "Designer", companyId: COMPANY_ID, adapterType: "claude_local" };
const READ_ONLY_AGENT = { id: "design-agent-read-only", name: "Writer", companyId: COMPANY_ID, adapterType: "claude_local" };

const SSH_DEVICE = instanceDevice("design-link-ssh", "SSH · Build box", "ssh_host", null);
const PLUGIN_DEVICE = instanceDevice(
  "design-link-plugin",
  "Build box",
  "external",
  "target:00000000-0000-4000-8000-000000000000:example-provider:build-box",
);
const SERVER_DEVICE = instanceDevice("design-link-server", "Paperclip server", "server", null);

const LINK_REQUESTS: Array<{ label: string; request: DeviceLinkRequest }> = [
  {
    label: "Linkable pair",
    request: { deviceId: SSH_DEVICE.id, hint: { deviceId: PLUGIN_DEVICE.id, deviceName: PLUGIN_DEVICE.name, matchedBy: "alias" } },
  },
  {
    label: "Pair that cannot be linked",
    request: { deviceId: SERVER_DEVICE.id, hint: { deviceId: PLUGIN_DEVICE.id, deviceName: PLUGIN_DEVICE.name, matchedBy: "label" } },
  },
];

function waitContext(reason: ResourceWaitContext["reason"]): ResourceWaitContext {
  return {
    version: 1,
    episodeId: "design-episode",
    kind: "environment",
    reason,
    scope: "target",
    environmentId: "design-environment",
    environmentName: "SSH · Build box",
    deviceId: BUILD_BOX.id,
    deviceName: BUILD_BOX.name,
    accountId: null,
    accountLabel: null,
    resumeAt: null,
    resumeAtSource: null,
    message: null,
  };
}

const WAIT_RUNS: Array<{ label: string; run: ResourceWaitRunLike }> = [
  {
    label: "A deferral: no provider work started",
    run: { status: "cancelled", errorCode: "environment_unavailable", resultJson: { resourceWait: waitContext("offline") } },
  },
  {
    label: "Its successor, waiting",
    run: {
      status: "scheduled_retry",
      scheduledRetryReason: "environment_wait",
      contextSnapshot: { resourceWait: waitContext("offline") },
      scheduledRetryAt: new Date(0).toISOString(),
    },
  },
  {
    label: "The successor once it started",
    run: { status: "succeeded", scheduledRetryReason: "environment_wait", startedAt: new Date(0).toISOString() },
  },
];

/**
 * One agent's picker options as the server sends them: to a company admin,
 * who may choose any eligible account, or to an account owner, who may
 * choose only their own (decision D4).
 */
function pickerOptions(now: Date, canBindAny: boolean): CompanyAiAccountOption[] {
  const notMine = canBindAny ? {} : { canBind: false, selectable: false, reason: "not_permitted" as const, warning: null };
  return [
    option({
      id: "design-pick-team",
      label: "Team Max",
      state: "limited",
      exhaustedUntil: new Date(now.getTime() + 3 * HOUR_MS).toISOString(),
      limitSource: "estimated",
      warning: "usage_limit",
      onAgentDevice: true,
      ...notMine,
    }),
    option({ id: "design-pick-mine", label: "My Pro", plan: "Pro", ownedByMe: true, owner: ME }),
    option({ id: "design-pick-night", label: "Night shift", ownedByMe: true, owner: ME, selectable: false, reason: "device_account_limit" }),
    option({ id: "design-pick-old", label: "Old token", ownedByMe: true, owner: ME, state: "signed_out", selectable: false, reason: "signed_out" }),
  ];
}

/** Every account state, as `AiAccountStateBadge` shows it. */
function stateBadgeSamples(now: Date): Array<{ state: AiAccountState; exhaustedUntil?: string; limitSource?: AiAccountLimitSource }> {
  const resetAt = new Date(now.getTime() + 3 * HOUR_MS).toISOString();
  return [
    { state: "active" },
    { state: "limited", exhaustedUntil: resetAt, limitSource: "estimated" },
    { state: "limited", exhaustedUntil: resetAt, limitSource: "provider" },
    { state: "signed_out" },
    { state: "withdrawn" },
    { state: "admin_disabled" },
  ];
}

interface WaitingTaskSample {
  label: string;
  issueId: string;
  scheduledRetry: IssueScheduledRetry;
  /** Also shown as a full banner, not only as a chip and a property value. */
  banner: boolean;
}

interface WaitingTaskInput {
  label: string;
  lane: ResourceWaitRetryReason;
  runId: string;
  agentName: string;
  banner: boolean;
  wait: ScheduledRetryResourceWait;
}

function waitingTask(key: string, input: WaitingTaskInput, now: Date): WaitingTaskSample {
  return {
    label: input.label,
    issueId: `design-issue-${key}`,
    banner: input.banner,
    scheduledRetry: {
      runId: input.runId,
      status: "scheduled_retry",
      agentId: `design-agent-${key}`,
      agentName: input.agentName,
      retryOfRunId: null,
      scheduledRetryAt: new Date(now.getTime() + MINUTE_MS).toISOString(),
      scheduledRetryAttempt: 2,
      scheduledRetryReason: input.lane,
      error: null,
      errorCode: null,
      resourceWait: { ...input.wait, episodeId: `design-episode-${key}` },
    },
  };
}

/** Waiting tasks of each lane: info waits resolve on their own, warning waits name the fix. */
function waitingTaskSamples(now: Date): WaitingTaskSample[] {
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const task = (key: string, input: WaitingTaskInput) => waitingTask(key, input, now);
  const account = (reason: ResourceWaitContext["reason"], accountId: string, accountLabel: string): ResourceWaitContext => ({
    ...waitContext(reason),
    kind: "ai_account",
    scope: "account",
    accountId,
    accountLabel,
  });
  return [
    task("offline", {
      label: "A device offline for an hour",
      lane: "environment_wait",
      runId: "4f2a9c10-6b3e-4d21-9a7f-0c1d2e3f4a51",
      agentName: "Coder",
      banner: true,
      wait: { ...waitContext("offline"), since: ago(HOUR_MS), notifiedAt: null },
    }),
    task("joined", {
      label: "A reviewer's run that joined another wait: no start time of its own",
      lane: "environment_wait",
      runId: "7c3d1e22-5a4b-4c6d-8e7f-1a2b3c4d5e62",
      agentName: "Reviewer",
      banner: true,
      wait: { ...waitContext("unreachable"), since: null, notifiedAt: null },
    }),
    task("limit", {
      label: "An account at its usage limit, estimated reset",
      lane: "ai_account_wait",
      runId: "a8b9c0d1-2e3f-4a5b-9c6d-7e8f9a0b1c73",
      agentName: "Coder",
      banner: true,
      wait: {
        ...account("usage_limit", "design-account-team", "Team Max"),
        resumeAt: new Date(now.getTime() + 3 * HOUR_MS).toISOString(),
        resumeAtSource: "estimated",
        since: ago(30 * MINUTE_MS),
        notifiedAt: ago(30 * MINUTE_MS),
      },
    }),
    task("signed-out", {
      label: "A signed-out account: a person has to act",
      lane: "ai_account_wait",
      runId: "d2e3f4a5-6b7c-4d8e-9f0a-1b2c3d4e5f84",
      agentName: "Coder",
      banner: true,
      wait: { ...account("signed_out", "design-account-old", "Old token"), since: ago(2 * HOUR_MS), notifiedAt: ago(2 * HOUR_MS) },
    }),
    task("slots", {
      label: "A device already running its maximum of Claude accounts",
      lane: "device_slot_wait",
      runId: "e5f6a7b8-9c0d-4e1f-8a2b-3c4d5e6f7a95",
      agentName: "Designer",
      banner: false,
      wait: { ...waitContext("slots_full"), kind: "device_slots", scope: "device", since: ago(10 * MINUTE_MS), notifiedAt: ago(10 * MINUTE_MS) },
    }),
  ];
}

/** An outage as the run ledger shows it: the waiting successor (newest first) and two earlier deferrals. */
function ledgerRuns(now: Date): ResourceWaitLedgerRunLike[] {
  const at = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const deferral = (runId: string, ms: number): ResourceWaitLedgerRunLike => ({
    runId,
    agentId: LIMITED_AGENT.id,
    status: "cancelled",
    errorCode: "environment_unavailable",
    resultJson: { resourceWait: waitContext("offline") },
    createdAt: at(ms),
    finishedAt: at(ms),
  });
  return [
    {
      runId: "4f2a9c10-6b3e-4d21-9a7f-0c1d2e3f4a51",
      agentId: LIMITED_AGENT.id,
      status: "scheduled_retry",
      scheduledRetryReason: "environment_wait",
      contextSnapshot: { resourceWait: waitContext("offline") },
      createdAt: at(20 * MINUTE_MS),
    },
    deferral("1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d06", 40 * MINUTE_MS),
    deferral("9e8d7c6b-5a49-4382-b716-05f4e3d2c117", HOUR_MS),
  ];
}

/** A query cache with the examples' data, kept fresh; every save stops before its request. */
function createExampleClient(now: Date): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false, refetchOnWindowFocus: false } },
    mutationCache: new MutationCache({
      onMutate: () => {
        throw new Error("This is an example: nothing was saved.");
      },
    }),
  });
  const seed = (queryKey: readonly unknown[], data: unknown) =>
    client.setQueryData(queryKey, data, { updatedAt: now.getTime() + FRESH_FOR_MS });
  const resetAt = new Date(now.getTime() + 3 * HOUR_MS).toISOString();
  const team = option({
    id: "design-account-team",
    label: "Team Max",
    state: "limited",
    exhaustedUntil: resetAt,
    limitSource: "estimated",
    warning: "usage_limit",
    onAgentDevice: true,
  });
  const mine = option({
    id: "design-account-mine",
    label: "My Pro",
    plan: "Pro",
    ownedByMe: true,
    owner: ME,
  });
  const full = option({ id: "design-account-night", label: "Night shift", selectable: false, reason: "device_account_limit" });
  const ada = option({ id: "design-account-ada", label: "Ada's Max", onAgentDevice: true });
  seed(aiAccountPoolKeys.agent(LIMITED_AGENT.id), binding({
    agentId: LIMITED_AGENT.id,
    agentName: LIMITED_AGENT.name,
    state: "pool_account",
    mode: "pool_account",
    source: "manual",
    account: {
      id: team.id,
      label: team.label,
      credentialType: "subscription",
      state: "limited",
      ownedByMe: false,
      ownerName: "Ada",
      exhaustedUntil: resetAt,
      limitSource: "estimated",
    },
    options: [team, mine, full],
  }));
  seed(aiAccountPoolKeys.agent(MIGRATED_AGENT.id), binding({
    agentId: MIGRATED_AGENT.id,
    agentName: MIGRATED_AGENT.name,
    state: "unassigned",
    mode: "pool_account",
    source: "migrated_host_pool",
    migrationNote: "The account it used most is over the device's limit of Claude accounts.",
    needsReview: true,
    devices: [BUILD_BOX, SERVER],
    pinned: false,
    options: [{ ...team, onAgentDevice: false }, mine, full],
  }));
  seed(aiAccountPoolKeys.agent(DEVICE_LOGIN_AGENT.id), binding({
    agentId: DEVICE_LOGIN_AGENT.id,
    agentName: DEVICE_LOGIN_AGENT.name,
    state: "device_login",
    mode: "device_login",
    source: "manual",
    options: [{ ...team, onAgentDevice: false }, mine],
  }));
  // A member who neither owns the account nor is a company admin sees the selection, but cannot change it.
  seed(aiAccountPoolKeys.agent(READ_ONLY_AGENT.id), binding({
    agentId: READ_ONLY_AGENT.id,
    agentName: READ_ONLY_AGENT.name,
    state: "pool_account",
    mode: "pool_account",
    source: "manual",
    account: {
      id: ada.id,
      label: ada.label,
      credentialType: "subscription",
      state: "active",
      ownedByMe: false,
      ownerName: "Ada",
      exhaustedUntil: null,
      limitSource: null,
    },
    canChange: false,
    canBindAny: false,
    options: [{ ...ada, canBind: false, selectable: false, reason: "not_permitted" }, mine],
  }));
  for (const agent of [LIMITED_AGENT, MIGRATED_AGENT, DEVICE_LOGIN_AGENT, READ_ONLY_AGENT]) {
    seed([...queryKeys.heartbeats(COMPANY_ID, agent.id), "resource-wait"], []);
  }
  const offline: EnvironmentAvailabilitySummary = {
    ...AVAILABLE,
    state: "unavailable",
    reason: "offline",
    unavailableSince: new Date(now.getTime() - HOUR_MS).toISOString(),
  };
  seed(executionDeviceKeys.company(COMPANY_ID), {
    limitPerDevice: 3,
    devices: [companyDevice(BUILD_BOX, AVAILABLE), companyDevice(SERVER, offline)],
  } satisfies CompanyExecutionDevicesResponse);
  seed(executionDeviceKeys.instance, {
    limitPerDevice: 3,
    devices: [SSH_DEVICE, PLUGIN_DEVICE, SERVER_DEVICE],
  } satisfies InstanceExecutionDevicesResponse);
  return client;
}

function Example({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium">{title}</h4>
      {children}
    </div>
  );
}

/** A picker that keeps its choice in place; nothing is saved. */
function AccountSelectExample({
  options,
  canBindAny,
  initial,
  label,
  now,
}: {
  options: readonly CompanyAiAccountOption[];
  canBindAny: boolean;
  initial: AccountSelectValue;
  label: string;
  now: Date;
}) {
  const [value, setValue] = useState<AccountSelectValue>(initial);
  const current = value?.mode === "pool_account" ? options.find((entry) => entry.id === value.accountId) ?? null : null;
  return (
    <div className="max-w-md">
      <AccountSelect
        options={options}
        canBindAny={canBindAny}
        value={value}
        onChange={setValue}
        includeDeviceLogin
        canSetDeviceLogin={canChooseDeviceLogin({ canBindAny, binding: { mode: value?.mode ?? null, account: current } })}
        aria-label={label}
        now={now}
      />
    </div>
  );
}

export function AccountPoolDesignExamples() {
  const [now] = useState(() => new Date());
  const [client] = useState(() => createExampleClient(now));
  const [samples] = useState(() => ({
    adminOptions: pickerOptions(now, true),
    ownerOptions: pickerOptions(now, false),
    badges: stateBadgeSamples(now),
    waitingTasks: waitingTaskSamples(now),
    ledger: ledgerRuns(now),
  }));
  const [linkRequest, setLinkRequest] = useState<DeviceLinkRequest | null>(null);
  return (
    <QueryClientProvider client={client}>
      <div className="flex max-w-2xl flex-col gap-5">
        <p className="text-sm text-muted-foreground">
          Sample data. A Claude agent uses one Claude account, or its device's own login, and Paperclip never moves a
          task to another account. A task whose device or account is unavailable waits and starts on its own. Saves
          and checks in these examples stop before they reach the server.
        </p>
        <Example title="AgentClaudeAccountCard: an account at its usage limit">
          <AgentClaudeAccountCard agent={LIMITED_AGENT} now={now} />
        </Example>
        <Example title="AgentClaudeAccountCard: a migrated agent without an account">
          <AgentClaudeAccountCard agent={MIGRATED_AGENT} now={now} />
        </Example>
        <Example title="AgentClaudeAccountCard: on its device's own login">
          <AgentClaudeAccountCard agent={DEVICE_LOGIN_AGENT} now={now} />
        </Example>
        <Example title="AgentClaudeAccountCard: read-only for a member who cannot change it">
          <AgentClaudeAccountCard agent={READ_ONLY_AGENT} now={now} />
        </Example>
        <Example title="AccountSelect: a company admin may choose any eligible account">
          <AccountSelectExample
            options={samples.adminOptions}
            canBindAny
            initial={{ mode: "pool_account", accountId: "design-pick-team" }}
            label="Claude account, as a company admin"
            now={now}
          />
        </Example>
        <Example title="AccountSelect: an account owner may choose only their own">
          <AccountSelectExample
            options={samples.ownerOptions}
            canBindAny={false}
            initial={null}
            label="Claude account, as an account owner"
            now={now}
          />
        </Example>
        <Example title="AiAccountStateBadge">
          <div className="flex flex-wrap items-center gap-2">
            {samples.badges.map((account) => (
              <AiAccountStateBadge key={`${account.state}:${account.limitSource ?? ""}`} display={aiAccountStateDisplay(account, now)} />
            ))}
          </div>
        </Example>
        <Example title="ResourceWaitBanner, with ResourceWaitCheckNowButton">
          <div className="space-y-3">
            {samples.waitingTasks.filter((task) => task.banner).map((task) => (
              <div key={task.issueId} className="space-y-1">
                <p className="text-xs text-muted-foreground">{task.label}</p>
                <ResourceWaitBanner issueId={task.issueId} scheduledRetry={task.scheduledRetry} />
              </div>
            ))}
          </div>
        </Example>
        <Example title="ResourceWaitChip and ResourceWaitPropertyValue">
          <ul className="space-y-1.5">
            {samples.waitingTasks.map((task) => (
              <li key={task.issueId} className="flex flex-wrap items-center gap-2">
                <ResourceWaitChip scheduledRetry={task.scheduledRetry} />
                <ResourceWaitPropertyValue scheduledRetry={task.scheduledRetry} />
              </li>
            ))}
            <li className="flex flex-wrap items-center gap-2 text-sm">
              <ResourceWaitChip scheduledRetry={samples.waitingTasks[0]!.scheduledRetry} selected />
              <span className="text-muted-foreground">In a selected task row</span>
            </li>
          </ul>
        </Example>
        <Example title="ResourceWaitLedgerEntry">
          <ResourceWaitLedgerEntry runs={samples.ledger} agentName={LIMITED_AGENT.name} timestamp={samples.ledger[0]!.createdAt} />
        </Example>
        <Example title="RunResourceWaitBadge">
          <ul className="space-y-1.5">
            {WAIT_RUNS.map(({ label, run }) => (
              <li key={label} className="flex flex-wrap items-center gap-2 text-sm">
                <RunResourceWaitBadge run={run} />
                <span className="text-muted-foreground">{label}</span>
              </li>
            ))}
          </ul>
        </Example>
        <Example title="DeviceLinkDialog">
          <div className="flex flex-wrap items-center gap-2">
            {LINK_REQUESTS.map(({ label, request }) => (
              <Button key={label} type="button" variant="outline" size="sm" onClick={() => setLinkRequest(request)}>
                {label}
              </Button>
            ))}
          </div>
          <DeviceLinkDialog request={linkRequest} onClose={() => setLinkRequest(null)} />
        </Example>
      </div>
    </QueryClientProvider>
  );
}
