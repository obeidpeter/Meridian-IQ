import type { ClerkCorrection } from "@workspace/db";

// ---- Correction-shape mining -----------------------------------------------
// Classify one changed correction by the SHAPE of the error. Closed set,
// deterministic, pure — the taxonomy a prompt tweak or parser fix acts on.

export type CorrectionShape =
  | "date_dmy_flip"
  | "date_other"
  | "vat_percent_fraction"
  | "numeric_scale"
  | "numeric_other"
  | "missed_value"
  | "hallucinated_value"
  | "text_other";

const DATE_FIELDS = new Set(["issueDate", "dueDate"]);
// Ratios within 1% of the target count as a match (OCR'd decimals wobble).
const RATIO_TOLERANCE = 0.01;

// Accepts the two dialects the exhaust actually carries: ISO YYYY-MM-DD (the
// approved side, and extraction when the printed date was unambiguous) and
// D/M/Y with /-. separators (Nigerian documents read verbatim).
function parseDateParts(
  value: string,
): { y: number; m: number; d: number } | null {
  const t = value.trim();
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (match) return { y: +match[1], m: +match[2], d: +match[3] };
  match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (match) return { y: +match[3], m: +match[2], d: +match[1] };
  return null;
}

function parseNumeric(value: string): number | null {
  const n = Number(value.replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// True when a/b is within tolerance of the target ratio.
function ratioNear(a: number, b: number, target: number): boolean {
  if (b === 0) return false;
  const ratio = a / b;
  return ratio > 0 && Math.abs(ratio / target - 1) <= RATIO_TOLERANCE;
}

export function classifyCorrectionShape(
  field: string,
  extracted: string | null,
  final: string | null,
): CorrectionShape {
  if (extracted === null && final !== null) return "missed_value";
  if (extracted !== null && final === null) return "hallucinated_value";
  if (extracted === null || final === null) return "text_other"; // both null

  if (DATE_FIELDS.has(field)) {
    const ex = parseDateParts(extracted);
    const fi = parseDateParts(final);
    // The classic scan error: day and month transposed in the same year.
    if (ex && fi && ex.y === fi.y && ex.m === fi.d && ex.d === fi.m && ex.m !== ex.d) {
      return "date_dmy_flip";
    }
    return "date_other";
  }

  const exNum = parseNumeric(extracted);
  const fiNum = parseNumeric(final);
  if (exNum !== null && fiNum !== null) {
    // VAT dialect confusion: percent read where the form wants a fraction
    // (7.5 vs 0.075) or vice versa — a x100 either way, only on rate fields.
    if (
      field.endsWith("vatRate") &&
      (ratioNear(exNum, fiNum, 100) || ratioNear(exNum, fiNum, 0.01))
    ) {
      return "vat_percent_fraction";
    }
    // A clean power-of-ten slip (dropped/invented zeros, shifted decimal
    // point): the ratio is 10^k within tolerance for some k != 0.
    if (exNum !== 0 && fiNum !== 0 && exNum / fiNum > 0) {
      const exponent = Math.round(Math.log10(exNum / fiNum));
      if (exponent !== 0 && ratioNear(exNum, fiNum, 10 ** exponent)) {
        return "numeric_scale";
      }
    }
    return "numeric_other";
  }

  return "text_other";
}

// Line corrections aggregate under their normalized field (lines.3.vatRate
// counts as lines.vatRate — position is noise for shape mining); the
// lines.count bookkeeping row is not a field correction at all.
export function normalizeCorrectionField(field: string): string | null {
  if (field === "lines.count") return null;
  const match = /^lines\.\d+\.(.+)$/.exec(field);
  return match ? `lines.${match[1]}` : field;
}

// One aggregated (field, shape) bucket with its example pair.
// ClerkMetrics.correctionShapes (metrics.ts) carries these rows verbatim.
export interface CorrectionShapeRow {
  field: string;
  shape: CorrectionShape;
  count: number;
  exampleExtracted: string | null;
  exampleFinal: string | null;
}

// Fold the calibration sample (newest cases first) into the top shape rows.
// Only corrections the operator actually CHANGED carry signal; the example
// pair is the newest occurrence because the first case seen wins.
const SHAPE_ROW_CAP = 20;

export function computeCorrectionShapes(
  cases: { corrections: ClerkCorrection[] | null }[],
): CorrectionShapeRow[] {
  const acc = new Map<string, CorrectionShapeRow>();
  for (const kase of cases) {
    for (const correction of kase.corrections ?? []) {
      if (!correction.changed) continue;
      const field = normalizeCorrectionField(correction.field);
      if (field === null) continue;
      const shape = classifyCorrectionShape(
        field,
        correction.extracted,
        correction.final,
      );
      const key = `${field}\0${shape}`;
      const row = acc.get(key);
      if (row) {
        row.count += 1;
      } else {
        acc.set(key, {
          field,
          shape,
          count: 1,
          exampleExtracted: correction.extracted,
          exampleFinal: correction.final,
        });
      }
    }
  }
  return [...acc.values()]
    .sort(
      (a, b) =>
        b.count - a.count ||
        a.field.localeCompare(b.field) ||
        a.shape.localeCompare(b.shape),
    )
    .slice(0, SHAPE_ROW_CAP);
}
