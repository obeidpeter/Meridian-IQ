import { DomainError } from "../modules/errors";
import { decimalToMinorUnits, isPositiveMoney } from "./money";

// Strict request parsing: a schema failure becomes a 400 through the central
// error boundary (middleware/error.ts), byte-identical to the previous inline
// res.status(400).json({ error: parsed.error.message }) blocks.
// List endpoints use it too (bounded reads, R98): an out-of-range limit or an
// over-long search term is a 400, never a silent fall-through to the
// unbounded query it used to be.
export function parseOrThrow<Out>(
  schema: {
    safeParse(
      input: unknown,
    ):
      | { success: true; data: Out }
      | { success: false; error: { message: string } };
  },
  input: unknown,
): Out {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new DomainError("VALIDATION", parsed.error.message, 400);
  }
  return parsed.data;
}

// The payment-flag amount guard shared by the buyer and bills routes: the
// contract types amount as a bare string, so anything that is not a plain
// decimal must be rejected before it reaches the numeric column (400, not a
// DB 500). undefined passes — the routes default an absent amount themselves.
export function assertPlainDecimalAmount(amount: string | undefined): void {
  if (amount !== undefined && !isPositiveMoney(amount)) {
    throw new DomainError(
      "INVALID_AMOUNT",
      "amount must be a positive decimal string (e.g. 120000.00)",
      400,
    );
  }
}

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

// YYYY-MM-DD and a real calendar date. The round-trip through Date.UTC is
// the overflow check (V8's parser would happily read 2026-02-30 as March 2);
// the date columns are mode "string", so nothing else normalizes these.
function isRealCalendarDate(value: string): boolean {
  const [y, m, d] = value.split("-").map(Number);
  const roundTrip = new Date(Date.UTC(y, m - 1, d));
  return (
    roundTrip.getUTCFullYear() === y &&
    roundTrip.getUTCMonth() === m - 1 &&
    roundTrip.getUTCDate() === d
  );
}

// One home for the date-column guard the obligations, filings and WHT desks
// each used to carry verbatim — every desk keeps its own error code, so the
// contract's per-module 400s are unchanged.
export function assertCalendarDate(
  value: string,
  field: string,
  code: string,
): void {
  if (!DATE_SHAPE.test(value) || !isRealCalendarDate(value)) {
    throw new DomainError(
      code,
      `${field} must be a real calendar date in YYYY-MM-DD form`,
      400,
    );
  }
}

// A `paid` flag is consumed as proof that the whole invoice is paid. Keep the
// event amount aligned with that meaning so a partial amount cannot settle a
// receivable or remove a bill from payables. Overpayments remain valid.
export function resolvePaymentFlagAmount(
  status: "scheduled" | "paid",
  amount: string | undefined,
  invoiceTotal: string,
): string {
  assertPlainDecimalAmount(amount);
  const effectiveAmount = amount ?? invoiceTotal;
  if (
    status === "paid" &&
    decimalToMinorUnits(effectiveAmount) < decimalToMinorUnits(invoiceTotal)
  ) {
    throw new DomainError(
      "INCOMPLETE_PAYMENT",
      "amount for a paid flag must cover the invoice total",
      400,
    );
  }
  return effectiveAmount;
}
