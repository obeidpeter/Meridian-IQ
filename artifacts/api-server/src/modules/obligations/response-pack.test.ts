import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  auditEventsTable,
  clerkInferenceCallsTable,
  engagementsTable,
  firmsTable,
  invoicesTable,
  partiesTable,
  submissionAttemptsTable,
  usersTable,
} from "@workspace/db";
import { DomainError } from "../errors.ts";
import type { Principal } from "../auth/rbac.ts";
import type { CompletionRequest } from "../clerk/gateway.ts";
import {
  computeObligationResponseFacts,
  draftObligationResponse,
  resolveResponseMonth,
  responsePackLines,
} from "./response-pack.ts";
import {
  renderObligationResponsePdf,
  type ObligationResponsePdfInput,
} from "./response-pack-pdf.ts";
import { createObligation } from "./obligations.ts";
import obligationsRouter from "../../routes/obligations.ts";
import { lagosMonthStart, monthLabel } from "../clerk/client-statement.ts";
import { vatPositionMonths } from "../invoice/vat-position.ts";
import {
  fakeGateway,
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "../clerk/test-support.ts";
import {
  appFor,
  listen,
  closeAllServers,
  JSON_HEADERS,
} from "../../test-helpers/route-harness.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";
import {
  clientPrincipal,
  firmPrincipal,
} from "../../test-helpers/principals.ts";

// Response Desk (Task #207). Pinned here:
//  - resolveResponseMonth: ONE month home for both endpoints — explicit month
//    through the live-month resolver (off-list → BAD_MONTH), else the
//    notice's issue month when on the list, else the current Lagos month;
//  - facts: the routes' 404 non-disclosure dance — a foreign tenant's
//    obligation and a sibling client's obligation are both indistinguishable
//    from an id that does not exist (zero leakage);
//  - the draft ladder: template without a gateway, Clerk phrasing when a
//    valid grounded letter comes back (with the NOTICE fence in the prompt),
//    template again on an invented numeral or an exhausted budget — never an
//    AI-availability error;
//  - the bundle PDF: a real PDF, byte-identical across renders of identical
//    inputs, and letter-free BY TYPE (the renderer's input has no letter
//    field — asserted at compile time below);
//  - routes: obligation.write only (a client_user's obligation.read must not
//    pull firm work product), and the pack ships as application/pdf.

const SALT = makeRunSalt();
const firmA = randomUUID();
const firmB = randomUUID();
const brokeFirmId = randomUUID();
const clientParty = randomUUID(); // the obligation's subject
const siblingParty = randomUUID(); // the SEC-03 probe
const buyerParty = randomUUID();
const vendorParty = randomUUID();
const brokeParty = randomUUID();
const adminId = randomUUID();

const MONTH = lagosMonthStart(0); // the current Lagos month
const CLIENT_NAME = `Resp Client ${SALT}`;
const SIBLING_NAME = `Resp Sibling ${SALT}`;
const REFERENCE = `FIRS/ASMT/${SALT}`;

const admin: Principal = firmPrincipal(firmA, { userId: adminId });
const brokeAdmin: Principal = firmPrincipal(brokeFirmId, { userId: adminId });
const clientUser: Principal = clientPrincipal(firmA, clientParty);

// Exact Lagos calendar dates (WAT is fixed UTC+1, no DST).
function lagosDateOffset(days: number): string {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

let obMainId = "";
let brokeObId = "";

async function pdfText(buf: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const result = await parser.getText();
    return result.text ?? "";
  } finally {
    await parser.destroy().catch(() => {});
  }
}

before(async () => {
  await saveAndEnableClerkFlag();
  const db = getDb();
  await db
    .insert(usersTable)
    .values({ id: adminId, email: `resp-${SALT}@test.local` })
    .onConflictDoNothing();
  await db.insert(firmsTable).values([
    { id: firmA, name: `Resp Firm ${SALT}` },
    { id: firmB, name: `Resp Foreign Firm ${SALT}` },
    { id: brokeFirmId, name: `Resp Broke Firm ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    { id: clientParty, type: "client_business", legalName: CLIENT_NAME },
    { id: siblingParty, type: "client_business", legalName: SIBLING_NAME },
    { id: buyerParty, type: "buyer", legalName: `Resp Buyer ${SALT}` },
    { id: vendorParty, type: "buyer", legalName: `Resp Vendor ${SALT}` },
    { id: brokeParty, type: "client_business", legalName: `Resp Broke ${SALT}` },
  ]);
  await db.insert(engagementsTable).values([
    { firmId: firmA, clientPartyId: clientParty, type: "retainer", title: `resp A ${SALT}` },
    { firmId: firmA, clientPartyId: siblingParty, type: "retainer", title: `resp B ${SALT}` },
    { firmId: brokeFirmId, clientPartyId: brokeParty, type: "retainer", title: `resp C ${SALT}` },
  ]);

  // The month's paper: a rails-accepted invoice (register + output VAT), an
  // unsubmitted draft (register + backlog) and a captured supplier bill
  // (payables + input VAT) — enough for every bundle section to have figures.
  const stampedId = randomUUID();
  await db.insert(invoicesTable).values([
    {
      id: stampedId,
      firmId: firmA,
      supplierPartyId: clientParty,
      buyerPartyId: buyerParty,
      invoiceNumber: `RP-INV-${SALT}`,
      status: "stamped",
      issueDate: `${MONTH.slice(0, 7)}-05`,
      subtotal: "1000.00",
      vatTotal: "75.00",
      grandTotal: "1075.00",
    },
    {
      firmId: firmA,
      supplierPartyId: clientParty,
      buyerPartyId: buyerParty,
      invoiceNumber: `RP-DRAFT-${SALT}`,
      status: "draft",
      issueDate: `${MONTH.slice(0, 7)}-10`,
      subtotal: "200.00",
      vatTotal: "15.00",
      grandTotal: "215.00",
    },
    {
      firmId: firmA,
      supplierPartyId: vendorParty,
      buyerPartyId: clientParty,
      invoiceNumber: `RP-BILL-${SALT}`,
      status: "draft",
      issueDate: `${MONTH.slice(0, 7)}-03`,
      subtotal: "500.00",
      vatTotal: "40.00",
      grandTotal: "540.00",
    },
  ]);
  await db.insert(submissionAttemptsTable).values({
    invoiceId: stampedId,
    rail: "rail_primary",
    attemptNo: 1,
    idempotencyKey: `resp-inv-${SALT}`,
    status: "accepted",
  });

  const obMain = await createObligation(
    firmA,
    {
      clientPartyId: clientParty,
      noticeType: "assessment",
      authority: "firs",
      reference: REFERENCE,
      taxType: "vat",
      period: "the month under review",
      amount: "120000.00",
      currency: "NGN",
      issueDate: `${MONTH.slice(0, 7)}-05`,
      responseDueDate: lagosDateOffset(10),
      notes: "arrived by courier",
    },
    adminId,
  );
  obMainId = obMain.id;

  const brokeOb = await createObligation(
    brokeFirmId,
    {
      clientPartyId: brokeParty,
      noticeType: "demand",
      authority: "lirs",
      responseDueDate: lagosDateOffset(7),
    },
    adminId,
  );
  brokeObId = brokeOb.id;
  // Exhaust the broke firm's Clerk allowance (the clerk-expansion.test.ts
  // arrangement): one ledger row worth the whole default monthly budget.
  await db.insert(clerkInferenceCallsTable).values({
    firmId: brokeFirmId,
    purpose: "extract_invoice",
    model: "fake-model-test",
    promptVersion: "test",
    inputRef: `resp-budget-${SALT}`,
    outputJson: null,
    schemaValid: true,
    outcome: "ok",
    promptTokens: 2_000_000,
    completionTokens: 0,
  });
});

after(async () => {
  await restoreClerkFlag();
  await closeAllServers();
});

// ---------------------------------------------------------------------------
// resolveResponseMonth — ONE home for the period
// ---------------------------------------------------------------------------

test("resolveResponseMonth: explicit month wins, issue month leads when live, else current", () => {
  const months = vatPositionMonths();

  // Explicit month: the live-month resolver verbatim.
  assert.equal(
    resolveResponseMonth({ issueDate: null }, lagosMonthStart(3)),
    lagosMonthStart(3),
  );
  assert.throws(
    () => resolveResponseMonth({ issueDate: null }, "2019-01-01"),
    (err: unknown) =>
      err instanceof DomainError &&
      err.code === "BAD_MONTH" &&
      err.status === 400,
  );

  // Omitted: the notice's issue month when it is on the live 12-month list.
  assert.equal(
    resolveResponseMonth({ issueDate: `${lagosMonthStart(2).slice(0, 7)}-15` }),
    lagosMonthStart(2),
  );
  // Off-list issue month (an old notice) → the current Lagos month.
  assert.equal(resolveResponseMonth({ issueDate: "2019-03-10" }), months[0]);
  // No issue date recorded → the current Lagos month.
  assert.equal(resolveResponseMonth({ issueDate: null }), months[0]);
});

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

test("facts join the obligation to its client's period figures", async () => {
  const facts = await computeObligationResponseFacts(obMainId, admin);
  assert.equal(facts.obligation.id, obMainId);
  assert.equal(facts.obligation.reference, REFERENCE);
  assert.equal(facts.monthStart, MONTH, "the issue month is the current month");
  assert.equal(facts.monthLabel, monthLabel(MONTH));
  assert.equal(facts.pack.clientName, CLIENT_NAME);
  assert.equal(facts.pack.firmName, `Resp Firm ${SALT}`);
  assert.ok(
    facts.pack.register.rows.some((r) => r.invoiceNumber === `RP-INV-${SALT}`),
    "the month's register is computed for the obligation's client",
  );

  // An explicit month overrides the issue-month default.
  const back = await computeObligationResponseFacts(
    obMainId,
    admin,
    lagosMonthStart(1),
  );
  assert.equal(back.monthStart, lagosMonthStart(1));
  assert.equal(back.monthLabel, monthLabel(lagosMonthStart(1)));

  // The figure lines speak the pack's own numbers (one home).
  const lines = responsePackLines(facts.pack);
  assert.ok(lines.some((l) => l === `Output VAT: NGN ${facts.pack.vat.outputVat}`));
  assert.ok(
    lines.some((l) => l.startsWith("Documents issued in the month: ")),
  );
});

test("404 non-disclosure: foreign tenant, sibling client and unknown id are indistinguishable", async () => {
  const isNotFound = (err: unknown) =>
    err instanceof DomainError &&
    err.code === "NOT_FOUND" &&
    err.status === 404;

  // Cross-tenant firm: NOT_FOUND, never CROSS_TENANT.
  await assert.rejects(
    computeObligationResponseFacts(obMainId, firmPrincipal(firmB)),
    isNotFound,
  );
  // Sibling client_user: NOT_FOUND, never CROSS_CLIENT.
  await assert.rejects(
    computeObligationResponseFacts(obMainId, clientPrincipal(firmA, siblingParty)),
    isNotFound,
  );
  // A missing id produces the exact same refusal.
  await assert.rejects(
    computeObligationResponseFacts(randomUUID(), admin),
    isNotFound,
  );
});

// ---------------------------------------------------------------------------
// The draft ladder
// ---------------------------------------------------------------------------

test("no gateway: the template answers with the notice's reference and due date", async () => {
  const draft = await draftObligationResponse(obMainId, admin, null);
  assert.equal(draft.source, "template");
  assert.equal(draft.obligationId, obMainId);
  assert.equal(draft.monthStart, MONTH);
  assert.equal(draft.monthLabel, monthLabel(MONTH));
  assert.ok(draft.letter.includes(REFERENCE), "the reference is stated");
  assert.ok(draft.letter.includes(lagosDateOffset(10)), "the due date is stated");
  assert.ok(draft.letter.includes(CLIENT_NAME), "the client is named");

  // Pointer-only audit: obligation id, month, source — nothing else.
  const events = await getDb()
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.entityType, "obligation"),
        eq(auditEventsTable.entityId, obMainId),
        eq(auditEventsTable.action, "obligation.response_draft"),
      ),
    );
  assert.ok(events.length >= 1);
  assert.deepEqual(events[events.length - 1].after, {
    month: MONTH,
    source: "template",
  });
});

test("a valid grounded letter is used, and the NOTICE travels fenced in the prompt", async () => {
  const calls: CompletionRequest[] = [];
  // Zero numerals: grounded by construction — the grounding pin below
  // exercises the invented-numeral direction separately.
  const LETTER =
    "We refer to the notice and enclose our client's records for the period; we will respond to the authority accordingly.";
  const draft = await draftObligationResponse(
    obMainId,
    admin,
    fakeGateway((req) => {
      calls.push(req);
      return JSON.stringify({ letter: LETTER });
    }),
  );
  assert.equal(draft.source, "clerk");
  assert.equal(draft.letter, LETTER);

  assert.equal(calls.length, 1);
  const user = String(calls[0].user);
  assert.ok(user.includes("-----BEGIN NOTICE-----"), "the notice is fenced");
  assert.ok(user.includes("-----END NOTICE-----"));
  assert.ok(
    user.includes(`Reference: ${REFERENCE}`),
    "the authority's reference rides inside the fence",
  );
  assert.ok(
    user.includes("Output VAT: NGN"),
    "the period figure lines ground the prompt",
  );
  assert.equal(calls[0].schemaName, "response_letter");
});

test("an invented numeral falls back to the template (grounding)", async () => {
  const draft = await draftObligationResponse(
    obMainId,
    admin,
    fakeGateway(() =>
      JSON.stringify({
        letter: "Our client accepts an adjusted assessment of NGN 31415926.53.",
      }),
    ),
  );
  assert.equal(draft.source, "template", "a numeral the facts never stated");
  assert.ok(draft.letter.includes(REFERENCE), "the template still answers");
});

test("an exhausted budget answers with the template before any provider touch", async () => {
  let called = false;
  const draft = await draftObligationResponse(
    brokeObId,
    brokeAdmin,
    fakeGateway(() => {
      called = true;
      return JSON.stringify({ letter: "must never be used" });
    }),
  );
  assert.equal(draft.source, "template");
  assert.equal(called, false, "no model call once the allowance is spent");
});

// ---------------------------------------------------------------------------
// The bundle PDF
// ---------------------------------------------------------------------------

// Compile-time pin: the renderer's input carries NO letter field — nothing a
// model ever phrased can reach this paper by construction. Adding one would
// turn this alias into a non-never type and fail the assignment.
const rendererInputHasNoLetterField: [
  Exclude<
    keyof ObligationResponsePdfInput,
    "obligation" | "pack" | "monthStart" | "theme"
  >,
] extends [never]
  ? true
  : never = true;
void rendererInputHasNoLetterField;

test("the bundle renders a real PDF, byte-identical across identical inputs", async () => {
  const facts = await computeObligationResponseFacts(obMainId, admin);
  const input = {
    obligation: facts.obligation,
    pack: facts.pack,
    monthStart: facts.monthStart,
    theme: null,
  };
  const first = await renderObligationResponsePdf(input);
  const second = await renderObligationResponsePdf(input);
  assert.equal(first.subarray(0, 5).toString(), "%PDF-");
  assert.ok(first.equals(second), "identical inputs render identical bytes");

  const text = await pdfText(first);
  assert.ok(text.includes(CLIENT_NAME), "the bundle names its client");
  assert.ok(text.includes(REFERENCE), "the cover is keyed to the reference");
  assert.ok(text.includes(`RP-INV-${SALT}`), "the register is enclosed");
  assert.ok(text.includes(monthLabel(MONTH)), "the period is named");
  assert.ok(!text.includes(SIBLING_NAME), "nothing of the sibling leaks");
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

test("a client_user (obligation.read only) is refused on both endpoints", async () => {
  const base = await listen(appFor(clientUser, obligationsRouter));
  const pack = await fetch(
    `${base}/obligation-response-pack?obligationId=${obMainId}`,
  );
  assert.equal(pack.status, 403, "firm work product — read alone must not pull it");
  const draft = await fetch(`${base}/obligations/${obMainId}/response-draft`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({}),
  });
  assert.equal(draft.status, 403);
});

test("the pack route ships application/pdf and audits pointer-only", async () => {
  const base = await listen(appFor(admin, obligationsRouter));
  const res = await fetch(
    `${base}/obligation-response-pack?obligationId=${obMainId}&month=${MONTH}`,
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  const disposition = res.headers.get("content-disposition") ?? "";
  assert.ok(
    disposition.includes("obligation-response-FIRS-ASMT"),
    "the filename carries the sanitized reference",
  );
  assert.ok(disposition.includes(MONTH.slice(0, 7)));
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body.subarray(0, 5).toString(), "%PDF-");

  const events = await getDb()
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.entityType, "obligation"),
        eq(auditEventsTable.entityId, obMainId),
        eq(auditEventsTable.action, "obligation.response_pack"),
      ),
    );
  assert.ok(events.length >= 1);
  assert.deepEqual(events[events.length - 1].after, { month: MONTH });

  // An off-list month is refused with the resolver's own error.
  const bad = await fetch(
    `${base}/obligation-response-pack?obligationId=${obMainId}&month=2019-01-01`,
  );
  assert.equal(bad.status, 400);
  const badBody = (await bad.json()) as { error: string };
  assert.match(badBody.error, /Lagos months/);

  // A foreign firm's obligation id 404s without disclosure.
  const foreign = await listen(appFor(firmPrincipal(firmB), obligationsRouter));
  const hidden = await fetch(
    `${foreign}/obligation-response-pack?obligationId=${obMainId}`,
  );
  assert.equal(hidden.status, 404);
});

test("the draft route answers the contract shape", async () => {
  const base = await listen(appFor(admin, obligationsRouter));
  const res = await fetch(`${base}/obligations/${obMainId}/response-draft`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ month: MONTH }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    obligationId: string;
    letter: string;
    source: string;
    monthStart: string;
    monthLabel: string;
  };
  assert.equal(body.obligationId, obMainId);
  assert.equal(body.monthStart, MONTH);
  assert.equal(body.monthLabel, monthLabel(MONTH));
  assert.ok(body.letter.length > 0, "a letter always answers");
  assert.ok(["clerk", "template"].includes(body.source));
});
