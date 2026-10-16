import { useEffect, type ReactNode } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { UserRoundCog } from "lucide-react";
import { DEVICE_POOL_ACCOUNT_LIMIT } from "@paperclipai/shared";
import { aiAccountPoolApi, aiAccountPoolKeys } from "@/api/ai-account-pool";
import { AiAccountStateBadge } from "@/components/ai-account-pool/AccountSelect";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import {
  AI_ACCOUNT_BINDING_STATE_TEXT,
  POOL_CREDENTIAL_TYPE_LABELS,
  POOL_PRODUCT_LINE,
  aiAccountPoolErrorMessage,
  aiAccountStateDisplay,
} from "@/lib/ai-account-pool";

/** Loading, error and empty states for one section; the data renders through `children`. */
function PoolSection<T>({
  title,
  description,
  query,
  isEmpty,
  empty,
  children,
}: {
  title: string;
  description?: string;
  query: UseQueryResult<T>;
  isEmpty: (data: T) => boolean;
  empty: string;
  children: (data: T) => ReactNode;
}) {
  let body: ReactNode = null;
  if (query.isLoading) {
    body = <p className="text-sm text-muted-foreground">Loading…</p>;
  } else if (query.error) {
    body = (
      <div className="space-y-2">
        <p role="alert" className="text-sm text-destructive">{aiAccountPoolErrorMessage(query.error)}</p>
        <Button variant="outline" size="sm" onClick={() => void query.refetch()}>Try again</Button>
      </div>
    );
  } else if (query.data !== undefined) {
    body = isEmpty(query.data) ? <p className="text-sm text-muted-foreground">{empty}</p> : children(query.data);
  }
  return (
    <Card className="block space-y-3 p-4" role="region" aria-label={title}>
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {body}
    </Card>
  );
}

/**
 * Fork: Company settings → Claude accounts, for every member. My accounts,
 * the accounts available in this company, and each Claude agent's account.
 */
export function ClaudeAccounts() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const companyId = selectedCompanyId ?? "";

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Claude accounts" },
    ]);
  }, [setBreadcrumbs]);

  const mine = useQuery({
    queryKey: aiAccountPoolKeys.mine,
    queryFn: () => aiAccountPoolApi.listMine(),
    retry: false,
  });
  const available = useQuery({
    queryKey: aiAccountPoolKeys.companyAccounts(companyId),
    queryFn: () => aiAccountPoolApi.listCompanyAccounts(companyId),
    enabled: Boolean(selectedCompanyId),
    retry: false,
  });
  const bindings = useQuery({
    queryKey: aiAccountPoolKeys.bindings(companyId),
    queryFn: () => aiAccountPoolApi.listBindings(companyId),
    enabled: Boolean(selectedCompanyId),
    retry: false,
  });
  const companyName = selectedCompany?.name ?? "this company";

  return (
    <div className="max-w-5xl space-y-6">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <UserRoundCog className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          <h1 className="text-lg font-semibold">Claude accounts</h1>
        </div>
        <div className="max-w-3xl space-y-2 text-sm text-muted-foreground">
          <p>
            A Claude account belongs to the person who adds it. It runs agents only in companies where its owner is a
            member, and each device runs at most {DEVICE_POOL_ACCOUNT_LIMIT} Claude accounts.
          </p>
          <p>{POOL_PRODUCT_LINE}</p>
        </div>
      </div>

      <PoolSection
        title="My Claude accounts"
        query={mine}
        isEmpty={(data) => data.accounts.length === 0}
        empty="You have not added a Claude account yet."
      >
        {(data) => (
          <ul className="divide-y divide-border">
            {data.accounts.map((account) => (
              <li key={account.id} className="flex flex-wrap items-center gap-2 py-2" aria-label={account.label}>
                <span className="text-sm font-medium">{account.label}</span>
                <span className="text-xs text-muted-foreground">{POOL_CREDENTIAL_TYPE_LABELS[account.credentialType]}</span>
                <AiAccountStateBadge display={aiAccountStateDisplay(account)} />
              </li>
            ))}
          </ul>
        )}
      </PoolSection>

      <PoolSection
        title={`Available in ${companyName}`}
        description="Accounts whose owners are members of this company."
        query={available}
        isEmpty={(data) => data.accounts.length === 0}
        empty="No Claude account is available in this company yet."
      >
        {(data) => (
          <ul className="divide-y divide-border">
            {data.accounts.map((account) => (
              <li key={account.id} className="flex flex-wrap items-center gap-2 py-2" aria-label={account.label}>
                <span className="text-sm font-medium">{account.label}</span>
                <span className="text-xs text-muted-foreground">
                  {account.ownedByMe ? "Yours" : account.owner.name ?? "Another member"}
                </span>
                <AiAccountStateBadge display={aiAccountStateDisplay(account)} />
              </li>
            ))}
          </ul>
        )}
      </PoolSection>

      <PoolSection
        title="Agent assignments"
        description="The Claude account each Claude agent uses. A change applies from the agent's next run."
        query={bindings}
        isEmpty={(data) => data.bindings.length === 0}
        empty="This company has no Claude agents yet."
      >
        {(data) => (
          <ul className="divide-y divide-border">
            {data.bindings.map((binding) => (
              <li key={binding.agentId} className="flex flex-wrap items-center gap-2 py-2" aria-label={binding.agentName}>
                <span className="text-sm font-medium">{binding.agentName}</span>
                <span className="text-xs text-muted-foreground">
                  {binding.state === "pool_account" && binding.account
                    ? binding.account.label
                    : AI_ACCOUNT_BINDING_STATE_TEXT[binding.state]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </PoolSection>
    </div>
  );
}
