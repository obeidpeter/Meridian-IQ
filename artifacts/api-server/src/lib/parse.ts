import { DomainError } from "../modules/errors";

// Strict request parsing: a schema failure becomes a 400 through the central
// error boundary (middleware/error.ts), byte-identical to the previous inline
// res.status(400).json({ error: parsed.error.message }) blocks.
// Deliberately-lenient query parses (list endpoints that fall back to
// defaults on failure) must NOT use this.
export function parseOrThrow<Out>(
  schema: {
    safeParse(input: unknown):
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
  if (amount !== undefined && !/^\d+(\.\d{1,2})?$/.test(amount)) {
    throw new DomainError(
      "INVALID_AMOUNT",
      "amount must be a plain decimal string (e.g. 120000.00)",
      400,
    );
  }
}
