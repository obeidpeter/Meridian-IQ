import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  auditEventsTable,
  bankStatementsTable,
  billingTiersTable,
  consentRecordsTable,
  engagementsTable,
  firmSubscriptionsTable,
  firmsTable,
  invoiceLinesTable,
  invoicesTable,
  membershipsTable,
  partiesTable,
  usersTable,
} from "@workspace/db";
import auditRouter from "../../routes/audit.ts";
import type { Principal } from "../auth/rbac.ts";
import { DomainError } from "../errors.ts";
import { appendAudit } from "./audit.ts";
import { EXPORT_SECTION_ROW_CAP, exportFirmData } from "./firm-export.ts";
import {
  appFor,
  listen,
  closeAllServers,
} from "../../test-helpers/route-harness.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Full-firm portability export: every section scoped to THE firm (party
// sphere, firm-keyed rows, the audit ledger's firm_id column), row caps with
// visible truncation, secrets never leave (no password hashes / TOTP
// material), and the operator/auditor-only route that audits the export
// action itself.

const SALT = makeRunSalt();

const firmA = randomUUID();
const firmB = randomUUID();
const adminUser = randomUUID();
const clientPartyA = randomUUID(); // engaged by firmA
const buyerPartyA = randomUUID(); // in firmA's sphere via an invoice
const foreignParty = randomUUID(); // engaged by firmB only
const invoiceId = randomUUID();
const PASSWORD_HASH = `sekret-scrypt-${SALT}`;

const operator: Principal = {
  userId: randomUUID(),
  role: "operator",
  firmId: null,
  clientPartyId: null,
  buyerPartyId: null,
};
const auditor: Principal = { ...operator, userId: randomUUID(), role: "auditor" };
const firmAdmin: Principal = {
  userId: adminUser,
  role: "firm_admin",
  firmId: firmA,
  clientPartyId: null,
  buyerPartyId: null,
};

const router = auditRouter as express.Router;

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values([
    { id: firmA, name: `Export Firm A ${SALT}` },
    { id: firmB, name: `Export Firm B ${SALT}` },
  ]);
  await db
    .insert(usersTable)
    .values({
      id: adminUser,
      email: `export-admin-${SALT}@test.local`,
      fullName: `Export Admin ${SALT}`,
      passwordHash: PASSWORD_HASH,
    })
    .onConflictDoNothing();
  await db.insert(membershipsTable).values({
    userId: adminUser,
    firmId: firmA,
    role: "firm_admin",
  });
  await db.insert(partiesTable).values([
    { id: clientPartyA, type: "client_business", legalName: `Export Client ${SALT}` },
    { id: buyerPartyA, type: "buyer", legalName: `Export Buyer ${SALT}` },
    { id: foreignParty, type: "client_business", legalName: `Export Foreign ${SALT}` },
  ]);
  await db.insert(engagementsTable).values([
    { firmId: firmA, clientPartyId: clientPartyA, type: "retainer", title: `exp A ${SALT}` },
    { firmId: firmB, clientPartyId: foreignParty, type: "retainer", title: `exp B ${SALT}` },
  ]);
  await db.insert(invoicesTable).values({
    id: invoiceId,
    firmId: firmA,
    supplierPartyId: clientPartyA,
    buyerPartyId: buyerPartyA,
    invoiceNumber: `EXP-${SALT}-1`,
    issueDate: "2027-01-10",
    status: "draft",
    subtotal: "100000.00",
    grandTotal: "107500.00",
  });
  await db.insert(invoiceLinesTable).values([
    {
      invoiceId,
      lineNo: 1,
      description: `Consulting ${SALT}`,
      quantity: "1",
      unitPrice: "60000.00",
      lineExtension: "60000.00",
    },
    {
      invoiceId,
      lineNo: 2,
      description: `Support ${SALT}`,
      quantity: "1",
      unitPrice: "40000.00",
      lineExtension: "40000.00",
    },
  ]);
  await db.insert(bankStatementsTable).values({
    firmId: firmA,
    clientPartyId: clientPartyA,
    formatKey: "generic_csv",
    status: "committed",
    lineCount: 12,
    parsedCount: 11,
  });
  await db.insert(consentRecordsTable).values([
    {
      partyId: clientPartyA,
      layer: 1,
      action: "grant",
      scope: "compliance_submission",
      basis: "contract",
      channel: "test",
    },
    {
      partyId: foreignParty,
      layer: 1,
      action: "grant",
      scope: "compliance_submission",
      basis: "contract",
      channel: "test",
    },
  ]);
  // Subscription: reuse (or seed) the essential tier — tier keys are a unique
  // enum, so the row may already exist from seeds or other tests.
  await db
    .insert(billingTiersTable)
    .values({
      key: "essential",
      name: "Essential",
      monthlyPrice: "25000",
      includedInvoices: 50,
      overagePrice: "150",
      revenueSharePct: "0.1",
    })
    .onConflictDoNothing({ target: billingTiersTable.key });
  const [tier] = await db
    .select({ id: billingTiersTable.id })
    .from(billingTiersTable)
    .where(eq(billingTiersTable.key, "essential"))
    .limit(1);
  await db.insert(firmSubscriptionsTable).values({
    firmId: firmA,
    tierId: tier.id,
  });
  // One ledger event per firm: A's must ride, B's must stay out.
  await appendAudit({
    actorId: adminUser,
    firmId: firmA,
    action: `test.export-a-${SALT}`,
    entityType: "test",
    entityId: `a-${SALT}`,
  });
  await appendAudit({
    firmId: firmB,
    action: `test.export-b-${SALT}`,
    entityType: "test",
    entityId: `b-${SALT}`,
  });
});

