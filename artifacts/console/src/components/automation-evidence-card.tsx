import {
  useGetAutomationEvidence,
  getGetAutomationEvidenceQueryKey,
  type AutomationEvidenceKind,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// Prove with Clerk Phase 1 (round 36): the backtest evidence behind the dark
// automation flags, rendered beside the rollup so "what is Clerk doing" and
// "what would Clerk have done" read together. Every number is recorded-
// ledger agreement or durable-fact replay computed server-side; this card
// only phrases counts — and keeps each kind's honest caveat note visible,
// because this surface exists to inform a consent decision, not to sell one.

const KIND_LABELS: Record<AutomationEvidenceKind["kind"], string> = {
  reconcile_matches: "Settle receipts",
  submit_overdue: "Submit overdue",
  retry_failed: "Retry failed",
  draft_recurring: "Draft recurring paper",
};

// "8 of 9 hand decisions agreed (89%) · median 6 days earlier" — null when
// the window holds no decided cases (the card then says so instead of
// implying a rate). Exported for the unit test.
export function evidenceLine(k: AutomationEvidenceKind): string | null {
  if (k.sample === 0) return null;
  const pct =
    k.agreementRate === null ? "" : ` (${Math.round(k.agreementRate * 100)}%)`;
  const decisions = k.sample === 1 ? "hand decision" : "hand decisions";
  const lead =
    k.medianLeadDays === null
      ? ""
      : ` · median ${k.medianLeadDays} ${k.medianLeadDays === 1 ? "day" : "days"} earlier`;
  return `${k.agreed} of ${k.sample} ${decisions} agreed${pct}${lead}`;
}

// "Would act on 3 now · ₦25,000 s.104 floor risked in the window" — the
// act-now cohort plus the submit lane's would-have exposure floor. Exported
// for the unit test.
export function actNowLine(k: AutomationEvidenceKind): string | null {
  const parts: string[] = [];
  if (k.pending > 0) parts.push(`would act on ${k.pending} now`);
  if (k.exposureFloorNgn && k.exposureFloorNgn !== "0")
    parts.push(
      `₦${Number(k.exposureFloorNgn).toLocaleString("en-NG")} s.104 floor risked in the window`,
    );
  if (parts.length === 0) return null;
  const line = parts.join(" · ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

export function AutomationEvidenceCard() {
  const { data: evidence, isSuccess } = useGetAutomationEvidence({
    query: { queryKey: getGetAutomationEvidenceQueryKey(), retry: false },
  });
  if (!isSuccess || !evidence) return null;
  const footprint = evidence.kinds.reduce(
    (sum, k) => sum + k.sample + k.pending,
    0,
  );
  if (footprint === 0) return null;

  return (
    <Card data-testid="card-automation-evidence">
      <CardHeader>
        <CardTitle className="text-base">
          What automation would have done
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Backtest over the last {evidence.windowMonths} months of this
          firm&apos;s own ledgers — agreement between each dark automation
          kind and the decisions your team made by hand.
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2">
          {evidence.kinds.map((k) => {
            const line = evidenceLine(k);
            const actNow = actNowLine(k);
            return (
              <div
                key={k.kind}
                className="rounded-md border p-3"
                data-testid={`evidence-${k.kind.replace(/_/g, "-")}`}
              >
                <p className="text-xs font-medium uppercase text-muted-foreground">
                  {KIND_LABELS[k.kind]}
                </p>
                <p className="mt-1 text-sm tabular-nums">
                  {line ?? "No decided cases in the window yet"}
                </p>
                {actNow ? (
                  <p className="text-sm tabular-nums">{actNow}</p>
                ) : null}
                <p className="mt-1 text-xs text-muted-foreground">{k.note}</p>
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Deterministic replay of recorded ledgers — machine-made writes never
          count as agreement. Evidence for deciding the automation flags, as
          of {evidence.asOf}.
        </p>
      </CardContent>
    </Card>
  );
}
