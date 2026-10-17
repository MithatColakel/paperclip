// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentAiAccountBindingDetail, AgentDetail, AgentRuntimeState, HeartbeatRun, Issue } from "@paperclipai/shared";
import { describe, expect, it, vi } from "vitest";
import { aiAccountPoolKeys } from "@/api/ai-account-pool";
import { AgentOverview, RunAiPoolAccountBadge } from "./AgentDetail";

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
    // The row links to where the account is chosen; Configure has the same href, so match the label.
    expect(markup).toMatch(/<a href="\/agents\/claudecoder\/runtime"[^>]*aria-label="Change the Claude account"[^>]*>Change<\/a>/);
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
