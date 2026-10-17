import type { Db } from "@paperclipai/db";
import type { DeploymentMode } from "@paperclipai/shared";
import { resolveDeploymentMode } from "../../config-file.js";
import { logger } from "../../middleware/logger.js";
import type { PluginWorkerManager } from "../plugin-worker-manager.js";
import { environmentWaitsEnabled as readEnvironmentWaitsEnabled } from "./classify.js";
import { createCheckNow } from "./check-now.js";
import { createDeferral } from "./deferral.js";
import { createEpisodeEnd } from "./episode-end.js";
import { readWakeEpochs } from "./epochs.js";
import { createHold } from "./hold.js";
import { createResourceWaitNotifier } from "./notify.js";
import { createPreflight } from "./preflight.js";
import { createSweep } from "./sweep.js";
import type { ResourceWaitDeps, WakeEpochRefs } from "./types.js";
import { wakeResourceWaits, type ResourceWaitWakeFilter, type ResourceWaitWakeOptions } from "./wake.js";

/**
 * Fork: the resource-wait module (spec 6.3, 7 and 8): a run whose execution
 * device, Claude account or device account slots are unavailable waits
 * instead of failing, resumes by itself, and the board hears about it.
 * Paperclip never moves a task to another account or device.
 *
 * `createResourceWaits({ db, pluginWorkerManager, deps, now })` is built once
 * by heartbeat (W8), which injects its own closures as `deps`. Hooks:
 *
 * - H2 `preflightEnvironment` after environment resolution;
 * - H4 `toDeferral` in the lease catch, `noteAcquired` after a lease;
 * - `noteRunPassed` after credentials (account and slot waits), after the
 *   lease (every wait) and, from the account's success hook (H14), after a
 *   pool run succeeded (`succeeded`: the only step that ends a limit probe's
 *   wait);
 * - H5 `finalizeDeferral` in the executeRun outer catch;
 * - H11 `holdDueWaits` first inside `promoteDueScheduledRetries`;
 * - `sweepResourceWaits` as a scheduler job;
 * - H15 `checkRunNow` for retry-now on a lane run and for comments;
 * - `noteRunRefused` when a waiting run turns into a configuration refusal;
 * - `scheduleResourceWait` for waits that start after a run ended (limits and
 *   sign-in failures, spec 4.6).
 *
 * Standalone helpers that need no heartbeat closures (`wakeResourceWaits`,
 * `readScheduledRetryResourceWaits`, `evaluateAccountPlan`, …) are exported
 * from this file too, for routes and services outside heartbeat.
 */

export interface CreateResourceWaitsOptions {
  db: Db;
  pluginWorkerManager?: PluginWorkerManager | null;
  deps: ResourceWaitDeps;
  /** The clock (tests pass a fixed one). */
  now?: () => Date;
  random?: () => number;
  /**
   * In `local_trusted` the local board user counts as a member of every
   * company. Defaults to the server's configured deployment mode.
   */
  deploymentMode?: DeploymentMode;
  /** The kill switch; defaults to `PAPERCLIP_ENVIRONMENT_WAITS` (read once). */
  environmentWaitsEnabled?: boolean;
  /** Environment for `PAPERCLIP_RESOURCE_WAIT_NOTIFY_HOURS` and the kill switch. */
  env?: NodeJS.ProcessEnv;
}

function configuredDeploymentMode(): DeploymentMode | undefined {
  try {
    return resolveDeploymentMode();
  } catch (error) {
    logger.warn({ err: error }, "resource waits could not read the deployment mode; treating the local board user as a non-member");
    return undefined;
  }
}

export function createResourceWaits(options: CreateResourceWaitsOptions) {
  const { db, deps } = options;
  const env = options.env ?? process.env;
  const clock = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const environmentWaitsEnabled = options.environmentWaitsEnabled ?? readEnvironmentWaitsEnabled(env);
  const deploymentMode = options.deploymentMode ?? configuredDeploymentMode();

  const notifier = createResourceWaitNotifier({ db, deps, deploymentMode, env });
  // An ended episode: registry cleanup, and the issue's other waits that named it.
  const onEpisodeEnded = createEpisodeEnd({ db, deps, notifier, clock });
  const deferral = createDeferral({ db, deps, notifier, clock, random, onEpisodeEnded });
  const preflight = createPreflight({ db, deps, notifier, clock, random, environmentWaitsEnabled, onEpisodeEnded });
  const hold = createHold({ db, deps, clock, random, environmentWaitsEnabled, deploymentMode, onEpisodeEnded });
  const sweep = createSweep({ db, pluginWorkerManager: options.pluginWorkerManager, notifier, clock, random, environmentWaitsEnabled, onEpisodeEnded });
  const checkNow = createCheckNow({ db, clock, hold, sweep });

  return {
    /** False while the environment-wait kill switch is set. */
    environmentWaitsEnabled,
    // Run path.
    preflightEnvironment: preflight.preflightEnvironment,
    toDeferral: preflight.toDeferral,
    noteAcquired: preflight.noteAcquired,
    noteRunPassed: preflight.noteRunPassed,
    noteRunRefused: preflight.noteRunRefused,
    finalizeDeferral: deferral.finalizeDeferral,
    scheduleResourceWait: deferral.scheduleResourceWait,
    readWakeEpochs: (refs: WakeEpochRefs) => readWakeEpochs(db, refs),
    // Holding, waking and sweeping.
    holdDueWaits: hold.holdDueWaits,
    wakeResourceWaits: (filter: ResourceWaitWakeFilter, wakeOptions?: ResourceWaitWakeOptions) =>
      wakeResourceWaits(db, filter, { now: clock(), ...wakeOptions }),
    sweepResourceWaits: sweep.sweepResourceWaits,
    checkEnvironment: sweep.checkEnvironment,
    // Check now.
    checkRunNow: checkNow.checkRunNow,
    checkEnvironmentsNow: checkNow.checkEnvironmentsNow,
    checkDeviceNow: checkNow.checkDeviceNow,
    // Notices.
    notifier,
  };
}

