import {
  useListWhtCredits,
  getListWhtCreditsQueryKey,
} from "@workspace/api-client-react";
import type { WhtCredit } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { CapabilityGate } from "@/components/capability-gate";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { SkeletonList } from "@/components/skeleton-list";
import { usePageTitle } from "@/hooks/use-page-title";
import { formatDate, formatNaira, pillClasses } from "@/lib/format";
import {
  WHT_CATEGORY_LABELS,
  WHT_CREDIT_STATUS_LABELS,
  whtCategoryLabel,
  whtCreditStatusLabel,
} from "@workspace/format/wht-copy";
import { HandCoins } from "lucide-react";

// Read-only by design: the credit ledger is written by the firm (recording
// deductions and marking credit notes received on the console) and by the
// reconciliation short-pay path — this page only watches the record: which
// buyers withheld, how much, and which credit notes are still outstanding.
// The server pins a client_user to its own party (no clientPartyId is sent).
// The platform records the deduction evidence; it never claims or remits
// anything itself.

// ---- Display vocabulary (exported for tests) -------------------------------
// The words come from @workspace/format/wht-copy — the one home for the WHT
// category/status vocabulary shared with the console (and later mobile).
// Only the pill CLASSES stay per-app (tones are this app's design language).

export {
  WHT_CATEGORY_LABELS,
  WHT_CREDIT_STATUS_LABELS,
  whtCategoryLabel,
  whtCreditStatusLabel,
};

/** Awaiting reads amber (chase it), received emerald (evidence in hand). */
export function whtBadgeClasses(status: string): string {
  switch (status) {
    case "awaiting_note":
      return pillClasses("amber");
    case "note_received":
      return pillClasses("emerald");
    default:
      return pillClasses("slate");
  }
}

// ---- Page ------------------------------------------------------------------

function CreditRow({ credit }: { credit: WhtCredit }) {
  return (
    <tr data-testid={`row-wht-${credit.id}`}>
      <td className="py-2 pr-3 font-medium">{credit.invoiceNumber}</td>
      <td className="py-2 pr-3">{whtCategoryLabel(credit.category)}</td>
      <td className="py-2 pr-3 tabular-nums">{formatNaira(credit.amount)}</td>
      <td className="py-2 pr-3">{formatDate(credit.deductedDate)}</td>
      <td className="py-2">
        <span
          className={whtBadgeClasses(credit.status)}
          data-testid={`pill-wht-${credit.id}`}
        >
          {whtCreditStatusLabel(credit.status)}
        </span>
        {credit.noteReference && (
          <span className="text-xs text-muted-foreground ml-2">
            Ref {credit.noteReference}
          </span>
        )}
      </td>
    </tr>
  );
}

function WhtContent() {
  // The server pins a client_user to its own party — no clientPartyId is
  // sent.
  const { data, isLoading, isError, refetch } = useListWhtCredits(undefined, {
    query: { queryKey: getListWhtCreditsQueryKey() },
  });
  const credits = data?.credits ?? [];
  const totals = data?.totals;

  return (
    <div className="space-y-6">
      <PageHeader
        title="WHT credits"
        description="When a buyer withholds tax on one of your invoices, the deduction becomes a credit you can claim — once the buyer's credit note is in hand. Your firm records each deduction and note as the evidence arrives; the platform never claims or remits anything itself."
      />

      {isLoading ? (
        <SkeletonList count={5} itemClassName="h-12" />
      ) : isError ? (
        <QueryError thing="your WHT credits" onRetry={() => refetch()} />
      ) : credits.length === 0 ? (
        <Card>
          <EmptyState
            icon={HandCoins}
            title="No withholding credits yet"
            testId="text-wht-empty"
            description="When a buyer deducts WHT on one of your invoices, your firm records it here and chases the credit note on your behalf."
          />
        </Card>
      ) : (
        <>
          {totals && (
            <p className="text-sm font-medium" data-testid="text-wht-totals">
              <span
                className={
                  totals.awaitingNote > 0
                    ? "text-amber-700 dark:text-amber-400"
                    : ""
                }
              >
                {totals.awaitingNote} awaiting credit note (
                {formatNaira(totals.awaitingAmount)})
              </span>{" "}
              · {totals.noteReceived} received
            </p>
          )}
          <Card>
            <CardContent className="p-4 overflow-x-auto">
              <table className="w-full text-sm" data-testid="table-wht-credits">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Invoice</th>
                    <th className="py-2 pr-3 font-medium">Category</th>
                    <th className="py-2 pr-3 font-medium">Withheld</th>
                    <th className="py-2 pr-3 font-medium">Deducted</th>
                    <th className="py-2 font-medium">Credit note</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {credits.map((credit) => (
                    <CreditRow key={credit.id} credit={credit} />
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

export function Wht() {
  usePageTitle("WHT credits");
  // The same capability the server's GET /wht/credits asserts.
  return (
    <CapabilityGate capability="invoice.read">
      <WhtContent />
    </CapabilityGate>
  );
}
