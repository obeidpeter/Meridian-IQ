import { useState } from "react";
import { logout, useRevokeSessions } from "@workspace/api-client-react";
import type { Me } from "@workspace/api-client-react";
import { signOutAndRedirect, trackUsabilityEvent } from "@workspace/web-ui";
import {
  ArrowRight,
  Loader2,
  LogOut,
  ShieldCheck,
  ShieldOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { serverErrorFrom } from "@/lib/errors";
import { defaultWorkspaceFor } from "@/lib/return-to";
import { ChangePasswordForm } from "./change-password-form";
import { roleLabel } from "./tiles";
import { TotpSecurityCard } from "./totp-security-card";

export function SignedInPanel({ me }: { me: Me }) {
  const revokeSessions = useRevokeSessions();
  const [signingOut, setSigningOut] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const target = defaultWorkspaceFor(me);

  const signOut = async () => {
    setSigningOut(true);
    await signOutAndRedirect((signal) => logout({ signal }));
  };

  const signOutEverywhere = async () => {
    setRevokeError(null);
    try {
      await revokeSessions.mutateAsync();
      trackUsabilityEvent("sessions_revoked", "account_security");
      await signOutAndRedirect(() => Promise.resolve());
    } catch (error) {
      setRevokeError(
        serverErrorFrom(error) ??
          "Could not sign out every device. Your current session is still active.",
      );
    }
  };

  return (
    <Card className="p-6 shadow-sm" data-testid="panel-signed-in">
      <div className="flex items-center gap-2">
        <ShieldCheck
          className="h-5 w-5 text-teal-600 dark:text-teal-400"
          aria-hidden="true"
        />
        <h2 className="text-lg font-semibold">Signed in</h2>
      </div>
      <div className="mt-3 rounded-lg bg-muted/60 p-3">
        <p className="text-sm font-medium" data-testid="text-account-name">
          {me.fullName ?? me.email ?? "Your account"}
        </p>
        <p
          className="text-xs text-muted-foreground"
          data-testid="text-account-detail"
        >
          {me.email ? `${me.email} · ` : ""}
          {roleLabel(me.role)}
        </p>
        <ChangePasswordForm />
      </div>
      <TotpSecurityCard />
      <p className="mt-3 text-sm text-muted-foreground">
        Open your workspace below, or sign out to switch accounts.
      </p>
      <div className="mt-4 space-y-2">
        {target && (
          <Button asChild className="w-full">
            <a href={target.href} data-testid="link-default-workspace">
              Open {target.label}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </a>
          </Button>
        )}
        <Button
          variant="secondary"
          className="w-full"
          id="sign-out"
          onClick={signOut}
          disabled={signingOut}
          data-testid="button-sign-out"
        >
          {signingOut ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <LogOut className="h-4 w-4" aria-hidden="true" />
          )}
          Sign out
        </Button>
        {!confirmRevoke ? (
          <Button
            variant="ghost"
            className="w-full text-slate-600"
            onClick={() => {
              setRevokeError(null);
              setConfirmRevoke(true);
            }}
            data-testid="button-revoke-sessions"
          >
            <ShieldOff className="h-4 w-4" aria-hidden="true" />
            Sign out every device
          </Button>
        ) : (
          <div
            className="rounded-md border border-red-200 bg-red-50 p-3"
            role="group"
            aria-label="Confirm session revocation"
          >
            <p className="text-xs font-semibold text-red-900">
              This immediately ends every browser and mobile session, including
              this one.
            </p>
            {revokeError && (
              <p className="mt-2 text-xs text-red-800" role="alert">
                {revokeError}
              </p>
            )}
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                variant="destructive"
                onClick={() => void signOutEverywhere()}
                disabled={revokeSessions.isPending}
              >
                {revokeSessions.isPending ? (
                  <Loader2
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : null}
                Sign out all
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setConfirmRevoke(false);
                  setRevokeError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
