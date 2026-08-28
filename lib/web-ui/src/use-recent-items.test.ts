// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { readRecentItems, recordRecentItem } from "./use-recent-items";

const KEY = "meridianiq:recent-invoices:user-1";
afterEach(() => window.localStorage.clear());

describe("recent items", () => {
  test("newest first, deduplicated by id", () => {
    recordRecentItem(KEY, { id: "a", label: "INV-1" });
    recordRecentItem(KEY, { id: "b", label: "INV-2" });
    recordRecentItem(KEY, { id: "a", label: "INV-1 (updated)" });
    expect(readRecentItems(KEY).map((x) => x.id)).toEqual(["a", "b"]);
    expect(readRecentItems(KEY)[0].label).toBe("INV-1 (updated)");
  });

  test("caps the list at six", () => {
    for (let i = 0; i < 9; i++) {
      recordRecentItem(KEY, { id: String(i), label: `INV-${i}` });
    }
    const items = readRecentItems(KEY);
    expect(items).toHaveLength(6);
    expect(items[0].id).toBe("8");
  });

  test("corrupt storage reads as empty, never throws", () => {
    window.localStorage.setItem(KEY, "{not json");
    expect(readRecentItems(KEY)).toEqual([]);
    window.localStorage.setItem(KEY, JSON.stringify({ nope: true }));
    expect(readRecentItems(KEY)).toEqual([]);
  });
});
