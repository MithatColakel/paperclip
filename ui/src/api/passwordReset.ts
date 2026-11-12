// Fork: owner-issued password reset links.
import type {
  PasswordResetAccessResponse,
  PasswordResetCompleted,
  PasswordResetLinkCreated,
  PasswordResetLinkSummary,
} from "@paperclipai/shared";
import { api } from "./client";

export const passwordResetApi = {
  getAccess: (companyId: string) =>
    api.get<PasswordResetAccessResponse>(`/companies/${companyId}/password-reset-access`),

  createLink: (companyId: string, memberId: string) =>
    api.post<PasswordResetLinkCreated>(
      `/companies/${companyId}/members/${memberId}/password-reset-links`,
      {},
    ),

  getLink: (token: string) =>
    api.get<PasswordResetLinkSummary>(`/password-reset/${encodeURIComponent(token)}`),

  complete: (token: string, password: string) =>
    api.post<PasswordResetCompleted>(`/password-reset/${encodeURIComponent(token)}`, { password }),
};

export const passwordResetQueryKeys = {
  access: (companyId: string) => ["access", "password-reset-access", companyId] as const,
  link: (token: string) => ["access", "password-reset-link", token] as const,
};
