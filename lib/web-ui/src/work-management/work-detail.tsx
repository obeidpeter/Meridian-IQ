import { ArrowRight, MessageSquare } from "lucide-react";
import { assigneesFor, formatWhen } from "./helpers";
import type {
  CollaborativeAssigneeOption,
  CollaborativeWorkComment,
  CollaborativeWorkItem,
  CollaborativeWorkStatus,
} from "./types";
import type { CommentComposer } from "./use-comment-composer";
import { WorkDiscussion } from "./work-discussion";

export function WorkDetail({
  selected,
  busy,
  assignees,
  onUpdateStatus,
  onUpdateAssignee,
  onOpenLinkedRecord,
  setLocalError,
  comments,
  commentsLoading,
  commentsError,
  onRetryComments,
  composer,
}: {
  selected: CollaborativeWorkItem | null | undefined;
  busy: boolean;
  assignees: CollaborativeAssigneeOption[];
  onUpdateStatus: (
    item: CollaborativeWorkItem,
    status: CollaborativeWorkStatus,
  ) => Promise<void>;
  onUpdateAssignee?: (
    item: CollaborativeWorkItem,
    assignedTo: string | null,
  ) => Promise<void>;
  onOpenLinkedRecord?: (href: string) => void;
  setLocalError: (message: string | null) => void;
  comments: CollaborativeWorkComment[];
  commentsLoading: boolean;
  commentsError?: string | null;
  onRetryComments?: () => void;
  composer: CommentComposer;
}) {
  return (
    <section
      className="mi-collaboration__detail"
      aria-label="Selected work item"
    >
      {!selected ? (
        <div className="mi-collaboration__empty">
          <MessageSquare aria-hidden="true" />
          <strong>Select a task</strong>
          <span>Its owner, status and discussion will appear here.</span>
        </div>
      ) : (
        <>
          <header>
            <div>
              <p>{selected.clientName ?? "Firm-wide work"}</p>
              <h2>{selected.title}</h2>
              {selected.description ? (
                <span>{selected.description}</span>
              ) : null}
            </div>
            {selected.href && onOpenLinkedRecord ? (
              <button
                type="button"
                className="mi-button-quiet"
                onClick={() => onOpenLinkedRecord(selected.href!)}
              >
                Open record <ArrowRight aria-hidden="true" />
              </button>
            ) : null}
          </header>

          <div className="mi-collaboration__facts">
            <label>
              Status
              <select
                value={selected.status}
                onChange={(event) =>
                  void onUpdateStatus(
                    selected,
                    event.target.value as CollaborativeWorkStatus,
                  ).catch((caught) =>
                    setLocalError(
                      caught instanceof Error
                        ? caught.message
                        : "The task changed elsewhere. Refresh and try again.",
                    ),
                  )
                }
                disabled={busy}
              >
                <option value="open">Open</option>
                <option value="in_progress">In progress</option>
                <option value="blocked">Blocked</option>
                <option value="done">Done</option>
              </select>
            </label>
            <div>
              <span>Priority</span>
              <strong data-priority={selected.priority}>
                {selected.priority}
              </strong>
            </div>
            <div>
              <span>Due</span>
              <strong>{formatWhen(selected.dueAt)}</strong>
            </div>
            <div>
              <span>Owner</span>
              {onUpdateAssignee ? (
                <select
                  aria-label="Task owner"
                  value={selected.assignedTo ?? ""}
                  onChange={(event) => {
                    setLocalError(null);
                    void onUpdateAssignee(
                      selected,
                      event.target.value || null,
                    ).catch((caught) =>
                      setLocalError(
                        caught instanceof Error
                          ? caught.message
                          : "The owner could not be changed.",
                      ),
                    );
                  }}
                  disabled={busy}
                >
                  <option value="">Unassigned</option>
                  {assigneesFor(assignees, selected.clientPartyId).map(
                    (assignee) => (
                      <option key={assignee.id} value={assignee.id}>
                        {assignee.name}
                      </option>
                    ),
                  )}
                </select>
              ) : (
                <strong>{selected.assignedToName ?? "Unassigned"}</strong>
              )}
            </div>
          </div>

          <WorkDiscussion
            comments={comments}
            commentsLoading={commentsLoading}
            commentsError={commentsError}
            onRetryComments={onRetryComments}
            busy={busy}
            composer={composer}
          />
        </>
      )}
    </section>
  );
}
