import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Laptop } from "lucide-react";
import {
  DEVICE_POOL_ACCOUNT_LIMIT,
  type ExecutionDeviceAgentRef,
  type ExecutionDeviceCheckNowResponse,
  type ExecutionDeviceDuplicateHint,
  type ExecutionDeviceSummary,
  type ExecutionDeviceWaitSummary,
  type ExecutionWaitSettings,
  type UpdateExecutionWaitSettings,
} from "@paperclipai/shared";
import { accessApi } from "@/api/access";
import { executionDeviceKeys, executionDevicesApi } from "@/api/execution-devices";
import { AiAccountStateBadge } from "@/components/ai-account-pool/AccountSelect";
import { DeviceLinkDialog, type DeviceLinkRequest } from "@/components/ai-accounts/DeviceLinkDialog";
import {
  acceptedCredentialTypesText,
  isCompanyAdminAccess,
  isCompanyViewerAccess,
  notifyAfterHoursFromSelect,
  notifyAfterOptions,
  notifyAfterSelectValue,
} from "@/components/ai-accounts/model";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { isInstanceAdminAccess } from "@/hooks/useIsInstanceAdmin";
import {
  EXECUTION_DEVICE_KIND_LABELS,
  POOL_BADGE_TONE_CLASS,
  aiAccountPoolErrorMessage,
  aiAccountStateDisplay,
  deviceAccountUsageText,
  deviceAvailabilityDisplay,
  deviceOwnerText,
  formatResetTime,
} from "@/lib/ai-account-pool";
import { queryKeys } from "@/lib/queryKeys";
import { resourceWaitReasonLabel } from "@/lib/resource-wait";
import { Link } from "@/lib/router";
import { agentUrl, cn } from "@/lib/utils";

/** Devices go offline and come back on their own; keep the page current. */
const DEVICE_POLL_MS = 30_000;

/**
 * Fork: Company settings → Devices, for every member. The machines that run
 * this company's agents, their availability, and their Claude account slots.
 * Accounts of other companies are counts only. Admins also set when a long
 * wait is reported.
 */
