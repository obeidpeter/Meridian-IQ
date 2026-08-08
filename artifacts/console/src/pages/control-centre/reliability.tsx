import { useState } from "react";
import { Link } from "wouter";
import {
  getGetIntegrationReliabilityQueryKey,
  useGetIntegrationReliability,
} from "@workspace/api-client-react";
import {
  Metric,
  MetricStrip,
  SegmentedControl,
  WorkQueue,
  type WorkQueueItem,
} from "@workspace/web-ui";
import {
  Activity,
  AlertTriangle,
  DatabaseZap,
  PlugZap,
  RefreshCcw,
  ServerCog,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { QueryError } from "@/components/query-error";
import { formatDateTime, humanize } from "@/lib/format";
import { StatusPill, WorkspaceLoading } from "./shared";

type ConnectionFilter = "all" | "attention" | "erp" | "bank_feed";

export function IntegrationReliabilityWorkspace() {
  const [filter, setFilter] = useState<ConnectionFilter>("all");
  const query = useGetIntegrationReliability({
    query: {
      queryKey: getGetIntegrationReliabilityQueryKey(),
      staleTime: 30_000,
    },
  });
  if (query.isLoading) return <WorkspaceLoading />;
  if (query.isError || !query.data) {
    return (
      <QueryError
        thing="integration reliability"
        onRetry={() => query.refetch()}
      />
    );
  }
  const data = query.data;
  const connections = data.connections.filter((connection) => {
    if (filter === "all") return true;
    if (filter === "attention")
      return connection.operationalState !== "healthy";
    return connection.type === filter;
  });
  const qualityItems: WorkQueueItem[] = data.qualitySignals
    .filter((signal) => signal.count > 0)
    .map((signal) => ({
      id: signal.key,
      title: `${signal.count} ${signal.label.toLowerCase()}`,
      description: signal.detail,
      tone:
        signal.severity === "critical"
          ? "critical"
          : signal.severity === "warning"
            ? "warning"
            : "info",
      icon: <AlertTriangle className="size-4" aria-hidden="true" />,
      action: (
        <Button asChild size="sm" variant="outline">
          <Link href={signal.actionHref}>Investigate</Link>
        </Button>
      ),
    }));

  return (
    <div className="space-y-6">
      <MetricStrip label="Integration reliability summary">
        <Metric
          label="Healthy connections"
          value={`${data.healthyConnections}/${data.totalConnections}`}
          detail={`${data.attentionConnections} need attention`}
          icon={<PlugZap className="size-4" aria-hidden="true" />}
          tone={data.attentionConnections > 0 ? "warning" : "positive"}
        />
        <Metric
          label="Failed runs (24h)"
          value={String(data.failedRuns24h)}
          detail="ERP and bank feed"
          icon={<RefreshCcw className="size-4" aria-hidden="true" />}
          tone={data.failedRuns24h > 0 ? "critical" : "positive"}
        />
        <Metric
          label="Rejected rows (30d)"
          value={String(data.invalidRows30d)}
          detail="Invalid, skipped or errored"
          icon={<DatabaseZap className="size-4" aria-hidden="true" />}
          tone={data.invalidRows30d > 0 ? "warning" : "positive"}
        />
        <Metric
          label="Platform delivery"
          value={String(data.deadLetters + data.openRails)}
          detail={`${data.deadLetters} dead events / ${data.openRails} degraded rails`}
          icon={<ServerCog className="size-4" aria-hidden="true" />}
          tone={data.deadLetters + data.openRails > 0 ? "critical" : "positive"}
        />
      </MetricStrip>

      <section
        id="connections"
        className="scroll-mt-6 overflow-hidden rounded-lg border border-slate-200 bg-white"
      >
        <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-base font-extrabold text-slate-950">
              <Activity className="size-4 text-teal-700" aria-hidden="true" />{" "}
              Connection estate
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Latest sync outcome, freshness and row-level throughput by tenant
              connection.
            </p>
          </div>
          <SegmentedControl<ConnectionFilter>
            label="Filter connections"
            value={filter}
            onChange={setFilter}
            items={[
              { value: "all", label: "All", count: data.connections.length },
              {
                value: "attention",
                label: "Attention",
                count: data.attentionConnections,
              },
              {
                value: "erp",
                label: "ERP",
                count: data.connections.filter((item) => item.type === "erp")
                  .length,
              },
              {
                value: "bank_feed",
                label: "Bank feed",
                count: data.connections.filter(
                  (item) => item.type === "bank_feed",
                ).length,
              },
            ]}
          />
        </div>

        {connections.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm text-slate-500">
            No connections in this view.
          </div>
        ) : (
          <div className="divide-y divide-slate-200">
            {connections.map((connection) => (
              <div
                key={`${connection.type}:${connection.id}`}
                className="grid gap-4 px-4 py-4 lg:grid-cols-[minmax(13rem,1.4fr)_minmax(10rem,1fr)_repeat(3,minmax(6rem,.7fr))] lg:items-center"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-extrabold text-slate-950">
                      {connection.clientName}
                    </p>
                    <StatusPill status={connection.operationalState}>
                      {humanize(connection.operationalState)}
                    </StatusPill>
                  </div>
                  <p className="mt-1 truncate text-xs text-slate-500">
                    {connection.firmName} / {connection.connectorKey}
                  </p>
                  {connection.issue ? (
                    <p className="mt-1 text-xs text-amber-800">
                      {connection.issue}
                    </p>
                  ) : null}
                </div>
                <div>
                  <p className="text-[11px] font-bold uppercase text-slate-400">
                    Last sync
                  </p>
                  <p className="mt-1 text-sm font-semibold text-slate-700">
                    {formatDateTime(connection.lastSyncAt)}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] font-bold uppercase text-slate-400">
                    Run
                  </p>
                  <p className="mt-1 text-sm font-semibold text-slate-700">
                    {connection.latestRunStatus
                      ? humanize(connection.latestRunStatus)
                      : "No run"}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] font-bold uppercase text-slate-400">
                    Read / written
                  </p>
                  <p className="mt-1 text-sm font-extrabold tabular-nums text-slate-900">
                    {connection.recordsRead} / {connection.recordsWritten}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] font-bold uppercase text-slate-400">
                    Row errors
                  </p>
                  <p
                    className={`mt-1 text-sm font-extrabold tabular-nums ${connection.errorCount > 0 ? "text-red-700" : "text-slate-900"}`}
                  >
                    {connection.errorCount}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <WorkQueue
        title="Data-quality and delivery signals"
        description="Only active exceptions are shown. A clear list means every monitored count is zero."
        items={qualityItems}
        emptyTitle="Reliability signals are clear"
        emptyDescription="No failed runs, invalid rows, dead deliveries or degraded rails are recorded."
      />
    </div>
  );
}
