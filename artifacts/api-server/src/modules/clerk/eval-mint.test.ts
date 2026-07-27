import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  getDb,
  clerkCasesTable,
  clerkEvalFixturesTable,
  firmsTable,
  invoicesTable,
  membershipsTable,
  partiesTable,
  usersTable,
  type ClerkExtraction,
} from "@workspace/db";
import { MintFixtureFromCaseResponse } from "@workspace/api-zod";
import evalRouter from "../../routes/clerk/eval.ts";
import type { Principal } from "../auth/rbac.ts";
import {
  appFor,
  listen,
  closeAllServers,
  JSON_HEADERS,
} from "../../test-helpers/route-harness.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";
import { DomainError } from "../errors.ts";
import { mintFixtureFromCase } from "./eval-curation.ts";

// Mint a fixture from a decided case (round 7). Invariants pinned here:
//  - a case traceable to a live client (client_user creator OR approved
//    invoice supplier) can only enter the corpus scrubbed: scrub=false is a
//    400 SCRUB_REQUIRED, and the scrub round-trip leaves NO raw name or TIN
//    in the stored text or expected values (one shared pseudonym assignment
//    keeps both consistent);
//  - undecided cases 409 NOT_DECIDED, purged content 400 CONTENT_PURGED,
//    vision/scan cases 400 TEXT_ONLY, double-mint 409 ALREADY_FIXTURE;
//  - the route responds 201 with the curation-inventory summary shape and a
//    minted fixture never carries supplier-memory identity columns.

const SALT = makeRunSalt();

const operatorId = randomUUID();
const clientUserId = randomUUID();
const firmId = randomUUID();
const clientPartyId = randomUUID(); // the client_user's own party (trace 2)
const invSupplierPartyId = randomUUID(); // approved invoice supplier (trace 1)
const invBuyerPartyId = randomUUID();
const invoiceId = randomUUID();

const rejectedCaseId = randomUUID(); // traceable via client_user creator
const approvedCaseId = randomUUID(); // traceable via invoice supplier (route test)
const undecidedCaseId = randomUUID();
const purgedCaseId = randomUUID();
const scanCaseId = randomUUID();

const CLIENT_NAME = `Ngozi Fabrics Ltd ${SALT}`;
const CLIENT_TIN = "55512345-0001";
const BUYER_NAME = `Obi Retail Stores ${SALT}`;
const BUYER_TIN = "66612345-0001";
const INV_SUPPLIER_NAME = `Chuka Steel Works Ltd ${SALT}`;
const INV_SUPPLIER_TIN = "77712345-0001";

function extractionWith(
  fields: Array<{ field: string; value: string | null; critical: boolean }>,
): ClerkExtraction {
  return {
    fields: fields.map((f) => ({
      ...f,
      confidence: 0.9,
      sourceSnippet: null,
      flagged: true,
    })),
    lines: [],
    promptVersion: "extract.test",
    model: "mint-seed",
  };
}

const principal: Principal = {
  userId: operatorId,
  role: "operator",
  firmId: null,
  clientPartyId: null,
  buyerPartyId: null,
};

