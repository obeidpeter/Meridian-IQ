// Deterministic pseudonymization for eval-fixture minting (round 7). When an
// operator promotes a decided case into the eval corpus (eval-curation.ts),
// the document text may carry real party identities — names and TINs the
// platform can trace to a live client. This module replaces every known
// identity with a shaped synthetic so the stored fixture keeps its layout,
// amounts and OCR noise (what extraction quality is actually measured on)
// while carrying no client identity.
//
// Everything here is pure string work — no model, no DB, no randomness:
//  - each DISTINCT name (case-insensitive) becomes "Company A"/"Company B"/…
//    assigned in FIRST-SEEN order, so the same inputs always produce the same
//    output and repeated mentions of one party stay one pseudonym;
//  - matching is word-boundary bounded and LONGEST-FIRST, so "Golden Palm
//    Foods Ltd" claims its span before a shorter "Golden Palm" identity can
//    split it;
//  - each TIN is matched on its digit sequence tolerant of spacing/hyphens
//    ("12345678-0001", "12345678 0001", "12 345 678 0001" all hit) and
//    becomes an indexed shaped synthetic ("00000001-0001", "00000002-0001"…)
//    that still LOOKS like a TIN, so extraction behaviour on the fixture is
//    representative.
//
// createScrubber() exposes the stateful form: one scrubber shared across the
// document text AND the fixture's expected values keeps label assignment
// consistent between them (the text's "Company A" is the expected value's
// "Company A"). scrubDocumentText() is the one-shot convenience wrapper.

export interface ScrubIdentities {
  names: string[];
  tins: string[];
}

export interface ScrubResult {
  text: string;
  replacements: number;
}

export interface Scrubber {
  scrub(text: string): ScrubResult;
}

// 0 -> "Company A" … 25 -> "Company Z", 26 -> "Company AA" (spreadsheet-style,
// so the label sequence never collides however many identities show up).
function companyLabel(index: number): string {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    letters = String.fromCharCode(65 + r) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return `Company ${letters}`;
}

// Shaped synthetic TIN: an 8-digit zero-padded index plus the common "-0001"
// branch suffix — obviously fake, structurally a TIN.
function syntheticTin(index: number): string {
  return `${String(index + 1).padStart(8, "0")}-0001`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Claim {
  start: number;
  end: number;
  // "name:<lower>" or "tin:<digits>" — the label maps key on the DISTINCT
  // identity, not the matched surface form.
  key: string;
}

export function createScrubber(identities: ScrubIdentities): Scrubber {
  // Distinct names, case-insensitive, blank-dropped; matched longest-first so
  // an identity that contains another claims its whole span.
  const seenNames = new Set<string>();
  const names: string[] = [];
  for (const raw of identities.names) {
    const name = raw?.trim();
    if (!name || name.length < 2) continue;
    const key = name.toLowerCase();
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    names.push(name);
  }
  names.sort((a, b) => b.length - a.length);

  // TINs normalize to their digit sequence; anything under 6 digits is too
  // short to match safely (it would hit ordinary amounts).
  const tins: string[] = [];
  const seenTins = new Set<string>();
  for (const raw of identities.tins) {
    const digits = (raw ?? "").replace(/\D/g, "");
    if (digits.length < 6 || seenTins.has(digits)) continue;
    seenTins.add(digits);
    tins.push(digits);
  }
  tins.sort((a, b) => b.length - a.length);

  // Label assignment survives across scrub() calls (first-seen order across
  // the whole scrubber lifetime) — that is what keeps a fixture's text and
  // its expected values on the same pseudonyms.
  const labels = new Map<string, string>();
  let nameCount = 0;
  let tinCount = 0;
  const labelFor = (key: string): string => {
    let label = labels.get(key);
    if (!label) {
      label = key.startsWith("name:")
        ? companyLabel(nameCount++)
        : syntheticTin(tinCount++);
      labels.set(key, label);
    }
    return label;
  };

  function scrub(text: string): ScrubResult {
    const claims: Claim[] = [];
    const overlaps = (start: number, end: number): boolean =>
      claims.some((c) => start < c.end && end > c.start);

    // Names first (longest-first): custom letter/digit boundaries rather than
    // \b because legal names carry spaces, "&" and ".".
    for (const name of names) {
      const re = new RegExp(
        `(?<![A-Za-z0-9])${escapeRegExp(name)}(?![A-Za-z0-9])`,
        "gi",
      );
      for (const m of text.matchAll(re)) {
        const start = m.index;
        const end = start + m[0].length;
        if (!overlaps(start, end)) {
          claims.push({ start, end, key: `name:${name.toLowerCase()}` });
        }
      }
    }
    // TINs: the digit sequence with optional spacing/hyphens between digits,
    // digit-bounded so a longer number containing the TIN is left alone.
    for (const tin of tins) {
      const re = new RegExp(
        `(?<!\\d)${tin.split("").join("[\\s-]*")}(?!\\d)`,
        "g",
      );
      for (const m of text.matchAll(re)) {
        const start = m.index;
        const end = start + m[0].length;
        if (!overlaps(start, end)) {
          claims.push({ start, end, key: `tin:${tin}` });
        }
      }
    }

    // Rebuild left-to-right; label allocation order IS first-seen order.
    claims.sort((a, b) => a.start - b.start);
    let out = "";
    let cursor = 0;
    for (const claim of claims) {
      out += text.slice(cursor, claim.start) + labelFor(claim.key);
      cursor = claim.end;
    }
    out += text.slice(cursor);
    return { text: out, replacements: claims.length };
  }

  return { scrub };
}

// One-shot form: scrub a single text with a fresh scrubber.
export function scrubDocumentText(
  text: string,
  identities: ScrubIdentities,
): ScrubResult {
  return createScrubber(identities).scrub(text);
}
