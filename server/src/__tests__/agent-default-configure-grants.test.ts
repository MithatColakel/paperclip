import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, principalPermissionGrants,
} from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET, type PermissionKey } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { authorizeInstructionCommit } from "../services/agent-instruction-authorization.js";
import { agentService } from "../services/agents.js";
import { authorizationService } from "../services/authorization.js";
import { accessService } from "../services/access.js";
import { agentJoinGrantsFromDefaults } from "../services/invite-grants.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;
// Board policy: only the coordinator gets these three by default, and only the
// coordinator gets agents:configure without a scope (others: scoped to self).
const coordinatorOnlyGrantKeys: PermissionKey[] = [
  "tools:manage_connections",
  "tasks:assign",
  "tasks:assign_scope",
];
const expectedNewAgentGrantKeys: PermissionKey[] = [
  "agents:configure",
  "agents:suggest-changes",
  "skills:create",
  "skills:suggest-changes",
  "tools:manage_profiles",
  "tools:view_audit",
  "audit:view_agent_actions",
  "tools:use",
  "tools:manage_runtime",
  "inbox:manage",
  "tasks:manage_active_checkouts",
].sort();
const expectedCoordinatorGrantKeys: PermissionKey[] = [...expectedNewAgentGrantKeys, ...coordinatorOnlyGrantKeys].sort();

