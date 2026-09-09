import {
  useGetChaseList,
  getGetChaseListQueryKey,
  useGetChaseEffectiveness,
  getGetChaseEffectivenessQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Clock } from "lucide-react";
import { Link } from "wouter";
import { formatDate, formatNaira } from "@/lib/format";

// Chase list (round-10 idea #2): the receivables most worth chasing this
// week — ranked by days beyond each buyer's OWN expected payment date, not
// raw age. Each row opens the invoice, where the reminder-draft button is.
export function ChaseListCard({ clientPartyId }: { clientPartyId: string }) {
  const { data: rows, isSuccess } = useGetChaseList(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetChaseListQueryKey({ clientPartyId }),
        staleTime: 5 * 60_000,
        retry: false,
      },
    },
  );
  // Reminder effectiveness (round 16): what past reminders actually did,
  // joined from the chase ladder and observed payments. Shown only once the
  // share clears its server-side sample floor.
  const { data: effectiveness } = useGetChaseEffectiveness(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetChaseEffectivenessQueryKey({ clientPartyId }),
        staleTime: 5 * 60_000,
        retry: false,
      },
    },
  );
  if (!isSuccess || !rows || rows.length === 0) return null;
  return (
    <Card data-testid="chase-list">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock className="w-5 h-5" aria-hidden="true" /> Worth chasing
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.map((r) => (
          <div
            key={r.invoiceId}
            className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm"
            data-testid={`chase-${r.invoiceId}`}
          >
            <div className="min-w-0">
              <p className="font-semibold truncate">{r.buyerName}</p>
              <p className="text-xs text-muted-foreground">
                {r.invoiceNumber} ·{" "}
                {r.currency === "NGN"
                  ? formatNaira(r.grandTotal)
                  : `${r.currency} ${r.grandTotal}`}{" "}
                · {r.daysBeyondExpected}d{" "}
                {r.basis === "rhythm"
                  ? "beyond their usual"
                  : r.basis === "dueDate"
                    ? "past due"
                    : "past standard terms"}
                {r.basis === "rhythm" && r.dueDate
                  ? ` · was due ${formatDate(r.dueDate)}`
                  : ""}
              </p>
            </div>
            <Button asChild size="sm" variant="secondary">
              <Link href={`/invoices/${r.invoiceId}`}>Chase</Link>
            </Button>
          </div>
        ))}
        <p className="text-xs text-muted-foreground pt-3 border-t">
          Ranked by how far each invoice is past that customer&apos;s own
          payment rhythm. Open one to draft a reminder.
          {effectiveness && effectiveness.settledWithinShare != null && (
            <span data-testid="chase-effectiveness">
              {" "}
              Of your past reminders,{" "}
              {Math.round(effectiveness.settledWithinShare * 100)}% were
              followed by payment within {effectiveness.withinDays} days
              {effectiveness.medianDaysReminderToSettle != null
                ? ` (typically ${Math.round(effectiveness.medianDaysReminderToSettle)} days after the reminder)`
                : ""}
              .
            </span>
          )}
        </p>
      </CardContent>
    </Card>
  );
}
