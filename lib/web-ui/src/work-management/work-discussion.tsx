import { AlertCircle, Loader2, RefreshCw, Send } from "lucide-react";
import { LiveStatus } from "../live-status";
import type { CollaborativeWorkComment } from "./types";
import type { CommentComposer } from "./use-comment-composer";

export function WorkDiscussion({
  comments,
  commentsLoading,
  commentsError,
  onRetryComments,
  busy,
  composer,
}: {
  comments: CollaborativeWorkComment[];
  commentsLoading: boolean;
  commentsError?: string | null;
  onRetryComments?: () => void;
  busy: boolean;
  composer: CommentComposer;
}) {
  const { commentKey, commentError } = composer;
  return (
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
              aria-busy={commentsLoading || undefined}
              aria-disabled={commentsLoading || undefined}
              onClick={() => {
                if (commentsLoading) return;
                onRetryComments();
              }}
            >
              <RefreshCw aria-hidden="true" />
              Retry discussion
            </button>
          ) : null}
        </div>
      ) : null}
      <LiveStatus className="mi-collaboration__discussion-status">
        {commentsLoading && comments.length === 0
          ? "Loading discussion…"
          : null}
      </LiveStatus>
      {commentsLoading && comments.length === 0 ? null : comments.length ===
          0 && !commentsError ? (
        <p>No comments yet. Add the first decision or handoff note.</p>
      ) : comments.length > 0 ? (
        <ol>
          {comments.map((entry) => (
            <li key={entry.id}>
              <span>
                <strong>{entry.authorName ?? "Workspace member"}</strong>
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
      <CommentForm busy={busy} composer={composer} />
    </div>
  );
}

function CommentForm({
  busy,
  composer,
}: {
  busy: boolean;
  composer: CommentComposer;
}) {
  const {
    commentKey,
    persistedCommentKey,
    draft,
    comment,
    commentSending,
    setCommentDraft,
    submitComment,
  } = composer;
  return (
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
          readOnly={commentSending}
          aria-busy={commentSending || undefined}
          maxLength={2000}
          rows={3}
          placeholder="Record a decision, question or handoff…"
        />
        <button
          type="submit"
          className="mi-button-primary"
          aria-busy={commentSending || undefined}
          aria-disabled={busy || commentSending || !comment.trim() || undefined}
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
  );
}
