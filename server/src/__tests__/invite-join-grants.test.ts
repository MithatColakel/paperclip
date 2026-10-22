import { describe, expect, it } from "vitest";
import {
  agentJoinGrantsFromDefaults,
  humanJoinGrantsFromDefaults,
} from "../services/invite-grants.js";
import {
  grantsForHumanRole,
  normalizeHumanRole,
  resolveHumanInviteRole,
} from "../services/company-member-roles.js";
import {
  COORDINATOR_ONLY_DEFAULT_GRANT_KEYS,
  newStandardAgentDefaultGrantKeys,
  newStandardAgentGrantScope,
} from "../lib/agent-permissions.js";

const invitedAgentId = "agent-1";
const defaultAgentGrants = newStandardAgentDefaultGrantKeys(false).map((permissionKey) => ({
  permissionKey,
  scope: newStandardAgentGrantScope(permissionKey, invitedAgentId, false),
}));

describe("agentJoinGrantsFromDefaults", () => {
  it("adds the non-coordinator new-agent grants when invite defaults do not specify grants", () => {
    const grants = agentJoinGrantsFromDefaults(null, invitedAgentId);
    expect(grants).toEqual(defaultAgentGrants);
    expect(grants).toHaveLength(11);
    for (const permissionKey of COORDINATOR_ONLY_DEFAULT_GRANT_KEYS) {
      expect(grants.map((grant) => grant.permissionKey)).not.toContain(permissionKey);
    }
    // Board policy: a non-coordinator configures only itself directly.
    expect(grants.find((grant) => grant.permissionKey === "agents:configure")?.scope)
      .toEqual({ agentIds: [invitedAgentId] });
  });

  it("preserves invite agent grants and appends the missing defaults", () => {
    expect(
      agentJoinGrantsFromDefaults({
        agent: {
          grants: [
            {
              permissionKey: "agents:create",
              scope: null,
            },
          ],
        },
      }, invitedAgentId),
    ).toEqual([{ permissionKey: "agents:create", scope: null }, ...defaultAgentGrants]);
  });

  it("does not duplicate tasks:assign when invite defaults already include it", () => {
    expect(
      agentJoinGrantsFromDefaults({
        agent: {
          grants: [
            {
              permissionKey: "tasks:assign",
              scope: { projectId: "project-1" },
            },
          ],
        },
      }, invitedAgentId),
    ).toEqual([
      { permissionKey: "tasks:assign", scope: { projectId: "project-1" } },
      ...defaultAgentGrants.filter((grant) => grant.permissionKey !== "tasks:assign"),
    ]);
  });

  it("preserves an explicit scoped agent configuration grant", () => {
    expect(agentJoinGrantsFromDefaults({
      agent: { grants: [{ permissionKey: "agents:configure", scope: { agentIds: ["agent-2"] } }] },
    }, invitedAgentId)).toEqual([
      { permissionKey: "agents:configure", scope: { agentIds: ["agent-2"] } },
      ...defaultAgentGrants.filter((grant) => grant.permissionKey !== "agents:configure"),
    ]);
  });
});

