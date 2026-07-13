import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  firmsTable,
  partiesTable,
  usersTable,
  engagementsTable,
} from "@workspace/db";
import engagementsRouter from "./engagements.ts";
import advisoryRouter from "./advisory.ts";
import smeRouter from "./sme.ts";
import type { Principal } from "../modules/auth/rbac.ts";
import { createDraft } from "../modules/invoice/service.ts";
import {
  appFor,
  listen,
  closeAllServers,
} from "../test-helpers/route-harness.ts";
import { makeRunSalt } from "../test-helpers/fixtures.ts";

// SEC-03 sub-tenant isolation for advisory surfaces: a client_user must see
// only its OWN client party's engagements, assessments and invoice
// escalations — never a sibling client's within the same firm (firm-keyed RLS
// is not a backstop). Regression for the audit's HIGH engagement-disclosure
// finding and the MEDIUM escalation finding.

const SALT = makeRunSalt();
const firmId = randomUUID();
const userStaff = randomUUID();
const userClientA = randomUUID();
const clientA = randomUUID();
const clientB = randomUUID();
const buyer = randomUUID();

const staff: Principal = {
  userId: userStaff,
  role: "firm_staff",
  firmId,
  clientPartyId: null,
  buyerPartyId: null,
};
const clientUserA: Principal = {
  userId: userClientA,
  role: "client_user",
  firmId,
  clientPartyId: clientA,
  buyerPartyId: null,
};

const ASSESSMENT_FINDINGS = {
  score: 72,
  band: "partial",
  gaps: [
    {
      questionId: "q1",
      section: "registration",
      prompt: "Are all buyer TINs validated?",
      severity: "high",
      note: "3 buyers missing TIN",
    },
  ],
  remediation: [
    {
      priority: 1,
      action: "Validate buyer TINs",
      rationale: "Stamping fails without a valid buyer TIN",
    },
  ],
  completedAt: "2026-06-01T00:00:00.000Z",
};

let engA = "";
let engB = "";
let clientBInvoiceId = "";

after(async () => {
  await closeAllServers();
});

before(async () => {
  const db = getDb();
  await db
    .insert(usersTable)
    .values([
      { id: userStaff, email: `eng-staff-${SALT}@test.local` },
      { id: userClientA, email: `eng-clientA-${SALT}@test.local` },
    ])
    .onConflictDoNothing();
  await db.insert(firmsTable).values({ id: firmId, name: `Eng Firm ${SALT}` });
  await db.insert(partiesTable).values([
    {
      id: clientA,
      type: "client_business",
      legalName: `Eng Client A ${SALT}`,
      tin: "10000000-0051",
      street: "1 Marina Rd",
      city: "Lagos",
    },
    {
      id: clientB,
      type: "client_business",
      legalName: `Eng Client B ${SALT}`,
      tin: "10000000-0052",
      street: "2 Marina Rd",
      city: "Lagos",
    },
    {
      id: buyer,
      type: "buyer",
      legalName: `Eng Buyer ${SALT}`,
      tin: "20000000-0051",
      street: "3 Broad St",
      city: "Lagos",
    },
  ]);
  const [rowA] = await db
    .insert(engagementsTable)
    .values({
      firmId,
      clientPartyId: clientA,
      type: "readiness_assessment",
      title: `A assessment ${SALT}`,
      findings: ASSESSMENT_FINDINGS,
    })
    .returning();
  const [rowB] = await db
    .insert(engagementsTable)
    .values({
      firmId,
      clientPartyId: clientB,
      type: "readiness_assessment",
      title: `B assessment ${SALT}`,
      findings: ASSESSMENT_FINDINGS,
    })
    .returning();
  engA = rowA.id;
  engB = rowB.id;

  const bundle = await createDraft(
    {
      firmId,
      supplierPartyId: clientB,
      buyerPartyId: buyer,
      invoiceNumber: `ENG-${SALT}`,
      issueDate: "2026-07-01",
      lines: [
        { description: "Goods", quantity: "1", unitPrice: "1000", vatRate: "0.075" },
      ],
    },
    userStaff,
  );
  clientBInvoiceId = bundle.invoice.id;
});

test("GET /engagements is SEC-03 scoped: a client sees only its own", async () => {
  const base = await listen(appFor(clientUserA, engagementsRouter));
  const rows = (await (await fetch(`${base}/engagements`)).json()) as {
    clientPartyId: string;
  }[];
  assert.ok(rows.length > 0);
  assert.ok(
    rows.every((r) => r.clientPartyId === clientA),
    "client_user must not see sibling-client engagements",
  );
});

test("firm staff see the whole firm's engagements", async () => {
  const base = await listen(appFor(staff, engagementsRouter));
  const rows = (await (await fetch(`${base}/engagements`)).json()) as {
    clientPartyId: string;
  }[];
  assert.ok(rows.some((r) => r.clientPartyId === clientA));
  assert.ok(rows.some((r) => r.clientPartyId === clientB));
});

test("GET /engagements/:id — own is 200, sibling is 403", async () => {
  const base = await listen(appFor(clientUserA, engagementsRouter));
  assert.equal((await fetch(`${base}/engagements/${engA}`)).status, 200);
  assert.equal((await fetch(`${base}/engagements/${engB}`)).status, 403);
});

test("GET /assessments/:id — sibling client's readiness findings are 403", async () => {
  const base = await listen(appFor(clientUserA, advisoryRouter));
  assert.equal((await fetch(`${base}/assessments/${engA}`)).status, 200);
  assert.equal((await fetch(`${base}/assessments/${engB}`)).status, 403);
});

test("GET /invoices/:id/escalations — sibling client's invoice is 403", async () => {
  const base = await listen(appFor(clientUserA, smeRouter));
  const res = await fetch(`${base}/invoices/${clientBInvoiceId}/escalations`);
  assert.equal(res.status, 403);
});
