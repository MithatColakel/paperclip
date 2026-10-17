import type {
  AiAccountHostEnvironmentSummary,
  AiAccountHostKind,
  AiAccountHostsResponse,
  CreateAiAccountHost,
  UpdateAiAccountHost,
} from "@paperclipai/shared";
import { api } from "./client";

/** A host row as the create/update routes return it (no accounts or environments attached). */
export interface AiAccountHostRecord {
  id: string;
  name: string;
  /** The update routes also return plugin (`external`) devices. */
  kind: AiAccountHostKind;
  maxAccounts: number;
  overflowToOtherAccounts: boolean;
  createdAt: string;
  updatedAt?: string;
}

/**
 * The legacy host routes, kept for device administration: instance admins
 * only. Accounts are managed through the account pool routes
 * (`aiAccountPoolApi`); the old per-host account routes are gone.
 */
export const aiAccountHostsApi = {
  list: () => api.get<AiAccountHostsResponse>("/instance/ai-hosts"),
  createHost: (input: CreateAiAccountHost) => api.post<AiAccountHostRecord>("/instance/ai-hosts", input),
  updateHost: (hostId: string, input: UpdateAiAccountHost) =>
    api.patch<AiAccountHostRecord>(`/instance/ai-hosts/${encodeURIComponent(hostId)}`, input),
  deleteHost: (hostId: string) => api.delete<{ ok: true }>(`/instance/ai-hosts/${encodeURIComponent(hostId)}`),
  /**
   * Replaces the device's environment mappings; an environment listed here moves off any other device.
   * A 409 says the edit would put more Claude accounts on a device than its limit.
   */
  setEnvironments: (hostId: string, environmentIds: string[]) =>
    api.put<{ host: AiAccountHostRecord; environments: AiAccountHostEnvironmentSummary[] }>(
      `/instance/ai-hosts/${encodeURIComponent(hostId)}/environments`,
      { environmentIds },
    ),
};
