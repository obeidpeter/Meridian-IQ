import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import { eq, sql } from "drizzle-orm";
import {
  getDb,
  firmsTable,
  partiesTable,
  engagementsTable,
  usersTable,
  invoicesTable,
  bankStatementsTable,
  bankStatementLinesTable,
  matchProposalsTable,
  auditEventsTable,
} from "@workspace/db";
import invoicesRouter from "./invoices.ts";
import smeRouter from "./sme.ts";
import { errorHandler } from "../middleware/error.ts";
import type { Principal } from "../modules/auth/rbac.ts";
import { bulkAcceptProposals } from "../modules/statements/bulk-accept.ts";

// CSV exports (invoice book, receivables aging) and reconciliation
// bulk-accept. Same harness/salting conventions as scale.test.ts.

const SALT = `${Date.now().toString(36)}${process.pid}`;

const firmId = randomUUID();
const userId = randomUUID();
const supplier = randomUUID();
const supplierB = randomUUID(); // sibling client (SEC-03)
const buyer = randomUUID();

const staff: Principal = {
  userId,
  role: "firm_staff",
  firmId,
  clientPartyId: null,
  buyerPartyId: null,
};
const clientUserA: Principal = {
  userId,
  role: "client_user",
  firmId,
  clientPartyId: supplier,
  buyerPartyId: null,
};

function appFor(principal: Principal, router: express.Router) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.principal = principal;
    req.log = {
      warn: () => {},
      error: () => {},
      info: () => {},
    } as unknown as typeof req.log;
    next();
  });
  app.use(router);
  app.use(errorHandler);
  return app;
}

const closers: Array<() => Promise<void>> = [];
async function listen(app: express.Express): Promise<string> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  closers.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  );
  return `http://127.0.0.1:${port}`;
}
after(async () => {
  for (const close of closers) await close();
});

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

// Invoices: one outstanding (stamped, 45 days past due -> 31-60 bucket), one
// settled (excluded from receivables), one draft (excluded), plus a sibling
// client's invoice (SEC-03 must keep it out of the client's export).
const invStamped = randomUUID();
const invSettled = randomUUID();
const invDraft = randomUUID();
const invSibling = randomUUID();

before(async () => {
  const db = getDb();
  await db
    .insert(usersTable)
    .values({ id: userId, email: `xbulk-${SALT}@test.local` })
    .onConflictDoNothing();
  await db.insert(firmsTable).values({ id: firmId, name: `Export Firm ${SALT}` });
  await db.insert(partiesTable).values([
    { id: supplier, type: "client_business", legalName: `Export Supplier ${SALT}` },
    { id: supplierB, type: "client_business", legalName: `Export Sibling ${SALT}` },
    { id: buyer, type: "buyer", legalName: `Comma, Buyer "${SALT}"` },
  ]);
  await db.insert(engagementsTable).values([
    { firmId, clientPartyId: supplier, type: "readiness_assessment", title: "x A" },
    { firmId, clientPartyId: supplierB, type: "readiness_assessment", title: "x B" },
  ]);
  await db.insert(invoicesTable).values([
    {
      id: invStamped,
      firmId,
      supplierPartyId: supplier,
      buyerPartyId: buyer,
      invoiceNumber: `EXP-${SALT}-1`,
      issueDate: daysAgo(120),
      dueDate: daysAgo(45),
      status: "stamped",
      grandTotal: "250.00",
      subtotal: "250.00",
    },
    {
      id: invSettled,
      firmId,
      supplierPartyId: supplier,
      buyerPartyId: buyer,
      invoiceNumber: `EXP-${SALT}-2`,
      issueDate: daysAgo(120),
      dueDate: daysAgo(45),
      status: "settled",
      grandTotal: "400.00",
      subtotal: "400.00",
    },
    {
      id: invDraft,
      firmId,
      supplierPartyId: supplier,
      buyerPartyId: buyer,
      invoiceNumber: `EXP-${SALT}-3`,
      issueDate: daysAgo(10),
      dueDate: null,
      status: "draft",
      grandTotal: "100.00",
      subtotal: "100.00",
    },
    {
      id: invSibling,
      firmId,
      supplierPartyId: supplierB,
      buyerPartyId: buyer,
      invoiceNumber: `EXP-${SALT}-B1`,
      issueDate: daysAgo(10),
      dueDate: null,
      status: "stamped",
      grandTotal: "900.00",
      subtotal: "900.00",
    },
  ]);
});

// ---------------------------------------------------------------------------
// CSV exports
// ---------------------------------------------------------------------------

