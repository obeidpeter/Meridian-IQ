import type { PortfolioSummary } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Clock, FileWarning, ListChecks } from "lucide-react";
import { formatNaira } from "@/lib/format";
import type { WorkQueueItem } from "@workspace/web-ui";

// The firm's priority queue for the Today view: one row per firm-level
// signal, ordered by client risk, failures, statutory deadlines and
// unsubmitted value. Each row's action moves the page to the view that
// resolves it; the shell supplies those moves.
export function firmPriorities(
  data: Pick<
    PortfolioSummary,
    | "highRiskCount"
    | "totalFailedCount"
    | "totalOverdueCount"
    | "totalUnsubmittedCount"
    | "totalUnsubmittedValue"
  >,
  actions: {
    reviewClients: () => void;
    openClients: () => void;
    openCompliance: () => void;
    openMoney: () => void;
  },
): WorkQueueItem[] {
  const workItems: WorkQueueItem[] = [];
  if (data.highRiskCount > 0) {
    workItems.push({
      id: "high-risk-clients",
      title: `${data.highRiskCount} high-risk client${data.highRiskCount === 1 ? "" : "s"}`,
      description:
        "Overdue paper or repeated failures require partner attention.",
      tone: "critical",
      icon: <AlertTriangle className="size-4" aria-hidden="true" />,
      action: (
        <Button size="sm" variant="destructive" onClick={actions.reviewClients}>
          Review clients
        </Button>
      ),
    });
  }
  if (data.totalFailedCount > 0) {
    workItems.push({
      id: "failed-submissions",
      title: `${data.totalFailedCount} failed submission${data.totalFailedCount === 1 ? "" : "s"}`,
      description:
        "Open the affected client records and resolve the rejection causes.",
      tone: "critical",
      icon: <FileWarning className="size-4" aria-hidden="true" />,
      action: (
        <Button size="sm" variant="outline" onClick={actions.openClients}>
          Open client book
        </Button>
      ),
    });
  }
  if (data.totalOverdueCount > 0) {
    workItems.push({
      id: "overdue-deadlines",
      title: `${data.totalOverdueCount} overdue deadline${data.totalOverdueCount === 1 ? "" : "s"}`,
      description:
        "Prioritize the statutory work that has already crossed its due date.",
      tone: "warning",
      icon: <Clock className="size-4" aria-hidden="true" />,
      action: (
        <Button size="sm" variant="outline" onClick={actions.openCompliance}>
          Open compliance
        </Button>
      ),
    });
  }
  if (data.totalUnsubmittedCount > 0) {
    workItems.push({
      id: "unsubmitted-value",
      title: `${formatNaira(data.totalUnsubmittedValue)} awaiting submission`,
      description: `${data.totalUnsubmittedCount} invoice${data.totalUnsubmittedCount === 1 ? "" : "s"} remain outside the stamping rails.`,
      tone: "warning",
      icon: <ListChecks className="size-4" aria-hidden="true" />,
      action: (
        <Button size="sm" variant="outline" onClick={actions.openMoney}>
          Review value
        </Button>
      ),
    });
  }
  return workItems;
}
