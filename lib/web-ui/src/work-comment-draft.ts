export interface CommentDraft {
  body: string;
  attempt: { body: string; id: string } | null;
}

export function readCommentDraft(key: string | undefined): CommentDraft {
  const empty = { body: "", attempt: null };
  if (!key || typeof window === "undefined") return empty;
  try {
    const value = JSON.parse(
      window.sessionStorage.getItem(key) ?? "null",
    ) as Partial<CommentDraft> | null;
    if (!value || typeof value.body !== "string") return empty;
    const attempt = value.attempt;
    return {
      body: value.body.slice(0, 2000),
      attempt:
        attempt &&
        typeof attempt.body === "string" &&
        attempt.body.length <= 2000 &&
        typeof attempt.id === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          attempt.id,
        )
          ? attempt
          : null,
    };
  } catch {
    return empty;
  }
}

export function saveCommentDraft(
  key: string | undefined,
  draft: CommentDraft,
): void {
  if (!key || typeof window === "undefined") return;
  try {
    if (draft.body || draft.attempt)
      window.sessionStorage.setItem(key, JSON.stringify(draft));
    else window.sessionStorage.removeItem(key);
  } catch {
    // The component retains a task-scoped in-memory copy when storage is blocked.
  }
}
