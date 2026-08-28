import { useCallback, useEffect, useState } from "react";

export interface PinnedItem {
  id: string;
  label: string;
  detail?: string;
}

export interface SavedView {
  id: string;
  name: string;
  params: Record<string, string>;
  createdAt: string;
}

const SAVED_WORK_EVENT = "meridianiq:saved-work-change";
const MAX_PINNED = 12;
const MAX_VIEWS = 8;

function storageAvailable(): boolean {
  return typeof window !== "undefined" && !!window.localStorage;
}

function emitChange(key: string): void {
  if (!storageAvailable()) return;
  window.dispatchEvent(new CustomEvent(SAVED_WORK_EVENT, { detail: key }));
}

function writeList<T>(key: string, value: T[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    emitChange(key);
  } catch {
    // Saved work is a convenience. Quota/privacy failures must not block work.
  }
}

export function readPinnedItems(key: string): PinnedItem[] {
  if (!storageAvailable()) return [];
  try {
    const value = JSON.parse(
      window.localStorage.getItem(key) ?? "[]",
    ) as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (item): item is PinnedItem =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as PinnedItem).id === "string" &&
          typeof (item as PinnedItem).label === "string" &&
          ((item as PinnedItem).detail === undefined ||
            typeof (item as PinnedItem).detail === "string"),
      )
      .slice(0, MAX_PINNED);
  } catch {
    return [];
  }
}

export function togglePinnedItem(key: string, item: PinnedItem): boolean {
  const current = readPinnedItems(key);
  const wasPinned = current.some((candidate) => candidate.id === item.id);
  const next = wasPinned
    ? current.filter((candidate) => candidate.id !== item.id)
    : [item, ...current.filter((candidate) => candidate.id !== item.id)].slice(
        0,
        MAX_PINNED,
      );
  writeList(key, next);
  return !wasPinned;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.entries(value).every(
      ([key, item]) => typeof key === "string" && typeof item === "string",
    )
  );
}

export function readSavedViews(key: string): SavedView[] {
  if (!storageAvailable()) return [];
  try {
    const value = JSON.parse(
      window.localStorage.getItem(key) ?? "[]",
    ) as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (item): item is SavedView =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as SavedView).id === "string" &&
          typeof (item as SavedView).name === "string" &&
          (item as SavedView).name.trim().length > 0 &&
          typeof (item as SavedView).createdAt === "string" &&
          isStringRecord((item as SavedView).params),
      )
      .slice(0, MAX_VIEWS);
  } catch {
    return [];
  }
}

export function saveNamedView(
  key: string,
  name: string,
  params: Record<string, string>,
): SavedView | null {
  const cleanName = name.trim().slice(0, 48);
  if (!cleanName) return null;
  const current = readSavedViews(key);
  const existing = current.find(
    (view) => view.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase(),
  );
  const view: SavedView = {
    id:
      existing?.id ??
      globalThis.crypto?.randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: cleanName,
    params: { ...params },
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  writeList(
    key,
    [view, ...current.filter((candidate) => candidate.id !== view.id)].slice(
      0,
      MAX_VIEWS,
    ),
  );
  return view;
}

export function removeSavedView(key: string, id: string): void {
  writeList(
    key,
    readSavedViews(key).filter((view) => view.id !== id),
  );
}

function useStoredList<T>(
  key: string | null,
  read: (storageKey: string) => T[],
): T[] {
  const [items, setItems] = useState<T[]>(() => (key ? read(key) : []));
  useEffect(() => {
    const refresh = () => setItems(key ? read(key) : []);
    refresh();
    if (!key || typeof window === "undefined") return;
    const onStorage = (event: StorageEvent) => {
      if (event.key === key) refresh();
    };
    const onLocal = (event: Event) => {
      if ((event as CustomEvent<string>).detail === key) refresh();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(SAVED_WORK_EVENT, onLocal);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(SAVED_WORK_EVENT, onLocal);
    };
  }, [key, read]);
  return items;
}

export function usePinnedItems(key: string | null) {
  const items = useStoredList(key, readPinnedItems);
  const toggle = useCallback(
    (item: PinnedItem) => (key ? togglePinnedItem(key, item) : false),
    [key],
  );
  return {
    items,
    isPinned: (id: string) => items.some((item) => item.id === id),
    toggle,
  };
}

export function useSavedViews(key: string | null) {
  const views = useStoredList(key, readSavedViews);
  const save = useCallback(
    (name: string, params: Record<string, string>) =>
      key ? saveNamedView(key, name, params) : null,
    [key],
  );
  const remove = useCallback(
    (id: string) => {
      if (key) removeSavedView(key, id);
    },
    [key],
  );
  return { views, save, remove };
}
