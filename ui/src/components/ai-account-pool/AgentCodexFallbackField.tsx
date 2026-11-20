import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentCodexFallbackView, SetAgentCodexFallback } from "@paperclipai/shared";
import { aiAccountPoolApi, aiAccountPoolKeys } from "@/api/ai-account-pool";
import { ApiError } from "@/api/client";
import { Field } from "@/components/agent-config-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { formatResetTime } from "@/lib/ai-account-pool";

/**
 * Fork: the Codex fallback of a Claude agent (AI-CONNECTIONS.md, "Codex
 * fallback on a device"). While the agent's Claude account is at its usage
 * limit, its runs use its device's own Codex login instead of waiting, and it
 * goes back to Claude after the reset. Company admins turn it on; it saves at
 * once, like the Claude account field above it.
 */

export const CODEX_FALLBACK_FIELD_HINT =
  "When this agent's Claude account reaches its usage limit, its tasks run on its device's own Codex login until the " +
  "reset instead of waiting. It never uses another device, and the device's Codex login never leaves the device.";

/** One line on what the fallback does for this agent right now. */
export function codexFallbackStatusText(view: AgentCodexFallbackView, now?: Date): string {
  const device = view.environment?.name ?? "its device";
  if (view.unsupportedReason === "adapter") return "Only a Claude agent can fall back to Codex.";
  if (view.unsupportedReason === "no_device_environment") {
    return "Available when the agent's default environment is a device (Mac Fleet).";
  }
  if (!view.enabled) return `Off: when Claude reaches its usage limit, this agent's tasks wait for the reset.`;
  if (view.codexBlockedUntil) {
    const until = formatResetTime(view.codexBlockedUntil, { now }) ?? "later";
    return view.codexBlockReason === "codex_limit"
      ? `Codex on ${device} is at its own usage limit until ${until}; meanwhile tasks wait for Claude.`
      : `The last Codex run on ${device} failed before Codex answered, so the fallback is off there until ${until}. Check that Codex is installed and signed in on the device.`;
  }
  if (view.active) {
    const until = formatResetTime(view.claudeUntil, { now }) ?? "the reset";
    return `Claude is at its usage limit until ${until}; this agent's tasks run on Codex on ${device} meanwhile.`;
  }
  return `On: if Claude reaches its usage limit, this agent's tasks run on Codex on ${device} until the reset.`;
}

function errorText(error: unknown): string {
  if (error instanceof ApiError && error.message) return error.message;
  return "Could not save the Codex fallback. Try again.";
}

export function AgentCodexFallbackField({ agentId, agentName, now }: { agentId: string; agentName: string; now?: Date }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: aiAccountPoolKeys.codexFallback(agentId),
    queryFn: () => aiAccountPoolApi.getCodexFallback(agentId),
    retry: false,
  });
  const view = query.data ?? null;
  const [model, setModel] = useState("");
  useEffect(() => {
    setModel(view?.model ?? "");
  }, [view?.model]);

  const save = useMutation({
    mutationFn: (input: SetAgentCodexFallback) => aiAccountPoolApi.setCodexFallback(agentId, input),
    onSuccess: (next) => {
      queryClient.setQueryData(aiAccountPoolKeys.codexFallback(agentId), next);
    },
  });

  if (query.isPending) {
    return (
      <Field label="Codex fallback" hint={CODEX_FALLBACK_FIELD_HINT}>
        <p role="status" className="text-sm text-muted-foreground">Loading…</p>
      </Field>
    );
  }
  if (!view) {
    return (
      <Field label="Codex fallback" hint={CODEX_FALLBACK_FIELD_HINT}>
        <p role="alert" className="text-sm text-destructive">Could not load the Codex fallback.</p>
      </Field>
    );
  }

  const supported = view.unsupportedReason === null;
  const disabled = !view.canChange || save.isPending || (!supported && !view.enabled);
  const trimmedModel = model.trim();
  const modelChanged = trimmedModel !== (view.model ?? "");
  const submit = (enabled: boolean) => save.mutate({
    enabled,
    model: trimmedModel || null,
    modelReasoningEffort: view.modelReasoningEffort,
  });

  return (
    <div className="min-w-0 space-y-1.5" data-agent-codex-fallback="">
      <Field label="Codex fallback" hint={CODEX_FALLBACK_FIELD_HINT}>
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <ToggleSwitch
              checked={view.enabled}
              disabled={disabled}
              onCheckedChange={(checked) => submit(checked)}
              aria-label={`Codex fallback for ${agentName}`}
            />
            <span className="text-sm">Use the device's Codex login while Claude is at its limit</span>
            {view.active ? <Badge variant="secondary">Running on Codex</Badge> : null}
          </div>
          {view.enabled && supported ? (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="Codex default model"
                aria-label="Codex model"
                disabled={!view.canChange || save.isPending}
                className="max-w-xs"
              />
              {modelChanged ? (
                <Button type="button" variant="outline" size="sm" disabled={!view.canChange || save.isPending} onClick={() => submit(true)}>
                  Save model
                </Button>
              ) : null}
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground" data-codex-fallback-status="">{codexFallbackStatusText(view, now)}</p>
          {!view.canChange ? <p className="text-xs text-muted-foreground">A company admin changes this.</p> : null}
          {save.error ? <p role="alert" className="text-sm text-destructive">{errorText(save.error)}</p> : null}
        </div>
      </Field>
    </div>
  );
}
