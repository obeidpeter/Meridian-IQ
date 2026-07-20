import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  getDb,
  firmsTable,
  usersTable,
  partiesTable,
  clerkCasesTable,
  clerkEvalFixturesTable,
  clerkInferenceCallsTable,
  errorCatalogueTable,
  submissionAttemptsTable,
  type ClerkCase,
} from "@workspace/db";
import {
  fixtureFromCase,
  growEvalFixtures,
  loadGrownFixtures,
} from "./eval-growth.ts";
import { explainInvoiceFailure } from "./explain.ts";
import { createExtractionCase } from "./cases.ts";
import type { Principal } from "../auth/rbac.ts";
import { createDraft } from "../invoice/service.ts";
import {
  fakeGateway,
  saveAndEnableClerkFlag,
  restoreClerkFlag,
} from "./test-support.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Clerk expansions B & C: the correction→eval learning loop and the grounded
// failure explainer, plus voice-note duration persistence.

const SALT = makeRunSalt();
const userId = randomUUID();
const firmId = randomUUID();
const brokeFirmId = randomUUID();
const clientId = randomUUID();
const buyerId = randomUUID();
const CODE = `EXP_TEST_${SALT}`.slice(0, 40);

const admin: Principal = {
  userId,
  role: "firm_admin",
  firmId,
  clientPartyId: null,
  buyerPartyId: null,
};
const brokeAdmin: Principal = { ...admin, firmId: brokeFirmId };

let invoiceId = "";

