// The shared Team work component (R126 split the 981-line file into this
// surface, the draft and attempt storage readers, the pure helpers, three
// state hooks and the list, detail, discussion and new-task dialog components
// under ./work-management/). index.ts, the unit suite
// (work-management.test.tsx) and the shared page suite keep importing
// "./work-management": this module is the component's surface.

import { useState } from "react";
import { AlertCircle, Plus, RefreshCw } from "lucide-react";
import { SegmentedControl, WorkspaceHeader } from "./workspace";
import { statusItems } from "./work-management/helpers";
import { NewTaskDialog } from "./work-management/new-task-dialog";
import type {
  CollaborativeAssigneeOption,
  CollaborativeClientOption,
  CollaborativeWorkComment,
  CollaborativeWorkItem,
  CollaborativeWorkStatus,
  CreateCollaborativeWorkInput,
} from "./work-management/types";
import { useCommentComposer } from "./work-management/use-comment-composer";
import { useTaskComposer } from "./work-management/use-task-composer";
import { useWorkList } from "./work-management/use-work-list";
import { WorkDetail } from "./work-management/work-detail";
import { WorkList } from "./work-management/work-list";

export type {
  CollaborativeAssigneeOption,
  CollaborativeClientOption,
  CollaborativeWorkComment,
  CollaborativeWorkItem,
  CollaborativeWorkPriority,
  CollaborativeWorkStatus,
  CreateCollaborativeWorkInput,
} from "./work-management/types";

export function WorkManagement({
  items,
  comments,
  selectedId,
  selectedItem,
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
  legacyDraftStorageKey,
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
  selectedItem?: CollaborativeWorkItem | null;
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
  /** The user-only key drafts were saved under before R116; adopted once. */
  legacyDraftStorageKey?: string;
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
  const [localError, setLocalError] = useState<string | null>(null);
  // Hook order is load-bearing: the selection correction effect runs before
  // the draft effects, exactly as it did in the single-file component.
  const { filter, setFilter, filtered, selected } = useWorkList({
    items,
    pageView,
    selectedId,
    selectedItem,
    onSelect,
  });
  const taskComposer = useTaskComposer({
    draftStorageKey,
    legacyDraftStorageKey,
    assignees,
    busy,
    openNewInitially,
    onCreate,
    setLocalError,
  });
  const commentComposer = useCommentComposer({
    commentDraftStorageKey,
    selectedId,
    selected,
    busy,
    onComment,
  });

  return (
    <div className="mi-collaboration">
      <WorkspaceHeader
        eyebrow="Shared workspace"
        title="Team work"
        description="Assign tasks, set due dates and keep team updates with the relevant client records."
        actions={
          <button
            type="button"
            className="mi-button-primary"
            onClick={() => taskComposer.setNewOpen(true)}
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
        <WorkList
          filtered={filtered}
          filter={filter}
          selectedId={selectedId}
          isLoading={isLoading}
          error={error}
          total={total}
          hasMore={hasMore}
          loadingMore={loadingMore}
          onSelect={onSelect}
          onRetry={onRetry}
          onLoadMore={onLoadMore}
        />

        <WorkDetail
          selected={selected}
          busy={busy}
          assignees={assignees}
          onUpdateStatus={onUpdateStatus}
          onUpdateAssignee={onUpdateAssignee}
          onOpenLinkedRecord={onOpenLinkedRecord}
          setLocalError={setLocalError}
          comments={comments}
          commentsLoading={commentsLoading}
          commentsError={commentsError}
          onRetryComments={onRetryComments}
          composer={commentComposer}
        />
      </div>

      <NewTaskDialog
        composer={taskComposer}
        clients={clients}
        assignees={assignees}
        busy={busy}
      />
    </div>
  );
}
