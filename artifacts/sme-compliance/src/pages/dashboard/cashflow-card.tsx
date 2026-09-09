import {
  useGetCashflowOutlook,
  getGetCashflowOutlookQueryKey,
  useGetProjectionAccuracy,
  getGetProjectionAccuracyQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity } from "lucide-react";
import { formatNaira } from "@/lib/format";
import { weekLabel } from "./helpers";

// Cash-flow outlook (round-10 idea #1): expected inflows by week, projected
// server-side from each buyer's own payment rhythm (falling back to due
// dates / standard terms). Deterministic, renders only when there is money
// outstanding.
export function CashflowCard({ clientPartyId }: { clientPartyId: string }) {
  // Projection accuracy (round-14 idea #2): the forecast auditing itself —
  // a confidence line under the outlook when enough settlements exist.
  const { data: accuracy } = useGetProjectionAccuracy(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetProjectionAccuracyQueryKey({ clientPartyId }),
        staleTime: 5 * 60_000,
        retry: false,
      },
    },
  );
  const { data: outlook, isSuccess } = useGetCashflowOutlook(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetCashflowOutlookQueryKey({ clientPartyId }),
        staleTime: 5 * 60_000,
        retry: false,
      },
    },
  );
  const group = outlook?.groups[0];
  if (!isSuccess || !group || group.total.count === 0) return null;
  return (
    <Card data-testid="cashflow-outlook">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="w-5 h-5" aria-hidden="true" /> Expected inflows
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {group.overdueExpected.count > 0 && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 p-2.5 dark:border-amber-900 dark:bg-amber-950/40">
            <span className="text-amber-800 dark:text-amber-300">
              Already past expected ({group.overdueExpected.count} inv)
            </span>
            <span className="font-semibold tabular-nums text-amber-800 dark:text-amber-300">
              {formatNaira(group.overdueExpected.amount)}
            </span>
          </div>
        )}
        {group.weeks.map((w, i) => (
          <div
            key={w.startDate}
            className="flex items-center justify-between gap-3"
          >
            <span className="text-muted-foreground">
              {weekLabel(i)}
              <span className="text-xs"> · {w.count} inv</span>
            </span>
            <span className="font-medium tabular-nums">
              {formatNaira(w.amount)}
            </span>
          </div>
        ))}
        {group.later.count > 0 && (
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">
              Later <span className="text-xs">· {group.later.count} inv</span>
            </span>
            <span className="font-medium tabular-nums">
              {formatNaira(group.later.amount)}
            </span>
          </div>
        )}
        <p className="text-xs text-muted-foreground pt-3 border-t">
          Projected from each customer&apos;s own payment history where we have
          one, otherwise due dates. {group.currency} only
          {outlook.groups.length > 1 ? " (other currencies not shown)" : ""}.
          {accuracy &&
            accuracy.settlements >= 5 &&
            accuracy.medianAbsErrorDays != null && (
              <span data-testid="projection-accuracy">
                {" "}
                Past projections have landed within about ±
                {Math.round(accuracy.medianAbsErrorDays)} day
                {Math.round(accuracy.medianAbsErrorDays) === 1 ? "" : "s"} of
                actual payment ({accuracy.settlements} matched payments).
              </span>
            )}
        </p>
      </CardContent>
    </Card>
  );
}
