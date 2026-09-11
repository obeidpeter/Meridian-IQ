import type { InvitationWithToken } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { roleLabel } from "@/components/capability-gate";
import { formatDateTime } from "@/lib/format";
import { Copy, Check, KeyRound, AlertTriangle, X } from "lucide-react";
import type { InvitationsState } from "./use-invitations";

// The ONE-TIME token card shown after a create: the accept link, the raw
// token and the dismiss control. `created` is the shell's narrowed result.
export function InviteTokenCard({
  state,
  created,
}: {
  state: InvitationsState;
  created: InvitationWithToken;
}) {
  const {
    linkCopied,
    setCreated,
    setConfirmDismiss,
    acceptLink,
    copyLink,
    copied,
  } = state;
  return (
    <Card
      className="border-amber-300 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/40"
      data-testid="card-invite-token"
      role="status"
      aria-live="polite"
    >
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base text-amber-900 dark:text-amber-200">
          <KeyRound className="w-4 h-4" aria-hidden="true" />
          Invitation for {created.invitation.email}
        </CardTitle>
        <button
          type="button"
          onClick={() =>
            linkCopied ? setCreated(null) : setConfirmDismiss(true)
          }
          aria-label="Dismiss invitation link"
          className="rounded-md p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="button-dismiss-token"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="flex items-start gap-2 text-sm font-medium text-amber-900 dark:text-amber-200">
          <AlertTriangle
            className="w-4 h-4 mt-0.5 shrink-0"
            aria-hidden="true"
          />
          This link is shown once — copy it now. The token cannot be retrieved
          again.
        </p>

        <div className="space-y-1.5">
          <Label htmlFor="invite-accept-link">Invitation link</Label>
          <div className="flex gap-2">
            <Input
              id="invite-accept-link"
              readOnly
              value={acceptLink}
              onFocus={(e) => e.currentTarget.select()}
              className="font-mono text-xs"
              data-testid="input-accept-link"
            />
            <Button
              type="button"
              variant="secondary"
              onClick={copyLink}
              data-testid="button-copy-link"
            >
              {copied ? (
                <>
                  <Check className="w-4 h-4 mr-1" aria-hidden="true" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4 mr-1" aria-hidden="true" />
                  Copy link
                </>
              )}
            </Button>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="invite-token">One-time token</Label>
          <Input
            id="invite-token"
            readOnly
            value={created.token}
            onFocus={(e) => e.currentTarget.select()}
            className="font-mono text-xs"
            data-testid="text-token"
          />
        </div>

        <p className="text-xs text-amber-900/80 dark:text-amber-200/80">
          Share it with {created.invitation.email}. They set a password at the
          link to join as {roleLabel(created.invitation.role)}. It expires{" "}
          {formatDateTime(created.invitation.expiresAt)}.
        </p>
      </CardContent>
    </Card>
  );
}
