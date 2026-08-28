// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import {
  readPinnedItems,
  readSavedViews,
  removeSavedView,
  saveNamedView,
  togglePinnedItem,
} from "./use-saved-work";

const PIN_KEY = "meridianiq:pinned-invoices:user-1";
const VIEW_KEY = "meridianiq:saved-view-portfolio:user-1";

afterEach(() => window.localStorage.clear());

describe("saved work", () => {
  test("pins, updates, and unpins an item", () => {
    expect(togglePinnedItem(PIN_KEY, { id: "a", label: "INV-1" })).toBe(true);
    expect(togglePinnedItem(PIN_KEY, { id: "b", label: "INV-2" })).toBe(true);
    expect(readPinnedItems(PIN_KEY).map((item) => item.id)).toEqual(["b", "a"]);
    expect(togglePinnedItem(PIN_KEY, { id: "a", label: "INV-1" })).toBe(false);
    expect(readPinnedItems(PIN_KEY).map((item) => item.id)).toEqual(["b"]);
  });

  test("upserts a named view without duplicating it", () => {
    const first = saveNamedView(VIEW_KEY, "High risk", {
      risk: "high",
      sort: "risk",
    });
    const updated = saveNamedView(VIEW_KEY, " high risk ", {
      risk: "high",
      sort: "deadline",
    });
    expect(updated?.id).toBe(first?.id);
    expect(readSavedViews(VIEW_KEY)).toHaveLength(1);
    expect(readSavedViews(VIEW_KEY)[0].params.sort).toBe("deadline");
    removeSavedView(VIEW_KEY, first!.id);
    expect(readSavedViews(VIEW_KEY)).toEqual([]);
  });

  test("treats malformed stored data as empty", () => {
    window.localStorage.setItem(PIN_KEY, "not-json");
    window.localStorage.setItem(VIEW_KEY, JSON.stringify([{ name: 7 }]));
    expect(readPinnedItems(PIN_KEY)).toEqual([]);
    expect(readSavedViews(VIEW_KEY)).toEqual([]);
  });
});
