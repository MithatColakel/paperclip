import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  type Db,
  agents,
  aiAccountAgentBindings,
  aiAccountHosts,
  aiAccounts,
  environmentAvailability,
  environments,
  executionWaitSettings,
  heartbeatRuns,
  issues,
  resourceWaitEpisodes,
  resourceWaitNotices,
} from "@paperclipai/db";
import {
  DEFAULT_RESOURCE_WAIT_NOTIFY_HOURS,
  MAX_RESOURCE_WAIT_NOTIFY_HOURS,
  RESOURCE_WAIT_NOTICE_POLICY,
  RESOURCE_WAIT_NOTIFY_HOURS_ENV,
  isResourceWaitReason,
  readResourceWaitContext,
  type DeploymentMode,
  type ExecutionWaitSettings,
  type IssueCommentMetadata,
  type IssueCommentPresentation,
  type ResourceWaitReason,
} from "@paperclipai/shared";
import { logActivity } from "../activity-log.js";
import { deviceForEnvironment, runningPoolAccountsOnDevice } from "../execution-devices.js";
import { agentLinkRow, keyValueRow, runLinkRow, systemNoticePresentation } from "../recovery/notice-format.js";
import { logger } from "../../middleware/logger.js";
import { effectiveAccountOwner, isActiveUserMember } from "./account-plan.js";
import { readRunEnvironmentPolicy, resolveRunEnvironment, type RunEnvironmentPolicy } from "./run-environment.js";
import type { ResourceWaitDeps, ResourceWaitEpisodeRow } from "./types.js";

/**
 * Fork: resource-wait notifications (spec 8). Company-scoped. Every notice,
 * once-only activity entry and PM wake first inserts its key into
 * `resource_wait_notices` (`INSERT … ON CONFLICT DO NOTHING RETURNING`), and
 * only the inserter acts:
 *
 * - `issue:<issueId>:<episodeId>:immediate`: an account reached its limit (once
 *   per episode, so a failed probe or a credit limit after a usage limit never
 *   repeats it); `issue:<issueId>:<episodeId>:immediate:<reason>`: a person has
 *   to act (once per reason, so a wait whose reason changes, e.g. a limit that
 *   turns into a sign-out, names the new fix);
 * - `issue:<issueId>:<episodeId>:long`: a device wait passed the company's
 *   notify-after hours;
 * - `issue:<issueId>:<episodeId>:resolved`: "Started after waiting …", only
 *   for an episode that was notified;
 * - `pm:<pmAgentId>:<kind>:<resourceKey>:<resourceEpisodeKey>`: one PM wake
 *   per resource episode (and per reason a person must act on), without an
 *   issue id (an issue-scoped wake would wait behind the waiting run's issue
 *   lock), skipped when the PM would only wait too: it shares the account or
 *   the unavailable device, or it would need a new slot on a device whose
 *   slots are full.
 *
 * An account's label appears only where its owner is an active member of the
 * company; elsewhere notices say "an account that is no longer available in
 * this company". `stopped` and `auth_unconfirmed` never notify.
 */

type AgentRow = typeof agents.$inferSelect;
type IssueRow = typeof issues.$inferSelect;
type DeviceRow = typeof aiAccountHosts.$inferSelect;
type AccountRow = typeof aiAccounts.$inferSelect;

export const RESOURCE_WAIT_NOTICE_ACTOR_ID = "resource_waits";
export const RESOURCE_WAIT_PM_WAKE_REASON = "resource_wait_notice";
/**
 * Where a PM's summary wake carries its summary. Not `resourceWait`: a lane
 * run keeps its own written-once wait there (spec 7.1), and the summary run
 * may itself wait, or take in a later wake, before the PM reads it.
 */
export const RESOURCE_WAIT_PM_NOTICE_CONTEXT_KEY = "resourceWaitNotice";
const PM_ISSUE_LIMIT = 20;
const HIDDEN_ACCOUNT_TEXT = "an account that is no longer available in this company";

// ---------------------------------------------------------------------------
// Gates and settings
// ---------------------------------------------------------------------------

/** Inserts the key; true only for the caller that inserted it. */
export async function claimResourceWaitNotice(db: Db, companyId: string, noticeKey: string, now: Date = new Date()): Promise<boolean> {
  const rows = await db
    .insert(resourceWaitNotices)
    .values({ companyId, noticeKey, createdAt: now })
    .onConflictDoNothing()
    .returning({ noticeKey: resourceWaitNotices.noticeKey });
  return rows.length > 0;
}

/** Gives a claimed key back after the send failed, so a later pass can retry it. */
export async function releaseResourceWaitNotice(db: Db, companyId: string, noticeKey: string): Promise<void> {
  await db
    .delete(resourceWaitNotices)
    .where(and(eq(resourceWaitNotices.companyId, companyId), eq(resourceWaitNotices.noticeKey, noticeKey)));
}

