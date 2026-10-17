import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  createAiAccountHostSchema,
  isEnvironmentAvailableToCompany,
  isUuidLike,
  setAiAccountHostEnvironmentsSchema,
  updateAiAccountHostSchema,
} from "@paperclipai/shared";
import { HttpError, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import { aiAccountHostService } from "../services/ai-account-hosts.js";
import { assertInstanceAdmin, getActorInfo } from "./authz.js";

/**
 * Fork: the legacy host routes, now instance-admin administration of
 * execution devices (spec 12). Every route is for instance admins only, since
 * one device serves every company's runs. A device change is logged only in
 * the companies whose agents use the device. Accounts moved to the account
 * pool routes: adding an account to a host or reserving it for projects
 * answers 410, and the account PATCH, clear-limit and DELETE routes are
 * served by the pool router under `/api/instance/ai-accounts/:accountId`.
 */

/** The device fields a rename or limit change may touch, in `changedKeys` order. */
const HOST_AUDIT_KEYS = ["maxAccounts", "name", "overflowToOtherAccounts"] as const;

/** 410 `ai_account_route_moved`, naming the routes that replace a legacy one. */
function routeMoved(message: string, replacements: string[]) {
  return new HttpError(410, message, { code: "ai_account_route_moved", replacements });
}

export function aiAccountHostRoutes(db: Db) {
  const router = Router();
  const svc = aiAccountHostService(db);

  /** One entry per company whose agents use the device (spec 12); no other company gets one. */
  async function audit(
    req: Request,
    companyIds: readonly string[],
    action: string,
    deviceId: string,
    details: (companyId: string) => Record<string, unknown>,
  ) {
    const actor = getActorInfo(req);
    for (const companyId of companyIds) {
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action,
        entityType: "execution_device",
        entityId: deviceId,
        details: details(companyId),
      });
    }
  }

  /** A malformed id is a 404, as on the device routes, never a query that fails to cast it. */
  function hostIdParam(req: Request): string {
    const hostId = req.params.hostId as string;
    if (!isUuidLike(hostId)) throw notFound("Device not found");
    return hostId;
  }

  router.get("/instance/ai-hosts", async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await svc.list());
  });

  router.post("/instance/ai-hosts", validate(createAiAccountHostSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const host = await svc.createHost(req.body, req.actor.userId ?? null);
    // Nothing to log: no agent uses a device before an environment is mapped to it.
    res.status(201).json(host);
  });

  router.patch("/instance/ai-hosts/:hostId", validate(updateAiAccountHostSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const previous = await svc.getHost(hostIdParam(req));
    const host = await svc.updateHost(previous.id, req.body);
    // Only what really changed: a request that changes nothing logs nothing.
    const changedKeys = HOST_AUDIT_KEYS.filter((key) => previous[key] !== host[key]);
    if (changedKeys.length > 0) {
      await audit(req, await svc.companiesUsingDevices([host.id]), "execution_device.updated", host.id, () => ({
        deviceName: host.name,
        changedKeys,
        maxAccounts: host.maxAccounts,
        ...(previous.name !== host.name ? { previousName: previous.name } : {}),
      }));
    }
    res.json(host);
  });

  router.delete("/instance/ai-hosts/:hostId", async (req, res) => {
    assertInstanceAdmin(req);
    const hostId = hostIdParam(req);
    // Read before the delete: afterwards no agent reaches the device.
    const companyIds = await svc.companiesUsingDevices([hostId]);
    const host = await svc.deleteHost(hostId);
    await audit(req, companyIds, "execution_device.deleted", host.id, () => ({ deviceName: host.name }));
    res.json({ ok: true });
  });

  router.put("/instance/ai-hosts/:hostId/environments", validate(setAiAccountHostEnvironmentsSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const hostId = hostIdParam(req);
    // Companies that used the device before the edit, or use it after.
    const before = await svc.companiesUsingDevices([hostId]);
    const result = await svc.setEnvironments(hostId, req.body.environmentIds);
    const after = await svc.companiesUsingDevices([hostId]);
    await audit(req, [...new Set([...before, ...after])].sort(), "execution_device.updated", result.host.id, (companyId) => {
      // Another company's own environments are counted, never named.
      const visible = result.environments.filter((environment) => isEnvironmentAvailableToCompany(environment, companyId));
      const otherEnvironments = result.environments.length - visible.length;
      return {
        deviceName: result.host.name,
        changedKeys: ["environments"],
        environments: visible.map((environment) => environment.name),
        ...(otherEnvironments > 0 ? { otherEnvironments } : {}),
      };
    });
    res.json({ host: result.host, environments: result.environments });
  });

  router.post("/instance/ai-hosts/:hostId/accounts", () => {
    throw routeMoved(
      "Claude accounts now belong to the person who adds them. Add one with POST /api/me/ai-accounts, " +
        "then assign it to an agent with PUT /api/agents/{agentId}/ai-account.",
      ["POST /api/me/ai-accounts", "PUT /api/agents/{agentId}/ai-account"],
    );
  });

  router.put("/instance/ai-accounts/:accountId/projects", () => {
    throw routeMoved(
      "Project reservations are no longer edited here. A reserved account serves only the companies of its " +
        "projects until its owner clears that with PATCH /api/me/ai-accounts/{accountId} and clearProjectRestriction.",
      ["PATCH /api/me/ai-accounts/{accountId}"],
    );
  });

  return router;
}
