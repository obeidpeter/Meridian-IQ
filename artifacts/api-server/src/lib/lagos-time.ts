// Business-day boundaries in Nigeria's timezone (WAT, UTC+1).
//
// Statutory clocks — submission windows, VAT due dates, "is this invoice
// overdue today" — are day-granular questions about the LAGOS calendar, not
// UTC's: between midnight and 1am Lagos time, UTC still shows yesterday, so
// UTC-derived dates lag local statutory time by an hour and can flip a
// boundary day. Nigeria has never observed DST and WAT is a fixed +01:00, so
// the conversion is plain offset arithmetic — no tz database lookup needed in
// JS (SQL predicates that must match these semantics use
// `AT TIME ZONE 'Africa/Lagos'`, which resolves to the same fixed offset).

import { sql, type SQL } from "drizzle-orm";

const LAGOS_OFFSET_MS = 60 * 60 * 1000;

/**
 * SQL fragment: the Lagos calendar "today" as a date. The one expression every
 * statutory day predicate (overdue, due-soon, VAT 21st) must share — never
 * `current_date`, which is the UTC day and lags Lagos by an hour.
 */
export function lagosTodaySql(): SQL {
  return sql`(now() AT TIME ZONE 'Africa/Lagos')::date`;
}

/**
 * SQL fragment: `column` (a timestamptz) falls inside the Lagos calendar
 * window [start, start + interval). `start` is a local-calendar anchor like
 * "2026-06-01" (cast to a plain timestamp — Lagos wall time), `interval` any
 * Postgres interval literal ("1 month", "7 days"). Every module that buckets
 * events into Lagos calendar periods should build its predicate here so the
 * boundaries can never drift apart.
 */
export function lagosWindowSql(
  column: SQL,
  start: string,
  interval = "1 month",
): SQL {
  return sql`(${column} AT TIME ZONE 'Africa/Lagos' >= ${start}::timestamp
    AND ${column} AT TIME ZONE 'Africa/Lagos' < ${start}::timestamp + ${interval}::interval)`;
}

/** The Lagos calendar date (YYYY-MM-DD) of the given instant. */
export function lagosDateString(at: Date = new Date()): string {
  return new Date(at.getTime() + LAGOS_OFFSET_MS).toISOString().slice(0, 10);
}

/** The absolute instant of Lagos midnight on a YYYY-MM-DD calendar date. */
export function lagosMidnight(dateString: string): Date {
  return new Date(`${dateString}T00:00:00+01:00`);
}

/**
 * The absolute instant of Lagos midnight on a (year, monthIndex, day)
 * calendar date; month overflow carries into the year like Date.UTC.
 */
export function lagosMidnightFor(
  year: number,
  monthIndex: number,
  day: number,
): Date {
  return new Date(Date.UTC(year, monthIndex, day) - LAGOS_OFFSET_MS);
}

/** The Lagos calendar year/month of the given instant. */
export function lagosParts(at: Date = new Date()): {
  year: number;
  monthIndex: number;
} {
  const shifted = new Date(at.getTime() + LAGOS_OFFSET_MS);
  return { year: shifted.getUTCFullYear(), monthIndex: shifted.getUTCMonth() };
}
