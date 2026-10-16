import { useRef, useState } from "react";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { ClipboardPaste, Server, UserRound } from "lucide-react";
import {
  AI_ACCOUNT_CREDENTIAL_PREFIXES,
  AI_ACCOUNT_ENV_KEY,
  type AiAccountCredentialType,
  type CreateMyAiAccount,
} from "@paperclipai/shared";
import { aiAccountPoolApi, invalidateAiAccountPoolQueries } from "@/api/ai-account-pool";
import { aiConnectionsApi } from "@/api/ai-connections";
import { importableConnections } from "@/components/ai-accounts/model";
import { AI_CONNECTION_STATUS } from "@/components/ai-connections/model";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioCardGroup, type RadioCardOption } from "@/components/ui/radio-card";
import { useCompany } from "@/context/CompanyContext";
import { useIsInstanceAdmin } from "@/hooks/useIsInstanceAdmin";
import { aiAccountPoolErrorMessage, readAiAccountPoolError } from "@/lib/ai-account-pool";

// ---------------------------------------------------------------------------
// Credential field, shared with the replace-token dialog
// ---------------------------------------------------------------------------

/** The server refuses shorter values. */
const MIN_CREDENTIAL_LENGTH = 20;

/** Terminals wrap long tokens; a credential never contains whitespace, so it is dropped. */
export function cleanCredentialValue(value: string): string {
  return value.replace(/\s+/g, "");
}

/** What is wrong with a (cleaned) value of this type, or null; a value still being typed is not flagged. */
export function credentialValueProblem(value: string, credentialType: AiAccountCredentialType): string | null {
  const prefix = AI_ACCOUNT_CREDENTIAL_PREFIXES[credentialType];
  if (!value || value.startsWith(prefix) || prefix.startsWith(value)) return null;
  return credentialType === "subscription"
    ? "A subscription token from claude setup-token starts with sk-ant-oat."
    : "A Claude Console API key starts with sk-ant-api.";
}

/** A complete (cleaned) value of this type that the server would take. */
export function credentialValueReady(value: string, credentialType: AiAccountCredentialType): boolean {
  return value.length >= MIN_CREDENTIAL_LENGTH && value.startsWith(AI_ACCOUNT_CREDENTIAL_PREFIXES[credentialType]);
}

/** A failed add or replace. A duplicate never says whose account it is. */
export function poolCredentialErrorMessage(error: unknown): string | null {
  if (!error) return null;
  if (readAiAccountPoolError(error)?.code === "ai_account_duplicate") {
    return "This Claude account is already in Paperclip. Each account can be added once.";
  }
  return aiAccountPoolErrorMessage(error);
}

/**
 * A masked credential input. The value is never shown; the caller clears it
 * on submit, and `cleared` explains the empty field after a failed attempt.
 */
