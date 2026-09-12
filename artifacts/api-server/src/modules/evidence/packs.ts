import { createHash } from "node:crypto";
import type {
  EvidenceEvent,
  EvidenceRequest,
  StampRecord,
} from "@workspace/db";
import type { Principal } from "../auth/rbac";
import { DomainError } from "../errors";
import { renderInvoicePdf, type InvoicePdfInput } from "../invoice/pdf";
import { assertEvidenceSource, type EvidenceSourceFile } from "./assistance";

export const MAX_EVIDENCE_PACK_BYTES = 25 * 1024 * 1024;
export const MAX_EVIDENCE_PACK_FILES = 50;
export const MAX_EVIDENCE_PACK_EVENTS = 2_000;

export type EvidencePackRequest = Pick<
  EvidenceRequest,
  | "id"
  | "firmId"
  | "clientPartyId"
  | "invoiceId"
  | "filingId"
  | "period"
  | "documentType"
  | "version"
  | "status"
  | "acceptedFileId"
  | "title"
  | "updatedAt"
>;

export type EvidencePackEvent = Pick<
  EvidenceEvent,
  | "id"
  | "firmId"
  | "requestId"
  | "actorId"
  | "action"
  | "comment"
  | "fileId"
  | "createdAt"
>;

export type EvidencePackStamp = Pick<
  StampRecord,
  | "id"
  | "invoiceId"
  | "irn"
  | "csid"
  | "qrPayload"
  | "signedArtifactRef"
  | "rail"
  | "provider"
  | "environment"
  | "createdAt"
>;

export interface EvidencePackInvoice {
  input: InvoicePdfInput;
  stamp: EvidencePackStamp | null;
}

export interface EvidencePackDependencies {
  assertRequest(principal: Principal, id: string): Promise<EvidencePackRequest>;
  readFile(
    principal: Principal,
    id: string,
  ): Promise<{
    request: EvidencePackRequest;
    file: EvidenceSourceFile;
    bytes: Buffer;
  }>;
  history(
    request: EvidencePackRequest,
  ): Promise<{ files: EvidenceSourceFile[]; events: EvidencePackEvent[] }>;
  invoice(
    principal: Principal,
    request: EvidencePackRequest,
  ): Promise<EvidencePackInvoice | null>;
}

export interface EvidencePack {
  bytes: Buffer;
  contentType: "application/zip";
  filename: string;
}

function conflict(message: string): never {
  throw new DomainError("EVIDENCE_PACK_CHANGED", message, 409);
}

function tooLarge(): never {
  throw new DomainError(
    "EVIDENCE_PACK_TOO_LARGE",
    "Evidence packs must be under 25 MB with at most 50 files and 2000 history events",
    413,
  );
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requestRecord(request: EvidencePackRequest) {
  return {
    id: request.id,
    firmId: request.firmId,
    clientPartyId: request.clientPartyId,
    invoiceId: request.invoiceId,
    filingId: request.filingId,
    period: request.period,
    title: request.title,
    documentType: request.documentType,
    status: request.status,
    version: request.version,
    acceptedFileId: request.acceptedFileId,
    updatedAt: request.updatedAt,
  };
}

function fileRecord(file: EvidenceSourceFile) {
  return {
    id: file.id,
    requestId: file.requestId,
    firmId: file.firmId,
    filename: file.filename,
    contentType: file.contentType,
    byteSize: file.byteSize,
    sha256: file.sha256,
    scanStatus: file.scanStatus,
    uploadedBy: file.uploadedBy,
    createdAt: file.createdAt,
    scannedAt: file.scannedAt,
  };
}

function eventRecord(event: EvidencePackEvent) {
  return {
    id: event.id,
    requestId: event.requestId,
    firmId: event.firmId,
    actorId: event.actorId,
    action: event.action,
    comment: event.comment,
    fileId: event.fileId,
    createdAt: event.createdAt,
  };
}

function stampRecord(stamp: EvidencePackStamp | null) {
  if (!stamp) return null;
  const provider = stamp.provider.trim().toLowerCase();
  const complete = [
    stamp.irn,
    stamp.csid,
    stamp.qrPayload,
    stamp.signedArtifactRef,
  ].every((value) => value.trim());
  return {
    id: stamp.id,
    invoiceId: stamp.invoiceId,
    irn: stamp.irn,
    csid: stamp.csid,
    qrPayload: stamp.qrPayload,
    signedArtifactRef: stamp.signedArtifactRef,
    rail: stamp.rail,
    provider: stamp.provider,
    environment: stamp.environment,
    createdAt: stamp.createdAt,
    provenance:
      stamp.environment === "sandbox" || provider === "simulator"
        ? "sandbox"
        : stamp.environment === "live" && provider && complete
          ? "live"
          : "unknown",
  };
}

function ordered<T extends { createdAt: Date; id: string }>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
}

