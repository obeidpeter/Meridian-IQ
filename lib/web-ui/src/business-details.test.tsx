// @vitest-environment jsdom
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
  BusinessDetailsForm,
  type BusinessDetailsRecord,
} from "./business-details";

afterEach(cleanup);
const party: BusinessDetailsRecord = {
  id: "client-a",
  legalName: "Acme Ltd",
  tin: "12345678-0001",
  cacNumber: "RC12345",
  street: "1 Market Road",
  city: "Lagos",
  countryCode: "NG",
};
function change(label: string, value: string) {
  fireEvent.change(screen.getByRole("textbox", { name: label }), {
    target: { value },
  });
}
function submit() {
  fireEvent.submit(screen.getByRole("form", { name: "Business details" }));
}

test("only permitted editable fields are rendered, without verification claims", () => {
  render(
    <BusinessDetailsForm
      party={{ ...party, tinValidated: true } as BusinessDetailsRecord}
      onSave={vi.fn()}
    />,
  );
  expect(screen.getAllByRole("textbox")).toHaveLength(6);
  expect(
    screen
      .getByRole("button", { name: "Save business details" })
      .getAttribute("aria-disabled"),
  ).toBe("true");
  expect(screen.queryByText(/verified|atomic|stamped/i)).toBeNull();
  expect(
    screen.queryByRole("textbox", {
      name: /^(id|type|version|tinValidated|firmId)$/i,
    }),
  ).toBeNull();
});

test("only changed fields are saved and the canonical response becomes the clean baseline", async () => {
  const onSave = vi
    .fn()
    .mockResolvedValue({ ...party, legalName: "New Name", city: "Ibadan" });
  render(<BusinessDetailsForm party={party} onSave={onSave} />);
  change("Legal business name", " New Name ");
  submit();
  await waitFor(() =>
    expect(screen.getByText("Business details saved.")).toBeTruthy(),
  );
  expect(onSave).toHaveBeenCalledExactlyOnceWith({ legalName: "New Name" });
  expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe(
    "Ibadan",
  );
  expect(
    screen
      .getByRole("button", { name: "Save business details" })
      .getAttribute("aria-disabled"),
  ).toBe("true");
  submit();
  expect(onSave).toHaveBeenCalledTimes(1);
});

test("dirty input survives refetch and does not echo remotely changed fields in PATCH", async () => {
  const onSave = vi
    .fn()
    .mockResolvedValue({ ...party, street: "2 New Street", city: "Kano" });
  const { rerender } = render(
    <BusinessDetailsForm party={party} onSave={onSave} />,
  );
  change("Street address", "2 New Street");
  rerender(
    <BusinessDetailsForm party={{ ...party, city: "Kano" }} onSave={onSave} />,
  );
  expect(
    (screen.getByLabelText("Street address") as HTMLInputElement).value,
  ).toBe("2 New Street");
  expect(screen.getByText(/Newer saved details are available/)).toBeTruthy();
  fireEvent.click(screen.getByText("Review newer saved details"));
  expect(screen.getByText("Latest saved: Kano")).toBeTruthy();
  expect(screen.getByText("Your value: Lagos")).toBeTruthy();
  submit();
  await waitFor(() =>
    expect(onSave).toHaveBeenCalledExactlyOnceWith({ street: "2 New Street" }),
  );
});

test("pristine refetch is adopted and discard explicitly uses the latest saved details", () => {
  const onSave = vi.fn();
  const { rerender } = render(
    <BusinessDetailsForm party={party} onSave={onSave} />,
  );
  rerender(
    <BusinessDetailsForm party={{ ...party, city: "Kano" }} onSave={onSave} />,
  );
  expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe(
    "Kano",
  );
  change("City", "Abuja");
  rerender(
    <BusinessDetailsForm
      party={{ ...party, city: "Ilorin" }}
      onSave={onSave}
    />,
  );
  expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe(
    "Abuja",
  );
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe(
    "Ilorin",
  );
  expect(onSave).not.toHaveBeenCalled();
});

test("save errors retain every unsaved field and allow a deliberate retry", async () => {
  const onSave = vi
    .fn()
    .mockRejectedValueOnce(new Error("Connection interrupted."))
    .mockResolvedValue({ ...party, city: "Abuja" });
  render(<BusinessDetailsForm party={party} onSave={onSave} />);
  change("City", "Abuja");
  submit();
  await screen.findByText("Connection interrupted.");
  expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe(
    "Abuja",
  );
  expect(screen.getByText("Unsaved changes")).toBeTruthy();
  submit();
  await screen.findByText("Business details saved.");
  expect(onSave).toHaveBeenCalledTimes(2);
});

