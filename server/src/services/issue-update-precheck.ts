import { conflict, notFound, unprocessable } from "../errors.js";

/**
 * Rules that reject an issue update from the stored issue row, the patch and
 * facts the caller looked up. `issueService.update` runs them as the
 * authority. `issueService.precheckUpdate` runs them, with the rules that read
 * other rows, before the PATCH route's own side effects (stopping the
 * assignee's runner goal and cancelling its run), so a request that the update
 * would refuse never stops the assignee's work first.
 *
 * Keep this module free of database access; the service reads the facts.
 */

export const ALL_ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
];

/**
 * The keys of the update data that are not issue columns. `issueService.update`
 * takes them out of the patch before it writes the rest, and its build fails
 * when this list and its data type disagree.
 */
export const ISSUE_UPDATE_CONTROL_KEYS = [
  "labelIds",
  "blockedByIssueIds",
  "actorAgentId",
  "actorRunId",
  "caseHandoffId",
  "actorRunStopId",
  "actorUserId",
  "companyGuard",
  "workspaceSelectionActor",
  "expectedExecutionPolicy",
  "expectedStatusVersion",
] as const;

const issueUpdateControlKeys: ReadonlySet<string> = new Set(
  ISSUE_UPDATE_CONTROL_KEYS,
);

export interface IssueUpdatePrecheckIssue {
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  conversationAgentId: string | null;
}

/** `undefined` leaves the field unchanged, as in `issueService.update`. */
export interface IssueUpdatePrecheckPatch {
  status?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  conversationAgentId?: unknown;
  conversationUserId?: unknown;
  conversationState?: unknown;
  conversationSessionGeneration?: unknown;
  conversationBoundaryCommentId?: unknown;
  labelIds?: unknown;
  blockedByIssueIds?: unknown;
  expectedExecutionPolicy?: unknown;
  /** Guards a status-only backlog-to-todo promotion. */
  expectedStatusVersion?: number;
}

export interface IssueUpdatePrecheckFacts {
  /**
   * The chat conversation that binds the issue to an external channel, or null
   * when there is none. Leave it undefined when the caller did not look the
   * binding up; `issueService.update` always looks it up for an agent change.
   */
  externalChannelConversationId?: string | null;
  /**
   * Whether the project the patch moves the issue to exists in the issue's
   * company. Leave it undefined when the patch names no project or the caller
   * did not look it up; `issueService.update` always looks it up.
   */
  projectFound?: boolean;
}

export function issueUpdateChangesAssigneeAgent(
  existing: Pick<IssueUpdatePrecheckIssue, "assigneeAgentId">,
  patch: Pick<IssueUpdatePrecheckPatch, "assigneeAgentId">,
) {
  return (
    patch.assigneeAgentId !== undefined &&
    patch.assigneeAgentId !== existing.assigneeAgentId
  );
}

/**
 * Throws the same error `issueService.update` returns for these rules, in the
 * same order. Every rule reads only its arguments.
 */
export function assertIssueUpdatePrecheck(
  existing: IssueUpdatePrecheckIssue,
  patch: IssueUpdatePrecheckPatch,
  facts: IssueUpdatePrecheckFacts = {},
): void {
  if (existing.conversationAgentId) {
    if (
      (patch.assigneeAgentId !== undefined &&
        patch.assigneeAgentId !== existing.conversationAgentId) ||
      patch.assigneeUserId ||
      patch.conversationAgentId !== undefined ||
      patch.conversationUserId !== undefined ||
      patch.conversationState !== undefined ||
      patch.conversationSessionGeneration !== undefined ||
      patch.conversationBoundaryCommentId !== undefined ||
      patch.status === "done" ||
      patch.status === "cancelled"
    ) {
      throw unprocessable(
        "Conversation identity is fixed; finish the reply instead of completing or reassigning the conversation",
      );
    }
  }
  if (
    patch.expectedStatusVersion !== undefined &&
    (patch.status !== "todo" ||
      Object.keys(patch).some(
        (key) => key !== "status" && !issueUpdateControlKeys.has(key),
      ) ||
      patch.labelIds !== undefined ||
      patch.blockedByIssueIds !== undefined ||
      patch.expectedExecutionPolicy !== undefined)
  ) {
    throw unprocessable(
      "expectedStatusVersion requires a status-only backlog-to-todo promotion",
    );
  }
  if (
    facts.externalChannelConversationId &&
    issueUpdateChangesAssigneeAgent(existing, patch)
  ) {
    throw conflict(
      "Agent assignment cannot change while this task is bound to an external channel",
      {
        code: "chat_binding_agent_locked",
        conversationId: facts.externalChannelConversationId,
      },
    );
  }
  if (
    patch.status &&
    patch.status !== existing.status &&
    !ALL_ISSUE_STATUSES.includes(patch.status)
  ) {
    throw conflict(`Unknown issue status: ${patch.status}`);
  }
  if (facts.projectFound === false) {
    throw notFound("Project not found");
  }

  const nextAssigneeAgentId =
    patch.assigneeAgentId !== undefined
      ? patch.assigneeAgentId
      : existing.assigneeAgentId;
  const nextAssigneeUserId =
    patch.assigneeUserId !== undefined
      ? patch.assigneeUserId
      : existing.assigneeUserId;
  if (nextAssigneeAgentId && nextAssigneeUserId) {
    throw unprocessable("Issue can only have one assignee");
  }
  if (
    patch.status === "in_progress" &&
    !nextAssigneeAgentId &&
    !nextAssigneeUserId
  ) {
    throw unprocessable("in_progress issues require an assignee");
  }
}
