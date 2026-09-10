import { Link } from "wouter";
import type { BulkConfirmationsResult } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FOCUS_RING } from "./constants";
import type { ConfirmationsPageState } from "./use-confirmations-page";

// The per-invoice report from the last bulk run. Takes the result itself
// (non-null by the time it renders) rather than the page bag.
export function BulkResultsCard({
  results,
  skippedItems,
  numbersById,
  onDismiss,
}: {
  results: BulkConfirmationsResult;
  skippedItems: ConfirmationsPageState["skippedItems"];
  numbersById: ConfirmationsPageState["numbersById"];
  onDismiss: () => void;
}) {
  return (
    <Card data-testid="card-bulk-results">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <CardTitle>Bulk confirmation results</CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDismiss}
            data-testid="button-dismiss-bulk-results"
          >
            Dismiss
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm" data-testid="text-bulk-outcome">
          <span className="font-semibold text-emerald-700 dark:text-emerald-400 tabular-nums">
            {results.confirmed} confirmed
          </span>
          {" · "}
          <span
            className={`tabular-nums ${
              results.skipped > 0
                ? "font-semibold text-amber-700 dark:text-amber-400"
                : "text-muted-foreground"
            }`}
          >
            {results.skipped} skipped
          </span>
        </p>
        {skippedItems.length > 0 && (
          <div className="rounded-md border divide-y">
            {skippedItems.map((item) => (
              <div
                key={item.invoiceId}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 p-3 text-sm"
                data-testid={`row-bulk-skipped-${item.invoiceId}`}
              >
                <Link
                  href={`/invoices/${item.invoiceId}`}
                  className={`font-medium text-primary hover:underline rounded-sm ${FOCUS_RING}`}
                  data-testid={`link-bulk-skipped-${item.invoiceId}`}
                >
                  {numbersById.get(item.invoiceId) ?? item.invoiceId}
                </Link>
                <p className="text-muted-foreground">
                  {item.reason ?? "Skipped"}
                </p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
