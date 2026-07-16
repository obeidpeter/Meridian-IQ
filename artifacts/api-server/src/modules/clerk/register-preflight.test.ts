import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  firmsTable,
  partiesTable,
  invoicesTable,
  usersTable,
  type ClerkExtraction,
} from "@workspace/db";
import {
  identityIssues,
  registerPreflightChecks,
} from "./register-preflight.ts";
import {
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "./test-support.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Register-history pre-flight (exhaust idea #6). Pinned invariants:
//  - checks fire only on STRONG name evidence, and messages reference the
//  document's values — the register's TIN appears masked, never in full;
//  - candidates come from the firm's party sphere only: an identical party
//  belonging to another firm produces NO issue (and no leak);
//  - the VAT-history check needs real history (>= 5 invoices) and a real
//  deviation; thin evidence stays silent;
//  - no firm scope (operator capture) = no checks at all.

const SALT = makeRunSalt();
const firmA = randomUUID();
const firmB = randomUUID();
const userId = randomUUID();
const supplierId = randomUUID();
const buyerId = randomUUID();
const foreignBuyerId = randomUUID();

const SUPPLIER_NAME = `Chukwuma Stores ${SALT}`;
const BUYER_NAME = `Adaeze Retail ${SALT}`;
const FOREIGN_NAME = `Okafor Logistics ${SALT}`;
const BUYER_TIN = `9876543${SALT.slice(-3)}1`;

function extraction(
  values: Record<string, string | null>,
): ClerkExtraction {
  return {
    fields: Object.entries(values).map(([field, value]) => ({
      field: field as never,
      value,
      confidence: 0.9,
      sourceSnippet: null,
      critical: true,
      flagged: true,
    })),
    lines: [],
    promptVersion: "extract.v1",
    model: "fake",
  };
}

before(async () => {
  await saveAndEnableClerkFlag();
  const db = getDb();
  await db.insert(firmsTable).values([
    { id: firmA, name: `Register Firm A ${SALT}` },
    { id: firmB, name: `Register Firm B ${SALT}` },
  ]);
  await db
    .insert(usersTable)
    .values({ id: userId, email: `register-${SALT}@test.example` })
    .onConflictDoNothing();
  await db.insert(partiesTable).values([
    // In firm A's sphere via provenance (createdByFirmId).
    {
      id: supplierId,
      type: "client_business",
      legalName: SUPPLIER_NAME,
      tin: `1111222${SALT.slice(-3)}3`,
      createdByFirmId: firmA,
    },
    {
      id: buyerId,
      type: "buyer",
      legalName: BUYER_NAME,
      tin: BUYER_TIN,
      createdByFirmId: firmA,
    },
    // Same shape of data, but firm B's — must be invisible to firm A checks.
    {
      id: foreignBuyerId,
      type: "buyer",
      legalName: FOREIGN_NAME,
      tin: `5555666${SALT.slice(-3)}7`,
      createdByFirmId: firmB,
    },
  ]);
  // Five non-draft invoices from the supplier, all at the standard 7.5%.
  await db.insert(invoicesTable).values(
    Array.from({ length: 5 }, (_, i) => ({
      firmId: firmA,
      supplierPartyId: supplierId,
      buyerPartyId: buyerId,
      invoiceNumber: `REG-${SALT}-${i}`,
      status: "submitted" as const,
      issueDate: "2026-06-01",
      subtotal: "1000.00",
      vatTotal: "75.00",
      grandTotal: "1075.00",
    })),
  );
});

after(async () => {
  await restoreClerkFlag();
});

test("identityIssues: mismatch flagged with a MASKED register TIN", () => {
  const issues = identityIssues(
    "buyer",
    { name: BUYER_NAME, tin: "0000000000" },
    [{ id: buyerId, legalName: BUYER_NAME, tin: BUYER_TIN, type: "buyer" }],
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0].field, "buyerTin");
  assert.ok(issues[0].message.includes(`…${BUYER_TIN.slice(-3)}`));
  assert.equal(
    issues[0].message.includes(BUYER_TIN),
    false,
    "the full register TIN never appears in an issue",
  );

  // Matching TIN: silence.
  const clean = identityIssues("buyer", { name: BUYER_NAME, tin: BUYER_TIN }, [
    { id: buyerId, legalName: BUYER_NAME, tin: BUYER_TIN, type: "buyer" },
  ]);
  assert.equal(clean.length, 0);

  // Weak name evidence: silence, whatever the TINs say.
  const weak = identityIssues(
    "buyer",
    { name: "Completely Different Name", tin: "0000000000" },
    [{ id: buyerId, legalName: BUYER_NAME, tin: BUYER_TIN, type: "buyer" }],
  );
  assert.equal(weak.length, 0);
});