test("same-tick submissions and edits cannot overlap an in-flight save", async () => {
  let finish!: (value: BusinessDetailsRecord) => void;
  const onSave = vi.fn(
    () =>
      new Promise<BusinessDetailsRecord>((resolve) => {
        finish = resolve;
      }),
  );
  render(<BusinessDetailsForm party={party} onSave={onSave} />);
  change("City", "Abuja");
  submit();
  submit();
  change("City", "Kano");
  expect(onSave).toHaveBeenCalledOnce();
  expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe(
    "Abuja",
  );
  const savingButton = screen.getByRole("button", {
    name: "Saving business details...",
  });
  expect(savingButton.getAttribute("aria-disabled")).toBe("true");
  expect(savingButton.getAttribute("aria-busy")).toBe("true");
  expect(savingButton.hasAttribute("disabled")).toBe(false);
  await act(async () => finish({ ...party, city: "Abuja" }));
  expect(screen.getByText("Business details saved.")).toBeTruthy();
});

test.each([
  ["Legal business name", " ", "Enter the legal business name."],
  [
    "Tax identification number (TIN)",
    "not-a-tin",
    "Enter 8 to 10 digits, optionally followed by a hyphen and 4 digits.",
  ],
  ["CAC number", "INVALID", "Enter RC or BN followed by 2 to 8 digits."],
  ["Country code", "Nigeria", "Enter a two-letter country code, such as NG."],
])(
  "%s validation is associated, focused and prevents save",
  (label, value, message) => {
    const onSave = vi.fn();
    render(<BusinessDetailsForm party={party} onSave={onSave} />);
    change(label, value);
    submit();
    const input = screen.getByRole("textbox", { name: label });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById(input.getAttribute("aria-describedby")!)
        ?.textContent,
    ).toBe(message);
    expect(document.activeElement).toBe(input);
    expect(onSave).not.toHaveBeenCalled();
    change(
      label,
      label === "Country code"
        ? "GH"
        : label === "Legal business name"
          ? "Valid"
          : label === "CAC number"
            ? "BN2345"
            : "1234567890",
    );
    expect(
      screen.queryByText("Correct the highlighted business details."),
    ).toBeNull();
  },
);

test("optional blank values use null and valid identifiers normalize without verification claims", async () => {
  const onSave = vi.fn().mockResolvedValue({
    ...party,
    tin: "1234567890",
    cacNumber: null,
    city: null,
  });
  render(<BusinessDetailsForm party={party} onSave={onSave} />);
  change("Tax identification number (TIN)", "12345 67890");
  change("CAC number", "");
  change("City", "");
  submit();
  await waitFor(() =>
    expect(onSave).toHaveBeenCalledExactlyOnceWith({
      tin: "1234567890",
      cacNumber: null,
      city: null,
    }),
  );
});

test("an unchanged legacy invalid identifier does not block an unrelated correction", async () => {
  const onSave = vi
    .fn()
    .mockResolvedValue({ ...party, tin: "legacy", city: "Abuja" });
  render(
    <BusinessDetailsForm party={{ ...party, tin: "legacy" }} onSave={onSave} />,
  );
  change("City", "Abuja");
  submit();
  await waitFor(() =>
    expect(onSave).toHaveBeenCalledExactlyOnceWith({ city: "Abuja" }),
  );
});

test("switching parties cannot carry dirty values into another business", () => {
  const onSave = vi.fn();
  const { rerender } = render(
    <BusinessDetailsForm party={party} onSave={onSave} />,
  );
  change("City", "Abuja");
  rerender(
    <BusinessDetailsForm
      party={{ ...party, id: "client-b", city: "Kano" }}
      onSave={onSave}
    />,
  );
  expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe(
    "Kano",
  );
  submit();
  expect(onSave).not.toHaveBeenCalled();
});