after(async () => {
  await closeAllServers();
});

test("every section is populated and scoped to the firm; secrets never leave", async () => {
  const bundle = await exportFirmData(firmA);
  assert.equal(bundle.firmId, firmA);
  assert.ok(bundle.exportedAt);

  assert.equal(bundle.sections.firm.length, 1);
  assert.equal(bundle.sections.firm[0].id, firmA);

  assert.equal(bundle.sections.subscription.length, 1);
  assert.equal(bundle.sections.subscription[0].tierKey, "essential");

  const partyIds = bundle.sections.parties.map((p) => p.id);
  assert.ok(partyIds.includes(clientPartyA), "engaged party in the sphere");
  assert.ok(partyIds.includes(buyerPartyA), "invoice buyer in the sphere");
  assert.ok(!partyIds.includes(foreignParty), "another firm's client stays out");

  assert.equal(bundle.sections.engagements.length, 1);
  assert.equal(bundle.sections.invoices.length, 1);
  assert.equal(bundle.sections.invoices[0].id, invoiceId);
  assert.equal(bundle.sections.invoice_lines.length, 2);
  assert.equal(bundle.sections.statements.length, 1);
  assert.equal(
    bundle.sections.statements[0].lineCount,
    12,
    "statements ride as summary rows (line counts), not raw lines",
  );

  const consentParties = bundle.sections.consent_records.map((c) => c.partyId);
  assert.ok(consentParties.includes(clientPartyA));
  assert.ok(!consentParties.includes(foreignParty));

  assert.equal(bundle.sections.members.length, 1);
  const member = bundle.sections.members[0];
  assert.equal(member.email, `export-admin-${SALT}@test.local`);
  assert.equal(member.role, "firm_admin");
  assert.ok(!("passwordHash" in member), "no hash column in the members section");

  const auditActions = bundle.sections.audit_events.map((e) => e.action);
  assert.ok(auditActions.includes(`test.export-a-${SALT}`), "firm A's ledger rows ride");
  assert.ok(
    !auditActions.includes(`test.export-b-${SALT}`),
    "another firm's ledger rows are excluded",
  );

  // No secret material anywhere in the bundle, whatever the section.
  const serialized = JSON.stringify(bundle);
  assert.ok(!serialized.includes(PASSWORD_HASH), "password hash never leaves");

  // Counts mirror the sections, nothing truncated at the default cap.
  for (const count of bundle.counts) {
    assert.equal(count.rows, bundle.sections[count.section].length);
    assert.equal(count.truncated, false);
  }
  assert.ok(EXPORT_SECTION_ROW_CAP >= 10_000);
});

test("sections are capped with a visible truncation flag", async () => {
  const bundle = await exportFirmData(firmA, 1);
  assert.equal(bundle.sections.invoice_lines.length, 1, "capped at 1 row");
  const lineCount = bundle.counts.find((c) => c.section === "invoice_lines");
  assert.equal(lineCount?.rows, 1);
  assert.equal(lineCount?.truncated, true);
  const partyCount = bundle.counts.find((c) => c.section === "parties");
  assert.equal(partyCount?.truncated, true, "sphere has 2+ parties");
  const firmCount = bundle.counts.find((c) => c.section === "firm");
  assert.equal(firmCount?.truncated, false);
});

test("an unknown firm 404s", async () => {
  await assert.rejects(exportFirmData(randomUUID()), (err: unknown) => {
    assert.ok(err instanceof DomainError);
    assert.equal(err.status, 404);
    return true;
  });
});

test("route: operator and auditor export; firm principals are refused", async () => {
  const asAdmin = await listen(appFor(firmAdmin, router));
  const forbidden = await fetch(`${asAdmin}/firms/${firmA}/export`);
  assert.equal(forbidden.status, 403, "firm_admin lacks audit.export");

  const asOperator = await listen(appFor(operator, router));
  const missing = await fetch(`${asOperator}/firms/${randomUUID()}/export`);
  assert.equal(missing.status, 404, "unknown firm 404s");

  const ok = await fetch(`${asOperator}/firms/${firmA}/export`);
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as {
    firmId: string;
    sections: Record<string, Array<Record<string, unknown>>>;
    counts: Array<{ section: string }>;
  };
  assert.equal(body.firmId, firmA);
  assert.ok(body.sections.invoices.length >= 1);
  assert.ok(body.counts.length >= 8);

  // The export action itself is audited, pointer-only.
  const exportEvents = await getDb()
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.action, "audit.firm_export"),
        eq(auditEventsTable.firmId, firmA),
      ),
    );
  assert.ok(exportEvents.length >= 1);
  assert.equal(exportEvents[0].entityId, firmA);
  assert.equal(
    typeof (exportEvents[0].after as { sections?: unknown }).sections,
    "object",
    "the audit row carries section counts, never content",
  );

  const asAuditor = await listen(appFor(auditor, router));
  const auditorOk = await fetch(`${asAuditor}/firms/${firmA}/export`);
  assert.equal(auditorOk.status, 200, "the read-only auditor may export");
});
