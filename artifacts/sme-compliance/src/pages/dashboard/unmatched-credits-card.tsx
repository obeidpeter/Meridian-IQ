import {
  useGetUnmatchedCredits,
  getGetUnmatchedCreditsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Wallet } from "lucide-react";
import { Link } from "wouter";
import { formatDate, formatNaira } from "@/lib/format";

// Unmatched credits (round-14 idea #1): bank credits with no invoice behind
// them — the compliance mirror of the unbilled card above. If any of these
// is a sale, an e-invoice should exist for it. Deterministic advisory,
// renders only when something needs looking at.
export function UnmatchedCreditsCard({
  clientPartyId,
}: {
  clientPartyId: string;
}) {
  const { data: credits, isSuccess } = useGetUnmatchedCredits(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetUnmatchedCreditsQueryKey({ clientPartyId }),
        staleTime: 5 * 60_000,
        retry: false,
      },
    },
  );
  if (!isSuccess || !credits || credits.count === 0) return null;
  return (
    <Card data-testid="unmatched-credits">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wallet className="w-5 h-5" aria-hidden="true" /> Money in with no
          invoice
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {credits.count} bank credit{credits.count === 1 ? "" : "s"} totalling{" "}
          {formatNaira(credits.totalAmount)} from the last {credits.windowDays}{" "}
          days match no invoice on the platform.
        </p>
        <div className="space-y-2">
          {credits.rows.slice(0, 5).map((r) => (
            <div
              key={r.lineId}
              className="flex items-center justify-between gap-3 rounded-lg border p-3"
              data-testid={`unmatched-credit-${r.lineId}`}
            >
              <div className="min-w-0">
                <p className="text-sm font-semibold truncate">
                  {r.counterpartyRef || r.narration || "Unnamed credit"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Received {formatDate(r.valueDate)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-medium tabular-nums text-sm">
                  {formatNaira(r.amount)}
                </span>
                <Button asChild size="sm" variant="secondary">
                  <Link href="/invoices/new">Raise invoice</Link>
                </Button>
              </div>
            </div>
          ))}
        </div>
        {(credits.truncated || credits.rows.length > 5) && (
          <p className="text-xs text-muted-foreground">
            Showing the largest — reconcile your statements to see the rest.
          </p>
        )}
        <p className="text-xs text-muted-foreground pt-3 border-t">
          {credits.note}
        </p>
      </CardContent>
    </Card>
  );
}
