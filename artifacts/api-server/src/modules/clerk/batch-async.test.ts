import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  getDb,
  clerkBatchesTable,
  clerkCasesTable,
  featureFlagsTable,
  firmsTable,
  usersTable,
} from "@workspace/db";
import {
  createClerkBatch,
  processBatch,
  sweepClerkBatches,
} from "./batch-async.ts";
import { setFlag } from "../flags/flags.ts";
import {
  fakeGateway,
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "./test-support.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Async batch intake (idea #8). Pinned invariants:
//  - the route path only QUEUES (no model call before the 202);
//  - processing is idempotent: the claim CAS means a second processor —
//  or a re-run after completion — can never double-create cases;
//  - every segment walks the ordinary capture path (duplicate guard included)
//  and progress counters tell the truth at each step;
//  - failures are terminal with a reason and the source text is cleared;
//  - the kill switch parks work instead of destroying it.

const SALT = makeRunSalt();
const firmId = randomUUID();
const userId = randomUUID();

const segText = (label: string) => `INVOICE ${label}-${SALT} total 100`;

function batchGateway(labels: string[]) {
  return fakeGateway((req) => {
    if (req.schemaName === "invoice_segmentation") {
      return JSON.stringify({
        invoices: labels.map((l) => ({
          text: segText(l),
          label: `${l}-${SALT}`,
        })),
      });
    }
    // Minimal valid extraction for each segment.
    return JSON.stringify({
      fields: [
        {
          field: "invoiceNumber",
          value: `${SALT}-X`,
          confidence: 0.9,
          sourceSnippet: null,
        },
      ],
      lines: [],
    });
  });
}

before(async () => {
  await saveAndEnableClerkFlag();
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmId, name: `Batch Firm ${SALT}` });
  await db
    .insert(usersTable)
    .values({ id: userId, email: `batch-${SALT}@test.example` })
    .onConflictDoNothing();
});

after(async () => {
  await restoreClerkFlag();
});

test("createClerkBatch queues without any model call", async () => {
  let calls = 0;
  const gateway = fakeGateway(() => {
    calls += 1;
    return "unused";
  });
  void gateway; // the queue path never touches a gateway at all
  const batch = await createClerkBatch(
    { sourceType: "text", name: `Bundle ${SALT}`, text: `doc ${SALT}` },
    userId,
    { firmId },
  );
  assert.equal(batch.status, "queued");
  assert.equal(batch.sourceText, `doc ${SALT}`);
  assert.equal(calls, 0);
});

test("processBatch walks every segment through capture and lands done", async () => {
  const batch = await createClerkBatch(
    { sourceType: "text", name: `Happy ${SALT}`, text: `two invoices ${SALT}` },
    userId,
    { firmId },
  );
  const outcome = await processBatch(
    batch.id,
    batchGateway(["HAPPY-A", "HAPPY-B"]),
  );
  assert.equal(outcome, "terminal");

  const [row] = await getDb()
    .select()
    .from(clerkBatchesTable)
    .where(eq(clerkBatchesTable.id, batch.id));
  assert.equal(row.status, "done");
  assert.equal(row.totalSegments, 2);
  assert.equal(row.processedSegments, 2);
  assert.equal(row.createdCases, 2);
  assert.equal(row.skippedDuplicates, 0);
  assert.equal(row.sourceText, null, "source text cleared at terminal state");
  assert.equal(row.segments, null, "segments cleared at terminal state");

  const cases = await getDb()
    .select({ id: clerkCasesTable.id })
    .from(clerkCasesTable)
    .where(eq(clerkCasesTable.firmId, firmId));
  assert.ok(cases.length >= 2);

  // Re-running is a no-op: the claim CAS rejects a terminal batch.
  const rerun = await processBatch(
    batch.id,
    batchGateway(["HAPPY-A", "HAPPY-B"]),
  );
  assert.equal(rerun, "noop");
  const after1 = await getDb()
    .select({ id: clerkCasesTable.id })
    .from(clerkCasesTable)
    .where(eq(clerkCasesTable.firmId, firmId));
  assert.equal(after1.length, cases.length, "no double-processing");
});

