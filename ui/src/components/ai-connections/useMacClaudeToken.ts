import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { pluginsApi } from "@/api/plugins";

/** Plugin key of the Mac Fleet plugin that reaches enrolled Macs. */
export const MAC_FLEET_PLUGIN_KEY = "paperclip.mac-fleet";
const POLL_MS = 3000;

export type MacTokenDevice = {
  id: string;
  name: string;
  online: boolean;
  claude: { loggedIn: boolean; subscriptionType: string | null; emailMasked: string | null } | null;
};

export type MacTokenRequestStatus = "idle" | "requesting" | "pending" | "collecting" | "declined" | "expired" | "failed";

type RequestStatusResponse = { status: "pending" | "fulfilled" | "declined" | "expired" | "collected"; expiresAt: string };

/**
 * Asks one of this company's Mac Fleet Macs for its Claude subscription. The
 * person at the Mac approves and runs `claude setup-token`; the token comes
 * back once, through the board user's own authorized session.
 */
export function useMacClaudeToken(companyId: string, onToken: (token: string, accountLabel: string | null) => void, enabled = true) {
  const plugins = useQuery({ queryKey: ["plugins", "ready"], queryFn: () => pluginsApi.list("ready"), enabled });
  const pluginId = plugins.data?.find((plugin) => plugin.pluginKey === MAC_FLEET_PLUGIN_KEY)?.id ?? null;
  const devices = useQuery({
    queryKey: ["mac-fleet", companyId, "claude-token-devices", pluginId],
    queryFn: async () => (await pluginsApi.bridgeGetData(pluginId!, "claude-token-devices", {}, companyId)).data as { devices: MacTokenDevice[] },
    enabled: enabled && Boolean(pluginId),
    refetchInterval: 15_000,
  });
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [status, setStatus] = useState<MacTokenRequestStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const requestId = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  async function start() {
    if (!pluginId || !deviceId || status === "requesting" || status === "pending") return;
    setStatus("requesting");
    setError(null);
    try {
      const created = (await pluginsApi.bridgePerformAction(pluginId, "request-claude-token", { deviceId }, companyId)).data as { requestId: string; expiresAt: string };
      requestId.current = created.requestId;
      setExpiresAt(created.expiresAt);
      setStatus("pending");
    } catch (cause) {
      setStatus("failed");
      setError(cause instanceof Error ? cause.message : "Could not reach the Mac.");
    }
  }

  function cancel() {
    const id = requestId.current;
    requestId.current = null;
    setStatus("idle");
    setExpiresAt(null);
    if (pluginId && id) void pluginsApi.bridgePerformAction(pluginId, "cancel-claude-token-request", { requestId: id }, companyId).catch(() => undefined);
  }

  useEffect(() => {
    if (status !== "pending" || !pluginId) return;
    let stopped = false;
    const timer = setInterval(async () => {
      const id = requestId.current;
      if (!id || stopped) return;
      try {
        const current = (await pluginsApi.bridgeGetData(pluginId, "claude-token-request", { requestId: id }, companyId)).data as RequestStatusResponse;
        if (stopped || requestId.current !== id) return;
        if (current.status === "declined" || current.status === "expired" || current.status === "collected") {
          requestId.current = null;
          setStatus(current.status === "declined" ? "declined" : "expired");
          return;
        }
        if (current.status !== "fulfilled") return;
        setStatus("collecting");
        const collected = (await pluginsApi.bridgePerformAction(pluginId, "collect-claude-token", { requestId: id }, companyId)).data as { token: string; accountLabel: string | null };
        requestId.current = null;
        setStatus("idle");
        onTokenRef.current(collected.token, collected.accountLabel);
      } catch (cause) {
        if (stopped) return;
        requestId.current = null;
        setStatus("failed");
        setError(cause instanceof Error ? cause.message : "Could not read the request.");
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [status, pluginId, companyId]);

  // Leaving the dialog withdraws a request nobody will collect.
  useEffect(() => () => {
    const id = requestId.current;
    if (pluginId && id) void pluginsApi.bridgePerformAction(pluginId, "cancel-claude-token-request", { requestId: id }, companyId).catch(() => undefined);
  }, [pluginId, companyId]);

  return {
    available: Boolean(pluginId),
    loading: plugins.isLoading || devices.isLoading,
    devices: devices.data?.devices ?? [],
    devicesError: devices.error,
    deviceId,
    selectDevice: (id: string) => {
      if (status === "pending" || status === "requesting" || status === "collecting") return;
      setDeviceId(id);
      setStatus("idle");
      setError(null);
    },
    status,
    error,
    expiresAt,
    start,
    cancel,
  };
}
export type MacClaudeToken = ReturnType<typeof useMacClaudeToken>;
