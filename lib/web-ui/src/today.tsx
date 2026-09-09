import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  ListChecks,
} from "lucide-react";
import type { ReactNode } from "react";
import { firstInvoiceJourney } from "./first-invoice-journey";
import { FirstInvoiceOnboarding } from "./first-invoice-onboarding";
import type { TodaySetupStepView } from "./today-types";
export type { TodaySetupStepView } from "./today-types";
import { Metric, MetricStrip, WorkQueue, WorkspaceHeader } from "./workspace";

export interface TodayItemView {
  id: string;
  title: string;
  description: string;
  priority: "low" | "normal" | "high" | "urgent";
  status: string;
  dueAt: string | null;
  href: string;
  clientName: string | null;
  source: string;
}

export interface TodaySummaryView {
  total: number;
  urgent: number;
  dueSoon: number;
  blocked: number;
  completedSetupSteps: number;
  totalSetupSteps: number;
}

function readableDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-NG", {
    day: "numeric",
    month: "short",
    year:
      date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  }).format(date);
}

export function TodayWorkspace({
  eyebrow,
  title,
  description,
  summary,
  items,
  setup,
  generatedAt,
  onOpen,
  onManageWork,
  actions,
  setupError,
  setupLoading = false,
  onRetrySetup,
}: {
  eyebrow: string;
  title: string;
  description: string;
  summary: TodaySummaryView;
  items: TodayItemView[];
  setup: TodaySetupStepView[];
  generatedAt: string;
  onOpen: (href: string, item?: TodayItemView) => void;
  onManageWork?: () => void;
  actions?: ReactNode;
  setupError?: string | null;
  setupLoading?: boolean;
  onRetrySetup?: () => void;
}) {
  const journey = firstInvoiceJourney(setup);
  const setupUnavailable = Boolean(setupError) || setupLoading;
  return (
    <div className="mi-today">
      <WorkspaceHeader
        eyebrow={eyebrow}
        title={title}
        description={description}
        actions={actions}
      />

      <MetricStrip label="Today at a glance">
        <Metric
          label="Open priorities"
          value={summary.total}
          detail="Across live records and team work"
          icon={<ListChecks aria-hidden="true" />}
          tone="info"
        />
        <Metric
          label="Urgent"
          value={summary.urgent}
          detail="Overdue or failed"
          icon={<AlertTriangle aria-hidden="true" />}
          tone={summary.urgent ? "critical" : "positive"}
        />
        <Metric
          label="Due in 3 days"
          value={summary.dueSoon}
          detail="Upcoming deadlines"
          icon={<CalendarClock aria-hidden="true" />}
          tone={summary.dueSoon ? "warning" : "default"}
        />
        <Metric
          label="Workspace setup"
          value={
            setupLoading
              ? "Checking"
              : setupUnavailable
                ? "Unavailable"
                : journey.percent === null
                  ? "Not applicable"
                  : `${journey.percent}%`
          }
          detail={
            setupLoading
              ? "Loading setup records"
              : setupUnavailable
                ? "Setup records could not be confirmed"
                : journey.total
                  ? `${journey.completed} of ${journey.total} complete`
                  : "No setup steps for this role"
          }
          icon={<CheckCircle2 aria-hidden="true" />}
          tone={
            !setupUnavailable && journey.percent === 100
              ? "positive"
              : "default"
          }
        />
      </MetricStrip>

      <div className="mi-today__grid">
        <WorkQueue
          title="Priority queue"
          description={`Showing ${items.length} of ${summary.total} priorities. Live view refreshed ${new Intl.DateTimeFormat(
            "en-NG",
            {
              hour: "numeric",
              minute: "2-digit",
            },
          ).format(new Date(generatedAt))}`}
          items={items.map((item) => ({
            id: item.id,
            title: item.title,
            description: item.description,
            tone:
              item.priority === "urgent"
                ? "critical"
                : item.priority === "high"
                  ? "warning"
                  : item.status === "done"
                    ? "positive"
                    : "neutral",
            meta: (
              <>
                <span>{item.source.replaceAll("_", " ")}</span>
                {item.clientName ? <span>{item.clientName}</span> : null}
                {readableDate(item.dueAt) ? (
                  <span>Due {readableDate(item.dueAt)}</span>
                ) : null}
              </>
            ),
            action: (
              <button
                type="button"
                className="mi-today__open"
                onClick={() => onOpen(item.href, item)}
                aria-label={`Open ${item.title}`}
              >
                <ArrowRight aria-hidden="true" />
              </button>
            ),
          }))}
          emptyTitle={
            summary.total
              ? "No priorities in this view"
              : "Your priority queue is clear"
          }
          emptyDescription={
            summary.total
              ? "Open priorities exist, but none were returned in this view."
              : "No failed, overdue or open records need attention right now."
          }
          toolbar={
            onManageWork ? (
              <button
                type="button"
                className="mi-today__text-action"
                onClick={onManageWork}
              >
                Manage work
                <ArrowRight aria-hidden="true" />
              </button>
            ) : undefined
          }
        />

        <FirstInvoiceOnboarding
          setup={setup}
          onOpen={onOpen}
          error={setupError}
          loading={setupLoading}
          onRetry={onRetrySetup}
        />
      </div>
    </div>
  );
}
