import { Router, type Request } from "express";
import { eq } from "drizzle-orm";
import { agents, heartbeatRuns, type Db } from "@paperclipai/db";
import {
  addApprovalCommentSchema,
  agentHarnessType,
  approveApprovalSchema,
  createApprovalSchema,
  supportedEnvironmentDriversForAdapter,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
  resubmitApprovalSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import {
  approvalService,
  accessService,
  heartbeatService,
  issueApprovalService,
  logActivity,
  secretService,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource, getActorInfo, hasCompanyAccess } from "./authz.js";
import { redactEventPayload } from "../redaction.js";
import { forbidden, HttpError, unprocessable } from "../errors.js";
import { environmentService } from "../services/environments.js";
import { aiAccountPoolService, type PlacementMove } from "../services/ai-account-pool.js";
import { isAdapterDisabled } from "../services/adapter-plugin-store.js";
import { agentRunnerAvailability, resolveAgentRunnerTargetForCompany, resolveNewAgentRunner } from "../services/agent-runner-selection.js";
import { isPlainRecord } from "../lib/agent-records.js";
import { resolvableApprovalStatuses } from "../lib/approval-records.js";
import { assertEnvironmentSelectionForCompany } from "./environment-selection.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { issueService } from "../services/issues.js";
import { approvalReadSqlCondition, canActorReadApproval } from "../services/authorization.js";
import { REVIEW_PATH_RECOVERY_INSTRUCTION } from "../services/recovery/review-path-recovery.js";

function redactApprovalPayload<T extends { payload: Record<string, unknown> }>(approval: T): T {
  return {
    ...approval,
    payload: redactEventPayload(approval.payload) ?? {},
  };
}

function isStatusOnlyRecoveryContext(contextSnapshot: unknown) {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return false;
  const context = contextSnapshot as Record<string, unknown>;
  return context.recoveryIntent === "status_only" &&
    context.allowDeliverableWork === false &&
    context.allowDocumentUpdates === false &&
    context.resumeRequiresNormalModel === true;
}

export function approvalRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const router = Router();
  router.param("id", async (req, res, next, id) => {
    try {
      if (!(await canActorReadApproval(db, req.actor, id))) {
        res.status(404).json({ error: "Approval not found" });
        return;
      }
      next();
    } catch (error) { next(error); }
  });
  const svc = approvalService(db);
  const access = accessService(db);
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
  });
  const issueApprovalsSvc = issueApprovalService(db);
  const issuesSvc = issueService(db);
  const secretsSvc = secretService(db);
  // Fork: the Claude account pool's placement rules (spec 5.6).
  const aiAccountPool = aiAccountPoolService(db);
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";

  /**
   * Fork: a hire's runner is resolved for the device it asked for (the hire
   * route records the runner choice in the payload). When the board picks the
   * device at approval (null: the company's default), a Codex or Claude hire
   * on Paperclip Runner is checked against that device before anything is
   * written. Where Paperclip Runner cannot run, an automatic choice
   * (`runner: "auto"`) falls back to Legacy, as it would have at hire; any
   * other hire asked for Paperclip Runner and is refused. Returns the payload
   * fields the approval changes.
   */
  async function hireRunnerForPickedEnvironment(
    companyId: string,
    payload: Record<string, unknown>,
    environmentId: string | null,
  ): Promise<Record<string, unknown>> {
    const adapterConfig = isPlainRecord(payload.adapterConfig) ? payload.adapterConfig : {};
    const harness = agentHarnessType("paperclip_runner", adapterConfig);
    if (payload.adapterType !== "paperclip_runner" || (harness !== "codex_local" && harness !== "claude_local")) return {};
    let supported = false;
    let probed = true;
    try {
      const target = await resolveAgentRunnerTargetForCompany(db, companyId, environmentId, harness);
      supported = agentRunnerAvailability(harness, target).supportedRunners.includes("paperclip");
    } catch (error) {
      // An SSH host that cannot be reached leaves its platform unknown.
      const code = error instanceof HttpError ? (error.details as { code?: unknown } | undefined)?.code : undefined;
      if (code !== "agent_runner_platform_probe_failed") throw error;
      probed = false;
    }
    if (supported) return {};
    if (payload.runner !== "auto") {
      throw probed
        ? unprocessable("This hire asks for Paperclip Runner, which cannot run on the chosen environment. Choose another environment, or request a revision for Legacy runner.", { code: "agent_runner_unavailable" })
        : unprocessable("Could not check the chosen SSH host's platform for this hire's Paperclip Runner. Check its connection and retry, or choose another environment.", { code: "agent_runner_platform_probe_failed" });
    }
    const legacy = resolveNewAgentRunner({ adapterType: "paperclip_runner", adapterConfig, runner: "legacy" });
    if (isAdapterDisabled(legacy.adapterType)) {
      throw unprocessable(`${harness === "claude_local" ? "Claude" : "Codex"} is disabled on this instance, and Paperclip Runner cannot run this hire on the chosen environment.`, { code: "agent_runner_unavailable" });
    }
    return { adapterType: legacy.adapterType, adapterConfig: legacy.adapterConfig };
  }

  /**
   * Fork: approving a hire passes the account pool's placement checks (spec
   * 5.6). When the approved payload moves a pending agent that holds a pool
   * account, they run under the bindings lock in the transaction that decides
   * the approval, before activation writes the environment, so a refusal
   * leaves the approval and the agent as they were. The move's wakes and the
   * cap re-check of the devices the agent left must read the committed
   * activation: the caller runs `afterCommit` once the approval has returned.
   */
  function hirePlacementCheck(req: Request): {
    beforeActivate: (tx: Db, approval: { companyId: string; payload: unknown }) => Promise<void>;
    afterCommit: () => Promise<void>;
  } {
    let move: PlacementMove | null = null;
    return {
      beforeActivate: async (tx, approval) => {
        move = await aiAccountPool.checkHireActivationInWrite(tx, req.actor, approval);
      },
      afterCommit: async () => {
        if (move) await aiAccountPool.afterPlacementMove(move);
      },
    };
  }

  async function lostReviewPathIssueIds(
    companyId: string,
    linkedIssues: Awaited<ReturnType<typeof issueApprovalsSvc.listIssuesForApproval>>,
  ) {
    const attention = await issuesSvc.listReviewAttention(companyId, linkedIssues);
    return new Set(linkedIssues
      .filter((issue) => attention.get(issue.id)?.state === "stalled")
      .map((issue) => issue.id));
  }

  function approvalReviewPathContext(approvalId: string) {
    return {
      reviewPathLost: true,
      reviewPathConsumedRef: approvalId,
      reviewPathInstruction: REVIEW_PATH_RECOVERY_INSTRUCTION,
    };
  }

  async function queueAdditionalApprovalReviewPathWakes(input: {
    approvalId: string;
    approvalStatus: string;
    companyId: string;
    linkedIssues: Awaited<ReturnType<typeof issueApprovalsSvc.listIssuesForApproval>>;
    lostIssueIds: Set<string>;
    alreadyWoken?: { agentId: string; issueId: string } | null;
    requestedByUserId: string;
  }) {
    for (const issue of input.linkedIssues) {
      if (!input.lostIssueIds.has(issue.id) || !issue.assigneeAgentId) continue;
      if (
        input.alreadyWoken?.agentId === issue.assigneeAgentId
        && input.alreadyWoken.issueId === issue.id
      ) continue;

      const wakeReason = `approval_${input.approvalStatus}`;
      try {
        const wakeRun = await heartbeat.wakeup(issue.assigneeAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: wakeReason,
          idempotencyKey: `approval-review-path:${input.approvalId}:${issue.id}:${input.approvalStatus}`,
          payload: {
            approvalId: input.approvalId,
            approvalStatus: input.approvalStatus,
            issueId: issue.id,
            ...approvalReviewPathContext(input.approvalId),
          },
          requestedByActorType: "user",
          requestedByActorId: input.requestedByUserId,
          contextSnapshot: {
            source: `approval.${input.approvalStatus}`,
            approvalId: input.approvalId,
            approvalStatus: input.approvalStatus,
            issueId: issue.id,
            taskId: issue.id,
            wakeReason,
            ...approvalReviewPathContext(input.approvalId),
          },
        });

        await logActivity(db, {
          companyId: input.companyId,
          actorType: "user",
          actorId: input.requestedByUserId,
          action: "approval.review_path_wakeup_queued",
          entityType: "approval",
          entityId: input.approvalId,
          details: {
            approvalStatus: input.approvalStatus,
            issueId: issue.id,
            assigneeAgentId: issue.assigneeAgentId,
            wakeRunId: wakeRun?.id ?? null,
          },
        });
      } catch (err) {
        logger.warn(
          { err, approvalId: input.approvalId, issueId: issue.id, agentId: issue.assigneeAgentId },
          "failed to queue review-path wake after approval resolution",
        );
        await logActivity(db, {
          companyId: input.companyId,
          actorType: "user",
          actorId: input.requestedByUserId,
          action: "approval.review_path_wakeup_failed",
          entityType: "approval",
          entityId: input.approvalId,
          details: {
            approvalStatus: input.approvalStatus,
            issueId: issue.id,
            assigneeAgentId: issue.assigneeAgentId,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
  }

  async function requireApprovalAccess(req: Request, id: string) {
    const approval = await svc.getById(id);
    if (!approval || !hasCompanyAccess(req, approval.companyId)) {
      return null;
    }
    assertCompanyAccess(req, approval.companyId);
    return approval;
  }

  async function assertApprovalAccessAllowed(req: Request, res: any, companyId: string) {
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (decision.allowed) return true;
    res.status(403).json({ error: "Approvals are outside this actor's authorization boundary" });
    return false;
  }

  async function assertApprovalMutationAllowedByRunContext(req: Request, res: any, companyId: string) {
    if (req.actor.type !== "agent") return true;
    const runId = req.actor.runId?.trim();
    if (!runId || !req.actor.agentId) return true;

    const run = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (!run || run.companyId !== companyId || run.agentId !== req.actor.agentId) return true;
    if (!isStatusOnlyRecoveryContext(run.contextSnapshot)) return true;

    res.status(403).json({
      error: "Status-only recovery runs cannot create or modify approvals",
      details: {
        companyId,
        runId: run.id,
        recoveryIntent: "status_only",
        resumeRequiresNormalModel: true,
      },
    });
    return false;
  }

  // Fork: an agent requests approvals only as itself. A board user may name a
  // requesting agent, but only one of this company's agents.
  async function resolveApprovalRequester(
    companyId: string,
    actor: ReturnType<typeof getActorInfo>,
    requestedByAgentId: string | null,
  ) {
    if (actor.actorType === "agent") {
      if (requestedByAgentId && requestedByAgentId !== actor.actorId) {
        throw forbidden("Agents can request approvals only as themselves");
      }
      return actor.actorId;
    }
    if (!requestedByAgentId) return null;
    const requester = await db
      .select({ companyId: agents.companyId })
      .from(agents)
      .where(eq(agents.id, requestedByAgentId))
      .then((rows) => rows[0] ?? null);
    if (requester?.companyId !== companyId) {
      throw unprocessable("The requesting agent must belong to this company");
    }
    return requestedByAgentId;
  }

  router.get("/companies/:companyId/approvals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertApprovalAccessAllowed(req, res, companyId))) return;
    const status = req.query.status as string | undefined;
    const result = await svc.list(companyId, status, await approvalReadSqlCondition(db, req.actor));
    res.json(result.map((approval) => redactApprovalPayload(approval)));
  });

  router.get("/approvals/:id", async (req, res) => {
    const id = req.params.id as string;
    const approval = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
    if (!approval) return;
    if (!(await assertApprovalAccessAllowed(req, res, approval.companyId))) return;
    res.json(redactApprovalPayload(approval));
  });

  router.post("/companies/:companyId/approvals", validate(createApprovalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertApprovalAccessAllowed(req, res, companyId))) return;
    if (!(await assertApprovalMutationAllowedByRunContext(req, res, companyId))) return;
    const rawIssueIds = req.body.issueIds;
    const issueIds = Array.isArray(rawIssueIds)
      ? rawIssueIds.filter((value: unknown): value is string => typeof value === "string")
      : [];
    const uniqueIssueIds = Array.from(new Set(issueIds));
    const { issueIds: _issueIds, ...approvalInput } = req.body;
    const actor = getActorInfo(req);
    const requestedByAgentId = await resolveApprovalRequester(
      companyId,
      actor,
      approvalInput.requestedByAgentId ?? null,
    );
    const normalizedPayload =
      approvalInput.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            companyId,
            approvalInput.payload,
            { strictMode: strictSecretsMode },
          )
        : approvalInput.payload;

    // Fork: the approval and its issue links commit together, so a rejected
    // link (another company's issue, or a missing one) leaves no pending approval.
    const approval = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const created = await approvalService(txDb).create(companyId, {
        ...approvalInput,
        payload: normalizedPayload,
        requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
        requestedByAgentId,
        status: "pending",
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        updatedAt: new Date(),
      });

      if (uniqueIssueIds.length > 0) {
        await issueApprovalService(txDb).linkManyForApproval(created.id, uniqueIssueIds, {
          agentId: actor.agentId,
          userId: actor.actorType === "user" ? actor.actorId : null,
        });
      }
      return created;
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.created",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type, issueIds: uniqueIssueIds },
    });

    res.status(201).json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/issues", async (req, res) => {
    const id = req.params.id as string;
    const approval = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
    if (!approval) return;
    if (!(await assertApprovalAccessAllowed(req, res, approval.companyId))) return;
    const issues = await issueApprovalsSvc.listIssuesForApproval(id);
    res.json(issues);
  });

  router.post("/approvals/:id/approve", validate(approveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await requireApprovalAccess(req, id))) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const decidedByUserId = req.actor.userId ?? "board";
    let payloadPatch: Record<string, unknown> | undefined;
    let placement: ReturnType<typeof hirePlacementCheck> | undefined;
    const pending = await svc.getById(id);
    if (req.body.defaultEnvironmentId !== undefined && pending?.type !== "hire_agent") {
      throw unprocessable("An environment can only be chosen when approving a hire.");
    }
    if (pending?.type === "hire_agent") {
      // The approver may pick where the hired agent runs; the pick is written
      // into the approved payload, which activation applies to the agent.
      // Whatever environment the hire ends up with is checked here, including
      // one the requester put in the payload.
      const payload = pending.payload as Record<string, unknown>;
      const environmentId =
        req.body.defaultEnvironmentId !== undefined
          ? req.body.defaultEnvironmentId
          : typeof payload.defaultEnvironmentId === "string"
            ? payload.defaultEnvironmentId
            : null;
      const adapterType = typeof payload.adapterType === "string" ? payload.adapterType : "process";
      await assertEnvironmentSelectionForCompany(
        environmentService(db),
        pending.companyId,
        environmentId,
        { allowedDrivers: supportedEnvironmentDriversForAdapter(adapterType) },
      );
      // Fork: the runner follows the board's device pick. Checked before
      // anything is written; a decided approval is left to the idempotent
      // approve.
      const runnerPatch = req.body.defaultEnvironmentId !== undefined && resolvableApprovalStatuses.includes(pending.status)
        ? await hireRunnerForPickedEnvironment(pending.companyId, payload, req.body.defaultEnvironmentId)
        : {};
      if (req.body.defaultEnvironmentId !== undefined) {
        payloadPatch = { ...runnerPatch, defaultEnvironmentId: req.body.defaultEnvironmentId };
      }
      // Fork: a pool-bound hire's move passes the placement checks inside its activation (spec 5.6).
      placement = hirePlacementCheck(req);
    }
    const { approval, applied } = placement
      ? await svc.approve(id, decidedByUserId, req.body.decisionNote, { payloadPatch, beforeActivate: placement.beforeActivate })
      : await svc.approve(id, decidedByUserId, req.body.decisionNote);
    // Fork: the move's wakes and device re-check, now that the activation has committed.
    await placement?.afterCommit();

    if (applied) {
      const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
      const linkedIssueIds = linkedIssues.map((issue) => issue.id);
      const primaryIssueId = linkedIssueIds[0] ?? null;
      const lostReviewIssueIds = await lostReviewPathIssueIds(approval.companyId, linkedIssues);
      const primaryReviewPathContext = primaryIssueId && lostReviewIssueIds.has(primaryIssueId)
        ? approvalReviewPathContext(approval.id)
        : null;

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.approved",
        entityType: "approval",
        entityId: approval.id,
        details: {
          type: approval.type,
          requestedByAgentId: approval.requestedByAgentId,
          linkedIssueIds,
        },
      });

      let primaryReviewPathWakeCovered = false;
      if (approval.requestedByAgentId) {
        try {
          const wakeRun = await heartbeat.wakeup(approval.requestedByAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "approval_approved",
            payload: {
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId: primaryIssueId,
              issueIds: linkedIssueIds,
              ...(primaryReviewPathContext ?? {}),
            },
            requestedByActorType: "user",
            requestedByActorId: req.actor.userId ?? "board",
            contextSnapshot: {
              source: "approval.approved",
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId: primaryIssueId,
              issueIds: linkedIssueIds,
              taskId: primaryIssueId,
              wakeReason: "approval_approved",
              ...(primaryReviewPathContext ?? {}),
            },
          });
          primaryReviewPathWakeCovered = Boolean(wakeRun && primaryReviewPathContext);

          await logActivity(db, {
            companyId: approval.companyId,
            actorType: "user",
            actorId: req.actor.userId ?? "board",
            action: "approval.requester_wakeup_queued",
            entityType: "approval",
            entityId: approval.id,
            details: {
              requesterAgentId: approval.requestedByAgentId,
              wakeRunId: wakeRun?.id ?? null,
              linkedIssueIds,
            },
          });
        } catch (err) {
          logger.warn(
            {
              err,
              approvalId: approval.id,
              requestedByAgentId: approval.requestedByAgentId,
            },
            "failed to queue requester wakeup after approval",
          );
          await logActivity(db, {
            companyId: approval.companyId,
            actorType: "user",
            actorId: req.actor.userId ?? "board",
            action: "approval.requester_wakeup_failed",
            entityType: "approval",
            entityId: approval.id,
            details: {
              requesterAgentId: approval.requestedByAgentId,
              linkedIssueIds,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }

      await queueAdditionalApprovalReviewPathWakes({
        approvalId: approval.id,
        approvalStatus: approval.status,
        companyId: approval.companyId,
        linkedIssues,
        lostIssueIds: lostReviewIssueIds,
        alreadyWoken: primaryReviewPathWakeCovered && approval.requestedByAgentId && primaryIssueId
          ? { agentId: approval.requestedByAgentId, issueId: primaryIssueId }
          : null,
        requestedByUserId: req.actor.userId ?? "board",
      });
    }

    res.json(redactApprovalPayload(approval));
  });

  router.post("/approvals/:id/reject", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await requireApprovalAccess(req, id))) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const decidedByUserId = req.actor.userId ?? "board";
    const { approval, applied } = await svc.reject(id, decidedByUserId, req.body.decisionNote);

    if (applied) {
      const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
      const lostReviewIssueIds = await lostReviewPathIssueIds(approval.companyId, linkedIssues);
      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.rejected",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });
      await queueAdditionalApprovalReviewPathWakes({
        approvalId: approval.id,
        approvalStatus: approval.status,
        companyId: approval.companyId,
        linkedIssues,
        lostIssueIds: lostReviewIssueIds,
        requestedByUserId: req.actor.userId ?? "board",
      });
    }

    res.json(redactApprovalPayload(approval));
  });

  router.post(
    "/approvals/:id/request-revision",
    validate(requestApprovalRevisionSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      if (!(await requireApprovalAccess(req, id))) {
        res.status(404).json({ error: "Approval not found" });
        return;
      }
      const decidedByUserId = req.actor.userId ?? "board";
      const approval = await svc.requestRevision(id, decidedByUserId, req.body.decisionNote);

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.revision_requested",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });

      res.json(redactApprovalPayload(approval));
    },
  );

  router.post("/approvals/:id/resubmit", validate(resubmitApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
    if (!existing) return;
    if (!(await assertApprovalMutationAllowedByRunContext(req, res, existing.companyId))) return;

    if (req.actor.type === "agent" && req.actor.agentId !== existing.requestedByAgentId) {
      res.status(403).json({ error: "Only requesting agent can resubmit this approval" });
      return;
    }

    const normalizedPayload = req.body.payload
      ? existing.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            existing.companyId,
            req.body.payload,
            { strictMode: strictSecretsMode },
          )
        : req.body.payload
      : undefined;
    const approval = await svc.resubmit(id, normalizedPayload);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.resubmitted",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type },
    });
    res.json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const approval = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
    if (!approval) return;
    const comments = await svc.listComments(id);
    res.json(comments);
  });

  router.post("/approvals/:id/comments", validate(addApprovalCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const approval = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
    if (!approval) return;
    if (!(await assertApprovalMutationAllowedByRunContext(req, res, approval.companyId))) return;
    const actor = getActorInfo(req);
    const comment = await svc.addComment(id, req.body.body, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
    });

    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.comment_added",
      entityType: "approval",
      entityId: approval.id,
      details: { commentId: comment.id },
    });

    res.status(201).json(comment);
  });

  return router;
}
