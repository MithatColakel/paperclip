import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  heartbeatRuns,
  issueRecoveryActions,
  issueThreadInteractions,
  nativeRunFinalizations,
  type Db,
} from "@paperclipai/db";
import {
  isResourceWaitErrorCode,
  isResourceWaitRetryReason,
  readResourceWaitContext,
  type ExecutionProjection,
  type ResourceWaitContext,
  type ResourceWaitErrorCode,
} from "@paperclipai/shared";
import { EXECUTION_CONTROL_DEADLINE_MS } from "./execution-control-deadline.js";
import { executionFailureRetryCount } from "./execution-recovery-attempt.js";
import { resourceWaitReasonLabel } from "./resource-waits/notify.js";
import { retryIdempotentDatabaseOperation } from "../database-retry.js";
const text = (v: unknown) => (typeof v === "string" ? v : null);
const executionRunColumns = {
  id: heartbeatRuns.id,
  errorCode: heartbeatRuns.errorCode,
  executionControlDeadlineAt: heartbeatRuns.executionControlDeadlineAt,
  finishedAt: heartbeatRuns.finishedAt,
  lastOutputAt: heartbeatRuns.lastOutputAt,
  lastUsefulActionAt: heartbeatRuns.lastUsefulActionAt,
  nativeIssueId: heartbeatRuns.nativeIssueId,
  nextAction: heartbeatRuns.nextAction,
  processPid: heartbeatRuns.processPid,
  retryOfRunId: heartbeatRuns.retryOfRunId,
  runtimeMode: heartbeatRuns.runtimeMode,
  scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
  scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt,
  scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
  startedAt: heartbeatRuns.startedAt,
  status: heartbeatRuns.status,
  // Fork: plus the failure count saved before a resource wait and the wait itself (spec 7.7).
  contextSnapshot: sql<Record<string, unknown>>`jsonb_build_object(
    'issueId', ${heartbeatRuns.contextSnapshot}->'issueId',
    'failureRetriesBeforeAiConnectionWait', ${heartbeatRuns.contextSnapshot}->'failureRetriesBeforeAiConnectionWait',
    'failureRetriesBeforeWorkspaceWait', ${heartbeatRuns.contextSnapshot}->'failureRetriesBeforeWorkspaceWait',
    'failureRetriesBeforeResourceWait', ${heartbeatRuns.contextSnapshot}->'failureRetriesBeforeResourceWait',
    'resourceWait', ${heartbeatRuns.contextSnapshot}->'resourceWait')`,
};
type Run = Pick<typeof heartbeatRuns.$inferSelect, keyof typeof executionRunColumns>;
type Coordinator = typeof nativeRunFinalizations.$inferSelect;
type Recovery = Pick<
  typeof issueRecoveryActions.$inferSelect,
  "cause" | "nextAction"
> &
  Partial<
    Pick<typeof issueRecoveryActions.$inferSelect, "status" | "evidence">
  >;

// Fork: device, Claude account and account-slot waits (spec 7.7). A lane
// successor says what it waits for and what, if anything, a person can fix;
// its cancelled deferral shows as "Waited", never as a failed run.
const RESOURCE_WAIT_DEFERRAL_ACTIONS: Readonly<Record<ResourceWaitErrorCode, string>> = {
  environment_unavailable: "This run waited for its execution device and started no provider work. The task continues in its next run.",
  ai_account_unavailable: "This run waited for its Claude account and started no provider work. The task continues in its next run.",
  device_slots_full: "This run waited for a Claude account slot on its device and started no provider work. The task continues in its next run.",
};

function utcTime(value: string | null): string | null {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? `${new Date(time).toISOString().slice(0, 16).replace("T", " ")} UTC` : null;
}

