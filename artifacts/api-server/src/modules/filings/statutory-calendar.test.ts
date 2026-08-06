import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANNUAL_KINDS,
  cacAnnualPeriodAndDue,
  citPeriodAndDue,
  FILING_KINDS,
  filingDueDate,
  payeAnnualPeriodAndDue,
  periodMonthBounds,
  previousLagosPeriod,
} from "./statutory-calendar.ts";

// Pure calendar math: the period a firm files for right now (last CLOSED
// Lagos month, with the year carry and the Lagos-vs-UTC boundary hour) and
// each kind's due day in the month after the period (with the December →
// January carry). No DB.

test("FILING_KINDS is the closed set with the statutory due days", () => {
  assert.deepEqual(
    FILING_KINDS.map((k) => [k.taxType, k.dueDayOfFollowingMonth]),
    [
      ["vat", 21],
      ["paye", 10],
      // WHT Desk: remit by the 21st of the following month (FIRS).
      ["wht", 21],
    ],
  );
});

test("previousLagosPeriod: the last closed Lagos month", () => {
  // Mid-August (Lagos and UTC agree) files July.
  assert.equal(
    previousLagosPeriod(new Date("2026-08-06T12:00:00Z")),
    "2026-07",
  );
  // January carries the year back: December of the previous year.
  assert.equal(
    previousLagosPeriod(new Date("2026-01-15T10:00:00Z")),
    "2025-12",
  );
  // The boundary hour: 23:30 UTC on Dec 31 is ALREADY Jan 1 in Lagos
  // (UTC+1), so the closed month is December — a UTC-derived date would
  // still say November's successor is open and hand back November.
  assert.equal(
    previousLagosPeriod(new Date("2025-12-31T23:30:00Z")),
    "2025-12",
  );
  // One minute before the Lagos year turns, December is still open.
  assert.equal(
    previousLagosPeriod(new Date("2025-12-31T22:59:00Z")),
    "2025-11",
  );
});

test("filingDueDate: each kind's day in the month AFTER the period", () => {
  assert.equal(filingDueDate("2026-07", "vat"), "2026-08-21");
  assert.equal(filingDueDate("2026-07", "paye"), "2026-08-10");
  assert.equal(filingDueDate("2026-07", "wht"), "2026-08-21");
});

test("filingDueDate: a December period carries into January of the next year", () => {
  assert.equal(filingDueDate("2026-12", "vat"), "2027-01-21");
  assert.equal(filingDueDate("2026-12", "paye"), "2027-01-10");
  assert.equal(filingDueDate("2026-12", "wht"), "2027-01-21");
});

test("periodMonthBounds: the half-open month window, December carrying the year", () => {
  assert.deepEqual(periodMonthBounds("2026-07"), {
    start: "2026-07-01",
    end: "2026-08-01",
  });
  assert.deepEqual(periodMonthBounds("2026-12"), {
    start: "2026-12-01",
    end: "2027-01-01",
  });
});

// --- The annual layer (Compliance Profile round) ---

test("ANNUAL_KINDS is the closed annual set, disjoint from FILING_KINDS", () => {
  assert.deepEqual(ANNUAL_KINDS, ["cit", "cac_annual", "paye_annual"]);
  const monthly = new Set<string>(FILING_KINDS.map((k) => k.taxType));
  assert.ok(ANNUAL_KINDS.every((k) => !monthly.has(k)));
});

test("citPeriodAndDue: latest CLOSED financial year, due six months after FYE", () => {
  // FYE December, seen from August 2026: December 2026 has not closed, so
  // the latest closed FY ended December 2025 — due June 30 of the NEXT year
  // (the year carry through Date.UTC's day-0 trick).
  assert.deepEqual(citPeriodAndDue(12, new Date("2026-08-06T12:00:00Z")), {
    period: "2025-12",
    dueDate: "2026-06-30",
  });
  // DURING the FYE month itself the year is still open — strictly-before.
  assert.deepEqual(citPeriodAndDue(12, new Date("2026-12-15T12:00:00Z")), {
    period: "2025-12",
    dueDate: "2026-06-30",
  });
  // The month after the FYE closes it.
  assert.deepEqual(citPeriodAndDue(12, new Date("2027-01-15T12:00:00Z")), {
    period: "2026-12",
    dueDate: "2027-06-30",
  });
  // FYE August: due the end of February — non-leap 28...
  assert.deepEqual(citPeriodAndDue(8, new Date("2026-09-15T12:00:00Z")), {
    period: "2026-08",
    dueDate: "2027-02-28",
  });
  // ...and leap 29 (2028).
  assert.deepEqual(citPeriodAndDue(8, new Date("2027-09-15T12:00:00Z")), {
    period: "2027-08",
    dueDate: "2028-02-29",
  });
  // FYE August seen from August (its own month): last CLOSED year is the
  // previous one.
  assert.deepEqual(citPeriodAndDue(8, new Date("2026-08-06T12:00:00Z")), {
    period: "2025-08",
    dueDate: "2026-02-28",
  });
  // The Lagos boundary hour: 23:30 UTC on Dec 31 is already January in
  // Lagos, so December 2026 has JUST closed.
  assert.deepEqual(citPeriodAndDue(12, new Date("2026-12-31T23:30:00Z")), {
    period: "2026-12",
    dueDate: "2027-06-30",
  });
});

test("cacAnnualPeriodAndDue: owed for the current Lagos year, never the incorporation year", () => {
  const now = new Date("2026-08-06T12:00:00Z");
  // Incorporated in an earlier year: this year's return is owed (the CAMA
  // small-company simplification — period Y-06, due June 30).
  assert.deepEqual(cacAnnualPeriodAndDue("2020-03-15", now), {
    period: "2026-06",
    dueDate: "2026-06-30",
  });
  // The last day of the previous year still counts as "before Jan 1".
  assert.deepEqual(cacAnnualPeriodAndDue("2025-12-31", now), {
    period: "2026-06",
    dueDate: "2026-06-30",
  });
  // Incorporated THIS year (Jan 1 inclusive): no return owed yet.
  assert.equal(cacAnnualPeriodAndDue("2026-01-01", now), null);
  assert.equal(cacAnnualPeriodAndDue("2026-07-30", now), null);
  // The Lagos boundary hour: 23:30 UTC on Dec 31 2025 is already 2026 in
  // Lagos, so a 2025 incorporation now owes the 2026 return.
  assert.deepEqual(
    cacAnnualPeriodAndDue("2025-06-01", new Date("2025-12-31T23:30:00Z")),
    { period: "2026-06", dueDate: "2026-06-30" },
  );
});

test("payeAnnualPeriodAndDue: the preceding Lagos year, due January 31", () => {
  assert.deepEqual(payeAnnualPeriodAndDue(new Date("2026-08-06T12:00:00Z")), {
    period: "2025-12",
    dueDate: "2026-01-31",
  });
  // Early January still files the year that JUST closed.
  assert.deepEqual(payeAnnualPeriodAndDue(new Date("2026-01-15T10:00:00Z")), {
    period: "2025-12",
    dueDate: "2026-01-31",
  });
  // The Lagos boundary hour carries the year forward an hour before UTC.
  assert.deepEqual(payeAnnualPeriodAndDue(new Date("2025-12-31T23:30:00Z")), {
    period: "2025-12",
    dueDate: "2026-01-31",
  });
});
