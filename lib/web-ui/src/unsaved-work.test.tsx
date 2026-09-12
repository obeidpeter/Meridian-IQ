// @vitest-environment jsdom
import { StrictMode, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  BusinessDetailsForm,
  type BusinessDetailsRecord,
} from "./business-details";
import {
  UnsavedWorkProvider,
  useProtectedHistoryState,
  useProtectedLocation,
  useProtectedSearch,
} from "./unsaved-work";

const party: BusinessDetailsRecord = {
  id: "business",
  legalName: "Acme Ltd",
  city: "Lagos",
  countryCode: "NG",
  updatedAt: "stamp-1",
};
beforeEach(() =>
  window.history.replaceState(null, "", "/business?tab=address"),
);
afterEach(cleanup);

function Shell({
  onSave,
  record = party,
  disabledReason,
}: {
  onSave: (patch: unknown) => Promise<BusinessDetailsRecord>;
  record?: BusinessDetailsRecord;
  disabledReason?: string;
}) {
  const [location, navigate] = useProtectedLocation();
  const search = useProtectedSearch();
  const state = useProtectedHistoryState();
  return (
    <>
      <nav>
        <button
          onClick={() =>
            navigate("/today?filter=open#summary", {
              state: { source: "sidebar" },
            })
          }
        >
          Today
        </button>
      </nav>
      <output aria-label="Location">{location + search}</output>
      <output aria-label="Route state">{JSON.stringify(state)}</output>
      {location === "/business" ? (
        <BusinessDetailsForm
          party={record}
          onSave={onSave}
          disabledReason={disabledReason}
        />
      ) : (
        <h1>Today workspace</h1>
      )}
    </>
  );
}