/** Runs `send` only for the inserter of the key; a failed send releases the key and rethrows. */
async function onceForKey(db: Db, companyId: string, noticeKey: string, now: Date, send: () => Promise<unknown>): Promise<boolean> {
  if (!(await claimResourceWaitNotice(db, companyId, noticeKey, now))) return false;
  try {
    await send();
    return true;
  } catch (error) {
    await releaseResourceWaitNotice(db, companyId, noticeKey).catch(() => undefined);
    throw error;
  }
}

export function issueNoticeKey(issueId: string, episodeId: string, which: "immediate" | "long" | "resolved", reason?: string | null): string {
  return reason ? `issue:${issueId}:${episodeId}:${which}:${reason}` : `issue:${issueId}:${episodeId}:${which}`;
}

function isLimitReason(reason: string): boolean {
  return reason === "usage_limit" || reason === "credit_balance";
}

/** A person must act on this reason: its notices are keyed by it, not just by the episode. */
function isActionReason(reason: string): boolean {
  return !isLimitReason(reason) && RESOURCE_WAIT_NOTICE_POLICY[reason as ResourceWaitReason] === "immediate";
}

/** The immediate notice's key: one per episode for a limit, one per reason otherwise. */
function immediateNoticeKey(issueId: string, episode: Pick<ResourceWaitEpisodeRow, "id" | "reason">): string {
  return issueNoticeKey(issueId, episode.id, "immediate", isActionReason(episode.reason) ? episode.reason : null);
}

export function pmNoticeKey(pmAgentId: string, kind: string, resourceKey: string, resourceEpisodeKey: string): string {
  return `pm:${pmAgentId}:${kind}:${resourceKey}:${resourceEpisodeKey}`;
}

