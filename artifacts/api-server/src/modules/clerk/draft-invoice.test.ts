import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import {
  getDb,
  firmsTable,
  partiesTable,
  clerkCasesTable,
  clerkInferenceCallsTable,
  invoicesTable,
} from "@workspace/db";
import type { Principal } from "../auth/rbac.ts";
import {
  draftInvoiceWithClerk,
  normalizeInvoiceDraft,
  normalizeVatRate,
} from "./draft-invoice.ts";
import type { CompletionRequest } from "./gateway.ts";
import {
  fakeGateway,
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "./test-support.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Natural-language invoice drafting (idea #7). Pinned invariants:
//  - the model's output is re-validated and normalised by the app (dates,
//  numbers, VAT fractions) before it reaches any form;
//  - buyer identity is a deterministic register suggestion, never the model's;
//  - NOTHING is persisted — no clerk case, no invoice; the ledger records the
//  call and that is all;
//  - the instruction is fenced as untrusted data;
//  - invalid output fails closed with a typed 502.

const SALT = makeRunSalt();
const buyerPartyId = randomUUID();
const supplierPartyId = randomUUID();
const firmAId = randomUUID();
const firmBId = randomUUID();

const BUYER_NAME = `Adaeze Foods ${SALT}`;

// Firm A has the buyer on one of its invoices (in sphere); firm B has no
// relationship to it at all.
const firmAPrincipal: Principal = {
  userId: randomUUID(),
  role: "firm_admin",
  firmId: firmAId,
  clientPartyId: null,
  buyerPartyId: null,
};
const firmBPrincipal: Principal = {
  ...firmAPrincipal,
  userId: randomUUID(),
  firmId: firmBId,
};

const validOutput = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    buyerName: "Adaeze Foods",
    buyerTin: null,
    invoiceNumber: null,
    issueDate: null,
    dueDate: null,
    currency: "ngn",
    lines: [
      {
        description: "June deliveries",
        quantity: null,
        unitPrice: "150000",
        vatRate: "7.5%",
      },
    ],
    ...over,
  });

