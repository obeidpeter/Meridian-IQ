import type {
  ClientRisk,
  ComplianceDeadline,
  ConsoleInvoice,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { AlertTriangle, CalendarClock } from "lucide-react";
import { formatDate, humanize } from "@/lib/format";
import type { WorkQueueItem } from "@workspace/web-ui";
import type { ClientView } from "./helpers";

// The Today view's work queue: submission failures first, then the nearest
// statutory deadlines.
export function clientWorkItems({
  client,
  deadlines,
  visibleViews,
  setView,
}: {
  client: ClientRisk;
  deadlines: ComplianceDeadline[];
  visibleViews: ClientView[];
  setView: (next: ClientView) => void;
}): WorkQueueItem[] {
  const workItems: WorkQueueItem[] = [];

  if (client.failingInvoiceIds.length > 0) {
    workItems.push({
      id: "failing-invoices",
      title: `${client.failingInvoiceIds.length} invoice${client.failingInvoiceIds.length === 1 ? "" : "s"} need attention`,
      description:
        "Resolve failed or overdue submissions before the next filing cycle.",
      tone: "critical",
      icon: <AlertTriangle className="size-4" aria-hidden="true" />,
      action: (
        <Button size="sm" variant="outline" onClick={() => setView("invoices")}>
          Review invoices
        </Button>
      ),
    });
  }

  deadlines.slice(0, 4).forEach((deadline) => {
    workItems.push({
      id: `deadline-${deadline.id}`,
      title: deadline.title,
      description: `Due ${formatDate(deadline.dueDate)} · ${humanize(deadline.status)}`,
      tone: deadline.severity === "critical" ? "critical" : "warning",
      icon: <CalendarClock className="size-4" aria-hidden="true" />,
      // When the Tax & filings tab is feature-dark the deadline still lists
      // (the Deadlines card beside this queue carries it) — no dead hop.
      action: visibleViews.includes("compliance") ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => setView("compliance")}
        >
          Open filings
        </Button>
      ) : undefined,
    });
  });

  return workItems;
}

// The segmented control's items, narrowed to the views the launch profile
// lights.
export function clientViewItems({
  workItems,
  invoices,
  deadlines,
  visibleViews,
}: {
  workItems: WorkQueueItem[];
  invoices: ConsoleInvoice[];
  deadlines: ComplianceDeadline[];
  visibleViews: ClientView[];
}): Array<{ value: ClientView; label: string; count?: number }> {
  const allViews: Array<{
    value: ClientView;
    label: string;
    count?: number;
  }> = [
    { value: "today", label: "Today", count: workItems.length },
    { value: "invoices", label: "Invoices", count: invoices.length },
    { value: "money", label: "Money" },
    { value: "compliance", label: "Tax & filings", count: deadlines.length },
    { value: "clerk", label: "Clerk" },
    { value: "setup", label: "Setup" },
  ];
  const views = allViews.filter((v) => visibleViews.includes(v.value));
  return views;
}
