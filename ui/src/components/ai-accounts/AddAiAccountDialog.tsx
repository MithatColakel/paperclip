import { useRef, useState } from "react";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { ClipboardPaste, Laptop, Server, UserRound } from "lucide-react";
import type { AiAccountCredentialType, AiAccountHostSummary, CreateAiAccount } from "@paperclipai/shared";
import { aiAccountHostsApi } from "@/api/ai-account-hosts";
import { aiConnectionsApi } from "@/api/ai-connections";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioCardGroup, type RadioCardOption } from "@/components/ui/radio-card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { MacClaudeTokenDevices } from "../ai-connections/ClaudeTokenSourcePicker";
import { useMacClaudeToken } from "../ai-connections/useMacClaudeToken";
import { AI_CONNECTION_STATUS } from "../ai-connections/model";
import { CREDENTIAL_PREFIX, aiAccountErrorMessage, importableConnections } from "./model";

type AccountSource = "paste" | "server_env" | "ai_connection" | "mac";

const TYPE_OPTIONS: RadioCardOption[] = [
  { value: "subscription", title: "Subscription token", description: "A Claude Pro or Max account, from claude setup-token." },
  { value: "api_key", title: "API key", description: "A Claude Console key, billed per use." },
];

function sourceOptions(host: AiAccountHostSummary, type: AiAccountCredentialType): RadioCardOption[] {
  const subscription = type === "subscription";
  return [
    {
      value: "paste",
      title: subscription ? "Paste a token" : "Paste a key",
      description: subscription
        ? "Run claude setup-token on any computer signed in to the account."
        : "Create a key in the Claude Console.",
      icon: <ClipboardPaste className="size-4" />,
    },
    ...(host.kind === "server"
      ? [{
          value: "server_env",
          title: subscription ? "Import the server's own token" : "Import the server's own key",
          description: `Moves the server's ${subscription ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY"} here without showing it.`,
          icon: <Server className="size-4" />,
        }]
      : []),
    {
      value: "ai_connection",
      title: subscription ? "Import my saved Claude subscription" : "Import my saved Claude API key",
      description: "Moves a Claude connection you own in one of your companies.",
      icon: <UserRound className="size-4" />,
    },
    {
      value: "mac",
      title: "Get it from a Mac",
      description: subscription
        ? "The Mac's owner approves and its Claude account comes back."
        : "Macs share subscription tokens only.",
      icon: <Laptop className="size-4" />,
      disabled: !subscription,
    },
  ];
}

