import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  type Db,
  agents,
  aiAccountHosts,
  aiAccounts,
  companies,
  companyMemberships,
  environmentAvailability,
  environments,
  executionWaitSettings,
  heartbeatRuns,
  issues,
  projectWorkspaces,
  projects,
  resourceWaitEpisodes,
} from "@paperclipai/db";
import {
  RESOURCE_WAIT_NOTICE_POLICY,
  deriveProjectUrlKey,
  isResourceWaitReason,
  type AttentionDecisionVerb,
  type AttentionItemDetail,
  type AttentionProjectRef,
  type AttentionSeverity,
  type AttentionSubject,
  type AttentionWorkspaceRef,
  type DeploymentMode,
  type ResourceWaitReason,
} from "@paperclipai/shared";
import { resolveDeploymentMode } from "../config-file.js";
import { logger } from "../middleware/logger.js";
import { capOf, type DeviceLimitCheck } from "./execution-devices.js";
import {
  claimResourceWaitNotice,
  formatWaitDuration,
  instanceDefaultNotifyHours,
  resourceEpisodeKeyOf,
  resourceWaitReasonLabel,
} from "./resource-waits/notify.js";

/**
 * Fork: inbox items for tasks that wait for a device, a Claude account or an
 * account slot (spec 8), and the immediate admin notice of a device flagged
 * over its account limit (spec 5.6). Source kind `resource_wait_alert`.
 *
 * Items are derived on every read from the company's open wait episodes, with
 * one query per company. Episodes of one resource episode (spec 8: an
 * account's limit episode, a target outage, a device's over-limit time, else
 * the episode itself, per reason a person must act on) share one item, keyed
 * by `resourceEpisodeKeyOf`, so a failed probe, a replacement run or a second
 * waiting task never adds a row. Skipped: episodes whose current run is no
 * longer live (the issue gate cancelled it), episodes of closed or hidden
 * tasks, reasons that never notify (`stopped`, `auth_unconfirmed`), and
 * device outages younger than the company's notify-after hours. An item
 * disappears when its episodes resolve. No board recovery action is ever
 * created, and an account's label appears only where its owner is an active
 * member of the company.
 */

/** What attention.ts's `createItem` takes for one resource-wait item. */
export interface ResourceWaitAttentionInput {
  companyId: string;
  sourceKind: "resource_wait_alert";
  subject: AttentionSubject;
  whyNow: string;
  decisionVerbs: AttentionDecisionVerb[];
  inlineResolvable: boolean;
  entryRule: string;
  exitRule: string;
  dedupKey: string;
  severity: AttentionSeverity;
  activityAt: string;
  createdAt: string;
  updatedAt: string;
  relatedIssue: AttentionSubject | null;
  project: AttentionProjectRef | null;
  workspace: AttentionWorkspaceRef | null;
  detail: AttentionItemDetail | null;
}

/** `resource_wait_notices` keys of the over-limit notice (spec 5.6), one per company and flag. */
export const DEVICE_OVER_LIMIT_NOTICE_PREFIX = "device-over-limit:";
const LOCAL_BOARD_USER_ID = "local-board";
const LIVE_RUN_STATUSES: ReadonlySet<string> = new Set(["scheduled_retry", "queued", "running"]);
const CLOSED_ISSUE_STATUSES: ReadonlySet<string> = new Set(["done", "cancelled"]);
const ISSUE_ID_LIMIT = 20;

export function deviceOverLimitNoticeKey(deviceId: string, overLimitAt: Date): string {
  return `${DEVICE_OVER_LIMIT_NOTICE_PREFIX}${deviceId}:${overLimitAt.getTime()}`;
}

/**
 * The immediate admin notice of spec 5.6, called when `recheckDeviceLimits`
 * (or a link-target merge) flags a device: each affected company is noted
 * once for this flag, and its inbox shows the item for as long as the device
 * keeps the flag. Returns the companies noted now; never throws.
 */
export async function noteDeviceOverLimit(
  db: Db,
  check: Pick<DeviceLimitCheck, "deviceId" | "change" | "overLimitAt" | "companyIds">,
  now: Date = new Date(),
): Promise<string[]> {
  if (check.change !== "flagged" || !check.overLimitAt) return [];
  const key = deviceOverLimitNoticeKey(check.deviceId, check.overLimitAt);
  const noted: string[] = [];
  for (const companyId of check.companyIds) {
    try {
      if (await claimResourceWaitNotice(db, companyId, key, now)) noted.push(companyId);
    } catch (error) {
      logger.warn({ err: error, companyId, deviceId: check.deviceId }, "failed to record a device over-limit notice");
    }
  }
  return noted;
}

