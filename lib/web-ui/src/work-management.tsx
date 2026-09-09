import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Send,
  X,
} from "lucide-react";
import { SegmentedControl, WorkspaceHeader } from "./workspace";
import {
  readCommentDraft,
  saveCommentDraft,
  type CommentDraft,
} from "./work-comment-draft";

export type CollaborativeWorkStatus =
  | "open"
  | "in_progress"
  | "blocked"
  | "done";
export type CollaborativeWorkPriority = "low" | "normal" | "high" | "urgent";

export interface CollaborativeWorkItem {
  id: string;
  clientPartyId: string | null;
  clientName: string | null;
  title: string;
  description: string | null;
  status: CollaborativeWorkStatus;
  priority: CollaborativeWorkPriority;
  dueAt: string | null;
  assignedTo: string | null;
  assignedToName: string | null;
  createdByName: string | null;
  href: string | null;
  version: number;
  updatedAt: string;
}

export interface CollaborativeWorkComment {
  id: string;
  authorName: string | null;
  body: string;
  createdAt: string;
}

export interface CollaborativeClientOption {
  id: string;
  name: string;
}

export interface CollaborativeAssigneeOption {
  id: string;
  name: string;
  clientPartyId?: string | null;
}

export interface CreateCollaborativeWorkInput {
  clientRequestId: string;
  clientPartyId?: string;
  title: string;
  description?: string;
  priority: CollaborativeWorkPriority;
  dueAt?: string;
  assignedTo?: string;
}

interface WorkDraft {
  title: string;
  description: string;
  clientPartyId: string;
  priority: CollaborativeWorkPriority;
  dueDate: string;
  assignedTo: string;
}

interface WorkAttempt {
  signature: string;
  id: string;
}

const EMPTY_DRAFT: WorkDraft = {
  title: "",
  description: "",
  clientPartyId: "",
  priority: "normal",
  dueDate: "",
  assignedTo: "",
};

function readDraft(key: string | undefined): WorkDraft {
  if (!key || typeof window === "undefined") return EMPTY_DRAFT;
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(key) ?? "null",
    ) as Partial<WorkDraft> | null;
    if (!parsed || typeof parsed !== "object") return EMPTY_DRAFT;
    const priority = ["low", "normal", "high", "urgent"].includes(
      String(parsed.priority),
    )
      ? (parsed.priority as CollaborativeWorkPriority)
      : "normal";
    return {
      title: typeof parsed.title === "string" ? parsed.title.slice(0, 160) : "",
      description:
        typeof parsed.description === "string"
          ? parsed.description.slice(0, 2000)
          : "",
      clientPartyId:
        typeof parsed.clientPartyId === "string" ? parsed.clientPartyId : "",
      priority,
      dueDate:
        typeof parsed.dueDate === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(parsed.dueDate)
          ? parsed.dueDate
          : "",
      assignedTo:
        typeof parsed.assignedTo === "string" ? parsed.assignedTo : "",
    };
  } catch {
    return EMPTY_DRAFT;
  }
}

function readAttempt(key: string | undefined): WorkAttempt | null {
  if (!key || typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(`${key}:attempt`) ?? "null",
    ) as Partial<WorkAttempt> | null;
    if (
      !parsed ||
      typeof parsed.signature !== "string" ||
      parsed.signature.length > 3_000 ||
      typeof parsed.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        parsed.id,
      )
    ) {
      return null;
    }
    return { signature: parsed.signature, id: parsed.id };
  } catch {
    return null;
  }
}

const statusItems: Array<{ value: "active" | "done" | "all"; label: string }> =
  [
    { value: "active", label: "Active" },
    { value: "done", label: "Completed" },
    { value: "all", label: "All" },
  ];

function formatWhen(value: string | null): string {
  if (!value) return "No due date";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-NG", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(parsed);
}

function displayStatus(status: CollaborativeWorkStatus): string {
  return status.replace("_", " ");
}

