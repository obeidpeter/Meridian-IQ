import { test } from "node:test";
import assert from "node:assert/strict";
import {
  confidenceTone,
  CSV_TOO_LARGE_MESSAGE,
  csvLineCount,
  formatLabel,
  MAX_CSV_CHARS,
  MAX_REPORT_ROWS,
  percent,
  PROPOSAL_STATUS_LABEL,
  PROPOSAL_STATUS_TONE,
  STATEMENT_STATUS_LABEL,
  STATEMENT_STATUS_TONE,
} from "./reconciliation.ts";

test("formatLabel names the recognised bank formats, humanizes unknown keys and covers a missing one", () => {
  assert.equal(formatLabel("gtb_csv"), "GTBank");
  assert.equal(formatLabel("zenith_csv"), "Zenith Bank");
  assert.equal(formatLabel("access_csv"), "Access Bank");
  assert.equal(formatLabel("generic_csv"), "Bank CSV");
  // An unrecognised key from a newer parser still reads as words.
  assert.equal(formatLabel("first_bank_csv"), "First Bank Csv");
  assert.equal(formatLabel(null), "Unknown format");
  assert.equal(formatLabel(undefined), "Unknown format");
  assert.equal(formatLabel(""), "Unknown format");
});

test("percent rounds a rate to a whole percentage and shows a dash for junk", () => {
  assert.equal(percent(0.756), "76%");
  assert.equal(percent("0.5"), "50%");
  assert.equal(percent(1), "100%");
  assert.equal(percent(0), "0%");
  assert.equal(percent(Number.NaN), "—");
  assert.equal(percent("abc"), "—");
});

test("confidenceTone: success from 0.75, warning from 0.5, neutral below and for junk", () => {
  assert.equal(confidenceTone("0.75"), "success");
  assert.equal(confidenceTone("0.9"), "success");
  assert.equal(confidenceTone("0.7499"), "warning");
  assert.equal(confidenceTone("0.5"), "warning");
  assert.equal(confidenceTone("0.4999"), "neutral");
  assert.equal(confidenceTone("0"), "neutral");
  assert.equal(confidenceTone("n/a"), "neutral");
});

test("csvLineCount counts non-blank lines, headers included, across CRLF and blank lines", () => {
  assert.equal(csvLineCount(""), 0);
  assert.equal(csvLineCount("   \n\n"), 0);
  assert.equal(csvLineCount("Date,Narration,Amount"), 1);
  assert.equal(csvLineCount("Date,Amount\r\n2026-01-01,100\r\n"), 2);
  assert.equal(csvLineCount("a\n\n  \nb\nc\n"), 3);
});

test("the status vocabularies cover every statement and proposal status", () => {
  assert.deepEqual(STATEMENT_STATUS_LABEL, {
    validated: "Preview",
    committed: "Matching…",
    reconciled: "Ready",
  });
  assert.deepEqual(STATEMENT_STATUS_TONE, {
    validated: "info",
    committed: "warning",
    reconciled: "success",
  });
  assert.deepEqual(PROPOSAL_STATUS_LABEL, {
    proposed: "Needs review",
    accepted: "Accepted",
    rejected: "Rejected",
    superseded: "Superseded",
  });
  assert.deepEqual(PROPOSAL_STATUS_TONE, {
    proposed: "info",
    accepted: "success",
    rejected: "neutral",
    superseded: "neutral",
  });
});

test("the import ceilings match the server's SEC-M3 limit and the report stays a decision aid", () => {
  assert.equal(MAX_CSV_CHARS, 4_000_000);
  assert.equal(MAX_REPORT_ROWS, 20);
  assert.match(CSV_TOO_LARGE_MESSAGE, /too large for a bank statement/);
});
