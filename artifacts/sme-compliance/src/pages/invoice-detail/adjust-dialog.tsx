import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Reason-first cancel / credit-note dialog. Controlled by the parent, which
// owns the kind/reason state, the mutations, and their toasts/invalidations.
export function AdjustDialog({
  kind,
  reason,
  onReasonChange,
  onClose,
  onConfirm,
  isPending,
}: {
  kind: "cancel" | "credit" | null;
  reason: string;
  onReasonChange: (reason: string) => void;
  onClose: () => void;
  onConfirm: () => void;
  isPending: boolean;
}) {
  return (
    <Dialog
      open={kind !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {kind === "cancel" ? "Cancel this invoice" : "Issue a credit note"}
          </DialogTitle>
          <DialogDescription>
            {kind === "cancel"
              ? "Cancellation is a recorded lifecycle event. A cancelled invoice can never be presented as eligible again."
              : "A credit note referencing this invoice is created and submitted for stamping. Once stamped, this invoice becomes Credited — a terminal, recorded state."}
          </DialogDescription>
        </DialogHeader>
        <div>
          <Label htmlFor="adjust-reason" className="sr-only">
            Reason
          </Label>
          <Textarea
            id="adjust-reason"
            placeholder="Reason (required — it is recorded on the ledger)"
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
            data-testid="input-adjust-reason"
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Keep invoice
          </Button>
          <Button
            variant={kind === "cancel" ? "destructive" : "default"}
            disabled={!reason.trim() || isPending}
            onClick={onConfirm}
            data-testid="button-confirm-adjust"
          >
            {isPending
              ? "Working…"
              : kind === "cancel"
                ? "Cancel invoice"
                : "Issue credit note"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
