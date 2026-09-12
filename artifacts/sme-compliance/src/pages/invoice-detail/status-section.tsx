// Overview advice and the document workspace's official stamp record.
import type { StampRecord } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RejectionRiskCard } from "@/components/rejection-risk-card";
import { ShieldCheck } from "lucide-react";
import { IRN_EXPANSION, CSID_EXPANSION } from "@/lib/format";
import { ComplianceStatusCard } from "./compliance-status-card";
import type { InvoiceDetailState } from "./use-invoice-detail";
import { stampEvidence } from "./stamp-evidence";

export function StatusSection({ state }: { state: InvoiceDetailState }) {
  const { statusLight, statusLightLoading, riskEligible, rejectionRisk } =
    state;
  return (
    <>
      <ComplianceStatusCard
        statusLight={statusLight}
        isLoading={statusLightLoading}
      />

      {/* Advisory only, gated on the same still-editable statuses as the
          query so a cached report never outlives a submission. */}
      {riskEligible && rejectionRisk && (
        <RejectionRiskCard report={rejectionRisk} />
      )}
    </>
  );
}

export function StampCard({ stamp }: { stamp: StampRecord }) {
  const evidence = stampEvidence(stamp);
  return (
    <Card className="border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-emerald-800 dark:text-emerald-300">
          <ShieldCheck className="w-4 h-4" aria-hidden="true" /> Stamp record
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm space-y-3">
        <p className="font-medium">{evidence.label}</p>
        <p className="text-muted-foreground">{evidence.description}</p>
        <div className="flex flex-col justify-between gap-1 sm:flex-row sm:gap-4">
          <span className="text-muted-foreground">IRN ({IRN_EXPANSION})</span>
          <span className="font-mono text-xs break-all text-right">
            {stamp.irn}
          </span>
        </div>
        <div className="flex flex-col justify-between gap-1 sm:flex-row sm:gap-4">
          <span className="text-muted-foreground">CSID ({CSID_EXPANSION})</span>
          <span className="font-mono text-xs break-all text-right">
            {stamp.csid}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
