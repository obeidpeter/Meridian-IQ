// The Today view's work queue (R126 moved it out of the page shell): one
// item per thing that needs attention, in statutory-risk order — at-risk
// invoices, failed submissions, drafts, aged receivables, the next deadline.
// `setView` is passed in so the aged-receivables action can jump to the
// money view exactly as the shell's inline handler did.
import type { DashboardSummary } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { AlertTriangle, CalendarCheck, FileText, Wallet } from "lucide-react";
import { Link } from "wouter";
import type { WorkQueueItem } from "@workspace/web-ui";
import { formatLagosDate } from "@/lib/format";
import type { DashboardView } from "./helpers";

export function dashboardWorkItems(
  summary: DashboardSummary | undefined,
  agedReceivableCount: number,
  setView: (view: DashboardView) => void,
): WorkQueueItem[] {
  const workItems: WorkQueueItem[] = [];
  if (summary?.atRiskCount) {
    workItems.push({
      id: "at-risk-invoices",
      title: `${summary.atRiskCount} invoice${summary.atRiskCount === 1 ? " is" : "s are"} at risk`,
      // Must state the server's actual rule (overdue deadlines + failed
      // submissions) — a merely-closing window does not count here.
      description:
        "A statutory submission deadline has passed, or a submission failed.",
      tone: "critical",
      icon: <AlertTriangle className="size-4" aria-hidden="true" />,
      action: (
        <Button asChild size="sm" variant="destructive">
          <Link href="/calendar">Review risk</Link>
        </Button>
      ),
    });
  }
  if (summary?.failedCount) {
    workItems.push({
      id: "failed-submissions",
      title: `${summary.failedCount} failed submission${summary.failedCount === 1 ? "" : "s"}`,
      description:
        "Review the rejection reason before sending the invoice again.",
      tone: "critical",
      icon: <FileText className="size-4" aria-hidden="true" />,
      action: (
        <Button asChild size="sm" variant="outline">
          <Link href="/invoices">Resolve</Link>
        </Button>
      ),
    });
  }
  if (summary?.draftCount) {
    workItems.push({
      id: "draft-invoices",
      title: `${summary.draftCount} draft invoice${summary.draftCount === 1 ? " needs" : "s need"} completion`,
      description: "Finish, validate and submit your existing invoice drafts.",
      tone: "warning",
      icon: <FileText className="size-4" aria-hidden="true" />,
      action: (
        <Button asChild size="sm" variant="outline">
          <Link href="/invoices">Open drafts</Link>
        </Button>
      ),
    });
  }
  if (agedReceivableCount > 0) {
    workItems.push({
      id: "aged-receivables",
      title: `${agedReceivableCount} receivable${agedReceivableCount === 1 ? " is" : "s are"} more than 90 days old`,
      description: "Prioritize the oldest balances in the collection queue.",
      tone: "warning",
      icon: <Wallet className="size-4" aria-hidden="true" />,
      action: (
        <Button size="sm" variant="outline" onClick={() => setView("money")}>
          Open money view
        </Button>
      ),
    });
  }
  if (summary?.nextDeadline) {
    workItems.push({
      id: `deadline-${summary.nextDeadline.id}`,
      title: summary.nextDeadline.title,
      description: `Due ${formatLagosDate(summary.nextDeadline.dueDate)}.`,
      tone:
        summary.nextDeadline.severity === "critical"
          ? "critical"
          : summary.nextDeadline.severity === "warning"
            ? "warning"
            : "info",
      icon: <CalendarCheck className="size-4" aria-hidden="true" />,
      action: (
        <Button asChild size="sm" variant="outline">
          <Link href="/calendar">View deadline</Link>
        </Button>
      ),
    });
  }
  return workItems;
}
