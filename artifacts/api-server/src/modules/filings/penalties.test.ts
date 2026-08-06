import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  engagementsTable,
  filingReturnsTable,
  firmsTable,
  partiesTable,
} from "@workspace/db";
import filingsRouter from "../../routes/filings.ts";
import {
  computeFilingPenaltyExposure,
  monthsLate,
} from "./penalties.ts";
import {
  appFor,
  listen,
  closeAllServers,
} from "../../test-helpers/route-harness.ts";
import {
  clientPrincipal,
  firmPrincipal,
} from "../../test-helpers/principals.ts";
import { lagosDateOffset, makeRunSalt } from "../../test-helpers/fixtures.ts";

// The late-filing EXPOSURE lane: overdue ANNUAL register rows priced by the
// closed statutory constants (CIT 25k + 5k/month, CAC 5k/year-in-default,
// PAYE annual 500k flat), monthly kinds and anything filed or not-yet-due
// excluded, the total summed FROM the rows, and the route's filing.read +
// SEC-03 narrowing. Frozen `today` injection keeps every figure exact; the
// route test sticks to the FLAT kind so live Lagos-today changes nothing.

const SALT = makeRunSalt();

const firmId = randomUUID();
const emptyFirmId = randomUUID();
const routeFirmId = randomUUID();
const clientX = randomUUID();
const clientY = randomUUID();
const routeClientA = randomUUID();
const routeClientB = randomUUID();

// The frozen Lagos today every module-level figure is computed against.
const TODAY = "2026-08-06";

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values([
    { id: firmId, name: `Penalty Firm ${SALT}` },
    { id: emptyFirmId, name: `Penalty Empty Firm ${SALT}` },
    { id: routeFirmId, name: `Penalty Route Firm ${SALT}` },
  ]);
  await db.insert(partiesTable).values(
    [clientX, clientY, routeClientA, routeClientB].map((id, i) => ({
      id,
      type: "client_business" as const,
      legalName: `Penalty Client ${i} ${SALT}`,
    })),
  );
  await db.insert(engagementsTable).values(
    [
      [firmId, clientX],
      [firmId, clientY],
      [routeFirmId, routeClientA],
      [routeFirmId, routeClientB],
    ].map(([firm, client], i) => ({
      firmId: firm,
      clientPartyId: client,
      type: "retainer" as const,
      status: "open" as const,
      title: `penalty ${i} ${SALT}`,
    })),
  );
  const row = (
    clientPartyId: string,
    taxType: string,
    period: string,
    dueDate: string,
    status: "upcoming" | "prepared" | "filed" = "upcoming",
    firm = firmId,
  ) => ({ firmId: firm, clientPartyId, taxType, period, dueDate, status });
  await db.insert(filingReturnsTable).values([
    // clientX, priced against TODAY 2026-08-06:
    // CIT one day late (due yesterday): first month — ₦25,000.
    row(clientX, "cit", "2025-12", "2026-08-05"),
    // CIT in its third month (due 2026-05-07: two whole months elapsed,
    // day-of-month 6 < 7 keeps the third from completing): 25k + 2×5k.
    row(clientX, "cit", "2024-12", "2026-05-07"),
    // CAC one day late: first year in default — ₦5,000.
    row(clientX, "cac_annual", "2026-06", "2026-08-05"),
    // CAC 14 months late: two years (or part-years) in default — ₦10,000.
    row(clientX, "cac_annual", "2025-06", "2025-06-30"),
    // PAYE annual: flat ₦500,000 however late. "prepared" still owes.
    row(clientX, "paye_annual", "2025-12", "2026-01-31", "prepared"),
    // Exclusions: due TODAY is not yet overdue (the register's `< today`
    // boundary)...
    row(clientX, "cit", "2023-12", TODAY),
    // ...a FILED annual row is off the clock however old...
    row(clientX, "paye_annual", "2024-12", "2025-01-31", "filed"),
    // ...and an overdue MONTHLY row is not this lane's business.
    row(clientX, "vat", "2026-01", "2026-02-21"),
    // clientY: one overdue CIT — the scoping fixture.
    row(clientY, "cit", "2025-12", "2026-08-05"),
    // Route firm (live Lagos today): the FLAT kind only, so the exposure is
    // deterministic whatever monthsLate the real clock produces.
    row(routeClientA, "paye_annual", "2096-12", lagosDateOffset(-40), "upcoming", routeFirmId),
    row(routeClientB, "paye_annual", "2096-12", lagosDateOffset(-10), "upcoming", routeFirmId),
  ]);
});

