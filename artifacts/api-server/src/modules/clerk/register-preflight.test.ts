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
  issueDateIssues,
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

// ---- History-based anomaly flags (exhaust idea #1) --------------------------

test("issueDateIssues: overdue-on-arrival and future dates are advisory; fresh dates silent", () => {
  const TODAY = "2026-07-16";
  const stale = issueDateIssues(extraction({ issueDate: "2026-07-01" }), TODAY);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].field, "issueDate");
  assert.equal(stale[0].severity, "advisory");
  assert.ok(stale[0].message.includes("already past"));

  const future = issueDateIssues(extraction({ issueDate: "2026-07-20" }), TODAY);
  assert.equal(future.length, 1);
  assert.ok(future[0].message.includes("in the future"));

  // Tomorrow is clock-skew slack, yesterday is normal, garbage is silent.
  assert.equal(issueDateIssues(extraction({ issueDate: "2026-07-17" }), TODAY).length, 0);
  assert.equal(issueDateIssues(extraction({ issueDate: "2026-07-14" }), TODAY).length, 0);
  assert.equal(issueDateIssues(extraction({ issueDate: "June 2026" }), TODAY).length, 0);
  assert.equal(issueDateIssues(extraction({ buyerName: "X" }), TODAY).length, 0);

  // Operator captures (no firm) get date sanity too — it needs no register.
  return registerPreflightChecks(
    extraction({ issueDate: "2026-01-01" }),
    null,
  ).then((issues) => {
    assert.equal(issues.length, 1);
    assert.equal(issues[0].field, "issueDate");
  });
});

test("a duplicate invoice number for the same supplier is a full issue", async () => {
  const issues = await registerPreflightChecks(
    extraction({
      supplierName: SUPPLIER_NAME,
      invoiceNumber: `reg-${SALT}-0`, // case-insensitive match on REG-…-0
    }),
    firmA,
  );
  const dup = issues.find((i) => i.field === "invoiceNumber");
  assert.ok(dup, "the existing invoice number is caught");
  assert.equal(dup.severity, undefined, "a duplicate number costs the fast lane");
  assert.ok(dup.message.includes("duplicate"));
  assert.ok(dup.message.includes("submitted"), "names the existing status");
});

test("same date + same total under a NEW number is an advisory duplicate hint", async () => {
  const issues = await registerPreflightChecks(
    extraction({
      supplierName: SUPPLIER_NAME,
      invoiceNumber: `FRESH-${SALT}`,
      issueDate: "2026-06-01",
      grandTotal: "1075.00",
    }),
    firmA,
  );
  const dup = issues.find(
    (i) => i.field === "invoiceNumber" && i.severity === "advisory",
  );
  assert.ok(dup, "same-date same-total is suspicious but only advisory");
  assert.ok(dup.message.includes("different number"));
});

test("SEC-03: a client capture never leaks a SIBLING supplier's history", async () => {
  // The document names the in-sphere supplier, but the capturing client is a
  // DIFFERENT party — history checks (duplicate number, outlier, VAT) that
  // would disclose the supplier's ledger must all stay silent.
  const siblingParty = randomUUID();
  const asSibling = await registerPreflightChecks(
    extraction({
      supplierName: SUPPLIER_NAME,
      invoiceNumber: `reg-${SALT}-0`, // an existing number for that supplier
      grandTotal: "50000.00", // an outlier vs the 1,075 median
      subtotal: "1000.00",
      vatTotal: "0.00", // a VAT deviation
    }),
    firmA,
    siblingParty,
  );
  assert.equal(
    asSibling.some((i) => i.field === "invoiceNumber"),
    false,
    "no duplicate-number disclosure to a sibling",
  );
  assert.equal(
    asSibling.some((i) => i.field === "grandTotal"),
    false,
    "no amount-outlier disclosure to a sibling",
  );
  assert.equal(
    asSibling.some((i) => i.field === "vatTotal"),
    false,
    "no VAT-history disclosure to a sibling",
  );

  // The SAME capture by the supplier itself (its own party) sees its history.
  const asOwn = await registerPreflightChecks(
    extraction({
      supplierName: SUPPLIER_NAME,
      invoiceNumber: `reg-${SALT}-0`,
      grandTotal: "50000.00",
      subtotal: "1000.00",
      vatTotal: "0.00",
    }),
    firmA,
    supplierId,
  );
  assert.ok(
    asOwn.some((i) => i.field === "invoiceNumber"),
    "a client sees its OWN duplicate",
  );
  assert.ok(asOwn.some((i) => i.field === "grandTotal"));
  assert.ok(asOwn.some((i) => i.field === "vatTotal"));

  // A firm/operator capture (null scope) keeps the full firm-wide view.
  const asFirm = await registerPreflightChecks(
    extraction({
      supplierName: SUPPLIER_NAME,
      invoiceNumber: `reg-${SALT}-0`,
    }),
    firmA,
  );
  assert.ok(asFirm.some((i) => i.field === "invoiceNumber"));
});

test("a total far outside the supplier's usual range is an advisory outlier", async () => {
  const issues = await registerPreflightChecks(
    extraction({
      supplierName: SUPPLIER_NAME,
      invoiceNumber: `OUT-${SALT}`,
      grandTotal: "50000.00", // history median is 1075
    }),
    firmA,
  );
  const outlier = issues.find((i) => i.field === "grandTotal");
  assert.ok(outlier, "50k against a 1,075 median is flagged");
  assert.equal(outlier.severity, "advisory");
  assert.ok(outlier.message.includes("usual range"));

  // A plausible amount stays silent; so does an unknown supplier (no history).
  const normal = await registerPreflightChecks(
    extraction({
      supplierName: SUPPLIER_NAME,
      invoiceNumber: `OK-${SALT}`,
      grandTotal: "1200.00",
    }),
    firmA,
  );
  assert.equal(normal.some((i) => i.field === "grandTotal"), false);
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