export function WorkManagement({
  items,
  comments,
  selectedId,
  clients = [],
  assignees = [],
  isLoading = false,
  commentsLoading = false,
  commentsError,
  onRetryComments,
  commentDraftStorageKey,
  pageView,
  onPageViewChange,
  total,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  busy = false,
  error,
  openNewInitially = false,
  draftStorageKey,
  onSelect,
  onRetry,
  onCreate,
  onUpdateStatus,
  onUpdateAssignee,
  onComment,
  onOpenLinkedRecord,
}: {
  items: CollaborativeWorkItem[];
  comments: CollaborativeWorkComment[];
  selectedId: string | null;
  clients?: CollaborativeClientOption[];
  assignees?: CollaborativeAssigneeOption[];
  isLoading?: boolean;
  commentsLoading?: boolean;
  commentsError?: string | null;
  onRetryComments?: () => void;
  commentDraftStorageKey?: string;
  pageView?: "active" | "done" | "all";
  onPageViewChange?: (view: "active" | "done" | "all") => void;
  total?: number;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  busy?: boolean;
  error?: string | null;
  openNewInitially?: boolean;
  draftStorageKey?: string;
  onSelect: (id: string | null) => void;
  onRetry: () => void;
  onCreate: (input: CreateCollaborativeWorkInput) => Promise<void>;
  onUpdateStatus: (
    item: CollaborativeWorkItem,
    status: CollaborativeWorkStatus,
  ) => Promise<void>;
  onUpdateAssignee?: (
    item: CollaborativeWorkItem,
    assignedTo: string | null,
  ) => Promise<void>;
  onComment: (
    item: CollaborativeWorkItem,
    body: string,
    clientRequestId: string,
  ) => Promise<void>;
  onOpenLinkedRecord?: (href: string) => void;
}) {
  const [initialDraft] = useState(() => readDraft(draftStorageKey));
  const [localFilter, setFilter] = useState<"active" | "done" | "all">(
    "active",
  );
  const filter = pageView ?? localFilter;
  const [newOpen, setNewOpen] = useState(openNewInitially);
  const [title, setTitle] = useState(initialDraft.title);
  const [description, setDescription] = useState(initialDraft.description);
  const [clientPartyId, setClientPartyId] = useState(
    initialDraft.clientPartyId,
  );
  const [priority, setPriority] = useState<CollaborativeWorkPriority>(
    initialDraft.priority,
  );
  const [dueDate, setDueDate] = useState(initialDraft.dueDate);
  const [assignedTo, setAssignedTo] = useState(initialDraft.assignedTo);
  const commentDrafts = useRef(new Map<string, CommentDraft>());
  const [, refreshDraft] = useState(0);
  const commentKey = `${commentDraftStorageKey ?? "memory"}:${selectedId ?? "none"}`;
  const persistedCommentKey =
    commentDraftStorageKey && selectedId ? commentKey : undefined;
  const draft =
    commentDrafts.current.get(commentKey) ??
    readCommentDraft(persistedCommentKey);
  const comment = draft.body;
  const [commentError, setCommentError] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [commentSending, setCommentSending] = useState(false);
  const sendingComment = useRef(false);
  const creatingTask = useRef(false);
  const setCommentDraft = (
    key: string,
    storageKey: string | undefined,
    next: CommentDraft,
  ) => {
    commentDrafts.current.set(key, next);
    saveCommentDraft(storageKey, next);
    refreshDraft((value) => value + 1);
  };
  const [localError, setLocalError] = useState<string | null>(null);
  const taskAttempt = useRef<WorkAttempt | null>(readAttempt(draftStorageKey));
  const loadedDraftKey = useRef(draftStorageKey);

  const filtered = useMemo(
    () =>
      items.filter((item) =>
        filter === "all"
          ? true
          : filter === "done"
            ? item.status === "done"
            : item.status !== "done",
      ),
    [filter, items],
  );
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const assigneesFor = (scope: string | null) =>
    assignees.filter(
      (assignee) => !assignee.clientPartyId || assignee.clientPartyId === scope,
    );
  const newTaskAssignees = assigneesFor(clientPartyId || null);
  const hasDraft = Boolean(
    title || description || clientPartyId || dueDate || assignedTo,
  );

  useEffect(() => {
    if (selectedId && filtered.some((item) => item.id === selectedId)) return;
    onSelect(filtered[0]?.id ?? null);
  }, [filtered, onSelect, selectedId]);

  useEffect(() => {
    if (!draftStorageKey || loadedDraftKey.current === draftStorageKey) return;
    loadedDraftKey.current = draftStorageKey;
    taskAttempt.current = readAttempt(draftStorageKey);
    if (hasDraft) return;
    const draft = readDraft(draftStorageKey);
    setTitle(draft.title);
    setDescription(draft.description);
    setClientPartyId(draft.clientPartyId);
    setPriority(draft.priority);
    setDueDate(draft.dueDate);
    setAssignedTo(draft.assignedTo);
  }, [draftStorageKey, hasDraft]);

  useEffect(() => {
    if (!draftStorageKey || typeof window === "undefined") return;
    const draft: WorkDraft = {
      title,
      description,
      clientPartyId,
      priority,
      dueDate,
      assignedTo,
    };
    try {
      if (title || description || clientPartyId || dueDate || assignedTo) {
        window.localStorage.setItem(draftStorageKey, JSON.stringify(draft));
      } else {
        window.localStorage.removeItem(draftStorageKey);
      }
    } catch {
      // Storage may be unavailable in private or locked-down browser modes.
    }
  }, [
    assignedTo,
    clientPartyId,
    description,
    draftStorageKey,
    dueDate,
    priority,
    title,
  ]);

  const submitNew = async (event: FormEvent) => {
    event.preventDefault();
    if (creatingTask.current || busy || title.trim().length < 2) return;
    creatingTask.current = true;
    setLocalError(null);
    try {
      const input = {
        ...(clientPartyId ? { clientPartyId } : {}),
        title: title.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        priority,
        ...(dueDate
          ? { dueAt: new Date(`${dueDate}T12:00:00`).toISOString() }
          : {}),
        ...(assignedTo ? { assignedTo } : {}),
      };
      const signature = JSON.stringify(input);
      if (taskAttempt.current?.signature !== signature) {
        taskAttempt.current = { signature, id: crypto.randomUUID() };
      }
      if (draftStorageKey) {
        try {
          window.localStorage.setItem(
            `${draftStorageKey}:attempt`,
            JSON.stringify(taskAttempt.current),
          );
        } catch {
          // The in-memory key still protects retries until the page is closed.
        }
      }
      await onCreate({
        clientRequestId: taskAttempt.current.id,
        ...input,
      });
      taskAttempt.current = null;
      setTitle("");
      setDescription("");
      setClientPartyId("");
      setPriority("normal");
      setDueDate("");
      setAssignedTo("");
      if (draftStorageKey) {
        try {
          window.localStorage.removeItem(draftStorageKey);
          window.localStorage.removeItem(`${draftStorageKey}:attempt`);
        } catch {
          // State has still been cleared when storage is unavailable.
        }
      }
      setNewOpen(false);
    } catch (caught) {
      setLocalError(
        caught instanceof Error
          ? caught.message
          : "The task could not be created.",
      );
    } finally {
      creatingTask.current = false;
    }
  };

  const submitComment = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !comment.trim() || busy || sendingComment.current) return;
    sendingComment.current = true;
    setCommentSending(true);
    const body = comment.trim();
    const attempt =
      draft.attempt?.body === body
        ? draft.attempt
        : { body, id: crypto.randomUUID() };
    setCommentDraft(commentKey, persistedCommentKey, {
      body: comment,
      attempt,
    });
    setCommentError(null);
    try {
      await onComment(selected, body, attempt.id);
      setCommentDraft(commentKey, persistedCommentKey, {
        body: "",
        attempt: null,
      });
    } catch (caught) {
      setCommentError({
        key: commentKey,
        message:
          caught instanceof Error
            ? caught.message
            : "The comment could not be added. Your draft is retained.",
      });
    } finally {
      sendingComment.current = false;
      setCommentSending(false);
    }
  };

  return (
    <div className="mi-collaboration">
      <WorkspaceHeader
        eyebrow="Shared workspace"
        title="Team work"
        description="Assign owners, due dates and decisions alongside the client records they affect."
        actions={
          <button
            type="button"
            className="mi-button-primary"
            onClick={() => setNewOpen(true)}
          >
            <Plus aria-hidden="true" />
            New task
          </button>
        }
      />

      <div className="mi-collaboration__toolbar">
        <SegmentedControl
          label="Filter team work"
          items={statusItems}
          value={filter}
          onChange={(value) => {
            const next = value as typeof filter;
            if (onPageViewChange) onPageViewChange(next);
            else setFilter(next);
          }}
        />
        <button
          type="button"
          className="mi-button-quiet"
          onClick={onRetry}
          disabled={isLoading}
        >
          <RefreshCw
            className={isLoading ? "is-spinning" : undefined}
            aria-hidden="true"
          />
          Refresh
        </button>
      </div>

      {error || localError ? (
        <div className="mi-collaboration__error" role="alert">
          <AlertCircle aria-hidden="true" />
          <span>{localError ?? error}</span>
        </div>
      ) : null}

      <div className="mi-collaboration__grid">
        <section className="mi-collaboration__list" aria-label="Work items">
          {isLoading && filtered.length === 0 ? (
            <div className="mi-collaboration__loading" role="status">
              <Loader2 className="is-spinning" aria-hidden="true" /> Loading
              team work…
            </div>
          ) : filtered.length === 0 && error ? (
            <div className="mi-collaboration__empty">
              <AlertCircle aria-hidden="true" />
              <strong>Team work could not be loaded</strong>
              <button
                type="button"
                className="mi-button-quiet"
                onClick={onRetry}
              >
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
          {total !== undefined && filtered.length > 0 ? (
            <p role="status">
              Showing {filtered.length} of {total} tasks
            </p>
          ) : null}
          {hasMore && onLoadMore ? (
            <button
              type="button"
              className="mi-button-quiet"
              onClick={onLoadMore}
              disabled={loadingMore || isLoading}
            >
              {loadingMore ? (
                <Loader2 className="is-spinning" aria-hidden="true" />
              ) : (
                <Plus aria-hidden="true" />
              )}
              {loadingMore ? "Loading more tasks" : "Load more tasks"}
            </button>
          ) : null}
        </section>

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
                      {assigneesFor(selected.clientPartyId).map((assignee) => (
                        <option key={assignee.id} value={assignee.id}>
                          {assignee.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <strong>{selected.assignedToName ?? "Unassigned"}</strong>
                  )}
                </div>
              </div>

              <div className="mi-collaboration__discussion">
                <h3>Discussion</h3>
                {commentsError ? (
                  <div className="mi-collaboration__error" role="alert">
                    <AlertCircle aria-hidden="true" />
                    <span>
                      {comments.length
                        ? "Discussion could not be refreshed. Showing the last loaded comments."
                        : "Discussion could not be loaded."}
                    </span>
                    {onRetryComments ? (
                      <button
                        type="button"
                        className="mi-button-quiet"
                        onClick={onRetryComments}
                        disabled={commentsLoading}
                      >
                        <RefreshCw aria-hidden="true" />
                        Retry discussion
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {commentsLoading && comments.length === 0 ? (
                  <p role="status">Loading discussion…</p>
                ) : comments.length === 0 && !commentsError ? (
                  <p>
                    No comments yet. Add the first decision or handoff note.
                  </p>
                ) : comments.length > 0 ? (
                  <ol>
                    {comments.map((entry) => (
                      <li key={entry.id}>
                        <span>
                          <strong>
                            {entry.authorName ?? "Workspace member"}
                          </strong>
                          <time dateTime={entry.createdAt}>
                            {new Intl.DateTimeFormat("en-NG", {
                              day: "numeric",
                              month: "short",
                              hour: "numeric",
                              minute: "2-digit",
                            }).format(new Date(entry.createdAt))}
                          </time>
                        </span>
                        <p>{entry.body}</p>
                      </li>
                    ))}
                  </ol>
                ) : null}
                {commentError?.key === commentKey ? (
                  <p role="alert">{commentError.message}</p>
                ) : null}
                <form onSubmit={submitComment}>
                  <label htmlFor="work-comment">Add a comment</label>
                  <div>
                    <textarea
                      id="work-comment"
                      value={comment}
                      onChange={(event) =>
                        setCommentDraft(commentKey, persistedCommentKey, {
                          ...draft,
                          body: event.target.value,
                        })
                      }
                      disabled={commentSending}
                      maxLength={2000}
                      rows={3}
                      placeholder="Record a decision, question or handoff…"
                    />
                    <button
                      type="submit"
                      className="mi-button-primary"
                      disabled={busy || commentSending || !comment.trim()}
                    >
                      {commentSending ? (
                        <Loader2 className="is-spinning" aria-hidden="true" />
                      ) : (
                        <Send aria-hidden="true" />
                      )}
                      {commentSending ? "Sending comment" : "Comment"}
                    </button>
                  </div>
                </form>
              </div>
            </>
          )}
        </section>
      </div>

      <Dialog.Root open={newOpen} onOpenChange={setNewOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="mi-dialog-overlay" />
          <Dialog.Content className="mi-work-dialog">
            <div className="mi-work-dialog__heading">
              <div>
                <Dialog.Title>New task</Dialog.Title>
                <Dialog.Description>
                  Give the work a clear outcome, owner context and due date.
                </Dialog.Description>
                {hasDraft ? (
                  <p className="mi-work-dialog__saved" role="status">
                    Draft saved on this device.
                  </p>
                ) : null}
              </div>
              <Dialog.Close
                className="mi-icon-button"
                aria-label="Close new task dialog"
              >
                <X aria-hidden="true" />
              </Dialog.Close>
            </div>
            <form onSubmit={submitNew}>
              {clients.length > 0 ? (
                <label>
                  Client
                  <select
                    value={clientPartyId}
                    onChange={(event) => {
                      const nextClient = event.target.value;
                      setClientPartyId(nextClient);
                      if (
                        assignedTo &&
                        !assigneesFor(nextClient || null).some(
                          (assignee) => assignee.id === assignedTo,
                        )
                      ) {
                        setAssignedTo("");
                      }
                    }}
                  >
                    <option value="">Firm-wide task</option>
                    {clients.map((client) => (
                      <option key={client.id} value={client.id}>
                        {client.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {assignees.length > 0 ? (
                <label>
                  Owner <span>Optional</span>
                  <select
                    value={assignedTo}
                    onChange={(event) => setAssignedTo(event.target.value)}
                  >
                    <option value="">Unassigned</option>
                    {newTaskAssignees.map((assignee) => (
                      <option key={assignee.id} value={assignee.id}>
                        {assignee.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label>
                Task title
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  minLength={2}
                  maxLength={160}
                  required
                  autoFocus
                  placeholder="e.g. Confirm July VAT return"
                />
              </label>
              <label>
                Context <span>Optional</span>
                <textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  maxLength={2000}
                  rows={3}
                  placeholder="What outcome is needed?"
                />
              </label>
              <div className="mi-work-dialog__row">
                <label>
                  Priority
                  <select
                    value={priority}
                    onChange={(event) =>
                      setPriority(
                        event.target.value as CollaborativeWorkPriority,
                      )
                    }
                  >
                    <option value="low">Low</option>
                    <option value="normal">Normal</option>
                    <option value="high">High</option>
                    <option value="urgent">Urgent</option>
                  </select>
                </label>
                <label>
                  Due date <span>Optional</span>
                  <input
                    type="date"
                    value={dueDate}
                    onChange={(event) => setDueDate(event.target.value)}
                  />
                </label>
              </div>
              <div className="mi-work-dialog__actions">
                <Dialog.Close className="mi-button-quiet" type="button">
                  Cancel
                </Dialog.Close>
                <button
                  type="submit"
                  className="mi-button-primary"
                  disabled={busy || title.trim().length < 2}
                >
                  {busy ? (
                    <Loader2 className="is-spinning" aria-hidden="true" />
                  ) : (
                    <Plus aria-hidden="true" />
                  )}
                  Create task
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
