import { and, asc, eq, lt, or } from "drizzle-orm";
import {
  getDb,
  clerkBatchesTable,
  type ClerkBatch,
} from "@workspace/db";
import { DomainError } from "../errors";
import { appendAudit } from "../audit/audit";
import { isFeatureEnabled } from "../flags/flags";
import { registerSweep } from "../pipeline/pipeline";
import { logger } from "../../lib/logger";
import { assertFirmClerkBudget } from "./budget";
import { segmentDocument, type BatchSegment } from "./batch";
import { createExtractionCase, resolveTextSource } from "./cases";
import {
  assertClerkEnabled,
  CLERK_FLAG_KEY,
  type ClerkGateway,
} from "./gateway";
import { getClerkGateway } from "./provider";
import { inClerkScope } from "./scope";

// Async batch intake (Clerk idea #8). The synchronous batch route caps at 10
// segments because the request holds the caller while every model call runs;
// a month-end bundle needs more. Here the route only QUEUES: it resolves the
// document text, inserts a clerk_batches row and returns 202 — no model call
// in the request. Processing happens out of band with the digest
// split-pattern: short transactions around the model calls, never across them.
//
// The concurrency story, stated once:
//  - SEGMENT ONCE, PERSIST, THEN CURSOR. Segmentation output is stored on the
//    row and processedSegments is a cursor into it — resume, reclaim and
//    slicing never re-segment, so shifted boundaries can't defeat the
//    duplicate guard or double the token spend.
//  - EVERY WRITE IS FENCED on the claim stamp (claimedAt doubles as an
//    ownership token, refreshed as a heartbeat on each write). A processor
//    that loses the fence stops writing immediately, so a reclaimed batch has
//    exactly one live writer.
//  - SLICES, NOT MARATHONS. One processBatch call handles at most one slice
//    (~1 segmentation + SEGMENTS_PER_SLICE extractions), then re-parks with
//    progress. The kick loops slices back-to-back; the shared sweep does one
//    slice per pass so it can never stall the minute-sensitive sweeps behind
//    it. A slice is minutes at worst — far inside the reclaim window.
//  - THE KILL SWITCH PARKS, the retention sweep is the backstop for content
//    held by batches that never get processed at all.
//
// Each segment then walks the EXACT same createExtractionCase path as a
// single upload — same duplicate guard, same extraction, same pre-flight,
// same human review. The batch machinery adds throughput, never authority.

export const MAX_ASYNC_BATCH_SEGMENTS = 50;
// Extractions per processBatch call; also bounds a sweep pass's model calls.
export const SEGMENTS_PER_SLICE = 10;
// A claim whose heartbeat is older than this belongs to a dead processor.
const RECLAIM_AFTER_MS = 10 * 60_000;

export interface CreateBatchInput {
  sourceType: "pdf" | "text";
  name?: string | null;
  text?: string;
  pdfBase64?: string;
}

// Queue one bundle. Runs on a NO_CONTEXT route: the insert commits in its own
// firm-scoped transaction so the processor (other connections) can see it
// immediately.
export async function createClerkBatch(
  input: CreateBatchInput,
  actorId: string,
  ctx: { firmId?: string | null } = {},
): Promise<ClerkBatch> {
  await assertClerkEnabled();
  const fullText = await resolveTextSource(
    input.sourceType,
    input,
    "Upload the invoices one at a time as images instead.",
  );
  const firmId = ctx.firmId ?? null;
  const batch = await inClerkScope(firmId, async () => {
    const [row] = await getDb()
      .insert(clerkBatchesTable)
      .values({
        firmId,
        createdBy: actorId,
        name: input.name?.trim() || "Batch intake",
        sourceText: fullText,
        status: "queued",
      })
      .returning();
    await appendAudit({
      actorId,
      firmId: firmId ?? undefined,
      action: "clerk.batch.queue",
      entityType: "clerk_batch",
      entityId: row.id,
      after: { sourceType: input.sourceType, chars: fullText.length },
    });
    return row;
  });
  return batch;
}

// Claim the batch with a compare-and-set: queued, or processing with a stale
// heartbeat (dead processor). Exactly one caller wins; everyone else no-ops.
async function claimBatch(
  batchId: string,
): Promise<{ batch: ClerkBatch; stamp: Date } | null> {
  const stamp = new Date();
  const staleBefore = new Date(Date.now() - RECLAIM_AFTER_MS);
  const [claimed] = await getDb()
    .update(clerkBatchesTable)
    .set({ status: "processing", claimedAt: stamp })
    .where(
      and(
        eq(clerkBatchesTable.id, batchId),
        or(
          eq(clerkBatchesTable.status, "queued"),
          and(
            eq(clerkBatchesTable.status, "processing"),
            lt(clerkBatchesTable.claimedAt, staleBefore),
          ),
        ),
      ),
    )
    .returning();
  return claimed ? { batch: claimed, stamp } : null;
}

