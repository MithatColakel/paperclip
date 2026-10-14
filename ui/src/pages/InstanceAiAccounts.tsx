import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2, UserRoundCog } from "lucide-react";
import {
  AI_ACCOUNT_HOST_KINDS,
  MAX_AI_ACCOUNTS_PER_HOST,
  type AiAccountHostEnvironmentSummary,
  type AiAccountHostKind,
  type AiAccountHostSummary,
  type AiAccountProjectSummary,
  type AiAccountSummary,
} from "@paperclipai/shared";
import { aiAccountHostsApi } from "@/api/ai-account-hosts";
import { ApiError } from "@/api/client";
import { AddAiAccountDialog } from "@/components/ai-accounts/AddAiAccountDialog";
import {
  CREDENTIAL_TYPE_LABELS,
  HOST_KIND_DESCRIPTIONS,
  HOST_KIND_LABELS,
  aiAccountErrorMessage,
  aiAccountState,
  environmentChoicesForHost,
  formatUsageWindow,
  hostAccountLimit,
  hostIsFull,
  limitReasonLabel,
  maskEmail,
  projectChipLabel,
  projectChoicesByCompany,
} from "@/components/ai-accounts/model";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioCardGroup } from "@/components/ui/radio-card";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { formatCents, formatDateTime } from "@/lib/utils";

type AccountAction =
  | { type: "pool"; id: string; poolEnabled: boolean }
  | { type: "activate"; id: string }
  | { type: "clear"; id: string }
  | { type: "remove"; id: string };

function useInvalidateHosts() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.instance.aiAccountHosts });
}

/** Instance settings → Claude accounts: each machine that runs agents and the Claude accounts it uses. */
export function InstanceAiAccounts() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const [addHostOpen, setAddHostOpen] = useState(false);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Claude accounts" },
    ]);
  }, [setBreadcrumbs]);

  const hostsQuery = useQuery({
    queryKey: queryKeys.instance.aiAccountHosts,
    queryFn: () => aiAccountHostsApi.list(),
    retry: false,
    // Limits lift and runs finish on their own; keep the page current.
    refetchInterval: 30_000,
  });

  const header = (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <UserRoundCog className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Claude accounts</h1>
        </div>
        {hostsQuery.data && (
          <Button size="sm" variant="outline" onClick={() => setAddHostOpen(true)}>
            <Plus />
            Add host
          </Button>
        )}
      </div>
      <div className="max-w-3xl space-y-2 text-sm text-muted-foreground">
        <p>
          Each machine that runs agents has its own Claude accounts, at most {MAX_AI_ACCOUNTS_PER_HOST}. Every run on that
          machine uses one of them, spread evenly across the available accounts.
        </p>
        <p>
          When an account reaches its usage limit, it rests until its reset and the run moves to another account of the
          same machine. Mac Fleet Macs are not covered yet.
        </p>
        <p>
          An account can be reserved for projects: their runs use it first, and accounts without projects are shared by
          every other run on the machine.
        </p>
      </div>
    </div>
  );

  if (hostsQuery.isLoading) {
    return (
      <div className="max-w-5xl space-y-6">
        {header}
        <p className="text-sm text-muted-foreground">Loading Claude accounts…</p>
      </div>
    );
  }

  if (hostsQuery.error) {
    const forbidden = hostsQuery.error instanceof ApiError && hostsQuery.error.status === 403;
    return (
      <div className="max-w-5xl space-y-6">
        {header}
        <div className="space-y-3">
          <p role="alert" className="text-sm text-destructive">
            {forbidden
              ? "Instance admin access is required to manage Claude accounts."
              : aiAccountErrorMessage(hostsQuery.error) ?? "Could not load Claude accounts."}
          </p>
          {!forbidden && <Button variant="outline" size="sm" onClick={() => void hostsQuery.refetch()}>Try again</Button>}
        </div>
      </div>
    );
  }

  const data = hostsQuery.data!;
  return (
    <div className="max-w-5xl space-y-6">
      {header}
      {data.hosts.length === 0 ? (
        <Card className="block space-y-2 p-4">
          <p className="text-sm font-medium">No hosts yet</p>
          <p className="text-sm text-muted-foreground">
            Add the Paperclip server first, then any runner server its SSH environments reach.
          </p>
        </Card>
      ) : (
        <div className="space-y-4">
          {data.hosts.map((host) => (
            <HostCard
              key={host.id}
              host={host}
              unmappedEnvironments={data.unmappedEnvironments}
              projects={data.projects}
              maxAccountsPerHost={data.maxAccountsPerHost}
            />
          ))}
        </div>
      )}
      {data.hosts.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Usage shows what Paperclip ran on each account. The official remaining limit is not available for setup tokens;
          it will come from the Macs where the same accounts are signed in.
        </p>
      )}
      {data.unmappedEnvironments.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Not on any host, so runs there keep their own credentials:{" "}
          {data.unmappedEnvironments.map((environment) => environment.name).join(", ")}.
        </p>
      )}
      <AddHostDialog open={addHostOpen} onOpenChange={setAddHostOpen} />
    </div>
  );
}

