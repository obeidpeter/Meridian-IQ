import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  consentRecordsTable,
  engagementsTable,
  filingReturnsTable,
  firmsTable,
  invoicesTable,
  messagesTable,
  partiesTable,
  submissionAttemptsTable,
  usersTable,
} from "@workspace/db";
import compliancePackRouter from "../../routes/compliance-pack.ts";
import { computeCompliancePack } from "./compliance-pack.ts";
import { computeVatPosition } from "./vat-position.ts";
import { renderCompliancePackPdf } from "./pack-pdf.ts";
import { draftPackCoverNote, templatePackNote } from "../clerk/pack-note.ts";
import { lagosMonthStart, monthLabel } from "../clerk/client-statement.ts";
import { lagosDateString } from "../../lib/lagos-time.ts";
import {
  fakeGateway,
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "../clerk/test-support.ts";
import type { Principal } from "../auth/rbac.ts";
import {
  appFor,
  listen,
  closeAllServers,
  JSON_HEADERS,
} from "../../test-helpers/route-harness.ts";
import { lagosDateOffset, makeRunSalt } from "../../test-helpers/fixtures.ts";
import { clientPrincipal, firmPrincipal } from "../../test-helpers/principals.ts";

// Monthly client compliance pack (contract 0.45.0). Pinned here:
//  - the facts object: month-filtered register (sibling and other-month
//    documents excluded), receivables/payables snapshots present, and a VAT
//    section that IS computeVatPosition for the same inputs;
//  - the cover note answers with the deterministic template when no gateway
//    exists, and phrases via the "draft_pack_note" purpose when one does;
//  - the route ships a real application/pdf attachment, refuses an off-list
//    month with BAD_MONTH, and PINS a client_user to its own pack (SEC-03 —
//    naming a sibling returns the caller's OWN paper, never the sibling's);
//  - notify: 202 always; without a layer-1 grant NOTHING lands in the
//    messages ledger (CORE-03 inside fanOutAlert), with one a row appears.

const SALT = makeRunSalt();
const firmA = randomUUID();
const clientParty = randomUUID(); // engaged — the pack's subject
const siblingParty = randomUUID(); // engaged — the SEC-03 probe
const buyerParty = randomUUID(); // ordinary buyer (register counterparty)
const vendorParty = randomUUID(); // NOT engaged — the bill's supplier
const adminId = randomUUID();

const MONTH = lagosMonthStart(0); // the current Lagos month — the default

const admin: Principal = firmPrincipal(firmA, { userId: adminId });
const clientUser: Principal = clientPrincipal(firmA, clientParty);

const CLIENT_NAME = `Pack Client ${SALT}`;
const SIBLING_NAME = `Pack Sibling ${SALT}`;

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

async function packMessages() {
  return getDb()
    .select()
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.recipientPartyId, clientParty),
        eq(messagesTable.templateKey, "compliance_pack_ready"),
      ),
    );
}

