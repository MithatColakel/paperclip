import type { Environment } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { environmentDisplayLabel } from "@/lib/managed-sandbox-environment";
import { selectableEnvironments } from "@/lib/environment-defaults";

/**
 * Picks where an agent or project runs. The empty option inherits
 * (`inheritLabel` names what it resolves to); the other options are the
 * company's selectable environments. A current value that is no longer
 * selectable (archived, or unsupported by the adapter) stays listed so the
 * form shows the truth instead of silently switching.
 */
export function EnvironmentSelect({
  environments,
  value,
  onChange,
  inheritLabel,
  adapterType,
  disabled,
  id,
  className,
  "aria-label": ariaLabel = "Environment",
}: {
  environments: readonly Environment[];
  value: string | null;
  onChange: (environmentId: string | null) => void;
  inheritLabel: string;
  adapterType?: string | null;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
}) {
  const options = selectableEnvironments(environments, adapterType);
  const current = value ? environments.find((environment) => environment.id === value) : null;
  const currentUnavailable = Boolean(value) && !options.some((environment) => environment.id === value);
  return (
    <select
      id={id}
      aria-label={ariaLabel}
      className={cn(
        "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
        className,
      )}
      value={value ?? ""}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value || null)}
    >
      <option value="">{inheritLabel}</option>
      {currentUnavailable && value ? (
        <option value={value}>
          {current ? `${environmentDisplayLabel(current)} (unavailable)` : "Unknown environment"}
        </option>
      ) : null}
      {options.map((environment) => (
        <option key={environment.id} value={environment.id}>
          {environmentDisplayLabel(environment)}
        </option>
      ))}
    </select>
  );
}