// Fenced write: only the processor holding the current stamp may write, and
// each write refreshes the stamp (heartbeat). Returns the new stamp, or null
// when the fence was lost — the caller must stop touching the batch.
async function fencedPatch(
  batchId: string,
  stamp: Date,
  patch: Partial<typeof clerkBatchesTable.$inferInsert>,
): Promise<Date | null> {
  const next = new Date();
  const rows = await getDb()
    .update(clerkBatchesTable)
    .set({ claimedAt: next, ...patch })
    .where(
      and(
        eq(clerkBatchesTable.id, batchId),
        eq(clerkBatchesTable.status, "processing"),
        eq(clerkBatchesTable.claimedAt, stamp),
      ),
    )
    .returning({ id: clerkBatchesTable.id });
  if (rows.length === 0) return null;
  return "claimedAt" in patch ? null : next;
}

export type SliceOutcome =
  | "noop" // nothing claimed (someone else owns it, or Clerk is off)
  | "terminal" // done or failed
  | "parked" // kill switch / budget: back in the queue, content intact
  | "more"; // slice finished, segments remain — call again to continue

// Process one SLICE of a batch. Safe to call concurrently and repeatedly:
// the claim + fence decide, the cursor resumes.
export async function processBatch(
  batchId: string,
  gateway: ClerkGateway,
): Promise<SliceOutcome> {
  if (!(await isFeatureEnabled(CLERK_FLAG_KEY))) return "noop";
  const claimed = await claimBatch(batchId);
  if (!claimed) return "noop";
  const { batch } = claimed;
  let stamp: Date | null = claimed.stamp;

  const park = async (
    counters: Partial<typeof clerkBatchesTable.$inferInsert> = {},
  ): Promise<SliceOutcome> => {
    if (stamp) {
      await fencedPatch(batchId, stamp, {
        status: "queued",
        claimedAt: null,
        ...counters,
      });
    }
    return "parked";
  };
  const fail = async (
    reason: string,
    counters: Partial<typeof clerkBatchesTable.$inferInsert> = {},
  ): Promise<SliceOutcome> => {
    if (stamp) {
      await fencedPatch(batchId, stamp, {
        status: "failed",
        failReason: reason,
        sourceText: null,
        segments: null,
        claimedAt: null,
        ...counters,
      });
    }
    return "terminal";
  };

  // ---- Stage 1: segmentation (once per batch, persisted) ----
  let segments: BatchSegment[] | null = batch.segments;
  if (!segments) {
    if (!batch.sourceText?.trim()) {
      return fail("The batch has no document text to process.");
    }
    // Budget pre-check BEFORE the segmentation call: an exhausted allowance
    // parks the batch (it self-heals next month; the retention sweep is the
    // backstop) instead of burning the document with a misleading failure.
    if (batch.firmId) {
      try {
        await assertFirmClerkBudget(batch.firmId);
      } catch {
        return park();
      }
    }
    try {
      segments = await segmentDocument(
        batch.sourceText,
        MAX_ASYNC_BATCH_SEGMENTS,
        gateway,
        batch.firmId,
      );
    } catch (err) {
      // Kill switch mid-flight parks work instead of destroying it.
      if (err instanceof DomainError && err.code === "CLERK_DISABLED") {
        return park();
      }
      const message =
        err instanceof DomainError
          ? err.message
          : "Segmentation failed unexpectedly.";
      return fail(message);
    }
    // The segments now carry the content; the raw document is dropped here.
    stamp = await fencedPatch(batchId, stamp, {
      segments,
      totalSegments: segments.length,
      sourceText: null,
    });
    if (!stamp) return "noop";
  }

  // ---- Stage 2: one slice of extractions, cursor-resumed ----
  let cursor = batch.processedSegments;
  let created = batch.createdCases;
  let skipped = batch.skippedDuplicates;
  let inSlice = 0;
  while (cursor < segments.length && inSlice < SEGMENTS_PER_SLICE) {
    const segment = segments[cursor];
    // Same budget semantics as the sync batch: a firm that runs dry mid-batch
    // keeps what was already created; the counters make the shortfall visible.
    if (batch.firmId) {
      try {
        await assertFirmClerkBudget(batch.firmId);
      } catch {
        return fail(
          created > 0
            ? `The firm's Clerk allowance ran out after ${created} invoice(s).`
            : "The firm's monthly Clerk allowance is exhausted.",
          {
            processedSegments: cursor,
            createdCases: created,
            skippedDuplicates: skipped,
          },
        );
      }
    }
    try {
      await createExtractionCase(
        {
          sourceType: "text",
          name:
            segment.label?.trim() ||
            `${batch.name ?? "Batch intake"} (${cursor + 1}/${segments.length})`,
          text: segment.text,
        },
        batch.createdBy,
        gateway,
        undefined,
        // The batch row does not record the creator's role, so supplier
        // memory stays conservatively client-scoped (creator's own cases) —
        // a staff-created batch just gets a smaller exemplar pool.
        { firmId: batch.firmId, clientScoped: true },
      );
      created += 1;
    } catch (err) {
      if (err instanceof DomainError && err.code === "DUPLICATE_SOURCE") {
        skipped += 1;
      } else if (err instanceof DomainError && err.code === "CLERK_DISABLED") {
        return park({
          processedSegments: cursor,
          createdCases: created,
          skippedDuplicates: skipped,
        });
      } else {
        const message =
          err instanceof DomainError
            ? err.message
            : "A segment failed unexpectedly.";
        return fail(message, {
          processedSegments: cursor + 1,
          createdCases: created,
          skippedDuplicates: skipped,
        });
      }
    }
    cursor += 1;
    inSlice += 1;
    stamp = await fencedPatch(batchId, stamp, {
      processedSegments: cursor,
      createdCases: created,
      skippedDuplicates: skipped,
    });
    if (!stamp) return "noop"; // fence lost: someone else owns the batch now
  }

  if (cursor < segments.length) {
    // Slice budget spent; park with progress so the next call (or sweep
    // pass) continues from the cursor without re-segmenting.
    await fencedPatch(batchId, stamp, {
      status: "queued",
      claimedAt: null,
      processedSegments: cursor,
      createdCases: created,
      skippedDuplicates: skipped,
    });
    return "more";
  }

  await fencedPatch(batchId, stamp, {
    status: "done",
    processedSegments: cursor,
    createdCases: created,
    skippedDuplicates: skipped,
    sourceText: null,
    segments: null,
    claimedAt: null,
  });
  await appendAudit({
    actorId: batch.createdBy,
    firmId: batch.firmId ?? undefined,
    action: "clerk.batch.processed",
    entityType: "clerk_batch",
    entityId: batch.id,
    after: { segments: segments.length, created, skippedDuplicates: skipped },
  });
  return "terminal";
}