function validateHistory(
  request: EvidencePackRequest,
  accepted: EvidenceSourceFile,
  history: Awaited<ReturnType<EvidencePackDependencies["history"]>>,
) {
  if (request.status !== "accepted" || request.acceptedFileId !== accepted.id) {
    conflict("The request must still accept the pinned evidence file");
  }
  if (
    history.files.length > MAX_EVIDENCE_PACK_FILES ||
    history.events.length > MAX_EVIDENCE_PACK_EVENTS
  )
    tooLarge();
  if (
    history.files.some(
      (file) => file.requestId !== request.id || file.firmId !== request.firmId,
    ) ||
    history.events.some(
      (event) =>
        event.requestId !== request.id || event.firmId !== request.firmId,
    )
  ) {
    conflict("Evidence history does not belong to this request");
  }
  const fileIds = new Set(history.files.map((file) => file.id));
  if (
    fileIds.size !== history.files.length ||
    new Set(history.events.map((event) => event.id)).size !==
      history.events.length ||
    history.events.some(
      (event) => event.fileId !== null && !fileIds.has(event.fileId),
    )
  ) {
    conflict("Evidence history has inconsistent file versions");
  }
  const pinned = history.files.find((file) => file.id === accepted.id);
  if (
    !pinned ||
    JSON.stringify(fileRecord(pinned)) !== JSON.stringify(fileRecord(accepted))
  ) {
    conflict("The accepted file version changed during export");
  }
  const events = ordered(history.events);
  const reviews = events.filter(
    (event) => event.action === "accepted" || event.action === "needs_changes",
  );
  const review = reviews.at(-1);
  if (
    !review ||
    review.action !== "accepted" ||
    review.fileId !== accepted.id ||
    !review.actorId
  ) {
    conflict("An accepted human review for the pinned file is required");
  }
  return {
    request: requestRecord(request),
    files: ordered(history.files).map(fileRecord),
    events: events.map(eventRecord),
    acceptedReviewId: review.id,
  };
}

function invoiceRecord(
  request: EvidencePackRequest,
  source: EvidencePackInvoice | null,
) {
  if (!request.invoiceId) {
    if (source) conflict("Unexpected invoice in a non-invoice evidence pack");
    return null;
  }
  if (!source) conflict("The invoice anchor is unavailable");
  const { invoice, supplier, buyer, lines } = source.input;
  if (
    invoice.id !== request.invoiceId ||
    invoice.firmId !== request.firmId ||
    invoice.supplierPartyId !== request.clientPartyId ||
    supplier.id !== invoice.supplierPartyId ||
    buyer.id !== invoice.buyerPartyId ||
    lines.some((line) => line.invoiceId !== invoice.id) ||
    (source.stamp !== null && source.stamp.invoiceId !== invoice.id)
  ) {
    conflict("Invoice source does not belong to this request");
  }
  if (JSON.stringify(source.input.stamp) !== JSON.stringify(source.stamp)) {
    conflict("Invoice PDF and stamp metadata must use the same stamp record");
  }
  return {
    id: invoice.id,
    contentRevision: invoice.contentRevision,
    updatedAt: invoice.updatedAt,
    invoiceNumber: invoice.invoiceNumber,
    issueDate: invoice.issueDate,
    currency: invoice.currency,
    grandTotal: invoice.grandTotal,
    status: invoice.status,
    snapshot:
      "Current invoice at export, not an invoice snapshot captured at evidence acceptance",
    stamp: stampRecord(source.stamp),
    // Detect any source change without exporting extra invoice/party fields.
    sourceSha256: sha256(JSON.stringify(source.input)),
  };
}

