import { test } from "node:test";
import assert from "node:assert/strict";
import { createScrubber, scrubDocumentText } from "./scrub.ts";

// Deterministic pseudonymization (round 7). Invariants pinned here:
//  - every occurrence of a known name/TIN is replaced; repeated mentions of
//    one identity share one pseudonym; labels assign in first-seen order;
//  - matching is case-insensitive, word-boundary bounded, and longest-first
//    (an identity containing another claims its whole span);
//  - TINs match on their digit sequence tolerant of spacing/hyphens and are
//    replaced by shaped, indexed synthetics;
//  - the function is pure: same inputs, same output, no randomness.

test("multi-occurrence: every mention replaced with ONE stable pseudonym", () => {
  const text = [
    "Supplier: Adaeze Foods Ltd",
    "Remit to ADAEZE FOODS LTD, Lagos",
    "Contact adaeze foods ltd for disputes",
  ].join("\n");
  const { text: out, replacements } = scrubDocumentText(text, {
    names: ["Adaeze Foods Ltd"],
    tins: [],
  });
  assert.equal(replacements, 3);
  assert.ok(!/adaeze/i.test(out), "no trace of the raw name survives");
  assert.equal(out.match(/Company A/g)?.length, 3, "one pseudonym, reused");
});

test("labels assign in first-seen order, not identity-list order", () => {
  const text = "Bill To: Buyer Co\nFrom: Vendor Co";
  const { text: out } = scrubDocumentText(text, {
    // Supplier listed first — but the buyer appears first in the text.
    names: ["Vendor Co", "Buyer Co"],
    tins: [],
  });
  assert.equal(out, "Bill To: Company A\nFrom: Company B");
});

test("overlapping names: the longest identity claims the span", () => {
  const text =
    "Supplier: Golden Palm Foods Ltd\nBrand: Golden Palm quality since 1998";
  const { text: out, replacements } = scrubDocumentText(text, {
    names: ["Golden Palm", "Golden Palm Foods Ltd"],
    tins: [],
  });
  assert.equal(replacements, 2);
  // The full legal name is ONE replacement (first seen -> Company A); the
  // shorter brand mention is a distinct identity (Company B).
  assert.equal(out, "Supplier: Company A\nBrand: Company B quality since 1998");
});

test("word boundaries: an identity inside a longer word is left alone", () => {
  const { text: out, replacements } = scrubDocumentText(
    "Acme and Acmex and MegaAcme",
    { names: ["Acme"], tins: [] },
  );
  assert.equal(replacements, 1);
  assert.equal(out, "Company A and Acmex and MegaAcme");
});

test("TIN formats: spacing/hyphen variants of one TIN all match", () => {
  const text = [
    "TIN: 12345678-0001",
    "Tax ID 12345678 0001",
    "tin no. 12 345 678 - 0001",
    "Buyer TIN: 87654321-0001",
  ].join("\n");
  const { text: out, replacements } = scrubDocumentText(text, {
    names: [],
    tins: ["12345678-0001", "87654321-0001"],
  });
  assert.equal(replacements, 4);
  assert.ok(!out.includes("12345678") && !/12\s*345\s*678/.test(out));
  assert.ok(!out.includes("87654321"));
  // Indexed shaped synthetics, first-seen order.
  assert.equal(out.match(/00000001-0001/g)?.length, 3);
  assert.equal(out.match(/00000002-0001/g)?.length, 1);
});

test("TIN digit boundaries: a longer number containing the TIN is untouched", () => {
  const { text: out, replacements } = scrubDocumentText(
    "Ref 912345678-00013 vs TIN 12345678-0001",
    { names: [], tins: ["12345678-0001"] },
  );
  assert.equal(replacements, 1);
  assert.ok(out.includes("912345678-00013"), "embedded digits left alone");
  assert.ok(out.includes("TIN 00000001-0001"));
});

test("deterministic and pure: identical inputs give identical outputs", () => {
  const identities = {
    names: ["Kola Motors Nig Ltd", "Funke Ajayi"],
    tins: ["20304050-0001"],
  };
  const text = "Kola Motors Nig Ltd (TIN 20304050-0001) sold to Funke Ajayi";
  const a = scrubDocumentText(text, identities);
  const b = scrubDocumentText(text, identities);
  assert.deepEqual(a, b);
  assert.equal(
    a.text,
    "Company A (TIN 00000001-0001) sold to Company B",
  );
});

test("a shared scrubber keeps text and expected values on the same labels", () => {
  const scrubber = createScrubber({
    names: ["Beta Traders", "Alpha Works Ltd"],
    tins: ["11223344-0001"],
  });
  // Text mentions Beta first -> Company A.
  const doc = scrubber.scrub("From Beta Traders to Alpha Works Ltd");
  assert.equal(doc.text, "From Company A to Company B");
  // A later value scrub reuses the assignment instead of restarting at A.
  assert.equal(scrubber.scrub("Alpha Works Ltd").text, "Company B");
  assert.equal(scrubber.scrub("11223344-0001").text, "00000001-0001");
});

test("degenerate identities: blanks, short TINs and empty lists are no-ops", () => {
  const text = "INVOICE 123 for NGN 5,000";
  assert.deepEqual(scrubDocumentText(text, { names: [], tins: [] }), {
    text,
    replacements: 0,
  });
  assert.deepEqual(
    scrubDocumentText(text, { names: ["", "  "], tins: ["123", ""] }),
    { text, replacements: 0 },
  );
});

test("label sequence extends past Z (spreadsheet style)", () => {
  const names = Array.from({ length: 28 }, (_, i) => `Uniqco${i} Ltd`);
  const text = names.join(", ");
  const { text: out } = scrubDocumentText(text, { names, tins: [] });
  assert.ok(out.includes("Company Z"));
  assert.ok(out.includes("Company AA"));
  assert.ok(out.includes("Company AB"));
});
