import { Router } from "express";
import type { Db } from "@paperclipai/db";
import type { DeploymentMode } from "@paperclipai/shared";
import {
  readAiAccountMigrationReport,
  runDeferredAiAccountMigration,
} from "../services/ai-account-pool-migration.js";
import { assertInstanceAdmin, getActorInfo } from "./authz.js";

/**
 * Fork: the Claude account binding backfill (spec 12, 15.3), for instance
 * admins only. The report is the job's state and summary (`pending` with a
 * null summary before the job ever ran) plus a fresh go/no-go; the re-run
 * adds only the bindings an earlier run could not make. A failed re-run
 * answers 200 with the report, whose status and last error say what went
 * wrong. No route here takes an account id, so none collides with
 * `/instance/ai-accounts/:accountId`.
 */
export function aiAccountPoolMigrationRoutes(db: Db, options: { deploymentMode?: DeploymentMode } = {}) {
  const router = Router();

  router.get("/instance/ai-accounts/migration", async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await readAiAccountMigrationReport(db, { deploymentMode: options.deploymentMode }));
  });

  router.post("/instance/ai-accounts/migration/run", async (req, res) => {
    assertInstanceAdmin(req);
    const actor = getActorInfo(req);
    await runDeferredAiAccountMigration(db, {
      force: true,
      deploymentMode: options.deploymentMode,
      actor: {
        audit: { actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId },
        userId: req.actor.userId ?? null,
      },
    });
    res.json(await readAiAccountMigrationReport(db, { deploymentMode: options.deploymentMode }));
  });

  return router;
}
