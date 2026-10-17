import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import {
  createMyAiAccountSchema,
  isUuidLike,
  replaceAiAccountCredentialSchema,
  setAgentAiAccountSchema,
  updateInstanceAiAccountSchema,
  updateMyAiAccountSchema,
  type DeploymentMode,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  aiAccountPoolService,
  type PoolAgentRow,
  type PoolContext,
} from "../services/ai-account-pool.js";
import { assertCompanyAccess, assertInstanceAdmin, getActorInfo, hasCompanyAccess } from "./authz.js";

/**
 * Fork: the user-owned Claude account pool (spec 12). Owners manage their own
 * accounts under `/me`; the owner or a company admin binds agents; instance
 * admins see every account and can disable, clear, remove or transfer one.
 * No response carries a credential value. Mounted by app.ts before the legacy
 * host routes, so these `/instance/ai-accounts/:id` routes win.
 */
export function aiAccountPoolRoutes(db: Db, options: { deploymentMode?: DeploymentMode } = {}) {
  const router = Router();
  const svc = aiAccountPoolService(db, { deploymentMode: options.deploymentMode });

  function context(req: Request): PoolContext {
    return { actor: req.actor, audit: getActorInfo(req) };
  }

  /** `/me` routes: a board user acting for themselves. */
  function assertBoardUser(req: Request) {
    if (req.actor.type !== "board") throw forbidden("Board access required");
    if (!req.actor.userId) throw forbidden("A signed-in user is required");
  }

  function accountIdParam(req: Request, res: Response): string | null {
    const accountId = req.params.accountId as string;
    if (isUuidLike(accountId)) return accountId;
    res.status(404).json({ error: "Claude account not found" });
    return null;
  }

  /**
   * The agent behind `:agentId`, or a 404 that never tells another company's
   * agent from a missing one. An instance admin outside the company gets a
   * 403 for a change: instance admins bind only in companies they belong to.
   */
  async function accessibleAgent(req: Request, res: Response, write: boolean): Promise<PoolAgentRow | null> {
    const agentId = req.params.agentId as string;
    const agent = isUuidLike(agentId) ? await svc.getAgent(agentId) : null;
    if (agent && !hasCompanyAccess(req, agent.companyId) && write && req.actor.type === "board" && req.actor.isInstanceAdmin) {
      throw forbidden("Instance admins change Claude accounts only in companies they belong to.", { code: "ai_account_binding_forbidden" });
    }
    if (!agent || !hasCompanyAccess(req, agent.companyId)) {
      res.status(404).json({ error: "Agent not found" });
      return null;
    }
    if (write && req.actor.type === "agent") {
      throw forbidden("Agents cannot change Claude account bindings.", { code: "ai_account_binding_forbidden" });
    }
    if (!write && req.actor.type === "agent" && req.actor.agentId !== agent.id) {
      throw forbidden("Agents can read only their own Claude account.");
    }
    assertCompanyAccess(req, agent.companyId);
    return agent;
  }

  /** Company account lists are for board users; agents never see account metadata. */
  function companyBoardAccess(req: Request, res: Response): string | null {
    const companyId = req.params.companyId as string;
    if (req.actor.type === "agent") throw forbidden("Board access required");
    assertCompanyAccess(req, companyId);
    if (isUuidLike(companyId)) return companyId;
    res.status(404).json({ error: "Company not found" });
    return null;
  }

  // --- My accounts -----------------------------------------------------------

  router.get("/me/ai-accounts", async (req, res) => {
    assertBoardUser(req);
    res.json(await svc.listMine(context(req)));
  });

  router.post("/me/ai-accounts", validate(createMyAiAccountSchema), async (req, res) => {
    assertBoardUser(req);
    res.status(201).json(await svc.create(context(req), req.body));
  });

  router.patch("/me/ai-accounts/:accountId", validate(updateMyAiAccountSchema), async (req, res) => {
    assertBoardUser(req);
    const accountId = accountIdParam(req, res);
    if (!accountId) return;
    res.json(await svc.update(context(req), accountId, req.body));
  });

  router.put("/me/ai-accounts/:accountId/credential", validate(replaceAiAccountCredentialSchema), async (req, res) => {
    assertBoardUser(req);
    const accountId = accountIdParam(req, res);
    if (!accountId) return;
    res.json(await svc.replaceCredential(context(req), accountId, req.body));
  });

  router.post("/me/ai-accounts/:accountId/clear-limit", async (req, res) => {
    assertBoardUser(req);
    const accountId = accountIdParam(req, res);
    if (!accountId) return;
    res.json(await svc.clearLimit(context(req), accountId));
  });

  router.delete("/me/ai-accounts/:accountId", async (req, res) => {
    assertBoardUser(req);
    const accountId = accountIdParam(req, res);
    if (!accountId) return;
    await svc.remove(context(req), accountId, { release: req.query.release === "true" });
    res.status(204).end();
  });

  // --- Company accounts and bindings ---------------------------------------

  router.get("/companies/:companyId/ai-accounts", async (req, res) => {
    const companyId = companyBoardAccess(req, res);
    if (!companyId) return;
    const agentId = typeof req.query.agentId === "string" && req.query.agentId.length > 0 ? req.query.agentId : null;
    if (agentId && !isUuidLike(agentId)) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    res.json(await svc.listForCompany(context(req), companyId, { agentId }));
  });

  router.get("/companies/:companyId/ai-account-bindings", async (req, res) => {
    const companyId = companyBoardAccess(req, res);
    if (!companyId) return;
    res.json(await svc.listBindings(context(req), companyId));
  });

  router.get("/agents/:agentId/ai-account", async (req, res) => {
    const agent = await accessibleAgent(req, res, false);
    if (!agent) return;
    res.json(await svc.getAgentBinding(context(req), agent.id));
  });

  router.put("/agents/:agentId/ai-account", validate(setAgentAiAccountSchema), async (req, res) => {
    const agent = await accessibleAgent(req, res, true);
    if (!agent) return;
    res.json(await svc.setBinding(context(req), agent.id, req.body));
  });

  router.delete("/agents/:agentId/ai-account", async (req, res) => {
    const agent = await accessibleAgent(req, res, true);
    if (!agent) return;
    await svc.clearBinding(context(req), agent.id);
    res.status(204).end();
  });

  router.post("/agents/:agentId/ai-account/review", async (req, res) => {
    const agent = await accessibleAgent(req, res, true);
    if (!agent) return;
    res.json(await svc.confirmMigratedBinding(context(req), agent.id));
  });

  // --- Instance admin ----------------------------------------------------------

  router.get("/instance/ai-accounts", async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await svc.listAll());
  });

  router.patch("/instance/ai-accounts/:accountId", validate(updateInstanceAiAccountSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const accountId = accountIdParam(req, res);
    if (!accountId) return;
    res.json(await svc.updateInstanceAccount(context(req), accountId, req.body));
  });

  router.post("/instance/ai-accounts/:accountId/clear-limit", async (req, res) => {
    assertInstanceAdmin(req);
    const accountId = accountIdParam(req, res);
    if (!accountId) return;
    res.json(await svc.adminClearLimit(context(req), accountId));
  });

  router.delete("/instance/ai-accounts/:accountId", async (req, res) => {
    assertInstanceAdmin(req);
    const accountId = accountIdParam(req, res);
    if (!accountId) return;
    await svc.adminDelete(context(req), accountId, { release: req.query.release === "true" });
    res.status(204).end();
  });

  return router;
}
