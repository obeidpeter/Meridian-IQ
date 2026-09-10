import { useRef, useState, type FormEvent } from "react";
import {
  readCommentDraft,
  saveCommentDraft,
  type CommentDraft,
} from "../work-comment-draft";
import type { CollaborativeWorkItem } from "./types";

export function useCommentComposer({
  commentDraftStorageKey,
  selectedId,
  selected,
  busy,
  onComment,
}: {
  commentDraftStorageKey?: string;
  selectedId: string | null;
  selected: CollaborativeWorkItem | null | undefined;
  busy: boolean;
  onComment: (
    item: CollaborativeWorkItem,
    body: string,
    clientRequestId: string,
  ) => Promise<void>;
}) {
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
  const setCommentDraft = (
    key: string,
    storageKey: string | undefined,
    next: CommentDraft,
  ) => {
    commentDrafts.current.set(key, next);
    saveCommentDraft(storageKey, next);
    refreshDraft((value) => value + 1);
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

  return {
    commentKey,
    persistedCommentKey,
    draft,
    comment,
    commentError,
    commentSending,
    setCommentDraft,
    submitComment,
  };
}

export type CommentComposer = ReturnType<typeof useCommentComposer>;
