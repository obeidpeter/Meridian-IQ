import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Clock3,
  ExternalLink,
  Loader2,
  RefreshCw,
  ListChecks,
  X,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import type {
  OperationRecord,
  OperationState,
  OperationSyncState,
} from "./operation-journal";

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
  verification,
  verifiedAt,
}: Pick<OperationRecord, "title" | "status" | "updatedAt"> &
  Partial<
    Pick<
      OperationRecord,
      "detail" | "savedSummary" | "verification" | "verifiedAt"
    >
  >) {
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
        <p>
          {verification === "server" && verifiedAt
            ? `Server verified ${statusTime(verifiedAt)}`
            : verification === "unconfirmed"
              ? "Not yet verified by the server"
              : "Recorded on this device"}
        </p>
      </div>
    </section>
  );
}

export function ActivityCenter({
  operations,
  onOpen,
  onDismiss,
  onClearCompleted,
  syncState = "local",
  onRefresh,
  onRecover,
}: {
  operations: OperationRecord[];
  onOpen: (route: string) => void;
  onDismiss: (id: string) => void;
  onClearCompleted: () => void;
  syncState?: OperationSyncState;
  onRefresh?: () => void;
  onRecover?: (id: string) => Promise<void>;
}) {
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [resultError, setResultError] = useState<string | null>(null);
  const hasCompleted = operations.some(
    (operation) => operation.status === "succeeded",
  );
  return (
    <section className="mi-activity" aria-label="Recent operations">
      <div className="mi-activity__toolbar">
        <p>
          {operations.length} recent operation
          {operations.length === 1 ? "" : "s"}
        </p>
        {onRefresh ? (
          <button
            type="button"
            onClick={onRefresh}
            disabled={syncState === "syncing"}
            aria-label="Refresh operation history"
            title="Refresh operation history"
          >
            <RefreshCw aria-hidden="true" />
          </button>
        ) : null}
        {hasCompleted ? (
          <button type="button" onClick={onClearCompleted}>
            Clear completed
          </button>
        ) : null}
      </div>
      <p role="status">
        {syncState === "syncing"
          ? "Checking server records..."
          : syncState === "synced"
            ? "Server history checked"
            : syncState === "offline"
              ? "Offline. Showing last available records."
              : syncState === "unavailable"
                ? "Server history is unavailable. Showing last available records."
                : syncState === "forbidden"
                  ? "Server history is not authorized for this session."
                  : "Device history"}
      </p>
      {resultError ? <p role="alert">{resultError}</p> : null}
      {operations.length === 0 ? (
        <div className="mi-activity-empty">
          <CircleDashed aria-hidden="true" />
          <h2>No recorded operations</h2>
        </div>
      ) : null}
      <ol className="mi-activity__list">
        {operations.map((operation) => (
          <li key={operation.id} className="mi-activity__item">
            <OperationStatusPanel {...operation} />
            <div className="mi-activity__actions">
              <button type="button" onClick={() => onOpen(operation.route)}>
                <ExternalLink aria-hidden="true" />
                <span className="mi-activity__action-label">Open source</span>
              </button>
              {operation.serverId && onRecover ? (
                <button
                  type="button"
                  disabled={inspecting === operation.id}
                  onClick={async () => {
                    setInspecting(operation.id);
                    setResultError(null);
                    try {
                      await onRecover(operation.id);
                    } catch {
                      setResultError(
                        "The operation result could not be verified. Refresh and try again.",
                      );
                    } finally {
                      setInspecting(null);
                    }
                  }}
                >
                  <ListChecks aria-hidden="true" />
                  <span className="mi-activity__action-label">
                    {inspecting === operation.id
                      ? "Checking result..."
                      : "Verify result"}
                  </span>
                </button>
              ) : null}
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
            {operation.serverResult ? (
              <details>
                <summary>
                  Saved result (HTTP {operation.serverResult.statusCode})
                </summary>
                <pre
                  role="region"
                  tabIndex={0}
                  aria-label="Saved operation result"
                  style={{
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                    maxHeight: 320,
                    overflowY: "auto",
                  }}
                >
                  {JSON.stringify(operation.serverResult.body, null, 2)}
                </pre>
              </details>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
