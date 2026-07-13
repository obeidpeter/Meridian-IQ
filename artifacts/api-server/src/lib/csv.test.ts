import { test } from "node:test";
import assert from "node:assert/strict";
import { toCsv, parseCsv } from "./csv.ts";

// serializeCell must (a) round-trip through RFC-4180 quoting and (b) neutralize
// spreadsheet formula injection (CWE-1236) on export.

test("plain values pass through and round-trip (minus the leading BOM)", () => {
  const csv = toCsv(["a", "b"], [["1", "hello"]]);
  assert.match(csv, /1,hello/);
  // toCsv prepends a UTF-8 BOM so Excel reads it correctly; strip it before
  // the round-trip comparison.
  const parsed = parseCsv(csv.replace(/^﻿/, ""));
  assert.deepEqual(parsed, [
    ["a", "b"],
    ["1", "hello"],
  ]);
});

test("cells with commas/quotes/newlines are RFC-4180 quoted", () => {
  const csv = toCsv(["x"], [['a,b'], ['he said "hi"'], ["line\nbreak"]]);
  assert.match(csv, /"a,b"/);
  assert.match(csv, /"he said ""hi"""/);
  assert.match(csv, /"line\nbreak"/);
});

test("formula-leading cells are prefixed with an apostrophe", () => {
  // Each of the four Excel formula triggers, plus tab and CR lead-ins.
  const payloads = [
    "=HYPERLINK(\"http://evil\")",
    "+1+1",
    "-2+3",
    "@SUM(A1)",
    "\t=cmd",
    "\r=cmd",
  ];
  for (const p of payloads) {
    const csv = toCsv(["v"], [[p]]);
    // The data row is the second line; it must start the cell with a quote so
    // the spreadsheet treats it as literal text, not a formula.
    const dataLine = csv.split("\r\n")[1];
    assert.ok(
      dataLine.includes(`'${p.replace(/"/g, '""')}`) ||
        dataLine.includes(`"'${p.replace(/"/g, '""')}`),
      `payload ${JSON.stringify(p)} was not neutralized: ${JSON.stringify(dataLine)}`,
    );
    // And it must NOT begin the cell value with a bare formula trigger.
    const cellStart = dataLine.replace(/^"/, "")[0];
    assert.notEqual(cellStart, "=", `still starts with = : ${dataLine}`);
  }
});

test("a legitimate value that merely contains = later is untouched", () => {
  const csv = toCsv(["v"], [["INV-2026=final"]]);
  const dataLine = csv.split("\r\n")[1];
  assert.equal(dataLine, "INV-2026=final");
});

test("numeric and null cells are unaffected by neutralization", () => {
  const csv = toCsv(["n", "z"], [[42, null]]);
  assert.equal(csv.split("\r\n")[1], "42,");
});
