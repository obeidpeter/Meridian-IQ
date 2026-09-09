import {
  useListUnbilledIncome,
  getListUnbilledIncomeQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Wallet } from "lucide-react";
import { Link } from "wouter";
import { formatAmount, formatDate } from "@/lib/format";

// Unbilled-income nudges (round-8 idea #1): buyers this client bills every
// month where the usual billing day has passed with nothing issued. Mined
// deterministically server-side from the client's own history — nothing
// stored, no model. Renders only when there is something to say.
export function UnbilledIncomeCard({
  clientPartyId,
}: {
  clientPartyId: string;
}) {
  const { data: alerts, isSuccess } = useListUnbilledIncome(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getListUnbilledIncomeQueryKey({ clientPartyId }),
        retry: false,
      },
    },
  );
  if (!isSuccess || !alerts || alerts.length === 0) return null;
  return (
    <Card data-testid="unbilled-income">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wallet className="w-5 h-5" aria-hidden="true" /> Money you usually
          bill
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Based on your own invoice history, these regular invoices look
          unraised this cycle.
        </p>
        <div className="space-y-2">
          {alerts.map((a) => (
            <div
              key={`${a.buyerPartyId}-${a.currency}`}
              className="flex items-center justify-between gap-3 rounded-lg border p-3"
              data-testid={`unbilled-${a.buyerPartyId}-${a.currency}`}
            >
              <div className="min-w-0">
                <p className="text-sm font-semibold truncate">{a.buyerName}</p>
                <p className="text-xs text-muted-foreground">
                  Usually about {formatAmount(a.medianAmount, a.currency)} every
                  ~{a.medianGapDays} days · last invoiced{" "}
                  {formatDate(a.lastIssueDate)}
                </p>
              </div>
              <Button asChild size="sm" variant="secondary">
                <Link href="/invoices/new">Draft invoice</Link>
              </Button>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground pt-3 border-t">
          Worked out from your own invoices — if an arrangement ended, you can
          ignore this.
        </p>
      </CardContent>
    </Card>
  );
}
