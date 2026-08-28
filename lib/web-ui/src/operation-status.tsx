import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Clock3,
  ExternalLink,
  Loader2,
  X,
  XCircle,
} from "lucide-react";
import type { OperationRecord, OperationState } from "./operation-journal";

const STATUS_COPY: Record<
  OperationState,
  { label: string; icon: typeof CheckCircle2 }
> = {
  queued: { label: "Queued", icon: Clock3 },
  running: { label: "Running", icon: Loader2 },
  partial: { label: "Needs review", icon: AlertTriangle },
  failed: { label: "Failed", icon: XCircle },
  succeeded: { label: "Completed", icon: CheckCircle2 },
};

function statusTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat("en-NG", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function OperationStatusPanel({
  title,
  status,
  detail,
  savedSummary,
  updatedAt,
}: Pick<OperationRecord, "title" | "status" | "updatedAt"> &
  Partial<Pick<OperationRecord, "detail" | "savedSummary">>) {
  const statusCopy = STATUS_COPY[status];
  const Icon = statusCopy.icon;
  return (
    <section
      className="mi-operation-status"
      data-state={status}
      aria-live={status === "failed" ? "assertive" : "polite"}
      aria-label={`${title}: ${statusCopy.label}`}
    >
      <Icon
        className={status === "running" ? "mi-operation-status__spin" : ""}
        aria-hidden="true"
      />
      <div className="mi-operation-status__copy">
        <div className="mi-operation-status__heading">
          <strong>{title}</strong>
          <span>{statusCopy.label}</span>
        </div>
        {detail ? <p>{detail}</p> : null}
        {savedSummary ? (
          <p className="mi-operation-status__saved">{savedSummary}</p>
        ) : null}
        <time dateTime={updatedAt}>Updated {statusTime(updatedAt)}</time>
      </div>
    </section>
  );
}

export function ActivityCenter({
  operations,
  onOpen,
  onDismiss,
  onClearCompleted,
}: {
  operations: OperationRecord[];
  onOpen: (route: string) => void;
  onDismiss: (id: string) => void;
  onClearCompleted: () => void;
}) {
  if (operations.length === 0) {
    return (
      <section className="mi-activity-empty">
        <CircleDashed aria-hidden="true" />
        <h2>No recorded operations</h2>
        <p>
          Imports, exports, submissions, onboarding, and Clerk work will appear
          here.
        </p>
      </section>
    );
  }
  const hasCompleted = operations.some(
    (operation) => operation.status === "succeeded",
  );
  return (
    <section className="mi-activity" aria-label="Recent operations">
      <div className="mi-activity__toolbar">
        <p>
          {operations.length} operation{operations.length === 1 ? "" : "s"} on
          this device
        </p>
        {hasCompleted ? (
          <button type="button" onClick={onClearCompleted}>
            Clear completed
          </button>
        ) : null}
      </div>
      <ol className="mi-activity__list">
        {operations.map((operation) => (
          <li key={operation.id} className="mi-activity__item">
            <OperationStatusPanel {...operation} />
            <div className="mi-activity__actions">
              <button type="button" onClick={() => onOpen(operation.route)}>
                <ExternalLink aria-hidden="true" />
                Open source
              </button>
              <button
                type="button"
                className="mi-activity__dismiss"
                onClick={() => onDismiss(operation.id)}
                aria-label={`Dismiss ${operation.title}`}
                title="Dismiss"
              >
                <X aria-hidden="true" />
              </button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
