import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Laptop } from "lucide-react";
import { DEVICE_POOL_ACCOUNT_LIMIT } from "@paperclipai/shared";
import { executionDeviceKeys, executionDevicesApi } from "@/api/execution-devices";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import {
  EXECUTION_DEVICE_KIND_LABELS,
  POOL_BADGE_TONE_CLASS,
  aiAccountPoolErrorMessage,
  deviceAccountUsageText,
  deviceAvailabilityDisplay,
  deviceOwnerText,
} from "@/lib/ai-account-pool";
import { cn } from "@/lib/utils";

/**
 * Fork: Company settings → Devices, for every member. The machines that run
 * this company's agents, their availability, and their Claude account slots.
 */
export function ExecutionDevices() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const companyId = selectedCompanyId ?? "";

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
    // Devices go offline and come back on their own; keep the page current.
    refetchInterval: 30_000,
  });

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

  if (devicesQuery.isLoading) {
    return (
      <div className="max-w-5xl space-y-6">
        {header}
        <p className="text-sm text-muted-foreground">Loading devices…</p>
      </div>
    );
  }

  if (devicesQuery.error) {
    return (
      <div className="max-w-5xl space-y-6">
        {header}
        <div className="space-y-3">
          <p role="alert" className="text-sm text-destructive">{aiAccountPoolErrorMessage(devicesQuery.error)}</p>
          <Button variant="outline" size="sm" onClick={() => void devicesQuery.refetch()}>Try again</Button>
        </div>
      </div>
    );
  }

  const devices = devicesQuery.data?.devices ?? [];
  return (
    <div className="max-w-5xl space-y-6">
      {header}
      {devices.length === 0 ? (
        <Card className="block space-y-2 p-4">
          <p className="text-sm font-medium">No devices yet</p>
          <p className="text-sm text-muted-foreground">
            A device appears here once one of this company's agents can run on it.
          </p>
        </Card>
      ) : (
        <div className="space-y-4">
          {devices.map((device) => {
            const availability = deviceAvailabilityDisplay(device.availability);
            const owner = deviceOwnerText(device.owner);
            return (
              <Card key={device.id} className="block space-y-2 p-4" role="region" aria-label={device.name}>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-sm font-semibold">{device.name}</h2>
                  <span className="text-xs text-muted-foreground">
                    {device.managedByPluginName
                      ? `Managed by ${device.managedByPluginName}`
                      : EXECUTION_DEVICE_KIND_LABELS[device.kind]}
                    {owner ? ` · ${owner}` : ""}
                  </span>
                  <Badge variant="outline" className={cn("font-normal", POOL_BADGE_TONE_CLASS[availability.tone])}>
                    {availability.label}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {deviceAccountUsageText(device)}
                  {device.waitingCount > 0 ? ` · ${device.waitingCount} waiting ${device.waitingCount === 1 ? "task" : "tasks"}` : ""}
                </p>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
