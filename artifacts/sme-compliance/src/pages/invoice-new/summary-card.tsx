import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ReadinessList } from "@workspace/web-ui";
import { formatAmount } from "@/lib/format";
import { ShieldCheck } from "lucide-react";
import type { InvoiceNewFormState } from "./use-invoice-new-form";

/** The sticky "Ready to create?" card: readiness rail, totals, the submit. */
export function ReadinessSummaryCard({
  checklist,
  totals,
  currency,
  submitting,
  conflict,
  onSubmit,
  showErrors,
  isValid,
}: Pick<
  InvoiceNewFormState,
  "checklist" | "totals" | "submitting" | "showErrors" | "isValid"
> & {
  currency: string;
  conflict: boolean;
  onSubmit: () => void;
}) {
  return (
    <Card className="lg:sticky lg:top-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2.5 text-base">
          <span className="mi-card-icon">
            <ShieldCheck aria-hidden="true" />
          </span>
          Ready to create?
        </CardTitle>
        <CardDescription>
          Checked against FIRS rules as you type.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ReadinessList steps={checklist} />
        <div className="border-t pt-3 space-y-1 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Net</span>
            <span className="tabular-nums">
              {formatAmount(totals.net, currency)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">VAT</span>
            <span className="tabular-nums">
              {formatAmount(totals.vat, currency)}
            </span>
          </div>
          <div className="flex justify-between font-semibold">
            <span>Total</span>
            <span className="tabular-nums">
              {formatAmount(totals.total, currency)}
            </span>
          </div>
        </div>
        <Button
          className="w-full"
          onClick={onSubmit}
          disabled={submitting || conflict}
        >
          {submitting ? "Saving…" : "Create invoice"}
        </Button>
        {showErrors && !isValid && (
          <p className="text-sm text-destructive text-center" role="alert">
            Fix the highlighted fields to continue.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
