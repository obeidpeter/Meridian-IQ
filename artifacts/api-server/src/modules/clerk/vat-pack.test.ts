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
//  - ISSUE-month basis: a document belongs to the month it was issued, and
//  counts only if it EVER cleared the rails (accepted attempt, any time);
//  - credit notes issued in the month are netted as offsets; cancelled
//  documents are excluded entirely;
//  - another firm's documents and other months never leak in;
//  - totals come from the SAME SQL pass, so TOTAL always equals the column;
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

  const accepted = new Date(`${MONTH.slice(0, 7)}-15T12:00:00Z`);

  const mk = async (over: {
    firmId?: string;
    supplier: string;
    n: string;
    issueDate: string;
    grand: string;
    vat: string;
    kind?: "invoice" | "credit_note";
    status?: string;
    accept?: boolean;
  }) => {
    const id = randomUUID();
    await db.insert(invoicesTable).values({
      id,
      firmId: over.firmId ?? firmA,
      supplierPartyId: over.supplier,
      buyerPartyId: buyer,
      invoiceNumber: over.n,
      issueDate: over.issueDate,
      kind: (over.kind ?? "invoice") as never,
      status: (over.status ?? (over.accept === false ? "draft" : "submitted")) as never,
      grandTotal: over.grand,
      vatTotal: over.vat,
    });
    if (over.accept !== false) {
      await db.insert(submissionAttemptsTable).values({
        invoiceId: id,
        rail: "rail_primary",
        attemptNo: 1,
        idempotencyKey: `vp-${over.n}`,
        status: "accepted",
        createdAt: accepted,
      });
    }
  };

  const inMonth = `${MONTH.slice(0, 7)}-05`;
  // Firm A, client A1: two accepted invoices issued in MONTH.
  await mk({ supplier: clientA1, n: `VP-A1a-${SALT}`, issueDate: inMonth, grand: "1075.00", vat: "75.00" });
  await mk({ supplier: clientA1, n: `VP-A1b-${SALT}`, issueDate: inMonth, grand: "2150.00", vat: "150.00" });
  // ...and an accepted CREDIT NOTE issued in MONTH — netted as an offset.
  await mk({ supplier: clientA1, n: `VP-A1cn-${SALT}`, issueDate: inMonth, grand: "430.00", vat: "30.00", kind: "credit_note", status: "stamped" });
  // ...and an accepted-then-CANCELLED invoice — void, excluded entirely.
  await mk({ supplier: clientA1, n: `VP-A1x-${SALT}`, issueDate: inMonth, grand: "9999.00", vat: "700.00", status: "cancelled" });
  // Firm A, client A2: one accepted issued in MONTH, one issued in an OLDER
  // month (accepted whenever) — the old issue month keeps it out.
  await mk({ supplier: clientA2, n: `VP-A2a-${SALT}`, issueDate: inMonth, grand: "500.00", vat: "34.88" });
  await mk({ supplier: clientA2, n: `VP-A2old-${SALT}`, issueDate: `${OLD_MONTH.slice(0, 7)}-05`, grand: "999.00", vat: "69.93" });
  // Firm A: a draft (never accepted) — unsubmitted paper is not evidence.
  await mk({ supplier: clientA1, n: `VP-A1d-${SALT}`, issueDate: inMonth, grand: "7777.00", vat: "543.00", accept: false });
  // Firm B: accepted in MONTH — must never appear in firm A's pack.
  await mk({ firmId: firmB, supplier: clientB, n: `VP-B-${SALT}`, issueDate: inMonth, grand: "888.00", vat: "62.16" });
});

test("closedLagosMonths offers only closed months, newest first", () => {
  const months = closedLagosMonths(12, new Date("2026-03-10T12:00:00Z"));
  assert.equal(months.length, 12);
  assert.equal(months[0], "2026-02-01", "the newest option is last month");
  assert.equal(months[11], "2025-03-01");
  for (const m of months) assert.match(m, /^\d{4}-\d{2}-01$/);
});

test("issue-month basis with credits netted and cancelled excluded", async () => {
  const pack = await computeVatPack(firmA, MONTH);
  assert.equal(pack.rows.length, 2, "two clients had accepted documents");
  const a1 = pack.rows.find((r) => r.clientPartyId === clientA1);
  const a2 = pack.rows.find((r) => r.clientPartyId === clientA2);
  assert.ok(a1 && a2);
  assert.equal(a1.acceptedCount, 2, "the cancelled invoice is void");
  assert.equal(a1.acceptedTotal, "3225.00");
  assert.equal(a1.acceptedVat, "225.00");
  assert.equal(a1.creditCount, 1);
  assert.equal(a1.creditVat, "30.00");
  assert.equal(a1.netVat, "195.00", "credits are netted");
  assert.equal(a2.acceptedCount, 1, "an older issue month is excluded");
  assert.equal(a2.creditCount, 0);
  assert.equal(a2.netVat, "34.88");
  // Totals come from the SAME SQL pass (GROUPING SETS) — exact by design.
  assert.equal(pack.totals.acceptedCount, 3);
  assert.equal(pack.totals.acceptedTotal, "3725.00");
  assert.equal(pack.totals.acceptedVat, "259.88");
  assert.equal(pack.totals.creditVat, "30.00");
  assert.equal(pack.totals.netVat, "229.88");
  // The disclosure names the basis and the correction blind spot.
  assert.ok(pack.note.includes("issue date"));
  assert.ok(pack.note.includes("not a return"));
  assert.ok(pack.note.includes("Corrections"));
  assert.ok(pack.months.includes(MONTH));
});

test("another firm's acceptances never leak into the pack", async () => {
  const packA = await computeVatPack(firmA, MONTH);
  assert.ok(!packA.rows.some((r) => r.clientPartyId === clientB));
  const packB = await computeVatPack(firmB, MONTH);
  assert.equal(packB.rows.length, 1);
  assert.equal(packB.rows[0].clientPartyId, clientB);
  assert.equal(packB.totals.netVat, "62.16");
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