before(async () => {
  await saveAndEnableClerkFlag();
  const db = getDb();
  await db
    .insert(usersTable)
    .values({ id: userId, email: `clerk-exp-${SALT}@test.local` })
    .onConflictDoNothing();
  await db.insert(firmsTable).values([
    { id: firmId, name: `Exp Firm ${SALT}` },
    { id: brokeFirmId, name: `Exp Broke Firm ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    {
      id: clientId,
      type: "client_business",
      legalName: `Exp Client ${SALT}`,
      tin: "40000000-0081",
      street: "1 Marina Rd",
      city: "Lagos",
    },
    {
      id: buyerId,
      type: "buyer",
      legalName: `Exp Buyer ${SALT}`,
      tin: "40000000-0082",
      street: "3 Broad St",
      city: "Lagos",
    },
  ]);
  await db
    .insert(errorCatalogueTable)
    .values({
      code: CODE,
      cause: `test cause ${SALT}`,
      fix: `test fix ${SALT}`,
      retriable: true,
    })
    .onConflictDoNothing();

  const bundle = await createDraft(
    {
      firmId,
      supplierPartyId: clientId,
      buyerPartyId: buyerId,
      invoiceNumber: `EXP-${SALT}`,
      issueDate: "2026-07-01",
      lines: [
        { description: "Goods", quantity: "1", unitPrice: "1000", vatRate: "0.075" },
      ],
    },
    userId,
  );
  invoiceId = bundle.invoice.id;
  await db.insert(submissionAttemptsTable).values({
    invoiceId,
    rail: "rail_primary",
    attemptNo: 1,
    idempotencyKey: `exp-${SALT}-1`,
    status: "error",
    errorCode: CODE,
  });

  // Exhaust brokeFirm's Clerk allowance so the explainer must fall back.
  await db.insert(clerkInferenceCallsTable).values({
    firmId: brokeFirmId,
    purpose: "extract_invoice",
    model: "fake-model-test",
    promptVersion: "test",
    inputRef: `exp-budget-${SALT}`,
    outputJson: null,
    schemaValid: true,
    outcome: "ok",
    promptTokens: 2_000_000,
    completionTokens: 0,
  });
});

after(async () => {
  await restoreClerkFlag();
});

test("fixtureFromCase turns a corrected approval into ground truth", () => {
  const base = {
    id: randomUUID(),
    sourceName: "july.pdf",
    sourceText: "INVOICE ...",
    status: "approved",
    corrections: [
      { field: "invoiceNumber", extracted: "INV-1", final: "INV-1", changed: false },
      { field: "buyerName", extracted: "Norstar", final: "Northstar Ltd", changed: true },
    ],
  } as unknown as ClerkCase;

  const fixture = fixtureFromCase(base);
  assert.ok(fixture);
  assert.equal(fixture.expected.invoiceNumber, "INV-1");
  assert.equal(fixture.expected.buyerName, "Northstar Ltd");

  assert.equal(fixtureFromCase({ ...base, status: "rejected" } as ClerkCase), null);
  assert.equal(fixtureFromCase({ ...base, sourceText: null } as ClerkCase), null);
  assert.equal(fixtureFromCase({ ...base, corrections: null } as ClerkCase), null);
});

test("growEvalFixtures ingests each corrected approval exactly once", async () => {
  const db = getDb();
  const [kase] = await db
    .insert(clerkCasesTable)
    .values({
      kind: "extraction",
      status: "approved",
      sourceType: "text",
      sourceName: `grown-${SALT}.txt`,
      sourceText: `INVOICE GROWN-${SALT} total 500`,
      corrections: [
        { field: "invoiceNumber", extracted: null, final: `GROWN-${SALT}`, changed: true },
      ],
      createdBy: userId,
    })
    .returning({ id: clerkCasesTable.id });

  // The shared test DB accumulates corrected approvals from other suites, so
  // drain the backlog (batched at 20/pass) until quiet, then assert the drained
  // state — the same drain-until-quiet pattern the sweep itself relies on.
  let drained = 0;
  for (let i = 0; i < 50 && (await growEvalFixtures()) > 0; i++) drained++;
  assert.ok(drained >= 1, "at least one pass grew fixtures (ours included)");
  assert.equal(await growEvalFixtures(), 0, "drained: nothing new grows");

  const rows = await db
    .select()
    .from(clerkEvalFixturesTable)
    .where(eq(clerkEvalFixturesTable.caseId, kase.id));
  assert.equal(rows.length, 1, "exactly one fixture per case");

  const grown = await loadGrownFixtures();
  const mine = grown.find((f) => f.sourceText.includes(`GROWN-${SALT}`));
  assert.ok(mine, "grown fixture is loaded into the eval corpus");
  assert.equal(mine.riskLabel, "correction");
  assert.equal(mine.expected.invoiceNumber, `GROWN-${SALT}`);
});

test("explainInvoiceFailure: Clerk phrases the catalogue entry when available", async () => {
  const gateway = fakeGateway(() =>
    JSON.stringify({
      explanation: "The buyer TIN did not match the registry.",
      nextSteps: ["Correct the TIN", "Resubmit the invoice"],
    }),
  );
  const result = await explainInvoiceFailure(invoiceId, admin, gateway);
  assert.equal(result.source, "clerk");
  assert.equal(result.errorCode, CODE);
  assert.equal(result.nextSteps.length, 2);
});

test("explainInvoiceFailure: an exhausted budget falls back to catalogue text", async () => {
  // Re-point the invoice's firm? No — use a second invoice under brokeFirm.
  const bundle = await createDraft(
    {
      firmId: brokeFirmId,
      supplierPartyId: clientId,
      buyerPartyId: buyerId,
      invoiceNumber: `EXP-BROKE-${SALT}`,
      issueDate: "2026-07-01",
      lines: [
        { description: "Goods", quantity: "1", unitPrice: "1000", vatRate: "0.075" },
      ],
    },
    userId,
  );
  await getDb().insert(submissionAttemptsTable).values({
    invoiceId: bundle.invoice.id,
    rail: "rail_primary",
    attemptNo: 1,
    idempotencyKey: `exp-${SALT}-2`,
    status: "error",
    errorCode: CODE,
  });
  const gateway = fakeGateway(() => {
    throw new Error("gateway must not be called when the budget is spent");
  });
  const result = await explainInvoiceFailure(bundle.invoice.id, brokeAdmin, gateway);
  assert.equal(result.source, "catalogue");
  assert.equal(result.explanation, `test cause ${SALT}`);
  assert.deepEqual(result.nextSteps, [`test fix ${SALT}`]);
});

test("explainInvoiceFailure: a null gateway (provider unavailable) still answers catalogue text", async () => {
  // The route passes gatewayOrNull(): when the provider integration cannot
  // even be constructed (missing AI env), the module receives null and the
  // grounded catalogue fallback answers — the digest posture the surface
  // promises, never a 500.
  const result = await explainInvoiceFailure(invoiceId, admin, null);
  assert.equal(result.source, "catalogue");
  assert.equal(result.errorCode, CODE);
  assert.equal(result.explanation, `test cause ${SALT}`);
  assert.deepEqual(result.nextSteps, [`test fix ${SALT}`]);
});

test("explainInvoiceFailure: a client_user reaches only its own party's invoices (SEC-03)", async () => {
  // The route now gates on clerk.capture so the client who owns the failed
  // invoice can use the fix flow; the module remains the scope authority.
  const gateway = fakeGateway(() =>
    JSON.stringify({
      explanation: "Plain words for the client.",
      nextSteps: ["Fix the field", "Resubmit"],
    }),
  );
  const clientPrincipal: Principal = {
    userId,
    role: "client_user",
    firmId,
    clientPartyId: clientId,
    buyerPartyId: null,
  };
  const result = await explainInvoiceFailure(invoiceId, clientPrincipal, gateway);
  assert.equal(result.errorCode, CODE);
  assert.equal(result.source, "clerk");

  // A sibling client of the SAME firm shares the firm-keyed RLS scope — the
  // party check is the only wall, and it must hold.
  const sibling: Principal = { ...clientPrincipal, clientPartyId: buyerId };
  await assert.rejects(
    explainInvoiceFailure(invoiceId, sibling, gateway),
    (err: Error & { code?: string; status?: number }) =>
      err.code === "CROSS_CLIENT" && err.status === 403,
  );
});

test("explainInvoiceFailure: 404 when the invoice never failed", async () => {
  const bundle = await createDraft(
    {
      firmId,
      supplierPartyId: clientId,
      buyerPartyId: buyerId,
      invoiceNumber: `EXP-CLEAN-${SALT}`,
      issueDate: "2026-07-01",
      lines: [
        { description: "Goods", quantity: "1", unitPrice: "1000", vatRate: "0.075" },
      ],
    },
    userId,
  );
  await assert.rejects(
    explainInvoiceFailure(bundle.invoice.id, admin, fakeGateway(() => "{}")),
    (err: Error & { status?: number }) => err.status === 404,
  );
});

test("a recorded voice note's duration is stored on the case", async () => {
  const kase = await createExtractionCase(
    {
      sourceType: "voice",
      audioBase64: Buffer.from(`audio-${SALT}`).toString("base64"),
      name: "note.webm",
      durationSec: 18,
    },
    userId,
    fakeGateway(() => JSON.stringify({ fields: [], lines: [] })),
    async () => `Invoice Northstar for the July delivery ${SALT}`,
    { firmId },
  );
  assert.equal(kase.sourceDurationSec, 18);
  assert.equal(kase.firmId, firmId);
});