function environmentWaitProjection(wait: ResourceWaitContext | null) {
  const device = wait?.deviceName ?? wait?.environmentName ?? null;
  const subject = device ? `device ${device}` : "its execution device";
  const starts = "The task starts automatically when it is available; Paperclip never moves it to another device.";
  // The driver's own message names the fix it needs (never set for SSH or Local).
  const driverFix = wait?.message ? `${/[.!?]$/.test(wait.message) ? wait.message : `${wait.message}.`} The task then starts automatically.` : null;
  switch (wait?.reason) {
    case "not_allowed":
      return { label: "Waiting for device", nextAction: driverFix ?? `This project is not enabled for this company on ${subject}. Enable it there, or move the agent to another device. The task then starts automatically.` };
    case "not_serving":
      return { label: "Waiting for device", nextAction: driverFix ?? `${device ? `Device ${device}` : "Its execution device"} does not serve this company. Add its owner to this company, or move the agent to another device. The task then starts automatically.` };
    case "stopped":
      return { label: "Waiting for device", nextAction: `Work for this company is stopped on ${subject}. The task starts automatically when it is resumed.` };
    default:
      return { label: "Waiting for device", nextAction: `Waiting for ${subject}${wait ? ` (${resourceWaitReasonLabel(wait.reason)})` : ""}. ${starts}` };
  }
}

function accountWaitProjection(wait: ResourceWaitContext | null) {
  const named = wait?.accountLabel ? `Claude account ${wait.accountLabel}` : null;
  const account = named ?? "The agent's Claude account";
  const resets = utcTime(wait?.resumeAt ?? null);
  const at = resets ? ` at ${resets}${wait?.resumeAtSource === "provider" ? "" : " (estimated)"}` : "";
  const never = "Paperclip never moves a task to another account.";
  switch (wait?.reason) {
    case "usage_limit":
      return { label: "Waiting for usage limit reset", nextAction: `${account} reached its usage limit. The task resumes automatically when it resets${at}. ${never}` };
    case "credit_balance":
      return { label: "Waiting for API credit", nextAction: `${account} has no API credit left. Add credit, then the owner can clear the limit; the task resumes automatically${at}. ${never}` };
    case "auth_unconfirmed":
      return { label: "Checking Claude account sign-in", nextAction: `${account} failed to sign in once. Paperclip checks it again shortly; the task resumes automatically. ${never}` };
    case "signed_out":
      return { label: "Waiting for a Claude account", nextAction: `${account} is signed out. Its owner must replace the token, or choose another account for the agent. The task then starts automatically.` };
    case "withdrawn":
      return { label: "Waiting for a Claude account", nextAction: `${account} is switched off. Turn it back on, or choose another account for the agent. The task then starts automatically.` };
    case "unassigned":
      return { label: "Waiting for a Claude account", nextAction: "No Claude account is chosen for the agent. Choose one, or switch the agent to its device's own login. The task then starts automatically." };
    case "owner_not_member":
      return { label: "Waiting for a Claude account", nextAction: "The agent's Claude account is no longer available in this company. Choose another account, or add its owner back to this company. The task then starts automatically." };
    case "reserved_elsewhere":
      return { label: "Waiting for a Claude account", nextAction: `${account} is reserved for other projects. Its owner can clear the reservation, or choose another account for the agent. The task then starts automatically.` };
    case "device_unknown":
      return { label: "Waiting for a Claude account", nextAction: "Paperclip cannot tell which device the agent runs on. Pin the agent to an environment, or ask an instance admin to map the environment to a device. The task then starts automatically." };
    case "credential_type_unsupported":
      return { label: "Waiting for a Claude account", nextAction: `${wait?.deviceName ? `Device ${wait.deviceName}` : "The agent's device"} does not accept this account's credential type. Choose another account, or move the agent to another device. The task then starts automatically.` };
    default:
      return { label: "Waiting for a Claude account", nextAction: `Waiting for ${named ?? "the agent's Claude account"}. The task starts automatically when it is available. ${never}` };
  }
}

