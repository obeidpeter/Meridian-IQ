import { useEffect, useMemo, useState } from "react";
import type { CollaborativeWorkItem } from "./types";

export function useWorkList({
  items,
  pageView,
  selectedId,
  selectedItem,
  onSelect,
}: {
  items: CollaborativeWorkItem[];
  pageView?: "active" | "done" | "all";
  selectedId: string | null;
  selectedItem?: CollaborativeWorkItem | null;
  onSelect: (id: string | null) => void;
}) {
  const [localFilter, setFilter] = useState<"active" | "done" | "all">(
    "active",
  );
  const filter = pageView ?? localFilter;

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
  const selected =
    items.find((item) => item.id === selectedId) ??
    (selectedItem?.id === selectedId ? selectedItem : null);

  useEffect(() => {
    if (
      selected &&
      (filter === "all" ||
        (filter === "done"
          ? selected.status === "done"
          : selected.status !== "done"))
    )
      return;
    onSelect(filtered[0]?.id ?? null);
  }, [filter, filtered, onSelect, selected]);

  return { filter, setFilter, filtered, selected };
}
