import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";

/*
 * Fork: a person's comment on a task that waits for a device, a Claude account
 * or an account slot (spec 7.5, 7.6, 18). The route half: the task keeps its
 * status, its waiting run is never cancelled, and the resource is checked.
 * heartbeat-resource-waits.test.ts covers the heartbeat half (the comment wake
 * merges into the waiting run; the check answers without promoting).
 */

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdForUpdate: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  getDependencyReadiness: vi.fn(),
  getCurrentScheduledRetry: vi.fn(),
  findMentionedAgents: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  getRelationSummaries: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  checkResourceWaitNow: vi.fn(async (_input: unknown): Promise<unknown> => ({ outcome: "still_unavailable", promoted: false })),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockTxInsertValues = vi.hoisted(() => vi.fn(async () => undefined));
const mockTxInsert = vi.hoisted(() =>
  vi.fn(() => ({ values: mockTxInsertValues })),
);
const mockTx = vi.hoisted(() => ({
  insert: mockTxInsert,
}));
const mockDbSelectOrderBy = vi.hoisted(() => vi.fn(async () => []));
const mockDbSelectWhere = vi.hoisted(() =>
  vi.fn(() => ({
    orderBy: mockDbSelectOrderBy,
    then: (
      onFulfilled: (rows: unknown[]) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve([]).then(onFulfilled, onRejected),
  })),
);
const mockDbSelectFrom = vi.hoisted(() =>
  vi.fn(() => ({ where: mockDbSelectWhere })),
);
const mockDbSelect = vi.hoisted(() =>
  vi.fn(() => ({ from: mockDbSelectFrom })),
);
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
  transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) =>
    fn(mockTx),
  ),
}));
const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(async () => []),
  saveIssueVote: vi.fn(async () => ({
    vote: null,
    consentEnabledNow: false,
    sharingEnabled: false,
  })),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    id: "instance-settings-1",
    general: {
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
    },
  })),
  listCompanyIds: vi.fn(async () => ["company-1"]),
}));
const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(async () => undefined),
}));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expirePendingInteractionsForTerminalIssue: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  listForIssue: vi.fn(async () => []),
}));
const mockIssueRecoveryActionService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
}));
const mockIssueTreeControlService = vi.hoisted(() => ({
  getActivePauseHoldGate: vi.fn(async () => null),
}));
const mockExternalObjectService = vi.hoisted(() => ({
  syncCommentSafely: vi.fn(async () => undefined),
  syncIssueSafely: vi.fn(async () => undefined),
}));
const mockObserveCrossIssueInfluence = vi.hoisted(() => vi.fn());
const mockCrossIssueInfluenceLimitError = vi.hoisted(() => vi.fn());
const mockCrossIssueInfluenceRunContextError = vi.hoisted(() => vi.fn());
const mockRunnerGoalService = vi.hoisted(() => ({
  projection: vi.fn(async () => null),
  act: vi.fn(),
}));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
}));

vi.mock("../services/queued-interaction-response.js", () => ({
  hasQueuedInteractionResponse: vi.fn(async () => false),
}));

vi.mock("../services/access.js", () => ({
  accessService: () => mockAccessService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));

vi.mock("../services/feedback.js", () => ({
  feedbackService: () => mockFeedbackService,
}));

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => mockHeartbeatService,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));

vi.mock("../services/routines.js", () => ({
  routineService: () => mockRoutineService,
}));

vi.mock("../services/runner-goals.js", () => ({
  runnerGoalService: () => mockRunnerGoalService,
  RunnerGoalActionError: class RunnerGoalActionError extends Error {},
  RunnerGoalConflictError: class RunnerGoalConflictError extends Error {},
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1" })),
  }),
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
  }),
  documentAnnotationService: () => ({
    remapOpenThreadsForDocument: async () => [],
  }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => mockFeedbackService,
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => mockIssueRecoveryActionService,
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueService: () => mockIssueService,
  issueThreadInteractionService: () => mockIssueThreadInteractionService,
  issueTreeControlService: () => mockIssueTreeControlService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => mockRoutineService,
  workProductService: () => ({}),
}));

vi.mock("../services/external-objects.js", () => ({
  externalObjectService: () => mockExternalObjectService,
}));

vi.mock("../services/cross-issue-influence-limit.js", () => ({
  observeCrossIssueInfluence: mockObserveCrossIssueInfluence,
  crossIssueInfluenceLimitError: mockCrossIssueInfluenceLimitError,
  crossIssueInfluenceRunContextError: mockCrossIssueInfluenceRunContextError,
}));