test("permission refresh failure disables saving without losing edits", () => {
  const onSave = vi.fn();
  const { rerender } = render(
    <BusinessDetailsForm party={party} onSave={onSave} />,
  );
  change("City", "Abuja");
  rerender(
    <BusinessDetailsForm
      party={party}
      onSave={onSave}
      disabledReason="Retry account permissions."
    />,
  );
  submit();
  expect(onSave).not.toHaveBeenCalled();
  expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe(
    "Abuja",
  );
  expect(screen.getByRole("alert").textContent).toBe(
    "Retry account permissions.",
  );
});

test("correcting every invalid field removes the summary alert before resubmitting", () => {
  render(<BusinessDetailsForm party={party} onSave={vi.fn()} />);
  change("Legal business name", "");
  change("Tax identification number (TIN)", "invalid");
  change("CAC number", "invalid");
  change("Country code", "invalid");
  submit();
  expect(screen.getByRole("alert").textContent).toBe(
    "Correct the highlighted business details.",
  );
  change("Legal business name", "New name");
  change("Tax identification number (TIN)", "1234567890");
  change("CAC number", "BN12345");
  change("Country code", "NG");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    screen
      .getAllByRole("textbox")
      .some((input) => input.getAttribute("aria-invalid") === "true"),
  ).toBe(false);
});

test("discard after save uses the successful response while the caller prop is still stale", async () => {
  const onSave = vi.fn().mockResolvedValue({ ...party, city: "Abuja" });
  render(<BusinessDetailsForm party={party} onSave={onSave} />);
  change("City", "Abuja");
  submit();
  await screen.findByText("Business details saved.");
  change("City", "Kano");
  expect(screen.queryByText(/Newer saved details are available/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe(
    "Abuja",
  );
});

test("the save carries the stamp of the record the user edited, then adopts the saved one (R113)", async () => {
  const stamped = { ...party, updatedAt: "2026-09-09T08:00:00.000Z" };
  const onSave = vi.fn().mockResolvedValue({
    ...stamped,
    city: "Abuja",
    updatedAt: "2026-09-09T09:00:00.000Z",
  });
  const view = render(<BusinessDetailsForm party={stamped} onSave={onSave} />);
  change("City", "Abuja");
  // A newer record arrives while the user is typing: the baseline (and its
  // stamp) must stay with what they edited, so the server can refuse it.
  view.rerender(
    <BusinessDetailsForm
      party={{
        ...stamped,
        street: "9 Other Road",
        updatedAt: "2026-09-09T08:30:00.000Z",
      }}
      onSave={onSave}
    />,
  );
  submit();
  await waitFor(() =>
    expect(onSave).toHaveBeenCalledExactlyOnceWith({
      city: "Abuja",
      expectedUpdatedAt: "2026-09-09T08:00:00.000Z",
    }),
  );
  await screen.findByText("Business details saved.");
  change("City", "Ibadan");
  submit();
  await waitFor(() =>
    expect(onSave).toHaveBeenLastCalledWith({
      city: "Ibadan",
      expectedUpdatedAt: "2026-09-09T09:00:00.000Z",
    }),
  );
});

test("save and discard keep keyboard focus through their own state changes (R115)", async () => {
  let finish!: (record: BusinessDetailsRecord) => void;
  const onSave = vi.fn(
    () =>
      new Promise<BusinessDetailsRecord>((resolve) => {
        finish = resolve;
      }),
  );
  render(<BusinessDetailsForm party={party} onSave={onSave} />);
  change("City", "Abuja");
  const save = screen.getByRole("button", { name: "Save business details" });
  save.focus();
  submit();
  // Saving: the control under the keyboard is busy, not removed from the
  // tab order, so focus stays where the user put it.
  expect(document.activeElement).toBe(save);
  expect(save.getAttribute("aria-busy")).toBe("true");
  await act(async () => finish({ ...party, city: "Abuja" }));
  expect(screen.getByText("Business details saved.")).toBeTruthy();
  // Saved: nothing left to save, and focus is still on the button rather
  // than dropped to the body by a disabled attribute.
  expect(document.activeElement).toBe(save);
  expect(save.getAttribute("aria-disabled")).toBe("true");
  expect(save.hasAttribute("disabled")).toBe(false);
  submit();
  expect(onSave).toHaveBeenCalledOnce();

  change("City", "Kano");
  const discard = screen.getByRole("button", { name: "Discard changes" });
  discard.focus();
  fireEvent.click(discard);
  expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe(
    "Abuja",
  );
  expect(document.activeElement).toBe(discard);
  expect(discard.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(discard);
  expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe(
    "Abuja",
  );
});
