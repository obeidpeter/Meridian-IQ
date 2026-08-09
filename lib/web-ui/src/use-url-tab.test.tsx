// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { useUrlTab } from "./use-url-tab";

const VIEWS = ["today", "money", "compliance"] as const;
type View = (typeof VIEWS)[number];

function setSearch(search: string) {
  window.history.replaceState(null, "", `${window.location.pathname}${search}`);
}

afterEach(() => setSearch(""));

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
