import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  Check,
  CheckCircle2,
  Circle,
  ListChecks,
} from "lucide-react";
import type { ReactNode } from "react";
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

export interface TodaySetupStepView {
  id: string;
  label: string;
  description: string;
  complete: boolean;
  href: string;
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
}) {
  const setupPercent = summary.totalSetupSteps
    ? Math.round((summary.completedSetupSteps / summary.totalSetupSteps) * 100)
    : 100;
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
          value={`${setupPercent}%`}
          detail={`${summary.completedSetupSteps} of ${summary.totalSetupSteps} complete`}
          icon={<CheckCircle2 aria-hidden="true" />}
          tone={setupPercent === 100 ? "positive" : "default"}
        />
      </MetricStrip>

      <div className="mi-today__grid">
        <WorkQueue
          title="Priority queue"
          description={`Live view refreshed ${new Intl.DateTimeFormat("en-NG", {
            hour: "numeric",
            minute: "2-digit",
          }).format(new Date(generatedAt))}`}
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
          emptyTitle="Your priority queue is clear"
          emptyDescription="No failed, overdue or open records need attention right now."
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

        <section
          className="mi-today__setup"
          aria-labelledby="mi-today-setup-title"
        >
          <div className="mi-today__setup-heading">
            <div>
              <p id="mi-today-setup-title">Getting ready</p>
              <span>Recommended steps for this workspace</span>
            </div>
            <strong>{setupPercent}%</strong>
          </div>
          <div
            className="mi-today__progress"
            role="progressbar"
            aria-label="Workspace setup progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={setupPercent}
          >
            <span style={{ width: `${setupPercent}%` }} />
          </div>
          {setup.length === 0 ? (
            <p className="mi-today__setup-empty">
              No setup steps apply to this role.
            </p>
          ) : (
            <ol className="mi-today__setup-list">
              {setup.map((step) => (
                <li key={step.id} data-complete={step.complete}>
                  <span className="mi-today__setup-marker" aria-hidden="true">
                    {step.complete ? <Check /> : <Circle />}
                  </span>
                  <button type="button" onClick={() => onOpen(step.href)}>
                    <strong>{step.label}</strong>
                    <span className="mi-today__step-status">
                      {step.complete ? "Completed" : "Not completed"}
                    </span>
                    <small>{step.description}</small>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}
