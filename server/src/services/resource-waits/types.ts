import type { Db, agentWakeupRequests, agents, heartbeatRuns, resourceWaitEpisodes } from "@paperclipai/db";
import type {
  AiAccountWaitReason,
  EnvironmentWaitReason,
  IssueCommentMetadata,
  IssueCommentPresentation,
  ResourceWaitKind,
  ResourceWaitReason,
  ResourceWaitRefusalReason,
  ResourceWaitResumeAtSource,
  ResourceWaitRetryReason,
  ResourceWaitScope,
} from "@paperclipai/shared";
import type { GateDecision } from "../../modules/run-dispatch/index.js";

/**
 * Fork: shared types of the resource-wait module. A run whose execution
 * device, Claude account or device account slots are unavailable is not
 * failed: it is cancelled as an expected deferral and a successor waits in a
 * resource-wait lane (spec 7). Nothing here ever moves a task to another
 * account or another device.
 */

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** A database handle or an open transaction. */
export type ResourceWaitDb = Db | Tx;
export type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;
export type HeartbeatRunPatch = Partial<typeof heartbeatRuns.$inferInsert>;
export type AgentRow = typeof agents.$inferSelect;
export type ResourceWaitEpisodeRow = typeof resourceWaitEpisodes.$inferSelect;

/**
 * Hold, backoff and sweep timings (spec 6.3, 7.1 and 7.4). Holds that wait for
 * an event still re-check at least every `gateIntervalMs`, so a closed or
 * reassigned issue never keeps its waiting run for long.
 */
export const RESOURCE_WAIT_TIMINGS = {
  /** Shortest hold of a target-scope wait. */
  minHoldMs: 30_000,
  /** A target-scope hold re-checks this long after the registry's next check, so the sweep's check lands first. */
  sweepGraceMs: 30_000,
  /** The issue gate runs at most this often per waiting run; no re-arm reaches further. */
  gateIntervalMs: 5 * 60_000,
  /** Database re-check of account and slot waits, ±20 %. */
  recheckMs: 60_000,
  recheckJitter: 0.2,
  /** `auth_unconfirmed`: the run-scoped sign-in check waits this long. */
  authUnconfirmedMs: 10 * 60_000,
  /** `jitter(runId)` added to a limit reset, 0–120 s. */
  limitJitterMaxMs: 120_000,
  /** not_allowed, not_serving, stopped and plugin_upgrade_pending: every 5 min, doubling to 60 min. */
  admissionSlowBaseMs: 5 * 60_000,
  admissionSlowMaxMs: 60 * 60_000,
  /** `other` (admission): 60 s doubling to 10 min. */
  admissionOtherBaseMs: 60_000,
  admissionOtherMaxMs: 10 * 60_000,
  busyMs: 60_000,
  throttledMinMs: 30_000,
  throttledMaxMs: 60_000,
  restartingMs: 30_000,
  /** The sweep clears a probe claim whose run has not started within this. */
  probeStartTimeoutMs: 15 * 60_000,
  /** An episode whose run ended this long ago without a newer lane run is abandoned. */
  abandonGraceMs: 10 * 60_000,
  /** One sweep availability check (SSH probe or plugin call). */
  checkTimeoutMs: 15_000,
  /** A registry row whose backoff outlasts the trust window is checked this long before it goes stale. */
  staleRefreshLeadMs: 60_000,
  /** The plugin's `environmentCheckAvailability` call. */
  pluginCheckTimeoutMs: 10_000,
  sweepChecksPerPass: 5,
  holdBatchLimit: 200,
  /** "Check now" on a waiting issue or a device: once per window. */
  checkNowWindowMs: 60_000,
} as const;

/** What a run waits for. Every text field is shown to the company's members. */
export interface ResourceWaitTarget {
  kind: ResourceWaitKind;
  reason: ResourceWaitReason;
  scope: ResourceWaitScope;
  environmentId: string | null;
  environmentName: string | null;
  deviceId: string | null;
  deviceName: string | null;
  accountId: string | null;
  /** Null where the account's owner is not an active member of the run's company. */
  accountLabel: string | null;
  resumeAt: Date | null;
  resumeAtSource: ResourceWaitResumeAtSource | null;
  /** A driver envelope's sanitized message. Never stderr, a host or a port. */
  message: string | null;
  /** When the driver asked to be tried again (admission waits). */
  retryAfter: Date | null;
}

/**
 * The wake epochs read before an attempt (spec 7.3 step 5). A deferral
 * re-reads them after its successor exists; when any moved, a report, check,
 * binding or account change raced the attempt and the successor is due now.
 * Timestamps are exact database text (microseconds).
 */
export interface WakeEpochSnapshot {
  environmentId: string | null;
  /** `environment_availability.wake_epoch`; 0 without a row. */
  environmentEpoch: number | null;
  agentId: string | null;
  /** The agent's binding `updated_at`; null without a binding. */
  bindingUpdatedAt: string | null;
  accountId: string | null;
  accountUpdatedAt: string | null;
  deviceId: string | null;
  deviceUpdatedAt: string | null;
}

