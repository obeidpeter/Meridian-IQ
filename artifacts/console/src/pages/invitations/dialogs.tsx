import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { InvitationsState } from "./use-invitations";

// Dismissing an uncopied one-time link needs an explicit acknowledgement.
export function DismissTokenDialog({ state }: { state: InvitationsState }) {
  const { confirmDismiss, setConfirmDismiss, created, setCreated } = state;
  return (
    <AlertDialog open={confirmDismiss} onOpenChange={setConfirmDismiss}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Dismiss the invite link for {created?.invitation.email}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This link is shown once and cannot be retrieved again. If it was
            never shared, the invitation sits as Pending until it expires — you
            would have to revoke it and create a new link.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => setCreated(null)}
            data-testid="button-confirm-dismiss-token"
          >
            Dismiss link
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// Confirm-before-revoke (and the revoke-then-prefill "New link" path).
export function RevokeDialog({ state }: { state: InvitationsState }) {
  const { revokeTarget, setRevokeTarget, revoke, runRevoke } = state;
  return (
    <AlertDialog
      open={revokeTarget !== null}
      onOpenChange={(open) => {
        if (!open) setRevokeTarget(null);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {revokeTarget?.replace
              ? `Create a new link for ${revokeTarget?.invitation.email}?`
              : `Revoke the invitation to ${revokeTarget?.invitation.email}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {revokeTarget?.replace
              ? "This revokes the current invitation first. Its link stops working immediately. The invitation form is then filled in so you can create a new link."
              : "The invitation link stops working immediately. To invite them again, create a new invitation."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={revoke.isPending}
            onClick={() =>
              revokeTarget &&
              runRevoke(revokeTarget.invitation, revokeTarget.replace)
            }
            data-testid="button-confirm-revoke"
          >
            {revoke.isPending
              ? "Revoking…"
              : revokeTarget?.replace
                ? "Revoke old link"
                : "Revoke invitation"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
