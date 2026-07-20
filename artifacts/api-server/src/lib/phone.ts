// Shared E.164-ish phone normalizer (Nigeria-first). Both sides of every
// phone comparison MUST go through this one function — the inbound WhatsApp
// rail normalizes the webhook's sender AND the free-text values stored on
// alert_preferences at compare time, so "0803 123 4567", "0803-123-4567" and
// "+234 803 123 4567" all resolve to the same identity. A drifted second
// normalizer would silently break that matching.
//
// Rules (deterministic, deliberately narrow):
//  - strip spaces, dashes and parentheses;
//  - a single leading "+" is allowed and removed; a "+" anywhere else (or any
//    other non-digit) rejects;
//  - Nigerian local convention: a bare 11-digit number starting with 0
//    (0XXXXXXXXXX) becomes +234XXXXXXXXXX;
//  - anything not 8–15 digits after normalization rejects (E.164 caps
//    subscriber numbers at 15 digits).
//
// Returns the canonical "+<digits>" form, or null when the input cannot be a
// phone number.
export function normalizePhone(raw: string): string | null {
  const stripped = raw.trim().replace(/[\s\-()]/g, "");
  if (!stripped) return null;
  const hasPlus = stripped.startsWith("+");
  let digits = hasPlus ? stripped.slice(1) : stripped;
  if (!/^\d+$/.test(digits)) return null;
  if (!hasPlus && digits.length === 11 && digits.startsWith("0")) {
    digits = `234${digits.slice(1)}`;
  }
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}
