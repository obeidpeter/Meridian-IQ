import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { unzipSync } from "fflate";
import type { Invoice, Party } from "@workspace/db";
import { firmPrincipal } from "../../test-helpers/principals";
import { extractPdfText } from "../clerk/cases/documents";
import { DomainError } from "../errors";
import type { EvidenceSourceFile } from "./assistance";
import {
  exportEvidencePack,
  MAX_EVIDENCE_PACK_BYTES,
  MAX_EVIDENCE_PACK_EVENTS,
  MAX_EVIDENCE_PACK_FILES,
  type EvidencePackDependencies,
  type EvidencePackEvent,
  type EvidencePackInvoice,
  type EvidencePackRequest,
} from "./packs";

const principal = firmPrincipal("firm-a");
const createdAt = new Date("2026-09-12T00:00:00Z");
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

function fixture(
  bytes: Buffer = Buffer.from("Accepted original support evidence"),
) {
  const request: EvidencePackRequest = {
    id: "request-a",
    firmId: "firm-a",
    clientPartyId: "client-a",
    invoiceId: null,
    filingId: null,
    period: "2026-09",
    documentType: "delivery_note",
    version: 3,
    status: "accepted",
    acceptedFileId: "file-a",
    title: "Delivery confirmation",
    updatedAt: createdAt,
  };
  const file: EvidenceSourceFile = {
    id: "file-a",
    requestId: request.id,
    firmId: request.firmId,
    filename: "../../unsafe\\invoice.pdf",
    contentType: "text/plain",
    byteSize: bytes.length,
    sha256: hash(bytes),
    scanStatus: "clean",
    uploadedBy: "uploader",
    createdAt,
    scannedAt: createdAt,
  };
  const files = [file];
  const events: EvidencePackEvent[] = [
    {
      id: "review-a",
      requestId: request.id,
      firmId: request.firmId,
      actorId: "human-reviewer",
      action: "accepted",
      comment: "Confirmed against original",
      fileId: file.id,
      createdAt,
    },
  ];
  const calls: string[] = [];
  const deps: EvidencePackDependencies = {
    assertRequest: async (who, id) => {
      assert.equal(who, principal);
      assert.equal(id, request.id);
      calls.push("request");
      return structuredClone(request);
    },
    readFile: async (who, id) => {
      assert.equal(who, principal);
      assert.equal(id, file.id);
      calls.push("file");
      return {
        request: structuredClone(request),
        file: structuredClone(file),
        bytes,
      };
    },
    history: async () => {
      calls.push("history");
      return structuredClone({ files, events });
    },
    invoice: async () => {
      calls.push("invoice");
      return null;
    },
  };
  return { request, file, files, events, calls, deps, bytes };
}

function invoiceSource(environment: string | null): EvidencePackInvoice {
  const party = (id: string): Party => ({
    id,
    type: "client_business",
    legalName: id,
    tin: null,
    tinValidated: false,
    cacNumber: null,
    street: null,
    city: null,
    countryCode: "NG",
    mergedIntoId: null,
    createdByFirmId: null,
    createdByUserId: null,
    schemaVersion: 1,
    createdAt,
    updatedAt: createdAt,
  });
  const invoice: Invoice = {
    id: "invoice-a",
    firmId: "firm-a",
    supplierPartyId: "client-a",
    buyerPartyId: "buyer-a",
    kind: "invoice",
    category: "b2b",
    whtCategory: null,
    relatedInvoiceId: null,
    invoiceNumber: "INV-PACK-009",
    currency: "NGN",
    fxRateToNgn: null,
    issueDate: "2026-09-12",
    dueDate: null,
    status: environment ? "stamped" : "draft",
    subtotal: "1000.00",
    vatTotal: "75.00",
    grandTotal: "1075.00",
    notes: null,
    legalHold: false,
    retentionUntil: null,
    schemaVersion: 1,
    contentRevision: 2,
    createdAt,
    updatedAt: createdAt,
  };
  const stamp = environment
    ? {
        id: "stamp-a",
        invoiceId: invoice.id,
        irn: "IRN-PACK-009",
        csid: "CSID-PACK",
        qrPayload: "local-test-stamp",
        signedArtifactRef: "stored-stamp-reference",
        rail: "rail_primary" as const,
        provider:
          environment === "sandbox" ? "simulator" : "local-test-provider",
        environment,
        createdAt,
      }
    : null;
  return {
    input: {
      invoice,
      lines: [],
      supplier: party(invoice.supplierPartyId),
      buyer: party(invoice.buyerPartyId),
      stamp,
      theme: null,
    },
    stamp,
  };
}

