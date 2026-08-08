import { useState } from "react";
import { Link } from "wouter";
import {
  getGetComplianceOperationsQueryKey,
  useGetComplianceOperations,
  type ComplianceOperationItem,
} from "@workspace/api-client-react";
import {
  Metric,
  MetricStrip,
  SegmentedControl,
  WorkQueue,
  type WorkQueueItem,
} from "@workspace/web-ui";
import {
  AlertTriangle,
  CalendarClock,
  ClipboardList,
  FileWarning,
  Inbox,
  Network,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { QueryError } from "@/components/query-error";
import { formatDateTime, humanize, priorityBadgeClasses } from "@/lib/format";
import { StatusPill, WorkspaceLoading } from "./shared";

type CaseFilter = "all" | "overdue" | "deadlines" | "buyer" | "operator";

function itemIcon(kind: ComplianceOperationItem["kind"]) {
  if (kind === "filing")
    return <CalendarClock className="size-4" aria-hidden="true" />;
  if (kind === "obligation")
    return <FileWarning className="size-4" aria-hidden="true" />;
  if (kind === "buyer_confirmation")
    return <Network className="size-4" aria-hidden="true" />;
  return <ClipboardList className="size-4" aria-hidden="true" />;
}

function queueTone(item: ComplianceOperationItem): WorkQueueItem["tone"] {
  if (item.slaState === "overdue" || item.priority === "high")
    return "critical";
  if (item.slaState === "due_soon" || item.priority === "medium")
    return "warning";
  return "neutral";
}

export function ComplianceOperationsWorkspace() {
  const [filter, setFilter] = useState<CaseFilter>("all");
  const query = useGetComplianceOperations({
    query: {
      queryKey: getGetComplianceOperationsQueryKey(),
      staleTime: 30_000,
    },
  });
  if (query.isLoading) return <WorkspaceLoading />;
  if (query.isError || !query.data) {
    return (
      <QueryError
        thing="compliance operations"
        onRetry={() => query.refetch()}
      />
    );
  }
  const data = query.data;
  const filtered = data.items.filter((item) => {
    if (filter === "all") return true;
    if (filter === "overdue") return item.slaState === "overdue";
    if (filter === "deadlines")
      return item.kind === "filing" || item.kind === "obligation";
    if (filter === "buyer") return item.kind === "buyer_confirmation";
    return item.kind === "operator_case";
  });
  const queueItems: WorkQueueItem[] = filtered.map((item) => ({
    id: item.key,
    title: item.title,
    description: [item.clientName, item.firmName, item.detail]
      .filter(Boolean)
      .join(" / "),
    tone: queueTone(item),
    icon: itemIcon(item.kind),
    meta: (
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={item.slaState}>
          {humanize(item.slaState)}
        </StatusPill>
        <span className={priorityBadgeClasses(item.priority)}>
          {humanize(item.priority)}
        </span>
        <span>Due {formatDateTime(item.dueAt)}</span>
        <span>{Math.round(item.ageHours)}h open</span>
      </div>
    ),
    action: (
      <Button asChild size="sm" variant="outline">
        <Link href={item.actionHref}>Open</Link>
      </Button>
    ),
  }));

  return (
    <div className="space-y-6">
      <MetricStrip label="Compliance operations summary">
        <Metric
          label="Open work"
          value={String(data.openItems)}
          detail="Across four operational domains"
          icon={<Inbox className="size-4" aria-hidden="true" />}
          tone="info"
        />
        <Metric
          label="Overdue"
          value={String(data.overdueItems)}
          detail={`${data.dueSoonItems} more due within 72h`}
          icon={<AlertTriangle className="size-4" aria-hidden="true" />}
          tone={data.overdueItems > 0 ? "critical" : "positive"}
        />
        <Metric
          label="High priority"
          value={String(data.highPriorityItems)}
          detail="SLA or statutory urgency"
          icon={<FileWarning className="size-4" aria-hidden="true" />}
          tone={data.highPriorityItems > 0 ? "warning" : "positive"}
        />
        <Metric
          label="Unassigned cases"
          value={String(data.unassignedCases)}
          detail="Managed Desk ownership gap"
          icon={<ClipboardList className="size-4" aria-hidden="true" />}
          tone={data.unassignedCases > 0 ? "warning" : "positive"}
        />
      </MetricStrip>

      <WorkQueue
        title="Prioritized exception queue"
        description="Overdue first, then priority and nearest deadline. All actions stay in their governed source workflow."
        items={queueItems}
        emptyTitle="No exceptions in this view"
        emptyDescription="The selected case segment has no open work."
        toolbar={
          <SegmentedControl<CaseFilter>
            label="Filter compliance exceptions"
            value={filter}
            onChange={setFilter}
            items={[
              { value: "all", label: "All", count: data.items.length },
              {
                value: "overdue",
                label: "Overdue",
                count: data.items.filter((item) => item.slaState === "overdue")
                  .length,
              },
              {
                value: "deadlines",
                label: "Deadlines",
                count: data.items.filter(
                  (item) =>
                    item.kind === "filing" || item.kind === "obligation",
                ).length,
              },
              {
                value: "buyer",
                label: "Buyer",
                count: data.items.filter(
                  (item) => item.kind === "buyer_confirmation",
                ).length,
              },
              {
                value: "operator",
                label: "Desk",
                count: data.items.filter(
                  (item) => item.kind === "operator_case",
                ).length,
              },
            ]}
          />
        }
      />
    </div>
  );
}
