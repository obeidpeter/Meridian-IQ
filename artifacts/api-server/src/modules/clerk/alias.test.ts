import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDb, firmsTable, partiesTable } from "@workspace/db";
import { aliasKey, lookupPartyAlias, recordPartyAliases } from "./alias.ts";
import { applyAlias } from "./party-match.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Party alias memory (exhaust idea #6). Pinned invariants:
//  - the key normalization treats word order, case, punctuation and legal-form
//  suffixes as noise, so a document's "ADAEZE FOODS" and the register's
//  "Adaeze Foods Ltd" share one memory;
//  - an alias identical to the register name teaches nothing and is skipped;
//  - the newest human confirmation wins when a name is re-pointed;
//  - memories are firm-private: another firm's lookup sees nothing.

const SALT = makeRunSalt();

const firmId = randomUUID();
const otherFirmId = randomUUID();
const partyA = randomUUID();
const partyB = randomUUID();

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values([
    { id: firmId, name: `Alias Firm ${SALT}` },
    { id: otherFirmId, name: `Alias Other Firm ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    {
      id: partyA,
      type: "buyer",
      legalName: `Dangote Cement ${SALT} Plc`,
    },
    {
      id: partyB,
      type: "buyer",
      legalName: `Lafarge Africa ${SALT} Plc`,
    },
  ]);
});

test("aliasKey: order, case, punctuation and legal suffixes are noise", () => {
  assert.equal(aliasKey("Adaeze Foods Ltd"), "ADAEZE FOODS");
  assert.equal(aliasKey("FOODS, adaeze!"), "ADAEZE FOODS");
  assert.equal(
    aliasKey("The Adaeze Foods Company Limited"),
    aliasKey("adaeze foods"),
  );
  // Duplicated tokens collapse.
  assert.equal(aliasKey("Adaeze Adaeze Foods"), "ADAEZE FOODS");
});

test("aliasKey: names with no identity produce no key", () => {
  assert.equal(aliasKey(null), null);
  assert.equal(aliasKey(""), null);
  assert.equal(aliasKey("Ltd Co The"), null, "all-generic tokens");
  assert.equal(aliasKey("ab & co"), null, "under the 4-char floor");
});

test("record + lookup round trip, scoped to the recording firm", async () => {
  await recordPartyAliases(firmId, [
    {
      extractedName: `DANGOTE CEM ${SALT}`,
      partyId: partyA,
      partyLegalName: `Dangote Cement ${SALT} Plc`,
    },
  ]);
  assert.equal(await lookupPartyAlias(firmId, `Dangote Cem ${SALT}`), partyA);
  assert.equal(
    await lookupPartyAlias(firmId, `cem ${SALT} dangote`),
    partyA,
    "word order is normalized away",
  );
  // SEC: memories never cross firms.
  assert.equal(await lookupPartyAlias(otherFirmId, `DANGOTE CEM ${SALT}`), null);
  // A name nobody taught stays unknown.
  assert.equal(await lookupPartyAlias(firmId, `BUA Cement ${SALT}`), null);
});

test("an alias identical to the register name is not stored", async () => {
  await recordPartyAliases(firmId, [
    {
      extractedName: `Lafarge Africa ${SALT} PLC`,
      partyId: partyB,
      partyLegalName: `Lafarge Africa ${SALT} Plc`,
    },
  ]);
  assert.equal(
    await lookupPartyAlias(firmId, `Lafarge Africa ${SALT}`),
    null,
    "ordinary matching already finds the register name",
  );
});

test("newest confirmation wins when a name is re-pointed", async () => {
  const alias = `WACO Industries ${SALT}`;
  await recordPartyAliases(firmId, [
    {
      extractedName: alias,
      partyId: partyA,
      partyLegalName: `Dangote Cement ${SALT} Plc`,
    },
  ]);
  assert.equal(await lookupPartyAlias(firmId, alias), partyA);
  await recordPartyAliases(firmId, [
    {
      extractedName: alias,
      partyId: partyB,
      partyLegalName: `Lafarge Africa ${SALT} Plc`,
    },
  ]);
  assert.equal(await lookupPartyAlias(firmId, alias), partyB);
});

test("applyAlias nominates, the candidate set decides", async () => {
  const name = `Golden Harvest ${SALT}`;
  await recordPartyAliases(firmId, [
    {
      extractedName: name,
      partyId: partyA,
      partyLegalName: `Dangote Cement ${SALT} Plc`,
    },
  ]);
  const candidates = [
    {
      id: partyA,
      legalName: `Dangote Cement ${SALT} Plc`,
      tin: null,
      type: "buyer" as const,
    },
  ];

  // Remembered + in the candidate set: the alias leads at full confidence.
  const suggestions = await applyAlias(firmId, name, [], candidates);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].partyId, partyA);
  assert.equal(suggestions[0].viaAlias, true);
  assert.equal(suggestions[0].confidence, 1);

  // Remembered but NOT in the caller's candidate set (wrong type, merged,
  // out of sphere): the memory is ignored — the caller's filters decide.
  const filtered = await applyAlias(firmId, name, [], []);
  assert.equal(filtered.length, 0);

  // The alias dedups against a scored suggestion for the same party rather
  // than listing it twice.
  const scored = [
    {
      partyId: partyA,
      legalName: `Dangote Cement ${SALT} Plc`,
      tin: null,
      type: "buyer",
      confidence: 0.4,
      tinScore: 0,
      nameScore: 1,
    },
  ];
  const deduped = await applyAlias(firmId, name, scored, candidates);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].viaAlias, true);
});

test("no firm means no memory in either direction", async () => {
  await recordPartyAliases(null, [
    {
      extractedName: `Orphan ${SALT}`,
      partyId: partyA,
      partyLegalName: "Different",
    },
  ]);
  assert.equal(await lookupPartyAlias(null, `Orphan ${SALT}`), null);
  assert.equal(await lookupPartyAlias(firmId, `Orphan ${SALT}`), null);
});
