import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import type { AiConnectionPoolMemberSummary, AiConnectionPoolSummary } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/utils";
import { AI_CONNECTION_STATUS, aiMethodLabel } from "./model";

/**
 * A limit a run met. Fork: Paperclip no longer reads usage, so a mark its
 * retired usage probe left is no limit, and no reading is shown (P7).
 */
function limitedUntil(member: AiConnectionPoolMemberSummary, now: number) {
  if (member.quotaSource === "usage_probe") return null;
  return member.exhaustedUntil && new Date(member.exhaustedUntil).getTime() > now ? member.exhaustedUntil : null;
}

/**
 * Fork: the legacy company pool of shared Claude accounts (spec 15.5). Each
 * agent on it stays on the account it used last, and one that has used none
 * starts on the top account. A limited account's tasks wait for its reset;
 * Paperclip never moves them to another account.
 */
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
          Agents already on the company pool stay on the account they used last and wait for its reset when it reaches
          its usage limit; an agent that has used none starts on the top account. Paperclip never moves a task to another
          account, and the pool takes no new agents.
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
            return (
              <li key={member.connectionId} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <span className="text-xs font-mono text-muted-foreground">{index + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{member.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {aiMethodLabel(member.provider, member.method)}
                    {member.accountLabel ? ` · ${member.accountLabel}` : ""}
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
