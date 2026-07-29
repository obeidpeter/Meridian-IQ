import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  alertPreferencesTable,
  auditEventsTable,
  bankStatementsTable,
  consentRecordsTable,
  engagementsTable,
  escalationsTable,
  firmsTable,
  invoiceLinesTable,
  invoicesTable,
  membershipsTable,
  partiesTable,
  usersTable,
} from "@workspace/db";
import clientsRouter from "../../routes/clients.ts";
import type { Principal } from "../auth/rbac.ts";
import { appendAudit } from "./audit.ts";
import { exportClientData } from "./client-export.ts";
import {
  appFor,
  listen,
  closeAllServers,
} from "../../test-helpers/route-harness.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";
import { clientPrincipal, crossTenantPrincipal, firmPrincipal } from "../../test-helpers/principals.ts";

// GET /clients/{id}/export — data-subject export. Access: assertPartyAccess
// whole (client_user pinned to its OWN party per SEC-03; firm principals
// behind the engagement wall; cross-tenant read-only staff pass). Content:
// the tenant lens — a firm caller sees only ITS slice of the firm-keyed
// sections, while the data subject's own client_user and operators see the
// party's data across ALL engaging firms. Member rows carry identity + role
// only, never secrets.

const SALT = makeRunSalt();

const firmA = randomUUID();
const firmB = randomUUID();
const firmC = randomUUID(); // never engages the party
const partyP = randomUUID(); // the data subject
const partyQ = randomUUID(); // a sibling client of firm A
const buyerX = randomUUID();
const invoiceA = randomUUID(); // firm A's invoice, P as supplier
const invoiceB = randomUUID(); // firm B's invoice, P as supplier
const userPA = randomUUID(); // P's client_user under firm A
const userPB = randomUUID(); // P's client_user under firm B
const PASSWORD_HASH = `sekret-scrypt-${SALT}`;

const clientP: Principal = clientPrincipal(firmA, partyP, { userId: userPA });
const clientQ: Principal = clientPrincipal(firmA, partyQ);
const adminA: Principal = firmPrincipal(firmA);
const staffC: Principal = firmPrincipal(firmC, { role: "firm_staff" });
const operator: Principal = crossTenantPrincipal("operator");
const bankUser: Principal = crossTenantPrincipal("bank_user");

