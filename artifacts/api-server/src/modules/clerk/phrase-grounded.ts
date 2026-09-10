import { z } from "zod/v4";
import { assertFirmClerkBudget } from "./budget";
import {
  CLERK_FLAG_KEY,
  inferPhrasing,
  type ClerkGateway,
  type ClerkPurpose,
} from "./gateway";
import { ensureGrounded } from "./grounding";
import { isFeatureEnabled } from "../flags/flags";

// The FULL phrase-or-template gate ladder shared by the phrasing surfaces
// with a template fallback (advisory/narrative.ts draftEngagementNarrative,
// obligations/response-pack.ts's letter draft, and the three periodic
// narratives — digest.ts, advisory-brief.ts, client-statement.ts): gateway
// missing → null; clerk_ai flag off → null; firm budget exhausted (the
// pre-check) → null; then ONE phrasing call and the number-grounding check
// inside a try, so ANYTHING failing past the checks still folds to null —
// the caller's deterministic template always answers, and these surfaces
// never error for AI-availability reasons.
//
// This is the cover-note.ts rule applied to the wider ladder: hand-copying
// exactly this block is how the kill-switch TOCTOU drift shipped four times
// (see narrative.ts's #93 history, now here). It is DELIBERATELY a sibling of
// phraseCoverNote, not a replacement: cover-note surfaces omit the budget
// pre-check (the gateway backstop answers with the template — see
// cover-note.ts), while the surfaces here perform it, and the check order
// (flag BEFORE budget) is part of the observable posture — a disabled flag
// never touches the budget counter.
//
// inferPhrasing (gateway.ts) re-checks the kill switch and folds every typed
// gateway failure (kill switch, budget backstop, discarded output) to null;
// the outer try keeps the stronger draft-reply.ts guarantee that anything
// failing past that — a ledger-insert failure inside the gateway after the
// provider answered, even a grounding-check crash — still answers with the
// template, source tagged honestly by the caller.
// The digest-posture headline+bullets output shape shared by digest.ts and
// client-statement.ts (300/400-char and 5-bullet caps). advisory-brief's
// 200-cap headline pair deliberately stays local to it.
export const headlineBulletsOutput = z.object({
  headline: z.string().min(1).max(300),
  bullets: z.array(z.string().min(1).max(400)).max(5),
});
export const headlineBulletsJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "bullets"],
  properties: {
    headline: { type: "string" },
    bullets: { type: "array", items: { type: "string" }, maxItems: 5 },
  },
};

export async function phraseGroundedDraft<T>(
  gateway: ClerkGateway | null,
  // tenantFirmId(principal) — null for operator principals; the budget
  // pre-check only applies when a firm is on the hook.
  tenant: string | null,
  opts: {
    purpose: ClerkPurpose;
    promptVersion: string;
    system: string;
    user: string;
    schemaName: string;
    jsonSchema: Record<string, unknown>;
    validator: z.ZodType<T>;
    // The surface key ensureGrounded stamps on a violation audit row.
    groundingSurface: string;
    inputForHash: string;
    // The validated output's grounded text (the surfaces compose it
    // differently: a narrative field, a letter join, headline + bullets/note
    // — the seam objects' joinOutput where one exists). The VALIDATED output
    // is returned so multi-field surfaces adopt every field; single-text
    // callers derive their string through this same selector.
    text(data: T): string;
  },
): Promise<T | null> {
  if (!gateway) return null;
  if (!(await isFeatureEnabled(CLERK_FLAG_KEY))) return null;
  if (tenant) {
    try {
      await assertFirmClerkBudget(tenant);
    } catch {
      return null;
    }
  }
  try {
    const data = await inferPhrasing<T>(gateway, {
      purpose: opts.purpose,
      firmId: tenant,
      promptVersion: opts.promptVersion,
      system: opts.system,
      user: opts.user,
      schemaName: opts.schemaName,
      jsonSchema: opts.jsonSchema,
      validator: opts.validator,
      inputForHash: opts.inputForHash,
    });
    if (!data) return null;
    const text = opts.text(data);
    // Number grounding: a numeral the facts never stated → template answers
    // (grounding.ts). The allowed source is the exact composed user prompt.
    if (
      !(await ensureGrounded(opts.groundingSurface, tenant, text, opts.user))
    ) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}
