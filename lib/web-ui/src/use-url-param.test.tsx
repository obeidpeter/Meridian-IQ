// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useUrlParam } from "./use-url-param";
import {
  UnsavedWorkProvider,
  useProtectedSearch,
  useProtectedHistoryState,
} from "./unsaved-work";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("useUrlParam", () => {
  test("protected filter replacements synchronize multiple consumers without adding history", () => {
    window.history.replaceState("route-payload", "", "/?tab=money#results");
    const length = window.history.length;
    const { result } = renderHook(
      () => ({
        filter: useUrlParam("q"),
        other: useUrlParam("q"),
        search: useProtectedSearch(),
        state: useProtectedHistoryState(),
      }),
      { wrapper: UnsavedWorkProvider },
    );
    act(() => result.current.filter[1]("cedar"));
    expect(result.current.filter[0]).toBe("cedar");
    expect(result.current.other[0]).toBe("cedar");
    expect(result.current.search).toBe("?tab=money&q=cedar");
    expect(result.current.state).toBe("route-payload");
    expect(window.location.hash).toBe("#results");
    expect(window.history.length).toBe(length);
    act(() => result.current.filter[1](""));
    expect(result.current.search).toBe("?tab=money");
  });

  test("reads the initial value from the URL", () => {
    window.history.replaceState(null, "", "/?q=adaeze");
    const { result } = renderHook(() => useUrlParam("q"));
    expect(result.current[0]).toBe("adaeze");
  });

  test("writes to the URL and drops the param at the fallback", () => {
    const { result } = renderHook(() => useUrlParam("q"));
    act(() => result.current[1]("cedar"));
    expect(result.current[0]).toBe("cedar");
    expect(new URLSearchParams(window.location.search).get("q")).toBe("cedar");

    act(() => result.current[1](""));
    expect(new URLSearchParams(window.location.search).has("q")).toBe(false);
  });

  test("popstate restores the value the history entry carried", () => {
    window.history.replaceState(null, "", "/?q=sahara");
    const { result } = renderHook(() => useUrlParam("q"));
    window.history.replaceState(null, "", "/?q=kora");
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(result.current[0]).toBe("kora");
  });
});
