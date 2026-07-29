import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  engagementsTable,
  firmsTable,
  invoicesTable,
  partiesTable,
} from "@workspace/db";
import { DATA_INTENTS, extractInvoiceNumbers } from "./data-intents/index.ts";
import { daysAgo, makeRunSalt } from "../../test-helpers/fixtures.ts";

// Invoice-pinned Ask intent (round-20 idea #5). Pinned invariants:
//  - the extractor is DETERMINISTIC and conservative: separator+digit
//    tokens and introduced bare numbers, dates excluded, ambiguity
//    surfaced (ask.ts refuses on 0 or >1);
//  - the lookup is exact-number, case-insensitive, firm-scoped; a client
//    pin matches EITHER side of the paper and a foreign number answers
//    "no invoice" — non-disclosure;
//  - duplicate numbers across clients ask for the client name instead of
//    guessing.

const SALT = makeRunSalt();
const firmId = randomUUID();
const clientParty = randomUUID();
const siblingParty = randomUUID();
const buyer = randomUUID();
const vendor = randomUUID(); // unengaged — supplies the client's bill
// Unique invoice number per run — the shared DB may hold INV-lookalikes.
const NUM = `IS-${SALT}-77`;
let invoiceId: string;

const intent = DATA_INTENTS.find((i) => i.key === "data.invoice_status");

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmId, name: `IS Firm ${SALT}` });
  await db.insert(partiesTable).values([
    { id: clientParty, type: "client_business", legalName: `IS Client ${SALT}` },
    { id: siblingParty, type: "client_business", legalName: `IS Sibling ${SALT}` },
    { id: buyer, type: "buyer", legalName: `IS Buyer ${SALT}` },
    { id: vendor, type: "buyer", legalName: `IS Vendor ${SALT}` },
  ]);
  await db.insert(engagementsTable).values([
    { firmId, clientPartyId: clientParty, type: "retainer", title: `is A ${SALT}` },
    { firmId, clientPartyId: siblingParty, type: "retainer", title: `is B ${SALT}` },
  ]);
  invoiceId = randomUUID();
  await db.insert(invoicesTable).values([
    {
      id: invoiceId,
      firmId,
      supplierPartyId: clientParty,
      buyerPartyId: buyer,
      invoiceNumber: NUM,
      issueDate: daysAgo(20),
      status: "draft",
      grandTotal: "90000.00",
      subtotal: "83720.93",
      vatTotal: "6279.07",
    },
    // The sibling's invoice with a DIFFERENT number — the scope probe.
    {
      firmId,
      supplierPartyId: siblingParty,
      buyerPartyId: buyer,
      invoiceNumber: `IS-${SALT}-88`,
      issueDate: daysAgo(5),
      status: "draft",
      grandTotal: "40000.00",
      subtotal: "37209.30",
      vatTotal: "2790.70",
    },
    // The H1 shape: the SIBLING's receivable where OUR client is the
    // buyer (dual-engaged trade — the supplier side wins orientation).
    // The pinned lookup must answer "no invoice", never the sibling's
    // rail posture.
    {
      firmId,
      supplierPartyId: siblingParty,
      buyerPartyId: clientParty,
      invoiceNumber: `IS-${SALT}-99`,
      issueDate: daysAgo(15),
      status: "failed",
      grandTotal: "60000.00",
      subtotal: "55813.95",
      vatTotal: "4186.05",
    },
    // A genuine BILL of the client (unengaged vendor supplies): the
    // pinned buyer-side lookup that SHOULD answer.
    {
      firmId,
      supplierPartyId: vendor,
      buyerPartyId: clientParty,
      invoiceNumber: `IS-${SALT}-55`,
      issueDate: daysAgo(8),
      status: "draft",
      grandTotal: "25000.00",
      subtotal: "23255.81",
      vatTotal: "1744.19",
    },
  ]);
});