let configuredDeploymentMode: DeploymentMode | undefined | null = null;

/** In `local_trusted` mode the local board user counts as a member, so its accounts keep their labels. */
function deploymentModeOf(explicit: DeploymentMode | undefined): DeploymentMode | undefined {
  if (explicit) return explicit;
  if (configuredDeploymentMode === null) {
    try {
      configuredDeploymentMode = resolveDeploymentMode();
    } catch (error) {
      logger.warn({ err: error }, "resource-wait inbox items could not read the deployment mode; treating the local board user as a non-member");
      configuredDeploymentMode = undefined;
    }
  }
  return configuredDeploymentMode;
}

interface DeviceNotice {
  deviceId: string;
  deviceName: string;
  maxAccounts: number;
  overLimitAt: Date;
  notedAt: Date;
}

/** The notices whose key is the device's current flag: an older flag's notice no longer shows. */
function readDeviceNotices(value: unknown): DeviceNotice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): DeviceNotice[] => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const overLimitAt = typeof row.overLimitAt === "string" ? new Date(row.overLimitAt) : null;
    const notedAt = typeof row.notedAt === "string" ? new Date(row.notedAt) : null;
    if (typeof row.deviceId !== "string" || typeof row.deviceName !== "string" || !overLimitAt || !notedAt) return [];
    if (!Number.isFinite(overLimitAt.getTime()) || !Number.isFinite(notedAt.getTime())) return [];
    if (row.noticeKey !== deviceOverLimitNoticeKey(row.deviceId, overLimitAt)) return [];
    return [{ deviceId: row.deviceId, deviceName: row.deviceName, maxAccounts: Number(row.maxAccounts) || 1, overLimitAt, notedAt }];
  });
}

/**
 * The one query: the company row (so a device notice shows with no waits), its
 * wait settings, its device notices that still match their device's flag, and
 * every open episode with what its item needs: the current run, the agent, the
 * task, the account, the device, the environment and its registry row.
 */
