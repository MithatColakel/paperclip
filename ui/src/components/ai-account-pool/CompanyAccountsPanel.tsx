import type { CompanyAiAccountOption } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { deviceDisplayName } from "@/lib/agent-claude-account";
import {
  POOL_CREDENTIAL_TYPE_LABELS,
  aiAccountStateDisplay,
  maskEmail,
} from "@/lib/ai-account-pool";
import { AiAccountStateBadge } from "./AccountSelect";

function ownerLine(account: CompanyAiAccountOption): string {
  if (account.ownedByMe) return "Yours";
  const who = account.owner.name?.trim() || maskEmail(account.owner.email) || "another member";
  return `Owner ${who}`;
}

/**
 * Fork: the Claude accounts available in a company, i.e. those whose owners
 * are members here, with their state and the agents and devices that use them
 * in this company.
 */
export function CompanyAccountsPanel({ accounts, now }: { accounts: readonly CompanyAiAccountOption[]; now?: Date }) {
  return (
    <ul className="divide-y divide-border">
      {accounts.map((account) => {
        const agents = account.agents.map((agent) => agent.agentName);
        // "Build box — owner x@y.com", as on every device surface; the owner is shown for display only.
        const devices = account.devices.map(deviceDisplayName);
        return (
          <li key={account.id} aria-label={account.label} className="space-y-1 py-3 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-sm font-medium">{account.label}</span>
              <Badge variant="outline">{POOL_CREDENTIAL_TYPE_LABELS[account.credentialType]}</Badge>
              <AiAccountStateBadge display={aiAccountStateDisplay(account, now)} />
            </div>
            <p className="text-xs text-muted-foreground">{[ownerLine(account), account.plan].filter(Boolean).join(" · ")}</p>
            <p className="text-xs text-muted-foreground">
              {agents.length > 0 ? `Agents: ${agents.join(", ")}` : "No agent here uses it yet."}
            </p>
            {devices.length > 0 && <p className="text-xs text-muted-foreground">Devices: {devices.join(", ")}</p>}
          </li>
        );
      })}
    </ul>
  );
}
