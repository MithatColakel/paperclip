import { useEffect, useState, type ReactNode } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Plus, ServerCog } from "lucide-react";
import {
  AI_ACCOUNT_HOST_CREATABLE_KINDS,
  DEVICE_POOL_ACCOUNT_LIMIT,
  isResourceWaitReason,
  type AiAccountHostEnvironmentSummary,
  type AiAccountHostKind,
  type AiAccountHostSummary,
  type AiAccountMigrationAgentEntry,
  type AiAccountMigrationGoNoGoEntry,
  type AiAccountMigrationReport,
  type ExecutionDeviceDuplicateHint,
  type ExecutionDeviceEnvironmentSummary,
  type InstanceAiAccountSummary,
  type InstanceAiAccountsResponse,
  type InstanceExecutionDeviceSummary,
  type InstanceExecutionDevicesResponse,
  type UpdateExecutionDevice,
} from "@paperclipai/shared";
import { accessApi } from "@/api/access";
import { aiAccountHostsApi } from "@/api/ai-account-hosts";
import { aiAccountPoolApi, aiAccountPoolKeys, invalidateAiAccountPoolQueries } from "@/api/ai-account-pool";
import { executionDeviceKeys, executionDevicesApi } from "@/api/execution-devices";
import { AiAccountStateBadge } from "@/components/ai-account-pool/AccountSelect";
import { DeviceLinkDialog, type DeviceLinkRequest } from "@/components/ai-accounts/DeviceLinkDialog";
import {
  HOST_KIND_DESCRIPTIONS,
  HOST_KIND_LABELS,
  MIGRATION_OUTCOME_LABELS,
  MIGRATION_RULE_LABELS,
  acceptedCredentialTypesText,
  accountOwnerText,
  aiAccountErrorMessage,
  companyAgentCountsText,
  environmentChoicesForHost,
  formatUsageWindow,
  maskEmail,
  migrationStatusText,
  projectChipLabel,
} from "@/components/ai-accounts/model";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioCardGroup } from "@/components/ui/radio-card";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import {
  EXECUTION_DEVICE_KIND_LABELS,
  POOL_BADGE_TONE_CLASS,
  POOL_CREDENTIAL_TYPE_LABELS,
  POOL_PRODUCT_LINE,
  aiAccountPoolErrorMessage,
  aiAccountStateDisplay,
  deviceAccountUsageText,
  deviceAvailabilityDisplay,
  deviceOwnerText,
  formatResetTime,
  readAiAccountPoolError,
} from "@/lib/ai-account-pool";
import { queryKeys } from "@/lib/queryKeys";
import { resourceWaitReasonLabel } from "@/lib/resource-wait";
import { cn, formatCents, formatDateTime } from "@/lib/utils";

/** Device availability changes on its own; the account list carries usage sums and is not polled. */
const DEVICE_POLL_MS = 30_000;

const DRIVER_LABELS: Record<string, string> = {
  local: "Local",
  ssh: "SSH",
  sandbox: "Plugin",
};

function driverLabel(driver: string): string {
  return DRIVER_LABELS[driver] ?? driver;
}

function isForbidden(error: unknown): boolean {
  return readAiAccountPoolError(error)?.status === 403;
}

/** Loading and error states for one section; the data renders through `children`. */
function SectionBody<T>({
  query,
  loading,
  children,
}: {
  query: UseQueryResult<T>;
  loading: string;
  children: (data: T) => ReactNode;
}) {
  if (query.isLoading) return <p className="text-sm text-muted-foreground">{loading}</p>;
  if (query.error) {
    return (
      <div className="space-y-2">
        <p role="alert" className="text-sm text-destructive">{aiAccountPoolErrorMessage(query.error)}</p>
        <Button variant="outline" size="sm" onClick={() => void query.refetch()}>Try again</Button>
      </div>
    );
  }
  return query.data === undefined ? null : <>{children(query.data)}</>;
}

/**
 * Fork: Instance settings → Devices & Claude accounts, for instance admins.
 * Every execution device (limits, links between two ways of reaching one
 * machine, explicit environment mappings), every pool account (admin disable,
 * clear limit, owner transfer, removal), the binding migration report, and the
 * legacy host pool, collapsed.
 */
