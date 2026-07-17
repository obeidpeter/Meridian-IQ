import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb, clerkBatchesTable, clerkCasesTable, usersTable } from "@workspace/db";
import { DomainError } from "../errors.ts";
import { validateScanSegments } from "./scan-batch.ts";
import { createClerkBatch, processBatch } from "./batch-async.ts";
import type { CompletionRequest } from "./gateway.ts";
import {
  fakeGateway,
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "./test-support.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Scanned month-end bundles (round-5 idea #1). Pinned invariants:
//  - a textless PDF queued as a batch becomes a SCAN bundle: no model call
//  and no full render in the request;
//  - the model only PROPOSES page ranges; the app validates them fail-closed
//  (contiguous, in order, every page exactly once) — an illegal split fails
//  the batch with a clear reason, it never guesses;
//  - every validated segment walks the ordinary vision-extraction case path
//  (per-segment duplicate hash on the page bytes);
//  - terminal states clear the stored PDF and the page ranges.

const SALT = makeRunSalt();
const actorId = randomUUID();

// Minimal textless multi-page PDF (mirrors clerk-scan.test.ts): pdfjs
// renders the pages, getText() finds nothing → the scan path engages.
function blankPdf(pages: number, tag: string): string {
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(" ");
  const body = Array.from(
    { length: pages },
    (_, i) =>
      `${3 + i} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >> endobj`,
  ).join("\n");
  const pdf = `%PDF-1.4
%${tag}-${SALT}
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [${kids}] /Count ${pages} >> endobj
${body}
trailer << /Size ${3 + pages} /Root 1 0 R >>
%%EOF`;
  return Buffer.from(pdf).toString("base64");
}

// Pages carrying only GRAPHICS (filled rectangles, no text layer), distinct
// per page AND per run: blank pages would all render identically, and the
// per-segment duplicate hash keys on the page bytes — identical segments
// would dedupe against each other and against earlier runs.
function drawnPdf(pages: number, tag: string): string {
  const offset = [...`${tag}-${SALT}`].reduce(
    (a, c) => (a + c.charCodeAt(0)) % 40,
    0,
  );
  const kids: string[] = [];
  const objs: string[] = [];
  let objNo = 3;
  for (let i = 0; i < pages; i++) {
    const pageNo = objNo++;
    const contentNo = objNo++;
    kids.push(`${pageNo} 0 R`);
    const stream = `0 0 0 rg ${10 + offset + i * 9} ${15 + i * 6} ${25 + i * 4} 12 re f`;
    objs.push(
      `${pageNo} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents ${contentNo} 0 R >> endobj`,
    );
    objs.push(
      `${contentNo} 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj`,
    );
  }
  const pdf = `%PDF-1.4
%${tag}-${SALT}
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages} >> endobj
${objs.join("\n")}
trailer << /Size ${objNo} /Root 1 0 R >>
%%EOF`;
  return Buffer.from(pdf).toString("base64");
}

const okExtraction = () => JSON.stringify({ fields: [], lines: [] });

before(async () => {
  await saveAndEnableClerkFlag();
  await getDb()
    .insert(usersTable)
    .values({ id: actorId, email: `scanbatch-${SALT}@test.local` })
    .onConflictDoNothing();
});

after(async () => {
  await restoreClerkFlag();
});

test("validateScanSegments: legal splits pass sorted; anything else fails closed", () => {
  const ok = validateScanSegments(
    [
      { startPage: 3, endPage: 4, label: null },
      { startPage: 1, endPage: 2, label: "A" },
    ],
    4,
  );
  assert.deepEqual(
    ok.map((s) => [s.startPage, s.endPage]),
    [
      [1, 2],
      [3, 4],
    ],
    "sorted into document order",
  );

  const bad = (segs: Parameters<typeof validateScanSegments>[0], pages: number) =>
    assert.throws(
      () => validateScanSegments(segs, pages),
      (err: unknown) =>
        err instanceof DomainError && err.code === "SEGMENTATION_INVALID",
    );
  bad([], 2); // nothing proposed
  bad([{ startPage: 2, endPage: 2, label: null }], 2); // page 1 uncovered
  bad(
    [
      { startPage: 1, endPage: 2, label: null },
      { startPage: 4, endPage: 4, label: null },
    ],
    4,
  ); // gap at page 3
  bad(
    [
      { startPage: 1, endPage: 3, label: null },
      { startPage: 2, endPage: 4, label: null },
    ],
    4,
  ); // overlap
  bad([{ startPage: 1, endPage: 3, label: null }], 4); // last page uncovered
  bad([{ startPage: 2, endPage: 1, label: null }], 2); // inverted
});

test("a textless PDF queues as a scan bundle and processes into per-segment cases", async () => {
  const batch = await createClerkBatch(
    {
      sourceType: "pdf",
      name: `Bundle ${SALT}`,
      pdfBase64: drawnPdf(4, "bundle-ok"),
    },
    actorId,
    {},
  );
  assert.equal(batch.status, "queued");
  assert.equal(batch.sourceKind, "scan");
  assert.ok(batch.sourcePdfB64, "the PDF is stored for the processor");
  assert.equal(batch.sourceText, null);

  const calls: CompletionRequest[] = [];
  const gateway = fakeGateway((req) => {
    calls.push(req);
    if (req.schemaName === "scan_segments") {
      return JSON.stringify({
        segments: [
          { startPage: 1, endPage: 2, label: `Seg A ${SALT}` },
          { startPage: 3, endPage: 4, label: null },
        ],
      });
    }
    return okExtraction();
  });

  let outcome = await processBatch(batch.id, gateway);
  while (outcome === "more") outcome = await processBatch(batch.id, gateway);
  assert.equal(outcome, "terminal");

  const [row] = await getDb()
    .select()
    .from(clerkBatchesTable)
    .where(eq(clerkBatchesTable.id, batch.id));
  assert.equal(row.status, "done");
  assert.equal(row.totalSegments, 2);
  assert.equal(row.processedSegments, 2);
  assert.equal(row.createdCases, 2);
  assert.equal(row.sourcePdfB64, null, "terminal state clears the PDF");
  assert.equal(row.scanSegments, null, "terminal state clears the ranges");

  // One segmentation call + one vision extraction per segment.
  assert.equal(calls.filter((c) => c.schemaName === "scan_segments").length, 1);
  const extractions = calls.filter((c) => c.schemaName === "invoice_extraction");
  assert.equal(extractions.length, 2);
  // Vision path: the extraction user content carries page images.
  for (const call of extractions) {
    assert.ok(Array.isArray(call.user), "vision content parts");
    const images = (call.user as Array<{ type: string }>).filter(
      (p) => p.type === "image_url",
    );
    assert.equal(images.length, 2, "each segment carries its two pages");
  }

  // The created cases are ordinary scan cases with per-segment content.
  const cases = await getDb()
    .select({
      id: clerkCasesTable.id,
      sourceType: clerkCasesTable.sourceType,
      sourceName: clerkCasesTable.sourceName,
      pages: clerkCasesTable.sourceScanPagesB64,
    })
    .from(clerkCasesTable)
    .where(
      and(
        eq(clerkCasesTable.createdBy, actorId),
        eq(clerkCasesTable.sourceType, "pdf"),
      ),
    )
    .orderBy(desc(clerkCasesTable.createdAt))
    .limit(2);
  assert.equal(cases.length, 2);
  assert.ok(cases.some((c) => c.sourceName === `Seg A ${SALT}`));
  for (const c of cases) {
    assert.equal(c.pages?.length, 2);
  }
});

test("an illegal proposed split fails the batch with a clear reason, content cleared", async () => {
  const batch = await createClerkBatch(
    {
      sourceType: "pdf",
      name: `Bundle bad ${SALT}`,
      pdfBase64: blankPdf(3, "bundle-bad"),
    },
    actorId,
    {},
  );
  const gateway = fakeGateway((req) =>
    req.schemaName === "scan_segments"
      ? JSON.stringify({
          // Gap: page 2 uncovered — must fail closed, never guess.
          segments: [
            { startPage: 1, endPage: 1, label: null },
            { startPage: 3, endPage: 3, label: null },
          ],
        })
      : okExtraction(),
  );
  const outcome = await processBatch(batch.id, gateway);
  assert.equal(outcome, "terminal");
  const [row] = await getDb()
    .select()
    .from(clerkBatchesTable)
    .where(eq(clerkBatchesTable.id, batch.id));
  assert.equal(row.status, "failed");
  assert.ok(row.failReason?.includes("page split was invalid"));
  assert.equal(row.sourcePdfB64, null);
  assert.equal(row.scanSegments, null);
});

test("a bundle past the page cap is refused at queue time", async () => {
  await assert.rejects(
    createClerkBatch(
      {
        sourceType: "pdf",
        name: `Bundle long ${SALT}`,
        pdfBase64: blankPdf(25, "bundle-long"),
      },
      actorId,
      {},
    ),
    (err: unknown) =>
      err instanceof DomainError && err.code === "SCAN_TOO_LONG",
  );
});
