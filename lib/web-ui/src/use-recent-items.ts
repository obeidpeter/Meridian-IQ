import { useEffect } from "react";

/**
 * Per-viewer "recently opened" lists (recognition over recall): detail pages
 * record the record they show, and the command menu offers the last few back.
 * localStorage only — a per-device convenience, never shared state — so every
 * read and write is wrapped and a blocked storage silently yields an empty
 * list. Keys are scoped per user id by the caller; the sign-out sweeps clear
 * the "meridianiq:recent-" prefix so nothing lingers on a shared machine.
 */
export interface RecentItem {
  id: string;
  label: string;
  detail?: string;
}

const MAX_RECENTS = 6;

export function readRecentItems(key: string): RecentItem[] {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is RecentItem =>
        typeof x === "object" &&
        x !== null &&
        typeof (x as RecentItem).id === "string" &&
        typeof (x as RecentItem).label === "string",
    );
  } catch {
    return [];
  }
}

export function recordRecentItem(key: string, item: RecentItem): void {
  try {
    const next = [
      item,
      ...readRecentItems(key).filter((x) => x.id !== item.id),
    ].slice(0, MAX_RECENTS);
    window.localStorage.setItem(key, JSON.stringify(next));
  } catch {
    /* storage unavailable — recents are a convenience, never required */
  }
}

/** Record on mount / when the record resolves; no-ops until all parts exist. */
export function useRecordRecentItem(
  key: string | null,
  item: RecentItem | null,
): void {
  // Primitive deps so a caller's fresh object literal never re-fires.
  const id = item?.id ?? null;
  const label = item?.label ?? null;
  const detail = item?.detail;
  useEffect(() => {
    if (!key || !id || !label) return;
    recordRecentItem(key, detail === undefined ? { id, label } : { id, label, detail });
  }, [key, id, label, detail]);
}
