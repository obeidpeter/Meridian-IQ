import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import {
  getDb,
  firmsTable,
  partiesTable,
  engagementsTable,
  invoicesTable,
  usersTable,
} from "@workspace/db";
import dashboardRouter from "./dashboard.ts";
import type { Principal } from "../../modules/auth/rbac.ts";
import {
  appFor,
  listen,
  closeAllServers,
} from "../../test-helpers/route-harness.ts";
import { makeRunSalt, daysAgo } from "../../test-helpers/fixtures.ts";
import { firmPrincipal } from "../../test-helpers/principals.ts";

// Bounded reads (R98): the dashboard summary and the compliance calendar no
// longer load the client's invoice book into JS. The counts and totals come
// from one SQL aggregate and the deadline list from the unsubmitted subset,
// so this pins that the aggregate says exactly what the fold used to say —
// including the overdue / due-soon submission counts that the SQL twins of
// submissionDeadline() must agree with.

const SALT = makeRunSalt();

after(async () => {
  await closeAllServers();
});

const firmId = randomUUID();
const userId = randomUUID();
const client = randomUUID();
const buyer = randomUUID();
const staff: Principal = firmPrincipal(firmId, { userId, role: "firm_staff" });

type Row = { num: string; status: string; issued: string; total: string };
const ROWS: Row[] = [
  {
    num: `DASH-${SALT}-D1`,
    status: "draft",
    issued: daysAgo(20),
    total: "100.00",
  }, // overdue
  {
    num: `DASH-${SALT}-D2`,
    status: "validated",
    issued: daysAgo(0),
    total: "50.00",
  }, // upcoming
  {
    num: `DASH-${SALT}-D3`,
    status: "draft",
    issued: daysAgo(5),
    total: "25.00",
  }, // due soon
  {
    num: `DASH-${SALT}-S1`,
    status: "submitted",
    issued: daysAgo(10),
    total: "200.00",
  },
  {
    num: `DASH-${SALT}-T1`,
    status: "stamped",
    issued: daysAgo(10),
    total: "300.00",
  },
  {
    num: `DASH-${SALT}-T2`,
    status: "confirmed",
    issued: daysAgo(10),
    total: "400.00",
  },
  {
    num: `DASH-${SALT}-T3`,
    status: "settled",
    issued: daysAgo(10),
    total: "100.00",
  },
  {
    num: `DASH-${SALT}-F1`,
    status: "failed",
    issued: daysAgo(10),
    total: "10.00",
  },
  {
    num: `DASH-${SALT}-C1`,
    status: "cancelled",
    issued: daysAgo(10),
    total: "5.00",
  },
];
const ids = new Map<string, string>();
const idOf = (num: string): string | null => ids.get(num) ?? null;

before(async () => {
  const db = getDb();
  await db
    .insert(usersTable)
    .values({ id: userId, email: `dash-${SALT}@test.local` })
    .onConflictDoNothing();
  await db.insert(firmsTable).values({ id: firmId, name: `Dash Firm ${SALT}` });
  await db.insert(partiesTable).values([
    { id: client, type: "client_business", legalName: `Dash Client ${SALT}` },
    { id: buyer, type: "buyer", legalName: `Dash Buyer ${SALT}` },
  ]);
  await db.insert(engagementsTable).values({
    firmId,
    clientPartyId: client,
    type: "readiness_assessment",
    title: `dash ${SALT}`,
  });
  const base = Date.now() - 60_000;
  for (const [i, row] of ROWS.entries()) {
    const id = randomUUID();
    ids.set(row.num, id);
    await db.insert(invoicesTable).values({
      id,
      firmId,
      supplierPartyId: client,
      buyerPartyId: buyer,
      invoiceNumber: row.num,
      issueDate: row.issued,
      dueDate: daysAgo(-30),
      status: row.status as never,
      grandTotal: row.total,
      subtotal: row.total,
      createdAt: new Date(base + i * 1000),
    });
  }
});

test("the summary's counts and totals are the SQL fold of the book", async () => {
  const base = await listen(appFor(staff, dashboardRouter as express.Router));
  const res = await fetch(`${base}/dashboard/summary?clientPartyId=${client}`);
  assert.equal(res.status, 200);
  const s = (await res.json()) as Record<string, unknown> & {
    recentActivity: { invoiceNumber: string | null; at: string }[];
    nextDeadline: { kind: string; invoiceId: string | null } | null;
  };
  assert.equal(s.totalInvoices, 9);
  assert.equal(s.draftCount, 3);
  assert.equal(s.unsubmittedCount, 3);
  assert.equal(s.unsubmittedValue, "175.00");
  assert.equal(s.pendingCount, 1);
  assert.equal(s.stampedCount, 3);
  assert.equal(s.stampedValue, "800.00");
  assert.equal(s.failedCount, 1);
  assert.equal(s.cancelledCount, 1);
  // One overdue submission (D1) + one failed invoice.
  assert.equal(s.atRiskCount, 2);
  assert.equal(s.penaltyRisk, "high");
  // The most overdue submission is the next deadline.
  assert.equal(s.nextDeadline?.kind, "penalty_watch");
  assert.equal(s.nextDeadline?.invoiceId, idOf(`DASH-${SALT}-D1`));
  // Activity is the newest eight invoices, newest first — never the book.
  assert.equal(s.recentActivity.length, 8);
  assert.equal(s.recentActivity[0].invoiceNumber, `DASH-${SALT}-C1`);
  for (let i = 1; i < s.recentActivity.length; i++) {
    assert.ok(
      new Date(s.recentActivity[i - 1].at) >= new Date(s.recentActivity[i].at),
    );
  }
});

test("the calendar carries one deadline per unsubmitted invoice and agrees with the summary", async () => {
  const base = await listen(appFor(staff, dashboardRouter as express.Router));
  const deadlines = (await (
    await fetch(`${base}/compliance/calendar?clientPartyId=${client}`)
  ).json()) as {
    kind: string;
    status: string;
    invoiceId: string | null;
    dueDate: string;
  }[];
  const byInvoice = new Map(
    deadlines.filter((d) => d.invoiceId).map((d) => [d.invoiceId, d]),
  );
  assert.equal(byInvoice.size, 3, "exactly the three unsubmitted invoices");
  assert.equal(byInvoice.get(idOf(`DASH-${SALT}-D1`))?.kind, "penalty_watch");
  assert.equal(byInvoice.get(idOf(`DASH-${SALT}-D1`))?.status, "overdue");
  assert.equal(
    byInvoice.get(idOf(`DASH-${SALT}-D2`))?.kind,
    "invoice_submission",
  );
  assert.equal(byInvoice.get(idOf(`DASH-${SALT}-D2`))?.status, "upcoming");
  assert.equal(
    byInvoice.get(idOf(`DASH-${SALT}-D3`))?.kind,
    "invoice_submission",
  );
  assert.equal(byInvoice.get(idOf(`DASH-${SALT}-D3`))?.status, "due_soon");
  for (let i = 1; i < deadlines.length; i++) {
    assert.ok(
      deadlines[i - 1].dueDate <= deadlines[i].dueDate,
      "sorted by due date",
    );
  }
  // The summary's upcoming count is the aggregate's unsubmitted count plus the
  // non-invoice deadlines — the same number the calendar lists.
  const summary = (await (
    await fetch(`${base}/dashboard/summary?clientPartyId=${client}`)
  ).json()) as { upcomingDeadlineCount: number };
  assert.equal(summary.upcomingDeadlineCount, deadlines.length);
});