describeDatabase("new agent configuration defaults", () => {
  let db!: ReturnType<typeof createDb>;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("agent-configure-defaults");
    db = createDb(started.connectionString);
    cleanup = started.cleanup;
  }, 20_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("grants only the coordinator assignment and peer configuration, and keeps restricted agents narrow", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Agent permission defaults",
      issuePrefix: `PD${companyId.slice(0, 6).toUpperCase()}`,
    });
    const create = (
      name: string,
      permissions: Record<string, unknown> = {},
      metadata?: Record<string, unknown>,
      role = "engineer",
      coordinator = false,
    ) =>
      agentService(db).create(companyId, {
        name,
        role,
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions,
        metadata,
      }, metadata || coordinator ? {
        ...(metadata ? { allowBuiltInAgentMetadata: true } : {}),
        ...(coordinator ? { coordinator: true } : {}),
      } : undefined);

    const standard = await create("Standard");
    const peer = await create("Peer");
    const projectManager = await create("Project Manager", {}, undefined, "pm");
    const chiefOfStaff = await create("Chief of staff", {}, undefined, "general", true);
    const lowTrust = await create("Low trust", { trustPreset: LOW_TRUST_REVIEW_PRESET });
    const lowTrustCoordinator = await create("Low trust PM", { trustPreset: LOW_TRUST_REVIEW_PRESET }, undefined, "pm");
    const bundled = await create("Bundled", {}, {
      paperclipBuiltInAgent: { key: "reflection-coach", featureKeys: [] },
    });

    const grants = await db.select().from(principalPermissionGrants)
      .where(eq(principalPermissionGrants.companyId, companyId));
    for (const agent of [standard, peer]) {
      expect(grants.filter((grant) => grant.principalId === agent.id)
        .map((grant) => grant.permissionKey).sort()).toEqual(expectedNewAgentGrantKeys);
      expect(grants.find((grant) => grant.principalId === agent.id && grant.permissionKey === "agents:configure")?.scope)
        .toEqual({ agentIds: [agent.id] });
      expect(grants.find((grant) => grant.principalId === agent.id && grant.permissionKey === "inbox:manage")?.scope)
        .toEqual({ responsibleUserOnly: true });
    }
    for (const agent of [projectManager, chiefOfStaff]) {
      expect(grants.filter((grant) => grant.principalId === agent.id)
        .map((grant) => grant.permissionKey).sort()).toEqual(expectedCoordinatorGrantKeys);
      expect(grants.find((grant) => grant.principalId === agent.id && grant.permissionKey === "agents:configure")?.scope)
        .toBeNull();
      expect(grants.find((grant) => grant.principalId === agent.id && grant.permissionKey === "tasks:assign_scope")?.scope)
        .toEqual({ subtreeRootAgentId: agent.id });
      expect(grants.find((grant) => grant.principalId === agent.id && grant.permissionKey === "inbox:manage")?.scope)
        .toEqual({ responsibleUserOnly: true });
    }
    for (const agent of [lowTrust, lowTrustCoordinator, bundled]) {
      expect(grants.filter((grant) => grant.principalId === agent.id)).toEqual([]);
    }

    await db.insert(companyMemberships).values([standard, projectManager].map((agent) => ({
      companyId,
      principalType: "agent" as const,
      principalId: agent.id,
      status: "active" as const,
      membershipRole: "member" as const,
    })));

    for (const permissionKey of expectedCoordinatorGrantKeys) {
      if (permissionKey === "tasks:assign_scope" || permissionKey === "inbox:manage") continue; // These grants require a target scope or the responsible-user inbox path.
      expect(await accessService(db).hasPermission(companyId, "agent", projectManager.id, permissionKey)).toBe(true);
      // An unscoped check misses the worker's self-scoped agents:configure grant.
      expect(await accessService(db).hasPermission(companyId, "agent", standard.id, permissionKey))
        .toBe(!coordinatorOnlyGrantKeys.includes(permissionKey) && permissionKey !== "agents:configure");
    }
    expect(await authorizationService(db).decidePrincipalGrant({
      companyId,
      principalType: "agent",
      principalId: projectManager.id,
      action: "tasks:assign",
      permissionKey: "tasks:assign_scope",
      scope: { assigneeAgentId: projectManager.id },
    })).toMatchObject({ allowed: true });
    expect(await authorizationService(db).decidePrincipalGrant({
      companyId,
      principalType: "agent",
      principalId: projectManager.id,
      action: "tasks:assign",
      permissionKey: "tasks:assign_scope",
      scope: { assigneeAgentId: peer.id },
    })).toMatchObject({ allowed: false, reason: "deny_scope" });
    expect(await authorizationService(db).decidePrincipalGrant({
      companyId,
      principalType: "agent",
      principalId: standard.id,
      action: "tasks:assign",
      permissionKey: "tasks:assign_scope",
      scope: { assigneeAgentId: standard.id },
    })).toMatchObject({ allowed: false });
    for (const permissionKey of [
      "agents:create", "environments:manage", "tools:admin", "users:invite",
      "users:manage_permissions", "pipelines:write", "joins:approve",
    ] as const) {
      expect(await accessService(db).hasPermission(companyId, "agent", standard.id, permissionKey)).toBe(false);
      expect(await accessService(db).hasPermission(companyId, "agent", projectManager.id, permissionKey)).toBe(false);
    }

    const decideConfigure = (actorAgentId: string) => authorizationService(db).decide({
      actor: { type: "agent", agentId: actorAgentId, companyId, source: "agent_key" },
      action: "agent_config:update",
      resource: { type: "agent", agentId: peer.id, companyId },
      scope: { requiresChangeGrant: true },
    });
    expect(await decideConfigure(projectManager.id)).toMatchObject({ allowed: true, reason: "allow_direct_change" });
    expect(await decideConfigure(standard.id)).toMatchObject({ allowed: false, reason: "deny_missing_consent" });

    // A worker without the grant still hands work back to the coordinator by assignment.
    expect(await authorizationService(db).decide({
      actor: { type: "agent", agentId: standard.id, companyId, source: "agent_key" },
      action: "tasks:assign",
      resource: { type: "issue", companyId, assigneeAgentId: projectManager.id },
      scope: { assigneeAgentId: projectManager.id },
    })).toMatchObject({ allowed: true, reason: "allow_visible_issue_write" });

    // A later ordinary self-update must not recreate a grant removed by an operator.
    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, standard.id));
    await agentService(db).update(standard.id, { title: "Updated own title" });
    expect(await db.select().from(principalPermissionGrants)
      .where(eq(principalPermissionGrants.principalId, standard.id))).toEqual([]);

    await agentService(db).remove(peer.id);
    expect(await db.select().from(principalPermissionGrants)
      .where(eq(principalPermissionGrants.principalId, peer.id))).toEqual([]);

    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, companyId));
    await db.delete(companyMemberships).where(eq(companyMemberships.companyId, companyId));
    await db.delete(agents).where(eq(agents.companyId, companyId));
    await db.delete(companies).where(eq(companies.id, companyId));
  });

  it("keeps existing agents and their scoped grants unchanged during ordinary updates", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Existing permission defaults",
      issuePrefix: `PE${companyId.slice(0, 6).toUpperCase()}`,
    });
    const rows = await db.insert(agents).values([
      { companyId, name: "Existing", role: "engineer", permissions: {}, adapterType: "process", adapterConfig: {}, runtimeConfig: {} },
      { companyId, name: "Scoped", role: "engineer", permissions: {}, adapterType: "process", adapterConfig: {}, runtimeConfig: {} },
      { companyId, name: "Restricted", role: "engineer", permissions: { trustPreset: LOW_TRUST_REVIEW_PRESET }, adapterType: "process", adapterConfig: {}, runtimeConfig: {} },
      { companyId, name: "Built in", role: "engineer", metadata: { paperclipBuiltInAgent: { key: "reflection-coach", featureKeys: [] } }, permissions: {}, adapterType: "process", adapterConfig: {}, runtimeConfig: {} },
      { companyId, name: "Pending", role: "engineer", status: "pending_approval", permissions: {}, adapterType: "process", adapterConfig: {}, runtimeConfig: {} },
    ]).returning();
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "agent",
      principalId: rows[1]!.id,
      permissionKey: "agents:configure",
      scope: { agentIds: [rows[0]!.id] },
    });

    for (const row of rows) {
      if (row.status === "pending_approval") {
        await expect(agentService(db).update(row.id, { title: "Updated existing agent" }))
          .rejects.toThrow("Pending approval agent configuration cannot be changed before board approval");
      } else {
        await agentService(db).update(row.id, { title: "Updated existing agent" });
      }
    }
    const grants = await db.select().from(principalPermissionGrants)
      .where(eq(principalPermissionGrants.companyId, companyId));
    expect(grants.map((grant) => grant.principalId).sort()).toEqual([rows[1]!.id]);
    expect(grants.map((grant) => grant.permissionKey)).toEqual(["agents:configure"]);
    expect(grants.find((grant) => grant.principalId === rows[1]!.id)?.scope).toEqual({ agentIds: [rows[0]!.id] });

    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, companyId));
    await db.delete(agents).where(eq(agents.companyId, companyId));
    await db.delete(companies).where(eq(companies.id, companyId));
  });

  it("adds the default grants when a pending hire is approved, the coordinator set only for a pm", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Pending permission default",
      issuePrefix: `PP${companyId.slice(0, 6).toUpperCase()}`,
    });
    const createPending = (name: string, role: string) => agentService(db).create(companyId, {
      name,
      status: "pending_approval",
      role,
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    });
    const pending = await createPending("Pending hire", "engineer");
    const pendingCoordinator = await createPending("Pending PM", "pm");
    expect(await db.select().from(principalPermissionGrants)
      .where(eq(principalPermissionGrants.companyId, companyId))).toEqual([]);

    const grantsFor = async (agentId: string) => db.select().from(principalPermissionGrants)
      .where(eq(principalPermissionGrants.principalId, agentId));
    const grantKeysFor = async (agentId: string) => (await grantsFor(agentId))
      .map((grant) => grant.permissionKey).sort();
    const configureScopeFor = async (agentId: string) => (await grantsFor(agentId))
      .find((grant) => grant.permissionKey === "agents:configure")?.scope;
    const result = await agentService(db).activatePendingApproval(pending.id);
    expect(result?.activated).toBe(true);
    expect(await grantKeysFor(pending.id)).toEqual(expectedNewAgentGrantKeys);
    expect(await configureScopeFor(pending.id)).toEqual({ agentIds: [pending.id] });
    const coordinatorResult = await agentService(db).activatePendingApproval(pendingCoordinator.id);
    expect(coordinatorResult?.activated).toBe(true);
    expect(await grantKeysFor(pendingCoordinator.id)).toEqual(expectedCoordinatorGrantKeys);
    expect(await configureScopeFor(pendingCoordinator.id)).toBeNull();

    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, companyId));
    await db.delete(agents).where(eq(agents.companyId, companyId));
    await db.delete(companies).where(eq(companies.id, companyId));
  });

  it("keeps the non-coordinator defaults when invitation approval replaces a new agent's grants", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Invited permission default",
      issuePrefix: `PI${companyId.slice(0, 6).toUpperCase()}`,
    });
    const invited = await agentService(db).create(companyId, {
      name: "Invited agent",
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    });
    await accessService(db).ensureMembership(companyId, "agent", invited.id, "member", "active");
    await accessService(db).setPrincipalGrants(
      companyId, "agent", invited.id, agentJoinGrantsFromDefaults(null, invited.id), null,
    );
    const grants = await db.select().from(principalPermissionGrants)
      .where(eq(principalPermissionGrants.principalId, invited.id));
    expect(grants.map((grant) => grant.permissionKey).sort()).toEqual(expectedNewAgentGrantKeys);
    expect(grants.find((grant) => grant.permissionKey === "agents:configure")?.scope).toEqual({ agentIds: [invited.id] });

    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, companyId));
    await db.delete(companyMemberships).where(eq(companyMemberships.companyId, companyId));
    await db.delete(agents).where(eq(agents.companyId, companyId));
    await db.delete(companies).where(eq(companies.id, companyId));
  });

  it("lets a new non-coordinator save its own instructions without consent, but not a peer's", async () => {
    const companyId = randomUUID();
    const userId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Own instruction edits",
      issuePrefix: `PO${companyId.slice(0, 6).toUpperCase()}`,
    });
    await db.insert(authUsers).values({
      id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date(),
    });
    const create = (name: string) => agentService(db).create(companyId, {
      name,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    });
    const worker = await create("Worker");
    const peer = await create("Peer");
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user" as const, principalId: userId, membershipRole: "owner" as const, status: "active" as const },
      ...[worker, peer].map((agent) => ({
        companyId,
        principalType: "agent" as const,
        principalId: agent.id,
        membershipRole: "member" as const,
        status: "active" as const,
      })),
    ]);
    // The responsible user may edit every agent, so the agent's own grants decide.
    await db.insert(principalPermissionGrants).values({
      companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure", scope: null,
    });
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId: worker.id, status: "running", responsibleUserId: userId, invocationSource: "automation",
    }).returning();
    const actor = { type: "agent" as const, source: "agent_jwt" as const, companyId, agentId: worker.id, runId: run!.id };

    // The agent-directory working copy saves AGENTS.md through this check, as the agent.
    await expect(authorizeInstructionCommit(db, actor, { companyId, id: worker.id }))
      .resolves.toMatchObject({ type: "agent", agentId: worker.id, onBehalfOfUserId: userId });
    await expect(authorizeInstructionCommit(db, actor, { companyId, id: peer.id }))
      .rejects.toMatchObject({ status: 403 });
    expect(await authorizationService(db).decide({
      actor: { type: "agent", agentId: worker.id, companyId, source: "agent_key" },
      action: "agent_config:update",
      resource: { type: "agent", agentId: peer.id, companyId },
      scope: { requiresChangeGrant: true },
    })).toMatchObject({ allowed: false, reason: "deny_missing_consent" });

    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, companyId));
    await db.delete(companyMemberships).where(eq(companyMemberships.companyId, companyId));
    await db.delete(agents).where(eq(agents.companyId, companyId));
    await db.delete(authUsers).where(eq(authUsers.id, userId));
    await db.delete(companies).where(eq(companies.id, companyId));
  });
});
