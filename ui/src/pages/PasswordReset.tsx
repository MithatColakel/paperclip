// Fork: the public page behind an owner-issued password reset link.
import { useEffect, useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PASSWORD_RESET_MAX_LENGTH, PASSWORD_RESET_MIN_LENGTH } from "@paperclipai/shared";
import { Link, useParams } from "@/lib/router";
import { passwordResetApi, passwordResetQueryKeys } from "@/api/passwordReset";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

const inputClassName =
  "w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50";

/** Keep the token in this page's URL out of the Referer of anything it loads. */
function useNoReferrer() {
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "referrer";
    meta.content = "no-referrer";
    document.head.appendChild(meta);
    return () => {
      meta.remove();
    };
  }, []);
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-xl px-4 py-10">
      <Card className="block p-6">{children}</Card>
    </div>
  );
}

export function PasswordResetPage() {
  useNoReferrer();
  const queryClient = useQueryClient();
  const params = useParams();
  const token = (params.token ?? "").trim();
  const errorId = useId();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const linkQuery = useQuery({
    queryKey: passwordResetQueryKeys.link(token),
    queryFn: () => passwordResetApi.getLink(token),
    enabled: token.length > 0,
    retry: false,
  });

  const completeMutation = useMutation({
    mutationFn: () => passwordResetApi.complete(token, password),
    onSuccess: async () => {
      setPassword("");
      setConfirm("");
      // The reset signs the user out everywhere, possibly this browser too.
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
    },
  });

  if (!token) {
    return (
      <PageShell>
        <h1 className="text-lg font-semibold">Invalid password reset link</h1>
      </PageShell>
    );
  }

  if (completeMutation.isSuccess) {
    return (
      <PageShell>
        <h1 className="text-lg font-semibold">Password updated</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Sign in as {completeMutation.data.userEmail} with your new password. You were signed out on your other
          devices.
        </p>
        <Button asChild className="mt-4">
          <Link to="/auth">Sign in</Link>
        </Button>
      </PageShell>
    );
  }

  if (linkQuery.isLoading) {
    return <div className="mx-auto max-w-xl px-4 py-10 text-sm text-muted-foreground">Checking the link…</div>;
  }

  if (linkQuery.error || !linkQuery.data) {
    return (
      <PageShell>
        <h1 className="text-lg font-semibold">Password reset link unavailable</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {linkQuery.error instanceof Error
            ? linkQuery.error.message
            : "This password reset link is invalid, expired or already used."}{" "}
          Ask the owner of your organization for a new link.
        </p>
      </PageShell>
    );
  }

  const link = linkQuery.data;
  const submitError =
    formError ?? (completeMutation.error instanceof Error ? completeMutation.error.message : null);

  return (
    <PageShell>
      <h1 className="text-xl font-semibold">Choose a new password</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {link.createdByUserName ? `${link.createdByUserName} created this link` : "This link was created"}
        {link.companyName ? ` in ${link.companyName}` : ""} for{" "}
        <span className="font-medium text-foreground">{link.userEmail}</span>. It works once, until{" "}
        {new Date(link.expiresAt).toLocaleString()}.
      </p>

      <form
        className="mt-6 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (completeMutation.isPending) return;
          if (password.length < PASSWORD_RESET_MIN_LENGTH) {
            setFormError(`Use at least ${PASSWORD_RESET_MIN_LENGTH} characters.`);
            return;
          }
          if (password.length > PASSWORD_RESET_MAX_LENGTH) {
            setFormError(`Use at most ${PASSWORD_RESET_MAX_LENGTH} characters.`);
            return;
          }
          if (password !== confirm) {
            setFormError("The passwords do not match.");
            return;
          }
          setFormError(null);
          completeMutation.mutate();
        }}
      >
        {/* Lets password managers store the new password under the right account. */}
        <input type="email" name="email" autoComplete="username" value={link.userEmail} readOnly hidden />
        <div>
          <label htmlFor="new-password" className="mb-1 block text-xs text-muted-foreground">
            New password
          </label>
          <input
            id="new-password"
            name="new-password"
            type="password"
            className={inputClassName}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            required
            minLength={PASSWORD_RESET_MIN_LENGTH}
            maxLength={PASSWORD_RESET_MAX_LENGTH}
            aria-invalid={submitError ? true : undefined}
            aria-describedby={submitError ? errorId : undefined}
            autoFocus
          />
        </div>
        <div>
          <label htmlFor="confirm-password" className="mb-1 block text-xs text-muted-foreground">
            Repeat new password
          </label>
          <input
            id="confirm-password"
            name="confirm-password"
            type="password"
            className={inputClassName}
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            autoComplete="new-password"
            required
            aria-invalid={submitError ? true : undefined}
            aria-describedby={submitError ? errorId : undefined}
          />
        </div>
        {submitError ? (
          <p id={errorId} role="alert" className="text-xs text-destructive">
            {submitError}
          </p>
        ) : null}
        <Button type="submit" className="w-full" disabled={completeMutation.isPending}>
          {completeMutation.isPending ? "Saving…" : "Set new password"}
        </Button>
      </form>
    </PageShell>
  );
}
