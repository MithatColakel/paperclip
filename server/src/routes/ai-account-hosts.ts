import { Router, type Request } from "express";
import { companies, type Db } from "@paperclipai/db";
import {
  createAiAccountHostSchema,
  createAiAccountSchema,
  setAiAccountHostEnvironmentsSchema,
  setAiAccountProjectsSchema,
  updateAiAccountHostSchema,
  updateAiAccountSchema,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import { aiAccountHostService } from "../services/ai-account-hosts.js";
import { getActorInfo } from "./authz.js";

/**
 * Fork: instance-level Claude accounts per execution host. Every route is
 * for instance admins only, because a host's accounts serve every company's
 * runs. Mutations are logged in every company, like instance settings.
 */
function assertInstanceAdmin(req: Request) {
  if (req.actor.type !== "board") throw forbidden("Board access required");
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
  throw forbidden("Instance admin access required");
}

export function aiAccountHostRoutes(db: Db) {
  const router = Router();
  const svc = aiAccountHostService(db);

  async function audit(req: Request, action: string, entityType: string, entityId: string, details: Record<string, unknown>) {
    const actor = getActorInfo(req);
    const companyIds = (await db.select({ id: companies.id }).from(companies)).map((row) => row.id);
    await Promise.all(companyIds.map((companyId) => logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action,
      entityType,
      entityId,
      details,
    })));
  }

  router.get("/instance/ai-hosts", async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await svc.list());
  });

  router.post("/instance/ai-hosts", validate(createAiAccountHostSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const host = await svc.createHost(req.body, req.actor.userId ?? null);
    await audit(req, "ai_account_host.created", "ai_account_host", host.id, { name: host.name, kind: host.kind, maxAccounts: host.maxAccounts });
    res.status(201).json(host);
  });

  router.patch("/instance/ai-hosts/:hostId", validate(updateAiAccountHostSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const host = await svc.updateHost(req.params.hostId as string, req.body);
    await audit(req, "ai_account_host.updated", "ai_account_host", host.id, { changedKeys: Object.keys(req.body).sort(), name: host.name, maxAccounts: host.maxAccounts, overflowToOtherAccounts: host.overflowToOtherAccounts });
    res.json(host);
  });

  router.delete("/instance/ai-hosts/:hostId", async (req, res) => {
    assertInstanceAdmin(req);
    const host = await svc.deleteHost(req.params.hostId as string);
    await audit(req, "ai_account_host.deleted", "ai_account_host", host.id, { name: host.name });
    res.json({ ok: true });
  });

  router.put("/instance/ai-hosts/:hostId/environments", validate(setAiAccountHostEnvironmentsSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const result = await svc.setEnvironments(req.params.hostId as string, req.body.environmentIds);
    await audit(req, "ai_account_host.environments_updated", "ai_account_host", result.host.id, {
      name: result.host.name,
      environments: result.environments.map((environment) => environment.name),
    });
    res.json(result);
  });

  router.post("/instance/ai-hosts/:hostId/accounts", validate(createAiAccountSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const { host, account } = await svc.addAccount(req.params.hostId as string, req.body, req.actor.userId ?? null);
    await audit(req, "ai_account.created", "ai_account", account.id, {
      host: host.name,
      label: account.label,
      credentialType: account.credentialType,
      source: req.body.importFrom?.kind ?? "pasted",
    });
    res.status(201).json(svc.summarizeAccount(account, 0));
  });

  router.patch("/instance/ai-accounts/:accountId", validate(updateAiAccountSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const { account } = await svc.updateAccount(req.params.accountId as string, req.body);
    await audit(req, "ai_account.updated", "ai_account", account.id, { label: account.label, changedKeys: Object.keys(req.body).sort(), poolEnabled: account.poolEnabled, status: account.status });
    res.json(svc.summarizeAccount(account, 0));
  });

  router.put("/instance/ai-accounts/:accountId/projects", validate(setAiAccountProjectsSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const result = await svc.setAccountProjects(req.params.accountId as string, req.body.projectIds);
    await audit(req, "ai_account.projects_updated", "ai_account", result.account.id, {
      label: result.account.label,
      projects: result.projects.map((project) => `${project.issuePrefix}: ${project.name}`),
    });
    res.json({ accountId: result.account.id, projects: result.projects });
  });

  router.post("/instance/ai-accounts/:accountId/clear-limit", async (req, res) => {
    assertInstanceAdmin(req);
    const account = await svc.clearLimit(req.params.accountId as string);
    await audit(req, "ai_account.limit_cleared", "ai_account", account.id, { label: account.label });
    res.json(svc.summarizeAccount(account, 0));
  });

  router.delete("/instance/ai-accounts/:accountId", async (req, res) => {
    assertInstanceAdmin(req);
    const account = await svc.deleteAccount(req.params.accountId as string);
    await audit(req, "ai_account.deleted", "ai_account", account.id, { label: account.label });
    res.json({ ok: true });
  });

  return router;
}