export interface WakeEpochRefs {
  environmentId?: string | null;
  agentId?: string | null;
  accountId?: string | null;
  deviceId?: string | null;
}

/**
 * Thrown on the run path when the run has to wait instead of failing. The
 * executeRun outer catch hands it to `finalizeDeferral` (hook H5).
 */
export class ResourceWaitDeferral extends Error {
  readonly code = "resource_wait_deferral" as const;
  readonly wait: ResourceWaitTarget;
  readonly epochs: WakeEpochSnapshot | null;
  /** Whether the deferred run executed as the issue's assignee; computed from the issue when null. */
  readonly wasIssueAssignee: boolean | null;

  constructor(
    wait: ResourceWaitTarget,
    options: { epochs?: WakeEpochSnapshot | null; wasIssueAssignee?: boolean | null; cause?: unknown } = {},
  ) {
    super(
      `Resource wait: ${wait.kind} (${wait.reason})`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ResourceWaitDeferral";
    this.wait = wait;
    this.epochs = options.epochs ?? null;
    this.wasIssueAssignee = options.wasIssueAssignee ?? null;
  }
}

export function isResourceWaitDeferral(error: unknown): error is ResourceWaitDeferral {
  return error instanceof ResourceWaitDeferral;
}

/**
 * Real configuration that blocks the run instead of waiting (spec 7.1): a
 * refused or retired environment, a routing override, or a persisted run
 * whose account is gone. heartbeat turns it into its own
 * `ConfigurationIncompleteFailure(message, resultJson)`.
 */
export class ConfigurationRefusal extends Error {
  readonly code = "configuration_incomplete" as const;
  readonly reason: ResourceWaitRefusalReason;
  readonly resultJson: Record<string, unknown>;

  constructor(input: {
    reason: ResourceWaitRefusalReason;
    message: string;
    companyId?: string | null;
    agentId?: string | null;
    environmentId?: string | null;
    deviceId?: string | null;
  }) {
    super(input.message);
    this.name = "ConfigurationRefusal";
    this.reason = input.reason;
    this.resultJson = {
      configurationIncomplete: {
        reason: input.reason,
        ...(input.companyId ? { companyId: input.companyId } : {}),
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.environmentId ? { environmentId: input.environmentId } : {}),
        ...(input.deviceId ? { deviceId: input.deviceId } : {}),
        fingerprint: `${input.reason}:${input.environmentId ?? input.agentId ?? "run"}`,
      },
    };
  }
}

export function isConfigurationRefusal(error: unknown): error is ConfigurationRefusal {
  return error instanceof ConfigurationRefusal;
}

interface NamedRef {
  id: string;
  name: string | null;
}

/** An environment wait (preflight, a classified lease error). */
export function environmentWaitDeferral(input: {
  reason: EnvironmentWaitReason;
  scope: "target" | "admission";
  environment: NamedRef;
  device?: NamedRef | null;
  message?: string | null;
  retryAfter?: Date | null;
  resumeAt?: Date | null;
  epochs?: WakeEpochSnapshot | null;
  wasIssueAssignee?: boolean | null;
  cause?: unknown;
}): ResourceWaitDeferral {
  return new ResourceWaitDeferral({
    kind: "environment",
    reason: input.reason,
    scope: input.scope,
    environmentId: input.environment.id,
    environmentName: input.environment.name,
    deviceId: input.device?.id ?? null,
    deviceName: input.device?.name ?? null,
    accountId: null,
    accountLabel: null,
    resumeAt: input.resumeAt ?? null,
    resumeAtSource: input.resumeAt ? "check" : null,
    message: input.message ?? null,
    retryAfter: input.retryAfter ?? null,
  }, { epochs: input.epochs, wasIssueAssignee: input.wasIssueAssignee, cause: input.cause });
}

/**
 * An account wait from planCredential or acquire (spec 4.2, 4.3). Pass the
 * label only where the account's owner is an active member of the run's
 * company (never for `owner_not_member`).
 */
export function accountWaitDeferral(input: {
  reason: AiAccountWaitReason;
  accountId: string | null;
  accountLabel: string | null;
  environment?: NamedRef | null;
  device?: NamedRef | null;
  resumeAt?: Date | null;
  resumeAtSource?: ResourceWaitResumeAtSource | null;
  epochs?: WakeEpochSnapshot | null;
  wasIssueAssignee?: boolean | null;
}): ResourceWaitDeferral {
  return new ResourceWaitDeferral({
    kind: "ai_account",
    reason: input.reason,
    scope: "account",
    environmentId: input.environment?.id ?? null,
    environmentName: input.environment?.name ?? null,
    deviceId: input.device?.id ?? null,
    deviceName: input.device?.name ?? null,
    accountId: input.accountId,
    accountLabel: input.reason === "owner_not_member" ? null : input.accountLabel,
    resumeAt: input.resumeAt ?? null,
    resumeAtSource: input.resumeAt ? input.resumeAtSource ?? "estimated" : null,
    message: null,
    retryAfter: null,
  }, { epochs: input.epochs, wasIssueAssignee: input.wasIssueAssignee });
}

