import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDb, firmsTable } from "@workspace/db";
import { draftClientImportWithClerk } from "./draft-client-import.ts";
import type { CompletionRequest } from "./gateway.ts";
import {
  fakeGateway,
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "./test-support.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Customer-list import drafting (exhaust idea #4). Pinned invariants:
//  - Clerk only NAMES columns; every proposal is re-verified against the
//  headers that literally exist (a hallucinated required column fails closed,
//  a hallucinated optional one is dropped);
//  - the rows returned are produced by the deterministic mapper, never by the
//  model — a mapping that parses nothing is no draft at all;
//  - the sample travels only inside the untrusted-data fence.

const SALT = makeRunSalt();
const firmId = randomUUID();

// A practice-management export: preamble line, then renamed headers.
const SAMPLE = [
  `Client book export ${SALT},,,,,,`,
  "Customer Name,TIN No.,RC Number,E-mail,Address Line,Town,Service",
  `"Adaeze Foods ${SALT} Ltd",12345678-0001,RC123456,ops@adaeze.example,"12, Allen Avenue",Ikeja,Retainer`,
  `"Bello & Sons ${SALT}",98765432-0001,,bello@bello.example,3 Marina Rd,Lagos,VAT filing`,
  `,,,,,,`,
  `"",11111111-0001,,orphan@row.example,No Name Street,Aba,Retainer`,
].join("\n");

const GOOD_PROPOSAL = JSON.stringify({
  legalName: "Customer Name",
  tin: "TIN No.",
  cacNumber: "RC Number",
  email: "E-mail",
  street: "Address Line",
  city: "Town",
  engagementTitle: "Service",
});

before(async () => {
  await saveAndEnableClerkFlag();
  await getDb()
    .insert(firmsTable)
    .values({ id: firmId, name: `Import Firm ${SALT}` });
});

after(async () => {
  await restoreClerkFlag();
});

test("happy path: verified mapping, deterministic rows, fenced sample", async () => {
  const calls: CompletionRequest[] = [];
  const draft = await draftClientImportWithClerk(
    SAMPLE,
    firmId,
    fakeGateway((req) => {
      calls.push(req);
      return GOOD_PROPOSAL;
    }),
  );
  assert.equal(draft.columns.legalName, "Customer Name");
  assert.equal(draft.columns.engagementTitle, "Service");
  // The mapper found the header row past the preamble and skipped the
  // blank/nameless rows — a row without a client name proposes nothing.
  assert.equal(draft.rows.length, 2);
  assert.equal(draft.rows[0].legalName, `Adaeze Foods ${SALT} Ltd`);
  assert.equal(draft.rows[0].street, "12, Allen Avenue");
  assert.equal(draft.rows[1].cacNumber, undefined, "empty cell = absent");
  assert.equal(draft.validation.headerFound, true);
  assert.equal(draft.validation.parsedCount, 2);
  // The sample is untrusted data and travels only inside the fence.
  assert.ok((calls[0].user as string).includes("-----BEGIN SAMPLE-----"));
});

test("a hallucinated required column fails closed — no draft", async () => {
  await assert.rejects(
    draftClientImportWithClerk(
      SAMPLE,
      firmId,
      fakeGateway(() =>
        JSON.stringify({
          ...JSON.parse(GOOD_PROPOSAL),
          legalName: "Client Legal Title", // not in the sample
        }),
      ),
    ),
    (err: Error & { code?: string; status?: number }) =>
      err.code === "CLERK_DRAFT_FAILED" && err.status === 502,
  );
});

test("a hallucinated optional column is dropped, the draft survives", async () => {
  const draft = await draftClientImportWithClerk(
    SAMPLE,
    firmId,
    fakeGateway(() =>
      JSON.stringify({
        ...JSON.parse(GOOD_PROPOSAL),
        email: "Electronic Mail Address", // not in the sample
      }),
    ),
  );
  assert.equal(draft.columns.email, null);
  assert.equal(draft.rows[0].email, undefined);
  assert.equal(draft.rows.length, 2, "the rest of the mapping still parses");
});

test("discarded model output is a clean 502, never a partial draft", async () => {
  await assert.rejects(
    draftClientImportWithClerk(SAMPLE, firmId, fakeGateway(() => "not json")),
    (err: Error & { code?: string; status?: number }) =>
      err.code === "CLERK_DRAFT_FAILED" && err.status === 502,
  );
});

test("a preamble label repeating the header text cannot hijack the header row", async () => {
  // The decoy row contains ONLY the legalName text; the real header row
  // resolves all seven proposals, so best-overall-match picks it.
  const decoyed = [
    `Customer Name,,,,,,`,
    "Customer Name,TIN No.,RC Number,E-mail,Address Line,Town,Service",
    `"Adaeze Foods ${SALT} Ltd",12345678-0001,RC123456,ops@adaeze.example,"12, Allen Avenue",Ikeja,Retainer`,
  ].join("\n");
  const draft = await draftClientImportWithClerk(
    decoyed,
    firmId,
    fakeGateway(() => GOOD_PROPOSAL),
  );
  assert.equal(draft.rows.length, 1);
  assert.equal(draft.rows[0].legalName, `Adaeze Foods ${SALT} Ltd`);
  assert.equal(draft.rows[0].city, "Ikeja", "columns resolved on the real header");
});

test("a data cell cannot vouch for a proposed column", async () => {
  // "Ikeja" exists as a data value but is not a header — the proposal is
  // dropped to null instead of silently resolving against a data row.
  const draft = await draftClientImportWithClerk(
    SAMPLE,
    firmId,
    fakeGateway(() =>
      JSON.stringify({ ...JSON.parse(GOOD_PROPOSAL), city: "Ikeja" }),
    ),
  );
  assert.equal(draft.columns.city, null);
  assert.equal(draft.rows[0].city, undefined);
  assert.equal(draft.rows.length, 2);
});

test("a proposal matching two identical headers is ambiguous and dropped", async () => {
  const doubled = [
    "Customer Name,E-mail,E-mail",
    `"Adaeze Foods ${SALT} Ltd",primary@adaeze.example,billing@adaeze.example`,
  ].join("\n");
  const draft = await draftClientImportWithClerk(
    doubled,
    firmId,
    fakeGateway(() =>
      JSON.stringify({
        legalName: "Customer Name",
        tin: null,
        cacNumber: null,
        email: "E-mail",
        street: null,
        city: null,
        engagementTitle: null,
      }),
    ),
  );
  assert.equal(draft.columns.email, null, "ambiguous column resolves to nothing");
  assert.equal(draft.rows[0].legalName, `Adaeze Foods ${SALT} Ltd`);
});

test("size and emptiness are checked before any model call", async () => {
  let calls = 0;
  const counting = fakeGateway(() => {
    calls += 1;
    return GOOD_PROPOSAL;
  });
  await assert.rejects(
    draftClientImportWithClerk("x".repeat(20_001), firmId, counting),
    (err: Error & { code?: string; status?: number }) =>
      err.code === "SAMPLE_TOO_LARGE" && err.status === 413,
  );
  await assert.rejects(
    draftClientImportWithClerk("just one line", firmId, counting),
    (err: Error & { code?: string; status?: number }) =>
      err.code === "SAMPLE_EMPTY" && err.status === 422,
  );
  assert.equal(calls, 0, "no tokens spent on an unusable sample");
});
