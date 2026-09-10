import { test } from "node:test";
import assert from "node:assert/strict";
import type { Invoice, Party } from "@workspace/api-client-react";
import {
  checkFixForm,
  focusAreasFor,
  invoiceFieldsDirty,
  invoicePatchFor,
  isContentEditable,
  linesFromDetail,
  partyDraftDirty,
  partyPatch,
  partyToDraft,
  type PartyDraft,
} from "./fix-invoice.ts";
import type { LineDraft } from "./invoice-form.ts";

// Characterisation of the fix-invoice save contract, written from the
// screen's inline code before the move: the party patch model, the
// editability rule, the pre-save check's report order and the PATCH shape.

const party = (overrides: Partial<Party> = {}): Party => ({
  id: "party-1",
  type: "buyer",
  legalName: "Ada Trading Ltd",
  tin: "12345678-0001",
  tinValidated: false,
  cacNumber: "RC123456",
  street: "1 Marina",
  city: "Lagos",
  countryCode: "NG",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  ...overrides,
});

const invoice = (overrides: Partial<Invoice> = {}): Invoice => ({
  id: "inv-1",
  firmId: "firm-1",
  supplierPartyId: "supplier-1",
  buyerPartyId: "party-1",
  kind: "invoice",
  category: "b2b",
  invoiceNumber: "INV-0001",
  currency: "NGN",
  issueDate: "2026-09-01",
  dueDate: "2026-09-30",
  status: "failed",
  subtotal: "100.00",
  vatTotal: "7.50",
  grandTotal: "107.50",
  notes: "Net 30",
  legalHold: false,
  contentRevision: 3,
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  ...overrides,
});

const line = (overrides: Partial<LineDraft> = {}): LineDraft => ({
  key: "l1",
  description: "Goods",
  quantity: "2",
  unitPrice: "50",
  vatRate: "7.5",
  ...overrides,
});

const fields = {
  invoiceNumber: "INV-0001",
  issueDate: "2026-09-01",
  dueDate: "2026-09-30",
  notes: "Net 30",
};

test("focusAreasFor maps the known rail codes to their sections and anything else to none", () => {
  assert.deepEqual(focusAreasFor("MBS_INVALID_TIN"), ["parties"]);
  assert.deepEqual(focusAreasFor("MBS_SCHEMA_INVALID"), ["invoice", "lines"]);
  assert.deepEqual(focusAreasFor("MBS_DUPLICATE"), ["invoiceNumber"]);
  assert.deepEqual(focusAreasFor("MBS_UNKNOWN"), []);
  assert.deepEqual(focusAreasFor(""), []);
});

test("partyToDraft reads every editable field with nulls as empty strings", () => {
  assert.deepEqual(partyToDraft(party()), {
    legalName: "Ada Trading Ltd",
    tin: "12345678-0001",
    cacNumber: "RC123456",
    street: "1 Marina",
    city: "Lagos",
  });
  assert.deepEqual(
    partyToDraft(
      party({ tin: null, cacNumber: null, street: null, city: null }),
    ),
    {
      legalName: "Ada Trading Ltd",
      tin: "",
      cacNumber: "",
      street: "",
      city: "",
    },
  );
});

test("partyPatch: unchanged fields are omitted, edits are trimmed, emptied optionals clear to null", () => {
  const original = party();
  assert.deepEqual(partyPatch(partyToDraft(original), original), {});
  // Whitespace-only differences are not edits.
  assert.deepEqual(
    partyPatch(
      { ...partyToDraft(original), tin: "  12345678-0001  ", city: " Lagos " },
      original,
    ),
    {},
  );
  assert.deepEqual(
    partyPatch(
      {
        legalName: " Ada Trading Limited ",
        tin: " 99999999-0001 ",
        cacNumber: "",
        street: "  ",
        city: "Abuja",
      },
      original,
    ),
    {
      legalName: "Ada Trading Limited",
      tin: "99999999-0001",
      cacNumber: null,
      street: null,
      city: "Abuja",
    },
  );
});

test("partyPatch: the legal name is only sent when non-empty and changed; a null original compares as empty", () => {
  const original = party({ tin: null, street: null });
  const draft: PartyDraft = { ...partyToDraft(original), legalName: "   " };
  assert.deepEqual(partyPatch(draft, original), {});
  assert.deepEqual(partyPatch({ ...draft, tin: "1" }, original), { tin: "1" });
  // Clearing a field that was already null is not a change.
  assert.deepEqual(partyPatch({ ...draft, street: "" }, original), {});
});