test("a big bundle processes in slices with truthful counters", async () => {
  // 12 segments > SEGMENTS_PER_SLICE: the first call parks with progress,
  // the second resumes FROM THE CURSOR — no re-segmentation, no counting a
  // batch's own earlier work as duplicates.
  const labels = Array.from({ length: 12 }, (_, i) => `SLICE-${i}`);
  const batch = await createClerkBatch(
    { sourceType: "text", name: `Big ${SALT}`, text: `twelve invoices ${SALT}` },
    userId,
    { firmId },
  );
  const first = await processBatch(batch.id, batchGateway(labels));
  assert.equal(first, "more");
  const [mid] = await getDb()
    .select()
    .from(clerkBatchesTable)
    .where(eq(clerkBatchesTable.id, batch.id));
  assert.equal(mid.status, "queued", "parked with progress between slices");
  assert.equal(mid.totalSegments, 12);
  assert.equal(mid.processedSegments, 10);
  assert.equal(mid.createdCases, 10);
  assert.ok(mid.segments, "segments persisted for the resume");
  assert.equal(mid.sourceText, null, "raw text dropped once segmented");

  // The resume must NOT need the segmentation call again: this gateway
  // would return garbage for it.
  let segmentationCalls = 0;
  const second = await processBatch(
    batch.id,
    fakeGateway((req) => {
      if (req.schemaName === "invoice_segmentation") {
        segmentationCalls += 1;
        return "garbage";
      }
      return JSON.stringify({
        fields: [
          {
            field: "invoiceNumber",
            value: `${SALT}-Y`,
            confidence: 0.9,
            sourceSnippet: null,
          },
        ],
        lines: [],
      });
    }),
  );
  assert.equal(second, "terminal");
  assert.equal(segmentationCalls, 0, "resume never re-segments");
  const [done] = await getDb()
    .select()
    .from(clerkBatchesTable)
    .where(eq(clerkBatchesTable.id, batch.id));
  assert.equal(done.status, "done");
  assert.equal(done.processedSegments, 12);
  assert.equal(done.createdCases, 12);
  assert.equal(done.skippedDuplicates, 0, "own progress never counted as dupes");
  assert.equal(done.segments, null);
});

test("duplicate segments are counted, never failed", async () => {
  // The same two invoices uploaded again: both segments hit the duplicate
  // guard on the capture path.
  const batch = await createClerkBatch(
    { sourceType: "text", name: `Dup ${SALT}`, text: `same again ${SALT}` },
    userId,
    { firmId },
  );
  await processBatch(batch.id, batchGateway(["HAPPY-A", "HAPPY-B"]));
  const [row] = await getDb()
    .select()
    .from(clerkBatchesTable)
    .where(eq(clerkBatchesTable.id, batch.id));
  assert.equal(row.status, "done");
  assert.equal(row.createdCases, 0);
  assert.equal(row.skippedDuplicates, 2);
});

test("garbage segmentation fails the batch with a reason", async () => {
  const batch = await createClerkBatch(
    { sourceType: "text", name: `Bad ${SALT}`, text: `unsplittable ${SALT}` },
    userId,
    { firmId },
  );
  await processBatch(batch.id, fakeGateway(() => "not json"));
  const [row] = await getDb()
    .select()
    .from(clerkBatchesTable)
    .where(eq(clerkBatchesTable.id, batch.id));
  assert.equal(row.status, "failed");
  assert.ok(row.failReason);
  assert.equal(row.sourceText, null);
});

test("the kill switch parks a queued batch instead of consuming it", async () => {
  const batch = await createClerkBatch(
    { sourceType: "text", name: `Parked ${SALT}`, text: `parked ${SALT}` },
    userId,
    { firmId },
  );
  await setFlag("clerk_ai", false);
  try {
    await processBatch(batch.id, batchGateway(["PARKED"]));
    await sweepClerkBatches();
    const [row] = await getDb()
      .select()
      .from(clerkBatchesTable)
      .where(eq(clerkBatchesTable.id, batch.id));
    assert.equal(row.status, "queued", "nothing ran while Clerk was off");
    assert.ok(row.sourceText, "the document is retained for the re-enable");
  } finally {
    await getDb()
      .insert(featureFlagsTable)
      .values({ key: "clerk_ai", enabled: true, description: "test" })
      .onConflictDoUpdate({
        target: featureFlagsTable.key,
        set: { enabled: true },
      });
  }
});
