import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import type { AiConnectionPoolMemberSummary, AiConnectionPoolSummary, AiConnectionPoolUsageWindowKey } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/utils";
import { AI_CONNECTION_STATUS, aiMethodLabel } from "./model";

const USAGE_LABELS: Record<AiConnectionPoolUsageWindowKey, string> = {
  five_hour: "Session",
  seven_day: "Week",
  seven_day_opus: "Opus week",
  seven_day_sonnet: "Sonnet week",
};

function limitedUntil(member: AiConnectionPoolMemberSummary, now: number) {
  return member.exhaustedUntil && new Date(member.exhaustedUntil).getTime() > now ? member.exhaustedUntil : null;
}

function usageSummary(member: AiConnectionPoolMemberSummary) {
  return member.usageWindows
    .filter((window) => window.usedPercent != null)
    .map((window) => `${USAGE_LABELS[window.key]} ${Math.round(window.usedPercent!)}%`)
    .join(" · ");
}

/** Orders a company's shared Claude accounts; runs move down the list when an account hits its usage limit. */
export function AiAccountPoolCard({ companyId }: { companyId: string }) {
  const client = useQueryClient();
  const queryKey = ["ai-connections", companyId, "pool", "anthropic"];
  const pool = useQuery({ queryKey, queryFn: () => aiConnectionsApi.pool(companyId, "anthropic") });
  const replace = useMutation({
    mutationFn: (members: Array<{ connectionId: string; grantId: string }>) =>
      aiConnectionsApi.replacePool(companyId, { provider: "anthropic", members }),
    onSuccess: (summary: AiConnectionPoolSummary) => client.setQueryData(queryKey, summary),
  });
  const clearLimit = useMutation({
    mutationFn: (connectionId: string) => aiConnectionsApi.clearPoolLimit(companyId, connectionId),
    onSuccess: () => client.invalidateQueries({ queryKey }),
  });
  const data = pool.data;
  if (pool.isLoading || (!pool.error && !data?.members.length && !data?.candidates.length)) return null;
  const members = data?.members ?? [];
  const order = members.map(({ connectionId, grantId }) => ({ connectionId, grantId }));
  const move = (index: number, offset: number) => {
    const next = [...order];
    [next[index], next[index + offset]] = [next[index + offset]!, next[index]!];
    replace.mutate(next);
  };
  const busy = replace.isPending || clearLimit.isPending;
  const error = pool.error ?? replace.error ?? clearLimit.error;
  const now = Date.now();
  return (
    <section className="space-y-3 rounded-lg border border-border p-4" aria-label="Claude account pool">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">Claude account pool</h2>
        <p className="text-xs text-muted-foreground">
          Agents set to “Company account pool” use these shared accounts from the top. When an account reaches its usage
          limit, the task moves to the next account and the limited one returns after its reset.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      )}
      {members.length > 0 ? (
        <ol className="divide-y divide-border rounded-md border border-border">
          {members.map((member, index) => {
            const until = limitedUntil(member, now);
            const usage = usageSummary(member);
            return (
              <li key={member.connectionId} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <span className="text-xs font-mono text-muted-foreground">{index + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{member.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {aiMethodLabel(member.provider, member.method)}
                    {member.accountLabel ? ` · ${member.accountLabel}` : ""}
                    {usage ? ` · ${usage}` : ""}
                  </p>
                </div>
                {until ? (
                  <Badge variant="destructive">Usage limit until {formatDateTime(until)}</Badge>
                ) : member.status !== "connected" ? (
                  <Badge variant="outline">{AI_CONNECTION_STATUS[member.status]}</Badge>
                ) : (
                  <Badge variant="secondary">Available</Badge>
                )}
                <div className="flex items-center gap-1">
                  {until && (
                    <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => clearLimit.mutate(member.connectionId)}>
                      Clear limit
                    </Button>
                  )}
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move ${member.name} up`} disabled={busy || index === 0} onClick={() => move(index, -1)}>
                    <ArrowUp />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move ${member.name} down`} disabled={busy || index === members.length - 1} onClick={() => move(index, 1)}>
                    <ArrowDown />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${member.name} from the pool`} disabled={busy} onClick={() => replace.mutate(order.filter((_, i) => i !== index))}>
                    <X />
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">No accounts in the pool yet.</p>
      )}
      {(data?.candidates.length ?? 0) > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Add a shared account:</span>
          {data!.candidates.map((candidate) => (
            <Button
              key={candidate.connectionId}
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => replace.mutate([...order, { connectionId: candidate.connectionId, grantId: candidate.grantId }])}
            >
              <Plus />
              {candidate.name}
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}
