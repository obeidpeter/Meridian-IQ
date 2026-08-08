import { useState } from "react";
import { Link } from "wouter";
import {
  getListBuyerPilotsQueryKey,
  useListBuyerPilots,
} from "@workspace/api-client-react";
import { Metric, MetricStrip, SegmentedControl } from "@workspace/web-ui";
import {
  Building2,
  CheckCircle2,
  Clock3,
  FileCheck2,
  ReceiptText,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { QueryError } from "@/components/query-error";
import { formatDateTime, humanize } from "@/lib/format";
import { fmtHours, pct, StatusPill, WorkspaceLoading } from "./shared";

type PilotFilter = "all" | "live" | "scale_ready" | "blocked";

export function BuyerPilotsWorkspace() {
  const [filter, setFilter] = useState<PilotFilter>("all");
  const query = useListBuyerPilots({
    query: { queryKey: getListBuyerPilotsQueryKey(), staleTime: 60_000 },
  });
  if (query.isLoading) return <WorkspaceLoading />;
  if (query.isError || !query.data) {
    return (
      <QueryError
        thing="buyer pilot workspace"
        onRetry={() => query.refetch()}
      />
    );
  }
  const data = query.data;
  const filtered = data.pilots.filter((pilot) => {
    if (filter === "all") return true;
    if (filter === "scale_ready") return pilot.stage === "scale_ready";
    if (filter === "blocked") return pilot.blockers.length >= 3;
    return ["live", "proving"].includes(pilot.stage);
  });

  return (
    <div className="space-y-6">
      <MetricStrip label="Buyer pilot summary">
        <Metric
          label="Anchor buyers"
          value={String(data.anchorBuyers)}
          detail={`${data.activeBuyers30d} active in 30 days`}
          icon={<Building2 className="size-4" aria-hidden="true" />}
          tone="info"
        />
        <Metric
          label="Pending confirmations"
          value={String(data.pendingConfirmations)}
          detail="Latest state still requested"
          icon={<Clock3 className="size-4" aria-hidden="true" />}
          tone={data.pendingConfirmations > 0 ? "warning" : "positive"}
        />
        <Metric
          label="Response coverage"
          value={pct(data.buyerResponseRate30d)}
          detail={`${data.confirmationResponses30d} responses in cohort`}
          icon={<CheckCircle2 className="size-4" aria-hidden="true" />}
          tone="positive"
        />
        <Metric
          label="Median response"
          value={fmtHours(data.medianResponseHours)}
          detail="Request to first buyer decision"
          icon={<ReceiptText className="size-4" aria-hidden="true" />}
        />
      </MetricStrip>

      <section className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
          <div>
            <h2 className="text-base font-extrabold text-slate-950">
              Pilot portfolio
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Readiness scores combine identity, supplier breadth, stamped flow,
              responses and payment signals.
            </p>
          </div>
          <SegmentedControl<PilotFilter>
            className="shrink-0"
            label="Filter buyer pilots"
            value={filter}
            onChange={setFilter}
            items={[
              { value: "all", label: "All", count: data.pilots.length },
              {
                value: "live",
                label: "Live",
                count: data.pilots.filter((pilot) =>
                  ["live", "proving"].includes(pilot.stage),
                ).length,
              },
              {
                value: "scale_ready",
                label: "Scale ready",
                count: data.pilots.filter(
                  (pilot) => pilot.stage === "scale_ready",
                ).length,
              },
              {
                value: "blocked",
                label: "Blocked",
                count: data.pilots.filter((pilot) => pilot.blockers.length >= 3)
                  .length,
              },
            ]}
          />
        </div>

        {filtered.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white px-5 py-12 text-center">
            <p className="font-bold text-slate-900">No pilots in this view</p>
            <p className="mt-1 text-sm text-slate-500">
              Select another readiness segment.
            </p>
          </div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            {filtered.map((pilot) => (
              <article
                key={pilot.buyerPartyId}
                className="rounded-lg border border-slate-200 bg-white"
              >
                <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-base font-extrabold text-slate-950">
                        {pilot.buyerName}
                      </h3>
                      <StatusPill status={pilot.stage}>
                        {humanize(pilot.stage)}
                      </StatusPill>
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      Last activity {formatDateTime(pilot.lastActivityAt)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-2xl font-extrabold tabular-nums text-slate-950">
                      {pilot.readinessScore}
                    </p>
                    <p className="text-[11px] font-bold uppercase text-slate-400">
                      Readiness
                    </p>
                  </div>
                </div>

                <div className="px-5 py-4">
                  <Progress value={pilot.readinessScore} className="h-1.5" />
                  <dl className="mt-5 grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-4">
                    {[
                      ["Suppliers", pilot.supplierCount],
                      ["Stamped", pilot.stampedCount],
                      ["Response", pct(pilot.responseRate)],
                      ["Paid signals", pilot.paidSignals],
                    ].map(([label, value]) => (
                      <div key={String(label)}>
                        <dt className="text-[11px] font-bold uppercase text-slate-400">
                          {label}
                        </dt>
                        <dd className="mt-1 text-lg font-extrabold tabular-nums text-slate-900">
                          {value}
                        </dd>
                      </div>
                    ))}
                  </dl>

                  <div className="mt-5 border-t border-slate-200 pt-4">
                    <div className="flex items-center gap-2 text-xs font-bold text-slate-600">
                      <FileCheck2
                        className="size-4 text-teal-700"
                        aria-hidden="true"
                      />
                      Next evidence
                    </div>
                    {pilot.blockers.length === 0 ? (
                      <p className="mt-2 text-sm text-emerald-700">
                        All scale-readiness evidence is present.
                      </p>
                    ) : (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {pilot.blockers.slice(0, 3).map((blocker) => (
                          <span
                            key={blocker}
                            className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-900"
                          >
                            {blocker}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3 border-y border-slate-200 bg-white px-4 py-4">
        <div className="flex items-center gap-2 text-sm text-slate-600">
          <Users className="size-4 text-teal-700" aria-hidden="true" />
          Buyer responses remain explicit, attributable decisions.
        </div>
        <div className="flex gap-2">
          <Button asChild size="sm" variant="outline">
            <Link href="/control-centre/cases">
              View confirmation exceptions
            </Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/feature-flags">Manage rollout</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