before(async () => {
  await saveAndEnableClerkFlag();
  const db = getDb();
  await db
    .insert(usersTable)
    .values({ id: adminId, email: `pack-${SALT}@test.local` })
    .onConflictDoNothing();
  await db.insert(firmsTable).values({ id: firmA, name: `Pack Firm ${SALT}` });
  await db.insert(partiesTable).values([
    { id: clientParty, type: "client_business", legalName: CLIENT_NAME },
    { id: siblingParty, type: "client_business", legalName: SIBLING_NAME },
    { id: buyerParty, type: "buyer", legalName: `Pack Buyer ${SALT}` },
    { id: vendorParty, type: "buyer", legalName: `Pack Vendor ${SALT}` },
  ]);
  await db.insert(engagementsTable).values([
    { firmId: firmA, clientPartyId: clientParty, type: "retainer", title: `pack A ${SALT}` },
    { firmId: firmA, clientPartyId: siblingParty, type: "retainer", title: `pack B ${SALT}` },
  ]);

  const stampedId = randomUUID();
  const creditId = randomUUID();
  await db.insert(invoicesTable).values([
    // Rails-accepted invoice IN the month: register + output VAT + receivable.
    {
      id: stampedId,
      firmId: firmA,
      supplierPartyId: clientParty,
      buyerPartyId: buyerParty,
      invoiceNumber: `CP-INV-${SALT}`,
      status: "stamped",
      issueDate: `${MONTH.slice(0, 7)}-05`,
      subtotal: "1000.00",
      vatTotal: "75.00",
      grandTotal: "1075.00",
    },
    // Rails-accepted credit note IN the month: register + nets output VAT.
    {
      id: creditId,
      firmId: firmA,
      supplierPartyId: clientParty,
      buyerPartyId: buyerParty,
      kind: "credit_note",
      invoiceNumber: `CP-CN-${SALT}`,
      status: "stamped",
      issueDate: `${MONTH.slice(0, 7)}-12`,
      subtotal: "100.00",
      vatTotal: "7.50",
      grandTotal: "107.50",
    },
    // Unsubmitted draft IN the month: register + the deadline backlog count.
    {
      firmId: firmA,
      supplierPartyId: clientParty,
      buyerPartyId: buyerParty,
      invoiceNumber: `CP-DRAFT-${SALT}`,
      status: "draft",
      issueDate: `${MONTH.slice(0, 7)}-15`,
      subtotal: "200.00",
      vatTotal: "15.00",
      grandTotal: "215.00",
    },
    // Issued two months back: OUT of the register (month filtering) — stamped
    // without an attempt so it never touches VAT or the backlog either.
    {
      firmId: firmA,
      supplierPartyId: clientParty,
      buyerPartyId: buyerParty,
      invoiceNumber: `CP-OLD-${SALT}`,
      status: "stamped",
      issueDate: `${lagosMonthStart(2).slice(0, 7)}-10`,
      subtotal: "500.00",
      vatTotal: "0.00",
      grandTotal: "500.00",
    },
    // The sibling's own paper IN the month: must never enter this pack.
    {
      firmId: firmA,
      supplierPartyId: siblingParty,
      buyerPartyId: buyerParty,
      invoiceNumber: `CP-SIB-${SALT}`,
      status: "draft",
      issueDate: `${MONTH.slice(0, 7)}-08`,
      subtotal: "300.00",
      vatTotal: "22.50",
      grandTotal: "322.50",
    },
    // A captured supplier BILL (buyer = client, supplier not engaged): the
    // payables snapshot and the input side of the VAT position.
    {
      firmId: firmA,
      supplierPartyId: vendorParty,
      buyerPartyId: clientParty,
      invoiceNumber: `CP-BILL-${SALT}`,
      status: "draft",
      issueDate: `${MONTH.slice(0, 7)}-03`,
      dueDate: lagosDateString(new Date(Date.now() + 5 * 24 * 60 * 60 * 1000)),
      subtotal: "500.00",
      vatTotal: "40.00",
      grandTotal: "540.00",
    },
  ]);
  await db.insert(submissionAttemptsTable).values([
    {
      invoiceId: stampedId,
      rail: "rail_primary",
      attemptNo: 1,
      idempotencyKey: `pack-inv-${SALT}`,
      status: "accepted",
    },
    {
      invoiceId: creditId,
      rail: "rail_primary",
      attemptNo: 1,
      idempotencyKey: `pack-cn-${SALT}`,
      status: "accepted",
    },
  ]);
  // One unfiled statutory return on the client's register (Filing Desk): due
  // inside the due-soon window, so the pack's filings section has a row and
  // exact counts. The far-past period keeps the natural key clear of any
  // sweep-minted rows.
  await db.insert(filingReturnsTable).values({
    firmId: firmA,
    clientPartyId: clientParty,
    taxType: "vat",
    period: "2097-05",
    dueDate: lagosDateOffset(3),
    status: "upcoming",
  });
});

after(async () => {
  await restoreClerkFlag();
  await closeAllServers();
});

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

