import { Metric, MetricStrip } from "@workspace/web-ui";
import { BadgeCheck, CircleHelp, ReceiptText, ShieldAlert } from "lucide-react";
import { confirmationLabel, formatNaira } from "@/lib/format";
import type { ConfirmationsPageState } from "./use-confirmations-page";

export function QueueMetrics({ state }: { state: ConfirmationsPageState }) {
  const { awaitingCount, awaitingTotal, counts, summary, invoices } = state;
  return (
    <MetricStrip label="Confirmation summary">
      <Metric
        label={confirmationLabel("requested")}
        value={String(awaitingCount)}
        detail={formatNaira(awaitingTotal)}
        icon={<ReceiptText className="size-4" aria-hidden="true" />}
        tone={awaitingCount > 0 ? "warning" : "default"}
      />
      <Metric
        label="Confirmed"
        value={String(counts.get("confirmed") ?? 0)}
        detail="Responses recorded"
        icon={<BadgeCheck className="size-4" aria-hidden="true" />}
        tone="positive"
      />
      <Metric
        label="Queried"
        value={String(counts.get("queried") ?? 0)}
        detail="Supplier clarification needed"
        icon={<CircleHelp className="size-4" aria-hidden="true" />}
        tone={(counts.get("queried") ?? 0) > 0 ? "info" : "default"}
      />
      <Metric
        label="Rejected"
        value={String(counts.get("rejected") ?? 0)}
        detail={`${summary?.total ?? invoices.length} invoices in scope`}
        icon={<ShieldAlert className="size-4" aria-hidden="true" />}
        tone={(counts.get("rejected") ?? 0) > 0 ? "critical" : "default"}
      />
    </MetricStrip>
  );
}
