import { and, eq } from "drizzle-orm";
import { type Db, environments, issues, projects } from "@paperclipai/db";
import { resolveInheritedEnvironmentDefaults } from "../environment-defaults.js";
import { environmentService } from "../environments.js";
import { isExecutionForcedToKubernetes } from "../execution-allowlist.js";
import {
  resolveExecutionWorkspaceEnvironmentId,
  type ExecutionWorkspaceEnvironmentResolution,
} from "../execution-workspace-policy.js";
import { instanceSettingsService } from "../instance-settings.js";
import type { AgentRow } from "./types.js";

/**
 * Fork: the environment a run resolves to, with the same inputs executeRun
 * uses (agent pin, then the project's, company's and instance's inheritable
 * defaults, then the Local environment). Database reads only: nothing is
 * created, so a missing Local row resolves to null.
 *
 * Forced-Kubernetes and managed-sandbox-only instances return null; waits do
 * not model those modes (spec 7.2 skips preflight there).
 */

export type RunEnvironmentRow = typeof environments.$inferSelect;

/** Instance-level inputs, read once per hold pass. */
export interface RunEnvironmentPolicy {
  instanceDefaultEnvironmentId: string | null;
  /** Kubernetes-forced or managed-sandbox-only. */
  unmodelled: boolean;
}

export interface RunEnvironmentInput {
  companyId: string;
  agent: Pick<AgentRow, "id" | "companyId" | "adapterType" | "defaultEnvironmentId">;
  issueId?: string | null;
  /** `contextSnapshot.projectId`, used when the run has no issue project. */
  projectId?: string | null;
}

export interface ResolvedRunEnvironment {
  environment: RunEnvironmentRow;
  source: ExecutionWorkspaceEnvironmentResolution["source"];
  projectId: string | null;
}

export async function readRunEnvironmentPolicy(db: Db): Promise<RunEnvironmentPolicy> {
  const settings = instanceSettingsService(db);
  const [resolved, experimental] = await Promise.all([settings.get(), settings.getExperimental()]);
  const managedSandboxOnly = experimental.enableManagedSandboxOnly === true;
  const forced = isExecutionForcedToKubernetes({
    executionMode: resolved.general.executionMode,
    managedSandboxOnly,
  });
  return {
    instanceDefaultEnvironmentId: resolved.defaultEnvironmentId ?? null,
    unmodelled: forced || managedSandboxOnly,
  };
}

export async function resolveRunEnvironment(
  db: Db,
  input: RunEnvironmentInput,
  policy?: RunEnvironmentPolicy,
): Promise<ResolvedRunEnvironment | null> {
  const resolvedPolicy = policy ?? await readRunEnvironmentPolicy(db);
  if (resolvedPolicy.unmodelled) return null;

  const issueProjectId = input.issueId
    ? await db
      .select({ projectId: issues.projectId })
      .from(issues)
      .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
      .then((rows) => rows[0]?.projectId ?? null)
    : null;
  const projectId = issueProjectId ?? input.projectId ?? null;
  const projectDefaultEnvironmentId = projectId
    ? await db
      .select({ defaultEnvironmentId: projects.defaultEnvironmentId })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, input.companyId)))
      .then((rows) => rows[0]?.defaultEnvironmentId ?? null)
    : null;
  const inherited = input.agent.defaultEnvironmentId
    ? { projectDefaultEnvironmentId: null, companyDefaultEnvironmentId: null }
    : await resolveInheritedEnvironmentDefaults(db, environmentService(db), {
      companyId: input.companyId,
      adapterType: input.agent.adapterType,
      projectDefaultEnvironmentId,
    });
  const [local] = await db.select({ id: environments.id }).from(environments).where(eq(environments.driver, "local")).limit(1);
  const resolution = resolveExecutionWorkspaceEnvironmentId({
    agentDefaultEnvironmentId: input.agent.defaultEnvironmentId,
    ...inherited,
    instanceDefaultEnvironmentId: resolvedPolicy.instanceDefaultEnvironmentId,
    localDefaultEnvironmentId: local?.id ?? "",
  });
  if (!resolution.environmentId) return null;
  const [environment] = await db.select().from(environments).where(eq(environments.id, resolution.environmentId));
  return environment ? { environment, source: resolution.source, projectId } : null;
}
