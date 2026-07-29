import {
  useGetActionEffectiveness,
  getGetActionEffectivenessQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNaira } from "@/lib/format";
import { Activity } from "lucide-react";

// Action effectiveness (round 29): the accountability card under "Clerk
// suggests" — did the approved batches WORK? Decision-time tallies split
// auto vs hand-approved, the executed submissions re-read against their
// CURRENT rail status (a later rejection is surfaced, never buried), and
// the lowest-band s.104 exposure estimate the submissions removed. Pure
// ledger SQL server-side; renders only when the window holds decisions —
// a client with no action history shows nothing.
export function ClerkActionEffectivenessCard({
  clientPartyId,
}: {
  clientPartyId: string;
}) {
  const { data: report, isSuccess } = useGetActionEffectiveness(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetActionEffectivenessQueryKey({ clientPartyId }),
        staleTime: 5 * 60_000,
        retry: false,
      },
    },
  );
  if (!isSuccess || !report || report.totals.decisions === 0) return null;
  const exposureCleared = Number(report.exposureFloorClearedNgn);

  return (
    <Card data-testid="card-action-effectiveness">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="w-5 h-5" aria-hidden="true" /> Did the batches
          work?
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm" data-testid="text-effectiveness-summary">
          {report.totals.decisions} decision
          {report.totals.decisions === 1 ? "" : "s"} in the last{" "}
          {report.windowDays} days — {report.totals.autoDecisions} ran
          automatically · {report.totals.executed} executed ·{" "}
          {report.totals.failed} failed at decision time.
        </p>
        <div className="space-y-2 text-xs text-muted-foreground">
          {report.kinds.map((k) => (
            <div key={k.kind} data-testid={`effectiveness-${k.kind}`}>
              <p>
                <span className="font-medium text-foreground">{k.kind}</span> ·{" "}
                {k.decisions} decision{k.decisions === 1 ? "" : "s"}
                {k.autoDecisions > 0 ? ` (${k.autoDecisions} auto)` : ""} ·{" "}
                {k.executed} executed · {k.skipped} skipped · {k.failed} failed
              </p>
              {/* Submit kinds only: where the executed targets stand NOW. */}
              {k.nowSucceeded !== null && k.executed > 0 && (
                <p data-testid={`effectiveness-now-${k.kind}`}>
                  now: {k.nowSucceeded} stamped or beyond · {k.nowInFlight} in
                  flight · {k.nowFailedAgain} failed again
                  {k.nowOther ? ` · ${k.nowOther} other` : ""}
                </p>
              )}
            </div>
          ))}
        </div>
        {exposureCleared > 0 && (
          <p
            className="text-xs text-muted-foreground border-t pt-3"
            data-testid="text-effectiveness-exposure"
          >
            Estimated s.104 exposure floor removed by the window&apos;s
            submissions: {formatNaira(exposureCleared)} (lowest band — an
            estimate under MeridianIQ&apos;s published penalty model, not
            advice). Drafted reminders are audited by the reminder
            effectiveness report, not here.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