test("pack round-trip includes the exact accepted original and scoped immutable history, never storage internals", async () => {
  const f = fixture();
  Object.assign(f.file, {
    encryptedContent: "PRIVATE_CIPHERTEXT",
    scanToken: "PRIVATE_SCAN_TOKEN",
    requestHash: "PRIVATE_COMMAND_HASH",
  });
  Object.assign(f.events[0], { requestHash: "PRIVATE_EVENT_HASH" });
  f.files.push({
    ...f.file,
    id: "newer-file",
    scanStatus: "rejected",
    createdAt: new Date("2026-09-12T01:00:00Z"),
  });
  const pack = await exportEvidencePack(principal, f.request.id, f.deps);
  assert.equal(pack.contentType, "application/zip");
  assert.equal(pack.filename, "evidence-pack.zip");
  const entries = unzipSync(pack.bytes);
  assert.deepEqual(Object.keys(entries).sort(), [
    "accepted-original.txt",
    "manifest.json",
  ]);
  assert.deepEqual(Buffer.from(entries["accepted-original.txt"]), f.bytes);
  const json = Buffer.from(entries["manifest.json"]).toString("utf8");
  assert.doesNotMatch(json, /PRIVATE_|encryptedContent|scanToken|requestHash/);
  const manifest = JSON.parse(json);
  assert.equal(manifest.original.fileId, f.file.id);
  assert.equal(manifest.original.sha256, hash(f.bytes));
  assert.equal(manifest.acceptedReviewId, "review-a");
  assert.equal(manifest.files.length, 2);
  assert.equal(manifest.files[0].filename, "../../unsafe\\invoice.pdf");
  assert.equal(manifest.events[0].actorId, "human-reviewer");
  assert.equal(manifest.invoice, null);
  assert.deepEqual(f.calls, [
    "request",
    "file",
    "history",
    "invoice",
    "request",
    "file",
    "history",
    "invoice",
  ]);
});

test("pack is deterministic for the same versions and history", async () => {
  const f = fixture();
  const first = await exportEvidencePack(principal, f.request.id, f.deps);
  const second = await exportEvidencePack(principal, f.request.id, f.deps);
  assert.deepEqual(first.bytes, second.bytes);
});

test("invoice packs reuse the real PDF renderer and explicitly preserve sandbox/live/unknown stamp provenance", async () => {
  for (const environment of ["sandbox", "live", "unexpected", null]) {
    const f = fixture();
    f.request.invoiceId = "invoice-a";
    f.request.period = null;
    const source = invoiceSource(environment);
    f.deps.invoice = async () => structuredClone(source);
    const entries = unzipSync(
      (await exportEvidencePack(principal, f.request.id, f.deps)).bytes,
    );
    const pdfText = await extractPdfText(Buffer.from(entries["invoice.pdf"]));
    assert.match(pdfText, /INV-PACK-009/);
    const manifest = JSON.parse(
      Buffer.from(entries["manifest.json"]).toString(),
    );
    assert.equal(manifest.invoice.contentRevision, 2);
    assert.match(
      manifest.invoice.snapshot,
      /not an invoice snapshot captured at evidence acceptance/,
    );
    if (environment) {
      assert.match(pdfText, /IRN-PACK-009/);
      const stamp = JSON.parse(Buffer.from(entries["stamp.json"]).toString());
      assert.equal(stamp.environment, environment);
      assert.equal(
        stamp.provenance,
        environment === "unexpected" ? "unknown" : environment,
      );
    } else {
      assert.equal(entries["stamp.json"], undefined);
      assert.equal(manifest.invoice.stamp, null);
      assert.match(pdfText, /UNSTAMPED/);
    }
  }
});

test("pack refuses unaccepted requests before it reads a file", async () => {
  for (const status of [
    "requested",
    "uploaded",
    "needs_changes",
    "cancelled",
  ] as const) {
    const f = fixture();
    f.request.status = status;
    await assert.rejects(exportEvidencePack(principal, f.request.id, f.deps), {
      status: 409,
    });
    assert.deepEqual(f.calls, ["request"]);
  }
});

test("pack fails before storage reads when request authorization is denied", async () => {
  const f = fixture();
  f.deps.assertRequest = async () => {
    throw new DomainError("FORBIDDEN", "Denied", 403);
  };
  await assert.rejects(exportEvidencePack(principal, f.request.id, f.deps), {
    status: 403,
  });
  assert.deepEqual(f.calls, []);
});

test("pack requires a real human accepted review for the exact pinned file", async () => {
  for (const invalid of [
    "missing",
    "other_file",
    "rejected",
    "no_actor",
    "later_changes",
  ]) {
    const f = fixture();
    if (invalid === "missing") f.events.length = 0;
    if (invalid === "other_file") f.events[0].fileId = "different-file";
    if (invalid === "rejected") f.events[0].action = "needs_changes";
    if (invalid === "no_actor") f.events[0].actorId = null;
    if (invalid === "later_changes")
      f.events.push({
        ...f.events[0],
        id: "review-b",
        action: "needs_changes",
        createdAt: new Date("2026-09-12T01:00:00Z"),
      });
    await assert.rejects(exportEvidencePack(principal, f.request.id, f.deps), {
      status: 409,
    });
  }
});