export function ExecutionDevices() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const companyId = selectedCompanyId ?? "";
  const [linkRequest, setLinkRequest] = useState<DeviceLinkRequest | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Devices" },
    ]);
  }, [setBreadcrumbs]);

  const devicesQuery = useQuery({
    queryKey: executionDeviceKeys.company(companyId),
    queryFn: () => executionDevicesApi.list(companyId),
    enabled: Boolean(selectedCompanyId),
    retry: false,
    refetchInterval: DEVICE_POLL_MS,
  });
  const boardAccess = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
    staleTime: 30_000,
  });
  const isAdmin = isCompanyAdminAccess(selectedCompanyId, boardAccess.data);
  const isInstanceAdmin = isInstanceAdminAccess(boardAccess.data);
  // Shown unless the snapshot says viewer; the server answers a viewer with 403.
  const canCheckNow = !isCompanyViewerAccess(selectedCompanyId, boardAccess.data);

  const header = (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Laptop className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <h1 className="text-lg font-semibold">Devices</h1>
      </div>
      <p className="max-w-3xl text-sm text-muted-foreground">
        The machines that run this company's agents. Each device runs at most {DEVICE_POOL_ACCOUNT_LIMIT} Claude accounts;
        agents on a device's own login do not count. When a device is unavailable, its tasks wait and start
        automatically when it is back.
      </p>
    </div>
  );

  let body: ReactNode;
  if (devicesQuery.isLoading) {
    body = <p className="text-sm text-muted-foreground">Loading devices…</p>;
  } else if (devicesQuery.error) {
    body = (
      <div className="space-y-3">
        <p role="alert" className="text-sm text-destructive">{aiAccountPoolErrorMessage(devicesQuery.error)}</p>
        <Button variant="outline" size="sm" onClick={() => void devicesQuery.refetch()}>Try again</Button>
      </div>
    );
  } else {
    const devices = devicesQuery.data?.devices ?? [];
    body = devices.length === 0 ? (
      <Card className="block space-y-2 p-4">
        <p className="text-sm font-medium">No devices yet</p>
        <p className="text-sm text-muted-foreground">
          A device appears here once one of this company's agents can run on it.
        </p>
      </Card>
    ) : (
      <div className="space-y-4">
        {devices.map((device) => (
          <DeviceCard
            key={device.id}
            companyId={companyId}
            device={device}
            canCheckNow={canCheckNow}
            canLink={isInstanceAdmin}
            onLink={(hint) => setLinkRequest({ deviceId: device.id, hint })}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="max-w-5xl space-y-6">
      {header}
      {body}
      {isAdmin && selectedCompanyId ? <WaitSettingsCard companyId={companyId} /> : null}
      <DeviceLinkDialog request={linkRequest} onClose={() => setLinkRequest(null)} />
    </div>
  );
}

/** The in-place answer of "Check now"; it stays until the next check, so it names its time. */
function checkNowResultText(result: ExecutionDeviceCheckNowResponse): string {
  const availability = result.device.availability;
  const checked = formatResetTime(result.checkedAt);
  const at = checked ? ` (checked at ${checked})` : "";
  if (availability.state === "available") {
    const woken = result.woken === 1 ? " 1 waiting task is starting." : result.woken > 1 ? ` ${result.woken} waiting tasks are starting.` : "";
    return `Available${at}.${woken}`;
  }
  if (availability.state === "retired") return `Removed${at}.`;
  return `Still unavailable: ${deviceAvailabilityDisplay(availability).label}${at}.`;
}

/**
 * The Claude account of an agent bound to the pool. There is no id when no
 * account is chosen, or when its owner is not a member here; both wait for a
 * choice, and neither names another company's account.
 */
function poolAgentAccountText(agent: ExecutionDeviceAgentRef, accountLabels: ReadonlyMap<string, string>): string {
  const label = agent.accountId ? accountLabels.get(agent.accountId) : undefined;
  return label ?? "no usable Claude account";
}

function DeviceCard({
  companyId,
  device,
  canCheckNow,
  canLink,
  onLink,
}: {
  companyId: string;
  device: ExecutionDeviceSummary;
  canCheckNow: boolean;
  canLink: boolean;
  onLink: (hint: ExecutionDeviceDuplicateHint) => void;
}) {
  const queryClient = useQueryClient();
  const availability = deviceAvailabilityDisplay(device.availability);
  const owner = deviceOwnerText(device.owner);
  const kindText = device.managedByPluginName
    ? `Managed by ${device.managedByPluginName}`
    : EXECUTION_DEVICE_KIND_LABELS[device.kind];
  const accepted = acceptedCredentialTypesText(device.acceptedCredentialTypes);
  const accountLabels = new Map(device.accounts.map((account) => [account.id, account.label]));
  // Agents on the device's own login (or with no choice yet) are a count; they take no account slot.
  const poolAgents = device.agents.filter((agent) => agent.mode === "pool_account");
  const overLimitSince = formatResetTime(device.overLimitSince);

  const checkNow = useMutation({
    mutationFn: () => executionDevicesApi.checkNow(companyId, device.id),
    onSuccess: async (result) => {
      queryClient.setQueryData(executionDeviceKeys.detail(companyId, device.id), result.device);
      await queryClient.invalidateQueries({ queryKey: executionDeviceKeys.company(companyId), exact: true });
    },
  });

  return (
    <Card className="block space-y-3 p-4" role="region" aria-label={device.name}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-sm font-semibold">{device.name}</h2>
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
          <p className="text-xs text-muted-foreground">{[kindText, accepted].filter(Boolean).join(" · ")}</p>
        </div>
        {canCheckNow ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={checkNow.isPending}
            onClick={() => {
              checkNow.reset();
              checkNow.mutate();
            }}
          >
            {checkNow.isPending ? "Checking…" : "Check now"}
          </Button>
        ) : null}
      </div>

      {checkNow.data ? <p role="status" className="text-xs text-muted-foreground">{checkNowResultText(checkNow.data)}</p> : null}
      {checkNow.error ? <p role="alert" className="text-xs text-destructive">{aiAccountPoolErrorMessage(checkNow.error)}</p> : null}

      {device.overLimit ? (
        <p className="text-xs text-destructive">
          Over its limit{overLimitSince ? ` since ${overLimitSince}` : ""}: agents that can run here use {device.inUse} Claude
          accounts, more than its {device.limit}. New runs wait for a free slot. Give some agents an account already on
          this device, or move them to another device.
        </p>
      ) : null}

      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">{deviceAccountUsageText(device)}</p>
        {device.accounts.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5" data-testid="device-accounts">
            {device.accounts.map((account) => (
              <span key={account.id} className="inline-flex items-center gap-1">
                <Badge variant="outline">{account.label}</Badge>
                {account.state !== "active" ? <AiAccountStateBadge display={aiAccountStateDisplay(account)} /> : null}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {poolAgents.length > 0 || device.ownLoginAgents > 0 ? (
        <div className="space-y-1">
          {poolAgents.length > 0 ? (
            <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs" aria-label={`Agents on ${device.name}`}>
              {poolAgents.map((agent) => (
                <li key={agent.agentId}>
                  <Link to={agentUrl({ id: agent.agentId, name: agent.agentName })} className="font-medium hover:underline">
                    {agent.agentName}
                  </Link>
                  <span className="text-muted-foreground"> · {poolAgentAccountText(agent, accountLabels)}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {device.ownLoginAgents > 0 ? (
            <p className="text-xs text-muted-foreground">
              Own login: {device.ownLoginAgents} {device.ownLoginAgents === 1 ? "agent" : "agents"} (not counted)
            </p>
          ) : null}
        </div>
      ) : null}

      {device.environments.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Reached through{" "}
          {device.environments
            .map((environment) => environment.availability.state === "available"
              ? environment.name
              : `${environment.name} (${deviceAvailabilityDisplay(environment.availability).label})`)
            .join(", ")}
        </p>
      ) : null}

      {device.duplicateHints.map((hint) => (
        <div key={hint.deviceId} className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline" className={cn("font-normal", POOL_BADGE_TONE_CLASS.info)}>
            Likely the same machine as {hint.deviceName}
          </Badge>
          {canLink ? (
            <Button type="button" variant="ghost" size="xs" onClick={() => onLink(hint)}>
              Link
            </Button>
          ) : (
            <span className="text-muted-foreground">An instance admin can link them so they count as one device.</span>
          )}
        </div>
      ))}

      {device.waitingCount > 0 ? <DeviceWaits companyId={companyId} device={device} /> : null}
    </Card>
  );
}

function DeviceWaits({ companyId, device }: { companyId: string; device: ExecutionDeviceSummary }) {
  const detail = useQuery({
    queryKey: executionDeviceKeys.detail(companyId, device.id),
    queryFn: () => executionDevicesApi.get(companyId, device.id),
    retry: false,
    refetchInterval: DEVICE_POLL_MS,
  });
  const title = `Waiting tasks (${device.waitingCount})`;
  return (
    <div className="space-y-1" aria-label={title} role="group">
      <p className="text-xs font-medium">{title}</p>
      {detail.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading waiting tasks…</p>
      ) : detail.error ? (
        <p role="alert" className="text-xs text-destructive">{aiAccountPoolErrorMessage(detail.error)}</p>
      ) : (
        <ul className="space-y-0.5 text-xs">
          {(detail.data?.waits ?? []).map((wait) => <DeviceWaitRow key={wait.runId} wait={wait} />)}
        </ul>
      )}
    </div>
  );
}

function DeviceWaitRow({ wait }: { wait: ExecutionDeviceWaitSummary }) {
  const since = formatResetTime(wait.since);
  const resumes = formatResetTime(wait.resumeAt);
  const details = [
    resourceWaitReasonLabel(wait.reason),
    since ? `since ${since}` : null,
    resumes ? `resumes ${resumes}` : null,
  ].filter(Boolean).join(" · ");
  return (
    <li className="flex flex-wrap items-baseline gap-x-2">
      {wait.issueId ? (
        <Link to={`/issues/${wait.issueIdentifier ?? wait.issueId}`} className="font-medium hover:underline">
          {wait.issueIdentifier ? `${wait.issueIdentifier} ` : ""}{wait.issueTitle ?? "Task"}
        </Link>
      ) : (
        <span className="font-medium">{wait.agentName}</span>
      )}
      <span className="text-muted-foreground">{wait.issueId ? `${wait.agentName} · ${details}` : details}</span>
    </li>
  );
}

function WaitSettingsCard({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: executionDeviceKeys.waitSettings(companyId),
    queryFn: () => executionDevicesApi.getWaitSettings(companyId),
    retry: false,
  });
  const save = useMutation({
    mutationFn: (input: UpdateExecutionWaitSettings) => executionDevicesApi.updateWaitSettings(companyId, input),
    onSuccess: (next) => queryClient.setQueryData<ExecutionWaitSettings>(executionDeviceKeys.waitSettings(companyId), next),
  });
  const update = (input: UpdateExecutionWaitSettings) => {
    save.reset();
    save.mutate(input);
  };

  const settings = settingsQuery.data;
  return (
    <Card className="block space-y-4 p-4" role="region" aria-label="Waiting notifications">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">Waiting notifications</h2>
        <p className="text-sm text-muted-foreground">
          Usage limits and problems a person has to fix, such as a signed-out account or a project a device does not
          take, are posted on the task right away. A task waiting for an unavailable device gets a notice after the time
          below; it still starts automatically when the device is back.
        </p>
      </div>
      {settingsQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : settingsQuery.error ? (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">{aiAccountPoolErrorMessage(settingsQuery.error)}</p>
          <Button variant="outline" size="sm" onClick={() => void settingsQuery.refetch()}>Try again</Button>
        </div>
      ) : settings ? (
        <div className="space-y-4">
          <label className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <span>Notice after a task waits for its device for</span>
            <select
              aria-label="Notice after a device wait of"
              className="rounded-md border border-border bg-background px-3 py-2 text-base md:text-sm"
              value={notifyAfterSelectValue(settings.notifyAfterHours)}
              disabled={save.isPending}
              onChange={(event) => update({ notifyAfterHours: notifyAfterHoursFromSelect(event.target.value) })}
            >
              {notifyAfterOptions(settings).map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <SettingToggle
            id={`wait-settings-${companyId}-account`}
            label="Wake the task's manager agent right away for usage limits and problems a person must fix"
            description="The task notice is posted either way."
            checked={settings.notifyPmOnAccountWait}
            disabled={save.isPending}
            onChange={(notifyPmOnAccountWait) => update({ notifyPmOnAccountWait })}
          />
          <SettingToggle
            id={`wait-settings-${companyId}-device`}
            label="Also wake the task's manager agent when a device wait reaches the notice time"
            description="Off by default: an unavailable device usually comes back on its own."
            checked={settings.notifyPmOnDeviceWait}
            disabled={save.isPending}
            onChange={(notifyPmOnDeviceWait) => update({ notifyPmOnDeviceWait })}
          />
        </div>
      ) : null}
      {save.error ? <p role="alert" className="text-sm text-destructive">{aiAccountPoolErrorMessage(save.error)}</p> : null}
    </Card>
  );
}

function SettingToggle({
  id,
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-0.5">
        <p id={id} className="text-sm">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <ToggleSwitch checked={checked} disabled={disabled} aria-labelledby={id} onCheckedChange={onChange} />
    </div>
  );
}
