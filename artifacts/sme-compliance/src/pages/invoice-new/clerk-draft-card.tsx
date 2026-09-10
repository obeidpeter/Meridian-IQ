import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Sparkles } from "lucide-react";
import type { InvoiceNewFormState } from "./use-invoice-new-form";

/**
 * "Draft with Clerk": one sentence prefills the same form below; nothing is
 * created until the user clicks "Create invoice". The `clerkLit &&` gate
 * stays in the shell.
 */
export function ClerkDraftCard({
  clerkText,
  setClerkText,
  onDraft,
  pending,
  note,
}: Pick<InvoiceNewFormState, "clerkText" | "setClerkText"> & {
  onDraft: () => void;
  pending: boolean;
  note: string | null;
}) {
  return (
    <Card className="border-violet-200 dark:border-violet-900">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Sparkles
            className="w-4 h-4 text-violet-600 dark:text-violet-400"
            aria-hidden="true"
          />
          Draft with Clerk
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Label htmlFor="clerk-draft-text" className="sr-only">
          Describe the invoice
        </Label>
        <Textarea
          id="clerk-draft-text"
          value={clerkText}
          onChange={(e) => setClerkText(e.target.value)}
          rows={2}
          placeholder='e.g. "Invoice Adaeze Foods ₦150,000 for June deliveries, 7.5% VAT"'
          data-testid="input-clerk-draft"
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Clerk prefills the form below — you review and save; nothing is
            created until you do.
          </p>
          <Button
            variant="outline"
            onClick={onDraft}
            disabled={clerkText.trim().length < 5 || pending}
            data-testid="button-clerk-draft"
          >
            {pending ? "Drafting…" : "Draft it"}
          </Button>
        </div>
        <p
          role="status"
          className="text-xs text-violet-800 dark:text-violet-300"
          data-testid="text-clerk-note"
        >
          {note}
        </p>
      </CardContent>
    </Card>
  );
}
