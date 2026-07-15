import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DomainError } from "../errors.ts";
import {
  MAX_SCAN_PAGES,
  createExtractionCase,
  retryExtraction,
} from "./cases.ts";
import { createBatchCases } from "./batch.ts";
import type { CompletionRequest } from "./gateway.ts";
import {
  fakeGateway,
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "./test-support.ts";
import { getDb, usersTable } from "@workspace/db";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Scanned-PDF intake (Clerk idea #1): a PDF with no text layer — the shape of
// most real Nigerian SME documents — is rendered to page images and walks the
// SAME vision extraction as an image upload: same gateway/ledger/budget, same
// duplicate guard, same human review. Multi-invoice bundles stay on the batch
// path, which remains text-only.

const SALT = makeRunSalt();

// Minimal hand-built PDFs. Offsets in the xref are deliberately not exact —
// pdfjs rebuilds the table when it disagrees — and a %-comment carries the
// run salt so the duplicate-detection hash differs between runs.
function blankPdf(pages: number, tag: string): string {
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(" ");
  const pageObjects = Array.from(
    { length: pages },
    (_, i) =>
      `${3 + i} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >> endobj`,
  ).join("\n");
  const pdf = `%PDF-1.4
%${tag}-${SALT}
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [${kids}] /Count ${pages} >> endobj
${pageObjects}
trailer << /Size ${3 + pages} /Root 1 0 R >>
%%EOF`;
  return Buffer.from(pdf).toString("base64");
}

// A one-page PDF whose content stream draws real text, so getText() finds it
// and the capture stays on the text path.
function textPdf(tag: string): string {
  const streamBody = `BT /F1 14 Tf 20 50 Td (INVOICE ${tag} ${SALT}) Tj ET`;
  const pdf = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj
4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
5 0 obj << /Length ${streamBody.length} >> stream
${streamBody}
endstream endobj
trailer << /Size 6 /Root 1 0 R >>
%%EOF`;
  return Buffer.from(pdf).toString("base64");
}

const okExtraction = () => JSON.stringify({ fields: [], lines: [] });

const actorId = randomUUID();

before(async () => {
  await saveAndEnableClerkFlag();
  await getDb()
    .insert(usersTable)
    .values({ id: actorId, email: `scan-${SALT}@test.local` })
    .onConflictDoNothing();
});

after(async () => {
  await restoreClerkFlag();
});

function imageParts(req: CompletionRequest): { url: string }[] {
  if (typeof req.user === "string") return [];
  return req.user
    .filter((p): p is { type: "image_url"; image_url: { url: string } } =>
      p.type === "image_url",
    )
    .map((p) => p.image_url);
}

test("a textless PDF is rendered and extracted through the vision path", async () => {
  const calls: CompletionRequest[] = [];
  const gateway = fakeGateway((req) => {
    calls.push(req);
    return okExtraction();
  });
  const kase = await createExtractionCase(
    {
      sourceType: "pdf",
      pdfBase64: blankPdf(1, "scan-one"),
      name: `scan-${SALT}.pdf`,
    },
    actorId,
    gateway,
  );
  assert.equal(kase.status, "extracted");
  assert.equal(kase.sourceText, null, "no text layer, no sourceText");
  assert.equal(kase.sourceScanPagesB64?.length, 1, "rendered page stored for retry");

  assert.equal(calls.length, 1, "extraction reached the gateway");
  const req = calls[0];
  const images = imageParts(req);
  assert.equal(images.length, 1, "one image part per rendered page");
  assert.match(images[0].url, /^data:image\/png;base64,/);
  const preamble = Array.isArray(req.user) ? req.user[0] : null;
  assert.ok(
    preamble?.type === "text" && /scanned page/i.test(preamble.text),
    "anti-injection preamble names the scanned pages",
  );
});

test("a PDF with a real text layer stays on the text path", async () => {
  const calls: CompletionRequest[] = [];
  const gateway = fakeGateway((req) => {
    calls.push(req);
    return okExtraction();
  });
  const kase = await createExtractionCase(
    { sourceType: "pdf", pdfBase64: textPdf("text-path") },
    actorId,
    gateway,
  );
  assert.equal(kase.status, "extracted");
  assert.match(kase.sourceText ?? "", /INVOICE text-path/);
  assert.equal(kase.sourceScanPagesB64, null, "no pages rendered for a text PDF");
  assert.equal(typeof calls[0]?.user, "string", "document travels as fenced text");
});

test("a scan beyond the page cap is rejected with clear advice, before any model call", async () => {
  let providerCalls = 0;
  const gateway = fakeGateway(() => {
    providerCalls += 1;
    return okExtraction();
  });
  await assert.rejects(
    createExtractionCase(
      { sourceType: "pdf", pdfBase64: blankPdf(MAX_SCAN_PAGES + 1, "scan-long") },
      actorId,
      gateway,
    ),
    (err: unknown) => {
      assert.ok(err instanceof DomainError);
      assert.equal(err.code, "SCAN_TOO_LONG");
      assert.equal(err.status, 422);
      return true;
    },
  );
  assert.equal(providerCalls, 0);
});

test("the duplicate guard keys on the scan's bytes", async () => {
  const gateway = fakeGateway(okExtraction);
  const pdf = blankPdf(1, "scan-dupe");
  await createExtractionCase({ sourceType: "pdf", pdfBase64: pdf }, actorId, gateway);
  await assert.rejects(
    createExtractionCase({ sourceType: "pdf", pdfBase64: pdf }, actorId, gateway),
    (err: unknown) => {
      assert.ok(err instanceof DomainError);
      assert.equal(err.code, "DUPLICATE_SOURCE");
      return true;
    },
  );
});

test("a failed scan case retries from the stored page images", async () => {
  const failing = fakeGateway(() => {
    throw new Error("provider down");
  });
  const failed = await createExtractionCase(
    { sourceType: "pdf", pdfBase64: blankPdf(2, "scan-retry") },
    actorId,
    failing,
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.sourceScanPagesB64?.length, 2);

  const retryCalls: CompletionRequest[] = [];
  const working = fakeGateway((req) => {
    retryCalls.push(req);
    return okExtraction();
  });
  const retried = await retryExtraction(failed.id, actorId, working);
  assert.equal(retried.status, "extracted");
  assert.equal(
    imageParts(retryCalls[0]).length,
    2,
    "retry re-sends every stored page, no re-upload needed",
  );
});

test("batch intake stays text-only: a scanned bundle directs to one-at-a-time upload", async () => {
  const gateway = fakeGateway(okExtraction);
  await assert.rejects(
    createBatchCases(
      { sourceType: "pdf", pdfBase64: blankPdf(2, "scan-batch") },
      actorId,
      gateway,
    ),
    (err: unknown) => {
      assert.ok(err instanceof DomainError);
      assert.equal(err.code, "PDF_NO_TEXT");
      assert.match(err.message, /one at a time/i);
      return true;
    },
  );
});