function HostCard({
  host,
  unmappedEnvironments,
  projects,
  maxAccountsPerHost,
}: {
  host: AiAccountHostSummary;
  unmappedEnvironments: AiAccountHostEnvironmentSummary[];
  projects: AiAccountProjectSummary[];
  maxAccountsPerHost: number;
}) {
  const invalidate = useInvalidateHosts();
  const { companies } = useCompany();
  const [addOpen, setAddOpen] = useState(false);
  const [environmentsOpen, setEnvironmentsOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [removing, setRemoving] = useState<AiAccountSummary | null>(null);
  const [editingProjects, setEditingProjects] = useState<AiAccountSummary | null>(null);

  const accountAction = useMutation({
    mutationFn: async (action: AccountAction): Promise<unknown> => {
      switch (action.type) {
        case "pool":
          return aiAccountHostsApi.updateAccount(action.id, { poolEnabled: action.poolEnabled });
        case "activate":
          return aiAccountHostsApi.updateAccount(action.id, { status: "active" });
        case "clear":
          return aiAccountHostsApi.clearLimit(action.id);
        case "remove":
          return aiAccountHostsApi.deleteAccount(action.id);
      }
    },
    onSettled: () => invalidate(),
  });
  const deleteHost = useMutation({
    mutationFn: () => aiAccountHostsApi.deleteHost(host.id),
    onSuccess: () => invalidate(),
  });
  const setOverflow = useMutation({
    mutationFn: (overflowToOtherAccounts: boolean) => aiAccountHostsApi.updateHost(host.id, { overflowToOtherAccounts }),
    onSettled: () => invalidate(),
  });

  const limit = hostAccountLimit(host, maxAccountsPerHost);
  const full = hostIsFull(host, maxAccountsPerHost);
  const companyName = (companyId: string | null) =>
    companyId ? companies.find((company) => company.id === companyId)?.name ?? null : null;
  const error = aiAccountErrorMessage(accountAction.error ?? deleteHost.error ?? setOverflow.error);
  const resetErrors = () => {
    accountAction.reset();
    deleteHost.reset();
    setOverflow.reset();
  };

  return (
    <Card className="block space-y-4 p-4" aria-label={host.name} role="region">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="truncate text-sm font-semibold">{host.name}</h2>
          <p className="text-xs text-muted-foreground">
            {HOST_KIND_LABELS[host.kind]} · {host.accounts.length} of {limit} accounts
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Rename ${host.name}`} onClick={() => setRenameOpen(true)}>
            <Pencil />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${host.name}`}
            disabled={deleteHost.isPending}
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 />
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Environments</span>
        {host.environments.length === 0 ? (
          <span className="text-xs text-muted-foreground">None yet, so no run uses these accounts.</span>
        ) : (
          host.environments.map((environment) => {
            const company = companyName(environment.companyId);
            return (
              <Badge key={environment.id} variant="outline">
                {environment.name}
                {company ? <span className="text-muted-foreground">· {company}</span> : null}
              </Badge>
            );
          })
        )}
        <Button type="button" variant="ghost" size="xs" onClick={() => setEnvironmentsOpen(true)}>
          Edit environments
        </Button>
      </div>

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <p id={`ai-host-${host.id}-overflow`} className="text-sm">
            Use other accounts on this machine when a project's own accounts are at their limit
          </p>
          <p className="text-xs text-muted-foreground">
            {host.overflowToOtherAccounts
              ? "A project's run moves on to shared accounts, then to other projects' accounts."
              : "Off: a project waits for its own accounts' reset."}
          </p>
        </div>
        <ToggleSwitch
          checked={host.overflowToOtherAccounts}
          disabled={setOverflow.isPending}
          aria-labelledby={`ai-host-${host.id}-overflow`}
          onCheckedChange={(next) => {
            resetErrors();
            setOverflow.mutate(next);
          }}
        />
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {host.accounts.length > 0 ? (
        <ul className="divide-y divide-border rounded-md border border-border">
          {host.accounts.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              busy={accountAction.isPending && accountAction.variables?.id === account.id}
              onAction={(action) => {
                resetErrors();
                accountAction.mutate(action);
              }}
              onRemove={() => setRemoving(account)}
              onEditProjects={() => setEditingProjects(account)}
            />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No accounts yet. Runs on this host keep their own credentials.</p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" variant="outline" disabled={full} onClick={() => setAddOpen(true)}>
          <Plus />
          Add account
        </Button>
        {full && (
          <span className="text-xs text-muted-foreground">This host has {limit} accounts, the most it can have.</span>
        )}
      </div>

      <AddAiAccountDialog host={host} open={addOpen} onOpenChange={setAddOpen} />
      <EditEnvironmentsDialog
        host={host}
        unmappedEnvironments={unmappedEnvironments}
        companyName={companyName}
        open={environmentsOpen}
        onOpenChange={setEnvironmentsOpen}
      />
      <RenameHostDialog host={host} open={renameOpen} onOpenChange={setRenameOpen} />
      <EditProjectsDialog
        hostName={host.name}
        account={editingProjects}
        projects={projects}
        onClose={() => setEditingProjects(null)}
      />

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {host.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {host.accounts.length > 0
                ? `Its ${host.accounts.length === 1 ? "account is" : `${host.accounts.length} accounts are`} deleted too. `
                : ""}
              Runs on its environments go back to their own credentials.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                resetErrors();
                deleteHost.mutate();
              }}
            >
              Remove host
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={removing !== null} onOpenChange={(open) => (open ? undefined : setRemoving(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              {host.name} stops using this account and its stored credential is deleted. Runs already using it are not stopped.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (!removing) return;
                resetErrors();
                accountAction.mutate({ type: "remove", id: removing.id });
              }}
            >
              Remove account
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function AccountStateBadge({ account }: { account: AiAccountSummary }) {
  const state = aiAccountState(account);
  switch (state.kind) {
    case "available":
      return <Badge variant="secondary">Available</Badge>;
    case "limited": {
      const reason = limitReasonLabel(state.reason);
      return (
        <Badge variant="destructive">
          Limited until {formatDateTime(state.until)}
          {reason ? ` (${reason})` : ""}
        </Badge>
      );
    }
    case "auth_failed":
      return <Badge variant="destructive">Sign-in failed</Badge>;
    case "disabled":
      return <Badge variant="outline">Switched off</Badge>;
    case "out_of_pool":
      return <Badge variant="outline">Not in pool</Badge>;
  }
}

function AccountRow({
  account,
  busy,
  onAction,
  onRemove,
  onEditProjects,
}: {
  account: AiAccountSummary;
  busy: boolean;
  onAction: (action: AccountAction) => void;
  onRemove: () => void;
  onEditProjects: () => void;
}) {
  const state = aiAccountState(account);
  const details = [maskEmail(account.emailHint), account.plan].filter(Boolean).join(" · ");
  return (
    <li className="space-y-2 px-3 py-3" aria-label={account.label}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{account.label}</span>
            <Badge variant="outline">{CREDENTIAL_TYPE_LABELS[account.credentialType]}</Badge>
            <AccountStateBadge account={account} />
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {details ? `${details} · ` : ""}
            {account.credentialHint ? <span className="font-mono">{account.credentialHint}</span> : "No hint"}
            {` · Running now: ${account.runningRuns}`}
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          In pool
          <ToggleSwitch
            checked={account.poolEnabled}
            disabled={busy}
            aria-label={`Use ${account.label} in the pool`}
            onCheckedChange={(poolEnabled) => onAction({ type: "pool", id: account.id, poolEnabled })}
          />
        </label>
        <div className="flex items-center gap-1">
          {state.kind === "limited" && (
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => onAction({ type: "clear", id: account.id })}>
              Clear limit
            </Button>
          )}
          {(state.kind === "auth_failed" || state.kind === "disabled") && (
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => onAction({ type: "activate", id: account.id })}>
              Set active again
            </Button>
          )}
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onRemove}>
            Remove
          </Button>
        </div>
      </div>
      {state.kind === "auth_failed" && state.message && (
        <p className="text-xs text-destructive">{state.message}</p>
      )}
      <AccountUsage account={account} />
      <div className="flex flex-wrap items-center gap-2" data-testid="account-projects">
        <span className="text-xs text-muted-foreground">Projects</span>
        {account.projects.length === 0 ? (
          <span className="text-xs">Shared (any project)</span>
        ) : (
          account.projects.map((project) => (
            <Badge key={project.id} variant="outline" title={project.companyName}>
              {projectChipLabel(project)}
            </Badge>
          ))
        )}
        <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={onEditProjects}>
          Edit projects
        </Button>
      </div>
    </li>
  );
}

function EditProjectsDialog({
  hostName,
  account,
  projects,
  onClose,
}: {
  hostName: string;
  account: AiAccountSummary | null;
  projects: AiAccountProjectSummary[];
  onClose: () => void;
}) {
  return (
    <Dialog open={account !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        {account && <EditProjectsForm hostName={hostName} account={account} projects={projects} onDone={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function EditProjectsForm({
  hostName,
  account,
  projects,
  onDone,
}: {
  hostName: string;
  account: AiAccountSummary;
  projects: AiAccountProjectSummary[];
  onDone: () => void;
}) {
  const invalidate = useInvalidateHosts();
  // Seeded once per opening; background refreshes do not undo the operator's picks.
  const [selected, setSelected] = useState<Set<string>>(() => new Set(account.projects.map((project) => project.id)));
  const [groups] = useState(() => projectChoicesByCompany(projects, account.projects));
  const save = useMutation({
    mutationFn: () => aiAccountHostsApi.setAccountProjects(account.id, [...selected]),
    onSuccess: async () => {
      await invalidate();
      onDone();
    },
  });
  const error = aiAccountErrorMessage(save.error);
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
      <DialogHeader>
        <DialogTitle>Projects for {account.label}</DialogTitle>
        <DialogDescription>
          Runs of these projects use this account first. With nothing selected, the account is shared by every run on{" "}
          {hostName}.
        </DialogDescription>
      </DialogHeader>
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">There are no active projects on this Paperclip.</p>
      ) : (
        <div className="max-h-80 space-y-3 overflow-y-auto">
          {groups.map((group) => (
            <fieldset key={group.companyId} className="space-y-1">
              <legend className="text-xs font-medium text-muted-foreground">{group.companyName}</legend>
              <ul className="divide-y divide-border rounded-md border border-border">
                {group.projects.map((project) => {
                  const id = `ai-account-${account.id}-project-${project.id}`;
                  return (
                    <li key={project.id} className="flex items-center gap-3 px-3 py-2">
                      <Checkbox
                        id={id}
                        checked={selected.has(project.id)}
                        disabled={save.isPending}
                        onCheckedChange={(checked) => toggle(project.id, checked === true)}
                      />
                      <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer truncate text-sm">
                        {projectChipLabel(project)}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </fieldset>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {selected.size === 0
          ? "Nothing selected: this account is shared (any project)."
          : `Reserved for ${selected.size === 1 ? "1 project" : `${selected.size} projects`}.`}
      </p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter className="sm:items-center sm:justify-between">
        <Button type="button" variant="outline" onClick={onDone} disabled={save.isPending}>
          Cancel
        </Button>
        <Button type="button" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save projects"}
        </Button>
      </DialogFooter>
    </>
  );
}

/** Paperclip's own use of the account; money only for API keys, which are billed per use. */
function AccountUsage({ account }: { account: AiAccountSummary }) {
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
    </div>
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
  const invalidate = useInvalidateHosts();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<AiAccountHostKind>("server");
  const create = useMutation({
    mutationFn: () => aiAccountHostsApi.createHost({ name: name.trim(), kind }),
    onSuccess: async () => {
      await invalidate();
      onDone();
    },
  });
  const error = aiAccountErrorMessage(create.error);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() && !create.isPending) create.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>Add a host</DialogTitle>
        <DialogDescription>A machine that runs agents. Choose its environments after adding it.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-2">
        <Label htmlFor="ai-host-name">Name</Label>
        <Input
          id="ai-host-name"
          value={name}
          maxLength={80}
          placeholder="Paperclip server"
          disabled={create.isPending}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="grid gap-2">
        <span className="text-sm font-medium">Kind</span>
        <RadioCardGroup
          ariaLabel="Host kind"
          value={kind}
          onValueChange={(next) => setKind(next as AiAccountHostKind)}
          disabled={create.isPending}
          options={AI_ACCOUNT_HOST_KINDS.map((value) => ({
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
          {create.isPending ? "Adding…" : "Add host"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function RenameHostDialog({
  host,
  open,
  onOpenChange,
}: {
  host: AiAccountHostSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>{open && <RenameHostForm host={host} onDone={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  );
}

function RenameHostForm({ host, onDone }: { host: AiAccountHostSummary; onDone: () => void }) {
  const invalidate = useInvalidateHosts();
  const [name, setName] = useState(host.name);
  const rename = useMutation({
    mutationFn: () => aiAccountHostsApi.updateHost(host.id, { name: name.trim() }),
    onSuccess: async () => {
      await invalidate();
      onDone();
    },
  });
  const error = aiAccountErrorMessage(rename.error);
  const canSave = Boolean(name.trim()) && name.trim() !== host.name && !rename.isPending;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) rename.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>Rename {host.name}</DialogTitle>
        <DialogDescription>{HOST_KIND_LABELS[host.kind]}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-2">
        <Label htmlFor={`ai-host-rename-${host.id}`}>Name</Label>
        <Input
          id={`ai-host-rename-${host.id}`}
          value={name}
          maxLength={80}
          disabled={rename.isPending}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter className="sm:items-center sm:justify-between">
        <Button type="button" variant="outline" onClick={onDone} disabled={rename.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSave}>
          {rename.isPending ? "Saving…" : "Save name"}
        </Button>
      </DialogFooter>
    </form>
  );
}

type EnvironmentsDialogProps = {
  host: AiAccountHostSummary;
  unmappedEnvironments: AiAccountHostEnvironmentSummary[];
  companyName: (companyId: string | null) => string | null;
};

function EditEnvironmentsDialog({
  open,
  onOpenChange,
  ...props
}: EnvironmentsDialogProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>{open && <EditEnvironmentsForm {...props} onDone={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  );
}

function EditEnvironmentsForm({
  host,
  unmappedEnvironments,
  companyName,
  onDone,
}: EnvironmentsDialogProps & { onDone: () => void }) {
  const invalidate = useInvalidateHosts();
  // Seeded once per opening; background refreshes do not undo the operator's picks.
  const [selected, setSelected] = useState<Set<string>>(() => new Set(host.environments.map((environment) => environment.id)));
  const [choices] = useState(() => environmentChoicesForHost(host, unmappedEnvironments));
  const save = useMutation({
    mutationFn: () => aiAccountHostsApi.setEnvironments(host.id, [...selected]),
    onSuccess: async () => {
      await invalidate();
      onDone();
    },
  });
  const error = aiAccountErrorMessage(save.error);
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
      <DialogHeader>
        <DialogTitle>Environments on {host.name}</DialogTitle>
        <DialogDescription>
          Runs in these environments use this host's accounts.{" "}
          {host.kind === "server" ? "A Paperclip server takes Local environments." : "This host takes SSH environments."}
        </DialogDescription>
      </DialogHeader>
      {choices.length === 0 ? (
        <p className="text-sm text-muted-foreground">No free environment fits this host.</p>
      ) : (
        <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-md border border-border">
          {choices.map((environment) => {
            const company = companyName(environment.companyId);
            const id = `ai-host-${host.id}-env-${environment.id}`;
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
                    {[environment.driver === "local" ? "Local" : "SSH", company].filter(Boolean).join(" · ")}
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
        <Button type="button" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save environments"}
        </Button>
      </DialogFooter>
    </>
  );
}