// Fire-and-forget kick from the route: processes slice after slice in this
// process; if it dies, the sweep's reclaim picks the batch up.
export function kickBatchProcessing(batchId: string): void {
  void (async () => {
    const gateway = await getClerkGateway();
    let outcome: SliceOutcome;
    do {
      outcome = await processBatch(batchId, gateway);
    } while (outcome === "more");
  })().catch((err) => {
    logger.warn({ err, batchId }, "async batch kick failed; sweep will retry");
  });
}

export async function sweepClerkBatches(): Promise<void> {
  if (!(await isFeatureEnabled(CLERK_FLAG_KEY))) return;
  const staleBefore = new Date(Date.now() - RECLAIM_AFTER_MS);
  // ONE slice of the oldest claimable batch per pass: the shared sweep loop
  // has minute-sensitive statutory work behind this, so a pass is bounded at
  // roughly a slice's worth of model calls; the queue drains across passes
  // (and the kick path drives the interactive case slice-to-slice anyway).
  const [candidate] = await getDb()
    .select({ id: clerkBatchesTable.id })
    .from(clerkBatchesTable)
    .where(
      or(
        eq(clerkBatchesTable.status, "queued"),
        and(
          eq(clerkBatchesTable.status, "processing"),
          lt(clerkBatchesTable.claimedAt, staleBefore),
        ),
      ),
    )
    .orderBy(asc(clerkBatchesTable.createdAt))
    .limit(1);
  if (!candidate) return;
  // No provider configured: leave the batches queued for when one exists.
  let gateway: ClerkGateway;
  try {
    gateway = await getClerkGateway();
  } catch {
    return;
  }
  await processBatch(candidate.id, gateway);
}

registerSweep(sweepClerkBatches);
