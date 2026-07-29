import { appendAudit } from "../audit/audit";
import { logger } from "../../lib/logger";

// Number grounding (round-17 idea #1). The Clerk covenant says deterministic
// code owns every number and the model only PHRASES — this module turns that
// promise into an enforced invariant. Every phrasing surface (digest, monthly
// statement, chaser, escalation reply, narrative, VAT/quarterly/pack notes)
// runs its model output through numberGroundingViolations against the SAME
// user prompt it sent: a numeral in the output that does not appear in the
// prompt is a violation, and the surface answers with its deterministic
// template instead — the safe direction, because the template always answers.
//
// Matching is deliberately format-tolerant but value-exact: "₦45,000.00",
// "NGN 45000" and "45,000" all canonicalize to "45000"; "7.50%" and "7.5"
// meet at "7.5". A violation therefore means a NUMBER the facts never
// stated, not a formatting choice. Words ("two invoices") are not checked —
// spelled-out numbers carry the model's own arithmetic nowhere the platform
// promises precision.
//
// Zero model calls, nothing stored beyond a pointer-only audit event per
// violation (surface name + count — never the numbers themselves, which
// could carry amounts); the health page counts those events.

export const GROUNDING_VIOLATION_ACTION = "clerk.grounding.violation";

// A numeral token: digits with optional comma thousand-groups and an
// optional decimal tail. Hyphens/colons split dates and times into their
// parts, which canonicalize symmetrically on both sides.
const TOKEN_RE = /\d[\d,]*(?:\.\d+)?/g;

// Canonical value form: commas stripped; trailing decimal zeros (then a bare
// trailing point) stripped; leading zeros stripped. "45,000.00" → "45000",
// "07" → "7", "7.50" → "7.5", "0" → "0".
export function canonNumeral(raw: string): string {
  let s = raw.replace(/,/g, "");
  if (s.includes(".")) {
    s = s.replace(/0+$/, "").replace(/\.$/, "");
  }
  s = s.replace(/^0+(?=\d)/, "");
  return s;
}

export function extractNumerals(text: string): string[] {
  return (text.match(TOKEN_RE) ?? []).map(canonNumeral);
}

// The canonical numerals present in `output` but absent from
// `allowedSource` (the exact user prompt the surface sent). Pure, exported
// for tests.
export function numberGroundingViolations(
  output: string,
  allowedSource: string,
): string[] {
  const allowed = new Set(extractNumerals(allowedSource));
  return [...new Set(extractNumerals(output))].filter((n) => !allowed.has(n));
}

// The enforcement seam every phrasing surface calls after a successful
// inference: true = grounded, use the model's text; false = a violation was
// recorded and the surface must answer with its template. The audit write is
// best-effort — if the ledger itself fails, the surface STILL falls back
// (the check's verdict never depends on the bookkeeping).
export async function ensureGrounded(
  surface: string,
  firmId: string | null,
  output: string,
  allowedSource: string,
): Promise<boolean> {
  const violations = numberGroundingViolations(output, allowedSource);
  if (violations.length === 0) return true;
  try {
    await appendAudit({
      firmId,
      action: GROUNDING_VIOLATION_ACTION,
      entityType: "clerk_surface",
      entityId: surface,
      after: { surface, violations: violations.length },
    });
  } catch (err) {
    logger.error({ err, surface }, "grounding violation audit failed");
  }
  return false;
}
