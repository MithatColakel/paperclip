import {
  isEnvironmentRunnableForAdapter,
  type Environment,
} from "@paperclipai/shared";
import { environmentDisplayLabel } from "./managed-sandbox-environment";
import { resolveLocalDefaultEnvironmentId } from "./adapter-test-environment";

export type InheritedEnvironmentSource = "project" | "company" | "instance" | "local";

/**
 * Environments a picker offers: active ones, minus the probe-only `fake`
 * sandbox. With an adapter, only the ones that adapter can run in.
 */
export function selectableEnvironments(
  environments: readonly Environment[],
  adapterType?: string | null,
): Environment[] {
  return environments.filter((environment) =>
    adapterType
      ? isEnvironmentRunnableForAdapter(environment, adapterType)
      : environment.status === "active" && environment.config?.provider !== "fake",
  );
}

/**
 * True when there is somewhere other than the local host to run. With only
 * the local environment there is nothing to choose, so forms hide the picker.
 */
export function hasRemoteEnvironmentChoice(
  environments: readonly Environment[],
  adapterType?: string | null,
): boolean {
  return selectableEnvironments(environments, adapterType).some(
    (environment) => environment.driver !== "local",
  );
}

/**
 * Where something with no environment of its own runs. Mirrors the server
 * (`resolveExecutionWorkspaceEnvironmentId` with
 * `resolveInheritedEnvironmentDefaults`): the project default, then the
 * company default, each skipped when the adapter cannot run there, then the
 * instance default, then the local host.
 */
export function resolveInheritedEnvironment(input: {
  environments: readonly Environment[];
  projectDefaultEnvironmentId?: string | null;
  companyDefaultEnvironmentId?: string | null;
  instanceDefaultEnvironmentId?: string | null;
  adapterType?: string | null;
}): { environment: Environment | null; source: InheritedEnvironmentSource } {
  const byId = (id: string | null | undefined) =>
    id ? (input.environments.find((environment) => environment.id === id) ?? null) : null;
  const inheritable = (id: string | null | undefined) => {
    const environment = byId(id);
    if (!environment) return null;
    return input.adapterType && !isEnvironmentRunnableForAdapter(environment, input.adapterType)
      ? null
      : environment;
  };
  const project = inheritable(input.projectDefaultEnvironmentId);
  if (project) return { environment: project, source: "project" };
  const company = inheritable(input.companyDefaultEnvironmentId);
  if (company) return { environment: company, source: "company" };
  const instance = byId(input.instanceDefaultEnvironmentId);
  if (instance) return { environment: instance, source: "instance" };
  return {
    environment: byId(resolveLocalDefaultEnvironmentId(input.environments)),
    source: "local",
  };
}

const SOURCE_LABELS: Record<InheritedEnvironmentSource, string> = {
  project: "Project default",
  company: "Company default",
  instance: "Instance default",
  local: "Default",
};

/** "Company default: Mac mini · sandbox" — the label of a picker's inherit option. */
export function inheritedEnvironmentLabel(resolved: {
  environment: Environment | null;
  source: InheritedEnvironmentSource;
}): string {
  const target = resolved.environment
    ? environmentDisplayLabel(resolved.environment)
    : "This Paperclip host";
  return `${SOURCE_LABELS[resolved.source]}: ${target}`;
}