/** The device already runs its cap of distinct pool accounts (spec 4.3 step 4). */
export function deviceSlotsDeferral(input: {
  device: NamedRef;
  environment?: NamedRef | null;
  accountId: string | null;
  accountLabel: string | null;
  epochs?: WakeEpochSnapshot | null;
  wasIssueAssignee?: boolean | null;
}): ResourceWaitDeferral {
  return new ResourceWaitDeferral({
    kind: "device_slots",
    reason: "slots_full",
    scope: "device",
    environmentId: input.environment?.id ?? null,
    environmentName: input.environment?.name ?? null,
    deviceId: input.device.id,
    deviceName: input.device.name,
    accountId: input.accountId,
    accountLabel: input.accountLabel,
    resumeAt: null,
    resumeAtSource: null,
    message: null,
    retryAfter: null,
  }, { epochs: input.epochs, wasIssueAssignee: input.wasIssueAssignee });
}

// ---------------------------------------------------------------------------
// Heartbeat closures (dependency injection)
// ---------------------------------------------------------------------------

/** Options passed to heartbeat's `scheduleBoundedRetryForRun`; `contextPatch` is merged last (hook H8). */
export interface ResourceWaitScheduleOptions {
  now: Date;
  retryReason: ResourceWaitRetryReason;
  wakeReason: string;
  maxAttempts: number;
  delayMs: number;
  contextPatch: Record<string, unknown>;
}

export type ResourceWaitScheduleOutcome =
  | { outcome: "scheduled"; run: HeartbeatRunRow; reusedExisting?: boolean }
  | { outcome: "not_scheduled"; reason: string; errorCode?: string | null; issueId?: string | null }
  | { outcome: "retry_exhausted"; attempt?: number; maxAttempts?: number };

/** The subset of heartbeat's wakeup options a PM summary wake uses. */
export interface ResourceWaitWakeupOptions {
  source: "automation";
  triggerDetail: "system";
  reason: string;
  payload: Record<string, unknown> | null;
  requestedByActorType: "system";
  requestedByActorId: null;
  contextSnapshot: Record<string, unknown>;
  /** False: the wake gets its own run instead of joining one already queued, waiting or running. */
  allowRunCoalescing?: boolean;
}

export interface ResourceWaitIssueNotice {
  companyId: string;
  issueId: string;
  body: string;
  presentation: IssueCommentPresentation;
  metadata?: IssueCommentMetadata | null;
}

/**
 * Closures heartbeat injects (W8). Each wraps the heartbeat function of the
 * same name; `addIssueSystemNotice` posts a system comment through
 * `issuesSvc.addComment(issueId, body, {}, { authorType: "system", presentation, metadata })`.
 */
export interface ResourceWaitDeps {
  setRunStatusIfRunning(
    runId: string,
    status: string,
    patch?: HeartbeatRunPatch,
  ): Promise<{ run: HeartbeatRunRow | null; updated: boolean }>;
  setWakeupStatus(
    wakeupRequestId: string | null | undefined,
    status: string,
    patch?: Partial<typeof agentWakeupRequests.$inferInsert>,
  ): Promise<void>;
  getRun(runId: string): Promise<HeartbeatRunRow | null>;
  getAgent(agentId: string): Promise<AgentRow | null>;
  scheduleBoundedRetryForRun(
    run: HeartbeatRunRow,
    agent: AgentRow,
    opts: ResourceWaitScheduleOptions,
  ): Promise<ResourceWaitScheduleOutcome>;
  appendRunEvent(
    run: HeartbeatRunRow,
    event: {
      eventType: string;
      stream?: "system" | "stdout" | "stderr";
      level?: "info" | "warn" | "error";
      message?: string;
      payload?: Record<string, unknown>;
    },
  ): Promise<void>;
  releaseIssueExecutionAndPromote(run: Pick<HeartbeatRunRow, "id" | "companyId">): Promise<void>;
  finalizeAgentStatus(
    agentId: string,
    outcome: "cancelled",
    failureReason?: string | null,
    options?: { keepIdleOnFailure?: boolean; wasFirstHeartbeat?: boolean },
  ): Promise<void>;
  enqueueWakeup(agentId: string, opts: ResourceWaitWakeupOptions): Promise<unknown>;
  addIssueSystemNotice(input: ResourceWaitIssueNotice): Promise<unknown>;
  evaluateScheduledRetryGate(input: {
    runId: string;
    companyId: string;
    retryReasonOverride: string;
    now: Date;
  }): Promise<GateDecision>;
}

export type { GateDecision };