test("the pack computes register, snapshots, VAT and deadlines for one client month", async () => {
  const facts = await computeCompliancePack(firmA, clientParty, MONTH);
  assert.equal(facts.clientName, CLIENT_NAME);
  assert.equal(facts.firmName, `Pack Firm ${SALT}`);
  assert.equal(facts.monthLabel, monthLabel(MONTH));
  assert.equal(facts.months[0], MONTH, "the live current month is requestable");

  // Register: the month's three documents in issue order — the other-month
  // invoice and the sibling's paper are out.
  assert.deepEqual(
    facts.register.rows.map((r) => r.invoiceNumber),
    [`CP-INV-${SALT}`, `CP-CN-${SALT}`, `CP-DRAFT-${SALT}`],
  );
  assert.equal(facts.register.truncated, false);
  const [inv] = facts.register.rows;
  assert.equal(inv.kind, "invoice");
  assert.equal(inv.status, "stamped");
  assert.equal(inv.counterparty, `Pack Buyer ${SALT}`);
  assert.equal(inv.currency, "NGN");
  assert.equal(inv.grandTotal, "1075.00");
  assert.equal(facts.register.rows[1].kind, "credit_note");

  // Receivables snapshot: both outstanding invoices (this month's stamped one
  // and the old one), whatever aging buckets they land in today.
  const recv = facts.receivables.groups.find((g) => g.currency === "NGN");
  assert.ok(recv, "an NGN receivables group exists");
  assert.equal(recv.invoiceCount, 2);
  assert.equal(recv.outstandingTotal, "1575.00");

  // Payables snapshot: the one unpaid bill, with its supplier on top.
  assert.equal(facts.payables.groups.length, 1);
  assert.deepEqual(facts.payables.groups[0].total, {
    amount: "540.00",
    count: 1,
  });
  assert.equal(facts.payables.topSuppliers[0]?.supplierName, `Pack Vendor ${SALT}`);

  // The VAT section IS computeVatPosition for the same inputs.
  assert.deepEqual(facts.vat, await computeVatPosition(firmA, clientParty, MONTH));
  assert.equal(facts.vat.outputVat, "67.50", "credit note netted");
  assert.equal(facts.vat.inputVat, "40.00");
  assert.equal(facts.vat.defensibleNetVat, "67.50", "no verified input yet");

  // Deadlines: the draft is the whole backlog (the bill is not a receivable),
  // and the next VAT return is a future Lagos 21st.
  assert.equal(facts.deadlines.unsubmittedReceivables, 1);
  assert.match(facts.deadlines.nextVatReturnDue, /^\d{4}-\d{2}-21$/);
  assert.ok(facts.deadlines.nextVatReturnDue > lagosDateString());

  // Statutory returns (Filing Desk): the seeded unfiled row, counted by the
  // filings module's single fact function and sampled soonest-due-first.
  assert.equal(facts.filings.unfiled, 1);
  assert.equal(facts.filings.dueSoon, 1);
  assert.equal(facts.filings.overdue, 0);
  assert.equal(facts.filings.nextDueDate, lagosDateOffset(3));
  assert.deepEqual(facts.filings.rows, [
    {
      taxType: "vat",
      period: "2097-05",
      dueDate: lagosDateOffset(3),
      status: "upcoming",
    },
  ]);
});

// ---------------------------------------------------------------------------
// Cover note
// ---------------------------------------------------------------------------

test("the cover note is the deterministic template without a gateway, phrased with one", async () => {
  const templated = await draftPackCoverNote(firmA, clientParty, MONTH, null);
  assert.equal(templated.source, "template");
  assert.ok(templated.note.length > 0, "the template is always sendable");
  assert.ok(templated.note.includes(monthLabel(MONTH)));
  assert.ok(templated.note.includes(CLIENT_NAME));
  assert.ok(
    templated.disclosure.includes("preparation aid"),
    "the VAT basis disclosure rides along",
  );
  // The template equals the exported builder over the same facts.
  const facts = await computeCompliancePack(firmA, clientParty, MONTH);
  assert.equal(templated.note, templatePackNote(facts));

  const phrased = await draftPackCoverNote(
    firmA,
    clientParty,
    MONTH,
    fakeGateway(() => JSON.stringify({ note: `Phrased pack note ${SALT}` })),
  );
  assert.equal(phrased.source, "clerk");
  assert.equal(phrased.note, `Phrased pack note ${SALT}`);

  const invalid = await draftPackCoverNote(
    firmA,
    clientParty,
    MONTH,
    fakeGateway(() => "not json"),
  );
  assert.equal(invalid.source, "template", "invalid output falls back");
});

// ---------------------------------------------------------------------------
// PDF + route
// ---------------------------------------------------------------------------