/** Adds a Claude account to one host. The credential never comes back to the browser. */
export function AddAiAccountDialog({
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
      <DialogContent className="sm:max-w-xl">
        {/* Mounted only while open, so closing forgets every field and withdraws a pending Mac request. */}
        {open && <AddAiAccountForm host={host} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function AddAiAccountForm({ host, onDone }: { host: AiAccountHostSummary; onDone: () => void }) {
  const queryClient = useQueryClient();
  const { companies, selectedCompanyId } = useCompany();
  const [label, setLabel] = useState("");
  const [email, setEmail] = useState("");
  const [plan, setPlan] = useState("");
  const [credentialType, setCredentialType] = useState<AiAccountCredentialType>("subscription");
  const [source, setSource] = useState<AccountSource>("paste");
  const [value, setValue] = useState("");
  const [connectionChoice, setConnectionChoice] = useState("");
  const [macCompanyId, setMacCompanyId] = useState<string>(
    () => (companies.some((company) => company.id === selectedCompanyId) ? selectedCompanyId! : companies[0]?.id ?? ""),
  );
  // A token from a Mac is held only to retry a failed save; it is never rendered.
  const macTokenRef = useRef<string | null>(null);
  const [hasMacToken, setHasMacToken] = useState(false);

  const add = useMutation({
    mutationFn: (input: CreateAiAccount) => aiAccountHostsApi.addAccount(host.id, input),
    onSuccess: async () => {
      macTokenRef.current = null;
      setValue("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.aiAccountHosts });
      onDone();
    },
  });

  const details = () => ({
    label: label.trim(),
    ...(email.trim() ? { emailHint: email.trim() } : {}),
    ...(plan.trim() ? { plan: plan.trim() } : {}),
  });

  const mac = useMacClaudeToken(
    macCompanyId,
    (token) => {
      macTokenRef.current = token;
      setHasMacToken(true);
      add.mutate({ ...details(), credentialType: "subscription", value: token });
    },
    source === "mac" && Boolean(macCompanyId),
  );
  const macWaiting = mac.status === "requesting" || mac.status === "pending" || mac.status === "collecting";

  const connectionLists = useQueries({
    queries: companies.map((company) => ({
      queryKey: ["ai-connections", company.id],
      queryFn: () => aiConnectionsApi.list(company.id),
      enabled: source === "ai_connection",
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
  const connectionsFailed = connectionLists.filter((query) => query.error).length;

  const trimmedValue = value.trim();
  const valueProblem = trimmedValue && !trimmedValue.startsWith(CREDENTIAL_PREFIX[credentialType])
    ? credentialType === "subscription"
      ? "A subscription token from claude setup-token starts with sk-ant-oat."
      : "A Claude Console API key starts with sk-ant-api."
    : null;

  const busy = add.isPending || macWaiting;
  const hasLabel = label.trim().length > 0;
  let primaryLabel = "Add account";
  let canSubmit = hasLabel && !busy;
  if (source === "paste") canSubmit &&= trimmedValue.length >= 20 && !valueProblem;
  if (source === "server_env") primaryLabel = credentialType === "subscription" ? "Import token" : "Import key";
  if (source === "ai_connection") {
    primaryLabel = "Import connection";
    canSubmit &&= Boolean(selectedConnection);
  }
  if (source === "mac" && !hasMacToken) {
    primaryLabel = macWaiting ? "Waiting for the Mac" : "Request from Mac";
    canSubmit &&= Boolean(mac.deviceId) && mac.available;
  }

  function submit() {
    if (!canSubmit) return;
    add.reset();
    if (source === "paste") {
      add.mutate({ ...details(), credentialType, value: trimmedValue });
    } else if (source === "server_env") {
      add.mutate({ ...details(), credentialType, importFrom: { kind: "server_env" } });
    } else if (source === "ai_connection") {
      const [companyId, connectionId] = selectedConnection.split(":");
      add.mutate({ ...details(), credentialType, importFrom: { kind: "ai_connection", companyId: companyId!, connectionId: connectionId! } });
    } else if (macTokenRef.current) {
      add.mutate({ ...details(), credentialType: "subscription", value: macTokenRef.current });
    } else {
      void mac.start();
    }
  }

  function changeType(next: string) {
    const type = next as AiAccountCredentialType;
    setCredentialType(type);
    setConnectionChoice("");
    if (type === "api_key" && source === "mac") setSource("paste");
    add.reset();
  }

  function changeSource(next: string) {
    setSource(next as AccountSource);
    add.reset();
  }

  const error = aiAccountErrorMessage(add.error);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>Add a Claude account to {host.name}</DialogTitle>
        <DialogDescription>
          Runs on this host share its accounts. A credential can serve one host only.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-2 sm:col-span-2">
          <Label htmlFor="ai-account-label">Name</Label>
          <Input
            id="ai-account-label"
            value={label}
            maxLength={80}
            placeholder="Account S"
            disabled={busy}
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="ai-account-email">Email (optional)</Label>
          <Input
            id="ai-account-email"
            inputMode="email"
            autoComplete="off"
            value={email}
            maxLength={200}
            placeholder="name@example.com"
            disabled={busy}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="ai-account-plan">Plan (optional)</Label>
          <Input
            id="ai-account-plan"
            value={plan}
            maxLength={40}
            placeholder="Max 20x"
            disabled={busy}
            onChange={(event) => setPlan(event.target.value)}
          />
        </div>
      </div>

      <div className="grid gap-2">
        <span className="text-sm font-medium">Type</span>
        <RadioCardGroup
          ariaLabel="Credential type"
          className="sm:grid-cols-2"
          value={credentialType}
          onValueChange={changeType}
          options={TYPE_OPTIONS}
          disabled={busy || hasMacToken}
        />
      </div>

      <div className="grid gap-2">
        <span className="text-sm font-medium">Source</span>
        <RadioCardGroup
          ariaLabel="Credential source"
          className="sm:grid-cols-2"
          value={source}
          onValueChange={changeSource}
          options={sourceOptions(host, credentialType)}
          disabled={busy || hasMacToken}
        />
      </div>

      {source === "paste" && (
        <div className="grid gap-2">
          <Label htmlFor="ai-account-value">{credentialType === "subscription" ? "Setup token" : "API key"}</Label>
          <Input
            id="ai-account-value"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            placeholder={credentialType === "subscription" ? "sk-ant-oat01-…" : "sk-ant-api03-…"}
            disabled={busy}
            aria-invalid={valueProblem ? true : undefined}
            onChange={(event) => setValue(event.target.value)}
          />
          {valueProblem ? (
            <p role="alert" className="text-xs text-destructive">{valueProblem}</p>
          ) : (
            <p className="text-xs text-muted-foreground">Paperclip stores it encrypted and never shows it again.</p>
          )}
        </div>
      )}

      {source === "server_env" && (
        <p className="text-sm text-muted-foreground">
          The server reads its own {credentialType === "subscription" ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY"} and
          stores a copy for this host. The value stays on the server.
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
              You have no saved Claude {credentialType === "subscription" ? "subscription" : "API key"} of your own in your
              companies.
            </p>
          )}
          {connectionsFailed > 0 && (
            <p role="alert" className="text-sm text-destructive">
              Could not load the connections of {connectionsFailed === 1 ? "one company" : `${connectionsFailed} companies`}. Close
              and try again.
            </p>
          )}
        </div>
      )}

      {source === "mac" && (
        <div className="grid gap-3">
          {companies.length === 0 ? (
            <p className="text-sm text-muted-foreground">You are not a member of any company with Macs.</p>
          ) : (
            <div className="grid gap-2">
              <Label htmlFor="ai-account-mac-company">Company the Mac is enrolled in</Label>
              <Select value={macCompanyId} onValueChange={setMacCompanyId} disabled={busy || hasMacToken}>
                <SelectTrigger id="ai-account-mac-company" className="w-full">
                  <SelectValue placeholder="Choose a company" />
                </SelectTrigger>
                <SelectContent>
                  {companies.map((company) => (
                    <SelectItem key={company.id} value={company.id}>{company.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {macCompanyId && !mac.loading && !mac.available ? (
            <p className="text-sm text-muted-foreground">Mac Fleet is not installed on this Paperclip.</p>
          ) : macCompanyId ? (
            <MacClaudeTokenDevices mac={mac} disabled={add.isPending || hasMacToken} />
          ) : null}
          {hasMacToken && (
            <p role="status" className="text-sm text-muted-foreground">
              The Mac sent its token. {add.isPending ? "Saving…" : "Add the account to save it."}
            </p>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <DialogFooter className="sm:items-center sm:justify-between">
        <Button type="button" variant="outline" onClick={() => (macWaiting ? mac.cancel() : onDone())} disabled={add.isPending}>
          {macWaiting ? "Stop waiting" : "Cancel"}
        </Button>
        <Button type="submit" disabled={!canSubmit}>
          {add.isPending ? "Saving…" : primaryLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}
