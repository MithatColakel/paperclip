import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, projects } from "@paperclipai/db";
import {
  isEnvironmentAvailableToCompany,
  isEnvironmentRunnableForAdapter,
  type Environment,
} from "@paperclipai/shared";

export type InheritedEnvironmentDefaults = {
  projectDefaultEnvironmentId: string | null;
  companyDefaultEnvironmentId: string | null;
};

/**
 * Project and company defaults are inherited hints, not pins. A default this
 * agent cannot use (archived, owned by another company, a driver its adapter
 * does not support) is dropped, so resolution falls through to the next tier
 * instead of failing the run. An agent's own pin is never filtered here.
 */
export function isInheritableEnvironment(
  environment: Environment | null,
  input: { companyId: string; adapterType: string },
): environment is Environment {
  return (
    environment !== null &&
    isEnvironmentAvailableToCompany(environment, input.companyId) &&
    isEnvironmentRunnableForAdapter(environment, input.adapterType)
  );
}

export async function resolveInheritedEnvironmentDefaults(
  db: Db,
  environmentsSvc: { getById(id: string): Promise<Environment | null> },
  input: {
    companyId: string;
    adapterType: string;
    projectId?: string | null;
    /** Pass when the caller already loaded the project's default. */
    projectDefaultEnvironmentId?: string | null;
  },
): Promise<InheritedEnvironmentDefaults> {
  const projectDefaultEnvironmentId =
    input.projectDefaultEnvironmentId !== undefined
      ? input.projectDefaultEnvironmentId
      : input.projectId
        ? await db
            .select({ defaultEnvironmentId: projects.defaultEnvironmentId })
            .from(projects)
            .where(and(eq(projects.id, input.projectId), eq(projects.companyId, input.companyId)))
            .then((rows) => rows[0]?.defaultEnvironmentId ?? null)
        : null;
  const companyDefaultEnvironmentId = await db
    .select({ defaultEnvironmentId: companies.defaultEnvironmentId })
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .then((rows) => rows[0]?.defaultEnvironmentId ?? null);

  const usable = async (environmentId: string | null) => {
    if (!environmentId) return null;
    const environment = await environmentsSvc.getById(environmentId);
    return isInheritableEnvironment(environment, input) ? environment.id : null;
  };
  return {
    projectDefaultEnvironmentId: await usable(projectDefaultEnvironmentId),
    companyDefaultEnvironmentId: await usable(companyDefaultEnvironmentId),
  };
}
