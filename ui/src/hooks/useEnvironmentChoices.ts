import { useQuery } from "@tanstack/react-query";
import type { Environment } from "@paperclipai/shared";
import { environmentsApi } from "../api/environments";
import { instanceSettingsApi } from "../api/instanceSettings";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";

/**
 * What an environment picker needs: the company's environments (shared ones
 * plus its own) and the company and instance defaults its inherit option
 * resolves through. `ready` stays false until all of it loaded; a failed load
 * leaves the picker hidden rather than blocking the form.
 */
export function useEnvironmentChoices(companyId: string, options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true;
  const { companies } = useCompany();
  const environments = useQuery({
    queryKey: queryKeys.environments.list(companyId),
    queryFn: () => environmentsApi.list(companyId),
    enabled,
  });
  const settings = useQuery({
    queryKey: queryKeys.instance.settings,
    queryFn: () => instanceSettingsApi.get(),
    enabled,
  });
  const company = companies?.find((entry) => entry.id === companyId) ?? null;
  return {
    environments: (environments.data ?? []) as Environment[],
    companyDefaultEnvironmentId: company?.defaultEnvironmentId ?? null,
    instanceDefaultEnvironmentId: settings.data?.defaultEnvironmentId ?? null,
    ready: environments.isSuccess && settings.isSuccess,
  };
}
