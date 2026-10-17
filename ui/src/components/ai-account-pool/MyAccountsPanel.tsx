import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AiAccountInUseErrorDetails, AiAccountUsedByAgent, MyAiAccount, UpdateMyAiAccount } from "@paperclipai/shared";
import { aiAccountPoolApi, invalidateAiAccountPoolQueries } from "@/api/ai-account-pool";
import { formatUsageWindow, projectChipLabel } from "@/components/ai-accounts/model";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  POOL_CREDENTIAL_TYPE_LABELS,
  aiAccountPoolErrorMessage,
  aiAccountStateDisplay,
  formatResetTime,
  isEstimatedSource,
  maskEmail,
  readAiAccountPoolError,
} from "@/lib/ai-account-pool";
import { cn, formatCents, formatDateTime, relativeTime } from "@/lib/utils";
import { AiAccountStateBadge } from "./AccountSelect";
import {
  PoolCredentialField,
  cleanCredentialValue,
  credentialValueReady,
  poolCredentialErrorMessage,
} from "./AddPoolAccountDialog";

type AccountAction =
  | { type: "status"; status: "active" | "disabled" }
  | { type: "clear-limit" }
  | { type: "clear-restriction" };

type AccountDialog = "edit" | "replace" | "pause" | "remove";

type NoteTone = "danger" | "warning" | "muted";

const NOTE_TONE_CLASS: Record<NoteTone, string> = {
  danger: "text-destructive",
  warning: "text-amber-700 dark:text-amber-300",
  muted: "text-muted-foreground",
};

/** Server text quoted inside a sentence, without its own final stop. */
function quoted(text: string | null): string | null {
  const trimmed = text?.trim().replace(/[.\s]+$/, "");
  return trimmed ? trimmed : null;
}

function credentialNoun(account: Pick<MyAiAccount, "credentialType">): "token" | "key" {
  return account.credentialType === "api_key" ? "key" : "token";
}

function agentsInMyCompanies(account: MyAiAccount): number {
  return account.usedBy.reduce((total, company) => total + company.agents.length, 0);
}

function inUse(account: MyAiAccount): boolean {
  return agentsInMyCompanies(account) > 0 || account.otherCompanies > 0;
}

function otherCompaniesText(count: number): string {
  return count === 1 ? "Agents in 1 other company" : `Agents in ${count} other companies`;
}

function usedByAgentText(agent: AiAccountUsedByAgent): string {
  const devices = agent.devices.map((device) => device.name);
  return devices.length > 0 ? `${agent.agentName} (${devices.join(", ")})` : agent.agentName;
}

/** What the account's state means for its tasks, and the fix. */
function accountStateNote(account: MyAiAccount, now?: Date): { text: string; tone: NoteTone } | null {
  switch (account.state) {
    case "admin_disabled": {
      const reason = quoted(account.adminDisabledReason);
      return {
        text: `An instance admin disabled this account${reason ? `: ${reason}` : ""}. Only an instance admin can turn it back on; its tasks wait until then.`,
        tone: "danger",
      };
    }
    case "signed_out": {
      const message = quoted(account.statusMessage);
      return {
        text: `Signed out${message ? `: ${message}` : ""}. Replace the ${credentialNoun(account)} to use it again; its tasks wait until then.`,
        tone: "danger",
      };
    }
    case "withdrawn":
      return { text: "Paused. Agents assigned to it wait until you resume it.", tone: "muted" };
    case "limited": {
      if (account.limitReason === "credit_balance") {
        return { text: "Out of API credit. Its tasks wait; add credit, then clear the limit.", tone: "warning" };
      }
      const until = formatResetTime(account.exhaustedUntil, { now, estimated: isEstimatedSource(account.limitSource) });
      return {
        text: until ? `At its usage limit until ${until}. Its tasks wait for the reset.` : "At its usage limit. Its tasks wait for the reset.",
        tone: "warning",
      };
    }
    case "active":
      return null;
  }
}

/**
 * Fork: the signed-in user's own Claude accounts on the Claude accounts page.
 * Each card shows the state, where the account is used and Paperclip's own
 * usage, with the owner's actions: edit, replace the token, pause or resume,
 * clear a limit or the project reservation, and remove. A signed-out account
 * offers no pause: replacing its token or removing it are its fixes.
 */
