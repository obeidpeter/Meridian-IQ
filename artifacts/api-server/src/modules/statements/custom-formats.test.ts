import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  getDb,
  statementFormatMappingsTable,
  usersTable,
} from "@workspace/db";
import {
  parseWithCustomFormats,
  saveFormatMapping,
  validateMapping,
} from "./custom-formats.ts";
import { draftFormatMappingWithClerk } from "../clerk/draft-format.ts";
import type { CompletionRequest } from "../clerk/gateway.ts";
import {
  fakeGateway,
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "../clerk/test-support.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Custom statement formats (idea #9). Pinned invariants:
//  - a mapping that cannot parse its own sample can NEVER be stored;
//  - Clerk's proposals are re-verified against the headers that actually
//  exist (a hallucinated column fails closed) and validated by the
//  deterministic parser before anything reaches an operator's save button;
//  - stored mappings feed the same detect-then-parse contract as the
//  built-in banks.

const SALT = makeRunSalt();
const actorId = randomUUID();

// A made-up bank export the built-in parsers do not recognise.
const SAMPLE = [
  "Posting Day,Details,Ref,Money In,Money Out",
  `05/07/2026,TRF FROM ADAEZE ${SALT},R1,150000.00,`,
  `06/07/2026,POS PURCHASE ${SALT},R2,,25000.00`,
].join("\n");

const GOOD_COLUMNS = {
  date: "Posting Day",
  narration: "Details",
  reference: "Ref",
  debit: "Money Out",
  credit: "Money In",
  amount: null,
  drcr: null,
};

before(async () => {
  await saveAndEnableClerkFlag();
  await getDb()
    .insert(usersTable)
    .values({ id: actorId, email: `fmt-${SALT}@test.example` })
    .onConflictDoNothing();
});

after(async () => {
  await restoreClerkFlag();
});

test("validateMapping parses the sample with located columns", () => {
  const v = validateMapping(GOOD_COLUMNS, SAMPLE);
  assert.equal(v.headerFound, true);
  assert.equal(v.lineCount, 2);
  assert.equal(v.parsedCount, 2);
  assert.equal(v.preview[0].direction, "credit");
  assert.equal(v.preview[1].direction, "debit");
  assert.equal(v.preview[0].valueDate, "2026-07-05");
});

test("a mapping that cannot parse its sample is rejected, never stored", async () => {
  await assert.rejects(
    saveFormatMapping(
      {
        bankName: `Nowhere Bank ${SALT}`,
        columns: { ...GOOD_COLUMNS, date: "No Such Column" },
        sampleCsv: SAMPLE,
      },
      actorId,
    ),
    (err: Error & { code?: string }) => err.code === "MAPPING_INVALID",
  );
  const rows = await getDb()
    .select()
    .from(statementFormatMappingsTable)
    .where(eq(statementFormatMappingsTable.bankName, `Nowhere Bank ${SALT}`));
  assert.equal(rows.length, 0);
});

test("save + ingest round trip: the stored mapping parses new statements", async () => {
  const { mapping, validation } = await saveFormatMapping(
    {
      bankName: `Keystone Test ${SALT}`,
      columns: GOOD_COLUMNS,
      sampleCsv: SAMPLE,
    },
    actorId,
  );
  assert.ok(mapping.key.startsWith("custom_"));
  assert.equal(validation.parsedCount, 2);

  // Detection path (no formatKey): a stored mapping recognises this export.
  // (Not asserted to be THIS run's mapping: an earlier test run may have
  // stored an equivalent one, and oldest-first detection order means either
  // parses identically.)
  const detected = await parseWithCustomFormats(SAMPLE);
  assert.ok(detected);
  assert.ok(detected.formatKey.startsWith("custom_"));
  assert.equal(detected.parsedCount, 2);

  // Explicit-key path.
  const explicit = await parseWithCustomFormats(SAMPLE, mapping.key);
  assert.equal(explicit?.parsedCount, 2);

  // Duplicate key is a clean 409.
  await assert.rejects(
    saveFormatMapping(
      {
        key: mapping.key,
        bankName: "Again",
        columns: GOOD_COLUMNS,
        sampleCsv: SAMPLE,
      },
      actorId,
    ),
    (err: Error & { code?: string }) => err.code === "KEY_EXISTS",
  );
});

test("keys outside the custom namespace are refused", async () => {
  await assert.rejects(
    saveFormatMapping(
      {
        key: "gtb_csv",
        bankName: "Impostor",
        columns: GOOD_COLUMNS,
        sampleCsv: SAMPLE,
      },
      actorId,
    ),
    (err: Error & { code?: string }) => err.code === "KEY_NOT_NAMESPACED",
  );
});

test("Clerk's proposal is header-verified and parser-validated", async () => {
  const calls: CompletionRequest[] = [];
  const draft = await draftFormatMappingWithClerk(
    SAMPLE,
    fakeGateway((req) => {
      calls.push(req);
      return JSON.stringify({
        bankName: "Keystone",
        date: "Posting Day",
        narration: "Details",
        reference: "Ref",
        debit: "Money Out",
        credit: "Money In",
        amount: null,
        drcr: null,
      });
    }),
  );
  assert.equal(draft.columns.date, "Posting Day");
  assert.equal(draft.validation.parsedCount, 2, "the parser proves the draft");
  // The sample is untrusted data and travels only inside the fence.
  assert.ok((calls[0].user as string).includes("-----BEGIN SAMPLE-----"));
});

test("a hallucinated required column fails closed", async () => {
  await assert.rejects(
    draftFormatMappingWithClerk(
      SAMPLE,
      fakeGateway(() =>
        JSON.stringify({
          bankName: "Keystone",
          date: "Transaction Moment", // not in the sample
          narration: "Details",
          reference: null,
          debit: null,
          credit: "Money In",
          amount: null,
          drcr: null,
        }),
      ),
    ),
    (err: Error & { code?: string; status?: number }) =>
      err.code === "CLERK_DRAFT_FAILED" && err.status === 502,
  );
});