/** The projection of a resource-wait lane successor or its deferral; null for every other run. */
function resourceWaitProjection(run: Run): { phase: ExecutionProjection["phase"]; label: string; nextAction: string } | null {
  if (run.status === "cancelled" && isResourceWaitErrorCode(run.errorCode)) {
    return { phase: "completed", label: "Waited", nextAction: RESOURCE_WAIT_DEFERRAL_ACTIONS[run.errorCode] };
  }
  const lane = run.scheduledRetryReason;
  if (run.status !== "scheduled_retry" || !isResourceWaitRetryReason(lane)) return null;
  const wait = readResourceWaitContext(run.contextSnapshot?.resourceWait);
  if (lane === "environment_wait") return { phase: "retry_scheduled", ...environmentWaitProjection(wait) };
  if (lane === "ai_account_wait") return { phase: "retry_scheduled", ...accountWaitProjection(wait) };
  const device = wait?.deviceName ?? null;
  return {
    phase: "retry_scheduled",
    label: "Waiting for an account slot",
    nextAction: `${device ? `Device ${device}` : "Its device"} already runs its maximum of Claude accounts. The task starts automatically when a slot there is free; to avoid the wait, choose an account already running there for the agent.`,
  };
}

/** Batched reads; list consumers do not perform per-task polling. */
export async function executionProjectionsForRuns(
  db: Db,
  companyId: string,
  runIds: string[],
  now = new Date(),
  options: { retryDatabaseReads?: boolean } = {},
) {
  const projections = new Map<string, ExecutionProjection>();
  if (!runIds.length) return projections;
  // Opt in only with a pooled Db outside a transaction. Issue enrichment also
  // calls this helper with a transaction, whose failed reads must not replay.
  const read = <T>(query: () => Promise<T>) => options.retryDatabaseReads
    ? retryIdempotentDatabaseOperation(query)
    : query();
  const runs = await read(async () => db
    .select(executionRunColumns)
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.id, runIds),
      ),
    ));
  const coordinators = await read(async () => db
    .select()
    .from(nativeRunFinalizations)
    .where(
      and(
        eq(nativeRunFinalizations.companyId, companyId),
        inArray(nativeRunFinalizations.runId, runIds),
      ),
    ));
  const issueIds = [
    ...new Set(
      runs
        .map((run) => run.nativeIssueId ?? text(run.contextSnapshot?.issueId))
        .filter((id): id is string => !!id),
    ),
  ];
  const pending = issueIds.length
    ? await read(async () => db
        .select({
          issueId: issueThreadInteractions.issueId,
          kind: issueThreadInteractions.kind,
        })
        .from(issueThreadInteractions)
        .where(
          and(
            eq(issueThreadInteractions.companyId, companyId),
            inArray(issueThreadInteractions.issueId, issueIds),
            eq(issueThreadInteractions.status, "pending"),
          ),
        ))
    : [];
  const recovery = issueIds.length
    ? await read(async () => db
        .select({
          issueId: issueRecoveryActions.sourceIssueId,
          cause: issueRecoveryActions.cause,
          nextAction: issueRecoveryActions.nextAction,
          evidence: issueRecoveryActions.evidence,
          status: issueRecoveryActions.status,
        })
        .from(issueRecoveryActions)
        .where(
          and(
            eq(issueRecoveryActions.companyId, companyId),
            inArray(issueRecoveryActions.sourceIssueId, issueIds),
            inArray(issueRecoveryActions.status, [
              "active",
              "escalated",
              "resolved",
            ]),
          ),
        )
        .orderBy(desc(issueRecoveryActions.updatedAt)))
    : [];
  const coordinatorByRun = new Map(coordinators.map((row) => [row.runId, row]));
  for (const run of runs) {
    const issueId = run.nativeIssueId ?? text(run.contextSnapshot?.issueId);
    const matching = recovery.filter(
      (row) =>
        row.issueId === issueId &&
        (row.status !== "resolved" || row.evidence.executionReconciliation || row.evidence.automaticRecovery) &&
        (row.evidence.runId === run.id || row.evidence.sourceRunId === run.id),
    );
    const action =
      matching.find((row) => row.status !== "resolved") ?? matching[0];
    projections.set(
      run.id,
      projectExecution(
        run,
        coordinatorByRun.get(run.id),
        pending.filter((row) => row.issueId === issueId),
        action,
        now,
      ),
    );
  }
  return projections;
}
export async function executionProjectionForRun(
  db: Db,
  companyId: string,
  runId: string,
  now = new Date(),
): Promise<ExecutionProjection | null> {
  return (
    (await executionProjectionsForRuns(db, companyId, [runId], now)).get(
      runId,
    ) ?? null
  );
}
export function projectExecution(
  run: Run,
  coordinator: Coordinator | undefined,
  pending: Array<{ kind: string }>,
  recoveryAction: Recovery | undefined,
  now = new Date(),
): ExecutionProjection {
  const detail = coordinator?.failureDetail ?? {};
  const successorRunId = text(detail.successorRunId);
  const projection: ExecutionProjection = {
    phase: "queued",
    label: "Queued",
    cause: run.errorCode ?? coordinator?.failureCode ?? null,
    lastConfirmedActivityAt:
      (
        run.lastUsefulActionAt ??
        run.lastOutputAt ??
        run.startedAt
      )?.toISOString() ?? null,
    retryAt:
      (coordinator?.nextAttemptAt ?? run.scheduledRetryAt)?.toISOString() ??
      null,
    attempt: coordinator?.attempt ?? executionFailureRetryCount(run) + 1,
    maxAttempts: 3,
    recoveryOwner: null,
    nextAction: text(detail.nextAction) ?? run.nextAction,
    permittedActions: ["inspect_run"],
    predecessorRunId: run.retryOfRunId,
    successorRunId,
  };
  const set = (phase: ExecutionProjection["phase"], label: string) =>
    Object.assign(projection, { phase, label });
  if (recoveryAction?.status === "resolved" && recoveryAction.evidence?.automaticRecovery) {
    projection.cause = recoveryAction.cause;
    projection.nextAction = recoveryAction.nextAction;
    const continuation = recoveryAction.evidence.explicitUserContinuation as
      { previousRunId?: unknown; runId?: unknown } | undefined;
    const explicitSuccessor = text(continuation?.runId);
    if (continuation?.previousRunId === run.id && explicitSuccessor && explicitSuccessor !== run.id) {
      // The admission transaction already recorded the user's successor. Keep
      // the old failure diagnostic without making it hold the newer attempt.
      projection.successorRunId = explicitSuccessor;
      projection.nextAction = null;
      return set("completed", "Continued in another run");
    }
    // Diagnostic projection only: no user decision or replay affordance.
    return set("recovery_needed", "Stopped");
  }
  if (
    recoveryAction?.status === "resolved" &&
    recoveryAction.evidence?.executionReconciliation
  ) {
    if (recoveryAction.evidence.continuationDelivery === "invalidated") {
      projection.cause = "continuation_ownership_changed";
      projection.nextAction =
        "The task was closed or reassigned before delivery. Inspect the current task owner and status.";
      return set("failed", "Continuation cancelled");
    }
    const deliveredRunId = text(recoveryAction.evidence.continuationRunId);
    projection.successorRunId = deliveredRunId;
    projection.cause = null;
    projection.nextAction = deliveredRunId
      ? null
      : "The previous execution is reconciled. Its continuation is queued for delivery.";
    return set(
      deliveredRunId ? "completed" : "queued",
      deliveredRunId ? "Continued in another run" : "Continuation queued",
    );
  }
  if (
    (run.status === "running" &&
      (run.executionControlDeadlineAt || coordinator?.controlDeadlineAt)) ||
    [
      "result_persisted",
      "ready_for_assessment",
      "arbitrating",
      "workspace_pending",
    ].includes(coordinator?.phase ?? "")
  )
    return set("finishing", "Finishing");
  if (successorRunId) return set("completed", "Continued in another run");
  if (run.status === "scheduled_retry" && run.scheduledRetryReason === "ai_connection_busy") {
    projection.nextAction = "Waiting for the AI subscription's current execution to finish; the scheduled check will revalidate access.";
    return set("retry_scheduled", "Waiting for AI subscription");
  }
  if (run.status === "scheduled_retry" && run.scheduledRetryReason === "workspace_busy") {
    projection.nextAction = "Waiting for the live workspace holder to finish; the scheduled check will revalidate ownership.";
    return set("retry_scheduled", "Waiting for workspace");
  }
  // Fork: device, Claude account and account-slot waits, and their deferrals.
  const resourceWait = resourceWaitProjection(run);
  if (resourceWait) {
    projection.nextAction = resourceWait.nextAction;
    return set(resourceWait.phase, resourceWait.label);
  }
  // Cleanup can fail before a finalization coordinator exists. The missing
  // row must not turn a quarantined native session into an ordinary Retry.
  const cleanupQuarantined = run.runtimeMode === "native" &&
    ["failed", "timed_out"].includes(run.status) &&
    run.errorCode === "native_session_cleanup_quarantined";
  if (!cleanupQuarantined && (
    coordinator?.phase === "retryable_failure" ||
    run.status === "scheduled_retry"
  )) {
    projection.recoveryOwner = "agent";
    return set(
      projection.retryAt && new Date(projection.retryAt) > now
        ? "retry_scheduled"
        : "reconnecting",
      projection.retryAt && new Date(projection.retryAt) > now
        ? "Retry scheduled"
        : "Reconnecting",
    );
  }
  if (coordinator?.phase === "terminal_failure" || recoveryAction || cleanupQuarantined) {
    if (
      !cleanupQuarantined &&
      coordinator?.failureCode === "native_provider_terminal_failed" &&
      !detail.replacementDenied &&
      run.finishedAt &&
      now.getTime() - run.finishedAt.getTime() < EXECUTION_CONTROL_DEADLINE_MS
    ) {
      projection.recoveryOwner = "agent";
      projection.nextAction =
        "Checking that the previous provider stopped and its action outcomes are known before continuing.";
      return set("reconnecting", "Checking recovery");
    }
    projection.recoveryOwner = "board";
    projection.cause =
      recoveryAction?.cause ??
      text(detail.replacementDenied) ??
      projection.cause;
    projection.nextAction = recoveryAction?.nextAction ?? projection.nextAction;
    if (cleanupQuarantined && !projection.nextAction) {
      projection.nextAction = "Verify the stopped session and its saved work before starting a new attempt.";
    }
    projection.permittedActions.push("inspect_recovery");
    return set("recovery_needed", "Recovery needed");
  }
  if (run.status === "succeeded") {
    if (pending.length)
      return set(
        pending.some((row) => row.kind === "connection_intent")
          ? "waiting_for_access"
          : "waiting_for_answer",
        pending.some((row) => row.kind === "connection_intent")
          ? "Waiting for access"
          : "Waiting for answer",
      );
    return set("completed", "Completed");
  }
  if (["failed", "cancelled", "timed_out", "interrupted"].includes(run.status))
    return set("failed", run.status === "cancelled" ? "Cancelled" : "Failed");
  if (run.status === "running") {
    const leaseConfirmed =
      coordinator?.phase === "observed" &&
      coordinator.leaseExpiresAt &&
      coordinator.leaseExpiresAt > now;
    let processConfirmed = false;
    if (run.runtimeMode === "legacy" && run.processPid) {
      try {
        process.kill(run.processPid, 0);
        processConfirmed = true;
      } catch {
        /* No execution confirmation. */
      }
    }
    return leaseConfirmed || processConfirmed
      ? set("working", "Working")
      : set("reconnecting", "Confirming execution");
  }
  return projection;
}
