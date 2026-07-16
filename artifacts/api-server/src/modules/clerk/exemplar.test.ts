import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import {
  getDb,
  clerkCasesTable,
  clerkEvalFixturesTable,
  clerkInferenceCallsTable,
  firmsTable,
  invoicesTable,
  partiesTable,
  usersTable,
} from "@workspace/db";
import { createExtractionCase } from "./cases.ts";
import { growEvalFixtures } from "./eval-growth.ts";
import {
  findExtractionExemplar,
  matchesSupplierName,
  matchesSupplierTin,
} from "./exemplar.ts";
import type { CompletionRequest } from "./gateway.ts";
import {
  fakeGateway,
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "./test-support.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Supplier memory (exhaust idea #1). Pinned invariants:
//  - the PRODUCTION learning loop produces matchable fixtures: growEvalFixtures
//  stamps the approved invoice's supplier party identity onto the fixture
//  (corrections deliberately exclude party identity, so matching on expected
//  keys would never fire — the green-wash the adversarial review caught);
//  - a fixture NEVER crosses firms, and client-scoped captures narrow the
//  pool to the caller's own cases (SEC-03);
//  - selection is deterministic: exact-TIN evidence outranks name evidence,
//  newest first within a pass, weak evidence matches nothing;
//  - the exemplar changes only the prompt (with its own ledger prompt
//  version) and is recorded on the extraction; the cold path is byte-identical.

const SALT = makeRunSalt();
const firmA = randomUUID();
const firmB = randomUUID();
const userId = randomUUID();
const clientUserId = randomUUID();

const SUPPLIER = `Adaeze Foods ${SALT}`;
const TIN = `12345678${SALT.slice(-4)}`;

async function seedFixture(
  firmId: string,
  identity: { supplierName: string | null; supplierTin: string | null },
  sourceText: string,
  createdBy = userId,
): Promise<string> {
  const caseId = randomUUID();
  await getDb().insert(clerkCasesTable).values({
    id: caseId,
    kind: "extraction",
    status: "approved",
    sourceType: "text",
    sourceText,
    firmId,
    createdBy,
  });
  await getDb().insert(clerkEvalFixturesTable).values({
    caseId,
    label: `fixture-${caseId.slice(0, 8)}`,
    sourceText,
    expected: { invoiceNumber: "INV-1" },
    supplierName: identity.supplierName,
    supplierTin: identity.supplierTin,
  });
  return caseId;
}

before(async () => {
  await saveAndEnableClerkFlag();
  const db = getDb();
  await db.insert(firmsTable).values([
    { id: firmA, name: `Exemplar Firm A ${SALT}` },
    { id: firmB, name: `Exemplar Firm B ${SALT}` },
  ]);
  await db
    .insert(usersTable)
    .values([
      { id: userId, email: `exemplar-${SALT}@test.example` },
      { id: clientUserId, email: `exemplar-client-${SALT}@test.example` },
    ])
    .onConflictDoNothing();
});

after(async () => {
  await restoreClerkFlag();
});

test("matching: TIN containment (8+ chars) or 2+ name tokens, nothing weaker", () => {
  const blob = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const doc = blob(`INVOICE from ${SUPPLIER} TIN ${TIN} for June deliveries`);
  assert.equal(
    matchesSupplierTin(doc, { supplierTin: TIN, supplierName: null }),
    true,
  );
  assert.equal(
    matchesSupplierName(doc, { supplierTin: null, supplierName: SUPPLIER }),
    true,
  );
  assert.equal(
    matchesSupplierName(doc, {
      supplierTin: null,
      supplierName: "Zenith Traders",
    }),
    false,
  );
  // One-token / generic-only names and short TINs are too weak to match on.
  assert.equal(
    matchesSupplierName(doc, { supplierTin: null, supplierName: "Adaeze" }),
    false,
  );
  assert.equal(
    matchesSupplierName(doc, {
      supplierTin: null,
      supplierName: "The Company Ltd",
    }),
    false,
  );
  assert.equal(
    matchesSupplierTin(blob("total 1234567 paid"), {
      supplierTin: "1234567",
      supplierName: null,
    }),
    false,
    "7-char TINs are below the containment evidence floor",
  );
});

test("the PRODUCTION growth loop produces a matchable fixture", async () => {
  // decideCase-shaped exhaust: an approved case with corrections and a
  // created invoice whose supplier party carries the register identity.
  const supplierPartyId = randomUUID();
  const caseId = randomUUID();
  await getDb().insert(partiesTable).values({
    id: supplierPartyId,
    type: "client_business",
    legalName: SUPPLIER,
    tin: TIN,
  });
  const [invoice] = await getDb()
    .insert(invoicesTable)
    .values({
      firmId: firmA,
      supplierPartyId,
      buyerPartyId: supplierPartyId,
      invoiceNumber: `EXG-${SALT}`,
      issueDate: "2026-07-01",
    })
    .returning({ id: invoicesTable.id });
  await getDb().insert(clerkCasesTable).values({
    id: caseId,
    kind: "extraction",
    status: "approved",
    sourceType: "text",
    sourceText: `INVOICE EXG-${SALT} from ${SUPPLIER}\nTotal 100`,
    // Production corrections NEVER include party identity — only these.
    corrections: [
      {
        field: "invoiceNumber",
        extracted: `EXG-${SALT}`,
        final: `EXG-${SALT}`,
        changed: false,
      },
    ],
    createdInvoiceId: invoice.id,
    firmId: firmA,
    createdBy: userId,
  });

  const grown = await growEvalFixtures();
  assert.ok(grown >= 1);
  const [fixture] = await getDb()
    .select()
    .from(clerkEvalFixturesTable)
    .where(eq(clerkEvalFixturesTable.caseId, caseId));
  assert.equal(fixture.supplierName, SUPPLIER, "register identity stamped");
  assert.equal(fixture.supplierTin, TIN);

  // The next document from this supplier now finds the fixture — through
  // exactly the identity the growth loop wrote, no hand-seeded keys.
  const hit = await findExtractionExemplar(
    `INVOICE EXG2-${SALT}\nFrom: ${SUPPLIER}\nTotal 250`,
    firmA,
  );
  assert.equal(hit?.caseId, caseId);
});

test("TIN evidence outranks a newer name-only match; firms never mix", async () => {
  const tinMatch = await seedFixture(
    firmA,
    { supplierName: null, supplierTin: TIN },
    `TIN fixture ${SALT}`,
  );
  await seedFixture(
    firmB,
    { supplierName: SUPPLIER, supplierTin: TIN },
    `FOREIGN fixture ${SALT}`,
  );
  const nameMatch = await seedFixture(
    firmA,
    { supplierName: SUPPLIER, supplierTin: null },
    `NAME fixture ${SALT}`,
  );

  const doc = `INVOICE\nFrom: ${SUPPLIER}\nTIN: ${TIN}\nJune deliveries`;
  const hit = await findExtractionExemplar(doc, firmA);
  assert.equal(
    hit?.caseId,
    tinMatch,
    "exact TIN beats the newer name-token match",
  );
  assert.notEqual(hit?.caseId, nameMatch);

  const foreign = await findExtractionExemplar(doc, firmB);
  assert.ok(foreign?.sourceText.startsWith("FOREIGN"), "firm B gets its own");

  const none = await findExtractionExemplar(
    `INVOICE from Someone Else Entirely ${SALT}`,
    firmA,
  );
  assert.equal(none, null);
});

test("client-scoped captures only see the caller's own fixtures", async () => {
  // All firm-A fixtures so far were created by userId; a sibling client's
  // capture must not receive them.
  const doc = `INVOICE\nFrom: ${SUPPLIER}\nTIN: ${TIN}\nJuly`;
  const sibling = await findExtractionExemplar(doc, firmA, clientUserId);
  assert.equal(sibling, null, "a sibling client's pool is empty");
  const own = await findExtractionExemplar(doc, firmA, userId);
  assert.ok(own, "the creator still matches their own fixtures");
});

test("capture with a match: exemplar rides along, is ledgered and recorded", async () => {
  const calls: CompletionRequest[] = [];
  const gateway = fakeGateway((req) => {
    calls.push(req);
    return JSON.stringify({
      fields: [
        {
          field: "supplierName",
          value: SUPPLIER,
          confidence: 0.95,
          sourceSnippet: null,
        },
      ],
      lines: [],
    });
  });
  const kase = await createExtractionCase(
    {
      sourceType: "text",
      name: `memory-${SALT}.txt`,
      text: `INVOICE ${SALT}-WARM\nFrom: ${SUPPLIER}\nTIN: ${TIN}\nTotal 150000`,
    },
    userId,
    gateway,
    undefined,
    { firmId: firmA },
  );
  assert.equal(kase.status, "extracted");
  assert.ok(kase.extraction?.exemplarCaseId, "exemplar recorded for audit");
  assert.equal(kase.extraction?.promptVersion, "extract.v1+ex1");

  assert.equal(calls.length, 1);
  const user = calls[0].user as string;
  assert.ok(user.includes("-----BEGIN EXAMPLE DOCUMENT-----"));
  assert.ok(
    calls[0].system.includes("never copy a value from the example"),
    "the system prompt carries the exemplar rules",
  );

  const [ledger] = await getDb()
    .select({ promptVersion: clerkInferenceCallsTable.promptVersion })
    .from(clerkInferenceCallsTable)
    .where(eq(clerkInferenceCallsTable.caseId, kase.id))
    .orderBy(desc(clerkInferenceCallsTable.createdAt))
    .limit(1);
  assert.equal(ledger?.promptVersion, "extract.v1+ex1");
});

test("cold capture stays byte-identical: no fence, no version suffix", async () => {
  const calls: CompletionRequest[] = [];
  const gateway = fakeGateway((req) => {
    calls.push(req);
    return JSON.stringify({ fields: [], lines: [] });
  });
  const kase = await createExtractionCase(
    {
      sourceType: "text",
      name: `cold-${SALT}.txt`,
      text: `INVOICE ${SALT}-COLD from Totally Unknown Vendors ${SALT}`,
    },
    userId,
    gateway,
    undefined,
    { firmId: firmA },
  );
  assert.equal(kase.extraction?.exemplarCaseId, undefined);
  assert.equal(kase.extraction?.promptVersion, "extract.v1");
  const user = calls[0].user as string;
  assert.equal(user.includes("EXAMPLE DOCUMENT"), false);
  assert.equal(calls[0].system.includes("reference example"), false);
});
