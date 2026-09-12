import { and, asc, count, desc, eq, exists, ne } from "drizzle-orm";
import {
  engagementsTable,
  evidenceEventsTable,
  evidenceFilesTable,
  evidenceRequestsTable,
  getDb,
  type EvidenceFile,
  type EvidenceRequest,
} from "@workspace/db";
import { narrowToClientPartyScope, type Principal } from "../auth/rbac";
import {
  assertEvidenceClient,
  assertEvidenceRequest,
  evidenceIdentity,
} from "./access";
import { evidenceScannerAvailable } from "./clamav";
import { evidenceStorageAvailable } from "./security";
import { normalizeEvidenceIds } from "./identifiers";

export const evidenceFileMetadataColumns = {
  id: evidenceFilesTable.id,
  firmId: evidenceFilesTable.firmId,
  requestId: evidenceFilesTable.requestId,
  filename: evidenceFilesTable.filename,
  contentType: evidenceFilesTable.contentType,
  byteSize: evidenceFilesTable.byteSize,
  sha256: evidenceFilesTable.sha256,
  scanStatus: evidenceFilesTable.scanStatus,
  scanError: evidenceFilesTable.scanError,
  scanAttempts: evidenceFilesTable.scanAttempts,
  leaseUntil: evidenceFilesTable.leaseUntil,
  uploadedBy: evidenceFilesTable.uploadedBy,
  createdAt: evidenceFilesTable.createdAt,
  scannedAt: evidenceFilesTable.scannedAt,
};

export function evidenceRequestView(r: EvidenceRequest) {
  return {
    id: r.id,
    firmId: r.firmId,
    clientPartyId: r.clientPartyId,
    invoiceId: r.invoiceId,
    filingId: r.filingId,
    period: r.period,
    title: r.title,
    description: r.description,
    documentType: r.documentType,
    status: r.status,
    ownerId: r.ownerId,
    createdBy: r.createdBy,
    dueAt: r.dueAt?.toISOString() ?? null,
    version: r.version,
    latestFileId: r.latestFileId,
    acceptedFileId: r.acceptedFileId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function evidenceFileView(
  f: Pick<EvidenceFile, keyof typeof evidenceFileMetadataColumns>,
) {
  return {
    id: f.id,
    requestId: f.requestId,
    filename: f.filename,
    contentType: f.contentType,
    byteSize: f.byteSize,
    sha256: f.sha256,
    scanStatus: f.scanStatus,
    scanError:
      f.scanError ??
      (f.scanStatus === "quarantined" &&
      f.scanAttempts >= 5 &&
      (!f.leaseUntil || f.leaseUntil <= new Date())
        ? "The security scan was interrupted. Your accounting team can retry it."
        : null),
    uploadedBy: f.uploadedBy,
    createdAt: f.createdAt.toISOString(),
    scannedAt: f.scannedAt?.toISOString() ?? null,
  };
}

export async function evidenceDetail(principal: Principal, requestId: string) {
  const request = await assertEvidenceRequest(principal, requestId);
  const files = await getDb()
    .select(evidenceFileMetadataColumns)
    .from(evidenceFilesTable)
    .where(eq(evidenceFilesTable.requestId, request.id))
    .orderBy(desc(evidenceFilesTable.createdAt), evidenceFilesTable.id);
  const events = await getDb()
    .select()
    .from(evidenceEventsTable)
    .where(eq(evidenceEventsTable.requestId, request.id))
    .orderBy(asc(evidenceEventsTable.createdAt), evidenceEventsTable.id);
  return {
    request: evidenceRequestView(request),
    files: files.map(evidenceFileView),
    events: events.map((e) => ({
      id: e.id,
      requestId: e.requestId,
      actorId: e.actorId,
      action: e.action,
      comment: e.comment,
      fileId: e.fileId,
      createdAt: e.createdAt.toISOString(),
    })),
  };
}

export async function listEvidenceRequests(
  principal: Principal,
  options: {
    clientPartyId?: string;
    invoiceId?: string;
    filingId?: string;
    status?: EvidenceRequest["status"];
    offset?: number;
    limit?: number;
  },
) {
  options = normalizeEvidenceIds(options);
  const firmId = await evidenceIdentity(principal);
  const clientPartyId = narrowToClientPartyScope(
    principal,
    options.clientPartyId,
  );
  if (clientPartyId) await assertEvidenceClient(principal, clientPartyId);
  const conditions = [
    eq(evidenceRequestsTable.firmId, firmId),
    exists(
      getDb()
        .select({ id: engagementsTable.id })
        .from(engagementsTable)
        .where(
          and(
            eq(engagementsTable.firmId, firmId),
            eq(
              engagementsTable.clientPartyId,
              evidenceRequestsTable.clientPartyId,
            ),
            ne(engagementsTable.status, "archived"),
          ),
        ),
    ),
  ];
  if (clientPartyId)
    conditions.push(eq(evidenceRequestsTable.clientPartyId, clientPartyId));
  if (options.invoiceId)
    conditions.push(eq(evidenceRequestsTable.invoiceId, options.invoiceId));
  if (options.filingId)
    conditions.push(eq(evidenceRequestsTable.filingId, options.filingId));
  if (options.status)
    conditions.push(eq(evidenceRequestsTable.status, options.status));
  const [total] = await getDb()
    .select({ total: count() })
    .from(evidenceRequestsTable)
    .where(and(...conditions));
  const items = await getDb()
    .select()
    .from(evidenceRequestsTable)
    .where(and(...conditions))
    .orderBy(desc(evidenceRequestsTable.updatedAt), evidenceRequestsTable.id)
    .limit(Math.min(50, Math.max(1, options.limit ?? 20)))
    .offset(Math.max(0, options.offset ?? 0));
  const uploadAvailable = evidenceStorageAvailable();
  const scanAvailable = evidenceScannerAvailable();
  const notice = !uploadAvailable
    ? "Secure document storage is not configured. Contact your administrator."
    : !scanAvailable
      ? "Uploads stay private and quarantined until the security scanner is available."
      : null;
  return {
    items: items.map(evidenceRequestView),
    total: total.total,
    uploadAvailable,
    scanAvailable,
    notice,
  };
}