export function InstanceAiAccounts() {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Devices & Claude accounts" },
    ]);
  }, [setBreadcrumbs]);

  const devicesQuery = useQuery({
    queryKey: executionDeviceKeys.instance,
    queryFn: () => executionDevicesApi.listInstance(),
    retry: false,
    refetchInterval: DEVICE_POLL_MS,
  });
  const accountsQuery = useQuery({
    queryKey: aiAccountPoolKeys.instanceAccounts,
    queryFn: () => aiAccountPoolApi.listInstanceAccounts(),
    retry: false,
  });
  const migrationQuery = useQuery({
    queryKey: aiAccountPoolKeys.migration,
    queryFn: () => aiAccountPoolApi.getMigrationReport(),
    retry: false,
    refetchInterval: (query) => (query.state.data?.status === "running" ? 5_000 : false),
  });

  const header = (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <ServerCog className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <h1 className="text-lg font-semibold">Devices & Claude accounts</h1>
      </div>
      <div className="max-w-3xl space-y-2 text-sm text-muted-foreground">
        <p>
          Every machine that runs agents and every Claude account on this Paperclip, across all companies. A Claude
          account belongs to the person who added it and runs agents only in companies where its owner is a member. Each
          device runs at most {DEVICE_POOL_ACCOUNT_LIMIT} Claude accounts.
        </p>
        <p>{POOL_PRODUCT_LINE}</p>
      </div>
    </div>
  );

  if ([devicesQuery.error, accountsQuery.error, migrationQuery.error].some(isForbidden)) {
    return (
      <div className="max-w-5xl space-y-6">
        {header}
        <p role="alert" className="text-sm text-destructive">
          Instance admin access is required to manage devices and Claude accounts.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-5xl space-y-8">
      {header}
      <DevicesSection query={devicesQuery} />
      <AccountsSection query={accountsQuery} />
      <MigrationSection query={migrationQuery} />
      <LegacySection />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

function DevicesSection({ query }: { query: UseQueryResult<InstanceExecutionDevicesResponse> }) {
  const [editing, setEditing] = useState<InstanceExecutionDeviceSummary | null>(null);
  const [mapping, setMapping] = useState<InstanceExecutionDeviceSummary | null>(null);
  const [linkRequest, setLinkRequest] = useState<DeviceLinkRequest | null>(null);
  return (
    <section className="space-y-3" aria-labelledby="instance-devices-heading">
      <div className="space-y-1">
        <h2 id="instance-devices-heading" className="text-sm font-semibold">Devices</h2>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Paperclip finds the device of each environment on its own: Local runs on the Paperclip server, an SSH
          environment on its host, and a plugin environment on the device its plugin reports. When one machine is
          reached both ways, link the two so they share one account limit.
        </p>
      </div>
      <SectionBody query={query} loading="Loading devices…">
        {(data) => data.devices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No devices yet. A device appears once an agent can run on it.</p>
        ) : (
          <div className="space-y-4">
            {data.devices.map((device) => (
              <InstanceDeviceCard
                key={device.id}
                device={device}
                onEdit={() => setEditing(device)}
                onMap={() => setMapping(device)}
                onLink={(hint) => setLinkRequest({ deviceId: device.id, hint })}
              />
            ))}
          </div>
        )}
      </SectionBody>
      <EditDeviceDialog device={editing} onClose={() => setEditing(null)} />
      <DeviceEnvironmentsDialog device={mapping} onClose={() => setMapping(null)} />
      <DeviceLinkDialog request={linkRequest} onClose={() => setLinkRequest(null)} />
    </section>
  );
}

function environmentText(environment: ExecutionDeviceEnvironmentSummary, companyName: (id: string | null) => string | null): string {
  return [
    environment.name,
    driverLabel(environment.driver),
    companyName(environment.companyId) ?? (environment.companyId ? null : "shared"),
    environment.explicit ? "mapped by hand" : null,
  ].filter(Boolean).join(" · ");
}

function InstanceDeviceCard({
  device,
  onEdit,
  onMap,
  onLink,
}: {
  device: InstanceExecutionDeviceSummary;
  onEdit: () => void;
  onMap: () => void;
  onLink: (hint: ExecutionDeviceDuplicateHint) => void;
}) {
  const { companies } = useCompany();
  const companyNames = new Map<string, string>([
    ...companies.map((company): [string, string] => [company.id, company.name]),
    ...device.companies.map((company): [string, string] => [company.companyId, company.companyName]),
  ]);
  const companyName = (id: string | null) => (id ? companyNames.get(id) || null : null);
  const availability = deviceAvailabilityDisplay(device.availability);
  const owner = deviceOwnerText(device.owner);
  const reported = formatResetTime(device.targetReportedAt);
  const meta = [
    device.managedByPluginName ? `Managed by ${device.managedByPluginName}` : EXECUTION_DEVICE_KIND_LABELS[device.kind],
    acceptedCredentialTypesText(device.acceptedCredentialTypes),
    reported ? `last report ${reported}` : null,
  ].filter(Boolean).join(" · ");
  const keys = [device.externalKey, device.targetKey].filter((key): key is string => Boolean(key));
  const usedBy = companyAgentCountsText(device.companies);
  const overLimitSince = formatResetTime(device.overLimitSince);

  return (
    <Card className="block space-y-3 p-4" role="region" aria-label={device.name}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold">{device.name}</h3>
            {owner ? <span className="text-xs text-muted-foreground">— {owner}</span> : null}
            <Badge
              variant="outline"
              data-device-availability={device.availability.state}
              className={cn("font-normal", POOL_BADGE_TONE_CLASS[availability.tone])}
            >
              {availability.label}
            </Badge>
            {device.overLimit ? (
              <Badge variant="outline" className={cn("font-normal", POOL_BADGE_TONE_CLASS.danger)}>Over limit</Badge>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">{meta}</p>
          {keys.length > 0 ? <p className="break-all font-mono text-xs text-muted-foreground">{keys.join(" · ")}</p> : null}
        </div>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={onMap}>Map environments</Button>
          <Button type="button" variant="ghost" size="sm" onClick={onEdit}>Edit</Button>
        </div>
      </div>

      {device.overLimit ? (
        <p className="text-xs text-destructive">
          Over its limit{overLimitSince ? ` since ${overLimitSince}` : ""}: agents that can run here use {device.inUse} Claude
          accounts, more than its {device.limit}. New runs wait for a free slot until agents move or change accounts.
        </p>
      ) : null}

      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">
          {deviceAccountUsageText({ limit: device.limit, inUse: device.inUse, otherCompaniesAccounts: 0 })}
          {usedBy ? ` · ${usedBy}` : ""}
        </p>
        {device.accounts.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {device.accounts.map((account) => {
              const owner = account.owner?.name?.trim() || account.owner?.email || null;
              return (
                <span key={account.id} className="inline-flex items-center gap-1">
                  <Badge variant="outline">
                    {account.label}
                    {owner ? <span className="text-muted-foreground">· {owner}</span> : null}
                  </Badge>
                  {account.state !== "active" ? <AiAccountStateBadge display={aiAccountStateDisplay(account)} /> : null}
                </span>
              );
            })}
          </div>
        ) : null}
      </div>

      {device.environments.length > 0 ? (
        <ul className="space-y-0.5 text-xs" aria-label={`Environments of ${device.name}`}>
          {device.environments.map((environment) => (
            <li key={environment.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span>{environmentText(environment, companyName)}</span>
              {environment.availability.state !== "available" ? (
                <span className="text-muted-foreground">
                  {deviceAvailabilityDisplay(environment.availability).label}
                  {environment.availability.message ? `: ${environment.availability.message}` : ""}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No environment reaches this device right now.</p>
      )}

      {device.aliases.length > 0 ? (
        <p className="text-xs text-muted-foreground">Also known as {device.aliases.join(", ")}</p>
      ) : null}

      {device.duplicateHints.map((hint) => (
        <div key={hint.deviceId} className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline" className={cn("font-normal", POOL_BADGE_TONE_CLASS.info)}>
            Likely the same machine as {hint.deviceName}
          </Badge>
          <Button type="button" variant="ghost" size="xs" onClick={() => onLink(hint)}>
            Link
          </Button>
        </div>
      ))}
    </Card>
  );
}

function EditDeviceDialog({ device, onClose }: { device: InstanceExecutionDeviceSummary | null; onClose: () => void }) {
  return (
    <Dialog open={device !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>{device && <EditDeviceForm device={device} onDone={onClose} />}</DialogContent>
    </Dialog>
  );
}

const DEVICE_LIMIT_CHOICES = Array.from({ length: DEVICE_POOL_ACCOUNT_LIMIT }, (_, index) => index + 1);

function EditDeviceForm({ device, onDone }: { device: InstanceExecutionDeviceSummary; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(device.name);
  const [maxAccounts, setMaxAccounts] = useState(Math.min(device.maxAccounts, DEVICE_POOL_ACCOUNT_LIMIT));
  const save = useMutation({
    mutationFn: (input: UpdateExecutionDevice) => executionDevicesApi.updateInstance(device.id, input),
    onSuccess: async () => {
      await invalidateAiAccountPoolQueries(queryClient);
      onDone();
    },
  });
  const trimmed = name.trim();
  const input: UpdateExecutionDevice = {
    ...(trimmed !== device.name ? { name: trimmed } : {}),
    ...(maxAccounts !== device.maxAccounts ? { maxAccounts } : {}),
  };
  const canSave = trimmed.length > 0 && Object.keys(input).length > 0 && !save.isPending;
  const error = save.error ? aiAccountErrorMessage(save.error) : null;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) save.mutate(input);
      }}
    >
      <DialogHeader>
        <DialogTitle>Edit {device.name}</DialogTitle>
        <DialogDescription>{EXECUTION_DEVICE_KIND_LABELS[device.kind]}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-2">
        <Label htmlFor={`device-name-${device.id}`}>Name</Label>
        <Input
          id={`device-name-${device.id}`}
          value={name}
          maxLength={80}
          disabled={save.isPending}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`device-limit-${device.id}`}>Claude accounts limit</Label>
        <select
          id={`device-limit-${device.id}`}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-base md:text-sm"
          value={String(maxAccounts)}
          disabled={save.isPending}
          onChange={(event) => setMaxAccounts(Number(event.target.value))}
        >
          {DEVICE_LIMIT_CHOICES.map((value) => (
            <option key={value} value={value}>{value === 1 ? "1 account" : `${value} accounts`}</option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          The most Claude accounts the agents that can run here may use. Agents use {device.inUse} now; a lower limit
          than that is refused.
        </p>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter className="sm:items-center sm:justify-between">
        <Button type="button" variant="outline" onClick={onDone} disabled={save.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSave}>
          {save.isPending ? "Saving…" : "Save device"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function DeviceEnvironmentsDialog({ device, onClose }: { device: InstanceExecutionDeviceSummary | null; onClose: () => void }) {
  return (
    <Dialog open={device !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>{device && <DeviceEnvironmentsForm device={device} onDone={onClose} />}</DialogContent>
    </Dialog>
  );
}

/** Explicit mappings live on the legacy host routes; the device and its host are the same row. */
function DeviceEnvironmentsForm({ device, onDone }: { device: InstanceExecutionDeviceSummary; onDone: () => void }) {
  const hostsQuery = useQuery({
    queryKey: queryKeys.instance.aiAccountHosts,
    queryFn: () => aiAccountHostsApi.list(),
    retry: false,
    staleTime: 30_000,
  });
  const host = hostsQuery.data?.hosts.find((candidate) => candidate.id === device.id) ?? null;
  return (
    <>
      <DialogHeader>
        <DialogTitle>Environments mapped to {device.name}</DialogTitle>
        <DialogDescription>
          Map an environment by hand only when Paperclip finds the wrong device for it, or none (its agents then wait
          with "device unknown"). A mapped environment moves off any other device. A mapping that would put more Claude
          accounts on a device than its limit is refused.
        </DialogDescription>
      </DialogHeader>
      {hostsQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading environments…</p>
      ) : hostsQuery.error ? (
        <>
          <p role="alert" className="text-sm text-destructive">{aiAccountErrorMessage(hostsQuery.error)}</p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onDone}>Close</Button>
          </DialogFooter>
        </>
      ) : host ? (
        <EnvironmentMappingForm host={host} unmapped={hostsQuery.data?.unmappedEnvironments ?? []} onDone={onDone} />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">This device is no longer listed. Reload the page and try again.</p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onDone}>Close</Button>
          </DialogFooter>
        </>
      )}
    </>
  );
}

function EnvironmentMappingForm({
  host,
  unmapped,
  onDone,
}: {
  host: AiAccountHostSummary;
  unmapped: AiAccountHostEnvironmentSummary[];
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const { companies } = useCompany();
  // Seeded once per opening; background refreshes do not undo the admin's picks.
  const [selected, setSelected] = useState<Set<string>>(() => new Set(host.environments.map((environment) => environment.id)));
  const [choices] = useState(() => environmentChoicesForHost(host, unmapped));
  const save = useMutation({
    mutationFn: () => aiAccountHostsApi.setEnvironments(host.id, [...selected]),
    onSuccess: async () => {
      await invalidateAiAccountPoolQueries(queryClient);
      onDone();
    },
  });
  const error = save.error ? aiAccountErrorMessage(save.error) : null;
  const companyName = (id: string | null) => (id ? companies.find((company) => company.id === id)?.name ?? null : "Shared");
  const toggle = (id: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  return (
    <>
      {choices.length === 0 ? (
        <p className="text-sm text-muted-foreground">No environment fits a {HOST_KIND_LABELS[host.kind].toLowerCase()}.</p>
      ) : (
        <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-md border border-border">
          {choices.map((environment) => {
            const id = `device-${host.id}-env-${environment.id}`;
            return (
              <li key={environment.id} className="flex items-center gap-3 px-3 py-2">
                <Checkbox
                  id={id}
                  checked={selected.has(environment.id)}
                  disabled={save.isPending}
                  onCheckedChange={(checked) => toggle(environment.id, checked === true)}
                />
                <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
                  <span className="block truncate text-sm">{environment.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {[driverLabel(environment.driver), companyName(environment.companyId)].filter(Boolean).join(" · ")}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter className="sm:items-center sm:justify-between">
        <Button type="button" variant="outline" onClick={onDone} disabled={save.isPending}>
          Cancel
        </Button>
        <Button type="button" disabled={save.isPending || choices.length === 0} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save mappings"}
        </Button>
      </DialogFooter>
    </>
  );
}

// ---------------------------------------------------------------------------
// Claude accounts
// ---------------------------------------------------------------------------

type QuickAction = { type: "enable" | "clear"; id: string };

function AccountsSection({ query }: { query: UseQueryResult<InstanceAiAccountsResponse> }) {
  const queryClient = useQueryClient();
  const [disabling, setDisabling] = useState<InstanceAiAccountSummary | null>(null);
  const [transferring, setTransferring] = useState<InstanceAiAccountSummary | null>(null);
  const [removing, setRemoving] = useState<InstanceAiAccountSummary | null>(null);
  const action = useMutation({
    mutationFn: (input: QuickAction): Promise<unknown> =>
      input.type === "enable"
        ? aiAccountPoolApi.setAdminDisabled(input.id, false)
        : aiAccountPoolApi.clearInstanceLimit(input.id),
    onSettled: () => invalidateAiAccountPoolQueries(queryClient),
  });
  const run = (input: QuickAction) => {
    action.reset();
    action.mutate(input);
  };
  return (
    <section className="space-y-3" aria-labelledby="instance-accounts-heading">
      <div className="space-y-1">
        <h2 id="instance-accounts-heading" className="text-sm font-semibold">Claude accounts</h2>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Owners add and manage their own accounts in Company settings → Claude accounts. Here you can disable an account
          for everyone, clear a limit, transfer an account to another user, or remove it. An account you disable stays
          off until an instance admin enables it again.
        </p>
      </div>
      <SectionBody query={query} loading="Loading Claude accounts…">
        {(data) => data.accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No Claude accounts yet.</p>
        ) : (
          <>
            {action.error ? (
              <p role="alert" className="text-sm text-destructive">{aiAccountPoolErrorMessage(action.error)}</p>
            ) : null}
            <ul className="divide-y divide-border rounded-md border border-border">
              {data.accounts.map((account) => (
                <InstanceAccountRow
                  key={account.id}
                  account={account}
                  busy={action.isPending && action.variables?.id === account.id}
                  onToggleDisabled={() => (account.adminDisabled ? run({ type: "enable", id: account.id }) : setDisabling(account))}
                  onClearLimit={() => run({ type: "clear", id: account.id })}
                  onTransfer={() => setTransferring(account)}
                  onRemove={() => setRemoving(account)}
                />
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              Usage shows what Paperclip ran on each account. The official remaining limit is not available for setup
              tokens.
            </p>
          </>
        )}
      </SectionBody>
      <AdminDisableDialog account={disabling} onClose={() => setDisabling(null)} />
      <TransferOwnerDialog account={transferring} onClose={() => setTransferring(null)} />
      <RemoveAccountDialog account={removing} onClose={() => setRemoving(null)} />
    </section>
  );
}

function InstanceAccountRow({
  account,
  busy,
  onToggleDisabled,
  onClearLimit,
  onTransfer,
  onRemove,
}: {
  account: InstanceAiAccountSummary;
  busy: boolean;
  onToggleDisabled: () => void;
  onClearLimit: () => void;
  onTransfer: () => void;
  onRemove: () => void;
}) {
  const state = aiAccountStateDisplay(account);
  const details = [maskEmail(account.emailHint), account.plan].filter(Boolean).join(" · ");
  const usedIn = companyAgentCountsText(account.companies);
  const toggleId = `instance-account-${account.id}-admin-disabled`;
  return (
    <li className="space-y-2 px-3 py-3" aria-label={account.label}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{account.label}</span>
            <Badge variant="outline">{POOL_CREDENTIAL_TYPE_LABELS[account.credentialType]}</Badge>
            <AiAccountStateBadge display={state} />
            {account.origin === "legacy_host_pool" ? (
              <Badge variant="outline" className="font-normal text-muted-foreground">From the host pool</Badge>
            ) : null}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {account.owner ? `Owner: ${accountOwnerText(account.owner)}` : "No owner"}
            {details ? ` · ${details}` : ""}
            {account.credentialHint ? <> · <span className="font-mono">{account.credentialHint}</span></> : null}
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span id={toggleId}>Disabled by admin</span>
          <ToggleSwitch checked={account.adminDisabled} disabled={busy} aria-labelledby={toggleId} onCheckedChange={onToggleDisabled} />
        </div>
      </div>

      {account.adminDisabled && account.adminDisabledReason ? (
        <p className="text-xs text-muted-foreground">Reason: {account.adminDisabledReason}</p>
      ) : null}
      {account.state === "signed_out" && account.statusMessage ? (
        <p className="text-xs text-destructive">{account.statusMessage}</p>
      ) : null}
      {account.state === "limited" && account.limitStrikes > 1 ? (
        <p className="text-xs text-muted-foreground">
          Reached its limit {account.limitStrikes} times in a row without a successful run in between.
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">{usedIn ? `Used by ${usedIn}` : "Not assigned to any agent."}</p>
      {account.reservedProjects.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span>Reserved for</span>
          {account.reservedProjects.map((project) => (
            <Badge key={project.id} variant="outline" title={project.companyName}>{projectChipLabel(project)}</Badge>
          ))}
          <span>Only those companies can use it until its owner clears this.</span>
        </div>
      ) : null}
      {account.legacyHostName ? (
        <p className="text-xs text-muted-foreground">Added to {account.legacyHostName} before accounts had owners.</p>
      ) : null}
      <AccountUsage account={account} />

      <div className="flex flex-wrap items-center gap-1">
        {account.state === "limited" ? (
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onClearLimit}>Clear limit</Button>
        ) : null}
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onTransfer}>Transfer owner</Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onRemove}>Remove</Button>
      </div>
    </li>
  );
}

/** Paperclip's own use of the account; money only for API keys, which are billed per use. */
function AccountUsage({ account }: { account: InstanceAiAccountSummary }) {
  const windows = [
    { label: "Last 5 h", window: account.usage.lastFiveHours },
    { label: "Last 7 days", window: account.usage.lastSevenDays },
  ];
  return (
    <div className="space-y-0.5 text-xs text-muted-foreground" data-testid="account-usage">
      {windows.map(({ label, window }) => {
        const { summary, cached } = formatUsageWindow(window);
        return (
          <p key={label}>
            {label}: <span className="font-mono">{summary}</span>
            {cached ? <span className="font-mono"> {cached}</span> : null}
          </p>
        );
      })}
      {account.credentialType === "api_key" ? (
        <p>This month: <span className="font-mono">{formatCents(account.usage.thisMonth.costCents)}</span></p>
      ) : null}
      {account.lastLimitedAt ? <p>Last limit: {formatDateTime(account.lastLimitedAt)}</p> : null}
    </div>
  );
}

function AdminDisableDialog({ account, onClose }: { account: InstanceAiAccountSummary | null; onClose: () => void }) {
  return (
    <Dialog open={account !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>{account && <AdminDisableForm account={account} onDone={onClose} />}</DialogContent>
    </Dialog>
  );
}

function AdminDisableForm({ account, onDone }: { account: InstanceAiAccountSummary; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const disable = useMutation({
    mutationFn: () => aiAccountPoolApi.setAdminDisabled(account.id, true, reason.trim() || null),
    onSuccess: async () => {
      await invalidateAiAccountPoolQueries(queryClient);
      onDone();
    },
  });
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disable.isPending) disable.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>Disable {account.label} for everyone?</DialogTitle>
        <DialogDescription>
          Tasks of agents that use it wait, in every company, until an instance admin enables it again. Its owner cannot
          turn it back on.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-2">
        <Label htmlFor={`admin-disable-reason-${account.id}`}>Reason (optional, shown to the owner)</Label>
        <Input
          id={`admin-disable-reason-${account.id}`}
          value={reason}
          maxLength={300}
          disabled={disable.isPending}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      {disable.error ? <p role="alert" className="text-sm text-destructive">{aiAccountPoolErrorMessage(disable.error)}</p> : null}
      <DialogFooter className="sm:items-center sm:justify-between">
        <Button type="button" variant="outline" onClick={onDone} disabled={disable.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="destructive" disabled={disable.isPending}>
          {disable.isPending ? "Disabling…" : "Disable account"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function TransferOwnerDialog({ account, onClose }: { account: InstanceAiAccountSummary | null; onClose: () => void }) {
  return (
    <Dialog open={account !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-xl">{account && <TransferOwnerForm account={account} onDone={onClose} />}</DialogContent>
    </Dialog>
  );
}

/** 422: the chosen user no longer exists; 409: the new owner already has an account with this e-mail hint. */
function transferErrorMessage(error: unknown): string {
  const info = readAiAccountPoolError(error);
  if (info?.status === 422) return "That user does not exist. Choose an existing user.";
  if (info?.code === "ai_account_duplicate") {
    return "The new owner already has a Claude account with this e-mail. Remove or rename that account first.";
  }
  return aiAccountPoolErrorMessage(error);
}

function TransferOwnerForm({ account, onDone }: { account: InstanceAiAccountSummary; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [choice, setChoice] = useState("");
  const query = search.trim();
  const users = useQuery({
    queryKey: queryKeys.access.adminUsers(query),
    queryFn: () => accessApi.searchAdminUsers(query),
    retry: false,
    placeholderData: keepPreviousData,
  });
  const candidates = (users.data ?? []).filter((user) => user.id !== account.owner?.userId);
  const selected = candidates.some((user) => user.id === choice) ? choice : "";
  const transfer = useMutation({
    mutationFn: (ownerUserId: string) => aiAccountPoolApi.transferOwner(account.id, ownerUserId),
    onSuccess: async () => {
      await invalidateAiAccountPoolQueries(queryClient);
      onDone();
    },
  });
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (selected && !transfer.isPending) transfer.mutate(selected);
      }}
    >
      <DialogHeader>
        <DialogTitle>Transfer {account.label}</DialogTitle>
        <DialogDescription>
          {account.owner ? `Owner now: ${accountOwnerText(account.owner)}.` : "It has no owner yet."} The new owner manages
          the account from now on, and it runs agents only in companies where they are a member. Both owners' companies
          get an activity entry.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-2">
        <Label htmlFor={`transfer-search-${account.id}`}>New owner</Label>
        <Input
          id={`transfer-search-${account.id}`}
          value={search}
          placeholder="Search by name or e-mail"
          autoComplete="off"
          disabled={transfer.isPending}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {users.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading users…</p>
      ) : users.error ? (
        <p role="alert" className="text-sm text-destructive">{aiAccountErrorMessage(users.error)}</p>
      ) : candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">No other user matches.</p>
      ) : (
        <div className="max-h-72 overflow-y-auto">
          <RadioCardGroup
            ariaLabel="Users"
            value={selected}
            onValueChange={setChoice}
            disabled={transfer.isPending}
            options={candidates.map((user) => ({
              value: user.id,
              title: user.name?.trim() || user.email || "Unnamed user",
              description: [
                user.name?.trim() ? user.email : null,
                user.activeCompanyMembershipCount === 1 ? "1 company" : `${user.activeCompanyMembershipCount} companies`,
                user.isInstanceAdmin ? "Instance admin" : null,
              ].filter(Boolean).join(" · "),
            }))}
          />
        </div>
      )}
      {transfer.error ? <p role="alert" className="text-sm text-destructive">{transferErrorMessage(transfer.error)}</p> : null}
      <DialogFooter className="sm:items-center sm:justify-between">
        <Button type="button" variant="outline" onClick={onDone} disabled={transfer.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!selected || transfer.isPending}>
          {transfer.isPending ? "Transferring…" : "Transfer account"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function RemoveAccountDialog({ account, onClose }: { account: InstanceAiAccountSummary | null; onClose: () => void }) {
  return (
    <Dialog open={account !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>{account && <RemoveAccountForm account={account} onDone={onClose} />}</DialogContent>
    </Dialog>
  );
}

function RemoveAccountForm({ account, onDone }: { account: InstanceAiAccountSummary; onDone: () => void }) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: (release: boolean) => aiAccountPoolApi.removeInstanceAccount(account.id, { release }),
    onSuccess: async () => {
      await invalidateAiAccountPoolQueries(queryClient);
      onDone();
    },
  });
  // 409 `ai_account_in_use`: agents still use it; removing it anyway releases them.
  const inUse = readAiAccountPoolError(remove.error)?.code === "ai_account_in_use";
  return (
    <>
      <DialogHeader>
        <DialogTitle>Remove {account.label}?</DialogTitle>
        <DialogDescription>
          Its stored credential is deleted for good. Running tasks finish with it; agents assigned to it then wait until
          someone chooses another account.
        </DialogDescription>
      </DialogHeader>
      {remove.error ? <p role="alert" className="text-sm text-destructive">{aiAccountPoolErrorMessage(remove.error)}</p> : null}
      <DialogFooter className="sm:items-center sm:justify-between">
        <Button type="button" variant="outline" onClick={onDone} disabled={remove.isPending}>
          Cancel
        </Button>
        <Button type="button" variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate(inUse)}>
          {remove.isPending ? "Removing…" : inUse ? "Remove and release agents" : "Remove account"}
        </Button>
      </DialogFooter>
    </>
  );
}

// ---------------------------------------------------------------------------
// Binding migration report
// ---------------------------------------------------------------------------

const GO_NO_GO_PLAN_TEXT: Record<AiAccountMigrationGoNoGoEntry["plan"], string> = {
  use: "would use its account",
  wait: "would wait",
  refuse: "would be refused",
};

function planReasonText(reason: string | null): string | null {
  if (!reason) return null;
  return isResourceWaitReason(reason) ? resourceWaitReasonLabel(reason) : reason;
}

function migrationAgentText(entry: AiAccountMigrationAgentEntry): string {
  const parts = [
    entry.outcome === "bound" ? entry.accountLabel : MIGRATION_OUTCOME_LABELS[entry.outcome],
    entry.rule ? MIGRATION_RULE_LABELS[entry.rule] : null,
    entry.note,
  ];
  return parts.filter(Boolean).join(" · ");
}

function MigrationSection({ query }: { query: UseQueryResult<AiAccountMigrationReport> }) {
  const queryClient = useQueryClient();
  const run = useMutation({
    mutationFn: () => aiAccountPoolApi.runMigration(),
    onSuccess: async (report) => {
      queryClient.setQueryData(aiAccountPoolKeys.migration, report);
      await invalidateAiAccountPoolQueries(queryClient);
    },
  });
  return (
    <section className="space-y-3" aria-labelledby="instance-migration-heading">
      <div className="space-y-1">
        <h2 id="instance-migration-heading" className="text-sm font-semibold">Assignments from the host pool</h2>
        <p className="max-w-3xl text-sm text-muted-foreground">
          When this version first started, Paperclip gave each Claude agent that used the old host pool one account: the
          one reserved for its projects, else the one it used most, else the one its company used most on its device.
          Company admins confirm them in Claude accounts. Running it again adds only the assignments it could not make
          before.
        </p>
      </div>
      <SectionBody query={query} loading="Loading the migration report…">
        {(report) => <MigrationReport report={report} />}
      </SectionBody>
      {query.data ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={run.isPending || query.data.status === "running"}
            onClick={() => {
              run.reset();
              run.mutate();
            }}
          >
            {run.isPending ? "Running…" : query.data.status === "pending" ? "Run now" : "Run again"}
          </Button>
          {run.error ? <p role="alert" className="text-sm text-destructive">{aiAccountPoolErrorMessage(run.error)}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function MigrationReport({ report }: { report: AiAccountMigrationReport }) {
  const summary = report.summary;
  const companyNames = new Map(summary?.agents.map((entry) => [entry.companyId, entry.companyName]) ?? []);
  const blockers = report.goNoGo.agents.filter((entry) => entry.plan !== "use");
  const review = summary?.agents.filter((entry) => entry.outcome !== "bound") ?? [];
  const bound = summary?.agents.filter((entry) => entry.outcome === "bound") ?? [];
  return (
    <Card className="block space-y-3 p-4" role="region" aria-label="Migration report">
      <p className="text-sm">{migrationStatusText(report)}</p>
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className={cn("font-normal", POOL_BADGE_TONE_CLASS[report.goNoGo.go ? "positive" : "danger"])}>
            {report.goNoGo.go ? "Go" : "No-go"}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {report.goNoGo.go
              ? "Every Claude agent that ran on the host pool in the last 7 days will use its account."
              : "Some Claude agents that ran on the host pool in the last 7 days would not use their account."}
          </span>
        </div>
        {blockers.length > 0 ? (
          <ul className="space-y-0.5 text-xs">
            {blockers.map((entry) => (
              <li key={entry.agentId}>
                <span className="font-medium">{entry.agentName}</span>
                <span className="text-muted-foreground">
                  {" "}({companyNames.get(entry.companyId) ?? "another company"}) {GO_NO_GO_PLAN_TEXT[entry.plan]}
                  {planReasonText(entry.reason) ? `: ${planReasonText(entry.reason)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {summary ? (
        <>
          <p className="text-xs text-muted-foreground">
            {summary.bound} assigned · {summary.unassigned} waiting for an account · {summary.unbound} not assigned
          </p>
          {review.length > 0 ? (
            <div className="space-y-1">
              <p className="text-xs font-medium">Needs a review</p>
              <ul className="space-y-0.5 text-xs">
                {review.map((entry) => (
                  <li key={entry.agentId}>
                    <span className="font-medium">{entry.agentName}</span>
                    <span className="text-muted-foreground"> ({entry.companyName}) · {migrationAgentText(entry)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {bound.length > 0 ? (
            <Collapsible>
              <CollapsibleTrigger className="flex items-center gap-1.5 text-xs font-medium">
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform [[data-state=open]>&]:rotate-90" />
                Assigned agents ({bound.length})
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul className="space-y-0.5 pt-1 text-xs">
                  {bound.map((entry) => (
                    <li key={entry.agentId}>
                      <span className="font-medium">{entry.agentName}</span>
                      <span className="text-muted-foreground"> ({entry.companyName}) · {migrationAgentText(entry)}</span>
                    </li>
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          ) : null}
          {summary.overLimitDevices.length > 0 ? (
            <p className="text-xs text-destructive">
              Over their limit:{" "}
              {summary.overLimitDevices.map((device) => `${device.deviceName} (${device.inUse} of ${device.limit})`).join(", ")}
            </p>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Legacy host pool
// ---------------------------------------------------------------------------

function LegacySection() {
  const [open, setOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  // Read only while open: the host list sums seven days of usage per account.
  const hostsQuery = useQuery({
    queryKey: queryKeys.instance.aiAccountHosts,
    queryFn: () => aiAccountHostsApi.list(),
    enabled: open,
    retry: false,
  });
  return (
    <section className="space-y-3" aria-labelledby="instance-legacy-heading">
      <Collapsible open={open} onOpenChange={setOpen} className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 id="instance-legacy-heading" className="text-sm font-semibold">Legacy host pool</h2>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Before accounts had owners, each device had its own accounts. Those accounts are now in the list above.
            </p>
          </div>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="outline" size="sm">
              {open ? <ChevronDown /> : <ChevronRight />}
              {open ? "Hide" : "Show"}
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-3xl text-xs text-muted-foreground">
              Paperclip adds devices on its own when their environments run. Add one by hand only to map environments to
              it.
            </p>
            <Button type="button" size="sm" variant="outline" onClick={() => setAddOpen(true)}>
              <Plus />
              Add device
            </Button>
          </div>
          <SectionBody query={hostsQuery} loading="Loading the host pool…">
            {(data) => (
              <div className="space-y-3">
                {data.hosts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No devices in the host pool.</p>
                ) : (
                  data.hosts.map((host) => <LegacyHostCard key={host.id} host={host} />)
                )}
                {data.unmappedEnvironments.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Not mapped by hand: {data.unmappedEnvironments.map((environment) => environment.name).join(", ")}.
                  </p>
                ) : null}
              </div>
            )}
          </SectionBody>
        </CollapsibleContent>
      </Collapsible>
      <AddHostDialog open={addOpen} onOpenChange={setAddOpen} />
    </section>
  );
}

function LegacyHostCard({ host }: { host: AiAccountHostSummary }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => aiAccountHostsApi.deleteHost(host.id),
    onSuccess: async () => {
      await invalidateAiAccountPoolQueries(queryClient);
      setConfirming(false);
    },
  });
  return (
    <Card className="block space-y-2 p-4" role="region" aria-label={host.name}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <h3 className="truncate text-sm font-semibold">{host.name}</h3>
          <p className="text-xs text-muted-foreground">{HOST_KIND_LABELS[host.kind]}</p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(true)}>Remove</Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Mapped by hand: {host.environments.length > 0 ? host.environments.map((environment) => environment.name).join(", ") : "none"}
      </p>
      <p className="text-xs text-muted-foreground">
        Accounts added here: {host.accounts.length > 0 ? host.accounts.map((account) => account.label).join(", ") : "none"}
      </p>
      <Dialog open={confirming} onOpenChange={(next) => (remove.isPending ? undefined : setConfirming(next))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {host.name}?</DialogTitle>
            <DialogDescription>
              Its environment mappings are removed. Accounts added to it stay in the pool. Paperclip adds the device
              again when one of its environments runs.
            </DialogDescription>
          </DialogHeader>
          {remove.error ? <p role="alert" className="text-sm text-destructive">{aiAccountErrorMessage(remove.error)}</p> : null}
          <DialogFooter className="sm:items-center sm:justify-between">
            <Button type="button" variant="outline" onClick={() => setConfirming(false)} disabled={remove.isPending}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
              {remove.isPending ? "Removing…" : "Remove device"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function AddHostDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>{open && <AddHostForm onDone={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  );
}

function AddHostForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<AiAccountHostKind>("ssh_host");
  const create = useMutation({
    mutationFn: () => aiAccountHostsApi.createHost({ name: name.trim(), kind }),
    onSuccess: async () => {
      await invalidateAiAccountPoolQueries(queryClient);
      onDone();
    },
  });
  const error = create.error ? aiAccountErrorMessage(create.error) : null;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() && !create.isPending) create.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>Add a device</DialogTitle>
        <DialogDescription>A machine that runs agents. Map its environments after adding it.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-2">
        <Label htmlFor="legacy-device-name">Name</Label>
        <Input
          id="legacy-device-name"
          value={name}
          maxLength={80}
          placeholder="Build machine"
          disabled={create.isPending}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="grid gap-2">
        <span className="text-sm font-medium">Kind</span>
        <RadioCardGroup
          ariaLabel="Device kind"
          value={kind}
          onValueChange={(next) => setKind(next as AiAccountHostKind)}
          disabled={create.isPending}
          options={AI_ACCOUNT_HOST_CREATABLE_KINDS.map((value) => ({
            value,
            title: HOST_KIND_LABELS[value],
            description: HOST_KIND_DESCRIPTIONS[value],
          }))}
        />
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter className="sm:items-center sm:justify-between">
        <Button type="button" variant="outline" onClick={onDone} disabled={create.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!name.trim() || create.isPending}>
          {create.isPending ? "Adding…" : "Add device"}
        </Button>
      </DialogFooter>
    </form>
  );
}
