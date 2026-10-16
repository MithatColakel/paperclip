import { useEffect, useState, type ReactNode } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Plus, UserRoundCog } from "lucide-react";
import { DEVICE_POOL_ACCOUNT_LIMIT } from "@paperclipai/shared";
import { aiAccountPoolApi, aiAccountPoolKeys } from "@/api/ai-account-pool";
import { AddPoolAccountDialog } from "@/components/ai-account-pool/AddPoolAccountDialog";
import { BindingsTable } from "@/components/ai-account-pool/BindingsTable";
import { CompanyAccountsPanel } from "@/components/ai-account-pool/CompanyAccountsPanel";
import { MyAccountsPanel } from "@/components/ai-account-pool/MyAccountsPanel";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { POOL_PRODUCT_LINE, aiAccountPoolErrorMessage } from "@/lib/ai-account-pool";

/**
 * Limits lift and owners change accounts on their own; keep the company lists
 * current. "My Claude accounts" is not polled: it sums Paperclip usage over
 * 5 hours, 7 days and the month. It refreshes on focus and after every change.
 */
const REFRESH_MS = 60_000;

/** Loading, error and empty states for one section; the data renders through `children`. */
function PoolSection<T>({
  title,
  description,
  actions,
  query,
  isEmpty,
  empty,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-semibold">{title}</h2>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {actions}
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
  const [addOpen, setAddOpen] = useState(false);
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
    refetchInterval: REFRESH_MS,
  });
  const bindings = useQuery({
    queryKey: aiAccountPoolKeys.bindings(companyId),
    queryFn: () => aiAccountPoolApi.listBindings(companyId),
    enabled: Boolean(selectedCompanyId),
    retry: false,
    refetchInterval: REFRESH_MS,
  });
  const companyName = selectedCompany?.name ?? "this company";

  return (
    <div className="max-w-5xl space-y-6">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <UserRoundCog className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          <h1 className="text-lg font-semibold">Claude accounts</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          A Claude account belongs to the person who adds it. It runs agents only in companies where its owner is a
          member, and each device runs at most {DEVICE_POOL_ACCOUNT_LIMIT} Claude accounts.
        </p>
      </div>

      <PoolSection
        title="My Claude accounts"
        description={POOL_PRODUCT_LINE}
        actions={(
          <Button type="button" size="sm" variant="outline" onClick={() => setAddOpen(true)}>
            <Plus />
            Add account
          </Button>
        )}
        query={mine}
        isEmpty={(data) => data.accounts.length === 0}
        empty="You have not added a Claude account yet."
      >
        {(data) => <MyAccountsPanel accounts={data.accounts} />}
      </PoolSection>

      <PoolSection
        title={`Available in ${companyName}`}
        description="Accounts whose owners are members of this company."
        query={available}
        isEmpty={(data) => data.accounts.length === 0}
        empty="No Claude account is available in this company yet."
      >
        {(data) => <CompanyAccountsPanel accounts={data.accounts} />}
      </PoolSection>

      <PoolSection
        title="Agent assignments"
        description="The Claude account each Claude agent uses. A change applies from the agent's next run; a run in progress keeps its account."
        query={bindings}
        isEmpty={(data) => data.bindings.length === 0}
        empty="This company has no Claude agents yet."
      >
        {(data) => <BindingsTable companyId={companyId} bindings={data.bindings} accounts={available.data} />}
      </PoolSection>

      <AddPoolAccountDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}
