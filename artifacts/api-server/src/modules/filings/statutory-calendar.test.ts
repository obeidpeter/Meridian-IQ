import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FILING_KINDS,
  filingDueDate,
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