export function PoolCredentialField({
  id,
  credentialType,
  value,
  onChange,
  disabled,
  cleared = false,
  label,
}: {
  id: string;
  credentialType: AiAccountCredentialType;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  cleared?: boolean;
  label?: string;
}) {
  const problem = credentialValueProblem(cleanCredentialValue(value), credentialType);
  const subscription = credentialType === "subscription";
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label ?? (subscription ? "Setup token" : "API key")}</Label>
      <Input
        id={id}
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={subscription ? "sk-ant-oat01-…" : "sk-ant-api03-…"}
        disabled={disabled}
        aria-invalid={problem ? true : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {problem ? (
        <p role="alert" className="text-xs text-destructive">{problem}</p>
      ) : cleared && !value ? (
        <p className="text-xs text-muted-foreground">
          The field was cleared when you submitted it. Paste the {subscription ? "token" : "key"} again to try once more.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">Paperclip stores it encrypted and never shows it again.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add dialog
// ---------------------------------------------------------------------------

type PoolAccountSource = "paste" | "ai_connection" | "server_env";

const TYPE_OPTIONS: RadioCardOption[] = [
  { value: "subscription", title: "Subscription token", description: "A Claude Pro or Max account, from claude setup-token." },
  { value: "api_key", title: "API key", description: "A Claude Console key, billed per use." },
];

function sourceOptions(credentialType: AiAccountCredentialType, canImportServerEnv: boolean): RadioCardOption[] {
  const subscription = credentialType === "subscription";
  return [
    {
      value: "paste",
      title: subscription ? "Paste a token" : "Paste a key",
      description: subscription
        ? "Run claude setup-token on any computer signed in to the account."
        : "Create a key in the Claude Console.",
      icon: <ClipboardPaste className="size-4" />,
    },
    {
      value: "ai_connection",
      title: subscription ? "Import my saved Claude subscription" : "Import my saved Claude API key",
      description: "Copies a Claude connection you own in one of your companies. Its value never reaches this browser.",
      icon: <UserRound className="size-4" />,
    },
    ...(canImportServerEnv
      ? [{
          value: "server_env",
          title: subscription ? "Import the server's own token" : "Import the server's own key",
          description: `Copies the server's ${AI_ACCOUNT_ENV_KEY[credentialType]} into your account without showing it. Instance admins only.`,
          icon: <Server className="size-4" />,
        }]
      : []),
  ];
}

function isAccessError(error: unknown): boolean {
  const status = readAiAccountPoolError(error)?.status;
  return status === 403 || status === 404;
}

/**
 * Fork: adds a Claude account owned by the signed-in user. Sources: a pasted
 * credential, the user's own saved Claude connection, or (instance admins
 * only) the server's environment token. Imports happen on the server, and a
 * pasted value is cleared from the form as soon as it is submitted.
 */
export function AddPoolAccountDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        {/* Mounted only while open, so closing forgets every field, the token included. */}
        {open && <AddPoolAccountForm onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function AddPoolAccountForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const { companies } = useCompany();
  const isInstanceAdmin = useIsInstanceAdmin();
  const [credentialType, setCredentialType] = useState<AiAccountCredentialType>("subscription");
  const [sourceChoice, setSourceChoice] = useState<PoolAccountSource>("paste");
  const [value, setValue] = useState("");
  const [valueCleared, setValueCleared] = useState(false);
  const [connectionChoice, setConnectionChoice] = useState("");
  const [label, setLabel] = useState("");
  const [email, setEmail] = useState("");
  const [plan, setPlan] = useState("");
  // The pasted value reaches the request through this ref, not through the
  // mutation's variables, so nothing keeps it once the request is sent.
  const pendingValue = useRef<string | null>(null);

  // The server's own token is an instance-admin source only.
  const source: PoolAccountSource = sourceChoice === "server_env" && !isInstanceAdmin ? "paste" : sourceChoice;

  const create = useMutation({
    mutationFn: (input: CreateMyAiAccount) => {
      const pasted = pendingValue.current;
      pendingValue.current = null;
      return aiAccountPoolApi.create(pasted ? { ...input, value: pasted } : input);
    },
    onSuccess: () => onDone(),
    onSettled: () => invalidateAiAccountPoolQueries(queryClient),
  });

  const connectionLists = useQueries({
    queries: companies.map((company) => ({
      queryKey: ["ai-connections", company.id],
      queryFn: () => aiConnectionsApi.list(company.id),
      enabled: source === "ai_connection",
      retry: false,
    })),
  });
  const connectionOptions: RadioCardOption[] = companies.flatMap((company, index) =>
    importableConnections(connectionLists[index]?.data, credentialType).map((connection) => ({
      value: `${company.id}:${connection.id}`,
      title: connection.name,
      description: [
        company.name,
        connection.accountLabel,
        connection.status === "connected" ? null : AI_CONNECTION_STATUS[connection.status],
      ].filter(Boolean).join(" · "),
    })),
  );
  // The first of the user's connections is chosen until they pick another.
  const selectedConnection = connectionOptions.some((option) => option.value === connectionChoice)
    ? connectionChoice
    : connectionOptions[0]?.value ?? "";
  const connectionsLoading = source === "ai_connection" && connectionLists.some((query) => query.isLoading);
  // A company the user cannot read connections in is simply not a source.
  const connectionsFailed = connectionLists.filter((query) => query.error && !isAccessError(query.error)).length;

  const pasted = cleanCredentialValue(value);
  const busy = create.isPending;
  const subscription = credentialType === "subscription";
  let primaryLabel = "Add account";
  let canSubmit = label.trim().length > 0 && !busy;
  if (source === "paste") canSubmit &&= credentialValueReady(pasted, credentialType);
  if (source === "ai_connection") {
    primaryLabel = "Import connection";
    canSubmit &&= Boolean(selectedConnection);
  }
  if (source === "server_env") primaryLabel = subscription ? "Import token" : "Import key";

  function submit() {
    if (!canSubmit) return;
    create.reset();
    const input: CreateMyAiAccount = {
      label: label.trim(),
      credentialType,
      ...(email.trim() ? { emailHint: email.trim() } : {}),
      ...(plan.trim() ? { plan: plan.trim() } : {}),
    };
    if (source === "paste") {
      pendingValue.current = pasted;
      setValue("");
      setValueCleared(true);
      create.mutate(input);
    } else if (source === "server_env") {
      create.mutate({ ...input, importFrom: { kind: "server_env" } });
    } else {
      const [companyId, connectionId] = selectedConnection.split(":");
      create.mutate({ ...input, importFrom: { kind: "ai_connection", companyId: companyId!, connectionId: connectionId! } });
    }
  }

  const error = poolCredentialErrorMessage(create.error);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>Add a Claude account</DialogTitle>
        <DialogDescription>
          The account is yours. It can run agents in companies where you are a member, once you or a company admin
          assigns it to an agent.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-2">
        <span className="text-sm font-medium">Type</span>
        <RadioCardGroup
          ariaLabel="Credential type"
          className="sm:grid-cols-2"
          value={credentialType}
          onValueChange={(next) => {
            setCredentialType(next as AiAccountCredentialType);
            setConnectionChoice("");
            create.reset();
          }}
          options={TYPE_OPTIONS}
          disabled={busy}
        />
      </div>

      <div className="grid gap-2">
        <span className="text-sm font-medium">Source</span>
        <RadioCardGroup
          ariaLabel="Credential source"
          value={source}
          onValueChange={(next) => {
            setSourceChoice(next as PoolAccountSource);
            create.reset();
          }}
          options={sourceOptions(credentialType, isInstanceAdmin)}
          disabled={busy}
        />
      </div>

      {source === "paste" && (
        <PoolCredentialField
          id="pool-account-value"
          credentialType={credentialType}
          value={value}
          onChange={setValue}
          disabled={busy}
          cleared={valueCleared && create.isError}
        />
      )}

      {source === "server_env" && (
        <p className="text-sm text-muted-foreground">
          The server reads its own {AI_ACCOUNT_ENV_KEY[credentialType]} and stores a copy as your account. The value stays
          on the server.
        </p>
      )}

      {source === "ai_connection" && (
        <div className="grid gap-2">
          {connectionsLoading ? (
            <p className="text-sm text-muted-foreground">Loading your Claude connections…</p>
          ) : connectionOptions.length > 0 ? (
            <RadioCardGroup
              ariaLabel="Your Claude connections"
              value={selectedConnection}
              onValueChange={setConnectionChoice}
              options={connectionOptions}
              disabled={busy}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              You have no saved Claude {subscription ? "subscription" : "API key"} of your own in your companies.
            </p>
          )}
          {connectionsFailed > 0 && (
            <p role="alert" className="text-sm text-destructive">
              Could not load your connections in {connectionsFailed === 1 ? "one company" : `${connectionsFailed} companies`}.
              Close and try again.
            </p>
          )}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-2 sm:col-span-2">
          <Label htmlFor="pool-account-label">Name</Label>
          <Input
            id="pool-account-label"
            value={label}
            maxLength={80}
            placeholder="Team Max"
            disabled={busy}
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="pool-account-plan">Plan (optional)</Label>
          <Input
            id="pool-account-plan"
            value={plan}
            maxLength={40}
            placeholder="Max 20x"
            disabled={busy}
            onChange={(event) => setPlan(event.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="pool-account-email">Email (optional)</Label>
          <Input
            id="pool-account-email"
            inputMode="email"
            autoComplete="off"
            value={email}
            maxLength={200}
            placeholder="name@example.com"
            disabled={busy}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <DialogFooter className="sm:items-center sm:justify-between">
        <Button type="button" variant="outline" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSubmit}>
          {busy ? "Adding…" : primaryLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}
