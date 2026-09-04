import type { CanonicalField } from "./prompts";

const NUMERIC_FIELDS: ReadonlySet<CanonicalField> = new Set([
  "subtotal",
  "vatTotal",
  "grandTotal",
]);

function blank(value: string | null): boolean {
  return value === null || value.trim() === "";
}

export function valuesMatch(
  numeric: boolean,
  expected: string | null,
  actual: string | null,
): boolean {
  if (blank(expected) || blank(actual))
    return blank(expected) === blank(actual);
  if (numeric) {
    const expectedNumber = Number(expected!.replace(/[,\s]/g, ""));
    const actualNumber = Number(actual!.replace(/[,\s]/g, ""));
    if (Number.isFinite(expectedNumber) && Number.isFinite(actualNumber)) {
      return Math.abs(expectedNumber - actualNumber) < 0.005;
    }
  }
  return expected!.trim().toUpperCase() === actual!.trim().toUpperCase();
}

export function fieldMatches(
  field: CanonicalField,
  expected: string | null,
  actual: string | null,
): boolean {
  return valuesMatch(NUMERIC_FIELDS.has(field), expected, actual);
}