function createApp() {
  const app = express();
  app.use(express.json());
  return app;
}

async function installActor(
  app: express.Express,
  actor?: Record<string, unknown>,
) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/issues.js"),
    import("../middleware/index.js"),
  ]);
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(
  status:
    | "backlog"
    | "todo"
    | "done"
    | "blocked"
    | "cancelled"
    | "in_progress"
    | "in_review",
) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    status,
    assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-580",
    title: "Waiting for a device",
  };
}

function agentActor(agentId = "22222222-2222-4222-8222-222222222222") {
  return {
    type: "agent",
    agentId,
    companyId: "company-1",
    source: "agent_key",
    runId: "run-1",
  };
}

async function waitForWakeup(assertion: () => void) {
  await vi.waitFor(assertion);
}

describe("issue comments on a task waiting for a resource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockReset();
    mockIssueService.getByIdForUpdate.mockReset();
    mockIssueService.assertCheckoutOwner.mockReset();
    mockIssueService.update.mockReset();
    mockIssueService.addComment.mockReset();
    mockIssueService.getDependencyReadiness.mockReset();
    mockIssueService.getCurrentScheduledRetry.mockReset();
    mockIssueService.findMentionedAgents.mockReset();
    mockIssueService.listWakeableBlockedDependents.mockReset();
    mockIssueService.getWakeableParentAfterChildCompletion.mockReset();
    mockAccessService.canUser.mockReset();
    mockAccessService.decide.mockReset();
    mockAccessService.hasPermission.mockReset();
    mockHeartbeatService.wakeup.mockReset();
    mockHeartbeatService.reportRunActivity.mockReset();
    mockHeartbeatService.getRun.mockReset();
    mockHeartbeatService.getActiveRunForAgent.mockReset();
    mockHeartbeatService.cancelRun.mockReset();
    mockHeartbeatService.checkResourceWaitNow.mockReset();
    mockAgentService.getById.mockReset();
    mockAgentService.list.mockReset();
    mockAgentService.resolveByReference.mockReset();
    mockLogActivity.mockReset();
    mockFeedbackService.listIssueVotesForUser.mockReset();
    mockFeedbackService.saveIssueVote.mockReset();
    mockInstanceSettingsService.get.mockReset();
    mockInstanceSettingsService.listCompanyIds.mockReset();
    mockRoutineService.syncRunStatusForIssue.mockReset();
    mockIssueThreadInteractionService.listForIssue.mockReset();
    mockIssueRecoveryActionService.getActiveForIssue.mockReset();
    mockIssueTreeControlService.getActivePauseHoldGate.mockReset();
    mockExternalObjectService.syncCommentSafely.mockReset();
    mockExternalObjectService.syncIssueSafely.mockReset();
    mockObserveCrossIssueInfluence.mockReset();
    mockCrossIssueInfluenceLimitError.mockReset();
    mockCrossIssueInfluenceRunContextError.mockReset();
    mockTxInsertValues.mockReset();
    mockTxInsert.mockReset();
    mockDbSelect.mockReset();
    mockDbSelectFrom.mockReset();
    mockDbSelectWhere.mockReset();
    mockDbSelectOrderBy.mockReset();
    mockDb.transaction.mockReset();
    mockTxInsertValues.mockResolvedValue(undefined);
    mockTxInsert.mockImplementation(() => ({ values: mockTxInsertValues }));
    mockDbSelectOrderBy.mockResolvedValue([]);
    mockDbSelectWhere.mockImplementation(() => ({
      orderBy: mockDbSelectOrderBy,
      then: (
        onFulfilled: (rows: unknown[]) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => Promise.resolve([]).then(onFulfilled, onRejected),
    }));
    mockDbSelectFrom.mockImplementation(() => ({ where: mockDbSelectWhere }));
    mockDbSelect.mockImplementation(() => ({ from: mockDbSelectFrom }));
    mockDb.transaction.mockImplementation(
      async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx),
    );
    mockIssueService.getByIdForUpdate.mockImplementation(async () =>
      mockIssueService.getById(),
    );
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockHeartbeatService.reportRunActivity.mockResolvedValue(undefined);
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
    mockHeartbeatService.checkResourceWaitNow.mockResolvedValue({ outcome: "still_unavailable", promoted: false });
    mockExternalObjectService.syncCommentSafely.mockResolvedValue(undefined);
    mockExternalObjectService.syncIssueSafely.mockResolvedValue(undefined);
    mockObserveCrossIssueInfluence.mockResolvedValue({
      allowed: true,
      mode: "log_only",
      count: 1,
      cap: 20,
      enforceAt: "2026-08-11T00:00:00.000Z",
    });
    mockCrossIssueInfluenceLimitError.mockImplementation(
      (decision: { count: number; cap: number }) => ({
        error: `Cross-issue influence cap exceeded: this run is limited to ${decision.cap} cross-issue comments or updates`,
        details: {
          code: "cross_issue_influence_cap_exceeded",
          count: decision.count,
          cap: decision.cap,
        },
      }),
    );
    mockCrossIssueInfluenceRunContextError.mockImplementation(
      () =>
        new HttpError(
          403,
          "Agent issue comments and updates require a valid heartbeat run so cross-issue influence can be contained",
          { code: "cross_issue_influence_run_context_required" },
        ),
    );
    mockLogActivity.mockResolvedValue(undefined);
    mockFeedbackService.listIssueVotesForUser.mockResolvedValue([]);
    mockFeedbackService.saveIssueVote.mockResolvedValue({
      vote: null,
      consentEnabledNow: false,
      sharingEnabled: false,
    });
    mockInstanceSettingsService.get.mockResolvedValue({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);
    mockRoutineService.syncRunStatusForIssue.mockResolvedValue(undefined);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(null);
    mockIssueTreeControlService.getActivePauseHoldGate.mockResolvedValue(null);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      body: "hello",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: null,
      authorUserId: "local-board",
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: "11111111-1111-4111-8111-111111111111",
      blockerIssueIds: [],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      allBlockersDone: true,
      isDependencyReady: true,
    });
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue(null);
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(
      null,
    );
    mockIssueService.assertCheckoutOwner.mockResolvedValue({
      adoptedFromRunId: null,
    });
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.decide.mockImplementation(
      async (input: { action?: string }) => {
        const allowed = input.action !== "tasks:manage_active_checkouts";
        return {
          allowed,
          action: input.action,
          reason: allowed ? "allow_explicit_grant" : "deny_missing_grant",
          explanation: allowed
            ? "Allowed by test grant."
            : "Missing active checkout override.",
        };
      },
    );
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAgentService.getById.mockResolvedValue(null);
    mockAgentService.list.mockResolvedValue([
      {
        id: "22222222-2222-4222-8222-222222222222",
        reportsTo: null,
        permissions: { canCreateAgents: false },
      },
      {
        id: "44444444-4444-4444-8444-444444444444",
        reportsTo: null,
        permissions: { canCreateAgents: false },
      },
    ]);
    mockAgentService.resolveByReference.mockImplementation(
      async (_companyId: string, reference: string) => {
        if (reference === "ambiguous-codex") {
          return { ambiguous: true, agent: null };
        }
        if (reference === "missing-codex") {
          return { ambiguous: false, agent: null };
        }
        if (reference === "codexcoder") {
          return {
            ambiguous: false,
            agent: { id: "33333333-3333-4333-8333-333333333333" },
          };
        }
        return {
          ambiguous: false,
          agent: { id: reference },
        };
      },
    );
  });

  const issueId = "11111111-1111-4111-8111-111111111111";
  const assigneeId = "22222222-2222-4222-8222-222222222222";

  /** The task's current retry: a device wait by default (spec 7.1 lanes). */
  function currentRetry(overrides: Record<string, unknown> = {}) {
    return {
      runId: "retry-run-1",
      status: "scheduled_retry",
      agentId: assigneeId,
      agentName: "CodexCoder",
      retryOfRunId: "deferred-run-1",
      scheduledRetryAt: new Date("2026-10-17T14:00:00.000Z"),
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "environment_wait",
      error: null,
      errorCode: null,
      ...overrides,
    };
  }

  function waitingIssue() {
    const issue = { ...makeIssue("in_progress"), executionRunId: "retry-run-1" };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(
      async (_id: string, patch: Record<string, unknown>) => ({ ...issue, ...patch, updatedAt: new Date() }),
    );
    return issue;
  }

  /** The check reads a stored comment: it starts only after the comment is saved. */
  function expectCheckAfterComment() {
    const [stored] = mockIssueService.addComment.mock.invocationCallOrder;
    const [checked] = mockHeartbeatService.checkResourceWaitNow.mock.invocationCallOrder;
    expect(stored).toBeDefined();
    expect(checked).toBeDefined();
    expect(stored!).toBeLessThan(checked!);
  }

  function expectNoStatusChange() {
    expect(mockIssueService.update).not.toHaveBeenCalledWith(issueId, expect.objectContaining({ status: "todo" }));
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ details: expect.objectContaining({ scheduledRetrySupersededByComment: true }) }),
    );
  }

  it.each(["environment_wait", "ai_account_wait", "device_slot_wait"])(
    "keeps a %s task in progress and its waiting run, then checks the resource (POST comment)",
    async (lane) => {
      waitingIssue();
      mockIssueService.getCurrentScheduledRetry.mockResolvedValue(currentRetry({ scheduledRetryReason: lane }));

      const res = await request(await installActor(createApp()))
        .post(`/api/issues/${issueId}/comments`)
        .send({ body: "Is the device back?" });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expectNoStatusChange();
      await waitForWakeup(() =>
        expect(mockHeartbeatService.checkResourceWaitNow).toHaveBeenCalledWith({
          runId: "retry-run-1",
          companyId: "company-1",
          source: "comment",
        }),
      );
      expectCheckAfterComment();
      // The comment's wake goes to the assignee as usual; heartbeat merges it into the waiting run.
      await waitForWakeup(() =>
        expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
          assigneeId,
          expect.objectContaining({ reason: "issue_commented", payload: expect.objectContaining({ commentId: "comment-1" }) }),
        ),
      );
    },
  );

  it("keeps a waiting task in progress on the PATCH comment path and checks the resource", async () => {
    waitingIssue();
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue(currentRetry());

    const res = await request(await installActor(createApp()))
      .patch(`/api/issues/${issueId}`)
      .send({ comment: "The device should be awake now." });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expectNoStatusChange();
    await waitForWakeup(() =>
      expect(mockHeartbeatService.checkResourceWaitNow).toHaveBeenCalledWith({
        runId: "retry-run-1",
        companyId: "company-1",
        source: "comment",
      }),
    );
    expectCheckAfterComment();
  });

  it("never fails a comment because the resource is still down, the check ran a minute ago, or the check broke", async () => {
    waitingIssue();
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue(currentRetry());
    const outcomes = [
      () => Promise.resolve({ outcome: "rate_limited", retryAfterMs: 60_000, promoted: false }),
      () => Promise.resolve({ outcome: "still_unavailable", promoted: false, details: { code: "resource_still_unavailable" } }),
      () => Promise.reject(new Error("probe failed")),
    ];
    for (const outcome of outcomes) {
      mockHeartbeatService.checkResourceWaitNow.mockReset();
      mockHeartbeatService.checkResourceWaitNow.mockImplementation(outcome);
      const res = await request(await installActor(createApp()))
        .post(`/api/issues/${issueId}/comments`)
        .send({ body: "Checking in." });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      await waitForWakeup(() => expect(mockHeartbeatService.checkResourceWaitNow).toHaveBeenCalledTimes(1));
    }
    expectNoStatusChange();
  });

  it("leaves a promoted resource-wait run alone and checks nothing", async () => {
    waitingIssue();
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue(currentRetry({ status: "queued" }));

    const res = await request(await installActor(createApp()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Starting soon?" });

    expect(res.status).toBe(201);
    expectNoStatusChange();
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalled());
    expect(mockHeartbeatService.checkResourceWaitNow).not.toHaveBeenCalled();
  });

  it("still moves a task whose retry is not a resource wait back to todo, as before", async () => {
    waitingIssue();
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue(currentRetry({ scheduledRetryReason: "transient_failure" }));
    mockHeartbeatService.cancelRun.mockResolvedValue({
      id: "retry-run-1",
      companyId: "company-1",
      agentId: assigneeId,
      status: "cancelled",
    });

    const res = await request(await installActor(createApp()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Please continue." });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).toHaveBeenCalledWith(issueId, { status: "todo" });
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("retry-run-1");
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalled());
    expect(mockHeartbeatService.checkResourceWaitNow).not.toHaveBeenCalled();
  });

  it("checks nothing for an agent's comment on a waiting task", async () => {
    waitingIssue();
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue(currentRetry());

    const res = await request(await installActor(createApp(), agentActor("44444444-4444-4444-8444-444444444444")))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "FYI from another agent." });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expectNoStatusChange();
    expect(mockIssueService.getCurrentScheduledRetry).not.toHaveBeenCalled();
    expect(mockHeartbeatService.checkResourceWaitNow).not.toHaveBeenCalled();
  });
});
