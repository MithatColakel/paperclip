// Fork: the "Reset password" action on a company member row. Shown only to an
// owner of the company or an instance admin; the server decides per member.
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { PasswordResetLinkCreated } from "@paperclipai/shared";
import { Check, Copy, KeyRound } from "lucide-react";
import type { CompanyMember } from "@/api/access";
import { passwordResetApi, passwordResetQueryKeys } from "@/api/passwordReset";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/context/ToastContext";
import { copyTextToClipboard } from "@/lib/clipboard";

function memberLabel(member: CompanyMember) {
  return member.user?.name || member.user?.email || member.principalId;
}

export function MemberPasswordResetAction({
  companyId,
  member,
}: {
  companyId: string;
  member: CompanyMember;
}) {
  const { pushToast } = useToast();
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<PasswordResetLinkCreated | null>(null);
  const [copied, setCopied] = useState(false);

  // One request per page: every row shares this query key.
  const accessQuery = useQuery({
    queryKey: passwordResetQueryKeys.access(companyId),
    queryFn: () => passwordResetApi.getAccess(companyId),
    enabled: companyId.length > 0,
  });

  const createMutation = useMutation({
    mutationFn: () => passwordResetApi.createLink(companyId, member.id),
    onSuccess: async (link) => {
      setCreated(link);
      setCopied(await copy(link.resetUrl));
    },
    onError: (error) => {
      pushToast({
        title: "Could not create the password reset link",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  async function copy(url: string) {
    try {
      await copyTextToClipboard(url);
      return true;
    } catch {
      return false;
    }
  }

  if (!accessQuery.data?.actorCanCreate) return null;
  const memberAccess = accessQuery.data.members[member.id];
  const canCreate = memberAccess?.canCreate ?? false;
  const reason = memberAccess?.reason ?? undefined;
  const label = memberLabel(member);

  const close = () => {
    setOpen(false);
    setCreated(null);
    setCopied(false);
  };

  return (
    <>
      <span className="inline-flex" title={!canCreate ? reason : undefined}>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setOpen(true)}
          disabled={!canCreate}
          title={!canCreate ? reason : undefined}
        >
          <KeyRound className="mr-1 h-3.5 w-3.5" />
          Reset password
        </Button>
      </span>

      <Dialog open={open} onOpenChange={(next) => !next && close()}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Reset password</DialogTitle>
            <DialogDescription>
              {created
                ? `Send this link to ${label} over a private channel.`
                : `Create a one-time link that lets ${label} choose a new password.`}
            </DialogDescription>
          </DialogHeader>

          {created ? (
            <div className="space-y-3">
              <label className="block space-y-1">
                <span className="sr-only">Password reset URL</span>
                <input
                  readOnly
                  value={created.resetUrl}
                  onFocus={(event) => event.currentTarget.select()}
                  onClick={(event) => event.currentTarget.select()}
                  className="w-full rounded-md border border-border bg-muted/60 px-3 py-2 text-sm text-foreground outline-none transition-colors selection:bg-primary selection:text-primary-foreground focus:border-ring"
                  aria-label="Password reset URL"
                />
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={async () => setCopied(await copy(created.resetUrl))}
                >
                  <Copy className="h-4 w-4" />
                  Copy link
                </Button>
                {copied ? (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-foreground">
                    <Check className="h-3.5 w-3.5" />
                    Copied
                  </span>
                ) : null}
              </div>
              <p className="text-sm text-muted-foreground">
                Works once, until {new Date(created.expiresAt).toLocaleString()}.
                {created.revokedPreviousCount > 0 ? " The earlier link for this user no longer works." : ""}
              </p>
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              <div className="rounded-lg border border-border px-3 py-3">
                <div className="font-medium">{label}</div>
                <div className="text-muted-foreground">{member.user?.email || member.principalId}</div>
              </div>
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                <li>Anyone who opens the link can set a new password for this account. Share it only with this user.</li>
                <li>The link works once, for 24 hours. Creating a new link stops the old one.</li>
                <li>When the new password is set, the user is signed out on every device.</li>
              </ul>
            </div>
          )}

          <DialogFooter>
            {created ? (
              <Button onClick={close}>Done</Button>
            ) : (
              <>
                <Button variant="outline" onClick={close}>
                  Cancel
                </Button>
                <Button onClick={() => createMutation.mutate()} disabled={createMutation.isPending}>
                  {createMutation.isPending ? "Creating…" : "Create link"}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