export type ResourceWaits = ReturnType<typeof createResourceWaits>;

export {
  ConfigurationRefusal,
  RESOURCE_WAIT_TIMINGS,
  ResourceWaitDeferral,
  accountWaitDeferral,
  deviceSlotsDeferral,
  environmentWaitDeferral,
  isConfigurationRefusal,
  isResourceWaitDeferral,
} from "./types.js";
export type {
  GateDecision,
  ResourceWaitDeps,
  ResourceWaitEpisodeRow,
  ResourceWaitIssueNotice,
  ResourceWaitScheduleOptions,
  ResourceWaitScheduleOutcome,
  ResourceWaitTarget,
  ResourceWaitWakeupOptions,
  WakeEpochRefs,
  WakeEpochSnapshot,
} from "./types.js";
export {
  ENVIRONMENT_WAITS_ENV,
  classifyEnvironmentError,
  classifySshFailure,
  classifySshStderr,
  environmentWaitsEnabled,
  isSshConfigurationFailure,
  type EnvironmentErrorClassification,
  type SshFailureClass,
} from "./classify.js";
export {
  readRunEnvironmentPolicy,
  resolveRunEnvironment,
  type ResolvedRunEnvironment,
  type RunEnvironmentInput,
  type RunEnvironmentPolicy,
} from "./run-environment.js";
export {
  adoptEpisode,
  chainOfRun,
  coWaiterOf,
  episodeForRun,
  getEpisode,
  handOverOrAbandon,
  needsNewImmediateNotice,
  openEpisode,
  openEpisodeForChain,
  resolveEpisode,
  resourceKeyOf,
  restoreEpisodeCurrentRun,
  sameResource,
  setEpisodeCurrentRun,
  type EpisodeChain,
  type EpisodeDeferringRun,
  type OpenEpisodeResult,
} from "./episodes.js";
export { mergeWakeEpochs, readWakeEpochs, wakeEpochsMoved } from "./epochs.js";
export {
  evaluateAccountPlan,
  effectiveAccountOwner,
  isActiveUserMember,
  type AccountPlanEvaluation,
} from "./account-plan.js";
export {
  FAILURE_RETRIES_BEFORE_RESOURCE_WAIT_KEY,
  deferredWhileAssignee,
  describeWaitShort,
  firstHoldMs,
  isAdmissionWait,
  resourceWaitContextFor,
  resourceWaitJitterMs,
  waitDelayMs,
  type EpisodeEndedHandler,
  type ScheduleResourceWaitInput,
  type ScheduleResourceWaitResult,
} from "./deferral.js";
export { createEpisodeEnd } from "./episode-end.js";
export type { PreflightResult, RunEnvironmentRef } from "./preflight.js";
export { claimAccountProbe, type HoldPassResult, type ProceedDecision, type RunWait } from "./hold.js";
export {
  environmentIdsForPlugin,
  wakeResourceWaits,
  type ResourceWaitWakeFilter,
  type ResourceWaitWakeOptions,
  type ResourceWaitWakeResult,
} from "./wake.js";
export { checkTargetAvailability, type TargetAvailabilityCheck } from "./plugin-check.js";
export {
  RESOURCE_WAIT_SWEEP_LOCK_KEY,
  type EnvironmentCheckResult,
  type SweepPassResult,
} from "./sweep.js";
export {
  acquireCheckNowSlot,
  checkNowRateLimitedError,
  readScheduledRetryResourceWaits,
  resourceStillUnavailableError,
  resourceWaitHoldsForIssues,
  type CheckNowSource,
  type CheckRunNowResult,
} from "./check-now.js";
export {
  RESOURCE_WAIT_NOTICE_ACTOR_ID,
  RESOURCE_WAIT_PM_NOTICE_CONTEXT_KEY,
  RESOURCE_WAIT_PM_WAKE_REASON,
  claimResourceWaitNotice,
  createResourceWaitNotifier,
  effectiveNotifyHours,
  formatWaitDuration,
  instanceDefaultNotifyHours,
  issueNoticeKey,
  pmNoticeKey,
  readExecutionWaitSettings,
  releaseResourceWaitNotice,
  resourceEpisodeKeys,
  resourceWaitPmNoticeMarkdown,
  resourceWaitReasonLabel,
  type ResourceWaitNotifier,
} from "./notify.js";