after(async () => {
  await closeAllServers();
});

test("monthsLate: a row one day late is in its FIRST month; whole calendar months add one each", () => {
  assert.equal(monthsLate("2026-06-30", "2026-07-01"), 1);
  // The current month is whole only once the day-of-month catches up.
  assert.equal(monthsLate("2026-06-30", "2026-07-29"), 1);
  assert.equal(monthsLate("2026-06-30", "2026-07-30"), 2);
  // Year carry.
  assert.equal(monthsLate("2025-06-30", "2026-08-06"), 14);
  assert.equal(monthsLate("2026-01-31", "2026-08-06"), 7);
});

test("each kind's schedule at the frozen clock, soonest due first, total summed from the rows", async () => {
  const exposure = await computeFilingPenaltyExposure(firmId, clientX, TODAY);
  // Due-date ascending — the longest-overdue clocks lead. (The two rows
  // sharing 2026-08-05 tiebreak on id, so the value pin below re-sorts by
  // kind to stay deterministic.)
  const dueDates = exposure.rows.map((r) => r.dueDate);
  assert.deepEqual(dueDates, [...dueDates].sort());
  assert.deepEqual(
    exposure.rows
      .map((r) => [r.taxType, r.period, r.dueDate, r.monthsLate, r.exposureNgn])
      .sort((a, b) => String(a[2]).localeCompare(String(b[2])) || String(a[0]).localeCompare(String(b[0]))),
    [
      ["cac_annual", "2025-06", "2025-06-30", 14, "10000.00"],
      ["paye_annual", "2025-12", "2026-01-31", 7, "500000.00"],
      ["cit", "2024-12", "2026-05-07", 3, "35000.00"],
      ["cac_annual", "2026-06", "2026-08-05", 1, "5000.00"],
      ["cit", "2025-12", "2026-08-05", 1, "25000.00"],
    ],
  );
  assert.equal(exposure.totalNgn, "575000.00");

  // Firm-wide adds clientY's first-month CIT.
  const firmWide = await computeFilingPenaltyExposure(firmId, undefined, TODAY);
  assert.equal(firmWide.rows.length, 6);
  assert.equal(firmWide.totalNgn, "600000.00");

  // The sibling pin: clientY alone.
  const forY = await computeFilingPenaltyExposure(firmId, clientY, TODAY);
  assert.deepEqual(
    forY.rows.map((r) => [r.taxType, r.exposureNgn]),
    [["cit", "25000.00"]],
  );
  assert.equal(forY.totalNgn, "25000.00");
});

test("an empty register answers zero, not silence", async () => {
  assert.deepEqual(
    await computeFilingPenaltyExposure(emptyFirmId, undefined, TODAY),
    { rows: [], totalNgn: "0.00" },
  );
});

test("route: filing.read, firm-wide for staff, SEC-03-pinned for a client_user", async () => {
  const firmBase = await listen(
    appFor(firmPrincipal(routeFirmId), filingsRouter),
  );
  const clientBase = await listen(
    appFor(clientPrincipal(routeFirmId, routeClientA), filingsRouter),
  );

  // Firm staff read the whole book: two flat employer-annual exposures.
  let res = await fetch(`${firmBase}/filing-penalty-exposure`);
  assert.equal(res.status, 200);
  const firmWide = (await res.json()) as {
    rows: { taxType: string; exposureNgn: string; dueDate: string }[];
    totalNgn: string;
  };
  assert.equal(firmWide.rows.length, 2);
  assert.ok(firmWide.rows.every((r) => r.taxType === "paye_annual"));
  assert.ok(firmWide.rows[0].dueDate < firmWide.rows[1].dueDate);
  assert.equal(firmWide.totalNgn, "1000000.00");

  // A client_user is pinned to its own party with no filter...
  res = await fetch(`${clientBase}/filing-penalty-exposure`);
  assert.equal(res.status, 200);
  const own = (await res.json()) as { rows: unknown[]; totalNgn: string };
  assert.equal(own.rows.length, 1);
  assert.equal(own.totalNgn, "500000.00");

  // ...and a sibling filter is rejected outright (CROSS_CLIENT).
  res = await fetch(
    `${clientBase}/filing-penalty-exposure?clientPartyId=${routeClientB}`,
  );
  assert.equal(res.status, 403);
});
