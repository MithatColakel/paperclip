import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExecutionDeviceDuplicateHint } from "@paperclipai/shared";
import { invalidateAiAccountPoolQueries } from "@/api/ai-account-pool";
import { executionDeviceKeys, executionDevicesApi } from "@/api/execution-devices";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { readAiAccountPoolError } from "@/lib/ai-account-pool";
import { aiAccountErrorMessage, deviceLinkPlan, type DeviceLinkPlan } from "./model";

/** A device and one of its "likely the same machine" hints. */
export interface DeviceLinkRequest {
  deviceId: string;
  hint: ExecutionDeviceDuplicateHint;
}

/** Why the two look like one machine, naming both once the pair is known. */
function matchedByText(hint: ExecutionDeviceDuplicateHint, plan: DeviceLinkPlan | null): string {
  if (!plan) return hint.matchedBy === "alias" ? "a reported host name matches" : "a reported name matches";
  return hint.matchedBy === "alias"
    ? `the plugin reports ${plan.target.name} under a host name that ${plan.device.name} is reached at over SSH`
    : `the plugin's name for ${plan.target.name} is the name of an SSH environment that reaches ${plan.device.name}`;
}

/**
 * Fork: links one machine reached two ways (an SSH environment and an
 * environment driver plugin) into one device, so both share one limit of
 * Claude accounts. Instance admins only; the dialog reads the instance device
 * list for the plugin's target, then calls `link-target`.
 */
export function DeviceLinkDialog({
  request,
  onClose,
}: {
  request: DeviceLinkRequest | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={request !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>{request && <DeviceLinkForm request={request} onDone={onClose} />}</DialogContent>
    </Dialog>
  );
}

function DeviceLinkForm({ request, onDone }: { request: DeviceLinkRequest; onDone: () => void }) {
  const queryClient = useQueryClient();
  const devices = useQuery({
    queryKey: executionDeviceKeys.instance,
    queryFn: () => executionDevicesApi.listInstance(),
    retry: false,
    staleTime: 30_000,
  });
  const list = devices.data?.devices ?? [];
  const device = list.find((candidate) => candidate.id === request.deviceId);
  const other = list.find((candidate) => candidate.id === request.hint.deviceId);
  const plan = device && other ? deviceLinkPlan(device, other) : null;
  const link = useMutation({
    mutationFn: () => executionDevicesApi.linkTarget(plan!.device.id, plan!.input),
    onSuccess: async () => {
      await invalidateAiAccountPoolQueries(queryClient);
      onDone();
    },
  });

  let body: ReactNode;
  if (devices.isLoading) {
    body = <p className="text-sm text-muted-foreground">Loading devices…</p>;
  } else if (devices.error) {
    body = (
      <p role="alert" className="text-sm text-destructive">
        {readAiAccountPoolError(devices.error)?.status === 403
          ? "Only instance admins can link devices."
          : aiAccountErrorMessage(devices.error)}
      </p>
    );
  } else if (!plan) {
    body = (
      <p className="text-sm text-muted-foreground">
        These two cannot be linked. Only a device reached over SSH can take a plugin device's place, and only while it has
        no plugin device of its own.
      </p>
    );
  } else {
    body = (
      <p className="text-sm text-muted-foreground">
        {plan.target.name} is merged into {plan.device.name}: its account slots, environment mappings and waiting tasks
        move over, and both ways of reaching the machine share one limit of Claude accounts. The plugin's reports then
        update {plan.device.name}.
      </p>
    );
  }

  const error = link.error ? aiAccountErrorMessage(link.error) : null;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{plan ? `Link ${plan.device.name} and ${plan.target.name}?` : "Link devices"}</DialogTitle>
        <DialogDescription>
          They look like the same machine: {matchedByText(request.hint, plan)}.
        </DialogDescription>
      </DialogHeader>
      {body}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter className="sm:items-center sm:justify-between">
        <Button type="button" variant="outline" onClick={onDone} disabled={link.isPending}>
          Cancel
        </Button>
        <Button type="button" disabled={!plan || link.isPending} onClick={() => link.mutate()}>
          {link.isPending ? "Linking…" : "Link devices"}
        </Button>
      </DialogFooter>
    </>
  );
}
