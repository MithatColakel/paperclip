import { describe, expect, it } from "vitest";
import { HttpError } from "../errors.js";
import {
  assertIssueUpdatePrecheck,
  type IssueUpdatePrecheckFacts,
  type IssueUpdatePrecheckIssue,
  type IssueUpdatePrecheckPatch,
} from "./issue-update-precheck.js";

const CONVERSATION_IDENTITY_ERROR =
  "Conversation identity is fixed; finish the reply instead of completing or reassigning the conversation";

const task: IssueUpdatePrecheckIssue = {
  status: "in_progress",
  assigneeAgentId: "agent-1",
  assigneeUserId: null,
  conversationAgentId: null,
};
const conversation: IssueUpdatePrecheckIssue = {
  ...task,
  status: "in_review",
  conversationAgentId: "agent-1",
};

function rejection(
  existing: IssueUpdatePrecheckIssue,
  patch: IssueUpdatePrecheckPatch,
  facts?: IssueUpdatePrecheckFacts,
) {
  try {
    assertIssueUpdatePrecheck(existing, patch, facts);
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    const httpError = error as HttpError;
    return { status: httpError.status, message: httpError.message, details: httpError.details };
  }
  return null;
}

describe("assertIssueUpdatePrecheck", () => {
  it("fixes a conversation's assignee, identity and open status", () => {
    for (const patch of [
      { assigneeAgentId: "agent-2" },
      { assigneeAgentId: null },
      { assigneeAgentId: null, assigneeUserId: "user-1" },
      { assigneeUserId: "user-1" },
      { status: "done" },
      { status: "cancelled" },
      { conversationAgentId: "agent-2" },
      { conversationUserId: "user-2" },
      { conversationState: "active" },
      { conversationSessionGeneration: 2 },
      { conversationBoundaryCommentId: null },
    ]) {
      expect(rejection(conversation, patch), JSON.stringify(patch)).toEqual({
        status: 422,
        message: CONVERSATION_IDENTITY_ERROR,
        details: undefined,
      });
    }
  });

  it("lets a conversation keep its agent and change its working status", () => {
    for (const patch of [
      {},
      { assigneeAgentId: "agent-1" },
      { assigneeUserId: null },
      { status: "in_progress" },
      { status: "in_review", assigneeAgentId: "agent-1" },
    ]) {
      expect(rejection(conversation, patch), JSON.stringify(patch)).toBeNull();
    }
  });

  it("locks the agent of a task bound to an external channel when the binding is known", () => {
    const facts = { externalChannelConversationId: "chat-1" };
    expect(rejection(task, { assigneeAgentId: "agent-2" }, facts)).toEqual({
      status: 409,
      message: "Agent assignment cannot change while this task is bound to an external channel",
      details: { code: "chat_binding_agent_locked", conversationId: "chat-1" },
    });
    expect(rejection(task, { assigneeAgentId: "agent-1" }, facts)).toBeNull();
    expect(rejection(task, { status: "todo" }, facts)).toBeNull();
    expect(rejection(task, { assigneeAgentId: "agent-2" }, { externalChannelConversationId: null })).toBeNull();
    expect(rejection(task, { assigneeAgentId: "agent-2" })).toBeNull();
  });

  it("reports the conversation rule before the channel binding, as the update does", () => {
    expect(
      rejection(conversation, { assigneeAgentId: "agent-2" }, { externalChannelConversationId: "chat-1" })?.status,
    ).toBe(422);
  });

  it("rejects an unknown status only when the status changes", () => {
    expect(rejection(task, { status: "archived" })).toEqual({
      status: 409,
      message: "Unknown issue status: archived",
      details: undefined,
    });
    expect(rejection({ ...task, status: "archived" }, { status: "archived" })).toBeNull();
  });

  it("allows expectedStatusVersion only on a status-only promotion to todo", () => {
    const backlog: IssueUpdatePrecheckIssue = { ...task, status: "backlog" };
    const refusal = {
      status: 422,
      message: "expectedStatusVersion requires a status-only backlog-to-todo promotion",
      details: undefined,
    };
    for (const patch of [
      { status: "in_progress", expectedStatusVersion: 3 },
      { expectedStatusVersion: 3 },
      { status: "todo", title: "Renamed", expectedStatusVersion: 3 },
      // A column the caller set to undefined still counts, as in the update.
      { status: "todo", hiddenAt: undefined, expectedStatusVersion: 3 },
      { status: "todo", labelIds: [], expectedStatusVersion: 3 },
      { status: "todo", blockedByIssueIds: [], expectedStatusVersion: 3 },
      { status: "todo", expectedExecutionPolicy: null, expectedStatusVersion: 3 },
    ]) {
      expect(rejection(backlog, patch), JSON.stringify(patch)).toEqual(refusal);
    }
    // The update's own control keys are not issue columns.
    expect(rejection(backlog, {
      status: "todo",
      expectedStatusVersion: 3,
      labelIds: undefined,
      actorAgentId: "agent-1",
      actorRunId: "run-1",
      actorRunStopId: null,
      actorUserId: null,
      caseHandoffId: undefined,
      companyGuard: "company-1",
      workspaceSelectionActor: { type: "agent" },
    } as IssueUpdatePrecheckPatch)).toBeNull();
    expect(rejection(backlog, { status: "todo", title: "Renamed" } as IssueUpdatePrecheckPatch)).toBeNull();
  });

  it("reports the conversation rule, then expectedStatusVersion, then the channel binding, as the update does", () => {
    const facts = { externalChannelConversationId: "chat-1" };
    expect(rejection(conversation, { status: "done", expectedStatusVersion: 1 }, facts)?.message)
      .toBe(CONVERSATION_IDENTITY_ERROR);
    expect(rejection(task, { assigneeAgentId: "agent-2", expectedStatusVersion: 1 }, facts)?.status)
      .toBe(422);
    expect(rejection(task, { assigneeAgentId: "agent-2" }, facts)?.status).toBe(409);
  });

  it("refuses a missing project after the status and before the assignees, as the update does", () => {
    expect(rejection(task, { status: "todo" }, { projectFound: false })).toEqual({
      status: 404,
      message: "Project not found",
      details: undefined,
    });
    expect(rejection(task, { status: "archived" }, { projectFound: false })?.status).toBe(409);
    expect(rejection(task, { assigneeUserId: "user-1" }, { projectFound: false })?.status).toBe(404);
    expect(rejection(task, { status: "todo" }, { projectFound: true })).toBeNull();
    expect(rejection(task, { status: "todo" })).toBeNull();
  });

  it("keeps a single assignee and requires one for in_progress", () => {
    expect(rejection(task, { assigneeUserId: "user-1" })).toEqual({
      status: 422,
      message: "Issue can only have one assignee",
      details: undefined,
    });
    expect(rejection(task, { assigneeAgentId: null, assigneeUserId: "user-1" })).toBeNull();
    expect(rejection(task, { assigneeAgentId: null, status: "in_progress" })).toEqual({
      status: 422,
      message: "in_progress issues require an assignee",
      details: undefined,
    });
    expect(rejection(task, { assigneeAgentId: null, status: "todo" })).toBeNull();
  });
});