/** `PAPERCLIP_RESOURCE_WAIT_NOTIFY_HOURS` (default 24, 0 never, at most 168). */
export function instanceDefaultNotifyHours(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[RESOURCE_WAIT_NOTIFY_HOURS_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_RESOURCE_WAIT_NOTIFY_HOURS;
  return Math.min(Number(raw), MAX_RESOURCE_WAIT_NOTIFY_HOURS);
}

/** The company's wait-notice settings with defaults applied (no row: instance default hours, device PM off, account PM on). */
export async function readExecutionWaitSettings(
  db: Db,
  companyId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ExecutionWaitSettings> {
  const [row] = await db.select().from(executionWaitSettings).where(eq(executionWaitSettings.companyId, companyId));
  return {
    companyId,
    notifyAfterHours: row?.notifyAfterHours ?? null,
    notifyPmOnDeviceWait: row?.notifyPmOnDeviceWait ?? false,
    notifyPmOnAccountWait: row?.notifyPmOnAccountWait ?? true,
    instanceDefaultHours: instanceDefaultNotifyHours(env),
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

/** Hours before a long device wait notifies; 0 never. */
export function effectiveNotifyHours(settings: Pick<ExecutionWaitSettings, "notifyAfterHours" | "instanceDefaultHours">): number {
  return settings.notifyAfterHours ?? settings.instanceDefaultHours;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** "45 min", "3 h 12 min", "2 d 4 h"; "less than a minute" below one. */
export function formatWaitDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `${days} d ${restHours} h` : `${days} d`;
}

function formatUtc(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const REASON_LABELS: Record<ResourceWaitReason, string> = {
  offline: "offline",
  paused: "paused",
  maintenance: "maintenance",
  updating: "updating",
  unreachable: "unreachable",
  not_allowed: "project not enabled on the device",
  not_serving: "the device does not serve this company",
  stopped: "stopped for this company",
  busy: "busy",
  throttled: "too many connections",
  restarting: "driver restarting",
  plugin_upgrade_pending: "driver upgrade pending",
  other: "unavailable",
  usage_limit: "usage limit",
  credit_balance: "no API credit",
  auth_unconfirmed: "checking its sign-in",
  signed_out: "signed out",
  withdrawn: "switched off",
  unassigned: "no account chosen",
  owner_not_member: "account no longer available",
  reserved_elsewhere: "reserved for other projects",
  device_unknown: "device unknown",
  credential_type_unsupported: "credential type not accepted",
  slots_full: "account slots full",
};

export function resourceWaitReasonLabel(reason: string): string {
  return isResourceWaitReason(reason) ? REASON_LABELS[reason] : "unavailable";
}

/**
 * What a PM's summary wake shows (spec 8). The wake carries no issue id, so
 * heartbeat renders this as the run's task context: what waits, for which
 * resource, that Paperclip resumes it by itself, and what a person can fix.
 * It reads the summary key, not the wake reason: a later wake merged into the
 * queued summary run, or the summary run's own wait, replaces the wake reason.
 * Empty for any other run.
 */
export function resourceWaitPmNoticeMarkdown(context: Record<string, unknown> | null | undefined): string {
  const summary = context?.[RESOURCE_WAIT_PM_NOTICE_CONTEXT_KEY];
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return "";
  const { kind, reason, resourceLabel, resumeAt, issueIds } = summary as Record<string, unknown>;
  const label = typeof resourceLabel === "string" && resourceLabel.trim() ? resourceLabel.trim().slice(0, 120) : null;
  const resource = kind === "ai_account"
    ? label && label !== HIDDEN_ACCOUNT_TEXT ? `the Claude account "${label}"` : `a Claude account that is no longer available in this company`
    : kind === "device_slots"
      ? `a free account slot on the device "${label ?? "unknown"}"`
      : `the device "${label ?? "unknown"}"`;
  const reasonText = typeof reason === "string" ? resourceWaitReasonLabel(reason) : "unavailable";
  const resume = typeof resumeAt === "string" && Number.isFinite(Date.parse(resumeAt))
    ? ` It is expected back at ${formatUtc(new Date(resumeAt))}.`
    : "";
  const ids = Array.isArray(issueIds)
    ? issueIds.filter((id): id is string => typeof id === "string" && id.length > 0).slice(0, PM_ISSUE_LIMIT)
    : [];
  return [
    "Paperclip resource wait notice:",
    `Tasks you are responsible for are waiting for ${resource} (${reasonText}). Paperclip starts them automatically when it is available, and it never moves a task to another Claude account or device.${resume}`,
    ...(ids.length > 0 ? ["", "Waiting tasks:", ...ids.map((id) => `- ${id}`)] : []),
    "",
    "Do not reassign, restart or redo these tasks to work around the wait. If a person has to act (for example replace a signed-out token, choose an account for the agent, allow the project on the device, or move the agent to another device), tell the board what to fix. Otherwise there is nothing to do.",
  ].join("\n");
}

interface NoticeFacts {
  episode: ResourceWaitEpisodeRow;
  agent: AgentRow | null;
  issue: IssueRow | null;
  device: DeviceRow | null;
  environmentName: string | null;
  account: AccountRow | null;
  /** The account's label where its owner is an active member, else null. */
  accountLabel: string | null;
  unavailableSince: Date | null;
  currentRun: { id: string; status: string; contextSnapshot: Record<string, unknown> | null } | null;
}

function deviceText(facts: NoticeFacts): string {
  return facts.device?.name ?? facts.environmentName ?? "the device";
}

function accountText(facts: NoticeFacts): string {
  return facts.accountLabel ? `**${facts.accountLabel}**` : HIDDEN_ACCOUNT_TEXT;
}

function agentText(facts: NoticeFacts): string {
  return facts.agent?.name ? `**${facts.agent.name}**` : "the agent";
}

function driverMessage(facts: NoticeFacts): string | null {
  const context = readResourceWaitContext(facts.currentRun?.contextSnapshot?.resourceWait);
  return context?.reason === facts.episode.reason && context.message ? context.message : null;
}

function immediateBody(facts: NoticeFacts): { title: string; tone: IssueCommentPresentation["tone"]; body: string } {
  const { episode } = facts;
  const device = `**${deviceText(facts)}**`;
  const agent = agentText(facts);
  const resumes = episode.resumeAt
    ? ` Resumes automatically at **${formatUtc(episode.resumeAt)}** (${episode.resumeAtSource === "provider" ? "provider reset" : "estimated"}).`
    : " Resumes automatically when the limit resets.";
  const startsWhenFixed = "This task starts automatically once that is done.";
  switch (episode.reason) {
    case "usage_limit":
      return {
        title: "Waiting for a usage limit to reset",
        tone: "info",
        body: `Waiting for Claude account ${accountText(facts)}: usage limit reached.${resumes} Paperclip never moves a task to another account. The owner can clear the limit after checking.`,
      };
    case "credit_balance":
      return {
        title: "Waiting for API credit",
        tone: "info",
        body: `Waiting for Claude account ${accountText(facts)}: no API credit left.${resumes} Paperclip never moves a task to another account. Add credit, then the owner can clear the limit.`,
      };
    case "signed_out":
      return { title: "Claude account signed out", tone: "warning", body: `Waiting for Claude account ${accountText(facts)}: it is signed out. Its owner must replace the token in Claude accounts, or choose another account for ${agent}. ${startsWhenFixed}` };
    case "withdrawn":
      return { title: "Claude account switched off", tone: "warning", body: `Waiting for Claude account ${accountText(facts)}: it is switched off. Turn it back on in Claude accounts, or choose another account for ${agent}. ${startsWhenFixed}` };
    case "unassigned":
      return { title: "No Claude account chosen", tone: "warning", body: `Waiting for a Claude account: none is chosen for ${agent}. Choose one in Claude accounts, or switch ${agent} to the device's own login. ${startsWhenFixed}` };
    case "owner_not_member":
      return { title: "Claude account not available", tone: "warning", body: `Waiting for a Claude account: ${HIDDEN_ACCOUNT_TEXT}. Choose another account for ${agent}, or add its owner back to this company. ${startsWhenFixed}` };
    case "reserved_elsewhere":
      return { title: "Claude account reserved elsewhere", tone: "warning", body: `Waiting for Claude account ${accountText(facts)}: it is reserved for other projects. Its owner can clear the reservation in Claude accounts, or choose another account for ${agent}. ${startsWhenFixed}` };
    case "device_unknown":
      return { title: "Device unknown", tone: "warning", body: `Waiting for a Claude account: Paperclip cannot tell which device ${agent} runs on, so it cannot check the device's account limit. Pin ${agent} to an environment, or ask an instance admin to map the environment to a device. ${startsWhenFixed}` };
    case "credential_type_unsupported":
      return { title: "Credential type not accepted", tone: "warning", body: `Waiting for a Claude account: device ${device} does not accept this credential type. Choose an account of a type ${device} accepts for ${agent}, or move ${agent} to another device. ${startsWhenFixed}` };
    case "not_allowed":
      return { title: "Project not enabled on the device", tone: "warning", body: `Waiting for device ${device}: this project is not enabled there. ${driverMessage(facts) ?? `Enable this project for this company on ${device}, or move ${agent} to another device.`} This task starts automatically once it is enabled.` };
    case "not_serving":
      return { title: "Device does not serve this company", tone: "warning", body: `Waiting for device ${device}: it does not serve this company. ${driverMessage(facts) ?? `Add its owner to this company, or move ${agent} to another device.`} This task starts automatically once it does.` };
    case "slots_full":
      return { title: "Waiting for an account slot", tone: "warning", body: `Waiting for an account slot on ${device}: it already runs its maximum of Claude accounts. This task starts automatically when one is free; to avoid the wait, choose an account already running on ${device} for ${agent}.` };
    default:
      return { title: "Waiting", tone: "info", body: `Waiting for ${device} (${resourceWaitReasonLabel(episode.reason)}). This task starts automatically when it is available.` };
  }
}

function noticeMetadata(facts: NoticeFacts, rows: Array<ReturnType<typeof keyValueRow>>): IssueCommentMetadata {
  const waitRows = [
    keyValueRow("Reason", resourceWaitReasonLabel(facts.episode.reason)),
    keyValueRow("Waiting since", formatUtc(facts.episode.since)),
    ...rows,
    ...(facts.agent ? [agentLinkRow("Agent", facts.agent)] : []),
    ...(facts.currentRun ? [runLinkRow("Waiting run", { id: facts.currentRun.id, status: facts.currentRun.status, agentId: facts.episode.agentId })] : []),
  ];
  return { version: 1, sections: [{ title: "Resource wait", rows: waitRows }] };
}

// ---------------------------------------------------------------------------
// Facts and keys
// ---------------------------------------------------------------------------

async function loadFacts(db: Db, episode: ResourceWaitEpisodeRow, deploymentMode?: DeploymentMode): Promise<NoticeFacts> {
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, episode.agentId), eq(agents.companyId, episode.companyId)));
  const [issue] = episode.issueId
    ? await db.select().from(issues).where(and(eq(issues.id, episode.issueId), eq(issues.companyId, episode.companyId)))
    : [];
  const [device] = episode.deviceId ? await db.select().from(aiAccountHosts).where(eq(aiAccountHosts.id, episode.deviceId)) : [];
  const [environment] = episode.environmentId
    ? await db.select({ name: environments.name }).from(environments).where(eq(environments.id, episode.environmentId))
    : [];
  const [account] = episode.accountId ? await db.select().from(aiAccounts).where(eq(aiAccounts.id, episode.accountId)) : [];
  const ownerIsMember = account
    ? await isActiveUserMember(db, episode.companyId, effectiveAccountOwner(account), deploymentMode)
    : false;
  const [registry] = episode.environmentId
    ? await db.select({ unavailableSince: environmentAvailability.unavailableSince, state: environmentAvailability.state })
      .from(environmentAvailability).where(eq(environmentAvailability.environmentId, episode.environmentId))
    : [];
  const [currentRun] = episode.currentRunId
    ? await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns).where(and(eq(heartbeatRuns.id, episode.currentRunId), eq(heartbeatRuns.companyId, episode.companyId)))
    : [];
  return {
    episode,
    agent: agent ?? null,
    issue: issue ?? null,
    device: device ?? null,
    environmentName: environment?.name ?? null,
    account: account ?? null,
    accountLabel: account && ownerIsMember && episode.reason !== "owner_not_member" ? account.label : null,
    unavailableSince: registry?.state === "unavailable" ? registry.unavailableSince ?? null : null,
    currentRun: currentRun ?? null,
  };
}

interface ResourceEpisodeFacts {
  episode: Pick<ResourceWaitEpisodeRow, "kind" | "reason" | "scope" | "since">;
  limitEpisodeStartedAt: Date | null;
  overLimitAt: Date | null;
  unavailableSince: Date | null;
}

function resourceEpisodeKeyOf(facts: ResourceEpisodeFacts): string {
  const { episode } = facts;
  const since = episode.since.toISOString();
  if (episode.reason === "usage_limit" || episode.reason === "credit_balance") {
    return facts.limitEpisodeStartedAt?.toISOString() ?? since;
  }
  if (episode.kind === "environment" && episode.scope === "target") return facts.unavailableSince?.toISOString() ?? since;
  if (episode.reason === "slots_full") return facts.overLimitAt?.toISOString() ?? since;
  // One per reason a person must act on: a sign-out after a withdrawal is a new fix.
  return isActionReason(episode.reason) ? `${since}:${episode.reason}` : since;
}

function resourceEpisodeKeyFromFacts(facts: NoticeFacts): string {
  return resourceEpisodeKeyOf({
    episode: facts.episode,
    limitEpisodeStartedAt: facts.account?.limitEpisodeStartedAt ?? null,
    overLimitAt: facts.device?.overLimitAt ?? null,
    unavailableSince: facts.unavailableSince,
  });
}

/**
 * The resource episode an episode belongs to (spec 8): the account's limit
 * episode for limits, the registry's outage for target waits, the device's
 * over-limit time for slot waits, else the episode's own start. PM wakes and
 * inbox items key on it, so one outage yields one of each.
 */
export async function resourceEpisodeKeys(db: Db, episodes: readonly ResourceWaitEpisodeRow[]): Promise<Map<string, string>> {
  const accountIds = [...new Set(episodes.map((episode) => episode.accountId).filter((id): id is string => Boolean(id)))];
  const deviceIds = [...new Set(episodes.map((episode) => episode.deviceId).filter((id): id is string => Boolean(id)))];
  const environmentIds = [...new Set(episodes.map((episode) => episode.environmentId).filter((id): id is string => Boolean(id)))];
  const accounts = new Map((accountIds.length > 0
    ? await db.select({ id: aiAccounts.id, limitEpisodeStartedAt: aiAccounts.limitEpisodeStartedAt }).from(aiAccounts).where(inArray(aiAccounts.id, accountIds))
    : []).map((row) => [row.id, row]));
  const devices = new Map((deviceIds.length > 0
    ? await db.select({ id: aiAccountHosts.id, overLimitAt: aiAccountHosts.overLimitAt }).from(aiAccountHosts).where(inArray(aiAccountHosts.id, deviceIds))
    : []).map((row) => [row.id, row]));
  const registry = new Map((environmentIds.length > 0
    ? await db.select({ environmentId: environmentAvailability.environmentId, state: environmentAvailability.state, unavailableSince: environmentAvailability.unavailableSince })
      .from(environmentAvailability).where(inArray(environmentAvailability.environmentId, environmentIds))
    : []).map((row) => [row.environmentId, row]));
  const keys = new Map<string, string>();
  for (const episode of episodes) {
    const row = episode.environmentId ? registry.get(episode.environmentId) : undefined;
    keys.set(episode.id, resourceEpisodeKeyOf({
      episode,
      limitEpisodeStartedAt: (episode.accountId ? accounts.get(episode.accountId)?.limitEpisodeStartedAt : null) ?? null,
      overLimitAt: (episode.deviceId ? devices.get(episode.deviceId)?.overLimitAt : null) ?? null,
      unavailableSince: row?.state === "unavailable" ? row.unavailableSince ?? null : null,
    }));
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Notifier
// ---------------------------------------------------------------------------

export interface ResourceWaitNotifierOptions {
  db: Db;
  deps: Pick<ResourceWaitDeps, "addIssueSystemNotice" | "enqueueWakeup">;
  deploymentMode?: DeploymentMode;
  env?: NodeJS.ProcessEnv;
}

const LIVE_RUN_STATUSES = new Set(["scheduled_retry", "queued", "running"]);

export function createResourceWaitNotifier(options: ResourceWaitNotifierOptions) {
  const { db, deps, deploymentMode } = options;
  const env = options.env ?? process.env;

  async function activity(facts: NoticeFacts, action: string, runId: string | null, details: Record<string, unknown>) {
    const { episode } = facts;
    await logActivity(db, {
      companyId: episode.companyId,
      actorType: "system",
      actorId: RESOURCE_WAIT_NOTICE_ACTOR_ID,
      action,
      entityType: episode.issueId ? "issue" : "agent",
      entityId: episode.issueId ?? episode.agentId,
      agentId: episode.agentId,
      runId,
      details: { episodeId: episode.id, kind: episode.kind, reason: episode.reason, scope: episode.scope, ...details },
    });
  }

  /** The PM (spec 8): the issue's creator agent when it is not the assignee, else the agent's manager. */
  async function pmOf(facts: NoticeFacts): Promise<AgentRow | null> {
    const waitingAgentId = facts.episode.agentId;
    const creator = facts.issue?.createdByAgentId ?? null;
    const pmId = creator && creator !== waitingAgentId ? creator : facts.agent?.reportsTo ?? null;
    if (!pmId || pmId === waitingAgentId) return null;
    const [pm] = await db.select().from(agents).where(and(eq(agents.id, pmId), eq(agents.companyId, facts.episode.companyId)));
    return pm && pm.status !== "terminated" ? pm : null;
  }

  /**
   * A PM that would only wait too is skipped: one bound to the same account,
   * one on the same unavailable device, or, for full slots, one that would
   * need a new slot on that device (a PM on the device's own login, or with
   * an account already running there, is not blocked by full slots).
   */
  async function pmSharesResource(pm: AgentRow, facts: NoticeFacts, policy: RunEnvironmentPolicy): Promise<boolean> {
    const { episode } = facts;
    const bindingOfPm = async () => {
      const [binding] = await db
        .select({ mode: aiAccountAgentBindings.mode, accountId: aiAccountAgentBindings.accountId })
        .from(aiAccountAgentBindings)
        .where(eq(aiAccountAgentBindings.agentId, pm.id));
      return binding ?? null;
    };
    if (episode.kind === "ai_account") {
      if (!episode.accountId) return false;
      const binding = await bindingOfPm();
      return binding?.mode === "pool_account" && binding.accountId === episode.accountId;
    }
    const resolved = await resolveRunEnvironment(db, { companyId: pm.companyId, agent: pm }, policy).catch(() => null);
    if (!resolved) return false;
    if (episode.kind === "device_slots") {
      if (!episode.deviceId) return false;
      const device = await deviceForEnvironment(db, resolved.environment, { create: false }).catch(() => null);
      if (device?.id !== episode.deviceId) return false;
      const binding = await bindingOfPm();
      if (binding?.mode !== "pool_account" || !binding.accountId) return false;
      return !(await runningPoolAccountsOnDevice(db, episode.deviceId)).has(binding.accountId);
    }
    if (episode.environmentId && resolved.environment.id === episode.environmentId) return true;
    if (!episode.deviceId) return false;
    const device = await deviceForEnvironment(db, resolved.environment, { create: false }).catch(() => null);
    return device?.id === episode.deviceId;
  }

  async function wakePm(facts: NoticeFacts, now: Date): Promise<boolean> {
    const pm = await pmOf(facts);
    if (!pm) return false;
    const policy = await readRunEnvironmentPolicy(db);
    if (await pmSharesResource(pm, facts, policy)) return false;
    const { episode } = facts;
    const key = pmNoticeKey(pm.id, episode.kind, episode.resourceKey, resourceEpisodeKeyFromFacts(facts));
    return onceForKey(db, episode.companyId, key, now, async () => {
      const waiting = await db
        .select({ issueId: resourceWaitEpisodes.issueId })
        .from(resourceWaitEpisodes)
        .where(and(
          eq(resourceWaitEpisodes.companyId, episode.companyId),
          eq(resourceWaitEpisodes.resourceKey, episode.resourceKey),
          isNull(resourceWaitEpisodes.resolvedAt),
          isNotNull(resourceWaitEpisodes.issueId),
        ))
        .orderBy(asc(resourceWaitEpisodes.since))
        .limit(PM_ISSUE_LIMIT);
      const resourceLabel = episode.kind === "ai_account"
        ? facts.accountLabel ?? HIDDEN_ACCOUNT_TEXT
        : deviceText(facts);
      await deps.enqueueWakeup(pm.id, {
        source: "automation",
        triggerDetail: "system",
        reason: RESOURCE_WAIT_PM_WAKE_REASON,
        // No issue id: an issue-scoped wake would queue behind the waiting run's issue lock.
        payload: null,
        requestedByActorType: "system",
        requestedByActorId: null,
        // Its own run: merged into a turn already running, the PM would never see it, and
        // merged into the PM's own waiting run, it would change that run's wait.
        allowRunCoalescing: false,
        contextSnapshot: {
          wakeReason: RESOURCE_WAIT_PM_WAKE_REASON,
          [RESOURCE_WAIT_PM_NOTICE_CONTEXT_KEY]: {
            kind: episode.kind,
            reason: episode.reason,
            resourceLabel,
            resumeAt: episode.resumeAt ? episode.resumeAt.toISOString() : null,
            issueIds: waiting.map((row) => row.issueId).filter((id): id is string => Boolean(id)),
          },
        },
      });
    });
  }

  function isLive(facts: NoticeFacts): boolean {
    return Boolean(facts.currentRun && LIVE_RUN_STATUSES.has(facts.currentRun.status));
  }

  /**
   * The immediate notice of an episode whose reason has one: the issue notice
   * once per episode for a limit and once per reason otherwise, and the PM
   * wake when the company's account-wait setting is on (it also covers
   * not_allowed, not_serving and slots_full).
   */
  async function notifyImmediate(episode: ResourceWaitEpisodeRow, now: Date = new Date()): Promise<{ issueNotice: boolean; pmWake: boolean }> {
    const none = { issueNotice: false, pmWake: false };
    if (episode.resolvedAt || RESOURCE_WAIT_NOTICE_POLICY[episode.reason as ResourceWaitReason] !== "immediate") return none;
    const facts = await loadFacts(db, episode, deploymentMode);
    if (!isLive(facts)) return none;
    const issueId = episode.issueId;
    const issueNotice = issueId
      ? await onceForKey(db, episode.companyId, immediateNoticeKey(issueId, episode), now, () => {
        const text = immediateBody(facts);
        return deps.addIssueSystemNotice({
          companyId: episode.companyId,
          issueId,
          body: text.body,
          presentation: systemNoticePresentation({ tone: text.tone, title: text.title }),
          metadata: noticeMetadata(facts, episode.resumeAt ? [keyValueRow("Resumes at", formatUtc(episode.resumeAt))] : []),
        });
      })
      : false;
    await db.update(resourceWaitEpisodes).set({ notifiedAt: now, updatedAt: now })
      .where(and(eq(resourceWaitEpisodes.id, episode.id), isNull(resourceWaitEpisodes.notifiedAt)));
    const settings = await readExecutionWaitSettings(db, episode.companyId, env);
    const pmWake = settings.notifyPmOnAccountWait ? await wakePm(facts, now) : false;
    return { issueNotice, pmWake };
  }

  /** The long-wait notice of a device wait older than the company's notify-after hours. */
  async function notifyLong(episode: ResourceWaitEpisodeRow, now: Date = new Date()): Promise<{ issueNotice: boolean; pmWake: boolean }> {
    const none = { issueNotice: false, pmWake: false };
    if (episode.resolvedAt || episode.longNotifiedAt) return none;
    if (RESOURCE_WAIT_NOTICE_POLICY[episode.reason as ResourceWaitReason] !== "after_threshold") return none;
    const settings = await readExecutionWaitSettings(db, episode.companyId, env);
    const hours = effectiveNotifyHours(settings);
    if (hours <= 0 || now.getTime() - episode.since.getTime() < hours * 3_600_000) return none;
    const facts = await loadFacts(db, episode, deploymentMode);
    if (!isLive(facts)) return none;
    const issueId = episode.issueId;
    const issueNotice = issueId
      ? await onceForKey(db, episode.companyId, issueNoticeKey(issueId, episode.id, "long"), now, () => {
        const device = deviceText(facts);
        return deps.addIssueSystemNotice({
          companyId: episode.companyId,
          issueId,
          body: `This task has been waiting for device **${device}** for **${formatWaitDuration(now.getTime() - episode.since.getTime())}** (${resourceWaitReasonLabel(episode.reason)}). It starts automatically when ${device} is available. To run it elsewhere, move ${agentText(facts)} to another device.`,
          presentation: systemNoticePresentation({ tone: "warning", title: "Long wait for a device" }),
          metadata: noticeMetadata(facts, []),
        });
      })
      : false;
    const marked = await db.update(resourceWaitEpisodes).set({ longNotifiedAt: now, updatedAt: now })
      .where(and(eq(resourceWaitEpisodes.id, episode.id), isNull(resourceWaitEpisodes.longNotifiedAt)))
      .returning({ id: resourceWaitEpisodes.id });
    if (marked.length === 0) return { issueNotice, pmWake: false };
    await activity(facts, "resource_wait.long_wait_notified", episode.currentRunId, { hours });
    const pmWake = settings.notifyPmOnDeviceWait ? await wakePm(facts, now) : false;
    return { issueNotice, pmWake };
  }

  /** "Started after waiting …" for a resolved episode that was notified, once. */
  async function notifyResolved(episode: ResourceWaitEpisodeRow, now: Date = new Date()): Promise<boolean> {
    const issueId = episode.issueId;
    if (episode.resolution !== "resolved" || !issueId) return false;
    if (!episode.notifiedAt && !episode.longNotifiedAt) return false;
    const facts = await loadFacts(db, episode, deploymentMode);
    const waited = (episode.resolvedAt ?? now).getTime() - episode.since.getTime();
    const sent = await onceForKey(db, episode.companyId, issueNoticeKey(issueId, episode.id, "resolved"), now, () =>
      deps.addIssueSystemNotice({
        companyId: episode.companyId,
        issueId,
        body: `Started after waiting ${formatWaitDuration(waited)}.`,
        presentation: systemNoticePresentation({ tone: "success", title: "Wait ended" }),
        metadata: noticeMetadata(facts, []),
      }));
    if (sent) {
      await db.update(resourceWaitEpisodes).set({ resolvedNotifiedAt: now, updatedAt: now }).where(eq(resourceWaitEpisodes.id, episode.id));
    }
    return sent;
  }

  /** `resource_wait.started`, once per episode. */
  async function logStarted(episode: ResourceWaitEpisodeRow, runId: string | null, now: Date = new Date()): Promise<void> {
    const facts = await loadFacts(db, episode, deploymentMode);
    await onceForKey(db, episode.companyId, `activity:${episode.id}:started`, now, () => activity(facts, "resource_wait.started", runId, {
      ...(facts.device ? { deviceName: facts.device.name } : {}),
      ...(facts.accountLabel ? { accountLabel: facts.accountLabel } : {}),
    }));
  }

  /** `resource_wait.resolved` for the call that resolved the episode. */
  async function logResolved(episode: ResourceWaitEpisodeRow, runId: string | null): Promise<void> {
    const facts = await loadFacts(db, episode, deploymentMode);
    await activity(facts, "resource_wait.resolved", runId, {
      waitedMs: Math.max(0, (episode.resolvedAt ?? new Date()).getTime() - episode.since.getTime()),
    });
  }

  /**
   * The sweep's notify pass: immediate notices that did not go out at
   * deferral time, and long-wait notices that came due. Bounded per pass.
   */
  async function runNotifyPass(input: { now?: Date; limit?: number } = {}): Promise<{ immediate: number; long: number }> {
    const now = input.now ?? new Date();
    const limit = Math.max(1, input.limit ?? 100);
    const immediateReasons = Object.entries(RESOURCE_WAIT_NOTICE_POLICY).filter(([, policy]) => policy === "immediate").map(([reason]) => reason);
    const longReasons = Object.entries(RESOURCE_WAIT_NOTICE_POLICY).filter(([, policy]) => policy === "after_threshold").map(([reason]) => reason);
    const liveCurrentRun = sql`exists (
      select 1 from ${heartbeatRuns}
      where ${heartbeatRuns.id} = ${resourceWaitEpisodes.currentRunId}
        and ${heartbeatRuns.status} in ('scheduled_retry', 'queued', 'running')
    )`;
    const pendingImmediate = await db.select().from(resourceWaitEpisodes).where(and(
      isNull(resourceWaitEpisodes.resolvedAt),
      isNull(resourceWaitEpisodes.notifiedAt),
      inArray(resourceWaitEpisodes.reason, immediateReasons),
      isNotNull(resourceWaitEpisodes.currentRunId),
      liveCurrentRun,
    )).orderBy(asc(resourceWaitEpisodes.since)).limit(limit);
    let immediate = 0;
    for (const episode of pendingImmediate) {
      try {
        if ((await notifyImmediate(episode, now)).issueNotice) immediate += 1;
      } catch (error) {
        logger.warn({ err: error, episodeId: episode.id }, "resource wait immediate notice failed");
      }
    }
    // Only episodes past their company's threshold (never with 0 hours) whose
    // run still waits, so episodes that are not due never crowd out due ones.
    const notifyHours = sql`coalesce(${executionWaitSettings.notifyAfterHours}, ${instanceDefaultNotifyHours(env)}::int)`;
    const pendingLong = await db
      .select({ episode: resourceWaitEpisodes })
      .from(resourceWaitEpisodes)
      .leftJoin(executionWaitSettings, eq(executionWaitSettings.companyId, resourceWaitEpisodes.companyId))
      .where(and(
        isNull(resourceWaitEpisodes.resolvedAt),
        isNull(resourceWaitEpisodes.longNotifiedAt),
        inArray(resourceWaitEpisodes.reason, longReasons),
        sql`${notifyHours} > 0`,
        sql`${resourceWaitEpisodes.since} <= ${now.toISOString()}::timestamptz - make_interval(hours => ${notifyHours})`,
        liveCurrentRun,
      ))
      .orderBy(asc(resourceWaitEpisodes.since))
      .limit(limit)
      .then((rows) => rows.map((row) => row.episode));
    let long = 0;
    for (const episode of pendingLong) {
      try {
        if ((await notifyLong(episode, now)).issueNotice) long += 1;
      } catch (error) {
        logger.warn({ err: error, episodeId: episode.id }, "resource wait long-wait notice failed");
      }
    }
    return { immediate, long };
  }

  return { notifyImmediate, notifyLong, notifyResolved, logStarted, logResolved, runNotifyPass, wakePm: async (episode: ResourceWaitEpisodeRow, now: Date = new Date()) => wakePm(await loadFacts(db, episode, deploymentMode), now) };
}

export type ResourceWaitNotifier = ReturnType<typeof createResourceWaitNotifier>;