test("invoice CSV export honours scope and search, and quotes cells", async () => {
  const base = await listen(appFor(staff, invoicesRouter as express.Router));
  const res = await fetch(`${base}/invoices/export?q=${SALT}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/csv/);
  assert.match(
    res.headers.get("content-disposition") ?? "",
    /attachment; filename="invoices-/,
  );
  const csv = await res.text();
  assert.ok(csv.includes(`EXP-${SALT}-1`));
  assert.ok(csv.includes(`EXP-${SALT}-B1`), "staff export spans the firm");
  // RFC-4180: the buyer name's comma and quotes survive round-tripping.
  assert.ok(csv.includes(`"Comma, Buyer ""${SALT}"""`));

  // A client_user's export is confined to its own invoices (SEC-03).
  const clientBase = await listen(
    appFor(clientUserA, invoicesRouter as express.Router),
  );
  const clientCsv = await (
    await fetch(`${clientBase}/invoices/export?q=${SALT}`)
  ).text();
  assert.ok(clientCsv.includes(`EXP-${SALT}-1`));
  assert.ok(
    !clientCsv.includes(`EXP-${SALT}-B1`),
    "sibling client's invoice must never leave the server",
  );
});

test("receivables CSV exports outstanding rows only, with aging", async () => {
  const base = await listen(appFor(staff, smeRouter as express.Router));
  const res = await fetch(
    `${base}/dashboard/receivables/export?clientPartyId=${supplier}`,
  );
  assert.equal(res.status, 200);
  const csv = await res.text();
  const lines = csv.trim().split("\r\n");
  assert.match(lines[0], /invoiceNumber,buyer,issueDate,dueDate,ageDays,bucket/);
  const dataLines = lines.slice(1).filter((l) => l.includes(SALT));
  assert.equal(dataLines.length, 1, "only the outstanding invoice exports");
  assert.ok(dataLines[0].includes(`EXP-${SALT}-1`));
  assert.ok(dataLines[0].includes("31-60"), "45 days past due lands in 31-60");
  assert.ok(!csv.includes(`EXP-${SALT}-2`), "settled invoices are excluded");
  assert.ok(!csv.includes(`EXP-${SALT}-3`), "drafts are excluded");
});

// ---------------------------------------------------------------------------
// Reconciliation bulk-accept
// ---------------------------------------------------------------------------

test("bulk-accept settles high-confidence matches, dedupes lines, reports conflicts", async () => {
  const db = getDb();
  // Three more stamped invoices to settle against.
  const invA = randomUUID();
  const invB = randomUUID();
  const invC = randomUUID();
  await db.insert(invoicesTable).values(
    [invA, invB, invC].map((id, i) => ({
      id,
      firmId,
      supplierPartyId: supplier,
      buyerPartyId: buyer,
      invoiceNumber: `REC-${SALT}-${i}`,
      issueDate: daysAgo(30),
      dueDate: null,
      status: "stamped" as const,
      grandTotal: "500.00",
      subtotal: "500.00",
    })),
  );

  const [statement] = await db
    .insert(bankStatementsTable)
    .values({
      firmId,
      clientPartyId: supplier,
      formatKey: "gtb_csv",
      filename: `bulk-${SALT}.csv`,
      lineCount: 4,
      parsedCount: 4,
    })
    .returning();
  const lines = await db
    .insert(bankStatementLinesTable)
    .values(
      [1, 2, 3, 4].map((n) => ({
        statementId: statement.id,
        lineNo: n,
        valueDate: daysAgo(5),
        amount: "500.00",
        direction: "credit" as const,
        narration: `transfer ${SALT} ${n}`,
        parseStatus: "parsed" as const,
        rawLine: `raw ${n}`,
      })),
    )
    .returning();

  await db.insert(matchProposalsTable).values([
    // Line 1: two proposals for the same line — only the best is attempted,
    // its sibling is superseded by the accept, never a failure row.
    { firmId, statementLineId: lines[0].id, invoiceId: invA, confidence: "0.9500", status: "proposed" },
    { firmId, statementLineId: lines[0].id, invoiceId: invB, confidence: "0.9000", status: "proposed" },
    // Line 2: high confidence, distinct invoice — accepted.
    { firmId, statementLineId: lines[1].id, invoiceId: invB, confidence: "0.9100", status: "proposed" },
    // Line 3: BELOW threshold — untouched, left for the human.
    { firmId, statementLineId: lines[2].id, invoiceId: invC, confidence: "0.6000", status: "proposed" },
    // Line 4: high confidence but points at the SAME invoice as line 2 — the
    // second acceptance must fail (invoice already settled) and be reported.
    { firmId, statementLineId: lines[3].id, invoiceId: invB, confidence: "0.8800", status: "proposed" },
  ]);

  const result = await bulkAcceptProposals(statement.id, {
    userId,
    role: "firm_staff",
  });

  assert.equal(result.total, 3, "best-per-line above threshold: lines 1, 2, 4");
  assert.equal(result.acceptedCount, 2, "lines 1 and 2 settle invA and invB");
  assert.equal(result.failedCount, 1, "line 4 conflicts on the settled invB");
  const failed = result.rows.find((r) => r.outcome === "failed");
  assert.ok(failed?.error, "the conflict carries its reason");

  const statusOf = async (id: string) =>
    (
      await db
        .select({ status: invoicesTable.status })
        .from(invoicesTable)
        .where(eq(invoicesTable.id, id))
    )[0]!.status;
  assert.equal(await statusOf(invA), "settled");
  assert.equal(await statusOf(invB), "settled");
  assert.equal(await statusOf(invC), "stamped", "below-threshold match left alone");

  // Line 1's weaker sibling was superseded by the accept, not failed.
  const proposals = await db
    .select({ status: matchProposalsTable.status })
    .from(matchProposalsTable)
    .where(eq(matchProposalsTable.statementLineId, lines[0].id));
  assert.deepEqual(
    proposals.map((p) => p.status).sort(),
    ["accepted", "superseded"],
  );

  // The batch is audited with its tallies.
  const [auditRow] = await db
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.action, "reconciliation.bulk_accept"))
    .orderBy(sql`${auditEventsTable.seq} DESC`)
    .limit(1);
  assert.ok(auditRow);

  // A second run re-reports the conflict and settles nothing new: the
  // failed proposal stays `proposed` on purpose — a credit matching an
  // already-settled invoice may be a duplicate payment, which deserves a
  // human decision (reject it), not silent auto-dismissal by a batch.
  const again = await bulkAcceptProposals(statement.id, {
    userId,
    role: "firm_staff",
  });
  assert.equal(again.total, 1);
  assert.equal(again.acceptedCount, 0);
  assert.equal(again.failedCount, 1);
});
