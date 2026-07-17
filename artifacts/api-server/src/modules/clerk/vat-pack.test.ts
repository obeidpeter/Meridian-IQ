import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  firmsTable,
  partiesTable,
  invoicesTable,
  submissionAttemptsTable,
} from "@workspace/db";
import { closedLagosMonths, computeVatPack } from "./vat-pack.ts";
import { lagosMonthStart } from "./client-statement.ts";
import { budgetPace } from "./budget.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Monthly VAT filing pack (idea #2) + budget pace (idea #7). Pinned:
//  - the pack's numbers come from rails-ACCEPTED invoices in the Lagos month,
//  grouped per client — same predicate as the per-client statements;
//  - another firm's acceptances and other months never leak in;
//  - closedLagosMonths offers only CLOSED months;
//  - budgetPace mirrors the enforcement month and bands deterministically.

const SALT = makeRunSalt();
const firmA = randomUUID();
const firmB = randomUUID();
const clientA1 = randomUUID();
const clientA2 = randomUUID();
const clientB = randomUUID();
const buyer = randomUUID();

const MONTH = lagosMonthStart(1);
const OLD_MONTH = lagosMonthStart(3);

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values([
    { id: firmA, name: `VAT Firm A ${SALT}` },
    { id: firmB, name: `VAT Firm B ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    { id: clientA1, type: "client_business", legalName: `VAT Client A1 ${SALT}` },
    { id: clientA2, type: "client_business", legalName: `VAT Client A2 ${SALT}` },
    { id: clientB, type: "client_business", legalName: `VAT Client B ${SALT}` },
    { id: buyer, type: "buyer", legalName: `VAT Buyer ${SALT}` },
  ]);

  const inMonth = new Date(`${MONTH.slice(0, 7)}-15T12:00:00Z`);
  const inOldMonth = new Date(`${OLD_MONTH.slice(0, 7)}-15T12:00:00Z`);

  const mk = async (
    firmId: string,
    supplier: string,
    n: string,
    grand: string,
    vat: string,
    acceptedAt: Date | null,
  ) => {
    const id = randomUUID();
    await db.insert(invoicesTable).values({
      id,
      firmId,
      supplierPartyId: supplier,
      buyerPartyId: buyer,
      invoiceNumber: n,
      issueDate: `${MONTH.slice(0, 7)}-05`,
      status: acceptedAt ? "submitted" : "draft",
      grandTotal: grand,
      vatTotal: vat,
    });
    if (acceptedAt) {
      await db.insert(submissionAttemptsTable).values({
        invoiceId: id,
        rail: "rail_primary",
        attemptNo: 1,
        idempotencyKey: `vp-${n}`,
        status: "accepted",
        createdAt: acceptedAt,
      });
    }
  };

  // Firm A, client A1: two accepted in MONTH.
  await mk(firmA, clientA1, `VP-A1a-${SALT}`, "1075.00", "75.00", inMonth);
  await mk(firmA, clientA1, `VP-A1b-${SALT}`, "2150.00", "150.00", inMonth);
  // Firm A, client A2: one accepted in MONTH, one in an OLDER month.
  await mk(firmA, clientA2, `VP-A2a-${SALT}`, "500.00", "34.88", inMonth);
  await mk(firmA, clientA2, `VP-A2old-${SALT}`, "999.00", "69.93", inOldMonth);
  // Firm A: a draft (never accepted) — must not count.
  await mk(firmA, clientA1, `VP-A1d-${SALT}`, "7777.00", "543.00", null);
  // Firm B: accepted in MONTH — must never appear in firm A's pack.
  await mk(firmB, clientB, `VP-B-${SALT}`, "888.00", "62.16", inMonth);
});

test("closedLagosMonths offers only closed months, newest first", () => {
  const months = closedLagosMonths(12, new Date("2026-03-10T12:00:00Z"));
  assert.equal(months.length, 12);
  assert.equal(months[0], "2026-02-01", "the newest option is last month");
  assert.equal(months[11], "2025-03-01");
  for (const m of months) assert.match(m, /^\d{4}-\d{2}-01$/);
});

test("the pack groups rails-accepted invoices per client for the month", async () => {
  const pack = await computeVatPack(firmA, MONTH);
  assert.equal(pack.rows.length, 2, "two clients had acceptances");
  const a1 = pack.rows.find((r) => r.clientPartyId === clientA1);
  const a2 = pack.rows.find((r) => r.clientPartyId === clientA2);
  assert.ok(a1 && a2);
  assert.equal(a1.acceptedCount, 2);
  assert.equal(a1.acceptedTotal, "3225.00");
  assert.equal(a1.acceptedVat, "225.00");
  assert.equal(a2.acceptedCount, 1, "the older month's acceptance is excluded");
  assert.equal(a2.acceptedVat, "34.88");
  // Rows are name-ordered; totals are the column sums.
  assert.equal(pack.totals.acceptedCount, 3);
  assert.equal(pack.totals.acceptedTotal, "3725.00");
  assert.equal(pack.totals.acceptedVat, "259.88");
  assert.ok(pack.note.includes(pack.monthLabel));
  assert.ok(pack.months.includes(MONTH));
});

test("another firm's acceptances never leak into the pack", async () => {
  const packA = await computeVatPack(firmA, MONTH);
  assert.ok(!packA.rows.some((r) => r.clientPartyId === clientB));
  const packB = await computeVatPack(firmB, MONTH);
  assert.equal(packB.rows.length, 1);
  assert.equal(packB.rows[0].clientPartyId, clientB);
  assert.equal(packB.totals.acceptedVat, "62.16");
});

// ---- Budget pace (idea #7) --------------------------------------------------

test("budgetPace bands mirror the enforcement month deterministically", () => {
  const monthStart = new Date(Date.UTC(2026, 5, 1)); // June 2026 (30 days)
  const mid = new Date(Date.UTC(2026, 5, 16)); // half elapsed
  const usage = (usedTokens: number, budgetTokens = 1_000_000) => ({
    monthStart,
    usedTokens,
    budgetTokens,
  });

  // Comfortable pace: half the month, well under half the budget.
  assert.equal(budgetPace(usage(300_000), mid).paceBand, "ok");
  // 80% used is a warning wherever the month stands.
  assert.equal(
    budgetPace(usage(800_000), new Date(Date.UTC(2026, 5, 2))).paceBand,
    "warning",
  );
  // Projection: half the month gone, 60% spent → projects to 120% → warning.
  const projected = budgetPace(usage(600_000), mid);
  assert.equal(projected.paceBand, "warning");
  assert.equal(projected.projectedTokens, 1_200_000);
  // Early-month noise floor: day 2 at high burn but <80% used stays ok —
  // the projection only counts after a quarter of the month.
  assert.equal(
    budgetPace(usage(200_000), new Date(Date.UTC(2026, 5, 2))).paceBand,
    "ok",
  );
  // Spent (or a zero budget) is critical.
  assert.equal(budgetPace(usage(1_000_000), mid).paceBand, "critical");
  assert.equal(budgetPace(usage(0, 0), mid).paceBand, "critical");
});
