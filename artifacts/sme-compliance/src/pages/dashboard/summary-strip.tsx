// The four-metric strip above the view switch (R126 moved it out of the page
// shell): awaiting stamp, stamped & valid (with the vault link), drafts and
// at risk — every count from the same dashboard summary the cards render.
import type { DashboardSummary } from "@workspace/api-client-react";
import { AtRiskInfo } from "@/components/at-risk-info";
import { AlertTriangle, CheckCircle, Clock, FileText } from "lucide-react";
import { Link } from "wouter";
import { Metric, MetricStrip } from "@workspace/web-ui";
import { formatNaira } from "@/lib/format";

export function DashboardMetricStrip({
  summary,
}: {
  summary: DashboardSummary | undefined;
}) {
  return (
    <MetricStrip label="Business compliance summary">
      <Metric
        label="Awaiting stamp"
        value={String(summary?.pendingCount ?? 0)}
        detail="Submitted, not yet stamped"
        icon={<Clock className="size-4" aria-hidden="true" />}
        tone={(summary?.pendingCount ?? 0) > 0 ? "info" : "default"}
      />
      <Metric
        label="Stamped & valid"
        value={String(summary?.stampedCount ?? 0)}
        detail={`${formatNaira(summary?.stampedValue)} total value`}
        icon={<CheckCircle className="size-4" aria-hidden="true" />}
        tone="positive"
        action={
          <Link
            href="/invoices?filter=stamped"
            className="text-xs font-bold text-primary hover:underline"
            data-testid="link-open-vault"
          >
            Open vault
          </Link>
        }
      />
      <Metric
        label="Drafts"
        value={String(summary?.draftCount ?? 0)}
        detail="Needs completion"
        icon={<FileText className="size-4" aria-hidden="true" />}
        tone={(summary?.draftCount ?? 0) > 0 ? "warning" : "default"}
      />
      <Metric
        label="At risk"
        value={String(summary?.atRiskCount ?? 0)}
        detail="Needs attention"
        icon={<AlertTriangle className="size-4" aria-hidden="true" />}
        tone={(summary?.atRiskCount ?? 0) > 0 ? "critical" : "default"}
        action={<AtRiskInfo />}
      />
    </MetricStrip>
  );
}
