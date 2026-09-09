import { type FieldError as ApiFieldError } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Wrench } from "lucide-react";

// SME-01 error recovery: a failed draft validation must outlive the toast.
// The full FieldError list renders as a persistent card (same row recipe as
// the vault's bulk-submit "Needs attention" list) with the fix path attached.
// Exported for the component tests, like ApprovalsCard.
export function ValidationErrorsCard({
  errors,
  onFix,
  showFixButton,
}: {
  errors: ApiFieldError[];
  onFix: () => void;
  showFixButton: boolean;
}) {
  if (errors.length === 0) return null;
  // buyer.*/supplier.* fields live on the party records, not on this invoice
  // — the fix form cannot correct them, so say where they are fixed.
  const partyFieldFlagged = errors.some(
    (e) => e.field.startsWith("buyer.") || e.field.startsWith("supplier."),
  );
  return (
    <Card
      className="border-destructive/30 bg-destructive/5"
      data-testid="card-validation-errors"
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-destructive">
          <AlertTriangle className="w-4 h-4" aria-hidden="true" /> Validation
          failed — {errors.length} {errors.length === 1 ? "issue" : "issues"} to
          fix
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Nothing was submitted — the invoice stays a draft until every issue
          below is fixed.
        </p>
        <ul className="space-y-2">
          {errors.map((err, i) => (
            <li
              key={`${err.field}-${i}`}
              className="text-sm border border-destructive/40 bg-destructive/5 rounded-md px-3 py-2"
              data-testid={`row-validation-error-${i}`}
            >
              <p className="text-xs text-destructive">
                {err.field}: {err.message}
              </p>
            </li>
          ))}
        </ul>
        {partyFieldFlagged && (
          <p className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40 p-2 text-amber-800 dark:text-amber-300">
            Issues with customer or business details live on the customer or
            business record, not on this invoice — ask your firm to correct the
            record, then submit again.
          </p>
        )}
        {showFixButton && (
          <Button size="sm" onClick={onFix} data-testid="button-fix-draft">
            <Wrench className="w-4 h-4 mr-2" aria-hidden="true" /> Fix invoice
            details
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
