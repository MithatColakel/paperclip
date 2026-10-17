import { and, asc, eq, sql } from "drizzle-orm";
import { type Db, aiAccountHosts, companyMemberships, environments, instanceUserRoles } from "@paperclipai/db";
import type { DeploymentMode } from "@paperclipai/shared";
import {
  ENSURE_COMPANY_ENVIRONMENT_LIMITS,
  ENVIRONMENT_TARGET_REPORT_LIMITS,
  InvocationScopeDeniedError,
  PLUGIN_RPC_ERROR_CODES,
  pluginEnsureCompanyEnvironmentParamsSchema,
  pluginEnvironmentReportTargetsParamsSchema,
  type PluginEnsureCompanyEnvironmentParams,
  type PluginEnsureCompanyEnvironmentResult,
  type PluginEnvironmentReportTargetsResult,
  type PluginEnvironmentTargetReport,
  type WorkerHostCallContext,
} from "@paperclipai/plugin-sdk";
import { resolveDeploymentMode } from "../config-file.js";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { recheckDeviceLimits } from "./ai-account-pool.js";
import { environmentAvailabilityService, type AvailabilityWriteResult } from "./environment-availability.js";
import { normalizeEnvironmentConfig } from "./environment-config.js";
import { environmentService } from "./environments.js";
import {
  deviceForEnvironment,
  environmentsMatchingTarget,
  isSoleProviderPlugin,
  targetAvailabilityOf,
  upsertPluginTargetByTargetKey,
  type DeviceEnvironmentRef,
  type ExecutionDeviceRow,
  type PluginTargetUpsertResult,
} from "./execution-devices.js";
import { collectSecretRefPaths, readConfigValueAtPath } from "./json-schema-secret-refs.js";
import { resolvePluginSandboxProviderDriverById } from "./plugin-environment-driver.js";
import { invocationBoardUser } from "./plugin-invocation-facts.js";
import { wakeResourceWaits, type ResourceWaitWakeFilter } from "./resource-waits/wake.js";
import { isBuiltinSandboxProvider } from "./sandbox-provider-runtime.js";

/**
 * Fork: the host side of `environments.reportTargets` and
 * `environments.ensureCompanyEnvironment` (spec 9.4–9.6), the worker→host
 * methods of environment driver plugins. Both need the
 * `environment.drivers.register` capability (checked by the SDK's handler
 * factory), and both act only for a `sandbox_provider` driver key that the
 * calling plugin declares and no other installed plugin does, and never for a
 * built-in sandbox provider.
 *
 * reportTargets: a plugin reports the state of its targets (machines). Each
 * target upserts its execution device by target key, and its state goes onto
 * the availability rows of the active environments it runs. After the writes
 * commit, waiting runs are woken from what changed per environment: a target
 * that came back wakes the environment's target-scope waits; `wake` (something
 * that affects admission changed) and a retired target wake every wait on its
 * environments; a change of accepted credential types also wakes the account
 * waits that wait for a credential type. An owner change alone wakes nothing.
 * Invalid targets are dropped, the rest are kept; more than 500 targets refuse
 * the whole call.
 *
 * ensureCompanyEnvironment: inside a `performAction` by a board user with
 * write access to the company, finds or creates the company's environment for
 * one target. Idempotent per (company, driver, match) under an advisory lock.
 * The provider is forced to the driver key; no env vars, secret references or
 * secret fields; the plugin's `validateConfig` is not called (the plugin is
 * the caller). The new environment's availability row starts from its
 * device's last report, read under a share lock so a report of that target
 * that is still in flight lands first.
 *
 * Device caps are re-checked after a commit that can make more environments
 * run on a device, through the account pool's `recheckDeviceLimits`: the one
 * writer of the `execution_device.over_limit` notice, which goes to each
 * company whose agents count toward a device that goes over its cap.
 */

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface PluginEnvironmentTargetsOptions {
  /** The calling plugin's id (`plugins.id`). */
  pluginId: string;
  /** The calling plugin's key, for activity details. */
  pluginKey: string;
  /** In `local_trusted` the local board user writes in every company. Defaults to the configured mode. */
  deploymentMode?: DeploymentMode;
  /** Makes matching waiting runs due; defaults to `wakeResourceWaits`. */
  wakeWaits?: (filter: ResourceWaitWakeFilter, now: Date) => Promise<unknown>;
  /** The clock (tests pass a fixed one). */
  now?: () => Date;
}

