import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  Loader2,
  Plus,
  RefreshCw,
} from "lucide-react";
import { LiveStatus } from "../live-status";
import { displayStatus, formatWhen } from "./helpers";
import type { CollaborativeWorkItem } from "./types";

export function WorkList({
  filtered,
  filter,
  selectedId,
  isLoading,
  error,
  total,
  hasMore,
  loadingMore,
  onSelect,
  onRetry,
  onLoadMore,
}: {
  filtered: CollaborativeWorkItem[];
  filter: "active" | "done" | "all";
  selectedId: string | null;
  isLoading: boolean;
  error?: string | null;
  total?: number;
  hasMore: boolean;
  loadingMore: boolean;
  onSelect: (id: string | null) => void;
  onRetry: () => void;
  onLoadMore?: () => void;
}) {
  return (
    <section className="mi-collaboration__list" aria-label="Work items">
      {/* Present from the first render so loading and the row count are
          announced as changes, not as freshly mounted regions (R115). */}
      <LiveStatus className="mi-collaboration__loading">
        {isLoading && filtered.length === 0 ? (
          <>
            <Loader2 className="is-spinning" aria-hidden="true" /> Loading team
            work…
          </>
        ) : null}
      </LiveStatus>
      {isLoading && filtered.length === 0 ? null : filtered.length === 0 &&
        error ? (
        <div className="mi-collaboration__empty">
          <AlertCircle aria-hidden="true" />
          <strong>Team work could not be loaded</strong>
          <button type="button" className="mi-button-quiet" onClick={onRetry}>
            <RefreshCw aria-hidden="true" />
            Try again
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="mi-collaboration__empty">
          <CheckCircle2 aria-hidden="true" />
          <strong>
            {filter === "done"
              ? "Nothing completed yet"
              : filter === "all"
                ? "No tasks yet"
                : "No active tasks"}
          </strong>
          <span>
            Create a task when work needs an owner, deadline or discussion.
          </span>
        </div>
      ) : (
        <ol>
          {filtered.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onSelect(item.id)}
                aria-pressed={item.id === selectedId}
                data-priority={item.priority}
              >
                <span className="mi-collaboration__item-topline">
                  <strong>{item.title}</strong>
                  <span>{displayStatus(item.status)}</span>
                </span>
                <small>{item.clientName ?? "Firm-wide work"}</small>
                <span className="mi-collaboration__item-meta">
                  <span>
                    <Clock3 aria-hidden="true" /> {formatWhen(item.dueAt)}
                  </span>
                  <span>{item.assignedToName ?? "Unassigned"}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      <LiveStatus className="mi-collaboration__count">
        {total !== undefined && filtered.length > 0
          ? `Showing ${filtered.length} of ${total} tasks`
          : null}
      </LiveStatus>
      {hasMore && onLoadMore ? (
        <LoadMoreButton
          loadingMore={loadingMore}
          isLoading={isLoading}
          onLoadMore={onLoadMore}
        />
      ) : null}
    </section>
  );
}

// aria-disabled rather than disabled while a page loads (R115): a control
// that disables itself under the keyboard drops focus to the body. The click
// guard does the refusing.
function LoadMoreButton({
  loadingMore,
  isLoading,
  onLoadMore,
}: {
  loadingMore: boolean;
  isLoading: boolean;
  onLoadMore: () => void;
}) {
  return (
    <button
      type="button"
      className="mi-button-quiet"
      aria-busy={loadingMore || undefined}
      aria-disabled={loadingMore || isLoading || undefined}
      onClick={() => {
        if (loadingMore || isLoading) return;
        onLoadMore();
      }}
    >
      {loadingMore ? (
        <Loader2 className="is-spinning" aria-hidden="true" />
      ) : (
        <Plus aria-hidden="true" />
      )}
      {loadingMore ? "Loading more tasks" : "Load more tasks"}
    </button>
  );
}