before(async () => {
  const db = getDb();
  await db.insert(usersTable).values([
    { id: operatorId, email: `mint-op-${SALT}@test.local` },
    { id: clientUserId, email: `mint-client-${SALT}@test.local` },
  ]);
  await db.insert(firmsTable).values({ id: firmId, name: `Mint Firm ${SALT}` });
  await db.insert(partiesTable).values([
    { id: clientPartyId, type: "client_business", legalName: CLIENT_NAME, tin: CLIENT_TIN },
    { id: invSupplierPartyId, type: "client_business", legalName: INV_SUPPLIER_NAME, tin: INV_SUPPLIER_TIN },
    { id: invBuyerPartyId, type: "buyer", legalName: `Lekki Builders ${SALT}` },
  ]);
  await db.insert(membershipsTable).values({
    userId: clientUserId,
    firmId,
    role: "client_user",
    clientPartyId,
  });
  await db.insert(invoicesTable).values({
    id: invoiceId,
    firmId,
    supplierPartyId: invSupplierPartyId,
    buyerPartyId: invBuyerPartyId,
    invoiceNumber: `MINT-INV-${SALT}`,
    issueDate: "2026-06-01",
  });

  await db.insert(clerkCasesTable).values([
    {
      // Rejected forgery a reviewer wants pinned: traceable through its
      // client_user creator; no corrections, so expected = extraction
      // criticals (party identity included — the scrub-consistency case).
      id: rejectedCaseId,
      kind: "extraction",
      status: "rejected",
      sourceType: "text",
      sourceName: `mint-rejected-${SALT}.txt`,
      sourceText: [
        `INVOICE NF-889-${SALT}`,
        "Issue Date: 2026-06-01",
        `Supplier: ${CLIENT_NAME} (TIN: ${CLIENT_TIN})`,
        `Bill To: ${BUYER_NAME} (TIN: 666 123 45 0001)`,
        `Pay ${CLIENT_NAME} promptly.`,
        "TOTAL: NGN 45,000.00",
      ].join("\n"),
      createdBy: clientUserId,
      extraction: extractionWith([
        { field: "invoiceNumber", value: `NF-889-${SALT}`, critical: true },
        { field: "issueDate", value: "2026-06-01", critical: true },
        { field: "dueDate", value: null, critical: false },
        { field: "supplierName", value: CLIENT_NAME, critical: true },
        { field: "supplierTin", value: CLIENT_TIN, critical: true },
        { field: "buyerName", value: BUYER_NAME, critical: true },
        { field: "buyerTin", value: BUYER_TIN, critical: true },
        { field: "grandTotal", value: "45000.00", critical: true },
      ]),
    },
    {
      // Approved with corrections and a created invoice: traceable through
      // the register join (invoices.supplierPartyId) — the route test.
      id: approvedCaseId,
      kind: "extraction",
      status: "approved",
      sourceType: "text",
      sourceName: `mint-approved-${SALT}.txt`,
      sourceText: [
        `TAX INVOICE CSW-12-${SALT}`,
        `From: ${INV_SUPPLIER_NAME}, TIN ${INV_SUPPLIER_TIN}`,
        "Amount payable: NGN 250,000.00",
      ].join("\n"),
      createdBy: operatorId,
      createdInvoiceId: invoiceId,
      extraction: extractionWith([
        { field: "invoiceNumber", value: `CSW-12-${SALT}`, critical: true },
        { field: "supplierName", value: INV_SUPPLIER_NAME, critical: true },
        { field: "grandTotal", value: "250000.00", critical: true },
      ]),
      corrections: [
        {
          field: "invoiceNumber",
          extracted: `CSW-12-${SALT}`,
          final: `CSW-12-${SALT}`,
          changed: false,
        },
        {
          field: "grandTotal",
          extracted: "250000.00",
          final: "255000.00",
          changed: true,
        },
      ],
    },
    {
      id: undecidedCaseId,
      kind: "extraction",
      status: "extracted",
      sourceType: "text",
      sourceText: `INVOICE undecided ${SALT}`,
      createdBy: operatorId,
    },
    {
      // Approved but purged by the retention sweep: no text left to mint.
      id: purgedCaseId,
      kind: "extraction",
      status: "approved",
      sourceType: "text",
      sourceText: null,
      createdBy: operatorId,
      corrections: [
        { field: "grandTotal", extracted: "1", final: "1", changed: false },
      ],
    },
    {
      // Scanned-PDF case: vision content is out of scope this round.
      id: scanCaseId,
      kind: "extraction",
      status: "approved",
      sourceType: "pdf",
      sourceText: null,
      sourceScanPagesB64: ["aGVsbG8="],
      createdBy: operatorId,
      corrections: [
        { field: "grandTotal", extracted: "1", final: "1", changed: false },
      ],
    },
  ]);
});

after(async () => {
  // Keep the grown corpus clean for other suites: fixtures and cases go.
  // The invoice row STAYS — the retention guard (migration 0001) blocks
  // deleting an invoice under its retention window — and with it the firm,
  // party and user rows it references (the fixed-fixture posture the other
  // clerk suites take).
  const db = getDb();
  const caseIds = [
    rejectedCaseId,
    approvedCaseId,
    undecidedCaseId,
    purgedCaseId,
    scanCaseId,
  ];
  await db
    .delete(clerkEvalFixturesTable)
    .where(inArray(clerkEvalFixturesTable.caseId, caseIds));
  await db.delete(clerkCasesTable).where(inArray(clerkCasesTable.id, caseIds));
  await db
    .delete(membershipsTable)
    .where(eq(membershipsTable.userId, clientUserId));
  await closeAllServers();
});

test("scrub=false on a traceable case is refused with SCRUB_REQUIRED", async () => {
  await assert.rejects(
    () =>
      mintFixtureFromCase({ caseId: rejectedCaseId, scrub: false }, operatorId),
    (err: unknown) =>
      err instanceof DomainError &&
      err.code === "SCRUB_REQUIRED" &&
      err.status === 400,
  );
  const rows = await getDb()
    .select()
    .from(clerkEvalFixturesTable)
    .where(eq(clerkEvalFixturesTable.caseId, rejectedCaseId));
  assert.equal(rows.length, 0, "nothing was stored");
});