/** What one target's transaction wrote. */
interface AppliedTarget {
  deviceId: string;
  /** A new device was inserted for the target. */
  created: boolean;
  changes: PluginTargetUpsertResult["changes"];
  environmentIds: string[];
  writes: AvailabilityWriteResult[];
}

/** Environments to wake after a report, per filter. */
interface ReportWakes {
  /** Every wait (a report's `wake`, a retired target). */
  all: Set<string>;
  /** Target-scope waits (a target that came back). */
  targetScope: Set<string>;
  /** Accepted credential types changed. */
  credentialTypes: Set<string>;
}

const LOCAL_BOARD_USER_ID = "local-board";
const ENSURE_METHOD = "environments.ensureCompanyEnvironment";
const MAX_NAME_ATTEMPTS = 1000;
/** The leading characters every name candidate shares with the requested name. */
const NAME_STEM_LENGTH = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The first issue of a failed parse, as `path: message` (never the value). */
function firstIssue(error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> }): string {
  const issue = error.issues[0];
  if (!issue) return "invalid params";
  const path = issue.path.map((part) => String(part)).join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/** Cuts text to `max` characters without splitting a surrogate pair. */
function cutText(value: string, max: number): string {
  if (value.length <= max) return value;
  const end = /[\uD800-\uDBFF]/.test(value.charAt(max - 1)) ? max - 1 : max;
  return value.slice(0, end).trimEnd();
}

/** `name`, then `name (2)`, `name (3)`…, each within the SDK's name limit. */
export function environmentNameCandidate(name: string, n: number): string {
  if (n <= 1) return name;
  const suffix = ` (${n})`;
  return `${cutText(name, ENSURE_COMPANY_ENVIRONMENT_LIMITS.nameMaxLength - suffix.length)}${suffix}`;
}

/** A match rule with sorted keys, so equal rules give one lock and one lookup. */
export function canonicalTargetMatch(match: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(match).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The text whose `hashtext` keys ensureCompanyEnvironment's advisory lock: one lock per (company, driver, match). */
export function companyEnvironmentLockKey(companyId: string, driverKey: string, match: Record<string, string>): string {
  return `${companyId}:${driverKey}:${JSON.stringify(canonicalTargetMatch(match))}`;
}

function notSoleProvider(pluginKey: string, driverKey: string): Error {
  return Object.assign(
    new Error(`Plugin "${pluginKey}" may not act for sandbox provider "${driverKey}": it must declare it, no other installed plugin may, and it may not be a built-in provider.`),
    { code: PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED },
  );
}

/**
 * The device a new environment runs on, re-read `FOR SHARE` to seed from. A
 * report of that target still in flight holds the row `FOR UPDATE`
 * (`upsertPluginTargetByTargetKey`) and has looked for its environments
 * without seeing this uncommitted one, so the seed waits for that commit and
 * starts from its state. A report that starts later waits for this commit and
 * then writes the new environment's row itself. A device merged away in
 * between gives no seed (a missing row means available until the next report).
 */
async function lockedDeviceForEnvironment(tx: Tx, environment: DeviceEnvironmentRef): Promise<ExecutionDeviceRow | null> {
  const resolved = await deviceForEnvironment(tx, environment);
  if (!resolved) return null;
  const [row] = await tx.select().from(aiAccountHosts).where(eq(aiAccountHosts.id, resolved.id)).for("share");
  return row ?? null;
}

function configuredDeploymentMode(): DeploymentMode | undefined {
  try {
    return resolveDeploymentMode();
  } catch (error) {
    logger.warn({ err: error }, "plugin environment targets could not read the deployment mode; the local board user is treated as a plain user");
    return undefined;
  }
}

export function pluginEnvironmentTargetsService(db: Db, options: PluginEnvironmentTargetsOptions) {
  const { pluginId, pluginKey } = options;
  const clock = options.now ?? (() => new Date());
  const wakeWaits = options.wakeWaits ?? ((filter: ResourceWaitWakeFilter, now: Date) => wakeResourceWaits(db, filter, { now }));
  let deploymentMode: DeploymentMode | undefined | null = options.deploymentMode ?? null;
  const currentDeploymentMode = () => {
    if (deploymentMode === null) deploymentMode = configuredDeploymentMode();
    return deploymentMode;
  };

  // -------------------------------------------------------------------------
  // reportTargets
  // -------------------------------------------------------------------------

  /** The call itself: an object, a valid driver key and at most 500 targets. */
  function readReport(params: unknown): { driverKey: string; targets: unknown[] } {
    if (!isRecord(params)) throw new Error("environments.reportTargets: params must be an object");
    const head = pluginEnvironmentReportTargetsParamsSchema.safeParse({ driverKey: params.driverKey, targets: [] });
    if (!head.success) throw new Error(`environments.reportTargets: ${firstIssue(head.error)}`);
    if (!Array.isArray(params.targets)) throw new Error("environments.reportTargets: targets must be an array");
    if (params.targets.length > ENVIRONMENT_TARGET_REPORT_LIMITS.maxTargets) {
      throw new Error(`environments.reportTargets: at most ${ENVIRONMENT_TARGET_REPORT_LIMITS.maxTargets} targets per call`);
    }
    return { driverKey: head.data.driverKey, targets: params.targets };
  }

  /** Each target on its own: an invalid one, or a repeated target key, is dropped and the rest are kept. */
  function validTargets(driverKey: string, raw: readonly unknown[]): PluginEnvironmentTargetReport[] {
    const targets: PluginEnvironmentTargetReport[] = [];
    const seen = new Set<string>();
    const dropped: string[] = [];
    raw.forEach((candidate, index) => {
      const parsed = pluginEnvironmentReportTargetsParamsSchema.safeParse({ driverKey, targets: [candidate] });
      const target = parsed.success ? parsed.data.targets[0] : undefined;
      if (!target) {
        dropped.push(`targets.${index}: ${parsed.success ? "missing" : firstIssue(parsed.error).replace(/^targets\.0\.?/, "")}`);
        return;
      }
      if (seen.has(target.targetKey)) {
        dropped.push(`targets.${index}: repeated targetKey`);
        return;
      }
      seen.add(target.targetKey);
      targets.push(target);
    });
    if (dropped.length > 0) {
      logger.warn({ pluginId, driverKey, dropped: dropped.length, first: dropped[0] }, "plugin target report: invalid targets dropped");
    }
    return targets;
  }

  /** One target in one transaction: its device, then its environments' availability rows. */
  async function applyTarget(driverKey: string, target: PluginEnvironmentTargetReport, now: Date): Promise<AppliedTarget> {
    return db.transaction(async (tx) => {
      const upserted = await upsertPluginTargetByTargetKey(tx, { pluginId, provider: driverKey, target, now });
      const matching = await environmentsMatchingTarget(tx, {
        provider: driverKey,
        match: target.configMatch,
        deviceId: upserted.device.id,
      });
      const environmentIds = matching.map((environment) => environment.id);
      const state = targetAvailabilityOf(upserted.device, now);
      const writes = state && environmentIds.length > 0
        ? await environmentAvailabilityService(tx).applyTargetState(environmentIds, state, { now })
        : [];
      return { deviceId: upserted.device.id, created: upserted.created, changes: upserted.changes, environmentIds, writes };
    });
  }

  function noteWakes(wakes: ReportWakes, target: PluginEnvironmentTargetReport, applied: AppliedTarget): void {
    if (target.wake === true) {
      for (const environmentId of applied.environmentIds) wakes.all.add(environmentId);
    }
    for (const write of applied.writes) {
      if (write.becameRetired) wakes.all.add(write.environmentId);
      if (write.becameAvailable) wakes.targetScope.add(write.environmentId);
      if (write.acceptedCredentialTypesChanged) wakes.credentialTypes.add(write.environmentId);
    }
  }

  /**
   * After commit. A retired target or a report's `wake` wakes every wait on
   * the environments (retired ones then refuse). A target that came back
   * wakes the target-scope waits; so does a credential-type change, which
   * also wakes the account waits that wait for a credential type there.
   */
  async function wakeAfterReport(wakes: ReportWakes, now: Date): Promise<unknown> {
    const notAll = (ids: Iterable<string>) => [...new Set(ids)].filter((id) => !wakes.all.has(id));
    const filters: ResourceWaitWakeFilter[] = [];
    if (wakes.all.size > 0) filters.push({ environmentIds: [...wakes.all] });
    const targetScope = notAll([...wakes.targetScope, ...wakes.credentialTypes]);
    if (targetScope.length > 0) filters.push({ environmentIds: targetScope, scopes: ["target"] });
    const credentialTypes = notAll(wakes.credentialTypes);
    if (credentialTypes.length > 0) {
      filters.push({ environmentIds: credentialTypes, kinds: ["ai_account"], reasons: ["credential_type_unsupported"] });
    }
    let failure: unknown = null;
    for (const filter of filters) {
      try {
        await wakeWaits(filter, now);
      } catch (error) {
        failure ??= error;
        logger.warn({ pluginId, err: errorMessage(error) }, "plugin target report: waking waiting runs failed");
      }
    }
    return failure;
  }

  async function reportTargets(params: unknown, _context?: WorkerHostCallContext): Promise<PluginEnvironmentReportTargetsResult> {
    const report = readReport(params);
    // A built-in provider's environments are not the plugin's, even when the manifest declares its key.
    if (isBuiltinSandboxProvider(report.driverKey) || !(await isSoleProviderPlugin(db, pluginId, report.driverKey))) {
      throw notSoleProvider(pluginKey, report.driverKey);
    }
    const targets = validTargets(report.driverKey, report.targets);
    const now = clock();
    const wakes: ReportWakes = { all: new Set(), targetScope: new Set(), credentialTypes: new Set() };
    const rematched = new Set<string>();
    let accepted = 0;
    let failed = 0;
    for (const target of targets) {
      let applied: AppliedTarget;
      try {
        applied = await applyTarget(report.driverKey, target, now);
      } catch (error) {
        failed += 1;
        logger.warn({ pluginId, driverKey: report.driverKey, targetKey: target.targetKey, err: errorMessage(error) }, "plugin target report: a target could not be saved");
        continue;
      }
      accepted += 1;
      noteWakes(wakes, target, applied);
      // A new device or a new match rule can put more environments, and so more bound accounts, on the device.
      if (applied.created || applied.changes.configMatchChanged) rematched.add(applied.deviceId);
    }
    const wakeFailure = await wakeAfterReport(wakes, now);
    await checkDeviceLimits([...rematched], now);
    // The plugin sends a failed report again (and keeps its wakes), so a saved
    // part is only written once more.
    if (failed > 0) throw new Error(`environments.reportTargets: ${failed} of ${targets.length} targets could not be saved; send the report again`);
    if (wakeFailure) throw new Error("environments.reportTargets: the report was saved, but waiting runs could not be woken; send the report again");
    return { accepted };
  }

  // -------------------------------------------------------------------------
  // Device caps
  // -------------------------------------------------------------------------

  /**
   * Re-runs the cap check for devices whose environments may have changed
   * (spec 5.6). The account pool's check is the one writer of the over-limit
   * notice: a device that goes over its cap gets `execution_device.over_limit`
   * in each company whose agents count toward it; the device page shows the
   * flag.
   */
  async function checkDeviceLimits(deviceIds: string[], now: Date): Promise<void> {
    if (deviceIds.length === 0) return;
    try {
      await recheckDeviceLimits(db, { deviceIds, now });
    } catch (error) {
      // The flag is recomputed by the next placement or mapping change.
      logger.warn({ pluginId, deviceIds, err: errorMessage(error) }, "plugin environment targets: device cap check failed");
    }
  }

  // -------------------------------------------------------------------------
  // ensureCompanyEnvironment
  // -------------------------------------------------------------------------

  /**
   * Write access as the board routes grant it for a POST: `local_trusted`'s
   * local board user, an active non-viewer member, or an instance admin who is
   * an active member.
   */
  async function canWriteCompany(companyId: string, userId: string): Promise<boolean> {
    if (userId === LOCAL_BOARD_USER_ID && currentDeploymentMode() === "local_trusted") return true;
    const [membership] = await db
      .select({ role: companyMemberships.membershipRole })
      .from(companyMemberships)
      .where(and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userId),
        eq(companyMemberships.status, "active"),
      ))
      .limit(1);
    if (!membership) return false;
    if (membership.role !== "viewer") return true;
    const [admin] = await db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .limit(1);
    return Boolean(admin);
  }

  /**
   * The config to store: the driver key as provider, the sandbox envelope
   * checked, and every secret field of the provider's config schema left
   * empty (a bare secret id there would bind a company secret; plain text
   * would be stored in the open).
   */
  async function companyEnvironmentConfig(input: PluginEnsureCompanyEnvironmentParams): Promise<Record<string, unknown>> {
    let config: Record<string, unknown>;
    try {
      config = normalizeEnvironmentConfig({ driver: "sandbox", config: { ...input.config, provider: input.driverKey } });
    } catch (error) {
      throw new Error(`${ENSURE_METHOD}: invalid config: ${errorMessage(error)}`);
    }
    const declared = await resolvePluginSandboxProviderDriverById({ db, pluginId, driverKey: input.driverKey });
    const schema = declared?.driver.configSchema;
    for (const path of collectSecretRefPaths(isRecord(schema) ? schema : null)) {
      const value = readConfigValueAtPath(config, path);
      if (value === undefined || value === null || (typeof value === "string" && value.trim().length === 0)) continue;
      throw new Error(`${ENSURE_METHOD}: config.${path} is a secret field; set it from the environment settings instead`);
    }
    return config;
  }

  async function findCompanyEnvironment(tx: Tx, input: { companyId: string; driverKey: string; match: Record<string, string> }) {
    const [row] = await tx
      .select({ id: environments.id, name: environments.name })
      .from(environments)
      .where(and(
        eq(environments.companyId, input.companyId),
        eq(environments.driver, "sandbox"),
        eq(environments.status, "active"),
        sql`${environments.config} ->> 'provider' = ${input.driverKey}`,
        sql`${environments.config} @> ${JSON.stringify(input.match)}::jsonb`,
      ))
      .orderBy(asc(environments.createdAt), asc(environments.id))
      .limit(1);
    return row ?? null;
  }

  /** Creates the environment through the environments service, with ` (n)` appended while the name is taken. */
  async function createWithUniqueName(
    tx: Tx,
    input: { companyId: string; name: string; description: string | null; config: Record<string, unknown> },
  ) {
    // Names already taken among those sharing the first characters (counted in code points, as `left` does).
    const stem = cutText(input.name, NAME_STEM_LENGTH);
    const taken = new Set((await tx
      .select({ name: environments.name })
      .from(environments)
      .where(sql`left(${environments.name}, ${Array.from(stem).length}) = ${stem}`)).map((row) => row.name));
    const service = environmentService(db);
    for (let n = 1; n <= MAX_NAME_ATTEMPTS; n += 1) {
      const name = environmentNameCandidate(input.name, n);
      if (taken.has(name)) continue;
      try {
        // A savepoint, so a name taken concurrently does not abort the transaction.
        return await tx.transaction((savepoint) => service.create({
          companyId: input.companyId,
          name,
          description: input.description,
          driver: "sandbox",
          status: "active",
          config: input.config,
          envVars: {},
          metadata: null,
        }, undefined, { db: savepoint }));
      } catch (error) {
        if (!(error instanceof HttpError && error.status === 409)) throw error;
        taken.add(name);
      }
    }
    throw new Error(`${ENSURE_METHOD}: no free environment name for "${input.name}"`);
  }

  async function ensureCompanyEnvironment(
    params: unknown,
    context?: WorkerHostCallContext,
  ): Promise<PluginEnsureCompanyEnvironmentResult> {
    const caller = invocationBoardUser(context);
    if (!caller) {
      throw new InvocationScopeDeniedError(pluginId, ENSURE_METHOD, "only a performAction invocation by a board user may do this");
    }
    const parsed = pluginEnsureCompanyEnvironmentParamsSchema.safeParse(params);
    if (!parsed.success) throw new Error(`${ENSURE_METHOD}: ${firstIssue(parsed.error)}`);
    const input = parsed.data as PluginEnsureCompanyEnvironmentParams;
    if (input.companyId !== caller.companyId) {
      throw new InvocationScopeDeniedError(
        pluginId,
        ENSURE_METHOD,
        `requested company "${input.companyId}" but the current invocation is scoped to company "${caller.companyId}"`,
      );
    }
    if (!(await canWriteCompany(caller.companyId, caller.userId))) {
      throw new InvocationScopeDeniedError(pluginId, ENSURE_METHOD, "the board user behind this action has no write access to the company");
    }
    if (isBuiltinSandboxProvider(input.driverKey) || !(await isSoleProviderPlugin(db, pluginId, input.driverKey))) {
      throw notSoleProvider(pluginKey, input.driverKey);
    }
    const config = await companyEnvironmentConfig(input);
    const match = canonicalTargetMatch(input.match);
    const lockKey = companyEnvironmentLockKey(input.companyId, input.driverKey, match);
    const now = clock();
    const publications: ActivityPublication[] = [];

    const outcome = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
      const existing = await findCompanyEnvironment(tx, { companyId: input.companyId, driverKey: input.driverKey, match });
      if (existing) return { environmentId: existing.id, name: existing.name, created: false, deviceId: null as string | null };

      const environment = await createWithUniqueName(tx, {
        companyId: input.companyId,
        name: input.name,
        description: input.description?.trim() ? input.description.trim() : null,
        config,
      });
      const device = await lockedDeviceForEnvironment(tx, environment);
      if (device) {
        await environmentAvailabilityService(tx).seedFromTarget(environment.id, targetAvailabilityOf(device, now), { now });
      }
      await logActivity(tx as unknown as Db, {
        companyId: input.companyId,
        actorType: "plugin",
        actorId: pluginId,
        action: "environment.created",
        entityType: "environment",
        entityId: environment.id,
        responsibleUserIdOverride: caller.userId,
        details: {
          name: environment.name,
          driver: environment.driver,
          status: environment.status,
          companyId: environment.companyId,
          provider: input.driverKey,
          sourcePluginId: pluginId,
          sourcePluginKey: pluginKey,
          initiatingActorType: "user",
          initiatingUserId: caller.userId,
        },
      }, publications);
      return { environmentId: environment.id, name: environment.name, created: true, deviceId: device?.id ?? null };
    });

    for (const publication of publications) publishActivity(publication);
    // A new per-company environment is a placement change nobody could refuse (spec 5.6): re-check its device's cap.
    if (outcome.deviceId) await checkDeviceLimits([outcome.deviceId], now);
    return { environmentId: outcome.environmentId, name: outcome.name, created: outcome.created };
  }

  return { reportTargets, ensureCompanyEnvironment };
}

export type PluginEnvironmentTargetsService = ReturnType<typeof pluginEnvironmentTargetsService>;
