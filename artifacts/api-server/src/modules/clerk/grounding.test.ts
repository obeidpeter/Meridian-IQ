import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb, auditEventsTable, firmsTable } from "@workspace/db";
import {
  GROUNDING_VIOLATION_ACTION,
  canonNumeral,
  ensureGrounded,
  extractNumerals,
  numberGroundingViolations,
} from "./grounding.ts";
import { generateFirmDigest } from "./digest.ts";
import {
  fakeGateway,
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "./test-support.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Number grounding (round-17 idea #1). Pinned here:
//  - canonicalization is format-tolerant but value-exact: separators,
//    trailing decimal zeros and leading zeros are noise, digits are not;
//  - a numeral in the output that the fact text never stated is a violation;
//  - date/time parts compare symmetrically (both sides split the same way);
//  - the enforcement seam records ONE pointer-only audit event per violating
//    output (surface + count, never the numbers) and returns false;
//  - end to end: a phrased digest carrying an invented number is REPLACED by
//    the deterministic template.

const SALT = makeRunSalt();

test("canonNumeral: separators, trailing zeros and leading zeros are noise", () => {
  assert.equal(canonNumeral("45,000.00"), "45000");
  assert.equal(canonNumeral("45000"), "45000");
  assert.equal(canonNumeral("7.50"), "7.5");
  assert.equal(canonNumeral("07"), "7");
  assert.equal(canonNumeral("0"), "0");
  assert.equal(canonNumeral("0.50"), "0.5");
  assert.equal(canonNumeral("100"), "100");
});

test("extractNumerals splits dates and times into symmetric parts", () => {
  assert.deepEqual(extractNumerals("due 2026-06-21 at 09:00"), [
    "2026",
    "6",
    "21",
    "9",
    "0",
  ]);
});

test("grounded output passes whatever its formatting", () => {
  const facts = [
    "Net VAT position: NGN 45000.00",
    "Rate applied: 7.50 percent",
    "Next VAT return due: 2026-06-21",
    "Invoices issued: 3",
  ].join("\n");
  assert.deepEqual(
    numberGroundingViolations(
      "Your net VAT is ₦45,000 at 7.5%, covering 3 invoices — the return falls due on the 21st.",
      facts,
    ),
    [],
  );
});

test("an invented or mangled numeral is a violation", () => {
  const facts = "Net VAT position: NGN 45000.00";
  assert.deepEqual(
    numberGroundingViolations("Roughly NGN 50,000 is due.", facts),
    ["50000"],
  );
  // A typo'd digit grouping is a DIFFERENT number, not a formatting choice.
  assert.deepEqual(
    numberGroundingViolations("NGN 45,0000 is due.", facts),
    ["450000"],
  );
  // Words are not checked — spelled-out numbers carry no false precision.
  assert.deepEqual(
    numberGroundingViolations("About forty-five thousand naira.", facts),
    [],
  );
});

before(async () => {
  await saveAndEnableClerkFlag();
});
after(async () => {
  await restoreClerkFlag();
});

test("ensureGrounded records one pointer-only audit event per violating output", async () => {
  const surface = `test_surface_${SALT}`;
  assert.equal(
    await ensureGrounded(surface, null, "All 3 invoices accepted.", "Invoices: 3"),
    true,
  );
  assert.equal(
    await ensureGrounded(surface, null, "All 4 invoices accepted.", "Invoices: 3"),
    false,
  );
  const rows = await getDb()
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.action, GROUNDING_VIOLATION_ACTION),
        eq(auditEventsTable.entityId, surface),
      ),
    );
  assert.equal(rows.length, 1, "the grounded call left no event");
  assert.deepEqual(rows[0].after, { surface, violations: 1 });
});

test("a phrased digest carrying an invented number answers with the template", async () => {
  const firmId = randomUUID();
  await getDb()
    .insert(firmsTable)
    .values({ id: firmId, name: `Grounding Firm ${SALT}` });
  const digest = await generateFirmDigest(
    firmId,
    // Valid shape, confident tone — and a number the facts never stated.
    fakeGateway(() =>
      JSON.stringify({
        headline: "17 invoices need attention this week.",
        bullets: ["Chase the 17 open invoices today."],
      }),
    ),
  );
  assert.equal(digest.source, "template", "the invented 17 forfeits phrasing");
  assert.match(digest.headline, /on track/);
});
