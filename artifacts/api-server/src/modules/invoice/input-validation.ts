import { DomainError } from "../errors.ts";

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  if (year < 1 || year > 9999) return false;
  const date = new Date(value + "T00:00:00.000Z");
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

export function decimalInputError(
  value: string,
  label: string,
  integerDigits: number,
  scale: number,
  positive = false,
): string | null {
  if (
    !/^\d+(?:\.\d+)?$/.test(value) ||
    value.length > integerDigits + scale + 2
  ) {
    return label + " must be a finite decimal number.";
  }
  const [whole, fraction = ""] = value.split(".");
  if (
    whole.replace(/^0+/, "").length > integerDigits ||
    fraction.length > scale
  ) {
    return label + " exceeds the supported precision.";
  }
  if (positive && !/[1-9]/.test(value))
    return label + " must be greater than zero.";
  return null;
}

export function assertInvoiceDates(input: {
  issueDate?: string;
  dueDate?: string | null;
}): void {
  for (const field of ["issueDate", "dueDate"] as const) {
    const value = input[field];
    if (value !== undefined && value !== null && !isCalendarDate(value)) {
      throw new DomainError(
        "INVALID_DATE",
        field + " must be a real date in YYYY-MM-DD format.",
      );
    }
  }
}

export function assertLineInputs(
  lines: readonly { quantity: string; unitPrice: string }[],
): void {
  for (const [index, line] of lines.entries()) {
    const error =
      decimalInputError(line.quantity, "Quantity", 14, 4, true) ??
      decimalInputError(line.unitPrice, "Unit price", 16, 2);
    if (error)
      throw new DomainError(
        "INVALID_LINE",
        "Line " + (index + 1) + ": " + error,
      );
  }
}
