import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  firmsTable,
  partiesTable,
  invoicesTable,
  submissionAttemptsTable,
} from "@workspace/db";
import { draftVatCoverNote, templateVatNote, vatNoteFacts } from "./vat-note.ts";
import { computeVatPack } from "./vat-pack.ts";
import { lagosMonthStart } from "./client-statement.ts";
import {
  fakeGateway,
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "./test-support.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// VAT filing cover note (round-4 idea #6). Pinned invariants:
//  - every figure in the prompt comes from the computed pack; the template
//  always answers (missing gateway, invalid output, quiet month);
//  - a month with no accepted activity never calls the provider — spending
//  tokens to say "nothing happened" is the digest anti-pattern;
//  - the pack's basis disclosure travels with the note.

const SALT = makeRunSalt();
const firmId = randomUUID();
const clientId = randomUUID();
const buyer = randomUUID();
const MONTH = lagosMonthStart(1);
const QUIET_MONTH = lagosMonthStart(6);

before(async () => {
  await saveAndEnableClerkFlag();
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmId, name: `Note Firm ${SALT}` });
  await db.insert(partiesTable).values([
    { id: clientId, type: "client_business", legalName: `Note Client ${SALT}` },
    { id: buyer, type: "buyer", legalName: `Note Buyer ${SALT}` },
  ]);
  const invoiceId = randomUUID();
  await db.insert(invoicesTable).values({
    id: invoiceId,
    firmId,
    supplierPartyId: clientId,
    buyerPartyId: buyer,
    invoiceNumber: `NOTE-${SALT}`,
    issueDate: `${MONTH.slice(0, 7)}-10`,
    status: "stamped" as never,
    grandTotal: "1075.00",
    vatTotal: "75.00",
  });
  await db.insert(submissionAttemptsTable).values({
    invoiceId,
    rail: "rail_primary",
    attemptNo: 1,
    idempotencyKey: `note-${SALT}`,
    status: "accepted",
  });
});

after(async () => {
  await restoreClerkFlag();
});

test("template + facts are grounded in the pack's own numbers", async () => {
  const pack = await computeVatPack(firmId, MONTH);
  const template = templateVatNote(pack);
  assert.ok(template.includes(pack.monthLabel));
  assert.ok(template.includes(pack.totals.netVat));
  const facts = vatNoteFacts(pack);
  assert.ok(facts.includes(`Net output VAT: NGN ${pack.totals.netVat}`));
  assert.ok(facts.includes("Basis note:"), "the disclosure reaches the model");
});

test("clerk path phrases; invalid output and missing gateway fall back", async () => {
  const drafted = await draftVatCoverNote(
    firmId,
    MONTH,
    fakeGateway(() => JSON.stringify({ note: `Phrased note ${SALT}` })),
  );
  assert.equal(drafted.source, "clerk");
  assert.equal(drafted.note, `Phrased note ${SALT}`);
  assert.ok(drafted.disclosure.includes("preparation aid"), "disclosure rides along");

  const invalid = await draftVatCoverNote(firmId, MONTH, fakeGateway(() => "not json"));
  assert.equal(invalid.source, "template");
  assert.ok(invalid.note.length > 0);

  const noGateway = await draftVatCoverNote(firmId, MONTH, null);
  assert.equal(noGateway.source, "template");
});

test("a quiet month answers with the template and never calls the provider", async () => {
  let calls = 0;
  const drafted = await draftVatCoverNote(
    firmId,
    QUIET_MONTH,
    fakeGateway(() => {
      calls += 1;
      return JSON.stringify({ note: "should not run" });
    }),
  );
  assert.equal(drafted.source, "template");
  assert.equal(calls, 0, "no tokens spent on an empty month");
});