describe("human invite roles", () => {
  it("maps owner to the full management grant set", () => {
    expect(grantsForHumanRole("owner")).toEqual([
      { permissionKey: "agents:create", scope: null },
      { permissionKey: "agents:configure", scope: null },
      { permissionKey: "skills:create", scope: null },
      { permissionKey: "environments:manage", scope: null },
      { permissionKey: "users:invite", scope: null },
      { permissionKey: "users:manage_permissions", scope: null },
      { permissionKey: "tasks:assign", scope: null },
      { permissionKey: "joins:approve", scope: null },
      { permissionKey: "tools:manage_connections", scope: null },
      { permissionKey: "tools:manage_runtime", scope: null },
      { permissionKey: "tools:use", scope: null },
      { permissionKey: "tools:admin", scope: null },
      { permissionKey: "commentary:view", scope: null },
    ]);
  });

  it("maps admin to management grants including environment management", () => {
    expect(grantsForHumanRole("admin")).toEqual([
      { permissionKey: "agents:create", scope: null },
      { permissionKey: "agents:configure", scope: null },
      { permissionKey: "skills:create", scope: null },
      { permissionKey: "environments:manage", scope: null },
      { permissionKey: "users:invite", scope: null },
      { permissionKey: "tasks:assign", scope: null },
      { permissionKey: "joins:approve", scope: null },
      { permissionKey: "tools:manage_connections", scope: null },
      { permissionKey: "tools:manage_runtime", scope: null },
      { permissionKey: "tools:use", scope: null },
      { permissionKey: "tools:admin", scope: null },
      { permissionKey: "commentary:view", scope: null },
    ]);
  });

  it("maps operator to company editing grants without join approval or member permissions", () => {
    expect(grantsForHumanRole("operator")).toEqual([
      { permissionKey: "agents:create", scope: null },
      { permissionKey: "agents:configure", scope: null },
      { permissionKey: "skills:create", scope: null },
      { permissionKey: "environments:manage", scope: null },
      { permissionKey: "users:invite", scope: null },
      { permissionKey: "tasks:assign", scope: null },
      { permissionKey: "tools:manage_connections", scope: null },
      { permissionKey: "tools:manage_profiles", scope: null },
      { permissionKey: "tools:manage_runtime", scope: null },
      { permissionKey: "tools:use", scope: null },
      { permissionKey: "tools:admin", scope: null },
      { permissionKey: "tools:view_audit", scope: null },
      { permissionKey: "audit:view_agent_actions", scope: null },
      { permissionKey: "commentary:view", scope: null },
    ]);
  });

  it("lets viewers read commentary without granting agent audit access", () => {
    expect(grantsForHumanRole("viewer")).toEqual([
      { permissionKey: "commentary:view", scope: null },
    ]);
    expect(humanJoinGrantsFromDefaults(null, "viewer")).toEqual(grantsForHumanRole("viewer"));
  });

  it("defaults legacy or missing roles to operator", () => {
    expect(normalizeHumanRole("member")).toBe("operator");
    expect(resolveHumanInviteRole(null)).toBe("operator");
  });

  it("reads the configured human invite role from defaults", () => {
    expect(
      resolveHumanInviteRole({
        human: {
          role: "viewer",
        },
      }),
    ).toBe("viewer");
  });

  it("falls back to role grants when human invite defaults omit explicit grants", () => {
    expect(humanJoinGrantsFromDefaults(null, "operator")).toEqual(grantsForHumanRole("operator"));
  });

  it.each(["owner", "admin", "operator", "viewer"] as const)("adds commentary access to saved pre-upgrade %s invite grants", (role) => {
    const legacyGrants = grantsForHumanRole(role).filter((grant) => grant.permissionKey !== "commentary:view");
    expect(humanJoinGrantsFromDefaults({ human: { role, grants: legacyGrants } }, role)).toEqual(grantsForHumanRole(role));
  });

  it("preserves an explicitly scoped commentary grant", () => {
    const grants = [{ permissionKey: "commentary:view", scope: { agentIds: ["agent-1"] } }];
    expect(humanJoinGrantsFromDefaults({ human: { grants } }, "operator")).toEqual(grants);
  });

  it("preserves explicit human invite scopes and adds the commentary default", () => {
    expect(
      humanJoinGrantsFromDefaults(
        {
          human: {
            grants: [
              {
                permissionKey: "users:invite",
                scope: { companyId: "company-1" },
              },
            ],
          },
        },
        "operator",
      ),
    ).toEqual([
      {
        permissionKey: "users:invite",
        scope: { companyId: "company-1" },
      },
      { permissionKey: "commentary:view", scope: null },
    ]);
  });
});
