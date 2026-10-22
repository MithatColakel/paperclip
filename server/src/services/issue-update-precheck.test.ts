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
