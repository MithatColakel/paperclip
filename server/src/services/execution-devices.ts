import { and, asc, eq, inArray, isNotNull, isNull, ne, sql, type SQL } from "drizzle-orm";
import {
  type Db,
  agents,
  aiAccountAgentBindings,
  aiAccountHostEnvironments,
  aiAccountHosts,
  aiAccountRunSlots,
  aiAccounts,
  authUsers,
  companies,
  companyMemberships,
  environmentAvailability,
  environments,
  heartbeatRuns,
  instanceSettings,
  issues,
  plugins,
  projects,
  resourceWaitEpisodes,
} from "@paperclipai/db";
import {
  DEVICE_POOL_ACCOUNT_LIMIT,
  LOCAL_EXECUTION_DEVICE_KEY,
  deriveAiAccountState,
  isEnvironmentAvailableToCompany,
  isEnvironmentRunnableForAdapter,
  sshExecutionDeviceKey,
  type AiAccountCredentialType,
  type AiAccountOwnerRef,
  type DeploymentMode,
  type EnvironmentAvailabilitySummary,
  type ExecutionDeviceAccountRef,
  type ExecutionDeviceDetail,
  type ExecutionDeviceDuplicateHint,
  type ExecutionDeviceEnvironmentSummary,
  type ExecutionDeviceOwner,
  type ExecutionDeviceSummary,
  type ExecutionDeviceWaitSummary,
  type InstanceExecutionDeviceSummary,
  type ResourceWaitKind,
  type ResourceWaitReason,
} from "@paperclipai/shared";
import type { PluginEnvironmentTargetReport } from "@paperclipai/plugin-sdk";
import { conflict, notFound } from "../errors.js";
import {
  clipAvailabilityLabel,
  clipAvailabilityMessage,
  normalizeAvailabilityReason,
  normalizeCredentialTypes,
  summarizeEnvironmentAvailability,
  type EnvironmentAvailabilityRow,
  type TargetAvailabilityState,
} from "./environment-availability.js";

/**
 * Fork: execution devices (`ai_account_hosts`), the machines that run agents.
 *
 * - Which device an environment runs on: an explicit mapping, else the Local
 *   environment's server device, an SSH host's device keyed
 *   `ssh:<host>:<port>`, or the sandbox target a plugin reported.
 * - The devices an agent can run on (its candidate environments), the pool
 *   accounts bound to each device, and the accounts running there now.
 * - Plugin targets: the report upsert, linking a target to an existing
 *   device, and likely-duplicate hints.
 * - Device summaries for a company (other companies' account labels are never
 *   returned) and for instance admins.
 *
 * At most `capOf(device)` distinct pool accounts are in use per device. The
 * binding-time check counts bound accounts; the run-time check counts running
 * ones. No device ownership check exists anywhere: ownership is display only.
 *
 * Input-only: every function takes the database handle or an open
 * transaction. Instance-level by design (see AGENTS.md §5): one machine serves
 * every company's runs.
 */

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** A database handle or an open transaction. */
export type DeviceDb = Db | Tx;
export type ExecutionDeviceRow = typeof aiAccountHosts.$inferSelect;
export type ExecutionEnvironmentRow = typeof environments.$inferSelect;

/** The server device's name when Paperclip creates it. */
export const SERVER_DEVICE_NAME = "Paperclip server";
/** A derived SSH device is named after the environment that first reached it. */
export const SSH_DEVICE_NAME_PREFIX = "SSH · ";
/** A target report older than this is stale: planning and binding then assume subscription only. */
export const TARGET_STATE_TTL_MS = 15 * 60 * 1000;
/** What a sandbox target accepts when its report is stale or names no types. */
export const DEFAULT_TARGET_CREDENTIAL_TYPES: readonly AiAccountCredentialType[] = ["subscription"];
/** Every binding change and device cap check runs under `pg_advisory_xact_lock(hashtext(<this>))`. */
export const AI_ACCOUNT_BINDINGS_LOCK_KEY = "ai-account-bindings";
/** Legacy host-pool runs still in flight count toward a device's running set for this release. */
export const LEGACY_HOST_POOL_ATTRIBUTION_MODE = "host_pool";
/** The only adapter whose runs use a pool binding (spec 5.3 step 2). */
const POOL_BINDING_ADAPTER_TYPE = "claude_local";

const DEVICE_NAME_BASE_MAX_LENGTH = 72;
const RUN_SLOT_RETENTION_MS = 24 * 60 * 60 * 1000;
const LOCAL_BOARD_USER_ID = "local-board";
const PLUGIN_TARGET_KEY_PATTERN = /^target:([0-9a-fA-F-]{36}):([a-z0-9][a-z0-9._-]*):(.+)$/;
const LIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What device resolution reads from an environment (a database row or the shared `Environment`). */
export interface DeviceEnvironmentRef {
  id: string;
  name: string;
  driver: string;
  config: Record<string, unknown> | null | undefined;
}

/** How an environment reached its device. `mapping` is an explicit instance-admin mapping. */
export type DeviceVia = "mapping" | "local" | "ssh" | "target";

export interface DeviceResolutionOptions {
  /** Create the server or an SSH device on first use (default true). Sandbox devices come only from reports. */
  create?: boolean;
}

/** An agent's placement inputs. To evaluate a placement change, pass the proposed pin. */
export interface DevicePlacementAgent {
  id: string;
  companyId: string;
  adapterType: string;
  defaultEnvironmentId: string | null;
}

export interface CandidateDevice {
  environmentId: string;
  environment: ExecutionEnvironmentRow | null;
  /** Null when the environment maps to no device (`device_unknown`). */
  device: ExecutionDeviceRow | null;
}

export interface DeviceBinding {
  agentId: string;
  companyId: string;
  accountId: string;
}

export interface DeviceBoundAccounts {
  deviceId: string;
  /** Distinct pool accounts bound to agents that can run on the device. */
  accountIds: Set<string>;
  bindings: DeviceBinding[];
}

export interface BoundAccountsOptions extends DeviceResolutionOptions {
  /** Only these devices (default: every device a binding reaches). */
  deviceIds?: readonly string[] | null;
  /** Leave this agent's binding out, as a change to that binding does. */
  excludeAgentId?: string | null;
}

/** A plugin target's last report, as stored in `ai_account_hosts.target_state`. */
export interface StoredTargetState {
  state: "available" | "unavailable" | "retired";
  reason: string | null;
  label: string | null;
  message: string | null;
  retryAfter: string | null;
  /** As reported; null when the report named none (the default then applies). */
  acceptedCredentialTypes: AiAccountCredentialType[] | null;
  servedCompanyIds: string[];
  aliases: string[];
  reportedAt: string | null;
}

export interface ProviderPluginRef {
  id: string;
  pluginKey: string;
  displayName: string;
  status: string;
}

interface InstalledPlugin extends ProviderPluginRef {
  sandboxProviders: string[];
}

export interface DeviceLimitCheck {
  deviceId: string;
  deviceName: string;
  limit: number;
  inUse: number;
  overLimit: boolean;
  /** `flagged`: `over_limit_at` was set by this call; `cleared`: it was cleared; null: unchanged. */
  change: "flagged" | "cleared" | null;
  overLimitAt: Date | null;
  /** Companies whose bound agents count toward the device, for notices and audit. */
  companyIds: string[];
}

export interface UpsertPluginTargetInput {
  pluginId: string;
  /** The `sandbox_provider` driver key the target belongs to. */
  provider: string;
  /** One target of a validated `environments.reportTargets` call. */
  target: PluginEnvironmentTargetReport;
  now?: Date;
}

export interface PluginTargetUpsertResult {
  device: ExecutionDeviceRow;
  /** A new `external` device was inserted. */
  created: boolean;
  /** The row of an uninstalled plugin's target was taken over (see `upsertPluginTargetByTargetKey`). */
  reclaimed: boolean;
  previous: StoredTargetState | null;
  state: StoredTargetState;
  /** The accepted types before (stale or unspecified means subscription only) and after the report. */
  acceptedCredentialTypes: { before: AiAccountCredentialType[] | null; after: AiAccountCredentialType[] };
  /**
   * What changed on the device row since its previous report, for device
   * bookkeeping only: `configMatchChanged` (or `created`) calls for
   * `markOverLimitIfNeeded`, `ownerChanged` for the owner shown. These are
   * not wake signals. A registry row can be unavailable (a lease error) while
   * the device's last report said available, so a report that says available
   * again changes nothing here. Wake environment waits from the
   * per-environment `AvailabilityWriteResult` flags of `applyTargetState`
   * (`becameAvailable`, `acceptedCredentialTypesChanged`, `becameRetired`),
   * plus the report's own `wake`.
   */
  changes: {
    becameAvailable: boolean;
    becameUnavailable: boolean;
    becameRetired: boolean;
    acceptedCredentialTypesChanged: boolean;
    /** New device, re-claimed row, or a different `configMatch`: other environments may match now. */
    configMatchChanged: boolean;
    ownerChanged: boolean;
  };
}

export interface LinkDeviceTargetInput {
  pluginId: string;
  provider: string;
  targetKey: string;
}

export interface LinkDeviceTargetResult {
  device: ExecutionDeviceRow;
  /** Earlier `external` rows of this target, merged into the device and deleted. */
  mergedDeviceIds: string[];
  changed: boolean;
  /**
   * The device's cap check after the merge (null when nothing changed). A
   * merge can join accounts that were bound on two rows; `flagged` means the
   * caller notifies the affected companies.
   */
  limit: DeviceLimitCheck | null;
}