before(async () => {
  await saveAndEnableClerkFlag();
  const db = getDb();
  await db.insert(firmsTable).values([
    { id: firmAId, name: `Draft Firm A ${SALT}` },
    { id: firmBId, name: `Draft Firm B ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    { id: buyerPartyId, type: "buyer", legalName: BUYER_NAME },
    {
      id: supplierPartyId,
      type: "client_business",
      legalName: `Draft Supplier ${SALT}`,
    },
  ]);
  // The buyer enters firm A's sphere by appearing on one of its invoices.
  await db.insert(invoicesTable).values({
    firmId: firmAId,
    supplierPartyId,
    buyerPartyId,
    invoiceNumber: `DFT-${SALT}`,
    issueDate: "2026-07-01",
  });
});

after(async () => {
  await restoreClerkFlag();
});

test("normalizeVatRate converts every stated form to the platform fraction", () => {
  assert.equal(normalizeVatRate("7.5%"), "0.075");
  assert.equal(normalizeVatRate("7.5"), "0.075");
  assert.equal(normalizeVatRate("0.075"), "0.075");
  assert.equal(normalizeVatRate("0"), "0");
  // A "%" always means percent, whatever the magnitude.
  assert.equal(normalizeVatRate("1%"), "0.01");
  assert.equal(normalizeVatRate("0.5%"), "0.005");
  // 100% (in any spelling) is not a VAT rate — dropped, never passed through.
  assert.equal(normalizeVatRate("1"), null);
  assert.equal(normalizeVatRate("100%"), null);
  assert.equal(normalizeVatRate("garbage"), null);
  assert.equal(normalizeVatRate("150"), null, "an impossible rate is dropped");
  assert.equal(normalizeVatRate(null), null);
});

test("normalizeInvoiceDraft re-validates every extracted value", () => {
  const proposal = normalizeInvoiceDraft({
    buyerName: "  Adaeze Foods  ",
    buyerTin: null,
    invoiceNumber: "",
    issueDate: "2026-02-31", // shape-valid, impossible
    dueDate: "June", // vague — the model was told null, but verify anyway
    currency: "naira",
    lines: [
      {
        description: "Deliveries",
        quantity: "0",
        unitPrice: "₦150,000",
        vatRate: "7.5%",
      },
      { description: null, quantity: null, unitPrice: null, vatRate: null },
    ],
  });
  assert.equal(proposal.buyerName, "Adaeze Foods");
  assert.equal(proposal.invoiceNumber, null);
  assert.equal(proposal.issueDate, null, "impossible dates are dropped");
  assert.equal(proposal.dueDate, null);
  assert.equal(proposal.currency, null, "only ISO codes survive");
  assert.equal(proposal.lines.length, 1, "an empty line proposes nothing");
  assert.equal(proposal.lines[0].quantity, "1", "quantity must be positive");
  assert.equal(proposal.lines[0].unitPrice, "150000");
  assert.equal(proposal.lines[0].vatRate, "0.075");

  const capped = normalizeInvoiceDraft({
    buyerName: null,
    buyerTin: null,
    invoiceNumber: null,
    issueDate: null,
    dueDate: null,
    currency: null,
    lines: Array.from({ length: 12 }, (_, i) => ({
      description: `Item ${i}`,
      quantity: "1",
      unitPrice: "10",
      vatRate: null,
    })),
  });
  assert.equal(capped.lines.length, 10, "line count is capped");
});

test("a sentence becomes a normalised proposal with a register buyer suggestion", async () => {
  const casesBefore = await getDb().select().from(clerkCasesTable);
  const invoicesBefore = await getDb().select().from(invoicesTable);

  const calls: CompletionRequest[] = [];
  const text = `Invoice ${BUYER_NAME} ₦150,000 for June deliveries, 7.5% VAT`;
  const result = await draftInvoiceWithClerk(
    text,
    firmAPrincipal,
    fakeGateway((req) => {
      calls.push(req);
      return validOutput({ buyerName: BUYER_NAME });
    }),
  );

  assert.equal(result.proposal.lines[0].unitPrice, "150000");
  assert.equal(result.proposal.lines[0].vatRate, "0.075");
  assert.equal(result.proposal.currency, "NGN");
  assert.ok(
    result.buyerSuggestions.some((s) => s.partyId === buyerPartyId),
    "a buyer in the firm's sphere is suggested deterministically",
  );
  assert.equal(result.promptVersion, "draft-invoice.v1");

  // The instruction is untrusted and travels only inside the fence.
  assert.equal(calls.length, 1);
  assert.ok((calls[0].user as string).includes("-----BEGIN INSTRUCTION-----"));
  assert.ok((calls[0].user as string).includes(text));

  // Drafting stores NOTHING: no clerk case, no invoice.
  const casesAfter = await getDb().select().from(clerkCasesTable);
  const invoicesAfter = await getDb().select().from(invoicesTable);
  assert.equal(casesAfter.length, casesBefore.length);
  assert.equal(invoicesAfter.length, invoicesBefore.length);
});

test("a foreign firm never sees another firm's buyer in the suggestions", async () => {
  // Firm B has no engagement, no invoice, no provenance tie to the buyer —
  // naming it in the instruction must NOT enumerate it (the parties table is
  // the shared spine with no RLS; the sphere filter is the only wall).
  const result = await draftInvoiceWithClerk(
    `Invoice ${BUYER_NAME} ₦99 for nothing`,
    firmBPrincipal,
    fakeGateway(() => validOutput({ buyerName: BUYER_NAME })),
  );
  assert.equal(
    result.buyerSuggestions.length,
    0,
    "an out-of-sphere buyer must never be suggested",
  );
});

test("the call is ledgered with the firm it was made for", async () => {
  await draftInvoiceWithClerk(
    "Invoice someone 500 naira",
    firmAPrincipal,
    fakeGateway(() => validOutput({ buyerName: null })),
  );
  const [row] = await getDb()
    .select({
      purpose: clerkInferenceCallsTable.purpose,
      firmId: clerkInferenceCallsTable.firmId,
    })
    .from(clerkInferenceCallsTable)
    .where(eq(clerkInferenceCallsTable.firmId, firmAId))
    .orderBy(desc(clerkInferenceCallsTable.createdAt))
    .limit(1);
  assert.equal(row?.purpose, "draft_invoice");
});

test("invalid model output fails closed with a typed 502", async () => {
  await assert.rejects(
    draftInvoiceWithClerk(
      "Invoice X 100",
      firmAPrincipal,
      fakeGateway(() => "nope"),
    ),
    (err: Error & { code?: string; status?: number }) =>
      err.code === "CLERK_DRAFT_FAILED" && err.status === 502,
  );
  await assert.rejects(
    draftInvoiceWithClerk(
      "Invoice X 100",
      firmAPrincipal,
      fakeGateway(() => JSON.stringify({ wrong: "shape" })),
    ),
    (err: Error & { code?: string }) => err.code === "CLERK_DRAFT_FAILED",
  );
});
