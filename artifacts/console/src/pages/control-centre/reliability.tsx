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
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { formatDateTime, humanize } from "@/lib/format";

type ConnectionFilter = "all" | "attention" | "erp" | "bank_feed";

export function IntegrationReliabilityWorkspace() {
  const [filter, setFilter] = useState<ConnectionFilter>("all");
  const query = useGetIntegrationReliability({
    query: {
      queryKey: getGetIntegrationReliabilityQueryKey(),
      staleTime: 30_000,
    },
  });
  if (query.isLoading) {
    return (
      <div
        className="mi-reliability space-y-6"
        role="status"
        aria-label="Loading workspace"
        aria-busy="true"
      >
        <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-[var(--mi-line)] bg-[var(--mi-line)] sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton
              key={index}
              className="h-28 rounded-none bg-[var(--mi-paper)]"
            />
          ))}
        </div>
        <Skeleton className="h-80 w-full bg-[var(--mi-paper)]" />
      </div>
    );
  }
  if (query.isError || !query.data) {
    return (
      <div className="mi-reliability">
        <QueryError
          thing="integration reliability"
          onRetry={() => query.refetch()}
        />
      </div>
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
    <div className="mi-reliability space-y-6">
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
        aria-labelledby="connections-title"
        className="scroll-mt-6 border-y border-[var(--mi-line)] bg-[var(--mi-paper)]"
      >
        <div className="mi-reliability__header flex flex-col gap-3 border-b border-[var(--mi-line)] px-4 py-4">
          <div className="min-w-0">
            <h2
              id="connections-title"
              className="flex items-center gap-2 text-base font-extrabold text-[var(--mi-ink)]"
            >
              <Activity
                className="size-4 shrink-0 text-[var(--mi-teal)]"
                aria-hidden="true"
              />{" "}
              Connection estate
            </h2>
            <p className="mt-0.5 text-xs text-[var(--mi-muted)]">
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

        {data.connectionsTruncated && (
          <p className="px-4 py-3 text-xs text-[var(--mi-muted)]" role="note">
            Showing the {data.connections.length} most affected of{" "}
            {data.totalConnections} connections — the counts above cover
            everything.
          </p>
        )}
        {connections.length === 0 ? (
          <div
            className="px-5 py-12 text-center text-sm text-[var(--mi-muted)]"
            role="status"
          >
            No connections in this view.
          </div>
        ) : (
          <div className="divide-y divide-[var(--mi-line)]">
            {connections.map((connection) => (
              <div
                key={`${connection.type}:${connection.id}`}
                className="mi-reliability__connection grid gap-4 px-4 py-4"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="mi-reliability__name text-sm font-extrabold text-[var(--mi-ink)]">
                      {connection.clientName}
                    </p>
                    <span
                      className="mi-reliability__status"
                      data-tone={
                        connection.operationalState === "healthy"
                          ? "positive"
                          : connection.operationalState === "stale"
                            ? "warning"
                            : "critical"
                      }
                    >
                      {humanize(connection.operationalState)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-[var(--mi-muted)]">
                    {connection.firmName} / {connection.connectorKey}
                  </p>
                  {connection.issue ? (
                    <p className="mi-reliability__issue mt-1 text-xs text-[var(--mi-warning)]">
                      {connection.issue}
                    </p>
                  ) : null}
                </div>
                <dl className="mi-reliability__facts">
                  <div>
                    <dt className="text-[11px] font-bold uppercase text-[var(--mi-muted)]">
                      Last sync
                    </dt>
                    <dd className="mt-1 text-sm font-semibold text-[var(--mi-ink)]">
                      {formatDateTime(connection.lastSyncAt)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-bold uppercase text-[var(--mi-muted)]">
                      Run
                    </dt>
                    <dd className="mt-1 text-sm font-semibold text-[var(--mi-ink)]">
                      {connection.latestRunStatus
                        ? humanize(connection.latestRunStatus)
                        : "No run"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-bold uppercase text-[var(--mi-muted)]">
                      Read / written
                    </dt>
                    <dd className="mt-1 text-sm font-extrabold tabular-nums text-[var(--mi-ink)]">
                      {connection.recordsRead} / {connection.recordsWritten}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-bold uppercase text-[var(--mi-muted)]">
                      Row errors
                    </dt>
                    <dd
                      className={`mt-1 text-sm font-extrabold tabular-nums ${connection.errorCount > 0 ? "text-[var(--mi-critical)]" : "text-[var(--mi-ink)]"}`}
                    >
                      {connection.errorCount}
                    </dd>
                  </div>
                </dl>
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
