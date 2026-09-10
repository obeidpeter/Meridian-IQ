import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Copy, Check, KeyRound } from "lucide-react";
import type { InvitationsState } from "./use-invitations";

// Operator support path (IDN-02): issue a one-time password-reset link for
// a user who lost access. The token is shown once, like an invite.
export function PasswordResetCard({ state }: { state: InvitationsState }) {
  const {
    issueReset,
    resetEmail,
    setResetEmail,
    setResetError,
    createReset,
    resetError,
    issuedReset,
    copyResetLink,
    resetCopied,
  } = state;
  return (
    <Card data-testid="card-password-reset">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-primary" aria-hidden="true" />
          Issue a password reset link
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Support path for a user who lost access: issues a one-time link (valid
          24 hours) that sets a new password and signs out every existing
          session. Share it out-of-band, like an invite.
        </p>
        <form onSubmit={issueReset} className="flex gap-2" noValidate>
          <Input
            type="email"
            required
            autoComplete="off"
            value={resetEmail}
            onChange={(e) => {
              setResetEmail(e.target.value);
              setResetError(null);
            }}
            placeholder="user@firm.com"
            aria-label="Email of the account to reset"
            data-testid="input-reset-email"
          />
          <Button
            type="submit"
            variant="outline"
            className="shrink-0"
            disabled={createReset.isPending}
            data-testid="button-issue-reset"
          >
            {createReset.isPending ? "Issuing…" : "Issue link"}
          </Button>
        </form>
        {resetError && (
          <p
            role="alert"
            className="text-sm text-destructive"
            data-testid="text-reset-error"
          >
            {resetError}
          </p>
        )}
        {issuedReset && (
          <div
            className="space-y-2 rounded-lg border border-amber-300 bg-amber-50/60 p-3 dark:border-amber-900 dark:bg-amber-950/40"
            role="status"
            aria-live="polite"
            data-testid="card-reset-token"
          >
            <p className="text-sm font-medium">
              One-time reset link for {issuedReset.email}
            </p>
            <p className="text-xs text-muted-foreground">
              Shown once — copy it now and share it with the user directly.
            </p>
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={issuedReset.link}
                onFocus={(e) => e.target.select()}
                className="font-mono text-xs"
                aria-label="One-time reset link"
                data-testid="input-reset-link"
              />
              <Button
                type="button"
                variant="outline"
                className="shrink-0"
                onClick={copyResetLink}
                data-testid="button-copy-reset-link"
              >
                {resetCopied ? (
                  <Check className="w-4 h-4" aria-hidden="true" />
                ) : (
                  <Copy className="w-4 h-4" aria-hidden="true" />
                )}
                {resetCopied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