function originalEntryName(contentType: string): string {
  const extensions: Record<string, string> = {
    "application/pdf": "pdf",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "text/plain": "txt",
  };
  return `accepted-original.${extensions[contentType] ?? "bin"}`;
}

const dependencies: EvidencePackDependencies = {
  assertRequest: async (principal, id) =>
    (await import("./access")).assertEvidenceRequest(principal, id, true),
  readFile: async (principal, id) =>
    (await import("./files")).readEvidenceFile(principal, id),
  history: async (request) => {
    const { and, asc, eq } = await import("drizzle-orm");
    const { getDb, evidenceFilesTable, evidenceEventsTable } =
      await import("@workspace/db");
    const files = await getDb()
      .select({
        id: evidenceFilesTable.id,
        requestId: evidenceFilesTable.requestId,
        firmId: evidenceFilesTable.firmId,
        filename: evidenceFilesTable.filename,
        contentType: evidenceFilesTable.contentType,
        byteSize: evidenceFilesTable.byteSize,
        sha256: evidenceFilesTable.sha256,
        scanStatus: evidenceFilesTable.scanStatus,
        uploadedBy: evidenceFilesTable.uploadedBy,
        createdAt: evidenceFilesTable.createdAt,
        scannedAt: evidenceFilesTable.scannedAt,
      })
      .from(evidenceFilesTable)
      .where(
        and(
          eq(evidenceFilesTable.requestId, request.id),
          eq(evidenceFilesTable.firmId, request.firmId),
        ),
      )
      .orderBy(asc(evidenceFilesTable.createdAt), asc(evidenceFilesTable.id))
      .limit(MAX_EVIDENCE_PACK_FILES + 1);
    const events = await getDb()
      .select({
        id: evidenceEventsTable.id,
        requestId: evidenceEventsTable.requestId,
        firmId: evidenceEventsTable.firmId,
        actorId: evidenceEventsTable.actorId,
        action: evidenceEventsTable.action,
        comment: evidenceEventsTable.comment,
        fileId: evidenceEventsTable.fileId,
        createdAt: evidenceEventsTable.createdAt,
      })
      .from(evidenceEventsTable)
      .where(
        and(
          eq(evidenceEventsTable.requestId, request.id),
          eq(evidenceEventsTable.firmId, request.firmId),
        ),
      )
      .orderBy(asc(evidenceEventsTable.createdAt), asc(evidenceEventsTable.id))
      .limit(MAX_EVIDENCE_PACK_EVENTS + 1);
    return { files, events };
  },
  invoice: async (principal, request) => {
    if (!request.invoiceId) return null;
    const { assertCan, assertSameTenant, assertClientPartyScope } =
      await import("../auth/rbac");
    const { getInvoiceWithLines } = await import("../invoice/service");
    assertCan(principal, "invoice.read");
    const bundle = await getInvoiceWithLines(request.invoiceId);
    if (
      !bundle ||
      bundle.invoice.firmId !== request.firmId ||
      bundle.invoice.supplierPartyId !== request.clientPartyId
    ) {
      throw new DomainError("NOT_FOUND", "Invoice anchor not found", 404);
    }
    assertSameTenant(principal, bundle.invoice.firmId);
    assertClientPartyScope(principal, bundle.invoice.supplierPartyId);
    const { asc, eq, inArray } = await import("drizzle-orm");
    const { getDb, partiesTable, stampRecordsTable } =
      await import("@workspace/db");
    const { loadFirmBrand } = await import("../invoice/pdf-brand");
    const parties = await getDb()
      .select()
      .from(partiesTable)
      .where(
        inArray(partiesTable.id, [
          bundle.invoice.supplierPartyId,
          bundle.invoice.buyerPartyId,
        ]),
      );
    const supplier = parties.find(
      (party) => party.id === bundle.invoice.supplierPartyId,
    );
    const buyer = parties.find(
      (party) => party.id === bundle.invoice.buyerPartyId,
    );
    if (!supplier || !buyer)
      throw new DomainError("NOT_FOUND", "Invoice parties not found", 404);
    const [stamp] = await getDb()
      .select()
      .from(stampRecordsTable)
      .where(eq(stampRecordsTable.invoiceId, bundle.invoice.id))
      .orderBy(asc(stampRecordsTable.createdAt), asc(stampRecordsTable.id))
      .limit(1);
    const brand = await loadFirmBrand(request.firmId);
    return {
      input: {
        ...bundle,
        supplier,
        buyer,
        stamp: stamp ?? null,
        theme: brand.theme,
      },
      stamp: stamp ?? null,
    };
  },
};

