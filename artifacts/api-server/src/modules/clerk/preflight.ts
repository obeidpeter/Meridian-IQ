import type {
  ClerkExtraction,
  ExtractionLine,
  PreflightIssue,
} from "@workspace/db";
import { money } from "../invoice/lines";

// Pre-flight checks (Clerk power-up, package R). Deterministic, model-free
// validation of an extraction BEFORE an operator opens the case: missing
// critical values, malformed dates and rates, and totals that don't add up.
// Full canonical validation needs the parties (chosen at approval), so this is
// the honest pre-approval subset — a case with an empty issue list and
// confident critical fields is "ready to approve" in the review queue.
//
// Kept pure (no DB, no gateway) so it is trivially unit-testable and can never
// touch tenant data. Field names mirror the extraction/correction field
// vocabulary ("invoiceNumber", "lines.0.quantity", …) so the console can
// anchor issues to the same rows it already renders.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Per-line kobo rounding accumulates, so totals get a tolerance that scales
// with line count (min one kobo either way plus a kobo per line).
function totalsTolerance(lineCount: number): number {
  return 0.01 * Math.max(1, lineCount) + 0.01;
}

function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(t)) return false;
  // Reject well-formed-but-impossible dates (e.g. 2026-02-31 rolls over).
  return new Date(t).toISOString().slice(0, 10) === value;
}

function num(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const n = Number(value.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Extractions carry VAT rates as printed — "7.5" (percent) and "0.075"
// (fraction) are the same rate. Normalize to a fraction before judging, the
// same dialect rule computeLineCorrections applies.
function vatFraction(raw: string | null): number | null {
  const n = num(raw);
  if (n === null) return null;
  return n > 1 ? n / 100 : n;
}

function fieldValue(
  extraction: ClerkExtraction,
  field: string,
): string | null {
  const hit = extraction.fields.find((f) => f.field === field);
  const v = hit?.value ?? null;
  return v !== null && v.trim() === "" ? null : v;
}

function checkLine(line: ExtractionLine, idx: number): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const prefix = `lines.${idx}`;
  if (!line.description?.trim()) {
    issues.push({
      field: `${prefix}.description`,
      message: `Line ${idx + 1} has no description`,
    });
  }
  const qty = num(line.quantity);
  if (qty === null || qty <= 0) {
    issues.push({
      field: `${prefix}.quantity`,
      message: `Line ${idx + 1} quantity must be a number greater than zero`,
    });
  }
  const price = num(line.unitPrice);
  if (price === null || price < 0) {
    issues.push({
      field: `${prefix}.unitPrice`,
      message: `Line ${idx + 1} unit price must be a number of zero or more`,
    });
  }
  const rate = vatFraction(line.vatRate);
  if (rate === null || rate < 0 || rate > 1) {
    issues.push({
      field: `${prefix}.vatRate`,
      message: `Line ${idx + 1} VAT rate is not a recognisable rate (expected e.g. "7.5%" or "0.075")`,
    });
  }
  return issues;
}

export function preflightChecks(extraction: ClerkExtraction): PreflightIssue[] {
  const issues: PreflightIssue[] = [];

  const invoiceNumber = fieldValue(extraction, "invoiceNumber");
  if (!invoiceNumber) {
    issues.push({
      field: "invoiceNumber",
      message: "No invoice number was found in the document",
    });
  }

  const issueDate = fieldValue(extraction, "issueDate");
  if (!issueDate) {
    issues.push({
      field: "issueDate",
      message: "No issue date was found in the document",
    });
  } else if (!isIsoDate(issueDate)) {
    issues.push({
      field: "issueDate",
      message: `Issue date "${issueDate}" is not an unambiguous YYYY-MM-DD date`,
    });
  }

  const dueDate = fieldValue(extraction, "dueDate");
  if (dueDate !== null) {
    if (!isIsoDate(dueDate)) {
      issues.push({
        field: "dueDate",
        message: `Due date "${dueDate}" is not an unambiguous YYYY-MM-DD date`,
      });
    } else if (issueDate && isIsoDate(issueDate) && dueDate < issueDate) {
      issues.push({
        field: "dueDate",
        message: `Due date ${dueDate} is before the issue date ${issueDate}`,
      });
    }
  }

  const currency = fieldValue(extraction, "currency");
  if (currency !== null && !/^[A-Za-z]{3}$/.test(currency)) {
    issues.push({
      field: "currency",
      message: `Currency "${currency}" is not a 3-letter ISO code (e.g. NGN)`,
    });
  }

  const buyerName = fieldValue(extraction, "buyerName");
  if (!buyerName) {
    issues.push({
      field: "buyerName",
      message: "No buyer name was found in the document",
    });
  }

  if (extraction.lines.length === 0) {
    issues.push({
      field: "lines",
      message: "No line items were found in the document",
    });
  } else {
    extraction.lines.forEach((line, idx) => issues.push(...checkLine(line, idx)));
  }

  issues.push(...totalsChecks(extraction));
  return issues;
}

// Totals arithmetic — only judged when every input needed for a given
// comparison parses cleanly; a missing or garbled number is already reported
// by the field/line checks above, and piling an arithmetic complaint on top
// would double-count the same problem.
function totalsChecks(extraction: ClerkExtraction): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const subtotal = num(fieldValue(extraction, "subtotal"));
  const vatTotal = num(fieldValue(extraction, "vatTotal"));
  const grandTotal = num(fieldValue(extraction, "grandTotal"));
  const tolerance = totalsTolerance(extraction.lines.length);

  const lineParts = extraction.lines.map((line) => {
    const qty = num(line.quantity);
    const price = num(line.unitPrice);
    const rate = vatFraction(line.vatRate);
    if (qty === null || price === null || rate === null || rate < 0 || rate > 1) {
      return null;
    }
    const ext = qty * price;
    return { ext, vat: ext * rate };
  });
  const allLinesParse =
    extraction.lines.length > 0 && lineParts.every((p) => p !== null);

  if (allLinesParse) {
    const lineSum = lineParts.reduce((acc, p) => acc + p!.ext, 0);
    const vatSum = lineParts.reduce((acc, p) => acc + p!.vat, 0);
    if (subtotal !== null && Math.abs(subtotal - lineSum) > tolerance) {
      issues.push({
        field: "subtotal",
        message: `Subtotal ${money(subtotal)} does not match the line items, which add up to ${money(lineSum)}`,
      });
    }
    if (vatTotal !== null && Math.abs(vatTotal - vatSum) > tolerance) {
      issues.push({
        field: "vatTotal",
        message: `VAT total ${money(vatTotal)} does not match the line items, which imply ${money(vatSum)}`,
      });
    }
  }

  if (
    subtotal !== null &&
    vatTotal !== null &&
    grandTotal !== null &&
    Math.abs(grandTotal - (subtotal + vatTotal)) > tolerance
  ) {
    issues.push({
      field: "grandTotal",
      message: `Grand total ${money(grandTotal)} does not equal subtotal + VAT (${money(subtotal + vatTotal)})`,
    });
  }
  return issues;
}