export interface DeviceSummaryOptions extends DeviceResolutionOptions {
  /** In `local_trusted` mode the implicit local board user counts as a member of every company. */
  deploymentMode?: DeploymentMode;
  now?: Date;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function transact<T>(db: DeviceDb, run: (tx: Tx) => Promise<T>): Promise<T> {
  return "rollback" in db ? (db as Tx).transaction(run) : (db as Db).transaction(run);
}

function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/** The cap on distinct pool accounts in use on a device: `min(max_accounts, 3)`. */
export function capOf(device: Pick<ExecutionDeviceRow, "maxAccounts">): number {
  const max = Number.isFinite(device.maxAccounts) ? Math.floor(device.maxAccounts) : DEVICE_POOL_ACCOUNT_LIMIT;
  return Math.max(1, Math.min(max, DEVICE_POOL_ACCOUNT_LIMIT));
}

/** Whether `accountId` would be one account too many among `inUse` (an account already in use takes no new slot). */
export function wouldExceedDeviceCap(input: { cap: number; inUse: ReadonlySet<string>; accountId: string }): boolean {
  return !input.inUse.has(input.accountId) && input.inUse.size + 1 > input.cap;
}

/** `target:<pluginId>:<provider>:<targetKey>`. */
export function pluginTargetKey(pluginId: string, provider: string, targetKey: string): string {
  return `target:${pluginId}:${provider}:${targetKey}`;
}

export function parsePluginTargetKey(key: string | null | undefined): { pluginId: string; provider: string; targetKey: string } | null {
  const match = key ? PLUGIN_TARGET_KEY_PATTERN.exec(key) : null;
  return match ? { pluginId: match[1]!, provider: match[2]!, targetKey: match[3]! } : null;
}

/** The host of an `ssh:<host>:<port>` device key. */
export function sshHostOfDeviceKey(key: string | null | undefined): string | null {
  if (!key?.startsWith("ssh:")) return null;
  const rest = key.slice(4);
  const index = rest.lastIndexOf(":");
  return index > 0 ? rest.slice(0, index) : null;
}

/** The SSH host of an environment config, normalized like device keys (spaces trimmed, lower-case). */
function sshHostOfConfig(config: Record<string, unknown> | null | undefined): string | null {
  return sshHostOfDeviceKey(sshExecutionDeviceKey(config?.host, config?.port));
}

export function readStoredTargetState(device: Pick<ExecutionDeviceRow, "targetState"> | null | undefined): StoredTargetState | null {
  const raw = device?.targetState;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const state = raw.state === "available" || raw.state === "unavailable" || raw.state === "retired" ? raw.state : null;
  if (!state) return null;
  const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  return {
    state,
    reason: text(raw.reason),
    label: text(raw.label),
    message: text(raw.message),
    retryAfter: text(raw.retryAfter),
    acceptedCredentialTypes: Array.isArray(raw.acceptedCredentialTypes) ? normalizeCredentialTypes(raw.acceptedCredentialTypes) : null,
    servedCompanyIds: strings(raw.servedCompanyIds),
    aliases: strings(raw.aliases),
    reportedAt: text(raw.reportedAt),
  };
}

/** The target reported within the last 15 minutes. */
export function isTargetStateFresh(
  device: Pick<ExecutionDeviceRow, "targetReportedAt"> | null | undefined,
  now: Date = new Date(),
): boolean {
  const at = device?.targetReportedAt?.getTime();
  return at !== undefined && Number.isFinite(at) && now.getTime() - at <= TARGET_STATE_TTL_MS;
}

/**
 * The credential types a run in this environment can receive. Local and SSH
 * take any type (null). A sandbox target takes what its report lists; a stale
 * report (older than 15 minutes), a report without a list, or no report at all
 * means subscription only.
 */
export function acceptedCredentialTypes(
  environment: Pick<DeviceEnvironmentRef, "driver">,
  device: Pick<ExecutionDeviceRow, "targetState" | "targetReportedAt"> | null | undefined,
  now: Date = new Date(),
): AiAccountCredentialType[] | null {
  if (environment.driver === "local" || environment.driver === "ssh") return null;
  if (!device || !isTargetStateFresh(device, now)) return [...DEFAULT_TARGET_CREDENTIAL_TYPES];
  return readStoredTargetState(device)?.acceptedCredentialTypes ?? [...DEFAULT_TARGET_CREDENTIAL_TYPES];
}

export function acceptsCredentialType(
  types: readonly AiAccountCredentialType[] | null | undefined,
  type: AiAccountCredentialType,
): boolean {
  return types == null || types.includes(type);
}

/**
 * A device's stored target state in the registry's terms, to seed or refresh
 * its environments' availability rows. Null for a device without a target.
 */
export function targetAvailabilityOf(
  device: ExecutionDeviceRow,
  now: Date = new Date(),
): (TargetAvailabilityState & { reportedAt: Date | null }) | null {
  const stored = readStoredTargetState(device);
  if (!stored || !device.targetKey) return null;
  return {
    state: stored.state,
    reason: stored.reason,
    label: stored.label ?? device.name,
    message: stored.message,
    retryAfter: stored.retryAfter,
    targetKey: device.targetKey,
    acceptedCredentialTypes: acceptedCredentialTypes({ driver: "sandbox" }, device, now),
    reportedAt: device.targetReportedAt,
  };
}

function matchesTarget(config: Record<string, unknown> | null | undefined, match: Record<string, string> | null | undefined): boolean {
  if (!match) return false;
  const entries = Object.entries(match);
  // An empty rule would match every environment of the provider; it never matches.
  if (entries.length === 0) return false;
  return entries.every(([key, value]) => typeof config?.[key] === "string" && config[key] === value);
}

function sameTargetMatch(a: Record<string, string> | null | undefined, b: Record<string, string> | null | undefined): boolean {
  const left = Object.entries(a ?? {}).sort(([x], [y]) => x.localeCompare(y));
  const right = Object.entries(b ?? {}).sort(([x], [y]) => x.localeCompare(y));
  return left.length === right.length && left.every(([key, value], index) => right[index]![0] === key && right[index]![1] === value);
}

function sameTypes(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((type, index) => type === b[index]);
}

/** Top-level string fields only, sorted, never `provider` (the driver key implies it). */
function normalizeTargetMatch(match: Record<string, unknown> | null | undefined): Record<string, string> {
  const entries = Object.entries(match ?? {})
    .filter(([key, value]) => key !== "provider" && typeof value === "string")
    .sort(([x], [y]) => x.localeCompare(y)) as Array<[string, string]>;
  return Object.fromEntries(entries);
}

function clipDeviceName(value: string): string {
  const text = value.replace(/\s+/g, " ").trim() || "Device";
  if (text.length <= DEVICE_NAME_BASE_MAX_LENGTH) return text;
  const end = /[\uD800-\uDBFF]/.test(text.charAt(DEVICE_NAME_BASE_MAX_LENGTH - 1))
    ? DEVICE_NAME_BASE_MAX_LENGTH - 1
    : DEVICE_NAME_BASE_MAX_LENGTH;
  return text.slice(0, end).trimEnd();
}

function toIsoOrNull(value: unknown): string | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// ---------------------------------------------------------------------------
// Locks, slots and the running set
// ---------------------------------------------------------------------------

/**
 * The bindings advisory lock (spec 5.3). Binding changes, placement changes,
 * mapping edits and the migration job take it before a cap check, in the same
 * transaction as their write.
 */
export async function acquireBindingsLock(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${AI_ACCOUNT_BINDINGS_LOCK_KEY}))`);
}

/** `SELECT … FOR UPDATE` on the device row; the run-time acquire holds it while it reads the running set. */
export async function lockDevice(tx: Tx, deviceId: string): Promise<ExecutionDeviceRow | null> {
  const [row] = await tx.select().from(aiAccountHosts).where(eq(aiAccountHosts.id, deviceId)).for("update");
  return row ?? null;
}

/**
 * The distinct pool accounts running on a device: run slots joined to runs
 * whose status is `running`. For one release it also counts the legacy
 * host-pool runs still in flight from the previous image, which record their
 * account only in `context_snapshot.aiConnection` (`mode: 'host_pool'`,
 * `hostId`). Pass the acquiring run as `excludeRunId`.
 */
export async function runningPoolAccountsOnDevice(
  db: DeviceDb,
  deviceId: string,
  excludeRunId?: string | null,
): Promise<Set<string>> {
  const slotRows = await db
    .selectDistinct({ accountId: aiAccountRunSlots.accountId })
    .from(aiAccountRunSlots)
    .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, aiAccountRunSlots.runId))
    .where(and(
      eq(aiAccountRunSlots.deviceId, deviceId),
      eq(heartbeatRuns.status, "running"),
      excludeRunId ? ne(aiAccountRunSlots.runId, excludeRunId) : undefined,
    ));
  const legacyAccountId = sql<string | null>`${heartbeatRuns.contextSnapshot} -> 'aiConnection' ->> 'accountId'`;
  const legacyRows = await db
    .selectDistinct({ accountId: legacyAccountId })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.status, "running"),
      sql`${heartbeatRuns.contextSnapshot} -> 'aiConnection' ->> 'mode' = ${LEGACY_HOST_POOL_ATTRIBUTION_MODE}`,
      sql`${heartbeatRuns.contextSnapshot} -> 'aiConnection' ->> 'hostId' = ${deviceId}`,
      excludeRunId ? ne(heartbeatRuns.id, excludeRunId) : undefined,
      sql`not exists (select 1 from ${aiAccountRunSlots} where ${aiAccountRunSlots.runId} = ${heartbeatRuns.id})`,
    ));
  const running = new Set<string>(slotRows.map((row) => row.accountId));
  for (const row of legacyRows) {
    if (typeof row.accountId === "string" && row.accountId.length > 0) running.add(row.accountId);
  }
  return running;
}

/** Records the account a run acquired on a device; a re-acquire by the same run replaces its slot. */
export async function insertRunSlot(
  db: DeviceDb,
  slot: { runId: string; companyId: string; deviceId: string; accountId: string; acquiredAt?: Date },
): Promise<void> {
  const acquiredAt = slot.acquiredAt ?? new Date();
  await db
    .insert(aiAccountRunSlots)
    .values({ runId: slot.runId, companyId: slot.companyId, deviceId: slot.deviceId, accountId: slot.accountId, acquiredAt })
    .onConflictDoUpdate({
      target: aiAccountRunSlots.runId,
      set: { companyId: slot.companyId, deviceId: slot.deviceId, accountId: slot.accountId, acquiredAt },
    });
}

/** Deletes slots of runs that ended more than `olderThanMs` (24 h) ago. Returns the number deleted. */
export async function pruneRunSlots(db: DeviceDb, input: { now?: Date; olderThanMs?: number } = {}): Promise<number> {
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - (input.olderThanMs ?? RUN_SLOT_RETENTION_MS));
  const rows = await db
    .delete(aiAccountRunSlots)
    .where(sql`exists (
      select 1 from ${heartbeatRuns}
      where ${heartbeatRuns.id} = ${aiAccountRunSlots.runId}
        and ${heartbeatRuns.status} not in (${sql.join(LIVE_RUN_STATUSES.map((status) => sql`${status}`), sql`, `)})
        and coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.updatedAt}) < ${cutoff.toISOString()}::timestamptz
    )`)
    .returning({ runId: aiAccountRunSlots.runId });
  return rows.length;
}

// ---------------------------------------------------------------------------
// Plugins that provide sandbox targets
// ---------------------------------------------------------------------------

async function installedPlugins(db: DeviceDb): Promise<InstalledPlugin[]> {
  const rows = await db
    .select({ id: plugins.id, pluginKey: plugins.pluginKey, status: plugins.status, manifest: plugins.manifestJson })
    .from(plugins)
    .where(ne(plugins.status, "uninstalled"));
  return rows.map((row) => ({
    id: row.id,
    pluginKey: row.pluginKey,
    displayName: pluginDisplayName(row.pluginKey, row.manifest),
    status: row.status,
    sandboxProviders: unique((row.manifest?.environmentDrivers ?? [])
      .filter((driver) => driver?.kind === "sandbox_provider" && typeof driver.driverKey === "string")
      .map((driver) => driver.driverKey)),
  }));
}

function pluginDisplayName(pluginKey: string, manifest: { displayName?: unknown } | null | undefined): string {
  const name = typeof manifest?.displayName === "string" ? manifest.displayName.trim() : "";
  return name || pluginKey;
}

function toProviderRef(plugin: InstalledPlugin): ProviderPluginRef {
  return { id: plugin.id, pluginKey: plugin.pluginKey, displayName: plugin.displayName, status: plugin.status };
}

/** Installed plugins (any status but `uninstalled`) that declare `provider` as a `sandbox_provider` driver. */
export async function providerPlugins(db: DeviceDb, provider: string): Promise<ProviderPluginRef[]> {
  return (await installedPlugins(db)).filter((plugin) => plugin.sandboxProviders.includes(provider)).map(toProviderRef);
}

/** The one installed plugin that declares `provider`; null when none or more than one does. */
export async function soleProviderPlugin(db: DeviceDb, provider: string): Promise<ProviderPluginRef | null> {
  const found = await providerPlugins(db, provider);
  return found.length === 1 ? found[0]! : null;
}

/** The sole-provider rule for target reports: `pluginId` declares `provider` and no other installed plugin does. */
export async function isSoleProviderPlugin(db: DeviceDb, pluginId: string, provider: string): Promise<boolean> {
  return (await soleProviderPlugin(db, provider))?.id === pluginId;
}

// ---------------------------------------------------------------------------
// Device of an environment
// ---------------------------------------------------------------------------

/**
 * Inserts a device, appending ` (2)`, ` (3)`… to the name while another
 * device has it. `findExisting` returns the row a concurrent insert of the
 * same key created, if any.
 */
async function insertDeviceWithUniqueName(
  db: DeviceDb,
  baseName: string,
  values: Omit<typeof aiAccountHosts.$inferInsert, "name">,
  findExisting: () => Promise<ExecutionDeviceRow | null>,
): Promise<{ row: ExecutionDeviceRow; inserted: boolean }> {
  const base = clipDeviceName(baseName);
  const taken = new Set((await db.select({ name: aiAccountHosts.name }).from(aiAccountHosts)).map((row) => row.name));
  for (let n = 1; n <= 1000; n += 1) {
    const name = n === 1 ? base : `${base} (${n})`;
    if (taken.has(name)) continue;
    const [row] = await db.insert(aiAccountHosts).values({ ...values, name }).onConflictDoNothing().returning();
    if (row) return { row, inserted: true };
    const existing = await findExisting();
    if (existing) return { row: existing, inserted: false };
    taken.add(name);
  }
  throw new Error(`Could not find a free name for a new execution device "${base}"`);
}

async function findOrCreateKeyedDevice(
  db: DeviceDb,
  input: { externalKey: string; kind: "server" | "ssh_host"; name: string },
  create: boolean,
): Promise<ExecutionDeviceRow | null> {
  const find = async () => {
    const [row] = await db.select().from(aiAccountHosts).where(eq(aiAccountHosts.externalKey, input.externalKey));
    return row ?? null;
  };
  const existing = await find();
  if (existing || !create) return existing;
  return (await insertDeviceWithUniqueName(db, input.name, { kind: input.kind, externalKey: input.externalKey }, find)).row;
}

interface ResolvedDevice {
  device: ExecutionDeviceRow;
  via: DeviceVia;
}

/**
 * The reported target each sandbox environment runs on, without explicit
 * mappings: a device whose `target_provider` is the config's provider, whose
 * match rule the config contains, and which the provider's only installed
 * plugin manages. The most specific rule wins; ties go to the oldest device.
 */
async function sandboxTargetDevices(
  db: DeviceDb,
  sandboxes: readonly DeviceEnvironmentRef[],
): Promise<Map<string, ExecutionDeviceRow | null>> {
  const result = new Map<string, ExecutionDeviceRow | null>();
  if (sandboxes.length === 0) return result;
  const providerOf = (environment: DeviceEnvironmentRef) =>
    typeof environment.config?.provider === "string" ? environment.config.provider : null;
  const providers = unique(sandboxes.map(providerOf).filter((provider): provider is string => provider !== null));
  const installed = providers.length > 0 ? await installedPlugins(db) : [];
  const pluginOf = new Map<string, string>();
  for (const provider of providers) {
    const declaring = installed.filter((plugin) => plugin.sandboxProviders.includes(provider));
    if (declaring.length === 1) pluginOf.set(provider, declaring[0]!.id);
  }
  const targets = pluginOf.size > 0
    ? await db.select().from(aiAccountHosts).where(and(
      inArray(aiAccountHosts.targetProvider, [...pluginOf.keys()]),
      isNotNull(aiAccountHosts.targetKey),
    ))
    : [];
  for (const environment of sandboxes) {
    const provider = providerOf(environment);
    const pluginId = provider ? pluginOf.get(provider) : undefined;
    const matches = pluginId
      ? targets.filter((device) =>
        device.targetProvider === provider
        && device.managedByPluginId === pluginId
        && matchesTarget(environment.config, device.targetMatch))
      : [];
    matches.sort((a, b) =>
      Object.keys(b.targetMatch ?? {}).length - Object.keys(a.targetMatch ?? {}).length
      || a.createdAt.getTime() - b.createdAt.getTime()
      || a.id.localeCompare(b.id));
    result.set(environment.id, matches[0] ?? null);
  }
  return result;
}

async function resolveEnvironmentDevices(
  db: DeviceDb,
  environmentList: readonly DeviceEnvironmentRef[],
  opts: DeviceResolutionOptions = {},
): Promise<Map<string, ResolvedDevice | null>> {
  const create = opts.create ?? true;
  const list = [...new Map(environmentList.map((environment) => [environment.id, environment])).values()];
  const result = new Map<string, ResolvedDevice | null>();
  if (list.length === 0) return result;

  // 1. An explicit instance-admin mapping wins.
  const mapped = await db
    .select({ environmentId: aiAccountHostEnvironments.environmentId, device: aiAccountHosts })
    .from(aiAccountHostEnvironments)
    .innerJoin(aiAccountHosts, eq(aiAccountHosts.id, aiAccountHostEnvironments.hostId))
    .where(inArray(aiAccountHostEnvironments.environmentId, list.map((environment) => environment.id)));
  for (const row of mapped) result.set(row.environmentId, { device: row.device, via: "mapping" });
  const rest = list.filter((environment) => !result.has(environment.id));

  // 2. The Local environment runs on the Paperclip server's device.
  const locals = rest.filter((environment) => environment.driver === "local");
  if (locals.length > 0) {
    const device = await findOrCreateKeyedDevice(db, { externalKey: LOCAL_EXECUTION_DEVICE_KEY, kind: "server", name: SERVER_DEVICE_NAME }, create);
    for (const environment of locals) result.set(environment.id, device ? { device, via: "local" } : null);
  }

  // 3. SSH environments share a device per `ssh:<host>:<port>` key, as migration 0310 backfilled it.
  const sshEnvironments = rest.filter((environment) => environment.driver === "ssh");
  if (sshEnvironments.length > 0) {
    const keyOf = new Map(sshEnvironments.map((environment) => [
      environment.id,
      sshExecutionDeviceKey(environment.config?.host, environment.config?.port),
    ]));
    const keys = unique([...keyOf.values()].filter((key): key is string => key !== null));
    const byKey = new Map<string, ExecutionDeviceRow>();
    if (keys.length > 0) {
      for (const row of await db.select().from(aiAccountHosts).where(inArray(aiAccountHosts.externalKey, keys))) {
        byKey.set(row.externalKey!, row);
      }
    }
    for (const environment of sshEnvironments) {
      const key = keyOf.get(environment.id) ?? null;
      if (!key) {
        result.set(environment.id, null);
        continue;
      }
      let device = byKey.get(key) ?? null;
      if (!device && create) {
        device = await findOrCreateKeyedDevice(db, { externalKey: key, kind: "ssh_host", name: `${SSH_DEVICE_NAME_PREFIX}${environment.name}` }, true);
        if (device) byKey.set(key, device);
      }
      result.set(environment.id, device ? { device, via: "ssh" } : null);
    }
  }

  // 4. A sandbox environment runs on the target its provider's plugin reported.
  const sandboxes = rest.filter((environment) => environment.driver === "sandbox");
  for (const [environmentId, device] of await sandboxTargetDevices(db, sandboxes)) {
    result.set(environmentId, device ? { device, via: "target" } : null);
  }

  // 5. Any other driver maps to no device.
  for (const environment of list) {
    if (!result.has(environment.id)) result.set(environment.id, null);
  }
  return result;
}

/**
 * The device each environment runs on (spec 6.1), or null:
 * 1. an explicit mapping in `ai_account_host_environments`;
 * 2. `local` → the server device (`external_key 'local'`), a pool device;
 * 3. `ssh` → the device keyed `ssh:<host>:<port>` (`sshExecutionDeviceKey`),
 *    created on first use and named `SSH · <environment name>`; a config
 *    without a usable host or port has no device;
 * 4. `sandbox` → the device whose `target_provider` is `config.provider`,
 *    whose `target_match` the config contains, and which the provider's only
 *    installed plugin manages;
 * 5. any other driver → null.
 */
export async function devicesForEnvironments(
  db: DeviceDb,
  environmentList: readonly DeviceEnvironmentRef[],
  opts: DeviceResolutionOptions = {},
): Promise<Map<string, ExecutionDeviceRow | null>> {
  const resolved = await resolveEnvironmentDevices(db, environmentList, opts);
  return new Map([...resolved].map(([environmentId, entry]) => [environmentId, entry?.device ?? null]));
}

export async function deviceForEnvironment(
  db: DeviceDb,
  environment: DeviceEnvironmentRef | null | undefined,
  opts: DeviceResolutionOptions = {},
): Promise<ExecutionDeviceRow | null> {
  if (!environment) return null;
  return (await devicesForEnvironments(db, [environment], opts)).get(environment.id) ?? null;
}

/** As `devicesForEnvironments`, from environment ids; an unknown id maps to null. */
export async function devicesForEnvironmentIds(
  db: DeviceDb,
  environmentIds: readonly string[],
  opts: DeviceResolutionOptions = {},
): Promise<Map<string, ExecutionDeviceRow | null>> {
  const ids = unique(environmentIds);
  const rows = ids.length > 0 ? await db.select().from(environments).where(inArray(environments.id, ids)) : [];
  const resolved = await devicesForEnvironments(db, rows, opts);
  return new Map(ids.map((id) => [id, resolved.get(id) ?? null]));
}

/**
 * The active environments that run on a device, with how they reach it. No
 * device is created on the way.
 */
export async function environmentsForDevice(
  db: DeviceDb,
  deviceId: string,
): Promise<Array<{ environment: ExecutionEnvironmentRow; via: DeviceVia }>> {
  const rows = await db.select().from(environments).where(eq(environments.status, "active")).orderBy(asc(environments.name));
  const resolved = await resolveEnvironmentDevices(db, rows, { create: false });
  return rows.flatMap((environment) => {
    const entry = resolved.get(environment.id);
    return entry?.device.id === deviceId ? [{ environment, via: entry.via }] : [];
  });
}

/**
 * Where the reporting device's target state is written: the active sandbox
 * environments of `provider` whose config contains `match` and whose target
 * is `deviceId`. When several reported targets match one environment, the
 * most specific one runs it (as in `devicesForEnvironments`), so a broader
 * target's reports never overwrite its row. Explicit mappings are not
 * consulted: they place an environment for the account cap, while its leases
 * still reach the target its config names.
 */
export async function environmentsMatchingTarget(
  db: DeviceDb,
  input: { provider: string; match: Record<string, string>; deviceId: string },
): Promise<ExecutionEnvironmentRow[]> {
  const match = normalizeTargetMatch(input.match);
  if (Object.keys(match).length === 0) return [];
  const rows = await db
    .select()
    .from(environments)
    .where(and(
      eq(environments.driver, "sandbox"),
      eq(environments.status, "active"),
      sql`${environments.config} ->> 'provider' = ${input.provider}`,
      sql`${environments.config} @> ${JSON.stringify(match)}::jsonb`,
    ))
    .orderBy(asc(environments.name));
  const targets = await sandboxTargetDevices(db, rows);
  return rows.filter((row) => targets.get(row.id)?.id === input.deviceId);
}

// ---------------------------------------------------------------------------
// Candidate environments and devices of agents
// ---------------------------------------------------------------------------

interface PlacementContext {
  environments: Map<string, ExecutionEnvironmentRow>;
  projectDefaults: Map<string, string[]>;
  companyDefaults: Map<string, string | null>;
  instanceDefaultEnvironmentId: string | null;
  localEnvironmentId: string | null;
}

async function loadPlacementContext(
  db: DeviceDb,
  companyIds: readonly string[],
  extraEnvironmentIds: readonly string[],
): Promise<PlacementContext> {
  const ids = unique(companyIds);
  const projectRows = ids.length > 0
    ? await db
      .select({ companyId: projects.companyId, defaultEnvironmentId: projects.defaultEnvironmentId })
      .from(projects)
      .where(and(inArray(projects.companyId, ids), isNull(projects.archivedAt), isNotNull(projects.defaultEnvironmentId)))
    : [];
  const companyRows = ids.length > 0
    ? await db.select({ id: companies.id, defaultEnvironmentId: companies.defaultEnvironmentId }).from(companies).where(inArray(companies.id, ids))
    : [];
  const [settings] = await db
    .select({ defaultEnvironmentId: instanceSettings.defaultEnvironmentId })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, "default"));
  const [local] = await db.select().from(environments).where(eq(environments.driver, "local")).limit(1);

  const projectDefaults = new Map<string, string[]>();
  for (const row of projectRows) {
    if (!row.defaultEnvironmentId) continue;
    const list = projectDefaults.get(row.companyId) ?? [];
    if (!list.includes(row.defaultEnvironmentId)) list.push(row.defaultEnvironmentId);
    projectDefaults.set(row.companyId, list);
  }
  const companyDefaults = new Map(companyRows.map((row) => [row.id, row.defaultEnvironmentId ?? null]));
  const instanceDefaultEnvironmentId = settings?.defaultEnvironmentId ?? null;
  const environmentIds = unique([
    ...[...projectDefaults.values()].flat(),
    ...[...companyDefaults.values()].filter((id): id is string => Boolean(id)),
    ...(instanceDefaultEnvironmentId ? [instanceDefaultEnvironmentId] : []),
    ...extraEnvironmentIds,
  ]);
  const rows = environmentIds.length > 0 ? await db.select().from(environments).where(inArray(environments.id, environmentIds)) : [];
  const environmentMap = new Map(rows.map((row) => [row.id, row]));
  if (local) environmentMap.set(local.id, local);
  return { environments: environmentMap, projectDefaults, companyDefaults, instanceDefaultEnvironmentId, localEnvironmentId: local?.id ?? null };
}

/** Mirrors `isInheritableEnvironment` (environment-defaults.ts): an inherited default this agent can use. */
function isInheritable(environment: ExecutionEnvironmentRow | undefined, agent: DevicePlacementAgent): environment is ExecutionEnvironmentRow {
  return environment !== undefined
    && isEnvironmentAvailableToCompany(environment, agent.companyId)
    && isEnvironmentRunnableForAdapter(environment, agent.adapterType);
}

function candidateEnvironmentIdsFrom(context: PlacementContext, agent: DevicePlacementAgent): string[] {
  if (agent.defaultEnvironmentId) return [agent.defaultEnvironmentId];
  const ids: string[] = [];
  for (const environmentId of context.projectDefaults.get(agent.companyId) ?? []) {
    if (isInheritable(context.environments.get(environmentId), agent)) ids.push(environmentId);
  }
  const companyDefault = context.companyDefaults.get(agent.companyId) ?? null;
  const instanceDefault = context.instanceDefaultEnvironmentId;
  const fallback = companyDefault && isInheritable(context.environments.get(companyDefault), agent)
    ? companyDefault
    : instanceDefault && isInheritable(context.environments.get(instanceDefault), agent)
      ? instanceDefault
      : context.localEnvironmentId;
  if (fallback) ids.push(fallback);
  return unique(ids);
}

/**
 * The environments an agent's runs can resolve to (spec 5.3 step 4). A pinned
 * agent has only its pin. Otherwise: the inheritable defaults of the company's
 * non-archived projects, plus the first inheritable of the company default,
 * the instance default and the Local environment (the run-time fallback for
 * runs without a project default).
 */
export async function candidateEnvironmentIds(db: DeviceDb, agent: DevicePlacementAgent): Promise<string[]> {
  if (agent.defaultEnvironmentId) return [agent.defaultEnvironmentId];
  const context = await loadPlacementContext(db, [agent.companyId], []);
  return candidateEnvironmentIdsFrom(context, agent);
}

/** `candidateDevicesForAgent` for many agents at once, keyed by agent id. */
export async function candidateDevicesForAgents(
  db: DeviceDb,
  agentList: readonly DevicePlacementAgent[],
  opts: DeviceResolutionOptions = {},
): Promise<Map<string, CandidateDevice[]>> {
  const placements = new Map<string, CandidateDevice[]>();
  if (agentList.length === 0) return placements;
  const context = await loadPlacementContext(
    db,
    agentList.map((agent) => agent.companyId),
    agentList.map((agent) => agent.defaultEnvironmentId).filter((id): id is string => Boolean(id)),
  );
  const environmentIdsByAgent = new Map(agentList.map((agent) => [agent.id, candidateEnvironmentIdsFrom(context, agent)]));
  const environmentRows = unique([...environmentIdsByAgent.values()].flat())
    .map((id) => context.environments.get(id))
    .filter((row): row is ExecutionEnvironmentRow => row !== undefined);
  const devices = await resolveEnvironmentDevices(db, environmentRows, opts);
  for (const agent of agentList) {
    placements.set(agent.id, (environmentIdsByAgent.get(agent.id) ?? []).map((environmentId) => ({
      environmentId,
      environment: context.environments.get(environmentId) ?? null,
      device: devices.get(environmentId)?.device ?? null,
    })));
  }
  return placements;
}

/** Each candidate environment of the agent with its device; a null device means `device_unknown`. */
export async function candidateDevicesForAgent(
  db: DeviceDb,
  agent: DevicePlacementAgent,
  opts: DeviceResolutionOptions = {},
): Promise<CandidateDevice[]> {
  return (await candidateDevicesForAgents(db, [agent], opts)).get(agent.id) ?? [];
}

function distinctDevices(candidates: readonly CandidateDevice[]): ExecutionDeviceRow[] {
  const byId = new Map<string, ExecutionDeviceRow>();
  for (const candidate of candidates) {
    if (candidate.device) byId.set(candidate.device.id, candidate.device);
  }
  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// Bound accounts and the binding-time cap
// ---------------------------------------------------------------------------

/**
 * `bound(D)` for each device (spec 5.3 step 7): the distinct accounts of
 * `pool_account` bindings with an account, of non-terminated agents of any
 * company whose candidate devices include D. Paused agents count, and so do
 * agents moved to another adapter: their binding applies again as soon as
 * they move back, and no cap check guards that move. Every bound agent is
 * placed as a `claude_local` agent, the only adapter the binding serves.
 */
export async function boundAccountsByDevice(
  db: DeviceDb,
  opts: BoundAccountsOptions = {},
): Promise<Map<string, DeviceBoundAccounts>> {
  const rows = await db
    .select({
      agentId: aiAccountAgentBindings.agentId,
      companyId: aiAccountAgentBindings.companyId,
      accountId: aiAccountAgentBindings.accountId,
      defaultEnvironmentId: agents.defaultEnvironmentId,
    })
    .from(aiAccountAgentBindings)
    .innerJoin(agents, and(eq(agents.id, aiAccountAgentBindings.agentId), eq(agents.companyId, aiAccountAgentBindings.companyId)))
    .where(and(
      eq(aiAccountAgentBindings.mode, "pool_account"),
      isNotNull(aiAccountAgentBindings.accountId),
      ne(agents.status, "terminated"),
      opts.excludeAgentId ? ne(aiAccountAgentBindings.agentId, opts.excludeAgentId) : undefined,
    ));
  const placements = await candidateDevicesForAgents(db, rows.map((row) => ({
    id: row.agentId,
    companyId: row.companyId,
    adapterType: POOL_BINDING_ADAPTER_TYPE,
    defaultEnvironmentId: row.defaultEnvironmentId,
  })), opts);
  const wanted = opts.deviceIds ? new Set(opts.deviceIds) : null;
  const result = new Map<string, DeviceBoundAccounts>();
  if (wanted) {
    for (const deviceId of wanted) result.set(deviceId, { deviceId, accountIds: new Set(), bindings: [] });
  }
  for (const row of rows) {
    for (const device of distinctDevices(placements.get(row.agentId) ?? [])) {
      if (wanted && !wanted.has(device.id)) continue;
      const entry = result.get(device.id) ?? { deviceId: device.id, accountIds: new Set<string>(), bindings: [] };
      entry.accountIds.add(row.accountId!);
      entry.bindings.push({ agentId: row.agentId, companyId: row.companyId, accountId: row.accountId! });
      result.set(device.id, entry);
    }
  }
  return result;
}

/**
 * Re-runs the cap check for devices after a change that could not be refused
 * synchronously (project, company or instance defaults; new plugin
 * environments or matches). Sets `over_limit_at` when the bound accounts
 * exceed the cap and clears it when they fit again. Only the call that flips
 * the flag sees `flagged` or `cleared`, so a notice goes out once. Without
 * `deviceIds` every device is checked.
 */
export async function markOverLimitIfNeeded(
  db: DeviceDb,
  deviceIds?: readonly string[] | null,
  opts: { now?: Date } = {},
): Promise<DeviceLimitCheck[]> {
  const now = opts.now ?? new Date();
  const ids = deviceIds ? unique(deviceIds) : null;
  if (ids && ids.length === 0) return [];
  const devices = await db.select().from(aiAccountHosts)
    .where(ids ? inArray(aiAccountHosts.id, ids) : undefined)
    .orderBy(asc(aiAccountHosts.name));
  if (devices.length === 0) return [];
  const bound = await boundAccountsByDevice(db, { deviceIds: devices.map((device) => device.id) });
  const results: DeviceLimitCheck[] = [];
  for (const device of devices) {
    const entry = bound.get(device.id);
    const inUse = entry?.accountIds.size ?? 0;
    const limit = capOf(device);
    const overLimit = inUse > limit;
    let change: DeviceLimitCheck["change"] = null;
    let overLimitAt = device.overLimitAt;
    if (overLimit && !device.overLimitAt) {
      const [row] = await db.update(aiAccountHosts)
        .set({ overLimitAt: now, updatedAt: now })
        .where(and(eq(aiAccountHosts.id, device.id), isNull(aiAccountHosts.overLimitAt)))
        .returning({ overLimitAt: aiAccountHosts.overLimitAt });
      if (row) {
        change = "flagged";
        overLimitAt = row.overLimitAt;
      }
    } else if (!overLimit && device.overLimitAt) {
      const [row] = await db.update(aiAccountHosts)
        .set({ overLimitAt: null, updatedAt: now })
        .where(and(eq(aiAccountHosts.id, device.id), isNotNull(aiAccountHosts.overLimitAt)))
        .returning({ id: aiAccountHosts.id });
      if (row) {
        change = "cleared";
        overLimitAt = null;
      }
    }
    results.push({
      deviceId: device.id,
      deviceName: device.name,
      limit,
      inUse,
      overLimit,
      change,
      overLimitAt,
      companyIds: unique((entry?.bindings ?? []).map((binding) => binding.companyId)).sort(),
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Plugin targets
// ---------------------------------------------------------------------------

async function existingUserId(db: DeviceDb, userId: string | null | undefined): Promise<string | null> {
  if (typeof userId !== "string" || userId.length === 0) return null;
  const [row] = await db.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.id, userId));
  return row?.id ?? null;
}

/**
 * Rows that stand for `<provider>/<targetKey>` under a plugin that is no
 * longer installed (no `plugins` row, or status `uninstalled`).
 */
async function orphanedTargetRows(
  tx: Tx,
  input: { provider: string; targetKey: string; installedPluginIds: readonly string[] },
): Promise<ExecutionDeviceRow[]> {
  const suffix = `:${input.provider}:${input.targetKey}`;
  return tx
    .select()
    .from(aiAccountHosts)
    .where(and(
      eq(aiAccountHosts.targetProvider, input.provider),
      sql`${aiAccountHosts.targetKey} = 'target:' || ${aiAccountHosts.managedByPluginId}::text || ${suffix}`,
      input.installedPluginIds.length > 0 ? sql`${aiAccountHosts.managedByPluginId} not in (${sql.join(input.installedPluginIds.map((id) => sql`${id}::uuid`), sql`, `)})` : undefined,
    ))
    .orderBy(asc(aiAccountHosts.createdAt), asc(aiAccountHosts.id))
    .for("update");
}

function storedTargetStateOf(target: PluginEnvironmentTargetReport, label: string, now: Date): StoredTargetState {
  const state = target.retired ? "retired" : target.state === "unavailable" ? "unavailable" : "available";
  return {
    state,
    reason: state === "unavailable" ? normalizeAvailabilityReason(target.reason) : null,
    label,
    message: clipAvailabilityMessage(target.message),
    retryAfter: toIsoOrNull(target.retryAfter),
    acceptedCredentialTypes: Array.isArray(target.acceptedCredentialTypes) ? normalizeCredentialTypes(target.acceptedCredentialTypes) : null,
    servedCompanyIds: unique((target.servedCompanyIds ?? []).filter((id) => typeof id === "string" && id.length > 0)).slice(0, 200),
    aliases: unique((target.aliases ?? []).filter((alias) => typeof alias === "string").map((alias) => alias.trim().toLowerCase()).filter(Boolean)).slice(0, 5),
    reportedAt: now.toISOString(),
  };
}

/**
 * Upserts the device of one reported target by its key
 * `target:<pluginId>:<provider>:<targetKey>` and stamps the managing plugin,
 * the match rule, the report and its time. The caller validates the report
 * and checks the sole-provider rule first (`isSoleProviderPlugin`).
 *
 * - A device linked to this target (`linkTarget`) is the row the key finds,
 *   so a report updates it instead of inserting an `external` one.
 * - Re-claim: `managed_by_plugin_id` has no foreign key, and a plugin that was
 *   removed with its data and installed again gets a new id, so its old key no
 *   longer matches. When no row has the new key, a row for the same provider
 *   and target key whose managing plugin is no longer installed is taken
 *   over: its key and managing plugin are rewritten, and it keeps its id,
 *   name, mappings, run slots and links. A row of a plugin that is still
 *   installed is never taken over. (An ordinary uninstall and reinstall keeps
 *   the plugin id, so its rows match directly.)
 * - A new device is `external`, named after the target's label.
 * - `ownerUserId` is display only and kept only when that user exists;
 *   anything else leaves the device unowned.
 *
 * The caller then writes the state onto `environmentsMatchingTarget` (with
 * this device's id) through `applyTargetState`, and wakes from that call's
 * per-environment results (see `PluginTargetUpsertResult.changes`).
 */
export async function upsertPluginTargetByTargetKey(
  db: DeviceDb,
  input: UpsertPluginTargetInput,
): Promise<PluginTargetUpsertResult> {
  const now = input.now ?? new Date();
  const { pluginId, provider, target } = input;
  const key = pluginTargetKey(pluginId, provider, target.targetKey);
  const label = clipAvailabilityLabel(target.label) ?? target.targetKey;
  const match = normalizeTargetMatch(target.configMatch);
  const state = storedTargetStateOf(target, label, now);
  return transact(db, async (tx) => {
    const ownerUserId = await existingUserId(tx, target.ownerUserId);
    const findByKey = async () => {
      const [row] = await tx.select().from(aiAccountHosts).where(eq(aiAccountHosts.targetKey, key)).for("update");
      return row ?? null;
    };
    let before = await findByKey();
    let reclaimed = false;
    if (!before) {
      const installedPluginIds = (await installedPlugins(tx)).map((plugin) => plugin.id);
      const [orphan] = await orphanedTargetRows(tx, { provider, targetKey: target.targetKey, installedPluginIds });
      if (orphan) {
        before = orphan;
        reclaimed = true;
      }
    }
    let created = false;
    let deviceId: string;
    if (before) {
      deviceId = before.id;
    } else {
      const inserted = await insertDeviceWithUniqueName(
        tx,
        label,
        { kind: "external", targetKey: key, targetProvider: provider, managedByPluginId: pluginId },
        findByKey,
      );
      created = inserted.inserted;
      deviceId = inserted.row.id;
      if (!inserted.inserted) before = inserted.row;
    }
    const [device] = await tx.update(aiAccountHosts).set({
      targetKey: key,
      targetProvider: provider,
      targetMatch: match,
      targetState: state as unknown as Record<string, unknown>,
      targetReportedAt: now,
      managedByPluginId: pluginId,
      ownerUserId,
      ownerSource: ownerUserId ? "plugin" : null,
      updatedAt: now,
    }).where(eq(aiAccountHosts.id, deviceId)).returning();

    const previous = created ? null : readStoredTargetState(before);
    const typesBefore = created ? null : acceptedCredentialTypes({ driver: "sandbox" }, before, now);
    const typesAfter = acceptedCredentialTypes({ driver: "sandbox" }, device!, now)!;
    return {
      device: device!,
      created,
      reclaimed,
      previous,
      state,
      acceptedCredentialTypes: { before: typesBefore, after: typesAfter },
      changes: {
        becameAvailable: state.state === "available" && (previous?.state === "unavailable" || previous?.state === "retired"),
        becameUnavailable: state.state === "unavailable" && previous?.state !== "unavailable",
        becameRetired: state.state === "retired" && previous?.state !== "retired",
        acceptedCredentialTypesChanged: !created && !sameTypes(typesBefore, typesAfter),
        configMatchChanged: created || reclaimed || !sameTargetMatch(before?.targetMatch, match),
        ownerChanged: (created ? null : before?.ownerUserId ?? null) !== ownerUserId,
      },
    };
  });
}

/**
 * Links an existing device (a `mac` or `ssh_host` row, e.g. the machine
 * behind an SSH tunnel) to a plugin target (spec 6.6): writes the target key,
 * provider and managing plugin onto it, so the plugin's reports update this
 * row. Earlier `external` rows of the same target (also one left by an
 * uninstalled plugin, see `upsertPluginTargetByTargetKey`) are merged: their
 * run slots, explicit mappings and open waits move here, their match rule and
 * last report carry over, and they are deleted. Bindings never reference
 * devices.
 *
 * 404 for an unknown device, or a plugin that is not installed or does not
 * provide `provider`; 409 when the device cannot take a target or has another
 * one, when another installed plugin also provides `provider`, or when the
 * target is already linked to another machine.
 */
export async function linkTarget(
  db: DeviceDb,
  deviceId: string,
  target: LinkDeviceTargetInput,
  opts: { now?: Date } = {},
): Promise<LinkDeviceTargetResult> {
  const now = opts.now ?? new Date();
  return transact(db, async (tx) => {
    const device = await lockDevice(tx, deviceId);
    if (!device) throw notFound("Device not found");
    const key = pluginTargetKey(target.pluginId, target.provider, target.targetKey);
    if (device.targetKey === key) return { device, mergedDeviceIds: [], changed: false, limit: null };
    if (device.kind !== "mac" && device.kind !== "ssh_host") {
      throw conflict(`${device.name} cannot be linked to a plugin target; link a machine reached over SSH instead`);
    }
    if (device.targetKey) throw conflict(`${device.name} is already linked to another target`);
    const installed = await installedPlugins(tx);
    const plugin = installed.find((candidate) => candidate.id === target.pluginId);
    if (!plugin || !plugin.sandboxProviders.includes(target.provider)) {
      throw notFound("No installed plugin provides this target");
    }
    if (installed.filter((candidate) => candidate.sandboxProviders.includes(target.provider)).length > 1) {
      throw conflict(`More than one installed plugin provides "${target.provider}" environments`);
    }
    const exact = await tx.select().from(aiAccountHosts)
      .where(and(eq(aiAccountHosts.targetKey, key), ne(aiAccountHosts.id, device.id)))
      .for("update");
    const orphaned = await orphanedTargetRows(tx, {
      provider: target.provider,
      targetKey: target.targetKey,
      installedPluginIds: installed.map((candidate) => candidate.id),
    });
    const sources = [...exact, ...orphaned.filter((row) => row.id !== device.id && !exact.some((other) => other.id === row.id))];
    const linkedElsewhere = sources.find((row) => row.kind !== "external");
    if (linkedElsewhere) throw conflict(`This target is already linked to ${linkedElsewhere.name}`);
    const latest = [...sources].sort((a, b) => (b.targetReportedAt?.getTime() ?? 0) - (a.targetReportedAt?.getTime() ?? 0))[0] ?? null;
    for (const source of sources) {
      await tx.update(aiAccountRunSlots).set({ deviceId: device.id }).where(eq(aiAccountRunSlots.deviceId, source.id));
      await tx.update(aiAccountHostEnvironments).set({ hostId: device.id }).where(eq(aiAccountHostEnvironments.hostId, source.id));
      await tx.update(resourceWaitEpisodes)
        .set({
          deviceId: device.id,
          // A slot wait is keyed by its device: it stays the same episode on this one.
          resourceKey: sql`case when ${resourceWaitEpisodes.kind} = 'device_slots' then ${`device:${device.id}`} else ${resourceWaitEpisodes.resourceKey} end`,
          updatedAt: now,
        })
        .where(and(eq(resourceWaitEpisodes.deviceId, source.id), isNull(resourceWaitEpisodes.resolvedAt)));
      await tx.delete(aiAccountHosts).where(eq(aiAccountHosts.id, source.id));
    }
    const [updated] = await tx.update(aiAccountHosts).set({
      targetKey: key,
      targetProvider: target.provider,
      managedByPluginId: target.pluginId,
      targetMatch: latest?.targetMatch ?? null,
      targetState: latest?.targetState ?? null,
      targetReportedAt: latest?.targetReportedAt ?? null,
      ownerUserId: latest ? latest.ownerUserId : device.ownerUserId,
      ownerSource: latest ? latest.ownerSource : device.ownerSource,
      updatedAt: now,
    }).where(eq(aiAccountHosts.id, device.id)).returning();
    const [limit] = await markOverLimitIfNeeded(tx, [device.id], { now });
    const linked = limit?.change ? (await lockDevice(tx, device.id)) ?? updated! : updated!;
    return { device: linked, mergedDeviceIds: sources.map((source) => source.id), changed: true, limit: limit ?? null };
  });
}

/**
 * "Likely the same machine" hints (spec 6.6): an `external` device that is
 * not retired, and whose reported alias equals an SSH host of another device
 * (from its `ssh:` key or the SSH environments that reach it), or whose label
 * equals the name of such an SSH environment. Only devices without a target
 * of their own can be linked, so only those are suggested. Hints are keyed by
 * both devices of each pair.
 */
function duplicateHintsFrom(
  devices: readonly ExecutionDeviceRow[],
  sshReach: ReadonlyArray<{ environment: Pick<ExecutionEnvironmentRow, "name" | "config">; device: ExecutionDeviceRow }>,
): Map<string, ExecutionDeviceDuplicateHint[]> {
  const hostsByDevice = new Map<string, Set<string>>();
  const namesByDevice = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, deviceId: string, value: string | null) => {
    if (!value) return;
    const set = map.get(deviceId) ?? new Set<string>();
    set.add(value);
    map.set(deviceId, set);
  };
  for (const device of devices) add(hostsByDevice, device.id, sshHostOfDeviceKey(device.externalKey));
  for (const { environment, device } of sshReach) {
    add(hostsByDevice, device.id, sshHostOfConfig(environment.config));
    add(namesByDevice, device.id, environment.name.trim().toLowerCase() || null);
  }
  const linkable = devices.filter((device) => device.kind !== "external" && !device.targetKey
    && (hostsByDevice.has(device.id) || namesByDevice.has(device.id)));
  const hints = new Map<string, ExecutionDeviceDuplicateHint[]>();
  const push = (deviceId: string, hint: ExecutionDeviceDuplicateHint) => {
    const list = hints.get(deviceId) ?? [];
    if (!list.some((existing) => existing.deviceId === hint.deviceId)) list.push(hint);
    hints.set(deviceId, list);
  };
  for (const external of devices.filter((device) => device.kind === "external")) {
    const stored = readStoredTargetState(external);
    if (stored?.state === "retired") continue;
    const aliases = new Set((stored?.aliases ?? []).map((alias) => alias.toLowerCase()));
    const label = (stored?.label ?? external.name).trim().toLowerCase();
    for (const candidate of linkable) {
      const byAlias = [...(hostsByDevice.get(candidate.id) ?? [])].some((host) => aliases.has(host));
      const byLabel = !byAlias && label.length > 0 && Boolean(namesByDevice.get(candidate.id)?.has(label));
      if (!byAlias && !byLabel) continue;
      const matchedBy = byAlias ? "alias" : "label";
      push(external.id, { deviceId: candidate.id, deviceName: candidate.name, matchedBy });
      push(candidate.id, { deviceId: external.id, deviceName: external.name, matchedBy });
    }
  }
  return hints;
}

/** Likely-duplicate hints for every device, keyed by device id (see `duplicateHintsFrom`). */
export async function likelyDuplicates(db: DeviceDb): Promise<Map<string, ExecutionDeviceDuplicateHint[]>> {
  const devices = await db.select().from(aiAccountHosts).orderBy(asc(aiAccountHosts.name));
  const sshEnvironments = await db.select().from(environments)
    .where(and(eq(environments.driver, "ssh"), eq(environments.status, "active")));
  const resolved = await resolveEnvironmentDevices(db, sshEnvironments, { create: false });
  const reach = sshEnvironments.flatMap((environment) => {
    const entry = resolved.get(environment.id);
    return entry ? [{ environment, device: entry.device }] : [];
  });
  return duplicateHintsFrom(devices, reach);
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

interface DeviceWorld {
  now: Date;
  devices: ExecutionDeviceRow[];
  environmentsByDevice: Map<string, Array<{ environment: ExecutionEnvironmentRow; via: DeviceVia }>>;
  availability: Map<string, EnvironmentAvailabilityRow>;
  bound: Map<string, DeviceBoundAccounts>;
  pluginNames: Map<string, string>;
  hints: Map<string, ExecutionDeviceDuplicateHint[]>;
}

/** Every device with its environments, bound accounts and hints, read without creating devices. */
async function loadDeviceWorld(db: DeviceDb, opts: DeviceSummaryOptions): Promise<DeviceWorld> {
  const now = opts.now ?? new Date();
  const activeEnvironments = await db.select().from(environments).where(eq(environments.status, "active")).orderBy(asc(environments.name));
  const resolved = await resolveEnvironmentDevices(db, activeEnvironments, { create: false });
  const bound = await boundAccountsByDevice(db, { create: false });
  const devices = await db.select().from(aiAccountHosts).orderBy(asc(aiAccountHosts.name));
  const environmentsByDevice = new Map<string, Array<{ environment: ExecutionEnvironmentRow; via: DeviceVia }>>();
  const sshReach: Array<{ environment: ExecutionEnvironmentRow; device: ExecutionDeviceRow }> = [];
  for (const environment of activeEnvironments) {
    const entry = resolved.get(environment.id);
    if (!entry) continue;
    const list = environmentsByDevice.get(entry.device.id) ?? [];
    list.push({ environment, via: entry.via });
    environmentsByDevice.set(entry.device.id, list);
    if (environment.driver === "ssh") sshReach.push({ environment, device: entry.device });
  }
  const availabilityRows = activeEnvironments.length > 0
    ? await db.select().from(environmentAvailability).where(inArray(environmentAvailability.environmentId, activeEnvironments.map((row) => row.id)))
    : [];
  const pluginIds = unique(devices.map((device) => device.managedByPluginId).filter((id): id is string => Boolean(id)));
  const pluginRows = pluginIds.length > 0
    ? await db.select({ id: plugins.id, pluginKey: plugins.pluginKey, manifest: plugins.manifestJson }).from(plugins).where(inArray(plugins.id, pluginIds))
    : [];
  return {
    now,
    devices,
    environmentsByDevice,
    availability: new Map(availabilityRows.map((row) => [row.environmentId, row])),
    bound,
    pluginNames: new Map(pluginRows.map((row) => [row.id, pluginDisplayName(row.pluginKey, row.manifest)])),
    hints: duplicateHintsFrom(devices, sshReach),
  };
}

/**
 * An environment's registry row as a company sees it. An SSH row's label and
 * message can come from the connection itself (a lease error naming the host
 * and port), and `host:port` is shown only in instance-admin views (spec
 * 6.1), so companies get its state, reason and times only.
 */
function companyAvailabilityOf(
  environment: Pick<ExecutionEnvironmentRow, "driver">,
  availability: EnvironmentAvailabilitySummary,
): EnvironmentAvailabilitySummary {
  return environment.driver === "ssh" ? { ...availability, label: null, message: null } : availability;
}

function environmentSummaries(
  world: DeviceWorld,
  device: ExecutionDeviceRow,
  filter: (environment: ExecutionEnvironmentRow) => boolean,
  view: "company" | "instance",
): ExecutionDeviceEnvironmentSummary[] {
  return (world.environmentsByDevice.get(device.id) ?? [])
    .filter(({ environment }) => filter(environment))
    .map(({ environment, via }) => {
      const availability = summarizeEnvironmentAvailability(
        world.availability.get(environment.id),
        acceptedCredentialTypes(environment, device, world.now),
      );
      return {
        id: environment.id,
        name: environment.name,
        driver: environment.driver,
        companyId: environment.companyId ?? null,
        explicit: via === "mapping",
        availability: view === "company" ? companyAvailabilityOf(environment, availability) : availability,
      };
    });
}

function deviceCredentialTypes(device: ExecutionDeviceRow, now: Date): AiAccountCredentialType[] | null {
  return device.targetKey ? acceptedCredentialTypes({ driver: "sandbox" }, device, now) : null;
}

/**
 * The device badge: an unavailable environment (the longest outage) wins, then
 * retired when every environment is retired, else available. A device that
 * no environment reaches shows its target's own last report, if any.
 */
function deviceAvailability(
  device: ExecutionDeviceRow,
  environmentList: readonly ExecutionDeviceEnvironmentSummary[],
  now: Date,
): EnvironmentAvailabilitySummary {
  const types = deviceCredentialTypes(device, now);
  if (environmentList.length === 0) {
    const stored = readStoredTargetState(device);
    return {
      state: stored?.state ?? "available",
      reason: stored?.reason ?? null,
      label: stored?.label ?? null,
      message: stored?.message ?? null,
      unavailableSince: null,
      retryAfter: stored?.retryAfter ?? null,
      checkedAt: iso(device.targetReportedAt),
      acceptedCredentialTypes: types,
    };
  }
  const states = environmentList.map((environment) => environment.availability);
  const unavailable = states
    .filter((state) => state.state === "unavailable")
    .sort((a, b) => (a.unavailableSince ?? "").localeCompare(b.unavailableSince ?? ""))[0];
  if (unavailable) return { ...unavailable, acceptedCredentialTypes: types };
  if (states.every((state) => state.state === "retired")) return { ...states[0]!, acceptedCredentialTypes: types };
  const checkedAt = states.map((state) => state.checkedAt).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
  return {
    state: "available",
    reason: null,
    label: null,
    message: null,
    unavailableSince: null,
    retryAfter: null,
    checkedAt,
    acceptedCredentialTypes: types,
  };
}

async function usersById(db: DeviceDb, userIds: readonly string[]): Promise<Map<string, { name: string | null; email: string | null }>> {
  const ids = unique(userIds.filter(Boolean));
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: authUsers.id, name: authUsers.name, email: authUsers.email }).from(authUsers).where(inArray(authUsers.id, ids));
  return new Map(rows.map((row) => [row.id, { name: row.name || null, email: row.email || null }]));
}

function ownerOf(
  userId: string | null | undefined,
  users: Map<string, { name: string | null; email: string | null }>,
): ExecutionDeviceOwner | null {
  if (!userId) return null;
  const user = users.get(userId);
  return { userId, name: user?.name ?? null, email: user?.email ?? null };
}

type AccountRow = Pick<typeof aiAccounts.$inferSelect,
  "id" | "label" | "credentialType" | "status" | "adminDisabledAt" | "exhaustedUntil" | "ownerUserId" | "createdByUserId">;

async function accountsById(db: DeviceDb, accountIds: readonly string[]): Promise<Map<string, AccountRow>> {
  const ids = unique(accountIds);
  if (ids.length === 0) return new Map();
  const rows = await db.select({
    id: aiAccounts.id,
    label: aiAccounts.label,
    credentialType: aiAccounts.credentialType,
    status: aiAccounts.status,
    adminDisabledAt: aiAccounts.adminDisabledAt,
    exhaustedUntil: aiAccounts.exhaustedUntil,
    ownerUserId: aiAccounts.ownerUserId,
    createdByUserId: aiAccounts.createdByUserId,
  }).from(aiAccounts).where(inArray(aiAccounts.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

function effectiveOwnerId(account: Pick<AccountRow, "ownerUserId" | "createdByUserId">): string | null {
  return account.ownerUserId ?? account.createdByUserId ?? null;
}

function accountRef(account: AccountRow, now: Date): ExecutionDeviceAccountRef {
  return {
    id: account.id,
    label: account.label,
    credentialType: account.credentialType,
    state: deriveAiAccountState({ status: account.status, adminDisabledAt: account.adminDisabledAt, exhaustedUntil: account.exhaustedUntil }, now),
  };
}

/** Users who are active `user` members of the company; in `local_trusted` mode also the local board user. */
async function activeMemberUserIds(db: DeviceDb, companyId: string, deploymentMode: DeploymentMode | undefined): Promise<Set<string>> {
  const rows = await db.select({ userId: companyMemberships.principalId }).from(companyMemberships).where(and(
    eq(companyMemberships.companyId, companyId),
    eq(companyMemberships.principalType, "user"),
    eq(companyMemberships.status, "active"),
  ));
  const members = new Set(rows.map((row) => row.userId));
  if (deploymentMode === "local_trusted") members.add(LOCAL_BOARD_USER_ID);
  return members;
}

interface CompanyWait {
  episodeId: string;
  runId: string | null;
  agentId: string;
  agentName: string;
  issueId: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
  kind: string;
  reason: string;
  environmentId: string | null;
  deviceId: string | null;
  since: Date;
  resumeAt: Date | null;
}

async function openCompanyWaits(db: DeviceDb, companyId: string): Promise<CompanyWait[]> {
  return db
    .select({
      episodeId: resourceWaitEpisodes.id,
      runId: resourceWaitEpisodes.currentRunId,
      agentId: resourceWaitEpisodes.agentId,
      agentName: agents.name,
      issueId: resourceWaitEpisodes.issueId,
      issueIdentifier: issues.identifier,
      issueTitle: issues.title,
      kind: resourceWaitEpisodes.kind,
      reason: resourceWaitEpisodes.reason,
      environmentId: resourceWaitEpisodes.environmentId,
      deviceId: resourceWaitEpisodes.deviceId,
      since: resourceWaitEpisodes.since,
      resumeAt: resourceWaitEpisodes.resumeAt,
    })
    .from(resourceWaitEpisodes)
    .innerJoin(agents, and(eq(agents.id, resourceWaitEpisodes.agentId), eq(agents.companyId, resourceWaitEpisodes.companyId)))
    .leftJoin(issues, and(eq(issues.id, resourceWaitEpisodes.issueId), eq(issues.companyId, resourceWaitEpisodes.companyId)))
    .where(and(eq(resourceWaitEpisodes.companyId, companyId), isNull(resourceWaitEpisodes.resolvedAt)))
    .orderBy(asc(resourceWaitEpisodes.since));
}

interface CompanyDeviceView {
  visible: Set<string>;
  summaries: ExecutionDeviceSummary[];
  waitsFor(deviceId: string): ExecutionDeviceWaitSummary[];
}

async function companyDeviceView(db: DeviceDb, companyId: string, opts: DeviceSummaryOptions): Promise<CompanyDeviceView> {
  const companyAgents = await db
    .select({ id: agents.id, name: agents.name, companyId: agents.companyId, adapterType: agents.adapterType, defaultEnvironmentId: agents.defaultEnvironmentId })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")))
    .orderBy(asc(agents.name));
  // Only this company's own placements may create a device on first use; the
  // rest of the world is read as it is.
  const placements = await candidateDevicesForAgents(db, companyAgents, opts);
  const world = await loadDeviceWorld(db, opts);
  const now = world.now;
  const bindings = new Map((await db
    .select({ agentId: aiAccountAgentBindings.agentId, mode: aiAccountAgentBindings.mode, accountId: aiAccountAgentBindings.accountId })
    .from(aiAccountAgentBindings)
    .where(eq(aiAccountAgentBindings.companyId, companyId))).map((row) => [row.agentId, row]));

  // A device is visible to the company when its agents can run there, or the
  // managing plugin lists the company among the ones the device serves.
  const agentsByDevice = new Map<string, typeof companyAgents>();
  for (const agent of companyAgents) {
    for (const device of distinctDevices(placements.get(agent.id) ?? [])) {
      const list = agentsByDevice.get(device.id) ?? [];
      list.push(agent);
      agentsByDevice.set(device.id, list);
    }
  }
  const visibleDevices = world.devices.filter((device) =>
    agentsByDevice.has(device.id)
    || Boolean(readStoredTargetState(device)?.servedCompanyIds.some((id) => id.toLowerCase() === companyId.toLowerCase())));
  const visible = new Set(visibleDevices.map((device) => device.id));

  const accountIds = unique([
    ...visibleDevices.flatMap((device) => [...(world.bound.get(device.id)?.accountIds ?? [])]),
    ...[...bindings.values()].map((binding) => binding.accountId).filter((id): id is string => Boolean(id)),
  ]);
  const accounts = await accountsById(db, accountIds);
  const members = await activeMemberUserIds(db, companyId, opts.deploymentMode);
  // An account's label is shown only where its owner is an active member.
  const labelVisible = (accountId: string | null | undefined) => {
    const account = accountId ? accounts.get(accountId) : undefined;
    const owner = account ? effectiveOwnerId(account) : null;
    return Boolean(account && owner && members.has(owner));
  };
  const users = await usersById(db, visibleDevices.map((device) => device.ownerUserId).filter((id): id is string => Boolean(id)));
  const waits = await openCompanyWaits(db, companyId);

  const environmentFilter = (environment: ExecutionEnvironmentRow) => isEnvironmentAvailableToCompany(environment, companyId);
  const deviceEnvironmentIds = (deviceId: string) =>
    new Set((world.environmentsByDevice.get(deviceId) ?? []).map(({ environment }) => environment.id));
  const waitsOn = (deviceId: string) => {
    const environmentIds = deviceEnvironmentIds(deviceId);
    return waits.filter((wait) => wait.deviceId === deviceId || (wait.environmentId !== null && environmentIds.has(wait.environmentId)));
  };

  const summaries = visibleDevices.map((device): ExecutionDeviceSummary => {
    // The device badge is derived from this list, so it carries no SSH text either.
    const environmentList = environmentSummaries(world, device, environmentFilter, "company");
    const bound = world.bound.get(device.id);
    const boundIds = [...(bound?.accountIds ?? [])];
    const shown = boundIds.filter(labelVisible).map((id) => accounts.get(id)!).sort((a, b) => a.label.localeCompare(b.label));
    const limit = capOf(device);
    const inUse = boundIds.length;
    const onDevice = agentsByDevice.get(device.id) ?? [];
    return {
      id: device.id,
      name: device.name,
      kind: device.kind,
      managedByPluginId: device.managedByPluginId,
      managedByPluginName: device.managedByPluginId ? world.pluginNames.get(device.managedByPluginId) ?? null : null,
      owner: ownerOf(device.ownerUserId, users),
      limit,
      inUse,
      overLimit: inUse > limit,
      overLimitSince: inUse > limit ? iso(device.overLimitAt) : null,
      availability: deviceAvailability(device, environmentList, now),
      environments: environmentList,
      accounts: shown.map((account) => accountRef(account, now)),
      otherCompaniesAccounts: inUse - shown.length,
      agents: onDevice.map((agent) => {
        const binding = bindings.get(agent.id);
        return {
          agentId: agent.id,
          agentName: agent.name,
          mode: binding?.mode ?? null,
          accountId: binding?.mode === "pool_account" && labelVisible(binding.accountId) ? binding.accountId : null,
        };
      }),
      ownLoginAgents: onDevice.filter((agent) => bindings.get(agent.id)?.mode !== "pool_account").length,
      acceptedCredentialTypes: deviceCredentialTypes(device, now),
      duplicateHints: (world.hints.get(device.id) ?? []).filter((hint) => visible.has(hint.deviceId)),
      waitingCount: waitsOn(device.id).length,
    };
  });

  return {
    visible,
    summaries,
    waitsFor: (deviceId) => waitsOn(deviceId).flatMap((wait): ExecutionDeviceWaitSummary[] => wait.runId ? [{
      runId: wait.runId,
      agentId: wait.agentId,
      agentName: wait.agentName,
      issueId: wait.issueId,
      issueIdentifier: wait.issueIdentifier ?? null,
      issueTitle: wait.issueTitle ?? null,
      kind: wait.kind as ResourceWaitKind,
      reason: wait.reason as ResourceWaitReason,
      since: wait.since.toISOString(),
      resumeAt: iso(wait.resumeAt),
    }] : []),
  };
}

/**
 * The devices a company sees (spec 12): those its agents' candidate
 * environments map to, and those whose plugin lists the company among the
 * ones the device serves. Only environments available to the company are
 * listed. Accounts appear with labels only where their owner is an active
 * member of the company; every other account is a count. The device owner is
 * shown for display only. An SSH environment's availability carries no label
 * or message here, since those can name its host (instance view only).
 */
export async function summariesForCompany(
  db: DeviceDb,
  companyId: string,
  opts: DeviceSummaryOptions = {},
): Promise<ExecutionDeviceSummary[]> {
  return (await companyDeviceView(db, companyId, opts)).summaries;
}

/** One device as the company sees it, with the company's waits on it; null when the company cannot see it. */
export async function detailForCompany(
  db: DeviceDb,
  companyId: string,
  deviceId: string,
  opts: DeviceSummaryOptions = {},
): Promise<ExecutionDeviceDetail | null> {
  const view = await companyDeviceView(db, companyId, opts);
  const summary = view.summaries.find((candidate) => candidate.id === deviceId);
  return summary ? { ...summary, waits: view.waitsFor(deviceId) } : null;
}

/** Every device with keys, owner, cap, over-limit state, duplicate hints, and accounts with labels (instance admins only). */
export async function summariesForInstance(
  db: DeviceDb,
  opts: DeviceSummaryOptions = {},
): Promise<InstanceExecutionDeviceSummary[]> {
  const allAgents = await db
    .select({ id: agents.id, companyId: agents.companyId, adapterType: agents.adapterType, defaultEnvironmentId: agents.defaultEnvironmentId })
    .from(agents)
    .where(ne(agents.status, "terminated"));
  const placements = await candidateDevicesForAgents(db, allAgents, opts);
  const world = await loadDeviceWorld(db, opts);
  const now = world.now;
  const agentCounts = new Map<string, Map<string, number>>();
  for (const agent of allAgents) {
    for (const device of distinctDevices(placements.get(agent.id) ?? [])) {
      const counts = agentCounts.get(device.id) ?? new Map<string, number>();
      counts.set(agent.companyId, (counts.get(agent.companyId) ?? 0) + 1);
      agentCounts.set(device.id, counts);
    }
  }
  const companyNames = new Map((await db.select({ id: companies.id, name: companies.name }).from(companies)).map((row) => [row.id, row.name]));
  const accounts = await accountsById(db, world.devices.flatMap((device) => [...(world.bound.get(device.id)?.accountIds ?? [])]));
  const users = await usersById(db, [
    ...world.devices.map((device) => device.ownerUserId).filter((id): id is string => Boolean(id)),
    ...[...accounts.values()].map(effectiveOwnerId).filter((id): id is string => Boolean(id)),
  ]);
  return world.devices.map((device): InstanceExecutionDeviceSummary => {
    const environmentList = environmentSummaries(world, device, () => true, "instance");
    const boundIds = [...(world.bound.get(device.id)?.accountIds ?? [])];
    const limit = capOf(device);
    const inUse = boundIds.length;
    const stored = readStoredTargetState(device);
    return {
      id: device.id,
      name: device.name,
      kind: device.kind,
      maxAccounts: device.maxAccounts,
      limit,
      inUse,
      overLimit: inUse > limit,
      overLimitSince: inUse > limit ? iso(device.overLimitAt) : null,
      externalKey: device.externalKey,
      targetKey: device.targetKey,
      targetProvider: device.targetProvider,
      targetMatch: device.targetMatch ?? null,
      targetReportedAt: iso(device.targetReportedAt),
      managedByPluginId: device.managedByPluginId,
      managedByPluginName: device.managedByPluginId ? world.pluginNames.get(device.managedByPluginId) ?? null : null,
      owner: ownerOf(device.ownerUserId, users),
      aliases: stored?.aliases ?? [],
      servedCompanyIds: stored?.servedCompanyIds ?? [],
      availability: deviceAvailability(device, environmentList, now),
      acceptedCredentialTypes: deviceCredentialTypes(device, now),
      environments: environmentList,
      accounts: boundIds
        .map((id) => accounts.get(id))
        .filter((account): account is AccountRow => account !== undefined)
        .sort((a, b) => a.label.localeCompare(b.label))
        .map((account) => {
          const ownerId = effectiveOwnerId(account);
          const owner: AiAccountOwnerRef | null = ownerOf(ownerId, users);
          return { ...accountRef(account, now), owner };
        }),
      companies: [...(agentCounts.get(device.id) ?? new Map<string, number>())]
        .map(([companyId, agentCount]) => ({ companyId, companyName: companyNames.get(companyId) ?? "", agentCount }))
        .sort((a, b) => a.companyName.localeCompare(b.companyName)),
      duplicateHints: world.hints.get(device.id) ?? [],
      createdAt: device.createdAt.toISOString(),
    };
  });
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** The functions above bound to one database handle or transaction. */
export function executionDeviceService(db: DeviceDb) {
  return {
    deviceForEnvironment: (environment: DeviceEnvironmentRef | null | undefined, opts?: DeviceResolutionOptions) =>
      deviceForEnvironment(db, environment, opts),
    devicesForEnvironments: (environmentList: readonly DeviceEnvironmentRef[], opts?: DeviceResolutionOptions) =>
      devicesForEnvironments(db, environmentList, opts),
    devicesForEnvironmentIds: (environmentIds: readonly string[], opts?: DeviceResolutionOptions) =>
      devicesForEnvironmentIds(db, environmentIds, opts),
    environmentsForDevice: (deviceId: string) => environmentsForDevice(db, deviceId),
    environmentsMatchingTarget: (input: { provider: string; match: Record<string, string>; deviceId: string }) =>
      environmentsMatchingTarget(db, input),
    candidateEnvironmentIds: (agent: DevicePlacementAgent) => candidateEnvironmentIds(db, agent),
    candidateDevicesForAgent: (agent: DevicePlacementAgent, opts?: DeviceResolutionOptions) => candidateDevicesForAgent(db, agent, opts),
    candidateDevicesForAgents: (agentList: readonly DevicePlacementAgent[], opts?: DeviceResolutionOptions) =>
      candidateDevicesForAgents(db, agentList, opts),
    boundAccountsByDevice: (opts?: BoundAccountsOptions) => boundAccountsByDevice(db, opts),
    runningPoolAccountsOnDevice: (deviceId: string, excludeRunId?: string | null) => runningPoolAccountsOnDevice(db, deviceId, excludeRunId),
    insertRunSlot: (slot: Parameters<typeof insertRunSlot>[1]) => insertRunSlot(db, slot),
    pruneRunSlots: (input?: Parameters<typeof pruneRunSlots>[1]) => pruneRunSlots(db, input),
    markOverLimitIfNeeded: (deviceIds?: readonly string[] | null, opts?: { now?: Date }) => markOverLimitIfNeeded(db, deviceIds, opts),
    providerPlugins: (provider: string) => providerPlugins(db, provider),
    soleProviderPlugin: (provider: string) => soleProviderPlugin(db, provider),
    isSoleProviderPlugin: (pluginId: string, provider: string) => isSoleProviderPlugin(db, pluginId, provider),
    upsertPluginTargetByTargetKey: (input: UpsertPluginTargetInput) => upsertPluginTargetByTargetKey(db, input),
    linkTarget: (deviceId: string, target: LinkDeviceTargetInput, opts?: { now?: Date }) => linkTarget(db, deviceId, target, opts),
    likelyDuplicates: () => likelyDuplicates(db),
    summariesForCompany: (companyId: string, opts?: DeviceSummaryOptions) => summariesForCompany(db, companyId, opts),
    detailForCompany: (companyId: string, deviceId: string, opts?: DeviceSummaryOptions) => detailForCompany(db, companyId, deviceId, opts),
    summariesForInstance: (opts?: DeviceSummaryOptions) => summariesForInstance(db, opts),
  };
}

export type ExecutionDeviceService = ReturnType<typeof executionDeviceService>;