function loadCompanyWaits(db: Db, companyId: string) {
  const accountOwner = sql<string | null>`coalesce(${aiAccounts.ownerUserId}, ${aiAccounts.createdByUserId})`;
  return db
    .select({
      notifyAfterHours: executionWaitSettings.notifyAfterHours,
      // The company's notices of the current flags of flagged devices: one
      // primary-key lookup per flagged device (`deviceOverLimitNoticeKey`), run
      // once per read. Never correlated to the outer row, which would rescan
      // the company's notices (a table never pruned) once per open episode.
      deviceNotices: sql<unknown>`(
        select coalesce(json_agg(json_build_object(
          'noticeKey', notice.notice_key,
          'deviceId', notice_device.id,
          'deviceName', notice_device.name,
          'maxAccounts', notice_device.max_accounts,
          'overLimitAt', notice_device.over_limit_at,
          'notedAt', notice.created_at
        ) order by notice.created_at), '[]'::json)
        from ai_account_hosts notice_device
        join resource_wait_notices notice
          on notice.company_id = ${companyId}
          and notice.notice_key = ${DEVICE_OVER_LIMIT_NOTICE_PREFIX} || notice_device.id::text || ':'
            || round(extract(epoch from notice_device.over_limit_at) * 1000)::bigint::text
        where notice_device.over_limit_at is not null
      )`,
      episodeId: resourceWaitEpisodes.id,
      agentId: resourceWaitEpisodes.agentId,
      issueId: resourceWaitEpisodes.issueId,
      kind: resourceWaitEpisodes.kind,
      reason: resourceWaitEpisodes.reason,
      scope: resourceWaitEpisodes.scope,
      resourceKey: resourceWaitEpisodes.resourceKey,
      environmentId: resourceWaitEpisodes.environmentId,
      deviceId: resourceWaitEpisodes.deviceId,
      accountId: resourceWaitEpisodes.accountId,
      since: resourceWaitEpisodes.since,
      resumeAt: resourceWaitEpisodes.resumeAt,
      resumeAtSource: resourceWaitEpisodes.resumeAtSource,
      currentRunId: resourceWaitEpisodes.currentRunId,
      episodeUpdatedAt: resourceWaitEpisodes.updatedAt,
      runStatus: heartbeatRuns.status,
      runWaitReason: sql<string | null>`${heartbeatRuns.contextSnapshot} -> 'resourceWait' ->> 'reason'`,
      runWaitMessage: sql<string | null>`${heartbeatRuns.contextSnapshot} -> 'resourceWait' ->> 'message'`,
      agentName: agents.name,
      issueIdentifier: issues.identifier,
      issueTitle: issues.title,
      issueStatus: issues.status,
      issuePriority: issues.priority,
      issueAssigneeAgentId: issues.assigneeAgentId,
      issueAssigneeUserId: issues.assigneeUserId,
      issueHiddenAt: issues.hiddenAt,
      projectId: projects.id,
      projectName: projects.name,
      projectColor: projects.color,
      projectIcon: projects.icon,
      workspaceId: projectWorkspaces.id,
      workspaceName: projectWorkspaces.name,
      accountLabel: aiAccounts.label,
      accountOwnerId: accountOwner,
      accountOwnerIsMember: sql<boolean>`exists (
        select 1 from ${companyMemberships}
        where ${companyMemberships.companyId} = ${companies.id}
          and ${companyMemberships.principalType} = 'user'
          and ${companyMemberships.status} = 'active'
          and ${companyMemberships.principalId} = ${accountOwner}
      )`,
      limitEpisodeStartedAt: aiAccounts.limitEpisodeStartedAt,
      deviceName: aiAccountHosts.name,
      overLimitAt: aiAccountHosts.overLimitAt,
      environmentName: environments.name,
      registryState: environmentAvailability.state,
      unavailableSince: environmentAvailability.unavailableSince,
    })
    .from(companies)
    .leftJoin(executionWaitSettings, eq(executionWaitSettings.companyId, companies.id))
    .leftJoin(resourceWaitEpisodes, and(eq(resourceWaitEpisodes.companyId, companies.id), isNull(resourceWaitEpisodes.resolvedAt)))
    .leftJoin(heartbeatRuns, and(eq(heartbeatRuns.id, resourceWaitEpisodes.currentRunId), eq(heartbeatRuns.companyId, companies.id)))
    .leftJoin(agents, and(eq(agents.id, resourceWaitEpisodes.agentId), eq(agents.companyId, companies.id)))
    .leftJoin(issues, and(eq(issues.id, resourceWaitEpisodes.issueId), eq(issues.companyId, companies.id)))
    .leftJoin(projects, and(eq(projects.id, issues.projectId), eq(projects.companyId, companies.id)))
    .leftJoin(projectWorkspaces, and(eq(projectWorkspaces.id, issues.projectWorkspaceId), eq(projectWorkspaces.companyId, companies.id)))
    .leftJoin(aiAccounts, eq(aiAccounts.id, resourceWaitEpisodes.accountId))
    .leftJoin(aiAccountHosts, eq(aiAccountHosts.id, resourceWaitEpisodes.deviceId))
    .leftJoin(environments, eq(environments.id, resourceWaitEpisodes.environmentId))
    .leftJoin(environmentAvailability, eq(environmentAvailability.environmentId, resourceWaitEpisodes.environmentId))
    .where(eq(companies.id, companyId))
    .orderBy(asc(resourceWaitEpisodes.since), asc(resourceWaitEpisodes.id));
}

type CompanyWaitRow = Awaited<ReturnType<typeof loadCompanyWaits>>[number];
type WaitRow = CompanyWaitRow & {
  episodeId: string;
  agentId: string;
  kind: string;
  reason: ResourceWaitReason;
  scope: string;
  resourceKey: string;
  since: Date;
};

interface WaitGroup {
  dedupKey: string;
  /** When the resource episode started: the item's arrival, and the base of a dismissal. */
  start: Date;
  rows: WaitRow[];
  device: DeviceNotice | null;
}

function isWaitRow(row: CompanyWaitRow): row is WaitRow {
  return Boolean(row.episodeId && row.agentId && row.kind && row.scope && row.resourceKey && row.since) && isResourceWaitReason(row.reason);
}

function isLimitReason(reason: string): boolean {
  return reason === "usage_limit" || reason === "credit_balance";
}

