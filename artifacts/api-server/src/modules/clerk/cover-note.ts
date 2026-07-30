import { z } from "zod/v4";
import { ensureGrounded } from "./grounding";
import { inferPhrasing, type ClerkGateway, type ClerkPurpose } from "./gateway";

// The ONE mechanical skeleton behind the deterministic-pack cover notes
// (vat-note, pack-note, advisory/quarterly-note). Each surface keeps its OWN
// prompt constants, facts builder, template, quiet check and result shape —
// only the machinery lives here: the `{note}` schema pair and the
// phrase-or-null call under the digest posture. Hand-copying exactly this
// block is how the kill-switch TOCTOU drift shipped four times (the
// bare-infer scan in middleware/rate-limit-lockstep.test.ts tells the story),
// so a new cover-note surface composes this instead of copying it.

export interface CoverNoteSchemas {
  jsonSchema: Record<string, unknown>;
  validator: z.ZodType<{ note: string }>;
}

// The shared `{note: string}` schema pair, parameterized only by the
// surface's length cap. Surfaces with an eval seam (vat-note's
// VAT_NOTE_PHRASING) must reference the SAME returned objects in the seam
// and in their phraseCoverNote call, so the seam can never drift from what
// production sends.
export function coverNoteSchemas(maxLen: number): CoverNoteSchemas {
  return {
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["note"],
      properties: { note: { type: "string" } },
    },
    validator: z.object({ note: z.string().min(1).max(maxLen) }),
  };
}

// One phrasing call under the digest posture — the kill-switch check and its
// TOCTOU catch live in inferPhrasing (gateway.ts); the outer try keeps these
// surfaces' stronger guarantee that even a grounding-check failure answers
// with the template. Null means "the caller's deterministic template
// answers", never an error.
export async function phraseCoverNote(
  gateway: ClerkGateway | null,
  opts: {
    firmId: string;
    purpose: ClerkPurpose;
    promptVersion: string;
    system: string;
    // The surface's computed facts — both the model's user prompt and the
    // ledger's input hash, so nothing else can reach the prompt.
    factsText: string;
    schemaName: string;
    // The surface key ensureGrounded stamps on a violation audit row.
    groundingSurface: string;
    jsonSchema: Record<string, unknown>;
    validator: z.ZodType<{ note: string }>;
  },
): Promise<string | null> {
  try {
    const data = await inferPhrasing<{ note: string }>(gateway, {
      purpose: opts.purpose,
      caseId: null,
      // Firm work product, so the firm's own allowance funds it. There is
      // deliberately NO route budget pre-check: the gateway backstop turns
      // an exhausted allowance into a typed failure, which answers with the
      // template — never a 429 (see the route comment).
      firmId: opts.firmId,
      promptVersion: opts.promptVersion,
      system: opts.system,
      user: opts.factsText,
      schemaName: opts.schemaName,
      jsonSchema: opts.jsonSchema,
      validator: opts.validator,
      inputForHash: opts.factsText,
    });
    // Number grounding: a numeral the facts never stated → template answers
    // (grounding.ts).
    if (
      !data ||
      !(await ensureGrounded(
        opts.groundingSurface,
        opts.firmId,
        data.note,
        opts.factsText,
      ))
    ) {
      return null;
    }
    return data.note;
  } catch {
    return null;
  }
}
