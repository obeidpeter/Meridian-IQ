import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseStatementText,
  findParser,
  normalizeDate,
  normalizeAmount,
  STATEMENT_PARSERS,
} from "./parsers.ts";

// INT-05 acceptance: top statement formats parse at >= 99% line success, with
// per-row error reporting, behind one pluggable interface.

// ---- fixture books: one per format, ~120 lines each with realistic noise ----

function gtbFixture(rows: number): string {
  const head = [
    "GTBank Plc Statement of Account",
    "Account No: 0123456789",
    "Period: 01-Jan-2027 to 31-Mar-2027",
    "Transaction Date,Reference,Debits,Credits,Balance,Remarks",
  ];
  const lines: string[] = [];
  for (let i = 1; i <= rows; i++) {
    const day = String((i % 28) + 1).padStart(2, "0");
    if (i % 3 === 0) {
      lines.push(
        `${day}-Feb-2027,GTB${1000 + i},"${(i * 1250).toLocaleString("en-NG")}.00",,"1,000,000.00",POS PURCHASE SHOPRITE`,
      );
    } else {
      lines.push(
        `${day}-Jan-2027,GTB${1000 + i},,"${(i * 8000).toLocaleString("en-NG")}.00","2,500,000.00",TRF FROM ZENITH RETAIL INV-10${i}`,
      );
    }
  }
  return [...head, ...lines].join("\n");
}

function zenithFixture(rows: number): string {
  const head = [
    "Zenith Bank Statement",
    "Account Number: 2087654321",
    "Date,Description,Value Date,Debit,Credit,Balance",
  ];
  const lines: string[] = [];
  for (let i = 1; i <= rows; i++) {
    const day = String((i % 28) + 1).padStart(2, "0");
    if (i % 4 === 0) {
      lines.push(
        `${day}/01/2027,NIP CHARGE,${day}/01/2027,"₦${(52.5).toFixed(2)}",,"₦890,123.45"`,
      );
    } else {
      lines.push(
        `${day}/01/2027,"NIP TRF SAHARA LOGISTICS/INV-20${i}",${day}/01/2027,,"₦${(i * 15000).toLocaleString("en-NG")}.00","₦1,890,123.45"`,
      );
    }
  }
  return [...head, ...lines].join("\n");
}

function accessFixture(rows: number): string {
  const head = [
    "Access Bank Statement Export",
    "Account No: 0698765432",
    "Trans Date,Narration,Reference,DR/CR,Amount(NGN),Running Balance",
  ];
  const lines: string[] = [];
  for (let i = 1; i <= rows; i++) {
    const day = String((i % 28) + 1).padStart(2, "0");
    if (i % 5 === 0) {
      lines.push(
        `${day}-02-2027,ATM WITHDRAWAL IKEJA,ACC${i},DR,"25,000.00","740,000.00"`,
      );
    } else {
      lines.push(
        `${day}-02-2027,"TRANSFER/INV-30${i}/ADAEZE FOODS",ACC${i},CR,"${(i * 22000).toLocaleString("en-NG")}.00","990,000.00"`,
      );
    }
  }
  return [...head, ...lines].join("\n");
}

test("GTBank format detects and parses at >= 99% line success", () => {
  const result = parseStatementText(gtbFixture(120));
  assert.ok(result, "parser should be detected from content");
  assert.equal(result.formatKey, "gtb_csv");
  assert.equal(result.accountRef, "0123456789");
  assert.equal(result.lineCount, 120);
  assert.ok(
    result.parsedCount / result.lineCount >= 0.99,
    `parse rate ${result.parsedCount}/${result.lineCount} below 99%`,
  );
  const credit = result.lines.find((l) => l.narration?.includes("INV-101"));
  assert.ok(credit);
  assert.equal(credit.direction, "credit");
  assert.match(credit.amount ?? "", /^\d+\.\d{2}$/);
  assert.match(credit.valueDate ?? "", /^2027-01-\d{2}$/);
});

test("Zenith format handles naira signs and comma amounts at >= 99%", () => {
  const result = parseStatementText(zenithFixture(120));
  assert.ok(result);
  assert.equal(result.formatKey, "zenith_csv");
  assert.ok(result.parsedCount / result.lineCount >= 0.99);
  const debit = result.lines.find((l) => l.narration === "NIP CHARGE");
  assert.ok(debit);
  assert.equal(debit.direction, "debit");
  assert.equal(debit.amount, "52.50");
});

test("Access format resolves DR/CR markers on a single amount column at >= 99%", () => {
  const result = parseStatementText(accessFixture(120));
  assert.ok(result);
  assert.equal(result.formatKey, "access_csv");
  assert.ok(result.parsedCount / result.lineCount >= 0.99);
  const withdrawal = result.lines.find((l) =>
    l.narration?.includes("ATM WITHDRAWAL"),
  );
  assert.ok(withdrawal);
  assert.equal(withdrawal.direction, "debit");
  assert.equal(withdrawal.amount, "25000.00");
});

test("bad lines are reported per-row, never dropped silently", () => {
  const csv = [
    "Date,Description,Value Date,Debit,Credit,Balance",
    '05/01/2027,GOOD CREDIT,05/01/2027,,"₦10,000.00",x',
    "not-a-date,BROKEN ROW,not-a-date,,abc,x",
  ].join("\n");
  const result = parseStatementText(csv);
  assert.ok(result);
  assert.equal(result.lineCount, 2);
  assert.equal(result.parsedCount, 1);
  const bad = result.lines[1];
  assert.equal(bad.parseStatus, "invalid");
  assert.ok(bad.parseError);
  assert.ok(bad.rawLine.includes("BROKEN ROW"));
});

test("explicit formatKey overrides detection; unknown key returns null", () => {
  const viaKey = parseStatementText(zenithFixture(10), "zenith_csv");
  assert.ok(viaKey);
  assert.equal(viaKey.formatKey, "zenith_csv");
  assert.equal(parseStatementText("a,b,c", "unknown_bank"), null);
  assert.ok(findParser("gtb_csv"));
  assert.equal(findParser("nope"), null);
});

test("every parser is pluggable behind the single interface", () => {
  assert.ok(STATEMENT_PARSERS.length >= 4);
  for (const parser of STATEMENT_PARSERS) {
    assert.equal(typeof parser.key, "string");
    assert.equal(typeof parser.detect, "function");
    assert.equal(typeof parser.parse, "function");
  }
});

test("date normalization covers Nigerian export variants", () => {
  assert.equal(normalizeDate("03/01/2027"), "2027-01-03");
  assert.equal(normalizeDate("03-01-2027"), "2027-01-03");
  assert.equal(normalizeDate("3-Jan-2027"), "2027-01-03");
  assert.equal(normalizeDate("2027-01-03"), "2027-01-03");
  assert.equal(normalizeDate("31/31/2027"), null);
  assert.equal(normalizeDate("garbage"), null);
});

test("amount normalization strips naira adornments and flags negatives", () => {
  assert.equal(normalizeAmount("₦1,234,567.89"), 1234567.89);
  assert.equal(normalizeAmount("NGN 5,000"), 5000);
  assert.equal(normalizeAmount("(2,500.00)"), -2500);
  assert.equal(normalizeAmount(""), null);
  assert.equal(normalizeAmount("-"), null);
  assert.equal(normalizeAmount("abc"), null);
});
