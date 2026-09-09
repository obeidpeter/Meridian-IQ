import {
  useGetNetCashPosition,
  getGetNetCashPositionQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity } from "lucide-react";
import { formatNaira } from "@/lib/format";
import { weekLabel } from "./helpers";

// Net cash position (round-15 idea #2): projected inflows minus committed
// bill outflows per week — the outlook and the payables card merged into
// the number the owner actually wants. Squeeze weeks are flagged, never
// predicted as failure.
export function NetPositionCard({ clientPartyId }: { clientPartyId: string }) {
  const { data: position, isSuccess } = useGetNetCashPosition(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetNetCashPositionQueryKey({ clientPartyId }),
        staleTime: 5 * 60_000,
        retry: false,
      },
    },
  );
  const group = position?.groups[0];
  if (!isSuccess || !group) return null;
  const hasMovement = group.weeks.some(
    (w) => w.inflowCount > 0 || w.outflowCount > 0,
  );
  if (!hasMovement) return null;
  return (
    <Card data-testid="net-position">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="w-5 h-5" aria-hidden="true" /> Net cash position
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {group.weeks.map((w, i) => (
          <div
            key={w.startDate}
            className={`flex items-center justify-between gap-3 rounded-lg p-2 ${
              w.squeeze
                ? "border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40"
                : ""
            }`}
            data-testid={`net-week-${i}`}
          >
            <span className="text-muted-foreground">
              {weekLabel(i)}
              <span className="text-xs">
                {" "}
                · in {formatNaira(w.inflow)} · out {formatNaira(w.outflow)}
              </span>
            </span>
            <span
              className={`font-semibold tabular-nums ${
                Number(w.net) < 0 ? "text-amber-800 dark:text-amber-300" : ""
              }`}
            >
              {formatNaira(w.net)}
            </span>
          </div>
        ))}
        {(group.overdueInflow.count > 0 || group.overdueOutflow.count > 0) && (
          <p className="text-xs text-muted-foreground">
            Outside these weeks: {formatNaira(group.overdueInflow.amount)}{" "}
            expected but already late,{" "}
            {formatNaira(group.overdueOutflow.amount)} in bills already overdue.
          </p>
        )}
        <p className="text-xs text-muted-foreground pt-3 border-t">
          {position.note} {group.currency} only
          {position.groups.length > 1 ? " (other currencies not shown)" : ""}.
        </p>
      </CardContent>
    </Card>
  );
}