test("the renderer produces a real PDF and the route ships it as an attachment", async () => {
  const facts = await computeCompliancePack(firmA, clientParty, MONTH);
  const buf = await renderCompliancePackPdf({
    facts,
    coverNote: templatePackNote(facts),
    theme: null,
  });
  assert.equal(buf.subarray(0, 5).toString(), "%PDF-");

  const base = await listen(appFor(admin, compliancePackRouter));
  const res = await fetch(`${base}/compliance-pack?clientPartyId=${clientParty}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.equal(
    res.headers.get("content-disposition"),
    `attachment; filename="compliance-pack-${MONTH.slice(0, 7)}.pdf"`,
  );
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body.subarray(0, 5).toString(), "%PDF-");
  const text = await pdfText(body);
  assert.ok(text.includes(CLIENT_NAME), "the pack names its client");
  assert.ok(text.includes(`CP-INV-${SALT}`), "the register is in the paper");
  assert.ok(text.includes(monthLabel(MONTH)));
  // The Filing Desk section rides the same paper: the heading plus the
  // seeded row's hand-rolled labels.
  assert.ok(text.includes("STATUTORY RETURNS"), "the filings section renders");
  assert.ok(text.includes("VAT return"), "the seeded row's kind label");
  assert.ok(text.includes("May 2097"), "the seeded row's period label");
});

test("an off-list month is refused with BAD_MONTH", async () => {
  const base = await listen(appFor(admin, compliancePackRouter));
  const res = await fetch(
    `${base}/compliance-pack?clientPartyId=${clientParty}&month=2019-01-01`,
  );
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /Lagos months/);
});

test("SEC-03: a client principal naming a sibling still pulls only its OWN pack", async () => {
  const base = await listen(appFor(clientUser, compliancePackRouter));
  // resolveClientAnalyticsScope PINS a client_user to its own party — the
  // sibling id in the query is ignored, never honoured.
  const res = await fetch(`${base}/compliance-pack?clientPartyId=${siblingParty}`);
  assert.equal(res.status, 200);
  const text = await pdfText(Buffer.from(await res.arrayBuffer()));
  assert.ok(text.includes(CLIENT_NAME), "the caller's own client name");
  assert.ok(!text.includes(SIBLING_NAME), "nothing of the sibling leaks");
  assert.ok(!text.includes(`CP-SIB-${SALT}`), "no sibling register rows");
});

// ---------------------------------------------------------------------------
// Notify: consent-gated fan-out, 202 either way
// ---------------------------------------------------------------------------

test("notify answers 202 but writes nothing without a layer-1 grant; a grant lights the rail", async () => {
  const base = await listen(appFor(admin, compliancePackRouter));

  // An off-list month is refused before anything fans out.
  const bad = await fetch(`${base}/compliance-pack/notify`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ clientPartyId: clientParty, month: "2019-01-01" }),
  });
  assert.equal(bad.status, 400);

  // No consent record exists for the party: CORE-03 inside fanOutAlert
  // suppresses every channel — and the route still answers 202
  // (indistinguishable by design, never a consent oracle).
  const silent = await fetch(`${base}/compliance-pack/notify`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ clientPartyId: clientParty }),
  });
  assert.equal(silent.status, 202);
  assert.equal((await packMessages()).length, 0, "no consent, no messages row");

  // A layer-1 grant (the reminders.test.ts arrangement) opens the purpose.
  await getDb().insert(consentRecordsTable).values({
    partyId: clientParty,
    layer: 1,
    action: "grant",
    scope: "compliance",
    basis: "contract",
    channel: "test",
  });
  const sent = await fetch(`${base}/compliance-pack/notify`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ clientPartyId: clientParty, month: MONTH }),
  });
  assert.equal(sent.status, 202);
  const msgs = await packMessages();
  // No prefs row: table defaults — whatsapp + email on, sms off (explicit
  // smsDefaultWhenNoPrefs: false), push skipped for want of devices.
  assert.deepEqual(msgs.map((m) => m.channel).sort(), ["email", "whatsapp"]);
  assert.ok(msgs.every((m) => m.entityType === "compliance_pack"));
  assert.ok(
    msgs.every((m) => m.entityId === `pack-${clientParty.replace(/[^a-z]/gi, "").slice(0, 6)}`),
    "pointer-only entity ref (SEC-12)",
  );
});
