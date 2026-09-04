import { useState, type FormEvent } from "react";
import {
  useRequestPasswordReset,
  useResetPassword,
} from "@workspace/api-client-react";
import { ADVISORY_EMAIL } from "@workspace/format";
import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  KeyRound,
  Mail,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PortalHeader } from "@/components/portal-header";
import { clearQuerySecret, takeQuerySecret } from "@/lib/query-secret";

// The platform's one public contact address (the penalty calculator's
// advisory desk) — reused here so a locked-out firm admin, who has no
// administrator above them in-product, still has a human path.
const SUPPORT_EMAIL = ADVISORY_EMAIL;

// Password recovery (IDN-02), mirroring the accept-invite page: a public,
// non-enumerating request sends a single-use link when the account exists;
// redeeming it sets a new password and signs every outstanding session out.

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
  const requestReset = useRequestPasswordReset();
  const [token] = useState(() => takeQuerySecret("token"));

  const [email, setEmail] = useState("");
  const [requestSent, setRequestSent] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
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
      clearQuerySecret("token");
    } catch {
      // Uniform server response: never a reason a specific token is unusable.
      setError(
        "This reset link is invalid or has expired. Request a fresh link from this page.",
      );
      document.getElementById("reset-password")?.focus();
    }
  };

  const onRequestReset = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || requestReset.isPending) return;
    setRequestError(null);
    try {
      await requestReset.mutateAsync({ data: { email: email.trim() } });
      setRequestSent(true);
    } catch (err) {
      const status = (err as { status?: number })?.status;
      setRequestError(
        status === 429
          ? "Too many reset requests were made. Wait a few minutes, then try again."
          : "We could not submit the request. Try again or use the support email below.",
      );
    }
  };

  // No token — self-service recovery with a uniform, non-enumerating result.
  if (!token) {
    return (
      <ResetShell>
        <Card className="p-6 shadow-sm" data-testid="card-reset-guidance">
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-primary" aria-hidden="true" />
            <h1 className="text-lg font-semibold">Reset your password</h1>
          </div>
          {requestSent ? (
            <div
              className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100"
              role="status"
              data-testid="text-reset-request-sent"
            >
              <p className="flex items-start gap-2 font-medium">
                <CheckCircle2
                  className="mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
                Check your email
              </p>
              <p className="mt-1 text-xs leading-5">
                If an account exists for that address and email delivery is
                available, a one-time reset link is on its way. It expires in 24
                hours. Check spam or junk before requesting another link.
              </p>
            </div>
          ) : (
            <>
              <p
                className="mt-2 text-sm text-muted-foreground"
                data-testid="text-reset-guidance"
              >
                Enter the email address on your MeridianIQ account. We will send
                a one-time link if the account exists.
              </p>
              <form onSubmit={onRequestReset} className="mt-4 space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="reset-email">Email address</Label>
                  <Input
                    id="reset-email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(event) => {
                      setEmail(event.target.value);
                      setRequestError(null);
                    }}
                    aria-invalid={requestError ? true : undefined}
                    aria-describedby={
                      requestError ? "request-reset-error" : undefined
                    }
                    data-testid="input-reset-email"
                  />
                </div>
                {requestError && (
                  <p
                    id="request-reset-error"
                    role="alert"
                    className="text-sm text-destructive"
                    data-testid="text-request-reset-error"
                  >
                    {requestError}
                  </p>
                )}
                <Button
                  type="submit"
                  className="w-full"
                  disabled={requestReset.isPending || !email.trim()}
                  data-testid="button-request-reset"
                >
                  {requestReset.isPending ? (
                    <>
                      <Loader2
                        className="size-4 animate-spin"
                        aria-hidden="true"
                      />
                      Sending request…
                    </>
                  ) : (
                    <>
                      <Mail className="size-4" aria-hidden="true" />
                      Send reset link
                    </>
                  )}
                </Button>
              </form>
            </>
          )}
          <Button asChild variant="outline" className="mt-4 w-full">
            <a href="/login" data-testid="link-guidance-sign-in">
              Back to sign in
            </a>
          </Button>
          <Button asChild variant="outline" className="mt-2 w-full">
            <a
              href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
                "MeridianIQ password reset request",
              )}`}
              data-testid="link-guidance-support"
            >
              Contact MeridianIQ support
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
              <AlertCircle
                className="mt-0.5 h-4 w-4 shrink-0"
                aria-hidden="true"
              />
              {error}
            </p>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={reset.isPending || password.length < 8 || !passwordsMatch}
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
