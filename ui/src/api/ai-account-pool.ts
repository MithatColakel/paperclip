import type { QueryClient } from "@tanstack/react-query";
import type {
  AgentAiAccountBindingDetail,
  AgentAiAccountBindingSummary,
  AiAccountMigrationReport,
  CompanyAiAccountBindingsResponse,
  CompanyAiAccountsResponse,
  CreateMyAiAccount,
  InstanceAiAccountSummary,
  InstanceAiAccountsResponse,
  MyAiAccount,
  MyAiAccountsResponse,
  ReplaceAiAccountCredential,
  SetAgentAiAccount,
  SetAgentAiAccountResponse,
  UpdateInstanceAiAccount,
  UpdateMyAiAccount,
} from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";
import { api } from "./client";
import { executionDeviceKeys } from "./execution-devices";

/**
 * Fork: query keys for the Claude account pool. They live here so the upstream
 * `queryKeys.ts` stays untouched; every key starts with `aiAccountPoolKeys.all`.
 */
export const aiAccountPoolKeys = {
  all: ["ai-account-pool"] as const,
  mine: ["ai-account-pool", "me"] as const,
  company: (companyId: string) => ["ai-account-pool", "company", companyId] as const,
  companyAccounts: (companyId: string, agentId?: string | null) =>
    ["ai-account-pool", "company", companyId, "accounts", agentId ?? null] as const,
  bindings: (companyId: string) => ["ai-account-pool", "company", companyId, "bindings"] as const,
  agent: (agentId: string) => ["ai-account-pool", "agent", agentId] as const,
  instanceAccounts: ["ai-account-pool", "instance", "accounts"] as const,
  migration: ["ai-account-pool", "instance", "migration"] as const,
};

const segment = encodeURIComponent;

function withRelease(path: string, release: boolean | undefined): string {
  return release ? `${path}?release=true` : path;
}

function updateInstanceAccount(accountId: string, input: UpdateInstanceAiAccount) {
  return api.patch<InstanceAiAccountSummary>(`/instance/ai-accounts/${segment(accountId)}`, input);
}

/**
 * Fork: the user-owned Claude account pool. Responses carry summaries only,
 * never a credential value.
 */
export const aiAccountPoolApi = {
  // --- My accounts (board users; the owner acts) -------------------------
  listMine: () => api.get<MyAiAccountsResponse>("/me/ai-accounts"),
  /** A pasted value, the caller's own saved Claude connection, or (instance admins) the server's environment token. */
  create: (input: CreateMyAiAccount) => api.post<MyAiAccount>("/me/ai-accounts", input),
  /** Label, plan, e-mail hint; `status` withdraws or resumes; `clearProjectRestriction` lifts a reservation. */
  update: (accountId: string, input: UpdateMyAiAccount) =>
    api.patch<MyAiAccount>(`/me/ai-accounts/${segment(accountId)}`, input),
  replaceCredential: (accountId: string, input: ReplaceAiAccountCredential) =>
    api.put<MyAiAccount>(`/me/ai-accounts/${segment(accountId)}/credential`, input),
  clearLimit: (accountId: string) =>
    api.post<MyAiAccount>(`/me/ai-accounts/${segment(accountId)}/clear-limit`, {}),
  /** 409 `ai_account_in_use` while agents use the account, unless `release` frees them (they then wait). */
  remove: (accountId: string, options: { release?: boolean } = {}) =>
    api.delete<void>(withRelease(`/me/ai-accounts/${segment(accountId)}`, options.release)),

  // --- Company accounts and agent bindings -------------------------------
  /** Accounts eligible in the company, with `canBind` per caller; with `agentId`, selectability for that agent. */
  listCompanyAccounts: (companyId: string, options: { agentId?: string | null } = {}) =>
    api.get<CompanyAiAccountsResponse>(
      options.agentId
        ? `/companies/${segment(companyId)}/ai-accounts?agentId=${segment(options.agentId)}`
        : `/companies/${segment(companyId)}/ai-accounts`,
    ),
  listBindings: (companyId: string) =>
    api.get<CompanyAiAccountBindingsResponse>(`/companies/${segment(companyId)}/ai-account-bindings`),
  getAgentBinding: (agentId: string) =>
    api.get<AgentAiAccountBindingDetail>(`/agents/${segment(agentId)}/ai-account`),
  /** Applies from the agent's next run; a running run keeps its account. */
  setAgentBinding: (agentId: string, input: SetAgentAiAccount) =>
    api.put<SetAgentAiAccountResponse>(`/agents/${segment(agentId)}/ai-account`, input),
  /** Back to the agent's AI connection or the device's own login. */
  clearAgentBinding: (agentId: string) => api.delete<void>(`/agents/${segment(agentId)}/ai-account`),
  /** Company admins confirm a migrated binding. */
  reviewAgentBinding: (agentId: string) =>
    api.post<AgentAiAccountBindingSummary>(`/agents/${segment(agentId)}/ai-account/review`, {}),

  // --- Instance admin ----------------------------------------------------
  listInstanceAccounts: () => api.get<InstanceAiAccountsResponse>("/instance/ai-accounts"),
  updateInstanceAccount,
  /** An admin disable is separate from the owner's own pause, so an admin never resumes what an owner withdrew. */
  setAdminDisabled: (accountId: string, adminDisabled: boolean, reason?: string | null) =>
    updateInstanceAccount(accountId, {
      adminDisabled,
      ...(reason !== undefined ? { reason } : {}),
    }),
  /** Owner transfer to an existing user: 422 for an unknown user, 409 when the new owner already has that e-mail hint. */
  transferOwner: (accountId: string, ownerUserId: string) => updateInstanceAccount(accountId, { ownerUserId }),
  clearInstanceLimit: (accountId: string) =>
    api.post<InstanceAiAccountSummary>(`/instance/ai-accounts/${segment(accountId)}/clear-limit`, {}),
  removeInstanceAccount: (accountId: string, options: { release?: boolean } = {}) =>
    api.delete<void>(withRelease(`/instance/ai-accounts/${segment(accountId)}`, options.release)),
  /** The binding backfill report: bound, unassigned and unbound agents, over-limit devices and the go/no-go preview. */
  getMigrationReport: () => api.get<AiAccountMigrationReport>("/instance/ai-accounts/migration"),
  /** Idempotent re-run of the backfill job. */
  runMigration: () => api.post<AiAccountMigrationReport>("/instance/ai-accounts/migration/run", {}),
};

/**
 * Refresh everything an account, binding or device change can touch: my
 * accounts, company accounts, bindings, agents' Claude account fields,
 * devices and the legacy host list.
 */
export function invalidateAiAccountPoolQueries(queryClient: QueryClient): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: aiAccountPoolKeys.all }),
    queryClient.invalidateQueries({ queryKey: executionDeviceKeys.all }),
    queryClient.invalidateQueries({ queryKey: queryKeys.instance.aiAccountHosts }),
  ]);
}
