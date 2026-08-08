import { Link } from "wouter";
import {
  getGetGateMetricsQueryKey,
  useGetGateMetrics,
} from "@workspace/api-client-react";
import { Metric, MetricStrip } from "@workspace/web-ui";
import {
  ArrowRight,
  Building2,
  Flag,
  Network,
  Target,
  Timer,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { QueryError } from "@/components/query-error";
import { humanize } from "@/lib/format";
import {
  ControlRow,
  fmtHours,
  pct,
  StatusPill,
  WorkspaceLoading,
} from "./shared";

type Gate = {
  key: string;
  label: string;
  value: string;
  target: string;
  progress: number | null;
  met: boolean | null;
  detail: string;
};

export function ActivationWorkspace() {
  const query = useGetGateMetrics({
    query: { queryKey: getGetGateMetricsQueryKey(), staleTime: 60_000 },
  });
  if (query.isLoading) return <WorkspaceLoading />;
  if (query.isError || !query.data) {
    return (
      <QueryError thing="activation evidence" onRetry={() => query.refetch()} />
    );
  }

  const data = query.data;
  const gates: Gate[] = [
    {
      key: "practices",
      label: "Subscribed practices",
      value: String(data.subscribedFirms),
      target: "150 channel-sourced subscriptions",
      progress: (data.subscribedFirms / 150) * 100,
      met: data.subscribedFirms >= 150,
      detail: `${data.activeClients} active client businesses`,
    },
    {
      key: "stamp",
      label: "Median time to stamp",
      value: fmtHours(data.medianHoursToStamp),
      target: "Under 48 hours",
      progress:
        data.medianHoursToStamp === null
          ? null
          : Math.max(0, (1 - data.medianHoursToStamp / 48) * 100),
      met:
        data.medianHoursToStamp === null ? null : data.medianHoursToStamp < 48,
      detail: `${data.stampedInvoices} stamped invoices`,
    },
    {
      key: "resolution",
      label: "Failure self-resolution",
      value: pct(data.failureSelfResolutionRate),
      target: "At least 80% without escalation",
      progress:
        data.failureSelfResolutionRate === null
          ? null
          : data.failureSelfResolutionRate * 100,
      met:
        data.failureSelfResolutionRate === null
          ? null
          : data.failureSelfResolutionRate >= 0.8,
      detail: `${data.failedInvoicesTotal} failure cases / ${data.openEscalations} open escalations`,
    },
    {
      key: "buyers",
      label: "Buyer response coverage",
      value: pct(data.buyerResponseRate30d),
      target: "Pilot threshold: at least 60%",
      progress:
        data.buyerResponseRate30d === null
          ? null
          : data.buyerResponseRate30d * 100,
      met:
        data.buyerResponseRate30d === null
          ? null
          : data.buyerResponseRate30d >= 0.6,
      detail: `${data.confirmationResponses30d} of ${data.confirmationRequests30d} request cohorts responded`,
    },
    {
      key: "credit",
      label: "Credit-observable businesses",
      value: String(data.creditObservableCount),
      target: "300 businesses by end-2027",
      progress: (data.creditObservableCount / 300) * 100,
      met: data.creditObservableCount >= 300,
      detail: "Stamped plus confirmation or settlement evidence",
    },
    {
      key: "confirmations",
      label: "Confirmation events",
      value: String(data.confirmationsLast30d),
      target: "50 events flowing monthly",
      progress: (data.confirmationsLast30d / 50) * 100,
      met: data.confirmationsLast30d >= 50,
      detail: `${data.anchorBuyers} anchor buyers represented`,
    },
  ];

  return (
    <div className="space-y-6">
      <MetricStrip label="Activation summary">
        <Metric
          label="Active practices"
          value={String(data.subscribedFirms)}
          detail={`${data.namedProspects} named prospects`}
          icon={<Building2 className="size-4" aria-hidden="true" />}
          tone="info"
        />
        <Metric
          label="Active clients"
          value={String(data.activeClients)}
          detail={`${data.onboardingProspects} currently onboarding`}
          icon={<Users className="size-4" aria-hidden="true" />}
        />
        <Metric
          label="Time to stamp"
          value={fmtHours(data.medianHoursToStamp)}
          detail="Median across stamped records"
          icon={<Timer className="size-4" aria-hidden="true" />}
          tone={
            data.medianHoursToStamp !== null && data.medianHoursToStamp < 48
              ? "positive"
              : "warning"
          }
        />
        <Metric
          label="Buyer participation"
          value={pct(data.buyerResponseRate30d)}
          detail={`${data.anchorBuyers} anchor buyers`}
          icon={<Network className="size-4" aria-hidden="true" />}
          tone="info"
        />
      </MetricStrip>

      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-extrabold text-slate-950">
              Evidence gates
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Commercial, operating and buyer-side proof measured from live
              records.
            </p>
          </div>
          <Button asChild size="sm" variant="outline">
            <Link href="/control-centre/buyers">
              Open buyer pilots{" "}
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </Button>
        </div>
        <div className="grid lg:grid-cols-2">
          {gates.map((gate, index) => (
            <div
              key={gate.key}
              className={`px-4 py-5 ${index < gates.length - 2 ? "border-b" : ""} border-slate-200 lg:[&:nth-child(odd)]:border-r lg:[&:nth-last-child(2)]:border-b-0`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-bold text-slate-500">
                    {gate.label}
                  </p>
                  <p className="mt-1 text-2xl font-extrabold tabular-nums text-slate-950">
                    {gate.value}
                  </p>
                </div>
                <StatusPill
                  status={
                    gate.met === null
                      ? "no_data"
                      : gate.met
                        ? "healthy"
                        : "watch"
                  }
                >
                  {gate.met === null
                    ? "No data"
                    : gate.met
                      ? "On gate"
                      : "Building"}
                </StatusPill>
              </div>
              {gate.progress !== null ? (
                <Progress
                  className="mt-3 h-1.5"
                  value={Math.min(100, gate.progress)}
                />
              ) : null}
              <div className="mt-3 flex items-start gap-2 text-xs leading-5 text-slate-500">
                <Target
                  className="mt-0.5 size-3.5 shrink-0"
                  aria-hidden="true"
                />
                <span>
                  {gate.target} / {gate.detail}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-4 py-4">
            <h2 className="flex items-center gap-2 text-base font-extrabold text-slate-950">
              <Flag className="size-4 text-teal-700" aria-hidden="true" />{" "}
              Release posture
            </h2>
          </div>
          {data.releaseReadiness.map((release) => (
            <ControlRow
              key={release.releaseTag}
              title={`${release.releaseTag} capability set`}
              detail={`${release.enabledFlags} of ${release.totalFlags} release flags enabled`}
              status={release.status}
              statusLabel={humanize(release.status)}
            />
          ))}
        </section>

        <section className="rounded-lg border border-slate-200 bg-[#082f31] px-5 py-5 text-white">
          <p className="text-xs font-bold uppercase text-lime-300">
            Activation funnel
          </p>
          <dl className="mt-5 space-y-4">
            {[
              ["Named prospects", data.namedProspects],
              ["In onboarding", data.onboardingProspects],
              ["Converted", data.convertedProspects],
              ["Conversion", pct(data.prospectConversionRate)],
            ].map(([label, value]) => (
              <div
                key={String(label)}
                className="flex items-baseline justify-between border-b border-white/15 pb-3 last:border-0 last:pb-0"
              >
                <dt className="text-sm text-white/65">{label}</dt>
                <dd className="text-lg font-extrabold tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </div>
  );
}
