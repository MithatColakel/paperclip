import { useMemo } from "react";
import type { CompanyAiAccountOption, SetAgentAiAccount } from "@paperclipai/shared";
import { SearchableSelect } from "@/components/SearchableSelect";
import { Badge } from "@/components/ui/badge";
import {
  AI_ACCOUNT_BINDING_STATE_TEXT,
  POOL_BADGE_TONE_CLASS,
  POOL_CREDENTIAL_TYPE_LABELS,
  accountSelectKey,
  accountSelectSelection,
  buildAccountSelectGroups,
  type AccountSelectOption,
  type AccountSelectValue,
  type AiAccountStateDisplay,
} from "@/lib/ai-account-pool";
import { cn } from "@/lib/utils";

/** Fork: an account's state as a badge (`Active`, `Limited until 18:00`, `Signed out`, …). */
export function AiAccountStateBadge({ display, className }: { display: AiAccountStateDisplay; className?: string }) {
  return (
    <Badge
      variant="outline"
      data-account-state={display.state}
      className={cn("font-normal", POOL_BADGE_TONE_CLASS[display.tone], className)}
    >
      {display.label}
    </Badge>
  );
}

function AccountOptionRow({ option }: { option: AccountSelectOption }) {
  const account = option.account;
  const meta = account
    ? [option.ownerText, account.plan, POOL_CREDENTIAL_TYPE_LABELS[account.credentialType]].filter(Boolean).join(" · ")
    : "Whatever login the device already has. It does not count toward the device's Claude accounts.";
  return (
    <span
      className="flex min-w-0 flex-1 flex-col gap-0.5"
      data-account-option={account?.id ?? "device-login"}
      data-disabled-reason={option.disabledReason ?? undefined}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate">{option.label}</span>
        {option.stateDisplay ? <AiAccountStateBadge display={option.stateDisplay} /> : null}
      </span>
      <span className="truncate text-xs text-muted-foreground">{meta}</span>
      {option.disabledReason ? (
        <span className="text-xs text-muted-foreground">{option.disabledReason}</span>
      ) : option.warning ? (
        <span className="text-xs text-amber-700 dark:text-amber-300">{option.warning}</span>
      ) : null}
    </span>
  );
}

export interface AccountSelectProps {
  /** Accounts eligible in the agent's company (`GET /companies/:id/ai-accounts?agentId=`). */
  options: readonly CompanyAiAccountOption[];
  /** The caller is a company admin and may choose any eligible account. */
  canBindAny: boolean;
  value: AccountSelectValue;
  /** Receives the body for `PUT /agents/:id/ai-account`. */
  onChange: (selection: SetAgentAiAccount) => void;
  /** Also offer the device's own login. */
  includeDeviceLogin?: boolean;
  /**
   * The caller may switch the agent to the device's own login; defaults to
   * `canBindAny`. For a caller who is not a company admin, pass
   * `canChooseDeviceLogin({ canBindAny, binding })`: an owner may do it only
   * while the agent is bound to one of their own accounts.
   */
  canSetDeviceLogin?: boolean;
  disabled?: boolean;
  loading?: boolean;
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
  disablePortal?: boolean;
  now?: Date;
}

/**
 * Fork: picks an agent's Claude account. Accounts already on the agent's
 * device come first (they take no new slot), then the others; each shows its
 * state, and an account or a device login this caller cannot choose stays
 * visible with the reason. Company admins may choose any eligible account;
 * everyone else only their own. The server stays authoritative.
 */
export function AccountSelect({
  options,
  canBindAny,
  value,
  onChange,
  includeDeviceLogin = false,
  canSetDeviceLogin,
  disabled = false,
  loading = false,
  placeholder = "Choose a Claude account",
  className,
  "aria-label": ariaLabel = "Claude account",
  disablePortal,
  now,
}: AccountSelectProps) {
  const groups = useMemo(
    () => buildAccountSelectGroups({ options, canBindAny, includeDeviceLogin, canSetDeviceLogin, now }),
    [canBindAny, canSetDeviceLogin, includeDeviceLogin, now, options],
  );
  const selectedKey = accountSelectKey(value);
  const knownSelection = selectedKey !== "" && groups.some((group) => group.options.some((option) => option.value === selectedKey));
  const fallbackLabel = value?.mode === "pool_account"
    ? value.accountId && !knownSelection
      ? AI_ACCOUNT_BINDING_STATE_TEXT.account_unavailable
      : "No account chosen"
    : placeholder;

  return (
    <SearchableSelect<string, AccountSelectOption>
      value={selectedKey}
      groups={groups}
      onValueChange={(next) => {
        const selection = accountSelectSelection(next);
        if (selection) onChange(selection);
      }}
      placeholder={placeholder}
      searchPlaceholder="Search accounts..."
      emptyMessage="No Claude account is available in this company yet."
      loading={loading}
      loadingMessage="Loading accounts..."
      disabled={disabled}
      className={className}
      triggerAriaLabel={ariaLabel}
      mobileTitle="Claude account"
      disablePortal={disablePortal}
      renderValue={(option) =>
        option ? (
          <span className="inline-flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate">{option.label}</span>
            {option.stateDisplay && option.stateDisplay.state !== "active" ? (
              <AiAccountStateBadge display={option.stateDisplay} />
            ) : null}
          </span>
        ) : (
          fallbackLabel
        )
      }
      renderOption={(option) => <AccountOptionRow option={option} />}
    />
  );
}
