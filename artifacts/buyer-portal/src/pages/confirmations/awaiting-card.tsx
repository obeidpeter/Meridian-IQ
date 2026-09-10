import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatNaira } from "@/lib/format";
import type { ConfirmationsPageState } from "./use-confirmations-page";

export function AwaitingCard({ state }: { state: ConfirmationsPageState }) {
  const { awaitingCount, awaitingTotal, setFilter, setPage, setServerPage } =
    state;
  return (
    <Card
      className="border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/40"
      data-testid="card-awaiting"
    >
      <CardHeader>
        <CardTitle className="text-base text-amber-900 dark:text-amber-300">
          {awaitingCount}{" "}
          {awaitingCount === 1 ? "invoice needs" : "invoices need"} your
          response
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-amber-900/80 dark:text-amber-300/80">
          <span className="font-semibold tabular-nums">
            {formatNaira(awaitingTotal)}
          </span>{" "}
          of input VAT-bearing spend is awaiting your confirmation.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setFilter("requested");
            setPage(1);
            setServerPage(0);
          }}
          data-testid="button-view-awaiting"
        >
          View requested
        </Button>
      </CardContent>
    </Card>
  );
}
