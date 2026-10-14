import type {
  AiAccountHostEnvironmentSummary,
  AiAccountHostsResponse,
  AiAccountProjectSummary,
  AiAccountSummary,
  CreateAiAccount,
  CreateAiAccountHost,
  UpdateAiAccount,
  UpdateAiAccountHost,
} from "@paperclipai/shared";
import { api } from "./client";

/** A host row as the create/update routes return it (no accounts or environments attached). */
export interface AiAccountHostRecord {
  id: string;
  name: string;
  kind: CreateAiAccountHost["kind"];
  maxAccounts: number;
  overflowToOtherAccounts: boolean;
  createdAt: string;
  updatedAt?: string;
}

/** Instance-level Claude accounts per execution host. Every route is for instance admins only. */
export const aiAccountHostsApi = {
  list: () => api.get<AiAccountHostsResponse>("/instance/ai-hosts"),
  createHost: (input: CreateAiAccountHost) => api.post<AiAccountHostRecord>("/instance/ai-hosts", input),
  updateHost: (hostId: string, input: UpdateAiAccountHost) =>
    api.patch<AiAccountHostRecord>(`/instance/ai-hosts/${encodeURIComponent(hostId)}`, input),
  deleteHost: (hostId: string) => api.delete<{ ok: true }>(`/instance/ai-hosts/${encodeURIComponent(hostId)}`),
  /** Replaces the host's environment list; an environment listed here moves off any other host. */
  setEnvironments: (hostId: string, environmentIds: string[]) =>
    api.put<{ host: AiAccountHostRecord; environments: AiAccountHostEnvironmentSummary[] }>(
      `/instance/ai-hosts/${encodeURIComponent(hostId)}/environments`,
      { environmentIds },
    ),
  addAccount: (hostId: string, input: CreateAiAccount) =>
    api.post<AiAccountSummary>(`/instance/ai-hosts/${encodeURIComponent(hostId)}/accounts`, input),
  updateAccount: (accountId: string, input: UpdateAiAccount) =>
    api.patch<AiAccountSummary>(`/instance/ai-accounts/${encodeURIComponent(accountId)}`, input),
  clearLimit: (accountId: string) =>
    api.post<AiAccountSummary>(`/instance/ai-accounts/${encodeURIComponent(accountId)}/clear-limit`, {}),
  /** Reserves the account for these projects; an empty list makes it shared by every run on the host again. */
  setAccountProjects: (accountId: string, projectIds: string[]) =>
    api.put<{ accountId: string; projects: AiAccountProjectSummary[] }>(
      `/instance/ai-accounts/${encodeURIComponent(accountId)}/projects`,
      { projectIds },
    ),
  deleteAccount: (accountId: string) =>
    api.delete<{ ok: true }>(`/instance/ai-accounts/${encodeURIComponent(accountId)}`),
};
