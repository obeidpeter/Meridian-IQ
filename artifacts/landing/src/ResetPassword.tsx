import { useState, type FormEvent } from "react";
import { useResetPassword } from "@workspace/api-client-react";
import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  KeyRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PortalHeader } from "@/components/portal-header";

// Password recovery (IDN-02), mirroring the accept-invite page: the link an
// operator issues carries a single-use token; redeeming it sets a new password
// and signs every outstanding session out. Reached without a token (the
// login page's "Forgot your password?" path), the page explains how to get a
// reset link — there is no self-serve email loop yet, recovery is issued by
// the firm's administrator or MeridianIQ support.

function ResetShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-muted/40 to-background">
      <PortalHeader
        right={
          <a
            href="/login"
            className="text-sm font-medium text-muted-foreground hover:text-foreground"
            data-testid="link-header-sign-in"
          >
            Sign in
          </a>
        }
      />
      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-10 focus:outline-none sm:px-6"
      >
        {children}
      </main>
    </div>
  );
}

export function ResetPassword() {
  const reset = useResetPassword();
  const token = new URLSearchParams(window.location.search).get("token");

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  const passwordsMatch = password === confirm;
  const showMismatch = confirm.length > 0 && !passwordsMatch;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token || password.length < 8 || !passwordsMatch) return;
    setError(null);
    try {
      await reset.mutateAsync({ data: { token, password } });
    } catch {
      // Uniform server response: never a reason a specific token is unusable.
      setError(
        "This reset link is invalid or has expired. Ask your administrator for a fresh one.",
      );
      document.getElementById("reset-password")?.focus();
    }
  };

  // No token — the "forgot password" guidance path.
  if (!token) {
    return (
      <ResetShell>
        <Card className="p-6 shadow-sm" data-testid="card-reset-guidance">
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-primary" aria-hidden="true" />
            <h1 className="text-lg font-semibold">Reset your password</h1>
          </div>
          <p
            className="mt-2 text-sm text-muted-foreground"
            data-testid="text-reset-guidance"
          >
            Password resets are issued as one-time links. Ask your firm
            administrator — or MeridianIQ support — to send you a reset link,
            then open it here to choose a new password.
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            For security, the link works once and expires after 24 hours.
          </p>
          <Button asChild variant="outline" className="mt-4 w-full">
            <a href="/login" data-testid="link-guidance-sign-in">
              Back to sign in
            </a>
          </Button>
        </Card>
      </ResetShell>
    );
  }

  // Password set — every old session is signed out; on to sign in.
  if (reset.isSuccess) {
    return (
      <ResetShell>
        <Card className="p-6 shadow-sm" data-testid="card-reset-success">
          <div className="flex items-center gap-2">
            <CheckCircle2
              className="h-5 w-5 text-emerald-600 dark:text-emerald-400"
              aria-hidden="true"
            />
            <h1 className="text-lg font-semibold">Password updated</h1>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Your new password is set and any previous sessions have been signed
            out. Sign in to continue.
          </p>
          <Button asChild className="mt-4 w-full">
            <a href="/login" data-testid="link-reset-continue-sign-in">
              Continue to sign in
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </a>
          </Button>
        </Card>
      </ResetShell>
    );
  }

  return (
    <ResetShell>
      <Card className="p-6 shadow-sm">
        <h1 className="text-lg font-semibold">Choose a new password</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          This one-time link sets a new password for your MeridianIQ account.
        </p>
        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="reset-password">New password</Label>
            <Input
              id="reset-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
              aria-describedby="reset-password-help"
              data-testid="input-reset-password"
            />
            <p
              id="reset-password-help"
              className="text-xs text-muted-foreground"
            >
              At least 8 characters.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reset-confirm">Confirm password</Label>
            <Input
              id="reset-confirm"
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => {
                setConfirm(e.target.value);
                setError(null);
              }}
              aria-invalid={showMismatch || undefined}
              aria-describedby={
                [
                  showMismatch ? "reset-confirm-help" : null,
                  error ? "reset-error" : null,
                ]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              data-testid="input-reset-confirm"
            />
            {showMismatch && (
              <p
                id="reset-confirm-help"
                className="text-xs text-destructive"
                role="alert"
              >
                Passwords do not match.
              </p>
            )}
          </div>
          {error && (
            <p
              id="reset-error"
              role="alert"
              className="flex items-start gap-2 text-sm text-destructive"
              data-testid="text-reset-error"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {error}
            </p>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={
              reset.isPending || password.length < 8 || !passwordsMatch
            }
            data-testid="button-set-password"
          >
            {reset.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Setting password…
              </>
            ) : (
              "Set new password"
            )}
          </Button>
        </form>
      </Card>
    </ResetShell>
  );
}