test("partyDraftDirty: an editable, loaded, changed draft — and nothing less", () => {
  const original = party();
  const clean = partyToDraft(original);
  const edited = { ...clean, city: "Abuja" };
  assert.equal(partyDraftDirty(false, edited, original), true);
  assert.equal(partyDraftDirty(false, clean, original), false);
  assert.equal(partyDraftDirty(true, edited, original), false);
  assert.equal(partyDraftDirty(false, null, original), false);
  assert.equal(partyDraftDirty(false, edited, undefined), false);
});

test("isContentEditable mirrors the server's content-frozen statuses", () => {
  assert.equal(isContentEditable(undefined), true);
  for (const status of ["draft", "validated", "failed"] as const) {
    assert.equal(isContentEditable(invoice({ status })), true, status);
  }
  for (const status of [
    "submitted",
    "stamped",
    "confirmed",
    "settled",
    "cancelled",
    "credited",
  ] as const) {
    assert.equal(isContentEditable(invoice({ status })), false, status);
  }
});

test("linesFromDetail keys drafts by the server line ID and turns the VAT fraction into a percent", () => {
  assert.deepEqual(
    linesFromDetail([
      {
        id: "line-a",
        invoiceId: "inv-1",
        lineNo: 1,
        description: "Goods",
        quantity: "2",
        unitPrice: "50.00",
        vatRate: "0.075",
        lineExtension: "100.00",
        vatAmount: "7.50",
      },
      {
        id: "line-b",
        invoiceId: "inv-1",
        lineNo: 2,
        description: "Exempt",
        quantity: "1",
        unitPrice: "10.00",
        vatRate: "0",
        lineExtension: "10.00",
        vatAmount: "0.00",
      },
    ]),
    [
      {
        key: "line-a",
        description: "Goods",
        quantity: "2",
        unitPrice: "50.00",
        vatRate: "7.5",
      },
      {
        key: "line-b",
        description: "Exempt",
        quantity: "1",
        unitPrice: "10.00",
        vatRate: "0",
      },
    ],
  );
});

test("invoiceFieldsDirty: trimmed comparison with null optionals as empty; nothing is dirty before the invoice loads", () => {
  assert.equal(invoiceFieldsDirty(undefined, fields), false);
  assert.equal(invoiceFieldsDirty(invoice(), fields), false);
  assert.equal(
    invoiceFieldsDirty(invoice(), { ...fields, notes: "  Net 30  " }),
    false,
  );
  assert.equal(
    invoiceFieldsDirty(invoice({ dueDate: null, notes: null }), {
      ...fields,
      dueDate: "",
      notes: "",
    }),
    false,
  );
  assert.equal(
    invoiceFieldsDirty(invoice(), { ...fields, invoiceNumber: "INV-0002" }),
    true,
  );
  assert.equal(
    invoiceFieldsDirty(invoice(), { ...fields, issueDate: "2026-09-02" }),
    true,
  );
  assert.equal(invoiceFieldsDirty(invoice(), { ...fields, dueDate: "" }), true);
  assert.equal(invoiceFieldsDirty(invoice(), { ...fields, notes: "" }), true);
});

test("checkFixForm: the required-field banners come first, in order, with no inline errors", () => {
  const base = { ...fields, lines: [line()], linesDirty: false };
  assert.deepEqual(checkFixForm({ ...base, invoiceNumber: "  " }), {
    ok: false,
    banner: "Enter an invoice number.",
    issueDateError: null,
    dueDateError: null,
    lineErrors: {},
    payloadLines: [],
  });
  // The invoice number is checked before the issue date, and the date's
  // format is not questioned while it is still blank.
  assert.equal(
    checkFixForm({ ...base, invoiceNumber: "", issueDate: "" }).banner,
    "Enter an invoice number.",
  );
  assert.deepEqual(checkFixForm({ ...base, issueDate: "" }), {
    ok: false,
    banner: "Enter an issue date.",
    issueDateError: null,
    dueDateError: null,
    lineErrors: {},
    payloadLines: [],
  });
});

