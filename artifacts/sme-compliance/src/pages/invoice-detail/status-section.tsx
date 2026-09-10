// The invoice detail page's status block (R126 moved it out of the page
// shell): the compliance light, the maker-checker ledger, the draft-time
// rejection risk, the FIRS stamp and the chase-payment card, in the shell's
// original order.
import type { Invoice, StampRecord } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RejectionRiskCard } from "@/components/rejection-risk-card";
import { ApprovalsCard } from "@/components/invoice-approvals";
import { ShieldCheck } from "lucide-react";
import { IRN_EXPANSION, CSID_EXPANSION } from "@/lib/format";
import { ComplianceStatusCard } from "./compliance-status-card";
import { PaymentReminderCard } from "./payment-reminder-card";
import type { InvoiceAbilities } from "./abilities";
import type { InvoiceDetailState } from "./use-invoice-detail";

export function StatusSection({
  state,
  invoice,
  abilities,
}: {
  state: InvoiceDetailState;
  invoice: Invoice;
  abilities: InvoiceAbilities;
}) {
  const {
    id,
    me,
    statusLight,
    statusLightLoading,
    riskEligible,
    rejectionRisk,
    stampedFamily,
    stamp,
  } = state;
  const { canClerkExplain } = abilities;
  return (
    <>
      <ComplianceStatusCard
        statusLight={statusLight}
        isLoading={statusLightLoading}
      />

      {/* Maker-checker ledger: informational for client users, actionable
          for firm roles while the invoice is still submittable. */}
      <ApprovalsCard
        invoiceId={id}
        role={me?.role}
        status={invoice.status}
        contentRevision={invoice.contentRevision}
      />

      {/* Advisory only, gated on the same still-editable statuses as the
          query so a cached report never outlives a submission. */}
      {riskEligible && rejectionRisk && (
        <RejectionRiskCard report={rejectionRisk} />
      )}

      {stampedFamily && stamp && <StampCard stamp={stamp} />}

      {/* Chase-payment card: the receivables definition exactly — issued to
          the buyer, payment not yet observed. Same capability as the other
          Clerk phrasings on this page. */}
      {canClerkExplain &&
        invoice.kind === "invoice" &&
        ["submitted", "stamped", "confirmed"].includes(invoice.status) && (
          <PaymentReminderCard invoice={invoice} />
        )}
    </>
  );
}

export function StampCard({ stamp }: { stamp: StampRecord }) {
  return (
    <Card className="border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-emerald-800 dark:text-emerald-300">
          <ShieldCheck className="w-4 h-4" aria-hidden="true" /> FIRS stamped
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm space-y-1">
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">IRN ({IRN_EXPANSION})</span>
          <span className="font-mono text-xs break-all text-right">
            {stamp.irn}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">CSID ({CSID_EXPANSION})</span>
          <span className="font-mono text-xs break-all text-right">
            {stamp.csid}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
