import { Router, type Request, type Response } from "express";
import { eq, inArray } from "drizzle-orm";
import { aiAccountHosts, aiAccounts, executionWaitSettings, type Db } from "@paperclipai/db";
import {
  DEVICE_POOL_ACCOUNT_LIMIT,
  isUuidLike,
  linkDeviceTargetSchema,
  updateExecutionDeviceSchema,
  updateExecutionWaitSettingsSchema,
  type CompanyExecutionDevicesResponse,
  type DeploymentMode,
  type DeviceAccountLimitErrorDetails,
  type ExecutionDeviceCheckNowResponse,
  type InstanceExecutionDeviceSummary,
  type InstanceExecutionDevicesResponse,
  type LinkDeviceTarget,
  type UpdateExecutionDevice,
  type UpdateExecutionWaitSettings,
} from "@paperclipai/shared";
import { resolveDeploymentMode } from "../config-file.js";
import { conflict, forbidden, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import { isUniqueViolation } from "../services/ai-account-credentials.js";
import {
  AI_ACCOUNT_POOL_SYSTEM_ACTOR_ID,
  isActiveNonViewerMember,
  isCompanyAdmin,
  recheckDeviceLimits,
} from "../services/ai-account-pool.js";
import { noteDeviceOverLimit } from "../services/attention-resource-waits.js";
import {
  acquireBindingsLock,
  boundAccountsByDevice,
  capOf,
  detailForCompany,
  linkTarget,
  lockDevice,
  summariesForCompany,
  summariesForInstance,
} from "../services/execution-devices.js";
import { heartbeatService } from "../services/heartbeat.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import {
  acquireCheckNowSlot,
  checkNowRateLimitedError,
  readExecutionWaitSettings,
  RESOURCE_WAIT_TIMINGS,
} from "../services/resource-waits/index.js";
import { assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "./authz.js";

/** What these routes need from the heartbeat service: forced checks, and waking (and starting) waits. */
export type ExecutionDeviceRoutesHeartbeat = Pick<ReturnType<typeof heartbeatService>, "resourceWaits" | "wakeResourceWaitsNow">;

export interface ExecutionDeviceRoutesOptions {
  /** From the app config; read from the config file when omitted. */
  deploymentMode?: DeploymentMode;
  /** The shared heartbeat service; a service of its own (with this worker manager) when omitted. */
  heartbeat?: ExecutionDeviceRoutesHeartbeat;
  pluginWorkerManager?: PluginWorkerManager;
}

/**
 * Fork: execution devices and wait notices (spec 6, 7.5, 8 and 12).
 *
 * - Company routes, for board users with access to the company: the devices
 *   the company sees (its agents' candidate environments reach them, or the
 *   managing plugin lists the company as served); one device with the
 *   company's waits on it (404 when the company cannot see it); "Check now"
 *   (active non-viewer members and company admins, once a minute per device):
 *   forced checks of the device's environments available to the company, in
 *   its context, then a wake that starts the waits; and the company's
 *   wait-notice settings (company admins write them).
 * - Instance admin routes: every device with keys, owner, cap and labels;
 *   renaming a device or changing its cap (409 below the accounts bound
 *   there); and linking a device to a plugin-reported target (spec 6.6).
 *
 * Other companies' accounts are only ever a count, ownership is display only,
 * and no response carries a credential value. Device changes are logged in
 * the companies whose agents use the device.
 */
export function executionDeviceRoutes(db: Db, options: ExecutionDeviceRoutesOptions = {}) {
  const router = Router();
  let heartbeat: ExecutionDeviceRoutesHeartbeat | null = options.heartbeat ?? null;
  let configuredMode: DeploymentMode | undefined | null = options.deploymentMode ?? null;

  function heartbeatOf(): ExecutionDeviceRoutesHeartbeat {
    heartbeat ??= heartbeatService(db, { pluginWorkerManager: options.pluginWorkerManager });
    return heartbeat;
  }

  /** In `local_trusted` mode the local board user's accounts keep their labels. */
  function deploymentMode(): DeploymentMode | undefined {
    if (configuredMode === null) {
      try {
        configuredMode = resolveDeploymentMode();
      } catch (error) {
        logger.warn({ err: error }, "device routes could not read the deployment mode");
        configuredMode = undefined;
      }
    }
    return configuredMode;
  }

  /** Company device routes are for board users; agents never see account or device metadata. */
  function companyBoardAccess(req: Request, res: Response): string | null {
    const companyId = req.params.companyId as string;
    if (req.actor.type === "agent") throw forbidden("Board access required");
    assertCompanyAccess(req, companyId);
    if (isUuidLike(companyId)) return companyId;
    res.status(404).json({ error: "Company not found" });
    return null;
  }

  function deviceIdParam(req: Request, res: Response): string | null {
    const deviceId = req.params.deviceId as string;
    if (isUuidLike(deviceId)) return deviceId;
    res.status(404).json({ error: "Device not found" });
    return null;
  }

  async function instanceSummary(deviceId: string): Promise<InstanceExecutionDeviceSummary> {
    const summary = (await summariesForInstance(db, { deploymentMode: deploymentMode() })).find((entry) => entry.id === deviceId);
    if (!summary) throw notFound("Device not found");
    return summary;
  }

  /** Device admin changes go to the companies whose agents use the device (spec 12). */
  async function auditDevice(req: Request, companyIds: Iterable<string>, action: string, deviceId: string, details: Record<string, unknown>) {
    const actor = getActorInfo(req);
    await Promise.all([...new Set(companyIds)].map((companyId) => logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action,
      entityType: "execution_device",
      entityId: deviceId,
      details,
    })));
  }

  // --- Company devices --------------------------------------------------------

  router.get("/companies/:companyId/devices", async (req, res) => {
    const companyId = companyBoardAccess(req, res);
    if (!companyId) return;
    const body: CompanyExecutionDevicesResponse = {
      limitPerDevice: DEVICE_POOL_ACCOUNT_LIMIT,
      devices: await summariesForCompany(db, companyId, { deploymentMode: deploymentMode() }),
    };
    res.json(body);
  });

  router.get("/companies/:companyId/devices/:deviceId", async (req, res) => {
    const companyId = companyBoardAccess(req, res);
    if (!companyId) return;
    const deviceId = deviceIdParam(req, res);
    if (!deviceId) return;
    const detail = await detailForCompany(db, companyId, deviceId, { deploymentMode: deploymentMode() });
    if (!detail) {
      res.status(404).json({ error: "Device not found" });
      return;
    }
    res.json(detail);
  });

  router.post("/companies/:companyId/devices/:deviceId/check-now", async (req, res) => {
    const companyId = companyBoardAccess(req, res);
    if (!companyId) return;
    if (!isActiveNonViewerMember(req.actor, companyId) && !isCompanyAdmin(req.actor, companyId)) {
      throw forbidden("Viewers cannot check devices.");
    }
    const deviceId = deviceIdParam(req, res);
    if (!deviceId) return;
    const before = await detailForCompany(db, companyId, deviceId, { deploymentMode: deploymentMode() });
    if (!before) {
      res.status(404).json({ error: "Device not found" });
      return;
    }
    if (!(await acquireCheckNowSlot(db, { companyId, key: `device:${before.id}` }))) {
      res.setHeader("Retry-After", String(Math.ceil(RESOURCE_WAIT_TIMINGS.checkNowWindowMs / 1000)));
      throw checkNowRateLimitedError();
    }
    // Only the environments this company may use, each checked in its context.
    const environmentIds = before.environments.map((environment) => environment.id);
    const service = heartbeatOf();
    const result = await service.resourceWaits.checkEnvironmentsNow({ companyId, environmentIds });
    // The check made the company's waits there due; start them now (the hold still re-checks each).
    if (environmentIds.length > 0) await service.wakeResourceWaitsNow({ environmentIds, companyId });
    const device = (await detailForCompany(db, companyId, before.id, { deploymentMode: deploymentMode() })) ?? before;
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "execution_device.checked",
      entityType: "execution_device",
      entityId: before.id,
      details: {
        deviceName: before.name,
        woken: result.woken,
        checks: result.checks.map((check) => ({ environmentId: check.environmentId, state: check.state, reason: check.reason })),
      },
    });
    const body: ExecutionDeviceCheckNowResponse = { checkedAt: result.checkedAt, device, woken: result.woken };
    res.json(body);
  });

  // --- Wait notice settings ---------------------------------------------------

  router.get("/companies/:companyId/execution-wait-settings", async (req, res) => {
    const companyId = companyBoardAccess(req, res);
    if (!companyId) return;
    res.json(await readExecutionWaitSettings(db, companyId));
  });

  router.put("/companies/:companyId/execution-wait-settings", validate(updateExecutionWaitSettingsSchema), async (req, res) => {
    const companyId = companyBoardAccess(req, res);
    if (!companyId) return;
    if (!isCompanyAdmin(req.actor, companyId)) throw forbidden("Only company admins can change wait notices.");
    const patch = req.body as UpdateExecutionWaitSettings;
    const changed = Object.keys(patch).sort();
    if (changed.length === 0) {
      res.json(await readExecutionWaitSettings(db, companyId));
      return;
    }
    const now = new Date();
    const updatedByUserId = req.actor.userId ?? null;
    await db
      .insert(executionWaitSettings)
      .values({ companyId, ...patch, updatedByUserId, updatedAt: now })
      .onConflictDoUpdate({ target: executionWaitSettings.companyId, set: { ...patch, updatedByUserId, updatedAt: now } });
    const settings = await readExecutionWaitSettings(db, companyId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "company.execution_wait_settings_updated",
      entityType: "company",
      entityId: companyId,
      details: {
        changedKeys: changed,
        notifyAfterHours: settings.notifyAfterHours,
        notifyPmOnDeviceWait: settings.notifyPmOnDeviceWait,
        notifyPmOnAccountWait: settings.notifyPmOnAccountWait,
      },
    });
    res.json(settings);
  });

  // --- Instance admin -----------------------------------------------------------

  router.get("/instance/devices", async (req, res) => {
    assertInstanceAdmin(req);
    const body: InstanceExecutionDevicesResponse = {
      limitPerDevice: DEVICE_POOL_ACCOUNT_LIMIT,
      devices: await summariesForInstance(db, { deploymentMode: deploymentMode() }),
    };
    res.json(body);
  });

  router.patch("/instance/devices/:deviceId", validate(updateExecutionDeviceSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const deviceId = deviceIdParam(req, res);
    if (!deviceId) return;
    const patch = req.body as UpdateExecutionDevice;
    const now = new Date();
    // Under the bindings lock, so no binding lands between the count and the new cap.
    const { before, after } = await db.transaction(async (tx) => {
      await acquireBindingsLock(tx);
      const device = await lockDevice(tx, deviceId);
      if (!device) throw notFound("Device not found");
      const limit = patch.maxAccounts === undefined ? null : Math.min(patch.maxAccounts, DEVICE_POOL_ACCOUNT_LIMIT);
      // Only lowering is refused (spec 6.2): a device over its limit may always get a higher one.
      if (limit !== null && limit < capOf(device)) {
        const bound = [...((await boundAccountsByDevice(tx, { deviceIds: [device.id], create: false })).get(device.id)?.accountIds ?? [])];
        if (bound.length > limit) {
          const labels = (await tx.select({ label: aiAccounts.label }).from(aiAccounts).where(inArray(aiAccounts.id, bound)))
            .map((row) => row.label)
            .sort((a, b) => a.localeCompare(b));
          const details: DeviceAccountLimitErrorDetails = {
            code: "device_account_limit",
            deviceId: device.id,
            deviceName: device.name,
            limit,
            inUse: bound.length,
            accounts: labels,
            otherCompaniesAccounts: bound.length - labels.length,
          };
          throw conflict(
            `${device.name} has ${bound.length} Claude accounts bound to agents that can run on it. Choose other accounts or move agents before lowering its limit to ${limit}.`,
            details,
          );
        }
      }
      if (Object.keys(patch).length === 0) return { before: device, after: device };
      try {
        const [updated] = await tx.update(aiAccountHosts).set({ ...patch, updatedAt: now }).where(eq(aiAccountHosts.id, device.id)).returning();
        return { before: device, after: updated! };
      } catch (error) {
        if (isUniqueViolation(error, "ai_account_hosts_name_uq")) throw conflict("A device with this name already exists.");
        throw error;
      }
    });
    const changedKeys = (Object.keys(patch) as Array<keyof UpdateExecutionDevice>).filter((key) => before[key] !== after[key]).sort();
    if (changedKeys.includes("maxAccounts")) {
      // A new cap may clear the over-limit flag, and a higher one frees slots.
      await recheckDeviceLimits(db, { deviceIds: [after.id], now });
      if (capOf(after) > capOf(before)) {
        await heartbeatOf().wakeResourceWaitsNow({ deviceIds: [after.id], kinds: ["device_slots"] });
      }
    }
    const summary = await instanceSummary(after.id);
    if (changedKeys.length > 0) {
      await auditDevice(req, summary.companies.map((entry) => entry.companyId), "execution_device.updated", after.id, {
        deviceName: after.name,
        changedKeys,
        ...(changedKeys.includes("name") ? { previousName: before.name, name: after.name } : {}),
        ...(changedKeys.includes("maxAccounts") ? { previousMaxAccounts: before.maxAccounts, maxAccounts: after.maxAccounts } : {}),
      });
    }
    res.json(summary);
  });

  router.post("/instance/devices/:deviceId/link-target", validate(linkDeviceTargetSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const deviceId = deviceIdParam(req, res);
    if (!deviceId) return;
    const target = req.body as LinkDeviceTarget;
    const result = await linkTarget(db, deviceId, target);
    const limit = result.limit;
    if (limit?.change === "flagged") {
      // A merge joined accounts bound on two rows: the over-limit notice of
      // spec 5.6, first, since a later recheck no longer flips the flag.
      await noteDeviceOverLimit(db, limit);
      await Promise.all(limit.companyIds.map((companyId) => logActivity(db, {
        companyId,
        actorType: "system",
        actorId: AI_ACCOUNT_POOL_SYSTEM_ACTOR_ID,
        action: "execution_device.over_limit",
        entityType: "execution_device",
        entityId: limit.deviceId,
        details: { deviceName: limit.deviceName, limit: limit.limit, inUse: limit.inUse },
      })));
    }
    if (result.changed) {
      // The merged rows' waits now point here; let them re-check against this
      // device. Best effort: the link stands, and the waits re-check anyway.
      try {
        await heartbeatOf().wakeResourceWaitsNow({ deviceIds: [result.device.id] });
      } catch (error) {
        logger.warn({ err: error, deviceId: result.device.id }, "failed to wake waits after linking a device to a target");
      }
    }
    const summary = await instanceSummary(result.device.id);
    if (result.changed) {
      await auditDevice(
        req,
        [...summary.companies.map((entry) => entry.companyId), ...(limit?.companyIds ?? [])],
        "execution_device.linked",
        result.device.id,
        {
          deviceName: result.device.name,
          pluginId: target.pluginId,
          provider: target.provider,
          targetKey: target.targetKey,
          mergedDevices: result.mergedDeviceIds.length,
        },
      );
    }
    res.json(summary);
  });

  return router;
}
