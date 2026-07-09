import {
  useGetGateMetrics,
  getGetGateMetricsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { usePageTitle } from "@/hooks/use-page-title";
import { pillClasses } from "@/lib/format";
import { Target, TrendingUp } from "lucide-react";

// Roadmap Appendix A ("Platform gates"): the analytics that measure the gates
// themselves. Targets are roadmap commitments (R1 exit criteria, R2 north
// star); measurements come live from the spine via /operator/gate-metrics.

function fmtHours(h: number | null | undefined): string {
  if (h === null || h === undefined) return "—";
  if (h < 1) return `${Math.round(h * 60)}m`;
  return `${h.toFixed(1)}h`;
}

function fmtPct(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return "—";
  return `${Math.round(rate * 100)}%`;
}

function GateCard({
  label,
  gate,
  value,
  progress,
  met,
  detail,
  testId,
}: {
  label: string;
  gate: string;
  value: string;
  progress?: number; // 0..100
  met?: boolean;
  detail?: string;
  testId: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardContent className="pt-6 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm text-muted-foreground">{label}</p>
          {met !== undefined && (
            <span className={`${pillClasses(met ? "emerald" : "amber")} shrink-0`}>
              {met ? "On gate" : "Below gate"}
            </span>
          )}
        </div>
        <p className="text-2xl font-bold tabular-nums">{value}</p>
        {progress !== undefined && <Progress value={Math.min(100, progress)} />}
        <p className="text-xs text-muted-foreground">
          <Target className="w-3 h-3 inline mr-1" aria-hidden="true" />
          {gate}
          {detail ? ` · ${detail}` : ""}
        </p>
      </CardContent>
    </Card>
  );
}

export function GateMetrics() {
  usePageTitle("Gate metrics");
  const { data, isLoading, error, refetch } = useGetGateMetrics({
    query: { queryKey: getGetGateMetricsQueryKey() },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1
          className="text-2xl md:text-3xl font-bold"
          data-testid="text-page-title"
        >
          Gate metrics
        </h1>
        <p className="text-muted-foreground mt-1">
          Releases unlock on evidence, not calendar dates — this is the
          evidence, measured live from the spine.
        </p>
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-36" />
          ))}
        </div>
      ) : error || !data ? (
        // A failed fetch must not skeleton forever — offer a retry.
        <QueryError thing="gate metrics" onRetry={() => refetch()} />
      ) : (
        <>
          <div>
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-1.5">
              <TrendingUp className="w-4 h-4" aria-hidden="true" /> R1 exit criteria
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <GateCard
                label="Subscribed firms"
                gate="Gate proxy: 150+ channel-sourced subscriptions by 31 Mar 2027"
                value={String(data.subscribedFirms)}
                progress={(data.subscribedFirms / 150) * 100}
                testId="gate-subscriptions"
                detail={`${data.activeClients} active client businesses`}
              />
              <GateCard
                label="Median time to stamp"
                gate="Under 48 hours from creation to stamp"
                value={fmtHours(data.medianHoursToStamp)}
                met={
                  data.medianHoursToStamp === null
                    ? undefined
                    : data.medianHoursToStamp < 48
                }
                testId="gate-time-to-stamp"
                detail={`${data.stampedInvoices} stamped invoices`}
              />
              <GateCard
                label="Failure self-resolution"
                gate="80%+ of failures resolve without escalation"
                value={fmtPct(data.failureSelfResolutionRate)}
                met={
                  data.failureSelfResolutionRate === null
                    ? undefined
                    : data.failureSelfResolutionRate >= 0.8
                }
                testId="gate-self-resolution"
                detail={`${data.failedInvoicesTotal} invoices ever failed · ${data.openEscalations} open escalations`}
              />
            </div>
          </div>

          <div>
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-1.5">
              <TrendingUp className="w-4 h-4" aria-hidden="true" /> R2 north star & guardrails
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <GateCard
                label="Credit-observable businesses"
                gate="Tracking to 300 by end-2027"
                value={String(data.creditObservableCount)}
                progress={(data.creditObservableCount / 300) * 100}
                testId="gate-credit-observable"
                detail="stamped + confirmation or settlement signal"
              />
              <GateCard
                label="Confirmations (30 days)"
                gate="50+ confirmed invoices flowing monthly"
                value={String(data.confirmationsLast30d)}
                progress={(data.confirmationsLast30d / 50) * 100}
                testId="gate-confirmations"
              />
              <GateCard
                label="Reconciliation accept rate"
                gate="Guardrail: match proposals accepted"
                value={fmtPct(data.reconciliationAcceptRate)}
                testId="gate-reconciliation"
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