test("mint + scrub round-trip: no raw name or TIN survives, in text OR expected", async () => {
  const summary = await mintFixtureFromCase(
    { caseId: rejectedCaseId },
    operatorId,
  );
  assert.equal(summary.source, "grown");
  assert.equal(summary.key, `correction.${rejectedCaseId.slice(0, 8)}`);
  assert.equal(summary.retired, false);

  const [row] = await getDb()
    .select()
    .from(clerkEvalFixturesTable)
    .where(eq(clerkEvalFixturesTable.caseId, rejectedCaseId));
  assert.ok(row);
  const stored = JSON.stringify({ text: row.sourceText, expected: row.expected });
  assert.ok(!/ngozi/i.test(stored), "supplier name scrubbed everywhere");
  assert.ok(!/obi retail/i.test(stored), "buyer name scrubbed everywhere");
  assert.ok(!stored.includes("55512345"), "supplier TIN digits gone");
  assert.ok(
    !/666\s*123\s*45\s*-?\s*0001/.test(stored),
    "buyer TIN gone even in its spaced printed form",
  );

  // Text and expected share ONE pseudonym assignment (first-seen in the
  // text: supplier -> Company A, buyer -> Company B) so the fixture still
  // scores: the document literally prints the expected values.
  const expected = row.expected as Record<string, string | null>;
  assert.equal(expected.supplierName, "Company A");
  assert.equal(expected.buyerName, "Company B");
  assert.equal(expected.supplierTin, "00000001-0001");
  assert.equal(expected.buyerTin, "00000002-0001");
  assert.ok(row.sourceText.includes("Supplier: Company A (TIN: 00000001-0001)"));
  // Non-identity values survive verbatim.
  assert.equal(expected.grandTotal, "45000.00");
  assert.ok(row.sourceText.includes("TOTAL: NGN 45,000.00"));

  // A minted fixture never serves supplier memory.
  assert.equal(row.supplierName, null);
  assert.equal(row.supplierTin, null);
  assert.equal(row.retiredAt, null);
});

test("double-mint is a 409 ALREADY_FIXTURE", async () => {
  await assert.rejects(
    () => mintFixtureFromCase({ caseId: rejectedCaseId }, operatorId),
    (err: unknown) =>
      err instanceof DomainError &&
      err.code === "ALREADY_FIXTURE" &&
      err.status === 409,
  );
});

test("undecided, purged and scan cases are refused with their specific codes", async () => {
  await assert.rejects(
    () => mintFixtureFromCase({ caseId: undecidedCaseId }, operatorId),
    (err: unknown) =>
      err instanceof DomainError &&
      err.code === "NOT_DECIDED" &&
      err.status === 409,
  );
  await assert.rejects(
    () => mintFixtureFromCase({ caseId: purgedCaseId }, operatorId),
    (err: unknown) =>
      err instanceof DomainError &&
      err.code === "CONTENT_PURGED" &&
      err.status === 400,
  );
  await assert.rejects(
    () => mintFixtureFromCase({ caseId: scanCaseId }, operatorId),
    (err: unknown) =>
      err instanceof DomainError &&
      err.code === "TEXT_ONLY" &&
      err.status === 400,
  );
  await assert.rejects(
    () => mintFixtureFromCase({ caseId: randomUUID() }, operatorId),
    (err: unknown) =>
      err instanceof DomainError && err.status === 404,
  );
});

test("route: 201 with the summary shape; register-join identities are scrubbed too", async () => {
  const base = await listen(appFor(principal, evalRouter));
  const res = await fetch(`${base}/clerk/eval/fixtures/from-case`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ caseId: approvedCaseId }),
  });
  assert.equal(res.status, 201);
  const body = MintFixtureFromCaseResponse.parse(await res.json());
  assert.equal(body.source, "grown");
  assert.equal(body.key, `correction.${approvedCaseId.slice(0, 8)}`);
  assert.equal(body.retired, false);

  const [row] = await getDb()
    .select()
    .from(clerkEvalFixturesTable)
    .where(eq(clerkEvalFixturesTable.caseId, approvedCaseId));
  assert.ok(row);
  // The supplier identity came off the created invoice's register party (the
  // eval-growth join precedent) and the extraction — both scrubbed.
  assert.ok(!/chuka/i.test(row.sourceText));
  assert.ok(!row.sourceText.includes("77712345"));
  // Corrections' FINAL values are the ground truth when present.
  const expected = row.expected as Record<string, string | null>;
  assert.equal(expected.grandTotal, "255000.00");
});
