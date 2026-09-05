// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Invoice, InvoiceLine } from "@workspace/api-client-react";
import { InvoiceConflict } from "./invoice-conflict";

afterEach(cleanup);
test("conflict comparison retains both versions and requires an explicit recovery choice", () => {
  const onReload = vi.fn();
  const onKeep = vi.fn();
  const draft = {
    invoiceNumber: "MY-UNSAVED",
    issueDate: "2026-09-05",
    dueDate: "",
    lines: [
      {
        description: "<script>typed text</script>",
        quantity: "0.5",
        unitPrice: "2.01",
        vatRate: "0.075",
      },
    ],
  };
  render(
    <InvoiceConflict
      draft={draft}
      saved={
        {
          invoiceNumber: "SAVED-2",
          issueDate: "2026-09-04",
          dueDate: null,
          contentRevision: 2,
        } as Invoice
      }
      lines={[
        {
          description: "Saved line",
          quantity: "1",
          unitPrice: "10.00",
          vatRate: "0",
        } as InvoiceLine,
      ]}
      onReload={onReload}
      onKeep={onKeep}
    />,
  );
  expect(screen.getByRole("alert").textContent).toContain(
    "Your edits are preserved",
  );
  const table = screen.getByRole("table", {
    name: "Saved invoice compared with your edits",
  });
  expect(within(table).getByText("MY-UNSAVED")).toBeTruthy();
  expect(within(table).getByText("SAVED-2")).toBeTruthy();
  expect(table.querySelector("script")).toBeNull();
  expect(onReload).not.toHaveBeenCalled();
  expect(onKeep).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Keep my edits" }));
  expect(onKeep).toHaveBeenCalledOnce();
  expect(draft.invoiceNumber).toBe("MY-UNSAVED");
  fireEvent.click(screen.getByRole("button", { name: "Reload saved version" }));
  expect(onReload).toHaveBeenCalledOnce();
});