export async function exportEvidencePack(
  principal: Principal,
  requestId: string,
  deps: EvidencePackDependencies = dependencies,
): Promise<EvidencePack> {
  const request = await deps.assertRequest(principal, requestId);
  if (request.status !== "accepted" || !request.acceptedFileId)
    conflict("Accept a clean evidence file before exporting a pack");
  const pinnedFileId = request.acceptedFileId;
  const loaded = await deps.readFile(principal, pinnedFileId);
  assertEvidenceSource(request, loaded, pinnedFileId);
  if (loaded.bytes.length >= MAX_EVIDENCE_PACK_BYTES) tooLarge();
  const history = validateHistory(
    request,
    loaded.file,
    await deps.history(request),
  );
  const invoice = await deps.invoice(principal, request);
  const invoiceMetadata = invoiceRecord(request, invoice);
  const entries: Record<string, Uint8Array> = Object.create(null);
  const originalName = originalEntryName(loaded.file.contentType);
  entries[originalName] = loaded.bytes;
  if (invoice) entries["invoice.pdf"] = await renderInvoicePdf(invoice.input);
  if (invoiceMetadata?.stamp)
    entries["stamp.json"] = Buffer.from(
      JSON.stringify(invoiceMetadata.stamp, null, 2),
    );
  const manifest = {
    schemaVersion: 1,
    ...history,
    invoice: invoiceMetadata,
    original: {
      entry: originalName,
      fileId: pinnedFileId,
      sha256: loaded.file.sha256,
      byteSize: loaded.file.byteSize,
    },
    scope:
      "Only the accepted original is attached; other immutable file versions are metadata-only. Acceptance records a human review, not authenticity or payment verification.",
    entries: Object.entries(entries).map(([name, bytes]) => ({
      name,
      byteSize: bytes.byteLength,
      sha256: sha256(Buffer.from(bytes)),
    })),
  };
  entries["manifest.json"] = Buffer.from(JSON.stringify(manifest, null, 2));
  const rawSize = Object.values(entries).reduce(
    (total, bytes) => total + bytes.byteLength,
    0,
  );
  if (
    rawSize >= MAX_EVIDENCE_PACK_BYTES ||
    Object.keys(entries).length > MAX_EVIDENCE_PACK_FILES
  )
    tooLarge();
  // fflate is the archive implementation; originals are stored, never decoded
  // or recompressed, and entry names are exclusively application-generated.
  const { zipSync } = await import("fflate");
  const bytes = Buffer.from(
    zipSync(entries, { level: 0, mtime: new Date("2000-01-01T00:00:00Z") }),
  );
  if (bytes.length >= MAX_EVIDENCE_PACK_BYTES) tooLarge();
  const current = await deps.assertRequest(principal, requestId);
  const currentFile = await deps.readFile(principal, pinnedFileId);
  assertEvidenceSource(current, currentFile, pinnedFileId);
  const currentHistory = validateHistory(
    current,
    currentFile.file,
    await deps.history(current),
  );
  const currentInvoice = invoiceRecord(
    current,
    await deps.invoice(principal, current),
  );
  if (
    JSON.stringify(currentHistory) !== JSON.stringify(history) ||
    JSON.stringify(currentInvoice) !== JSON.stringify(invoiceMetadata)
  ) {
    conflict(
      "Evidence or its invoice changed during export; request a fresh pack",
    );
  }
  return {
    bytes,
    contentType: "application/zip",
    filename: "evidence-pack.zip",
  };
}
