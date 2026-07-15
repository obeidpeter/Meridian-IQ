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
