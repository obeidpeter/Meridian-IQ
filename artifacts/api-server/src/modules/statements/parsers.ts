import { parseCsv } from "../../lib/csv.ts";

// Bank-statement ingestion (INT-05). One StatementParser interface over N
// bank-export implementations — the same seam the open-banking interfaces of
// [OPEN-3] later slot behind, exactly as the APP rails hide behind the adapter
// contract (INT-01). Parsers are pure: text in, normalized lines out, per-line
// error reporting, no I/O.
//
// The three concrete formats model the CSV exports Phase-one engagements met
// most often (GTBank, Zenith, Access); a header-alias generic parser catches
// simple exports. Adding a bank is a new implementation of this interface —
// never a change to ingestion, matching or storage.

export interface ParsedStatementLine {
  lineNo: number;
  valueDate: string | null; // ISO yyyy-mm-dd
  amount: string | null; // absolute amount, "12345.67"
  direction: "credit" | "debit" | null;
  narration: string | null;
  counterpartyRef: string | null;
  parseStatus: "parsed" | "invalid";
  parseError: string | null;
  rawLine: string;
}

export interface ParsedStatement {
  formatKey: string;
  accountRef: string | null;
  lines: ParsedStatementLine[];
  lineCount: number;
  parsedCount: number;
}

export interface StatementParser {
  key: string;
  bankName: string;
  // Recognise this bank's export from its header row.
  detect(headers: string[]): boolean;
  parse(text: string): ParsedStatement;
}

// ---- shared normalization helpers ----

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z]/g, "");
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

