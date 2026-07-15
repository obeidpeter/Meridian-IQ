import type {
  ClerkCorrection,
  ClerkExtraction,
  ExtractionLine,
} from "@workspace/db";

// Pure corrections-diff library for Clerk cases. The labeled-outcome exhaust
// (item: correction capture). Diff the model's proposal against the
// operator-approved values for every field both sides can express. Party
// identities are chosen as IDs at approval and have no extracted-string
// equivalence, so they are not compared. Totals come from the created draft
// invoice, whose arithmetic is the platform's own.

export interface ApprovedLineForDiff {
  description: string;
  quantity: string;
  unitPrice: string;
  vatRate?: string | null;
}

// VAT rates arrive in two dialects: the extraction may report "7.5" (percent,
// as printed on the document) while the approved line carries "0.075"
// (fraction, the API contract). Normalize both to a fraction before
// comparing so a dialect difference never counts as an operator override.
function vatToFraction(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n > 1 ? n / 100 : n;
}

// The 0.005 epsilon is the shared numeric tolerance for both correction paths
// (header fields and line fields); non-numeric values fall back to a trimmed
// exact compare.
function numericEq(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const na = Number(a);
  const nb = Number(b);
  return Number.isFinite(na) && Number.isFinite(nb)
    ? Math.abs(na - nb) < 0.005
    : a.trim() === b.trim();
}

function textEq(a: string | null, b: string | null): boolean {
  return (a ?? "").trim() === (b ?? "").trim();
}

// Line-level exhaust: most operator re-keying happens in the lines, so the
// header-field diff alone under-reports extraction quality. Lines are matched
// by position — the model is instructed to emit lines in document order and
// the console prefills the form in that order, so positional pairing is the
// honest default; a count mismatch is itself recorded as a correction.
export function computeLineCorrections(
  extracted: ExtractionLine[],
  approved: ApprovedLineForDiff[],
): ClerkCorrection[] {
  const corrections: ClerkCorrection[] = [];
  corrections.push({
    field: "lines.count",
    extracted: String(extracted.length),
    final: String(approved.length),
    changed: extracted.length !== approved.length,
  });
  const pairs = Math.min(extracted.length, approved.length, 20);
  for (let i = 0; i < pairs; i++) {
    const ex = extracted[i];
    const ap = approved[i];
    const prefix = `lines.${i}`;
    corrections.push({
      field: `${prefix}.description`,
      extracted: ex.description,
      final: ap.description,
      changed: !textEq(ex.description, ap.description),
    });
    corrections.push({
      field: `${prefix}.quantity`,
      extracted: ex.quantity,
      final: ap.quantity,
      changed: !numericEq(ex.quantity, ap.quantity),
    });
    corrections.push({
      field: `${prefix}.unitPrice`,
      extracted: ex.unitPrice,
      final: ap.unitPrice,
      changed: !numericEq(ex.unitPrice, ap.unitPrice),
    });
    const exVat = vatToFraction(ex.vatRate);
    const apVat = vatToFraction(ap.vatRate ?? null);
    corrections.push({
      field: `${prefix}.vatRate`,
      extracted: ex.vatRate,
      final: ap.vatRate ?? null,
      changed:
        exVat === null || apVat === null
          ? exVat !== apVat
          : Math.abs(exVat - apVat) >= 0.0005,
    });
  }
  return corrections;
}

export function computeCorrections(
  extraction: ClerkExtraction | null,
  approved: {
    invoiceNumber: string;
    issueDate: string;
    dueDate: string | null;
    currency: string;
    subtotal: string;
    vatTotal: string;
    grandTotal: string;
  },
): ClerkCorrection[] {
  const extracted = new Map(
    (extraction?.fields ?? []).map((f) => [f.field, f.value]),
  );
  const compare: {
    field: string;
    final: string | null;
    eq: (a: string | null, b: string | null) => boolean;
  }[] = [
    { field: "invoiceNumber", final: approved.invoiceNumber, eq: textEq },
    { field: "issueDate", final: approved.issueDate, eq: textEq },
    { field: "dueDate", final: approved.dueDate, eq: textEq },
    { field: "currency", final: approved.currency, eq: textEq },
    { field: "subtotal", final: approved.subtotal, eq: numericEq },
    { field: "vatTotal", final: approved.vatTotal, eq: numericEq },
    { field: "grandTotal", final: approved.grandTotal, eq: numericEq },
  ];
  return compare.map(({ field, final, eq }) => {
    const raw = extracted.get(field) ?? null;
    return { field, extracted: raw, final, changed: !eq(raw, final) };
  });
}
