import type { OperatorQueueStats } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { PORTAL_URL } from "@/components/require-session";
import { Metric, MetricStrip } from "@workspace/web-ui";
import { Clock, ShieldCheck, Lock, LifeBuoy, Inbox } from "lucide-react";
import { formatDuration } from "./helpers";

// The operator endpoints answer 403 unless the signed-in principal is an
// operator. A firm_admin/firm_staff reaching this page should see a friendly
// prompt instead of an infinite spinner or a crash.
export function OperatorAccessRequired() {
  return (
    <div className="space-y-6">
      <h1
        className="text-2xl md:text-3xl font-bold"
        data-testid="text-page-title"
      >
        Operator work queue
      </h1>
      <Card data-testid="card-operator-access-required">
        <CardContent className="pt-6">
          <div className="flex items-start gap-3">
            <Lock
              className="w-5 h-5 text-muted-foreground mt-0.5 shrink-0"
              aria-hidden="true"
            />
            <div>
              <p className="font-medium">Operator access required</p>
              <p className="text-sm text-muted-foreground mt-1">
                This queue is for operator accounts. Sign in as an operator from
                the portal at{" "}
                <a
                  href={PORTAL_URL}
                  className="underline"
                  data-testid="link-portal"
                >
                  {PORTAL_URL}
                </a>
                .
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// Throughput and service indicators. The section / heading id pair and the
// strip label are what the accessibility suite names the regions by.
export function QueueHealthSection({
  stats,
  statsLoading,
}: {
  stats: OperatorQueueStats | undefined;
  statsLoading: boolean;
}) {
  return (
    <section className="space-y-3" aria-labelledby="queue-health-heading">
      <div>
        <h2 id="queue-health-heading" className="text-base font-semibold">
          Queue health
        </h2>
        <p className="text-sm text-muted-foreground">
          Throughput and service indicators for the current operator desk.
        </p>
      </div>
      <MetricStrip label="Queue health metrics">
        <Metric
          label="Open"
          value={statsLoading ? "…" : String(stats?.openCount ?? "—")}
          detail="Awaiting a claim"
          tone={(stats?.openCount ?? 0) > 0 ? "warning" : "default"}
          icon={<Inbox className="size-4" aria-hidden="true" />}
          testId="stat-open"
        />
        <Metric
          label="In progress"
          value={statsLoading ? "…" : String(stats?.inProgressCount ?? "—")}
          detail="Claimed by an operator"
          icon={<Clock className="size-4" aria-hidden="true" />}
          testId="stat-in-progress"
        />
        <Metric
          label="Resolved"
          value={statsLoading ? "…" : String(stats?.resolvedCount ?? "—")}
          detail="Closed with a resolution code"
          tone="positive"
          icon={<ShieldCheck className="size-4" aria-hidden="true" />}
          testId="stat-resolved"
        />
        <Metric
          label="Clients served"
          value={statsLoading ? "…" : String(stats?.clientsServed ?? "—")}
          detail="Distinct businesses"
          icon={<LifeBuoy className="size-4" aria-hidden="true" />}
          testId="stat-clients-served"
        />
        <Metric
          label="Avg handle time"
          value={statsLoading ? "…" : formatDuration(stats?.avgHandleSeconds)}
          detail="Claim to resolution"
          icon={<Clock className="size-4" aria-hidden="true" />}
          testId="stat-avg-handle"
        />
      </MetricStrip>
    </section>
  );
}
