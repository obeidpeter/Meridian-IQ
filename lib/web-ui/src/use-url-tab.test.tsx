// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { useUrlTab } from "./use-url-tab";
import {
  UnsavedWorkProvider,
  useProtectedHistoryState,
  useProtectedSearch,
  useUnsavedWork,
} from "./unsaved-work";

const VIEWS = ["today", "money", "compliance"] as const;
type View = (typeof VIEWS)[number];

function setSearch(search: string) {
  window.history.replaceState(null, "", `${window.location.pathname}${search}`);
}

afterEach(() => {
  cleanup();
  setSearch("");
});

test("initialises from the query parameter", () => {
  setSearch("?tab=money");
  const { result } = renderHook(() => useUrlTab<View>("tab", "today", VIEWS));
  expect(result.current[0]).toBe("money");
});

test("falls back on a missing or unknown value", () => {
  setSearch("?tab=nonsense");
  const { result } = renderHook(() => useUrlTab<View>("tab", "today", VIEWS));
  expect(result.current[0]).toBe("today");

  setSearch("");
  const bare = renderHook(() => useUrlTab<View>("tab", "today", VIEWS));
  expect(bare.result.current[0]).toBe("today");
});

test("selecting writes the parameter via replaceState and clears it on the fallback", () => {
  setSearch("?keep=1");
  const { result } = renderHook(() => useUrlTab<View>("tab", "today", VIEWS));

  act(() => result.current[1]("compliance"));
  expect(result.current[0]).toBe("compliance");
  const params = new URLSearchParams(window.location.search);
  expect(params.get("tab")).toBe("compliance");
  expect(params.get("keep")).toBe("1");

  act(() => result.current[1]("today"));
  expect(new URLSearchParams(window.location.search).get("tab")).toBeNull();
  expect(new URLSearchParams(window.location.search).get("keep")).toBe("1");
});

test("popstate re-reads the URL", () => {
  const { result } = renderHook(() => useUrlTab<View>("tab", "today", VIEWS));
  expect(result.current[0]).toBe("today");

  act(() => {
    setSearch("?tab=money");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(result.current[0]).toBe("money");
});

test("protected tab replacements keep router search, state, other params and hash synchronized", () => {
  window.history.replaceState({ from: "business" }, "", "/?keep=1#section");
  const length = window.history.length;
  const { result } = renderHook(
    () => ({
      tab: useUrlTab<View>("tab", "today", VIEWS),
      search: useProtectedSearch(),
      state: useProtectedHistoryState(),
    }),
    { wrapper: UnsavedWorkProvider },
  );
  act(() => result.current.tab[1]("money"));
  expect(result.current.tab[0]).toBe("money");
  expect(result.current.search).toBe("?keep=1&tab=money");
  expect(result.current.state).toEqual({ from: "business" });
  expect(window.location.hash).toBe("#section");
  expect(window.history.length).toBe(length);
});

test("a tab replacement cannot update local state ahead of a blocked navigation", async () => {
  setSearch("?tab=money");
  const { result } = renderHook(
    () => {
      useUnsavedWork({
        dirty: true,
        save: async () => false,
        discard: () => true,
      });
      return useUrlTab<View>("tab", "today", VIEWS);
    },
    { wrapper: UnsavedWorkProvider },
  );
  act(() => result.current[1]("compliance"));
  expect(result.current[0]).toBe("money");
  expect(window.location.search).toBe("?tab=money");
  fireEvent.click(await screen.findByRole("button", { name: "Stay" }));
  expect(result.current[0]).toBe("money");
});
