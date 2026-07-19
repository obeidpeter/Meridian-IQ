import type { RejectionRiskReport } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { History } from "lucide-react";
import { formatDate, pillClasses } from "@/lib/format";

// Draft-time rejection risk (contract 0.36.0): recent rail rejections that
// touch this invoice's supplier or buyer — or the wider firm — surfaced while
// the invoice is still draft/validated so the client can double-check the
// implicated details before submitting. Advisory history only: it is what the
// rail rejected recently, never a prediction, and it never blocks submission.
// A quiet window (no signals) renders nothing at all.

const SCOPE_LABELS: Record<string, string> = {
  supplier: "this supplier",
  buyer: "this buyer",
  firm: "your firm",
};

// Party-scoped signals (closest to this invoice) read amber/blue; firm-wide
// background noise stays slate. The chip text always carries the meaning —
// colour is never the only signal.
const SCOPE_TONES: Record<string, string> = {
  supplier: pillClasses("amber"),
  buyer: pillClasses("blue"),
  firm: pillClasses("slate"),
};

/** "this supplier" / "this buyer" / "your firm"; humanizes nothing — an unknown scope shows as-is. */
export function scopeChipLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope;
}

/** Pill classes for a signal's scope chip (slate for unrecognised scopes). */
export function scopeChipClasses(scope: string): string {
  return SCOPE_TONES[scope] ?? pillClasses("slate");
}

/** "Seen 3 times · last on 12 Jul 2026" — the row's frequency line. */
export function signalFrequency(count: number, lastSeen: string): string {
  return `Seen ${count} time${count === 1 ? "" : "s"} · last on ${formatDate(lastSeen)}`;
}

export function RejectionRiskCard({ report }: { report: RejectionRiskReport }) {
  // Nothing recent touches this invoice's parties — say nothing rather than
  // manufacture an all-clear the neighbouring cards don't give either.
  if (report.signals.length === 0) return null;
  return (
    <Card data-testid="card-rejection-risk">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="w-4 h-4" aria-hidden="true" /> Recent rejections
          nearby
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Recent rejections that touch this invoice&apos;s supplier or buyer —
          worth checking before you submit.
        </p>
        <div className="border rounded-md divide-y">
          {report.signals.map((s) => (
            <div
              key={`${s.errorCode}-${s.scope}`}
              className="px-3 py-2 space-y-1"
              data-testid={`row-risk-${s.errorCode}-${s.scope}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs font-medium">
                  {s.errorCode}
                </span>
                <span className={scopeChipClasses(s.scope)}>
                  {scopeChipLabel(s.scope)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {signalFrequency(s.count, s.lastSeen)}
                </span>
              </div>
              {s.cause && <p className="text-muted-foreground">{s.cause}</p>}
              {s.fix && (
                <p className="text-muted-foreground">
                  <span className="font-medium text-foreground">Fix:</span>{" "}
                  {s.fix}
                </p>
              )}
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          From the last {report.windowDays} days of submissions. This is
          history, not a prediction — it never blocks you from submitting.
        </p>
      </CardContent>
    </Card>
  );
}
