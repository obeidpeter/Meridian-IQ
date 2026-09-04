import assert from "node:assert/strict";
import { test } from "node:test";
import { databaseTimestampIso } from "./database-timestamp.ts";

test("database timestamps normalize mapped Dates and raw PostgreSQL strings", () => {
  const expected = "2026-09-04T12:34:56.123Z";
  for (const value of [
    new Date(expected),
    expected,
    "2026-09-04 12:34:56.123456+00",
    "2026-09-04 13:34:56.123456+01",
    "2026-09-04 18:04:56.123456+05:30",
    "2026-09-04T09:04:56.123456-0330",
  ])
    assert.equal(databaseTimestampIso(value), expected);
});

test("normalization handles whole seconds, leap days and timezone date boundaries", () => {
  assert.equal(
    databaseTimestampIso("2024-02-29 23:30:00-01"),
    "2024-03-01T00:30:00.000Z",
  );
  assert.equal(
    databaseTimestampIso("2026-09-04 00:00:00+01"),
    "2026-09-03T23:00:00.000Z",
  );
  const date = new Date("2026-09-04T12:00:00Z");
  const before = date.getTime();
  databaseTimestampIso(date);
  assert.equal(
    date.getTime(),
    before,
    "mapped Date instances must not be mutated",
  );
});

test("invalid, missing and timezone-ambiguous timestamps fail instead of fabricating dates", () => {
  for (const value of [
    null,
    undefined,
    0,
    true,
    {},
    [],
    new Date(Number.NaN),
    "",
    "infinity",
    "-infinity",
    "2026-09-04",
    "2026-09-04 12:34:56",
    "2026-02-30 12:34:56+00",
    "2026-09-04 24:34:56+00",
    "2026-09-04 12:34:56+99:99",
  ])
    assert.throws(
      () => databaseTimestampIso(value),
      /Invalid database timestamp/,
    );
});
