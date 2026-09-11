import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { OFFBOARD_EXPLANATION, offboardConfirmReady } from "./helpers";
import type { ClientDetailState } from "./use-client-detail";

// The typed-name offboard confirm (firm_admin only): the dialog only requires
// non-blank; exact matching is the server's 400 CONFIRM_MISMATCH.
export function OffboardClientDialog({
  state,
  legalName,
}: {
  state: ClientDetailState;
  legalName: string;
}) {
  const {
    offboard,
    offboardOpen,
    setOffboardOpen,
    confirmText,
    setConfirmText,
    offboardNote,
    handleOffboard,
  } = state;
  return (
    <Dialog
      open={offboardOpen}
      onOpenChange={(o) => {
        if (!o) setOffboardOpen(false);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>End the engagement with {legalName}?</DialogTitle>
          <DialogDescription>{OFFBOARD_EXPLANATION}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="offboard-confirm">
            Type the client's legal name to confirm
          </Label>
          <Input
            id="offboard-confirm"
            value={confirmText}
            autoComplete="off"
            placeholder={legalName}
            onChange={(e) => setConfirmText(e.target.value)}
            aria-invalid={offboardNote !== null}
            aria-describedby={
              offboardNote !== null ? "offboard-confirm-error" : undefined
            }
            data-testid="input-offboard-confirm"
          />
          {offboardNote && (
            <p
              id="offboard-confirm-error"
              className="text-sm text-destructive"
              role="alert"
              data-testid="text-offboard-error"
            >
              {offboardNote}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOffboardOpen(false)}
            disabled={offboard.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleOffboard}
            disabled={!offboardConfirmReady(confirmText) || offboard.isPending}
            data-testid="button-confirm-offboard"
          >
            {offboard.isPending ? "Ending engagement…" : "End engagement"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
