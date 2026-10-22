// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentAiAccountBindingDetail, AgentDetail, AgentRuntimeState, HeartbeatRun, Issue } from "@paperclipai/shared";
import { describe, expect, it, vi } from "vitest";
import { aiAccountPoolKeys } from "@/api/ai-account-pool";
import { AgentOverview, RunAiPoolAccountBadge } from "./AgentDetail";
import { queryKeys } from "../lib/queryKeys";

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
      <a href={to} {...props}>{children}</a>
    ),
  };
});

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div>{children}</div>,
}));

describe("AgentOverview", () => {
  it("identifies Muse and shows its provider-managed model even when old model fields remain", () => {
    const agent = {
      id: "muse-agent", companyId: "company-1", name: "Muse Researcher", role: "researcher", status: "active",
      adapterType: "paperclip_runner", adapterConfig: { provider: "muse", model: "old-model" },
      runtimeConfig: { model: "old-runtime-model" },
    } as unknown as AgentDetail;
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <AgentOverview agent={agent} runs={[]} assignedIssues={[]} directReportCount={0} skillNames={[]} agentRouteId="muse-agent" />
      </QueryClientProvider>,
    );
    expect(markup).toContain("Muse — Personal agent");
    expect(markup).toContain("Managed by Muse");
    expect(markup).not.toContain("Adapter default");
    expect(markup).not.toContain("old-model");
    expect(markup).not.toContain("old-runtime-model");
  });

  it("prioritizes identity, capability, runtime, skills, tasks, and scoped Audit entry points", () => {
    const agent = {
      id: "agent-1",
      companyId: "company-1",
      name: "Codex Coder",
      urlKey: "codexcoder",
      role: "engineer",
      title: "Product engineer",
      status: "active",
      reportsTo: null,
      capabilities: "Builds and verifies product changes.",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.6-sol" },
      runtimeConfig: {},
      chainOfCommand: [],
      access: { canAssignTasks: true, taskAssignSource: "explicit_grant", membership: null, grants: [] },
    } as unknown as AgentDetail;
    const issue = {
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-42",
      title: "Simplify agent information architecture",
      status: "in_progress",
      priority: "high",
      updatedAt: new Date("2026-08-31T12:00:00Z"),
    } as unknown as Issue;
    const runtime = {
      sessionDisplayId: "codex-session-42",
    } as unknown as AgentRuntimeState;

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <AgentOverview
          agent={agent}
          runs={[] as HeartbeatRun[]}
          assignedIssues={[issue]}
          runtimeState={runtime}
          directReportCount={2}
          skillNames={["Design Guide", "Check PR"]}
          agentRouteId="codexcoder"
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain("Identity");
    expect(markup).toContain("Capabilities");
    expect(markup).toContain("Harness / Runtime");
    expect(markup).toContain("Design Guide");
    expect(markup).toContain("Simplify agent information architecture");
    expect(markup).toContain("PAP-42");
    expect(markup).toContain('href="/activity/costs?agentId=agent-1"');
    expect(markup).not.toContain("Run Activity");
    expect(markup).not.toContain("Tasks by Status");
    // Fork: the Claude account rows are for Claude agents only.
    expect(markup).not.toContain("Claude account");
    expect(markup).not.toContain("Created by");
  });

  function renderOverview(createdByUserId: string | null, client: QueryClient) {
    const agent = {
      id: "agent-2",
      companyId: "company-1",
      name: "Shared Agent",
      urlKey: "sharedagent",
      role: "engineer",
      title: null,
      status: "idle",
      reportsTo: null,
      capabilities: null,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      createdByUserId,
      chainOfCommand: [],
      access: { canAssignTasks: true, taskAssignSource: "explicit_grant", membership: null, grants: [] },
    } as unknown as AgentDetail;
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <AgentOverview
          agent={agent}
          runs={[] as HeartbeatRun[]}
          assignedIssues={[]}
          directReportCount={0}
          skillNames={[]}
          agentRouteId="sharedagent"
        />
      </QueryClientProvider>,
    );
  }

  function renderWithDirectory(createdByUserId: string, principalIds: string[]) {
    const client = new QueryClient();
    client.setQueryData(queryKeys.access.companyUserDirectory("company-1"), {
      users: principalIds.map((principalId) => ({
        principalId,
        status: "active",
        user: { id: principalId, name: principalId === "user-alice" ? "Alice Admin" : "Bob Builder", email: null, image: null },
      })),
    });
    return renderOverview(createdByUserId, client);
  }

  it("shows who created the agent when the company has more than one human user", () => {
    const markup = renderWithDirectory("user-alice", ["user-alice", "user-bob"]);
    expect(markup).toContain("Created by");
    expect(markup).toContain("Alice Admin");
  });

  it("hides the creator when only one human user shares the company with the Board", () => {
    const markup = renderWithDirectory("user-alice", ["user-alice", "local-board"]);
    expect(markup).not.toContain("Created by");
  });

  function failedDirectoryClient() {
    const client = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
    client.getQueryCache().build(client, { queryKey: queryKeys.access.companyUserDirectory("company-1") }).setState({
      status: "error",
      error: new Error("Directory unavailable"),
      fetchStatus: "idle",
    });
    return client;
  }

  it("shows an error when the company user directory cannot be loaded", () => {
    const markup = renderOverview("user-alice", failedDirectoryClient());
    expect(markup).toContain("Created by");
    expect(markup).toContain("Could not load creator");
  });

  it.each([null, "local-board"])("keeps the creator row hidden for creator %s when the directory failed", (createdByUserId) => {
    const markup = renderOverview(createdByUserId, failedDirectoryClient());
    expect(markup).not.toContain("Created by");
    expect(markup).not.toContain("Could not load creator");
  });

  it("adds the Device and Claude account rows for a Claude agent", () => {
    const agent = {
      id: "agent-2",
      companyId: "company-1",
      name: "Claude Coder",
      urlKey: "claudecoder",
      role: "engineer",
      title: null,
      status: "idle",
      reportsTo: null,
      capabilities: null,
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      chainOfCommand: [],
      access: { canAssignTasks: false, taskAssignSource: "none", membership: null, grants: [] },
    } as unknown as AgentDetail;
    const client = new QueryClient();
    client.setQueryData(aiAccountPoolKeys.agent("agent-2"), {
      agentId: "agent-2",
      agentName: "Claude Coder",
      companyId: "company-1",
      adapterType: "claude_local",
      supported: true,
      state: "pool_account",
      mode: "pool_account",
      account: {
        id: "acct-1", label: "Team Max", credentialType: "subscription", state: "active",
        ownedByMe: false, ownerName: "Ada", exhaustedUntil: null, limitSource: null,
      },
      source: "manual",
      migrationNote: null,
      reviewedAt: null,
      needsReview: false,
      devices: [{ id: "device-1", name: "Build box", kind: "ssh_host", owner: { userId: "user-ada", name: "Ada", email: "ada@example.com" } }],
      pinned: true,
      overridesAiConnection: false,
      canChange: true,
      updatedAt: null,
      options: [],
    } satisfies AgentAiAccountBindingDetail);

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <AgentOverview
          agent={agent}
          runs={[] as HeartbeatRun[]}
          assignedIssues={[]}
          directReportCount={0}
          skillNames={[]}
          agentRouteId="claudecoder"
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain("Device");
    expect(markup).toContain("Build box — owner ada@example.com");
    expect(markup).toContain("Claude account");
    expect(markup).toContain("Team Max");
    // The row links to the Claude account field in the Configuration view; Configure links to the view itself.
    expect(markup).toMatch(/<a href="\/agents\/claudecoder\/runtime#claude-account"[^>]*aria-label="Change the Claude account"[^>]*>Change<\/a>/);
    expect(markup).toMatch(/<a [^>]*href="\/agents\/claudecoder\/runtime"[^>]*>Configure<\/a>/);
  });
});

// Fork: a run's detail names the Claude account that served it.
describe("RunAiPoolAccountBadge", () => {
  it("names the Claude account of a pool-account run", () => {
    const markup = renderToStaticMarkup(
      <RunAiPoolAccountBadge contextSnapshot={{ aiConnection: { mode: "pool_account", accountName: "Team Max" } }} />,
    );
    expect(markup).toContain("Claude account: Team Max");
  });

  it("keeps the legacy company-pool badge and shows nothing for other runs", () => {
    expect(renderToStaticMarkup(
      <RunAiPoolAccountBadge contextSnapshot={{ aiConnection: { mode: "company_pool", poolPriority: 1 } }} />,
    )).toContain("AI pool account #2");
    expect(renderToStaticMarkup(
      <RunAiPoolAccountBadge contextSnapshot={{ aiConnection: { mode: "responsible_user", provider: "anthropic" } }} />,
    )).toBe("");
    expect(renderToStaticMarkup(<RunAiPoolAccountBadge contextSnapshot={null} />)).toBe("");
  });
});