test("missing TIN with a registered one becomes an ADVISORY hint", () => {
  const issues = identityIssues("buyer", { name: BUYER_NAME, tin: null }, [
    { id: buyerId, legalName: BUYER_NAME, tin: BUYER_TIN, type: "buyer" },
  ]);
  assert.equal(issues.length, 1);
  assert.ok(issues[0].message.includes("confirm it at approval"));
  assert.equal(
    issues[0].severity,
    "advisory",
    "a document that simply omits a registered TIN must not lose the fast lane",
  );
});

test("one shared name token is not evidence — no false TIN warnings", () => {
  // "Adaeze" alone would score nameScore 1 against any party sharing the
  // token (containment over the smaller set); the strong-match rule demands
  // two meaningful tokens before the register may complain.
  const issues = identityIssues(
    "buyer",
    { name: "Adaeze", tin: "0000000000" },
    [{ id: buyerId, legalName: BUYER_NAME, tin: BUYER_TIN, type: "buyer" }],
  );
  assert.equal(issues.length, 0);

  // Ambiguity guard: two strong matches naming DIFFERENT TINs stay silent.
  const ambiguous = identityIssues(
    "buyer",
    { name: BUYER_NAME, tin: "0000000000" },
    [
      { id: buyerId, legalName: BUYER_NAME, tin: BUYER_TIN, type: "buyer" },
      {
        id: randomUUID(),
        legalName: `${BUYER_NAME} Annex`,
        tin: "555511112222",
        type: "buyer",
      },
    ],
  );
  assert.equal(ambiguous.length, 0);
});

test("sphere isolation: another firm's identical data raises nothing", async () => {
  // The extracted buyer matches firm B's party exactly — but this check runs
  // for firm A, whose sphere does not contain it.
  const issues = await registerPreflightChecks(
    extraction({
      buyerName: FOREIGN_NAME,
      buyerTin: "0000000000",
    }),
    firmA,
  );
  assert.equal(issues.length, 0, "out-of-sphere parties are invisible");

  // And with no firm at all (operator capture), no checks run.
  const none = await registerPreflightChecks(
    extraction({ buyerName: BUYER_NAME, buyerTin: "0000000000" }),
    null,
  );
  assert.equal(none.length, 0);
});

test("register checks fire end-to-end for in-sphere identities", async () => {
  const issues = await registerPreflightChecks(
    extraction({
      supplierName: SUPPLIER_NAME,
      supplierTin: null,
      buyerName: BUYER_NAME,
      buyerTin: "0000000000",
      subtotal: "1000.00",
      vatTotal: "75.00",
    }),
    firmA,
  );
  const fields = issues.map((i) => i.field).sort();
  assert.ok(fields.includes("buyerTin"), "buyer TIN mismatch caught");
  assert.ok(fields.includes("supplierTin"), "missing supplier TIN hinted");
  assert.equal(
    issues.some((i) => i.field === "vatTotal"),
    false,
    "7.5% matches the supplier's history — no VAT complaint",
  );
});

test("unusual VAT treatment for a known supplier is flagged; thin history is not", async () => {
  const zeroRated = await registerPreflightChecks(
    extraction({
      supplierName: SUPPLIER_NAME,
      subtotal: "1000.00",
      vatTotal: "0.00",
    }),
    firmA,
  );
  const vatIssue = zeroRated.find((i) => i.field === "vatTotal");
  assert.ok(vatIssue, "0% against a 7.5% history is unusual");
  assert.ok(vatIssue.message.includes("usually 7.5"));

  // A supplier with no history says nothing.
  const unknown = await registerPreflightChecks(
    extraction({
      supplierName: `Brand New Vendors ${SALT}`,
      subtotal: "1000.00",
      vatTotal: "0.00",
    }),
    firmA,
  );
  assert.equal(unknown.some((i) => i.field === "vatTotal"), false);
});
