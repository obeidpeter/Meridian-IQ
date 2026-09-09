import {
  useGetPenaltyExposure,
  getGetPenaltyExposureQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ClerkActionsCard } from "@/components/clerk-actions-card";
import { AlertTriangle } from "lucide-react";
import { formatDate, formatNaira } from "@/lib/format";

// Penalty exposure (round 18): what the overdue paper could cost under
// Valo's published s.104 model. Renders only when something is
// overdue; always the SMALL-band floor ("at least"), never a scare figure —
// and the fix is stated: submit the paper, the exposure goes away.
export function PenaltyExposureCard({
  clientPartyId,
}: {
  clientPartyId: string;
}) {
  const { data: exposure, isSuccess } = useGetPenaltyExposure(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetPenaltyExposureQueryKey({ clientPartyId }),
        retry: false,
      },
    },
  );
  if (!isSuccess || !exposure || exposure.overdueCount === 0) return null;
  return (
    <Card
      className="border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40"
      data-testid="penalty-exposure"
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-amber-800 dark:text-amber-300">
          <AlertTriangle className="w-5 h-5" aria-hidden="true" /> Estimated
          penalty exposure
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-amber-800 dark:text-amber-300">
        <p className="text-sm">
          {exposure.overdueCount} invoice
          {exposure.overdueCount === 1 ? " is" : "s are"} past the statutory
          submission window — at least{" "}
          <span className="font-semibold" data-testid="text-penalty-floor">
            {formatNaira(exposure.exposure.small)}
          </span>{" "}
          of potential s.104 exposure at the lowest turnover band (
          {formatNaira(exposure.perInvoice.small)} per invoice; higher bands
          reach {formatNaira(exposure.exposure.large)}).
        </p>
        {exposure.sampleInvoices.length > 0 && (
          <div className="space-y-1 text-xs">
            {exposure.sampleInvoices.map((s) => (
              <p
                key={s.invoiceId}
                data-testid={`penalty-invoice-${s.invoiceId}`}
              >
                {s.invoiceNumber} · issued {formatDate(s.issueDate)} ·{" "}
                {s.daysOverdue} day{s.daysOverdue === 1 ? "" : "s"} past the
                window
              </p>
            ))}
          </div>
        )}
        <p className="text-sm font-medium">
          Submitting the overdue invoices removes this exposure.
        </p>
        <p className="text-xs">
          An estimate under Valo&apos;s published penalty model — not legal or
          tax advice. As of {formatDate(exposure.asOf)}.
        </p>
      </CardContent>
    </Card>
  );
}

// Proposed actions (round 21): the "Clerk suggests" card lives in
// components/clerk-actions-card.tsx (mirroring its console twin's
// placement). Re-exported here so the card's existing import sites —
// dashboard-clerk-actions.test.tsx pins it from this page module — keep
// working unchanged.
export { ClerkActionsCard };