/** The start of the resource episode, by the same rules as `resourceEpisodeKeyOf`. */
function resourceEpisodeStart(row: WaitRow): Date {
  if (isLimitReason(row.reason)) return row.limitEpisodeStartedAt ?? row.since;
  if (row.kind === "environment" && row.scope === "target" && row.registryState === "unavailable") return row.unavailableSince ?? row.since;
  if (row.reason === "slots_full") return row.overLimitAt ?? row.since;
  return row.since;
}

function resourceEpisodeKey(row: WaitRow): string {
  return resourceEpisodeKeyOf({
    episode: { kind: row.kind, reason: row.reason, scope: row.scope, since: row.since },
    limitEpisodeStartedAt: row.limitEpisodeStartedAt ?? null,
    overLimitAt: row.overLimitAt ?? null,
    unavailableSince: row.registryState === "unavailable" ? row.unavailableSince ?? null : null,
  });
}

function utcTime(value: Date): string {
  return `${value.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function issueHref(prefix: string, row: Pick<WaitRow, "issueId" | "issueIdentifier">): string {
  return `/${prefix}/issues/${row.issueIdentifier ?? row.issueId}`;
}

function issueSubjectOf(prefix: string, companyId: string, row: WaitRow): AttentionSubject | null {
  if (!row.issueId || !row.issueTitle) return null;
  return {
    kind: "issue",
    id: row.issueId,
    companyId,
    title: row.issueTitle,
    identifier: row.issueIdentifier ?? null,
    status: row.issueStatus ?? null,
    href: issueHref(prefix, row),
    metadata: {
      priority: row.issuePriority,
      assigneeAgentId: row.issueAssigneeAgentId,
      assigneeUserId: row.issueAssigneeUserId,
    },
  };
}

function projectOf(row: WaitRow | undefined): AttentionProjectRef | null {
  return row?.projectId && row.projectName
    ? { id: row.projectId, name: row.projectName, urlKey: deriveProjectUrlKey(row.projectName, row.projectId), color: row.projectColor ?? null, icon: row.projectIcon ?? null }
    : null;
}

function workspaceOf(row: WaitRow | undefined): AttentionWorkspaceRef | null {
  return row?.workspaceId && row.workspaceName ? { id: row.workspaceId, name: row.workspaceName } : null;
}

/** "A task waits" or "3 tasks wait". */
function tasksWait(count: number, verb: "wait" | "have waited" = "wait"): string {
  if (count === 1) return verb === "wait" ? "A task waits" : "A task has waited";
  return `${count} tasks ${verb}`;
}

interface ItemText {
  title: string;
  whyNow: string;
}

/** The headline and the fix of a group of waits, by reason (spec 8 names the fix). */
function waitText(group: WaitGroup, input: { now: Date; accountLabel: string | null; notifyHours: number }): ItemText {
  const first = group.rows[0]!;
  const count = group.rows.length;
  const account = input.accountLabel ? `Claude account ${input.accountLabel}` : null;
  const device = first.deviceName ?? first.environmentName ?? "the device";
  const agent = first.agentName ?? "the agent";
  const resumes = first.resumeAt ? ` at ${utcTime(first.resumeAt)} (${first.resumeAtSource === "provider" ? "provider reset" : "estimated"})` : "";
  const driverFix = first.runWaitReason === first.reason && first.runWaitMessage ? first.runWaitMessage : null;
  const never = "Paperclip never moves a task to another account.";
  switch (first.reason) {
    case "usage_limit":
      return {
        title: `${account ?? "A Claude account"} reached its usage limit`,
        whyNow: `${tasksWait(count)} for the limit to reset${resumes}; they resume automatically. ${never} The owner can clear the limit after checking.`,
      };
    case "credit_balance":
      return {
        title: `${account ?? "A Claude account"} has no API credit left`,
        whyNow: `${tasksWait(count)} for API credit${resumes}. ${never} Add credit, then the owner can clear the limit.`,
      };
    case "signed_out":
      return { title: `${account ?? "A Claude account"} is signed out`, whyNow: `${tasksWait(count)}. Its owner must replace the token in Claude accounts, or choose another account for ${agent}.` };
    case "withdrawn":
      return { title: `${account ?? "A Claude account"} is switched off`, whyNow: `${tasksWait(count)}. Turn it back on in Claude accounts, or choose another account for ${agent}.` };
    case "unassigned":
      return { title: `No Claude account chosen for ${agent}`, whyNow: `${tasksWait(count)}. Choose an account for ${agent} in Claude accounts, or switch it to its device's own login.` };
    case "owner_not_member":
      return { title: `The Claude account of ${agent} is no longer available in this company`, whyNow: `${tasksWait(count)}. Choose another account for ${agent}, or add the account's owner back to this company.` };
    case "reserved_elsewhere":
      return { title: `${account ?? "A Claude account"} is reserved for other projects`, whyNow: `${tasksWait(count)}. Its owner can clear the reservation in Claude accounts, or choose another account for ${agent}.` };
    case "device_unknown":
      return { title: `Paperclip cannot tell which device ${agent} runs on`, whyNow: `${tasksWait(count)} for ${account ?? "its Claude account"}. Pin ${agent} to an environment, or ask an instance admin to map the environment to a device.` };
    case "credential_type_unsupported":
      return { title: `${device} does not accept this credential type`, whyNow: `${tasksWait(count)}. Choose an account of a type ${device} accepts for ${agent}, or move ${agent} to another device.` };
    case "not_allowed":
      return { title: `Project not enabled on ${device}`, whyNow: `${tasksWait(count)}. ${driverFix ?? `Enable this project for this company on ${device}, or move ${agent} to another device.`}` };
    case "not_serving":
      return { title: `${device} does not serve this company`, whyNow: `${tasksWait(count)}. ${driverFix ?? `Add its owner to this company, or move ${agent} to another device.`}` };
    case "slots_full":
      return { title: `No free Claude account slot on ${device}`, whyNow: `${tasksWait(count)} for a free slot; ${device} already runs its maximum of Claude accounts. To avoid the wait, choose an account already running there, or move agents to another device.` };
    default: {
      const waited = formatWaitDuration(input.now.getTime() - group.start.getTime());
      return {
        title: `Waiting for device ${device} (${resourceWaitReasonLabel(first.reason)})`,
        whyNow: `${tasksWait(count, "have waited")} for ${device} for ${waited}. ${count === 1 ? "It starts" : "They start"} automatically when ${device} is available; to run elsewhere, move the agent to another device.`,
      };
    }
  }
}