test("checkFixForm: an edited form with no describable line is refused before the inline checks", () => {
  const blank = [line({ description: "  " })];
  assert.deepEqual(
    checkFixForm({
      ...fields,
      issueDate: "bad",
      lines: blank,
      linesDirty: true,
    }),
    {
      ok: false,
      banner: "Keep at least one line item with a description.",
      issueDateError: null,
      dueDateError: null,
      lineErrors: {},
      payloadLines: [],
    },
  );
  // Untouched lines are never the reason a save is refused.
  const pristine = checkFixForm({ ...fields, lines: blank, linesDirty: false });
  assert.equal(pristine.ok, true);
  assert.deepEqual(pristine.payloadLines, []);
});

test("checkFixForm: every inline error is reported at once under one banner", () => {
  const result = checkFixForm({
    ...fields,
    issueDate: "2026-02-30",
    dueDate: "30/09/2026",
    lines: [line({ quantity: "abc" })],
    linesDirty: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.banner, "Fix the highlighted fields before saving.");
  assert.equal(result.issueDateError, "Enter the issue date as YYYY-MM-DD.");
  assert.equal(result.dueDateError, "Enter the due date as YYYY-MM-DD.");
  assert.deepEqual(result.lineErrors, {
    l1: { quantity: "Enter a quantity greater than 0." },
  });
  // A single bad date reports only itself; a blank due date is fine.
  const dateOnly = checkFixForm({
    ...fields,
    dueDate: "",
    issueDate: "2026-13-01",
    lines: [line()],
    linesDirty: true,
  });
  assert.equal(dateOnly.issueDateError, "Enter the issue date as YYYY-MM-DD.");
  assert.equal(dateOnly.dueDateError, null);
  assert.deepEqual(dateOnly.lineErrors, {});
});

test("checkFixForm: pristine lines with unparsable numerics still save; the same lines edited do not", () => {
  const broken = [line({ quantity: "abc", unitPrice: "x" })];
  const pristine = checkFixForm({
    ...fields,
    lines: broken,
    linesDirty: false,
  });
  assert.deepEqual(pristine, {
    ok: true,
    banner: null,
    issueDateError: null,
    dueDateError: null,
    lineErrors: {},
    payloadLines: [
      { description: "Goods", quantity: "0", unitPrice: "0", vatRate: "0.075" },
    ],
  });
  const edited = checkFixForm({ ...fields, lines: broken, linesDirty: true });
  assert.equal(edited.ok, false);
  assert.deepEqual(Object.keys(edited.lineErrors), ["l1"]);
});

test("checkFixForm: a clean form is ok with the normalized payload lines", () => {
  const result = checkFixForm({
    ...fields,
    lines: [line({ quantity: "1,5", unitPrice: "100" })],
    linesDirty: true,
  });
  assert.deepEqual(result, {
    ok: true,
    banner: null,
    issueDateError: null,
    dueDateError: null,
    lineErrors: {},
    payloadLines: [
      {
        description: "Goods",
        quantity: "1.5",
        unitPrice: "100",
        vatRate: "0.075",
      },
    ],
  });
});

test("invoicePatchFor sends only what changed, trimmed, with emptied optionals as null", () => {
  const payloadLines = [
    { description: "Goods", quantity: "2", unitPrice: "50", vatRate: "0.075" },
  ];
  assert.deepEqual(invoicePatchFor(invoice(), fields, false, payloadLines), {});
  assert.deepEqual(
    invoicePatchFor(
      invoice(),
      {
        invoiceNumber: " INV-0002 ",
        issueDate: " 2026-09-02 ",
        dueDate: "  ",
        notes: "",
      },
      false,
      payloadLines,
    ),
    {
      invoiceNumber: "INV-0002",
      issueDate: "2026-09-02",
      dueDate: null,
      notes: null,
    },
  );
  assert.deepEqual(
    invoicePatchFor(
      invoice({ dueDate: null, notes: null }),
      { ...fields, dueDate: " 2026-10-01 ", notes: " Net 60 " },
      false,
      payloadLines,
    ),
    { dueDate: "2026-10-01", notes: "Net 60" },
  );
});

test("invoicePatchFor carries the lines only once they were edited", () => {
  const payloadLines = [
    { description: "Goods", quantity: "2", unitPrice: "50", vatRate: "0.075" },
  ];
  assert.deepEqual(invoicePatchFor(invoice(), fields, true, payloadLines), {
    lines: payloadLines,
  });
  assert.equal(
    "lines" in invoicePatchFor(invoice(), fields, false, payloadLines),
    false,
  );
});
