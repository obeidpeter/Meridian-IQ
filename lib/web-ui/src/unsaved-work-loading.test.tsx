// @vitest-environment jsdom
import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  UnsavedWorkProvider,
  useProtectedLocation,
  useUnsavedWork,
} from "./unsaved-work";

const load = vi.hoisted(() => {
  let reject!: (error: Error) => void;
  const promise = new Promise<never>((_, fail) => {
    reject = fail;
  });
  return { promise, reject, started: vi.fn() };
});
vi.mock("./unsaved-work-dialog", () => {
  load.started();
  return load.promise;
});
afterEach(cleanup);

test("a delayed or failed prompt chunk never navigates or discards dirty input", async () => {
  window.history.replaceState(null, "", "/business");
  const save = vi.fn().mockResolvedValue(true);
  const discard = vi.fn().mockReturnValue(true);
  function Form() {
    const [value, setValue] = useState("");
    const [location, navigate] = useProtectedLocation();
    useUnsavedWork({ dirty: Boolean(value), save, discard });
    return (
      <>
        <input
          aria-label="Draft"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <button onClick={() => navigate("/today")}>Today</button>
        <output aria-label="Location">{location}</output>
      </>
    );
  }
  render(
    <UnsavedWorkProvider>
      <Form />
    </UnsavedWorkProvider>,
  );
  expect(load.started).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Draft"), {
    target: { value: "Keep this draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Today" }));
  await waitFor(() => expect(load.started).toHaveBeenCalledOnce());
  expect(screen.getByText("Opening save prompt...").getAttribute("role")).toBe(
    "status",
  );
  expect(window.location.pathname).toBe("/business");
  await act(async () => load.reject(new Error("Synthetic chunk failure")));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Your changes are still here",
  );
  expect(screen.getByLabelText("Location").textContent).toBe("/business");
  expect((screen.getByLabelText("Draft") as HTMLInputElement).value).toBe(
    "Keep this draft",
  );
  expect(save).not.toHaveBeenCalled();
  expect(discard).not.toHaveBeenCalled();
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
});