function overLimitText(notice: DeviceNotice, waiting: number): ItemText {
  const tail = waiting > 0
    ? ` ${tasksWait(waiting)} for a free slot.`
    : " Tasks that need another account there wait for a free slot.";
  return {
    title: `${notice.deviceName} is over its Claude account limit`,
    whyNow: `More Claude accounts are bound to agents that can run on ${notice.deviceName} than its limit of ${capOf(notice)}.${tail} Choose accounts already on it, or move agents to another device.`,
  };
}

/**
 * The company's resource-wait inbox items (one query). `prefix` is the
 * company's issue prefix, `now` the feed's clock.
 */
export async function resourceWaitAttentionInputs(
  db: Db,
  companyId: string,
  options: { prefix: string; now?: number | Date; deploymentMode?: DeploymentMode; env?: NodeJS.ProcessEnv },
): Promise<ResourceWaitAttentionInput[]> {
  const now = options.now === undefined ? new Date() : new Date(options.now);
  const rows = await loadCompanyWaits(db, companyId);
  if (rows.length === 0) return [];
  const deploymentMode = deploymentModeOf(options.deploymentMode);
  const notifyHours = rows[0]!.notifyAfterHours ?? instanceDefaultNotifyHours(options.env);
  const groups = new Map<string, WaitGroup>();

  for (const row of rows) {
    if (!isWaitRow(row)) continue;
    // The issue gate cancelled the current run, or it ended: its episode is about to close.
    if (!row.runStatus || !LIVE_RUN_STATUSES.has(row.runStatus)) continue;
    if (row.issueId && (!row.issueStatus || CLOSED_ISSUE_STATUSES.has(row.issueStatus) || row.issueHiddenAt)) continue;
    const policy = RESOURCE_WAIT_NOTICE_POLICY[row.reason];
    if (policy === "never") continue;
    if (policy === "after_threshold" && (notifyHours <= 0 || now.getTime() - row.since.getTime() < notifyHours * 3_600_000)) continue;
    const dedupKey = `resource_wait:${row.kind}:${row.resourceKey}:${resourceEpisodeKey(row)}`;
    const group = groups.get(dedupKey) ?? { dedupKey, start: resourceEpisodeStart(row), rows: [], device: null };
    group.rows.push(row);
    groups.set(dedupKey, group);
  }
  // The over-limit notice of a device shares its key with the slot waits of that flag.
  for (const notice of readDeviceNotices(rows[0]!.deviceNotices)) {
    const dedupKey = `resource_wait:device_slots:device:${notice.deviceId}:${notice.overLimitAt.toISOString()}`;
    const group = groups.get(dedupKey) ?? { dedupKey, start: notice.overLimitAt, rows: [], device: null };
    group.device = notice;
    groups.set(dedupKey, group);
  }

  const items: ResourceWaitAttentionInput[] = [];
  for (const group of groups.values()) {
    const first = group.rows[0];
    const labelRow = group.rows.find((row) => row.reason !== "owner_not_member" && row.accountLabel
      && (row.accountOwnerIsMember || (deploymentMode === "local_trusted" && row.accountOwnerId === LOCAL_BOARD_USER_ID)));
    const accountLabel = labelRow?.accountLabel ?? null;
    const text = group.device
      ? overLimitText(group.device, group.rows.length)
      : waitText(group, { now, accountLabel, notifyHours });
    const reason = first?.reason ?? "slots_full";
    const policy = RESOURCE_WAIT_NOTICE_POLICY[reason];
    // A device outage arrives once it passed the threshold; everything else at its start.
    const activityAt = policy === "after_threshold" ? new Date(group.start.getTime() + notifyHours * 3_600_000) : group.start;
    const issueIds = [...new Set(group.rows.map((row) => row.issueId).filter((id): id is string => Boolean(id)))];
    const relatedIssue = first ? issueSubjectOf(options.prefix, companyId, first) : null;
    const href = relatedIssue?.href
      ?? (first ? `/${options.prefix}/agents/${first.agentId}` : `/${options.prefix}/company/settings/devices`);
    const updatedAt = [group.device?.notedAt, ...group.rows.map((row) => row.episodeUpdatedAt)]
      .filter((value): value is Date => value instanceof Date)
      .reduce((latest, value) => (value > latest ? value : latest), group.start);
    items.push({
      companyId,
      sourceKind: "resource_wait_alert",
      // A derived item has no row of its own: its key is its identity, so
      // triage and retention follow the resource episode.
      subject: {
        kind: "resource_wait",
        id: group.dedupKey,
        companyId,
        title: text.title,
        identifier: null,
        status: reason,
        href,
        metadata: {
          kind: first?.kind ?? "device_slots",
          reason,
          resourceKey: first?.resourceKey ?? `device:${group.device!.deviceId}`,
          waitingCount: group.rows.length,
          issueIds: issueIds.slice(0, ISSUE_ID_LIMIT),
          runIds: group.rows.map((row) => row.currentRunId).filter((id): id is string => Boolean(id)).slice(0, ISSUE_ID_LIMIT),
          ...(first ? { agentId: first.agentId, since: first.since.toISOString() } : {}),
          ...(first?.environmentId ? { environmentId: first.environmentId } : {}),
          ...((first?.deviceId ?? group.device?.deviceId) ? { deviceId: first?.deviceId ?? group.device!.deviceId } : {}),
          ...(accountLabel && first?.accountId ? { accountId: first.accountId } : {}),
          ...(first?.resumeAt ? { resumeAt: first.resumeAt.toISOString() } : {}),
          ...(group.device ? { overLimitSince: group.device.overLimitAt.toISOString() } : {}),
        },
      },
      whyNow: text.whyNow,
      decisionVerbs: [
        relatedIssue
          ? { id: "inspect", label: "Inspect", description: "Open the waiting task." }
          : { id: "inspect", label: "Inspect", description: group.device ? "Open the devices page." : "Open the waiting agent." },
        { id: "dismiss", label: "Dismiss", description: "Dismiss this alert until the wait changes." },
      ],
      inlineResolvable: false,
      entryRule: group.device
        ? "ai_account_hosts.over_limit_at is set and the company was notified when it was set."
        : "Open resource_wait_episodes row whose current run is live: immediate reasons at once, device outages after the company's notify-after hours.",
      exitRule: group.device
        ? "The device's bound accounts fit its limit again, or the row is dismissed."
        : "Every wait of the resource episode ends, or the row is dismissed.",
      dedupKey: group.dedupKey,
      severity: !group.device && isLimitReason(reason) ? "medium" : "high",
      activityAt: activityAt.toISOString(),
      createdAt: group.start.toISOString(),
      updatedAt: updatedAt.toISOString(),
      relatedIssue,
      project: projectOf(first),
      workspace: workspaceOf(first),
      detail: null,
    });
  }
  return items;
}