test("extractInvoiceNumbers is conservative and date-safe", () => {
  assert.deepEqual(
    extractInvoiceNumbers("What is happening with INV-2041?"),
    ["INV-2041"],
  );
  assert.deepEqual(extractInvoiceNumbers("Where is invoice 7801 now?"), [
    "7801",
  ]);
  // A date is not an invoice number; the real token still comes through.
  assert.deepEqual(
    extractInvoiceNumbers("Was INV-2041 submitted before 2026-07-01?"),
    ["INV-2041"],
  );
  // No number at all.
  assert.deepEqual(extractInvoiceNumbers("Why are my invoices failing?"), []);
  // Two distinct candidates surface both — ask.ts refuses ambiguity.
  assert.equal(
    extractInvoiceNumbers("Compare INV-1 and INV-2 for me").length,
    2,
  );
  // Case-insensitive dedup keeps one.
  assert.deepEqual(
    extractInvoiceNumbers("is inv-2041 the same as INV-2041?"),
    ["inv-2041"],
  );
  // The review-probed false positives (round-20 M3):
  // slash dates and month/fiscal shapes are dates, not numbers…
  assert.deepEqual(extractInvoiceNumbers("submitted on 2026/07/08?"), []);
  assert.deepEqual(extractInvoiceNumbers("the 05/2026 return"), []);
  assert.deepEqual(extractInvoiceNumbers("the 2025/26 fiscal year"), []);
  // …an introduced rail error code or TIN is that thing…
  assert.deepEqual(
    extractInvoiceNumbers("it failed with code E-TIN-01, why?"),
    [],
  );
  assert.deepEqual(
    extractInvoiceNumbers("their TIN 12345678-0001 was rejected"),
    [],
  );
  // …but the real number still comes through beside an excluded token.
  assert.deepEqual(
    extractInvoiceNumbers("it failed with code E-TIN-01 — what about INV-2041?"),
    ["INV-2041"],
  );
  // Ordinary words containing "no" and the bare word "no" introduce nothing.
  assert.deepEqual(extractInvoiceNumbers("casino 12345 is not ours"), []);
  assert.deepEqual(
    extractInvoiceNumbers("there are no 20000 naira invoices"),
    [],
  );
  // A separator-free compound is ONE candidate — never its bare digit tail.
  assert.deepEqual(extractInvoiceNumbers("where is invoice INV2041?"), [
    "INV2041",
  ]);
  // The verification-pass residuals (N1-N3):
  // an introduced number that is NOT the exact digit tail of another
  // candidate is a distinct invoice — both surface, ask.ts refuses
  // honestly instead of silently answering about the wrong one…
  assert.equal(
    extractInvoiceNumbers("what about invoice 123? It's blocking INV-1234")
      .length,
    2,
  );
  // …a word merely ENDING in an excluding term never eats a number…
  assert.deepEqual(
    extractInvoiceNumbers("the invoice from Eko Hotel INV-2041"),
    ["INV-2041"],
  );
  // …and period compounds are periods, not numbers.
  assert.deepEqual(extractInvoiceNumbers("the FY2025 accounts"), []);
  assert.deepEqual(extractInvoiceNumbers("billed in July2026"), []);
});

test("the lookup answers status, next step and a link", async () => {
  assert.ok(intent, "the intent is registered");
  const result = await intent.run(firmId, { invoiceNumber: NUM });
  assert.match(result.text, new RegExp(`Invoice ${NUM}`));
  assert.match(result.text, /receivable e-invoice/);
  assert.match(result.text, /status draft/);
  assert.match(result.text, /past the 7-day submission window/);
  assert.deepEqual(result.links, [
    { label: NUM, kind: "invoice", id: invoiceId },
  ]);
  const status = result.facts.find((f) => f.key === "status");
  assert.ok(status && status.value === "draft");
});

test("scope: a client pin only sees its own paper", async () => {
  assert.ok(intent);
  // Own paper: answers.
  const own = await intent.run(firmId, {
    invoiceNumber: NUM,
    clientPartyId: clientParty,
  });
  assert.match(own.text, new RegExp(`Invoice ${NUM}`));
  // The sibling's number under the caller's pin: non-disclosure.
  const foreign = await intent.run(firmId, {
    invoiceNumber: `IS-${SALT}-88`,
    clientPartyId: clientParty,
  });
  assert.match(foreign.text, /No invoice numbered/);
  // The H1 shape: the sibling's RECEIVABLE with our client on the buyer
  // side (dual-engaged) — the pin's buyer arm is BILL_ORIENTATION-
  // qualified, so this answers non-disclosure, never the sibling's
  // failed-submission posture.
  const dualEngaged = await intent.run(firmId, {
    invoiceNumber: `IS-${SALT}-99`,
    clientPartyId: clientParty,
  });
  assert.match(dualEngaged.text, /No invoice numbered/);
  assert.ok(
    !dualEngaged.text.includes("failed"),
    "the sibling's rail posture never leaks",
  );
  // The client's genuine BILL answers on the buyer side — bill copy, and
  // deliberately NO link (the invoice detail loader is supplier-side).
  const bill = await intent.run(firmId, {
    invoiceNumber: `IS-${SALT}-55`,
    clientPartyId: clientParty,
  });
  assert.match(bill.text, /captured supplier bill/);
  assert.equal(bill.links, undefined);
  // A foreign firm sees nothing at all.
  const otherFirm = await intent.run(randomUUID(), { invoiceNumber: NUM });
  assert.match(otherFirm.text, /No invoice numbered/);
});

test("a duplicated number asks for the client instead of guessing", async () => {
  assert.ok(intent);
  // The sibling now captures the SAME number.
  await getDb().insert(invoicesTable).values({
    firmId,
    supplierPartyId: siblingParty,
    buyerPartyId: buyer,
    invoiceNumber: NUM,
    issueDate: daysAgo(3),
    status: "draft",
    grandTotal: "10000.00",
    subtotal: "9302.33",
    vatTotal: "697.67",
  });
  const result = await intent.run(firmId, { invoiceNumber: NUM });
  assert.match(result.text, /2 invoices share the number/);
  assert.match(result.text, /Add the client's name/);
  assert.equal(result.links, undefined, "no link when the pick is ambiguous");
});