// Nigerian bank exports mix DD/MM/YYYY, DD-MM-YYYY, DD-MMM-YYYY and ISO.
export function normalizeDate(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = v.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (m) {
    const day = m[1].padStart(2, "0");
    const month = m[2].padStart(2, "0");
    if (Number(month) > 12 || Number(day) > 31) return null;
    return `${m[3]}-${month}-${day}`;
  }
  m = v.match(/^(\d{1,2})[\/ -]([A-Za-z]{3,})[\/ -](\d{2,4})$/);
  if (m) {
    const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (!month) return null;
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${month}-${m[1].padStart(2, "0")}`;
  }
  return null;
}

// Strip currency adornments: naira sign, NGN, thousands separators, spaces;
// parentheses mean negative (a debit on single-amount-column formats).
export function normalizeAmount(raw: string): number | null {
  let v = raw.trim();
  if (!v || v === "-" || v === "--") return null;
  let negative = false;
  if (/^\(.*\)$/.test(v)) {
    negative = true;
    v = v.slice(1, -1);
  }
  if (v.endsWith("-")) {
    negative = true;
    v = v.slice(0, -1);
  }
  v = v
    .replace(/₦|NGN|ngn/g, "")
    .replace(/[,\s]/g, "")
    .replace(/(DR|CR|dr|cr)$/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(v)) return null;
  const n = Number(v);
  if (Number.isNaN(n)) return null;
  return negative ? -n : n;
}

function money(n: number): string {
  return (Math.round(Math.abs(n) * 100) / 100).toFixed(2);
}

function invalid(
  lineNo: number,
  rawLine: string,
  error: string,
): ParsedStatementLine {
  return {
    lineNo,
    valueDate: null,
    amount: null,
    direction: null,
    narration: null,
    counterpartyRef: null,
    parseStatus: "invalid",
    parseError: error,
    rawLine,
  };
}

interface ColumnMap {
  date: number;
  narration: number;
  reference: number | null;
  debit: number | null;
  credit: number | null;
  amount: number | null;
  drcr: number | null;
}

// Shared row-to-line logic once a format's columns are located: dual
// debit/credit columns or a single amount column with (or without) a DR/CR
// marker, tolerant of currency symbols, comma separators and parentheses.
function toLine(
  cells: string[],
  lineNo: number,
  cols: ColumnMap,
): ParsedStatementLine {
  const rawLine = cells.join(",");
  const date = normalizeDate(cells[cols.date] ?? "");
  if (!date) {
    return invalid(lineNo, rawLine, `Unparseable date: "${cells[cols.date] ?? ""}"`);
  }
  const narration = (cells[cols.narration] ?? "").trim() || null;
  const reference =
    cols.reference !== null ? (cells[cols.reference] ?? "").trim() || null : null;

  let amount: number | null = null;
  let direction: "credit" | "debit" | null = null;
  if (cols.debit !== null && cols.credit !== null) {
    const debit = normalizeAmount(cells[cols.debit] ?? "");
    const credit = normalizeAmount(cells[cols.credit] ?? "");
    if (credit !== null && credit !== 0) {
      amount = credit;
      direction = "credit";
    } else if (debit !== null && debit !== 0) {
      amount = debit;
      direction = "debit";
    }
  } else if (cols.amount !== null) {
    const value = normalizeAmount(cells[cols.amount] ?? "");
    if (value !== null) {
      const marker =
        cols.drcr !== null ? (cells[cols.drcr] ?? "").trim().toUpperCase() : "";
      if (marker === "CR" || marker === "C") direction = "credit";
      else if (marker === "DR" || marker === "D") direction = "debit";
      else direction = value < 0 ? "debit" : "credit";
      amount = value;
    }
  }
  if (amount === null) {
    return invalid(lineNo, rawLine, "No parseable amount on the line");
  }
  return {
    lineNo,
    valueDate: date,
    amount: money(amount),
    direction,
    narration,
    counterpartyRef: reference,
    parseStatus: "parsed",
    parseError: null,
    rawLine,
  };
}

// Locate the header row (banks often prefix exports with account metadata) and
// return [headerIndex, headers]. A row "matches" when the given detector says so.
function findHeader(
  grid: string[][],
  matches: (headers: string[]) => boolean,
): number {
  const scanDepth = Math.min(grid.length, 10);
  for (let i = 0; i < scanDepth; i++) {
    if (matches(grid[i])) return i;
  }
  return -1;
}

function makeParser(spec: {
  key: string;
  bankName: string;
  headerMatch: (normalized: string[]) => boolean;
  locate: (normalized: string[]) => ColumnMap | null;
  accountRefPrefix?: RegExp;
}): StatementParser {
  return {
    key: spec.key,
    bankName: spec.bankName,
    detect(headers: string[]): boolean {
      return spec.headerMatch(headers.map(normalizeHeader));
    },
    parse(text: string): ParsedStatement {
      const grid = parseCsv(text);
      const headerIdx = findHeader(grid, (h) =>
        spec.headerMatch(h.map(normalizeHeader)),
      );
      const lines: ParsedStatementLine[] = [];
      let accountRef: string | null = null;
      if (spec.accountRefPrefix) {
        for (const row of grid.slice(0, Math.max(headerIdx, 0))) {
          const joined = row.join(" ");
          const m = joined.match(spec.accountRefPrefix);
          if (m) accountRef = m[1] ?? m[0];
        }
      }
      if (headerIdx === -1) {
        return {
          formatKey: spec.key,
          accountRef,
          lines: [],
          lineCount: 0,
          parsedCount: 0,
        };
      }
      const cols = spec.locate(grid[headerIdx].map(normalizeHeader));
      let lineNo = 0;
      for (const row of grid.slice(headerIdx + 1)) {
        lineNo++;
        if (!cols) {
          lines.push(invalid(lineNo, row.join(","), "Unrecognised columns"));
          continue;
        }
        lines.push(toLine(row, lineNo, cols));
      }
      return {
        formatKey: spec.key,
        accountRef,
        lines,
        lineCount: lines.length,
        parsedCount: lines.filter((l) => l.parseStatus === "parsed").length,
      };
    },
  };
}

function indexOfAny(headers: string[], names: string[]): number | null {
  for (const name of names) {
    const i = headers.indexOf(name);
    if (i !== -1) return i;
  }
  return null;
}

// ---- GTBank-style export: Transaction Date / Reference / Debits / Credits /
// Balance / Remarks, dates DD-MMM-YYYY ----
const gtbParser = makeParser({
  key: "gtb_csv",
  bankName: "GTBank",
  headerMatch: (h) =>
    h.includes("transactiondate") && h.includes("debits") && h.includes("credits"),
  locate: (h) => {
    const date = h.indexOf("transactiondate");
    const narration = indexOfAny(h, ["remarks", "narration"]);
    if (date === -1 || narration === null) return null;
    return {
      date,
      narration,
      reference: indexOfAny(h, ["reference", "refno"]),
      debit: indexOfAny(h, ["debits", "debit"]),
      credit: indexOfAny(h, ["credits", "credit"]),
      amount: null,
      drcr: null,
    };
  },
  accountRefPrefix: /Account\s*(?:No|Number)[:\s]+(\d{6,})/i,
});

// ---- Zenith-style export: Date / Description / Value Date / Debit / Credit /
// Balance, dates DD/MM/YYYY, ₦-prefixed amounts ----
const zenithParser = makeParser({
  key: "zenith_csv",
  bankName: "Zenith Bank",
  headerMatch: (h) =>
    h.includes("valuedate") && h.includes("debit") && h.includes("credit"),
  locate: (h) => {
    const date = h.indexOf("valuedate");
    const narration = indexOfAny(h, ["description", "narration"]);
    if (date === -1 || narration === null) return null;
    return {
      date,
      narration,
      reference: indexOfAny(h, ["reference", "instrumentno"]),
      debit: h.indexOf("debit"),
      credit: h.indexOf("credit"),
      amount: null,
      drcr: null,
    };
  },
  accountRefPrefix: /Account\s*(?:No|Number)[:\s]+(\d{6,})/i,
});

// ---- Access-style export: Trans Date / Narration / Reference / DR\/CR /
// Amount(NGN) / Running Balance — single amount column with DR/CR marker ----
const accessParser = makeParser({
  key: "access_csv",
  bankName: "Access Bank",
  headerMatch: (h) =>
    h.includes("transdate") && (h.includes("drcr") || h.includes("amountngn")),
  locate: (h) => {
    const date = h.indexOf("transdate");
    const narration = h.indexOf("narration");
    if (date === -1 || narration === -1) return null;
    return {
      date,
      narration,
      reference: indexOfAny(h, ["reference", "refno"]),
      debit: null,
      credit: null,
      amount: indexOfAny(h, ["amountngn", "amount"]),
      drcr: indexOfAny(h, ["drcr"]),
    };
  },
  accountRefPrefix: /Account\s*(?:No|Number)[:\s]+(\d{6,})/i,
});

// ---- Generic fallback: date / narration / amount (+ optional direction) ----
const genericParser = makeParser({
  key: "generic_csv",
  bankName: "Generic",
  headerMatch: (h) =>
    indexOfAny(h, ["date", "valuedate", "transactiondate", "transdate"]) !==
      null &&
    (indexOfAny(h, ["amount", "amountngn"]) !== null ||
      (indexOfAny(h, ["debit", "debits"]) !== null &&
        indexOfAny(h, ["credit", "credits"]) !== null)),
  locate: (h) => {
    const date = indexOfAny(h, [
      "date",
      "valuedate",
      "transactiondate",
      "transdate",
    ]);
    const narration = indexOfAny(h, [
      "narration",
      "description",
      "remarks",
      "details",
    ]);
    if (date === null || narration === null) return null;
    return {
      date,
      narration,
      reference: indexOfAny(h, ["reference", "refno", "ref"]),
      debit: indexOfAny(h, ["debit", "debits"]),
      credit: indexOfAny(h, ["credit", "credits"]),
      amount: indexOfAny(h, ["amount", "amountngn"]),
      drcr: indexOfAny(h, ["drcr", "direction", "type"]),
    };
  },
});

// Detection order matters: specific bank formats before the generic fallback.
export const STATEMENT_PARSERS: StatementParser[] = [
  gtbParser,
  zenithParser,
  accessParser,
  genericParser,
];

// Build a parser from a stored column mapping (custom-formats.ts). The
// mapping names HEADERS, matched after the same normalization the built-in
// parsers use, so column order and cosmetic punctuation never matter. The
// parse pipeline is byte-identical to the code-defined banks — a custom
// format gains no behaviour of its own, only column locations.
export interface ColumnNameMapping {
  date: string;
  narration: string;
  reference?: string | null;
  debit?: string | null;
  credit?: string | null;
  amount?: string | null;
  drcr?: string | null;
}

export function parserFromMapping(mapping: {
  key: string;
  bankName: string;
  columns: ColumnNameMapping;
}): StatementParser {
  const col = (name: string | null | undefined) =>
    name?.trim() ? normalizeHeader(name) : null;
  const date = col(mapping.columns.date);
  const narration = col(mapping.columns.narration);
  const debit = col(mapping.columns.debit);
  const credit = col(mapping.columns.credit);
  const amount = col(mapping.columns.amount);
  const find = (h: string[], name: string | null): number | null => {
    if (!name) return null;
    const i = h.indexOf(name);
    return i === -1 ? null : i;
  };
  return makeParser({
    key: mapping.key,
    bankName: mapping.bankName,
    headerMatch: (h) =>
      date !== null &&
      narration !== null &&
      h.includes(date) &&
      h.includes(narration) &&
      // Amount evidence must be locatable, same rule as the generic parser.
      ((amount !== null && h.includes(amount)) ||
        (debit !== null &&
          credit !== null &&
          h.includes(debit) &&
          h.includes(credit))),
    locate: (h) => {
      const dateIdx = find(h, date);
      const narrationIdx = find(h, narration);
      if (dateIdx === null || narrationIdx === null) return null;
      return {
        date: dateIdx,
        narration: narrationIdx,
        reference: find(h, col(mapping.columns.reference)),
        debit: find(h, debit),
        credit: find(h, credit),
        amount: find(h, amount),
        drcr: find(h, col(mapping.columns.drcr)),
      };
    },
  });
}

export function findParser(key: string): StatementParser | null {
  return STATEMENT_PARSERS.find((p) => p.key === key) ?? null;
}

// The first few raw rows of an export — the window every parser's detect()
// scans (banks prefix exports with account metadata before the header row).
export function parseCsvHeadersOnly(text: string): string[][] {
  const grid = parseCsv(text);
  return grid.slice(0, Math.min(grid.length, 10));
}

// Detect a parser from the file content (scanning for a recognisable header
// row), or honour an explicit formatKey when the caller knows the bank.
export function parseStatementText(
  text: string,
  formatKey?: string | null,
): ParsedStatement | null {
  if (formatKey) {
    const parser = findParser(formatKey);
    return parser ? parser.parse(text) : null;
  }
  const grid = parseCsv(text);
  const scanDepth = Math.min(grid.length, 10);
  for (const parser of STATEMENT_PARSERS) {
    for (let i = 0; i < scanDepth; i++) {
      if (parser.detect(grid[i])) {
        return parser.parse(text);
      }
    }
  }
  return null;
}