function page(
  onSave = vi.fn().mockResolvedValue({ ...party, city: "Abuja" }),
  disabledReason?: string,
  record = party,
) {
  return (
    <StrictMode>
      <UnsavedWorkProvider>
        <Shell
          onSave={onSave}
          disabledReason={disabledReason}
          record={record}
        />
      </UnsavedWorkProvider>
    </StrictMode>
  );
}
function edit(value = "Abuja", label = "City") {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
function leave() {
  fireEvent.click(screen.getByRole("button", { name: "Today" }));
}
async function openSavePrompt() {
  leave();
  expect(window.location.pathname).toBe("/business");
  await screen.findByRole("alertdialog");
}
function dialogButton(name: string) {
  return within(screen.getByRole("alertdialog")).getByRole("button", {
    name,
  });
}
function warned() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

test("pristine navigation needs no prompt and preserves query, hash and router state", () => {
  render(page());
  leave();
  expect(screen.getByRole("heading", { name: "Today workspace" })).toBeTruthy();
  expect(screen.getByLabelText("Location").textContent).toBe(
    "/today?filter=open",
  );
  expect(screen.getByLabelText("Route state").textContent).toBe(
    '{"source":"sidebar"}',
  );
  expect(window.location.hash).toBe("#summary");
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

test("Stay is focused by default, Escape keeps edits and restores trigger focus, Discard leaves without save", async () => {
  const onSave = vi.fn();
  render(page(onSave));
  edit();
  const trigger = screen.getByRole("button", { name: "Today" });
  trigger.focus();
  await openSavePrompt();
  expect(document.activeElement).toBe(dialogButton("Stay"));
  expect(
    screen.getByRole("alertdialog").getAttribute("aria-describedby"),
  ).toBeTruthy();
  expect(window.location.search).toBe("?tab=address");
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe(
    "Abuja",
  );
  expect(document.activeElement).toBe(trigger);
  await openSavePrompt();
  fireEvent.click(dialogButton("Discard"));
  expect(screen.getByRole("heading", { name: "Today workspace" })).toBeTruthy();
  expect(onSave).not.toHaveBeenCalled();
  expect(warned()).toBe(false);
});

test.each([
  new Error("Conflict: newer record."),
  new Error("Connection interrupted."),
])("save failure %s retains the modal, route and every edit", async (error) => {
  const onSave = vi
    .fn()
    .mockRejectedValueOnce(error)
    .mockResolvedValue({ ...party, city: "Abuja" });
  render(page(onSave));
  edit();
  edit("New business", "Legal business name");
  await openSavePrompt();
  fireEvent.click(dialogButton("Save"));
  await waitFor(() =>
    expect(
      within(screen.getByRole("alertdialog")).getByRole("alert"),
    ).toBeTruthy(),
  );
  expect(window.location.pathname).toBe("/business");
  expect(warned()).toBe(true);
  fireEvent.click(dialogButton("Stay"));
  expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe(
    "Abuja",
  );
  expect(
    (screen.getByLabelText("Legal business name") as HTMLInputElement).value,
  ).toBe("New business");
  expect(screen.getByText(error.message)).toBeTruthy();
  await openSavePrompt();
  fireEvent.click(dialogButton("Save"));
  await screen.findByRole("heading", { name: "Today workspace" });
  expect(onSave).toHaveBeenCalledTimes(2);
});

test("invalid save stays in the dialog and Stay focuses the invalid field for correction", async () => {
  const onSave = vi.fn();
  render(page(onSave));
  edit("", "Legal business name");
  await openSavePrompt();
  fireEvent.click(dialogButton("Save"));
  await waitFor(() =>
    expect(
      within(screen.getByRole("alertdialog")).getByRole("alert"),
    ).toBeTruthy(),
  );
  expect(onSave).not.toHaveBeenCalled();
  fireEvent.click(dialogButton("Stay"));
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByLabelText("Legal business name"),
    ),
  );
  expect(
    (screen.getByLabelText("Legal business name") as HTMLInputElement).value,
  ).toBe("");
});

test("normalization-only edits leave after Save without issuing an empty PATCH", async () => {
  const onSave = vi.fn();
  render(page(onSave));
  edit(" Acme Ltd ", "Legal business name");
  await openSavePrompt();
  fireEvent.click(dialogButton("Save"));
  await screen.findByRole("heading", { name: "Today workspace" });
  expect(onSave).not.toHaveBeenCalled();
});

test("manual save and dialog Save share one request; Stay cancels navigation without cancelling the save", async () => {
  let finish!: (record: BusinessDetailsRecord) => void;
  const onSave = vi.fn(
    () =>
      new Promise<BusinessDetailsRecord>((resolve) => {
        finish = resolve;
      }),
  );
  render(page(onSave));
  edit();
  fireEvent.submit(screen.getByRole("form"));
  await openSavePrompt();
  fireEvent.click(dialogButton("Save"));
  fireEvent.click(dialogButton("Save"));
  expect(dialogButton("Discard").hasAttribute("disabled")).toBe(true);
  expect(onSave).toHaveBeenCalledOnce();
  fireEvent.click(dialogButton("Stay"));
  await act(async () =>
    finish({ ...party, city: "Abuja", updatedAt: "stamp-2" }),
  );
  expect(screen.getByText("Business details saved.")).toBeTruthy();
  expect(window.location.pathname).toBe("/business");
  expect(warned()).toBe(false);
});

test("permission change cancels the pending navigation and refuses stale save success", async () => {
  let finish!: (record: BusinessDetailsRecord) => void;
  const onSave = vi.fn(
    () =>
      new Promise<BusinessDetailsRecord>((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(page(onSave));
  edit();
  await openSavePrompt();
  fireEvent.click(dialogButton("Save"));
  view.rerender(page(onSave, "Refresh account permissions."));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await act(async () => finish({ ...party, city: "Abuja" }));
  expect(window.location.pathname).toBe("/business");
  expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe(
    "Abuja",
  );
  expect(screen.getByText("Unsaved changes")).toBeTruthy();
  await openSavePrompt();
  fireEvent.click(dialogButton("Save"));
  await waitFor(() =>
    expect(
      within(screen.getByRole("alertdialog")).getByRole("alert").textContent,
    ).toBe("Refresh account permissions."),
  );
  expect(onSave).toHaveBeenCalledOnce();
});

test("party replacement and unmount clear pending handlers and unload warnings", async () => {
  const onSave = vi.fn();
  const view = render(page(onSave));
  edit();
  await openSavePrompt();
  view.rerender(
    page(onSave, undefined, { ...party, id: "another", city: "Kano" }),
  );
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe(
    "Kano",
  );
  expect(warned()).toBe(false);
  edit();
  view.unmount();
  expect(warned()).toBe(false);
});

test("owner removal while a save runs cannot navigate a replacement screen", async () => {
  let finish!: (record: BusinessDetailsRecord) => void;
  const onSave = vi.fn(
    () =>
      new Promise<BusinessDetailsRecord>((resolve) => {
        finish = resolve;
      }),
  );
  function Removable() {
    const [shown, setShown] = useState(true);
    return (
      <UnsavedWorkProvider>
        <button onClick={() => setShown(false)}>Remove owner</button>
        {shown ? <Shell onSave={onSave} /> : <h1>Access ended</h1>}
      </UnsavedWorkProvider>
    );
  }
  render(<Removable />);
  edit();
  await openSavePrompt();
  fireEvent.click(dialogButton("Save"));
  fireEvent.click(screen.getByText("Remove owner"));
  await act(async () => finish({ ...party, city: "Abuja" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(window.location.pathname).toBe("/business");
});