export function MyAccountsPanel({ accounts, now }: { accounts: readonly MyAiAccount[]; now?: Date }) {
  return (
    <ul className="divide-y divide-border">
      {accounts.map((account) => (
        <MyAccountCard key={account.id} account={account} now={now} />
      ))}
    </ul>
  );
}

function MyAccountCard({ account, now }: { account: MyAiAccount; now?: Date }) {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<AccountDialog | null>(null);
  const action = useMutation({
    mutationFn: (next: AccountAction): Promise<unknown> => {
      switch (next.type) {
        case "status":
          return aiAccountPoolApi.update(account.id, { status: next.status });
        case "clear-limit":
          return aiAccountPoolApi.clearLimit(account.id);
        case "clear-restriction":
          return aiAccountPoolApi.update(account.id, { clearProjectRestriction: true });
      }
    },
    onSettled: () => invalidateAiAccountPoolQueries(queryClient),
  });

  function run(next: AccountAction) {
    action.reset();
    action.mutate(next);
  }

  const display = aiAccountStateDisplay(account, now);
  const note = accountStateNote(account, now);
  const details = [maskEmail(account.emailHint), account.plan].filter(Boolean).join(" · ");
  const busy = action.isPending;
  const error = action.error ? aiAccountPoolErrorMessage(action.error) : null;

  return (
    <li aria-label={account.label} className="space-y-3 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{account.label}</span>
            <Badge variant="outline">{POOL_CREDENTIAL_TYPE_LABELS[account.credentialType]}</Badge>
            <AiAccountStateBadge display={display} />
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {details ? `${details} · ` : ""}
            {account.credentialHint ? <span className="font-mono">{account.credentialHint}</span> : "No hint"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {display.state === "limited" && (
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => run({ type: "clear-limit" })}>
              Clear limit
            </Button>
          )}
          {/* A signed-out account is neither paused nor resumed: a new token or removal is its fix. */}
          {account.status === "auth_failed" ? null : account.status === "disabled" ? (
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => run({ type: "status", status: "active" })}>
              Resume
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => (inUse(account) ? setDialog("pause") : run({ type: "status", status: "disabled" }))}
            >
              Pause
            </Button>
          )}
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setDialog("replace")}>
            Replace {credentialNoun(account)}
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setDialog("edit")}>
            Edit
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setDialog("remove")}>
            Remove
          </Button>
        </div>
      </div>

      {note && <p className={cn("text-xs", NOTE_TONE_CLASS[note.tone])}>{note.text}</p>}

      {account.reservedProjects.length > 0 && (
        <div className="space-y-1" data-testid="account-restriction">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Reserved for</span>
            {account.reservedProjects.map((project) => (
              <Badge key={project.id} variant="outline" title={project.companyName}>
                {projectChipLabel(project)}
              </Badge>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={busy}
              aria-label={`Clear the project reservation of ${account.label}`}
              onClick={() => run({ type: "clear-restriction" })}
            >
              Clear
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            It runs only in companies that own one of these projects. Clear the reservation to use it in all your companies.
          </p>
        </div>
      )}

      <AccountUsedBy account={account} />
      <AccountUsage account={account} />

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <EditAccountDialog account={account} open={dialog === "edit"} onOpenChange={(open) => setDialog(open ? "edit" : null)} />
      <ReplaceCredentialDialog
        account={account}
        open={dialog === "replace"}
        onOpenChange={(open) => setDialog(open ? "replace" : null)}
      />
      <AlertDialog open={dialog === "pause"} onOpenChange={(open) => setDialog(open ? "pause" : null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Pause {account.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              Agents assigned to it stop starting new runs and wait until you resume it. Runs already in progress finish.
              Paperclip does not move their tasks to another account.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              type="button"
              onClick={() => {
                setDialog(null);
                run({ type: "status", status: "disabled" });
              }}
            >
              Pause account
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <RemoveAccountDialog
        account={account}
        open={dialog === "remove"}
        onOpenChange={(open) => setDialog(open ? "remove" : null)}
      />
    </li>
  );
}

/** Where the account is used: agents in the caller's companies, other companies as a count only. */
function AccountUsedBy({ account }: { account: MyAiAccount }) {
  const companies = account.usedBy.filter((company) => company.agents.length > 0);
  if (companies.length === 0 && account.otherCompanies === 0) {
    return <p className="text-xs text-muted-foreground">No agent uses it yet.</p>;
  }
  return (
    <div className="space-y-0.5 text-xs" data-testid="account-used-by">
      <p className="text-muted-foreground">Used by</p>
      <ul className="space-y-0.5">
        {companies.map((company) => (
          <li key={company.companyId}>
            <span className="font-medium">{company.companyName}</span>: {company.agents.map(usedByAgentText).join(", ")}
          </li>
        ))}
        {account.otherCompanies > 0 && <li className="text-muted-foreground">{otherCompaniesText(account.otherCompanies)}</li>}
      </ul>
    </div>
  );
}

/** Paperclip's own use of the account; money only for API keys, which are billed per use. */
function AccountUsage({ account }: { account: MyAiAccount }) {
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
      {account.credentialType === "api_key" && (
        <p>
          This month: <span className="font-mono">{formatCents(account.usage.thisMonth.costCents)}</span>
        </p>
      )}
      {account.lastLimitedAt && <p>Last limit: {formatDateTime(account.lastLimitedAt)}</p>}
      {account.lastUsedAt && <p>Last used {relativeTime(account.lastUsedAt)}</p>}
    </div>
  );
}

function EditAccountDialog({
  account,
  open,
  onOpenChange,
}: {
  account: MyAiAccount;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>{open && <EditAccountForm account={account} onDone={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  );
}

function EditAccountForm({ account, onDone }: { account: MyAiAccount; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState(account.label);
  const [email, setEmail] = useState(account.emailHint ?? "");
  const [plan, setPlan] = useState(account.plan ?? "");
  const save = useMutation({
    mutationFn: (input: UpdateMyAiAccount) => aiAccountPoolApi.update(account.id, input),
    onSuccess: () => onDone(),
    onSettled: () => invalidateAiAccountPoolQueries(queryClient),
  });

  const changes: UpdateMyAiAccount = {};
  if (label.trim() !== account.label) changes.label = label.trim();
  if ((email.trim() || null) !== (account.emailHint ?? null)) changes.emailHint = email.trim() || null;
  if ((plan.trim() || null) !== (account.plan ?? null)) changes.plan = plan.trim() || null;
  const canSave = label.trim().length > 0 && Object.keys(changes).length > 0 && !save.isPending;
  // E-mail hints are unique per owner, so a duplicate here is another account of yours.
  const error = !save.error
    ? null
    : readAiAccountPoolError(save.error)?.code === "ai_account_duplicate"
      ? "You already have a Claude account with this e-mail."
      : aiAccountPoolErrorMessage(save.error);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) save.mutate(changes);
      }}
    >
      <DialogHeader>
        <DialogTitle>Edit {account.label}</DialogTitle>
        <DialogDescription>Only you see the full e-mail; others see it masked.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-2 sm:col-span-2">
          <Label htmlFor={`pool-account-${account.id}-label`}>Name</Label>
          <Input
            id={`pool-account-${account.id}-label`}
            value={label}
            maxLength={80}
            disabled={save.isPending}
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`pool-account-${account.id}-plan`}>Plan (optional)</Label>
          <Input
            id={`pool-account-${account.id}-plan`}
            value={plan}
            maxLength={40}
            disabled={save.isPending}
            onChange={(event) => setPlan(event.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`pool-account-${account.id}-email`}>Email (optional)</Label>
          <Input
            id={`pool-account-${account.id}-email`}
            inputMode="email"
            autoComplete="off"
            value={email}
            maxLength={200}
            disabled={save.isPending}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter className="sm:items-center sm:justify-between">
        <Button type="button" variant="outline" onClick={onDone} disabled={save.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSave}>
          {save.isPending ? "Saving…" : "Save changes"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function ReplaceCredentialDialog({
  account,
  open,
  onOpenChange,
}: {
  account: MyAiAccount;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Mounted only while open, so closing forgets the pasted value. */}
      <DialogContent>{open && <ReplaceCredentialForm account={account} onDone={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  );
}

function ReplaceCredentialForm({ account, onDone }: { account: MyAiAccount; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState("");
  const [cleared, setCleared] = useState(false);
  // The value reaches the request through this ref, never through mutation variables.
  const pendingValue = useRef<string | null>(null);
  const replace = useMutation({
    mutationFn: () => {
      const next = pendingValue.current ?? "";
      pendingValue.current = null;
      return aiAccountPoolApi.replaceCredential(account.id, { value: next });
    },
    onSuccess: () => onDone(),
    onSettled: () => invalidateAiAccountPoolQueries(queryClient),
  });
  const pasted = cleanCredentialValue(value);
  const canSubmit = credentialValueReady(pasted, account.credentialType) && !replace.isPending;
  const noun = credentialNoun(account);
  const error = poolCredentialErrorMessage(replace.error);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        replace.reset();
        pendingValue.current = pasted;
        setValue("");
        setCleared(true);
        replace.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>Replace the {noun} of {account.label}</DialogTitle>
        <DialogDescription>
          {account.credentialType === "api_key"
            ? "Paste a new Claude Console API key."
            : "Paste a new token from claude setup-token."}{" "}
          The account keeps its name and assignments, becomes active again, and tasks waiting on it start again.
        </DialogDescription>
      </DialogHeader>
      <PoolCredentialField
        id={`pool-account-${account.id}-value`}
        credentialType={account.credentialType}
        label={account.credentialType === "api_key" ? "New API key" : "New setup token"}
        value={value}
        onChange={setValue}
        disabled={replace.isPending}
        cleared={cleared && replace.isError}
      />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter className="sm:items-center sm:justify-between">
        <Button type="button" variant="outline" onClick={onDone} disabled={replace.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSubmit}>
          {replace.isPending ? "Saving…" : `Replace ${noun}`}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Removing an account its agents use releases them: they wait until someone chooses another account. */
function RemoveAccountDialog({
  account,
  open,
  onOpenChange,
}: {
  account: MyAiAccount;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: (release: boolean) => aiAccountPoolApi.remove(account.id, { release }),
    onSuccess: () => onOpenChange(false),
    onSettled: () => invalidateAiAccountPoolQueries(queryClient),
  });
  const info = readAiAccountPoolError(remove.error);
  // The server knows of agents this page did not show yet.
  const conflict = info?.code === "ai_account_in_use" ? (info.details as Partial<AiAccountInUseErrorDetails> | null) : null;
  const release = inUse(account) || conflict !== null;
  const companies = account.usedBy.filter((company) => company.agents.length > 0);
  const conflictBindings = Array.isArray(conflict?.bindings) ? conflict.bindings : [];

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (remove.isPending) return;
        if (!next) remove.reset();
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {account.label}?</AlertDialogTitle>
          <AlertDialogDescription>
            {release
              ? "Its stored credential is deleted. The agents below stop using it and wait until someone chooses another account for them. Runs already in progress finish."
              : "Its stored credential is deleted. No agent uses it."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {release && (
          <ul className="space-y-0.5 text-sm" data-testid="remove-account-bindings">
            {companies.map((company) => (
              <li key={company.companyId}>
                <span className="font-medium">{company.companyName}</span>: {company.agents.map((agent) => agent.agentName).join(", ")}
              </li>
            ))}
            {conflictBindings
              .filter((binding) => !companies.some((company) => company.agents.some((agent) => agent.agentId === binding.agentId)))
              .map((binding) => (
                <li key={binding.agentId}>
                  <span className="font-medium">{binding.companyName}</span>: {binding.agentName}
                </li>
              ))}
            {Math.max(account.otherCompanies, conflict?.otherCompanies ?? 0) > 0 && (
              <li className="text-muted-foreground">
                {otherCompaniesText(Math.max(account.otherCompanies, conflict?.otherCompanies ?? 0))}
              </li>
            )}
          </ul>
        )}
        {remove.error && !conflict && (
          <p role="alert" className="text-sm text-destructive">{aiAccountPoolErrorMessage(remove.error)}</p>
        )}
        {conflict && (
          <p role="alert" className="text-sm text-destructive">
            Agents still use this account. Remove it and release them to continue.
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
          <Button type="button" variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate(release)}>
            {remove.isPending ? "Removing…" : release ? "Remove and release agents" : "Remove account"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
