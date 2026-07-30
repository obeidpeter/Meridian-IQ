import { test } from "node:test";
import assert from "node:assert/strict";
import {
  closeHeaderPill,
  closeItemRoute,
  closeItemTitle,
} from "./month-end.ts";

// The route map is the load-bearing piece: a checklist row may only link to
// a screen this app actually has — a link to nowhere is worse than no link.

test("invoice-shaped items route to the invoice list", () => {
  assert.equal(closeItemRoute("overdue_submissions"), "/invoices");
  assert.equal(closeItemRoute("pending_approvals"), "/invoices");
});

test("vendor-bill items route to the supplier-bills ledger", () => {
  assert.equal(closeItemRoute("missing_bills"), "/bills");
  assert.equal(closeItemRoute("double_payments"), "/bills");
});

test("bank-credit items route to reconciliation; unbilled income to New Invoice", () => {
  assert.equal(closeItemRoute("unmatched_credits"), "/reconciliation");
  assert.equal(closeItemRoute("unbilled_income"), "/invoice");
});

test("open tax-authority obligations route to the Obligations screen", () => {
  assert.equal(closeItemRoute("open_obligations"), "/obligations");
});

test("items without a mobile surface render without a link", () => {
  assert.equal(closeItemRoute("unmatched_collections"), null);
  // A key from a newer server degrades to a plain row, never a dead link.
  assert.equal(closeItemRoute("brand_new_check"), null);
});

test("closeHeaderPill: amber count while anything needs review, else all clear", () => {
  assert.deepEqual(closeHeaderPill(3), { label: "3 to review", tone: "warning" });
  assert.deepEqual(closeHeaderPill(1), { label: "1 to review", tone: "warning" });
  assert.deepEqual(closeHeaderPill(0), { label: "All clear", tone: "success" });
});

test("closeItemTitle appends the count only when non-zero", () => {
  assert.equal(
    closeItemTitle({ label: "Possible double payments", count: 2 }),
    "Possible double payments (2)",
  );
  assert.equal(
    closeItemTitle({ label: "Possible double payments", count: 0 }),
    "Possible double payments",
  );
});
