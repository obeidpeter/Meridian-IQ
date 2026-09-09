import {
  type Escalation,
  type SettlementEvent,
  type SubmissionAttempt,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckCircle2, Clock, XCircle, Banknote } from "lucide-react";
import {
  formatNaira,
  formatDate,
  formatDateTime,
  humanize,
  pillClasses,
} from "@/lib/format";
import { SETTLEMENT_SOURCE_LABELS } from "./meta";

export function SettlementsCard({
  settlements,
}: {
  settlements: SettlementEvent[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Banknote className="w-4 h-4" aria-hidden="true" /> Settlement events
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {settlements.map((s) => (
          <div key={s.id} className="text-sm border rounded-md px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className={pillClasses("slate")}>
                  {SETTLEMENT_SOURCE_LABELS[s.source] || humanize(s.source)}
                </span>
                {s.paymentStatus && (
                  <span
                    className={pillClasses(
                      s.paymentStatus === "paid" ? "emerald" : "amber",
                    )}
                  >
                    {humanize(s.paymentStatus)}
                  </span>
                )}
              </div>
              <span className="font-semibold tabular-nums">
                {formatNaira(s.amount)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {formatDateTime(s.occurredAt)}
            </p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function SubmissionTimeline({
  attempts,
}: {
  attempts: SubmissionAttempt[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Submission timeline</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {[...attempts]
          .sort((a, b) => a.attemptNo - b.attemptNo)
          .map((a) => (
            <div key={a.id} className="flex items-start gap-3 text-sm">
              {a.status === "rejected" || a.status === "error" ? (
                <XCircle
                  className="w-4 h-4 text-destructive mt-0.5"
                  aria-hidden="true"
                />
              ) : a.status === "accepted" ? (
                <CheckCircle2
                  className="w-4 h-4 text-emerald-600 dark:text-emerald-400 mt-0.5"
                  aria-hidden="true"
                />
              ) : (
                <Clock
                  className="w-4 h-4 text-muted-foreground mt-0.5"
                  aria-hidden="true"
                />
              )}
              <div>
                <p>
                  Attempt {a.attemptNo} · {humanize(a.status)}{" "}
                  <span className="text-muted-foreground uppercase text-xs">
                    ({a.rail})
                  </span>
                </p>
                {a.errorCode && (
                  <p className="text-xs text-destructive font-mono">
                    {a.errorCode}
                  </p>
                )}
                {a.correlationId && (
                  <p className="break-all font-mono text-[11px] text-muted-foreground">
                    Support reference {a.correlationId}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  {formatDate(a.createdAt)}
                </p>
              </div>
            </div>
          ))}
      </CardContent>
    </Card>
  );
}

export function EscalationsCard({
  escalations,
}: {
  escalations: Escalation[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Escalations</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {escalations.map((e) => (
          <div key={e.id} className="text-sm border rounded-md px-3 py-2">
            <div className="flex justify-between">
              <span className="font-medium">{humanize(e.status)}</span>
              <span className="text-xs text-muted-foreground">
                {formatDate(e.createdAt)}
              </span>
            </div>
            <p className="text-muted-foreground">{e.reason}</p>
            {e.operatorReply && (
              <div
                className="mt-2 rounded-md bg-muted/60 px-3 py-2"
                data-testid={`escalation-reply-${e.id}`}
              >
                <p className="text-xs font-medium text-muted-foreground">
                  Compliance Desk replied
                  {e.repliedAt ? ` · ${formatDate(e.repliedAt)}` : ""}
                </p>
                <p className="mt-1 whitespace-pre-wrap">{e.operatorReply}</p>
              </div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
