import { Check, KeyRound, Laptop } from "lucide-react";
import { cn, formatDateTime } from "@/lib/utils";
import { OnboardingCardField } from "../AdapterLoginChrome";
import type { MacClaudeToken } from "./useMacClaudeToken";

export type ClaudeTokenSource = "mac" | "token";

const SOURCES: Array<{ id: ClaudeTokenSource; label: string; description: string; icon: typeof Laptop }> = [
  { id: "mac", label: "From a Mac", description: "The Mac's owner approves and its Claude account comes back.", icon: Laptop },
  { id: "token", label: "Enter token", description: "Paste the output of claude setup-token.", icon: KeyRound },
];

function deviceDetail(device: MacClaudeToken["devices"][number]) {
  const plan = device.claude?.subscriptionType ? `Claude ${device.claude.subscriptionType[0]!.toUpperCase()}${device.claude.subscriptionType.slice(1)}` : device.claude?.loggedIn ? "Claude" : "No Claude sign-in";
  return [plan, device.claude?.emailMasked, device.online ? "online" : "offline"].filter(Boolean).join(" · ");
}

/**
 * Where a Claude subscription token comes from: one of this company's Macs
 * (its owner approves and runs `claude setup-token` there) or a pasted token.
 * The two big choices sit on top; the picked one opens its section below.
 */
export function ClaudeTokenSourcePicker({
  source,
  onSourceChange,
  mac,
  token,
  onTokenChange,
  onSubmit,
  disabled,
}: {
  source: ClaudeTokenSource | null;
  onSourceChange: (source: ClaudeTokenSource) => void;
  mac: MacClaudeToken;
  token: string;
  onTokenChange: (value: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
}) {
  const waiting = mac.status === "requesting" || mac.status === "pending" || mac.status === "collecting";
  return (
    <div className="flex flex-col gap-4">
      <div role="radiogroup" aria-label="Token source" className="flex gap-3">
        {SOURCES.map(({ id, label, description, icon: Icon }) => {
          const unavailable = id === "mac" && !mac.loading && !mac.available;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={source === id}
              disabled={disabled || waiting || unavailable}
              onClick={() => onSourceChange(id)}
              className={cn(
                "flex min-w-0 flex-1 cursor-pointer flex-col items-start gap-1.5 rounded-md border p-4 text-left",
                "transition-(--tp-border-color-background-color) duration-(--motion-duration-fast) ease-(--motion-ease-standard)",
                "outline-none focus-visible:ring-ring/50 focus-visible:ring-(length:--rad-3)",
                "disabled:cursor-default disabled:opacity-50",
                source === id ? "border-foreground/40 bg-accent" : "border-border bg-card hover:bg-accent/40",
              )}
            >
              <Icon className="size-5 text-muted-foreground" aria-hidden />
              <span className="text-sm font-medium text-foreground">{label}</span>
              <span className="text-xs text-muted-foreground">
                {unavailable ? "Mac Fleet is not installed on this Paperclip." : description}
              </span>
            </button>
          );
        })}
      </div>

      {source === "mac" && (
        <div className="flex flex-col gap-2">
          {mac.devicesError ? (
            <p role="alert" className="text-sm text-destructive">Could not load this company's Macs. Try again.</p>
          ) : mac.devices.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {mac.loading ? "Loading Macs…" : "No Mac is enrolled in this company yet. Enroll one in Mac Fleet, or enter a token."}
            </p>
          ) : (
            <div role="listbox" aria-label="Macs" className="divide-y divide-border overflow-hidden rounded-md border border-border">
              {mac.devices.map((device) => {
                const selected = mac.deviceId === device.id;
                return (
                  <button
                    key={device.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    disabled={disabled || waiting || !device.online}
                    onClick={() => mac.selectDevice(device.id)}
                    className={cn(
                      "flex w-full items-center gap-3 px-3 py-2 text-left",
                      "outline-none focus-visible:bg-accent/50 disabled:cursor-default disabled:opacity-50",
                      selected ? "bg-accent" : "hover:bg-accent/40",
                    )}
                  >
                    <Laptop className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{device.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{deviceDetail(device)}</span>
                    </span>
                    {selected && <Check className="size-4 shrink-0 text-foreground" aria-hidden />}
                  </button>
                );
              })}
            </div>
          )}
          {waiting && (
            <p role="status" className="text-sm text-muted-foreground">
              {mac.status === "collecting"
                ? "Receiving the token…"
                : `Waiting for approval on the Mac${mac.expiresAt ? ` until ${formatDateTime(mac.expiresAt)}` : ""}. Its owner gets a prompt in Paperclip Mac Agent.`}
            </p>
          )}
          {mac.status === "declined" && <p role="alert" className="text-sm text-destructive">The Mac's owner declined the request.</p>}
          {mac.status === "expired" && <p role="alert" className="text-sm text-destructive">The request expired before the Mac answered. Try again.</p>}
          {mac.status === "failed" && mac.error && <p role="alert" className="text-sm text-destructive">{mac.error}</p>}
        </div>
      )}

      {source === "token" && (
        <div className="flex flex-col gap-2">
          <OnboardingCardField
            label="Setup token"
            masked
            autoFocus
            value={token}
            placeholder="sk-ant-oat01-…"
            onChange={onTokenChange}
            onSubmit={onSubmit}
            disabled={disabled}
          />
          <p className="text-xs text-muted-foreground">
            On any computer signed in to the Claude account, run <code>claude setup-token</code> and paste the token. Paperclip stores it encrypted.
          </p>
        </div>
      )}
    </div>
  );
}