test("pack rejects foreign history, duplicate versions, wrong originals and non-clean originals", async () => {
  for (const invalid of [
    "event_firm",
    "event_request",
    "file_firm",
    "file_request",
    "duplicate",
    "quarantined",
    "corrupt",
  ]) {
    const f = fixture();
    if (invalid === "event_firm") f.events[0].firmId = "other";
    if (invalid === "event_request") f.events[0].requestId = "other";
    if (invalid === "file_firm")
      f.files.push({ ...f.file, id: "file-b", firmId: "other" });
    if (invalid === "file_request") f.file.requestId = "other";
    if (invalid === "duplicate") f.files.push({ ...f.file });
    if (invalid === "quarantined") f.file.scanStatus = "quarantined";
    if (invalid === "corrupt") f.file.sha256 = "f".repeat(64);
    await assert.rejects(
      exportEvidencePack(principal, f.request.id, f.deps),
      DomainError,
    );
  }
});

test("pack will not emit a ZIP when acceptance, source safety, history or membership changes mid-export", async () => {
  for (const changed of [
    "pointer",
    "scan",
    "version",
    "event",
    "file",
    "access",
  ]) {
    const f = fixture();
    let calls = 0;
    f.deps.invoice = async () => {
      if (++calls !== 1) return null;
      if (changed === "pointer") f.request.acceptedFileId = "new-file";
      if (changed === "scan") f.file.scanStatus = "rejected";
      if (changed === "version") f.request.version += 1;
      if (changed === "event") f.events[0].comment = "Changed review";
      if (changed === "file") f.file.filename = "changed-name.txt";
      if (changed === "access")
        f.deps.assertRequest = async () => {
          throw new DomainError("FORBIDDEN", "Revoked", 403);
        };
      return null;
    };
    await assert.rejects(
      exportEvidencePack(principal, f.request.id, f.deps),
      DomainError,
    );
  }
});

test("invoice source must be scoped, complete and unchanged across generation", async () => {
  for (const invalid of [
    "missing",
    "foreign_firm",
    "sibling_client",
    "other_invoice",
    "stamp",
    "changed",
  ]) {
    const f = fixture();
    f.request.invoiceId = "invoice-a";
    f.request.period = null;
    const source = invoiceSource("sandbox");
    if (invalid === "foreign_firm") source.input.invoice.firmId = "other";
    if (invalid === "sibling_client")
      source.input.invoice.supplierPartyId = "sibling";
    if (invalid === "other_invoice") source.input.invoice.id = "other";
    if (invalid === "stamp") source.stamp!.invoiceId = "other";
    let reads = 0;
    f.deps.invoice = async () => {
      if (invalid === "missing") return null;
      if (++reads === 2 && invalid === "changed")
        source.input.invoice.contentRevision += 1;
      return structuredClone(source);
    };
    await assert.rejects(exportEvidencePack(principal, f.request.id, f.deps), {
      status: 409,
    });
  }
});

test("pack bounds original bytes, combined archive bytes, file versions and event history", async () => {
  const large = fixture(Buffer.alloc(MAX_EVIDENCE_PACK_BYTES));
  await assert.rejects(
    exportEvidencePack(principal, large.request.id, large.deps),
    { status: 413 },
  );
  const combined = fixture(Buffer.alloc(MAX_EVIDENCE_PACK_BYTES - 100));
  await assert.rejects(
    exportEvidencePack(principal, combined.request.id, combined.deps),
    { status: 413 },
  );
  const manyFiles = fixture();
  for (let i = 1; i <= MAX_EVIDENCE_PACK_FILES; i++)
    manyFiles.files.push({ ...manyFiles.file, id: `file-${i}` });
  await assert.rejects(
    exportEvidencePack(principal, manyFiles.request.id, manyFiles.deps),
    { status: 413 },
  );
  const manyEvents = fixture();
  for (let i = 1; i <= MAX_EVIDENCE_PACK_EVENTS; i++)
    manyEvents.events.push({ ...manyEvents.events[0], id: `event-${i}` });
  await assert.rejects(
    exportEvidencePack(principal, manyEvents.request.id, manyEvents.deps),
    { status: 413 },
  );
  manyFiles.files.pop();
  assert.ok(
    (await exportEvidencePack(principal, manyFiles.request.id, manyFiles.deps))
      .bytes.length < MAX_EVIDENCE_PACK_BYTES,
  );
});

test("simulator or incomplete stamps never receive live provenance", async () => {
  for (const invalid of ["simulator", "incomplete"]) {
    const f = fixture();
    f.request.invoiceId = "invoice-a";
    f.request.period = null;
    const source = invoiceSource("live");
    if (invalid === "simulator") source.stamp!.provider = " Simulator ";
    else source.stamp!.signedArtifactRef = "";
    f.deps.invoice = async () => structuredClone(source);
    const entries = unzipSync(
      (await exportEvidencePack(principal, f.request.id, f.deps)).bytes,
    );
    const stamp = JSON.parse(Buffer.from(entries["stamp.json"]).toString());
    assert.equal(
      stamp.provenance,
      invalid === "simulator" ? "sandbox" : "unknown",
    );
    assert.equal(stamp.environment, "live");
  }
});
