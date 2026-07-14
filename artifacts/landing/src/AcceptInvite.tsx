import { useState, type FormEvent } from "react";
import { useAcceptInvite } from "@workspace/api-client-react";
import {
  FileCheck2,
  Loader2,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// The generated client throws ApiError carrying the parsed body; the server
// answers { error: string }. (Copied from App.tsx — kept local on purpose.)
function serverErrorFrom(err: unknown): string | null {
  const data = (err as { data?: unknown })?.data;
  return data && typeof data === "object" && "error" in data
    ? String((data as { error: unknown }).error)
    : null;
}

// Map the accept-invite failure to a friendly line. `showSignIn` decides
// whether we surface a "go to sign in" link (the account already exists).
function acceptError(err: unknown): { message: string; showSignIn: boolean } {
  const status = (err as { status?: number })?.status;
  if (status === 400) {
    return {
      message: "This invitation link is invalid or has expired.",
      showSignIn: false,
    };
  }
  if (status === 409) {
    return {
      message: "An account with this email already exists — sign in instead.",
      showSignIn: true,
    };
  }
  if (status !== undefined) {
    return {
      message:
        serverErrorFrom(err) ??
        "Could not activate your account. Please try again.",
      showSignIn: false,
    };
  }
  return {
    message: "Could not activate your account. Please try again.",
    showSignIn: false,
  };
}

// The MeridianIQ brand mark + a sign-in shortcut, mirroring the Portal header.
function InviteHeader() {
  return (
    <header className="border-b bg-card/70 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
        <a
          href="/"
          className="flex items-center gap-2.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          aria-label="MeridianIQ home"
        >
          <div className="rounded-lg bg-primary p-1.5 text-primary-foreground">
            <FileCheck2 className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <p className="text-base font-bold leading-none">MeridianIQ</p>
            <p className="text-xs text-muted-foreground">
              Compliance & verified receivables
            </p>
          </div>
        </a>
        <a
          href="/login"
          className="text-sm font-medium text-muted-foreground hover:text-foreground"
          data-testid="link-header-sign-in"
        >
          Sign in
        </a>
      </div>
    </header>
  );
}

function InviteShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-muted/40 to-background">
      <InviteHeader />
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

export function AcceptInvite() {
  const accept = useAcceptInvite();
  const token = new URLSearchParams(window.location.search).get("token");

  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<{
    message: string;
    showSignIn: boolean;
  } | null>(null);

  const passwordsMatch = password === confirm;
  const showMismatch = confirm.length > 0 && !passwordsMatch;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token || password.length < 8 || !passwordsMatch) return;
    setError(null);
    try {
      await accept.mutateAsync({
        data: {
          token,
          password,
          ...(fullName.trim() ? { fullName: fullName.trim() } : {}),
        },
      });
    } catch (err) {
      setError(acceptError(err));
      document.getElementById("invite-password")?.focus();
    }
  };

  // No token in the link — nothing we can redeem.
  if (!token) {
    return (
      <InviteShell>
        <Card className="p-6 shadow-sm" data-testid="card-invite-missing-token">
          <div className="flex items-center gap-2">
            <AlertCircle
              className="h-5 w-5 text-destructive"
              aria-hidden="true"
            />
            <h1 className="text-lg font-semibold">Invitation link incomplete</h1>
          </div>
          <p
            className="mt-2 text-sm text-muted-foreground"
            data-testid="text-missing-token"
          >
            This invitation link is missing its token. Ask your administrator to
            resend it.
          </p>
          <Button asChild variant="outline" className="mt-4 w-full">
            <a href="/login" data-testid="link-missing-token-sign-in">
              Go to sign in
            </a>
          </Button>
        </Card>
      </InviteShell>
    );
  }

  // Account activated — send them on to sign in.
  if (accept.isSuccess) {
    return (
      <InviteShell>
        <Card className="p-6 shadow-sm" data-testid="card-invite-success">
          <div className="flex items-center gap-2">
            <CheckCircle2
              className="h-5 w-5 text-emerald-600 dark:text-emerald-400"
              aria-hidden="true"
            />
            <h1 className="text-lg font-semibold">Your account is ready</h1>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Your password is set. Sign in to open your workspace.
          </p>
          <Button asChild className="mt-4 w-full">
            <a href="/login" data-testid="link-continue-sign-in">
              Continue to sign in
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </a>
          </Button>
        </Card>
      </InviteShell>
    );
  }

  const confirmDescribedBy =
    [
      showMismatch ? "invite-confirm-help" : null,
      error ? "accept-error" : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <InviteShell>
      <Card className="p-6 shadow-sm">
        <h1 className="text-lg font-semibold">Activate your account</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Set a password to finish setting up your MeridianIQ account.
        </p>
        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="invite-full-name">
              Full name{" "}
              <span className="font-normal text-muted-foreground">
                (optional)
              </span>
            </Label>
            <Input
              id="invite-full-name"
              type="text"
              autoComplete="name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Ada Okafor"
              data-testid="input-invite-full-name"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="invite-password">Password</Label>
            <Input
              id="invite-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              aria-invalid={error ? true : undefined}
              aria-describedby={
                error
                  ? "invite-password-help accept-error"
                  : "invite-password-help"
              }
              data-testid="input-invite-password"
            />
            <p
              id="invite-password-help"
              className="text-xs text-muted-foreground"
            >
              At least 8 characters
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="invite-confirm-password">Confirm password</Label>
            <Input
              id="invite-confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              minLength={8}
              aria-invalid={showMismatch || error ? true : undefined}
              aria-describedby={confirmDescribedBy}
              data-testid="input-invite-confirm-password"
            />
            {showMismatch && (
              <p
                id="invite-confirm-help"
                className="text-xs text-destructive"
                data-testid="text-invite-mismatch"
              >
                Passwords do not match.
              </p>
            )}
          </div>

          {error && (
            <p
              role="alert"
              id="accept-error"
              className="flex items-start gap-1.5 text-sm text-destructive"
              data-testid="text-accept-error"
            >
              <AlertCircle
                className="mt-0.5 h-4 w-4 shrink-0"
                aria-hidden="true"
              />
              <span>
                {error.message}
                {error.showSignIn && (
                  <>
                    {" "}
                    <a
                      href="/login"
                      className="font-medium underline underline-offset-4"
                      data-testid="link-accept-sign-in"
                    >
                      Go to sign in
                    </a>
                  </>
                )}
              </span>
            </p>
          )}

          <Button
            type="submit"
            className="w-full"
            disabled={
              accept.isPending || password.length < 8 || !passwordsMatch
            }
            data-testid="button-accept-invite"
          >
            {accept.isPending && (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            )}
            Activate account
          </Button>
        </form>
      </Card>
    </InviteShell>
  );
}

export default AcceptInvite;