const ALL_SECTIONS = [
  "party",
  "engagements",
  "invoices",
  "invoice_lines",
  "statements",
  "consent_records",
  "members",
  "alert_preferences",
  "escalations",
  "audit_events",
];

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values([
    { id: firmA, name: `CX Firm A ${SALT}` },
    { id: firmB, name: `CX Firm B ${SALT}` },
    { id: firmC, name: `CX Firm C ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    {
      id: partyP,
      type: "client_business",
      legalName: `CX Subject ${SALT}`,
      tin: "10000001-0001",
    },
    { id: partyQ, type: "client_business", legalName: `CX Sibling ${SALT}` },
    { id: buyerX, type: "buyer", legalName: `CX Buyer ${SALT}` },
  ]);
  await db.insert(engagementsTable).values([
    { firmId: firmA, clientPartyId: partyP, type: "retainer", title: `CX A-P ${SALT}` },
    { firmId: firmB, clientPartyId: partyP, type: "retainer", title: `CX B-P ${SALT}` },
    { firmId: firmA, clientPartyId: partyQ, type: "retainer", title: `CX A-Q ${SALT}` },
  ]);
  await db.insert(invoicesTable).values([
    {
      id: invoiceA,
      firmId: firmA,
      supplierPartyId: partyP,
      buyerPartyId: buyerX,
      invoiceNumber: `CXA-${SALT}`,
      issueDate: "2027-02-01",
      status: "draft",
    },
    {
      id: invoiceB,
      firmId: firmB,
      supplierPartyId: partyP,
      buyerPartyId: buyerX,
      invoiceNumber: `CXB-${SALT}`,
      issueDate: "2027-02-02",
      status: "draft",
    },
  ]);
  await db.insert(invoiceLinesTable).values([
    {
      invoiceId: invoiceA,
      lineNo: 1,
      description: `CX line A ${SALT}`,
      quantity: "1",
      unitPrice: "1000.00",
      lineExtension: "1000.00",
    },
    {
      invoiceId: invoiceB,
      lineNo: 1,
      description: `CX line B ${SALT}`,
      quantity: "1",
      unitPrice: "2000.00",
      lineExtension: "2000.00",
    },
  ]);
  await db.insert(bankStatementsTable).values({
    firmId: firmA,
    clientPartyId: partyP,
    formatKey: "generic_csv",
    status: "committed",
    lineCount: 3,
    parsedCount: 3,
  });
  await db.insert(consentRecordsTable).values({
    partyId: partyP,
    layer: 1,
    action: "grant",
    scope: "compliance_submission",
    basis: "contract",
    channel: "test",
  });
  await db.insert(usersTable).values([
    {
      id: userPA,
      email: `cx-pa-${SALT}@test.local`,
      fullName: `CX PA ${SALT}`,
      passwordHash: PASSWORD_HASH,
    },
    {
      id: userPB,
      email: `cx-pb-${SALT}@test.local`,
      fullName: `CX PB ${SALT}`,
      passwordHash: PASSWORD_HASH,
    },
  ]);
  await db.insert(membershipsTable).values([
    { userId: userPA, firmId: firmA, role: "client_user", clientPartyId: partyP },
    { userId: userPB, firmId: firmB, role: "client_user", clientPartyId: partyP },
  ]);
  await db.insert(alertPreferencesTable).values({
    clientPartyId: partyP,
    whatsappTo: "+2348012345678",
    phone: "+2348012345678",
    email: `cx-alerts-${SALT}@test.local`,
    contactSetByRole: "client_user",
  });
  await db.insert(escalationsTable).values({
    invoiceId: invoiceA,
    firmId: firmA,
    clientPartyId: partyP,
    reason: `CX escalation ${SALT}`,
  });
  // Party-entity ledger rows for the lens test: one tenant-neutral (rides for
  // every caller) and one written under firm B's tenant (must stay out of
  // firm A's bundle).
  await appendAudit({
    action: `cx.neutral-${SALT}`,
    entityType: "party",
    entityId: partyP,
  });
  await appendAudit({
    firmId: firmB,
    action: `cx.firm-b-${SALT}`,
    entityType: "party",
    entityId: partyP,
  });
});

after(async () => {
  await closeAllServers();
});

test("SEC-03: a client_user cannot export a sibling client's bundle", async () => {
  const base = await listen(appFor(clientQ, clientsRouter));
  const res = await fetch(`${base}/clients/${partyP}/export`);
  assert.equal(res.status, 403, "CROSS_CLIENT — pinned to its own party");
});

test("engagement wall: a non-engaged firm is refused; roles without party.read are refused", async () => {
  const asStaffC = await listen(appFor(staffC, clientsRouter));
  const res = await fetch(`${asStaffC}/clients/${partyP}/export`);
  assert.equal(res.status, 403, "no engagement -> CROSS_TENANT");

  const asBank = await listen(appFor(bankUser, clientsRouter));
  const bankRes = await fetch(`${asBank}/clients/${partyP}/export`);
  assert.equal(bankRes.status, 403, "bank_user lacks party.read");
});

test("the data subject's own client_user gets the full cross-firm bundle, secrets redacted", async () => {
  const base = await listen(appFor(clientP, clientsRouter));
  const res = await fetch(`${base}/clients/${partyP}/export`);
  assert.equal(res.status, 200);
  const bundle = (await res.json()) as {
    partyId: string;
    firmId: string | null;
    sections: Record<string, Array<Record<string, unknown>>>;
    counts: Array<{ section: string; rows: number; truncated: boolean }>;
  };
  assert.equal(bundle.partyId, partyP);
  assert.equal(bundle.firmId, null, "the subject's view carries no tenant lens");
  assert.deepEqual(
    Object.keys(bundle.sections).sort(),
    [...ALL_SECTIONS].sort(),
    "every section is present",
  );
  assert.equal(bundle.sections.party[0].id, partyP);
  assert.equal(bundle.sections.engagements.length, 2, "both firms' engagements ride");
  assert.equal(bundle.sections.invoices.length, 2);
  assert.equal(bundle.sections.members.length, 2);
  assert.equal(bundle.sections.alert_preferences.length, 1);
  assert.equal(
    bundle.sections.alert_preferences[0].whatsappTo,
    "+2348012345678",
    "the subject's contact row is included — it IS their data",
  );
  assert.equal(bundle.sections.consent_records.length, 1);
  const member = bundle.sections.members[0];
  assert.ok(member.email, "identity rides");
  assert.ok(!("passwordHash" in member), "no hash column");
  assert.ok(
    !JSON.stringify(bundle).includes(PASSWORD_HASH),
    "no secret material anywhere in the bundle",
  );
  for (const count of bundle.counts) {
    assert.equal(count.rows, bundle.sections[count.section].length);
    assert.equal(count.truncated, false);
  }
});

test("a firm caller gets only its own tenant's slice of the firm-keyed sections", async () => {
  const base = await listen(appFor(adminA, clientsRouter));
  const res = await fetch(`${base}/clients/${partyP}/export`);
  assert.equal(res.status, 200);
  const bundle = (await res.json()) as {
    firmId: string | null;
    sections: Record<string, Array<Record<string, unknown>>>;
  };
  assert.equal(bundle.firmId, firmA);
  assert.equal(bundle.sections.engagements.length, 1, "only firm A's engagement");
  assert.equal(bundle.sections.engagements[0].firmId, firmA);
  assert.equal(bundle.sections.invoices.length, 1, "firm B's invoice stays out");
  assert.equal(bundle.sections.invoices[0].id, invoiceA);
  assert.equal(bundle.sections.invoice_lines.length, 1);
  assert.equal(bundle.sections.invoice_lines[0].invoiceId, invoiceA);
  assert.equal(bundle.sections.members.length, 1, "firm B's member identity stays out");
  assert.equal(bundle.sections.members[0].userId, userPA);
  assert.equal(bundle.sections.statements.length, 1);
  assert.equal(bundle.sections.escalations.length, 1);
  const actions = bundle.sections.audit_events.map((e) => e.action);
  assert.ok(
    actions.includes(`cx.neutral-${SALT}`),
    "tenant-neutral party events ride",
  );
  assert.ok(
    !actions.includes(`cx.firm-b-${SALT}`),
    "another tenant's party events stay out",
  );
});

test("operator sees the full bundle; the export itself is audited pointer-only", async () => {
  const base = await listen(appFor(operator, clientsRouter));
  const res = await fetch(`${base}/clients/${partyP}/export`);
  assert.equal(res.status, 200);
  const bundle = (await res.json()) as {
    firmId: string | null;
    sections: Record<string, Array<Record<string, unknown>>>;
  };
  assert.equal(bundle.firmId, null);
  assert.equal(bundle.sections.engagements.length, 2);
  const actions = bundle.sections.audit_events.map((e) => e.action);
  assert.ok(actions.includes(`cx.firm-b-${SALT}`), "no lens for cross-tenant staff");

  const exportEvents = await getDb()
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.action, "audit.client_export"),
        eq(auditEventsTable.entityId, partyP),
      ),
    );
  assert.ok(exportEvents.length >= 1, "the export action is audited");
  const afterPayload = exportEvents[0].after as {
    sections?: Record<string, number>;
  };
  assert.equal(typeof afterPayload.sections, "object", "counts, never content");
  assert.ok(
    !JSON.stringify(exportEvents).includes("+2348012345678"),
    "the audit rows carry no exported PII",
  );
});

test("unknown party 404s (operator); sections are capped with a visible truncation flag", async () => {
  const base = await listen(appFor(operator, clientsRouter));
  const missing = await fetch(`${base}/clients/${randomUUID()}/export`);
  assert.equal(missing.status, 404);

  const capped = await exportClientData(partyP, null, 1);
  assert.equal(capped.sections.engagements.length, 1, "capped at 1 row");
  const engagementCount = capped.counts.find((c) => c.section === "engagements");
  assert.equal(engagementCount?.rows, 1);
  assert.equal(engagementCount?.truncated, true);
  const partyCount = capped.counts.find((c) => c.section === "party");
  assert.equal(partyCount?.truncated, false);
});
