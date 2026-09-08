import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  useAcceptInvite,
  usePreviewInvitation,
} from "@workspace/api-client-react";
import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  Building2,
  Mail,
  UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PortalHeader } from "@/components/portal-header";
import { serverErrorFrom } from "@/lib/errors";
import { clearQuerySecret, takeQuerySecret } from "@/lib/query-secret";
import "@/auth.css";

// Map the accept-invite failure to a friendly line. `showSignIn` decides
// whether we surface a "go to sign in" link (the account already exists).
function acceptError(err: unknown): { message: string; showSignIn: boolean } {
  const status = (err as { status?: number })?.status;
  if (status === 400) {
    return {
      message:
        "This invitation link is invalid or has expired. Ask your administrator to send a fresh invitation.",
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

function InviteShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="valo-auth auth-flow">
      {/* The brand mark + a sign-in shortcut, mirroring the Portal header. */}
      <PortalHeader
        right={
          <a
            href="/login"
            className="auth-text-link"
            data-testid="link-header-sign-in"
          >
            Sign in
          </a>
        }
      />
      <main
        id="main-content"
        tabIndex={-1}
        className="auth-flow-main focus:outline-none"
      >
        {children}
      </main>
    </div>
  );
}

function inviteRoleLabel(role: string): string {
  if (role === "firm_admin") return "Firm administrator";
  if (role === "firm_staff") return "Firm team member";
  return "Client workspace user";
}

function previewErrorMessage(err: unknown): string {
  const status = (err as { status?: number })?.status;
  if (status === 400) {
    return "This invitation is invalid, expired, revoked, or already used. Ask the person who invited you to create a new link.";
  }
  if (status === 429) {
    return "Too many invitation checks were made from this connection. Wait a few minutes, then try again.";
  }
  return "We could not verify this invitation right now. Check your connection and try again.";
}

export function AcceptInvite() {
  const accept = useAcceptInvite();
  const preview = usePreviewInvitation();
  const requestPreview = preview.mutate;
  const [token] = useState(() => takeQuerySecret("token"));
  const previewRequestedFor = useRef<string | null>(null);

  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<{
    message: string;
    showSignIn: boolean;
  } | null>(null);

  useEffect(() => {
    if (!token || previewRequestedFor.current === token) return;
    previewRequestedFor.current = token;
    requestPreview({ data: { token } });
  }, [requestPreview, token]);

  // Success replaces the form — and the button the user just pressed — with
  // the confirmation card, dropping focus to <body>. Move focus onto the
  // page's main region so keyboard and screen-reader users hear the outcome
  // (the error path already refocuses the password field on failure).
  useEffect(() => {
    if (accept.isSuccess) {
      document.getElementById("main-content")?.focus();
    }
  }, [accept.isSuccess]);

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
      clearQuerySecret("token");
    } catch (err) {
      setError(acceptError(err));
      document.getElementById("invite-password")?.focus();
    }
  };

  // No token in the link — nothing we can redeem.
  if (!token) {
    return (
      <InviteShell>
        <Card className="auth-flow-panel" data-testid="card-invite-missing-token">
          <div className="flex items-center gap-2">
            <AlertCircle
              className="h-5 w-5 text-destructive"
              aria-hidden="true"
            />
            <h1 className="text-lg font-semibold">
              Invitation link incomplete
            </h1>
          </div>
          <p
            className="mt-2 text-sm text-muted-foreground"
            data-testid="text-missing-token"
          >
            This page does not contain an invitation token. Ask the person who
            invited you to copy and share a new Valo invitation link.
          </p>
          <Button asChild variant="outline" className="auth-secondary mt-4">
            <a href="/login" data-testid="link-missing-token-sign-in">
              Go to sign in
            </a>
          </Button>
        </Card>
      </InviteShell>
    );
  }

  if (preview.isPending || preview.isIdle) {
    return (
      <InviteShell>
        <Card
          className="auth-flow-panel"
          aria-live="polite"
          data-testid="card-invite-checking"
        >
          <div className="flex items-center gap-3">
            <Loader2
              className="h-5 w-5 animate-spin text-primary"
              aria-hidden="true"
            />
            <div>
              <h1 className="text-lg font-semibold">Checking invitation</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Confirming which account and workspace this link opens.
              </p>
            </div>
          </div>
        </Card>
      </InviteShell>
    );
  }

  if (preview.isError) {
    return (
      <InviteShell>
        <Card className="auth-flow-panel" data-testid="card-invite-preview-error">
          <div className="flex items-start gap-2">
            <AlertCircle
              className="mt-0.5 h-5 w-5 shrink-0 text-destructive"
              aria-hidden="true"
            />
            <div>
              <h1 className="text-lg font-semibold">Invitation unavailable</h1>
              <p role="alert" className="mt-2 text-sm text-muted-foreground">
                {previewErrorMessage(preview.error)}
              </p>
            </div>
          </div>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              className="auth-submit flex-1"
              onClick={() => preview.mutate({ data: { token } })}
              disabled={preview.isPending}
              data-testid="button-retry-invite-preview"
            >
              Try again
            </Button>
            <Button asChild variant="outline" className="auth-secondary flex-1">
              <a href="/login">Go to sign in</a>
            </Button>
          </div>
        </Card>
      </InviteShell>
    );
  }

  // Account activated — send them on to sign in.
  if (accept.isSuccess) {
    return (
      <InviteShell>
        <Card className="auth-flow-panel" data-testid="card-invite-success">
          <div className="flex items-center gap-2">
            <CheckCircle2
              className="h-5 w-5 text-emerald-600 dark:text-emerald-400"
              aria-hidden="true"
            />
            <h1 className="text-lg font-semibold">Your account is ready</h1>
          </div>
          <p role="status" className="mt-2 text-sm text-muted-foreground">
            Your password is set. Sign in with{" "}
            <span className="font-medium text-foreground" data-testid="text-invite-signin-email">
              {preview.data?.email ?? "the email address this invitation was sent to"}
            </span>{" "}
            and the password you just chose.
          </p>
          <Button asChild className="auth-submit mt-4">
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
    [showMismatch ? "invite-confirm-help" : null, error ? "accept-error" : null]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <InviteShell>
      <Card className="auth-flow-panel">
        <h1 className="text-lg font-semibold">Activate your account</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Set a password to finish setting up your Valo account.
        </p>
        <dl
          className="auth-invite-context mt-4 divide-y border text-sm"
          data-testid="invite-context"
        >
          <div className="flex gap-3 py-2.5">
            <Mail
              className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">Account email</dt>
              <dd
                className="break-all font-medium"
                data-testid="text-invite-email"
              >
                {preview.data.email}
              </dd>
            </div>
          </div>
          <div className="flex gap-3 py-2.5">
            <Building2
              className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">Workspace</dt>
              <dd className="font-medium" data-testid="text-invite-workspace">
                {preview.data.workspaceName}
              </dd>
            </div>
          </div>
          <div className="flex gap-3 py-2.5">
            <UserRound
              className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">Access</dt>
              <dd className="font-medium" data-testid="text-invite-role">
                {inviteRoleLabel(preview.data.role)}
                {preview.data.clientName ? ` · ${preview.data.clientName}` : ""}
              </dd>
            </div>
          </div>
        </dl>
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
            className="auth-submit"
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
