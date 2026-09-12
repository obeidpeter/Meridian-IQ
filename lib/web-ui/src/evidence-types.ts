export type EvidenceDocumentKind =
  | "purchase_order"
  | "delivery_note"
  | "payment_receipt"
  | "tax_acknowledgement"
  | "contract"
  | "other";
export type EvidenceStatus =
  | "requested"
  | "uploaded"
  | "needs_changes"
  | "accepted"
  | "cancelled";
export type EvidenceMediaType = "image/jpeg" | "image/png" | "application/pdf";

// Structural view contracts keep web-ui independent of the generated API client.
export interface EvidenceRecord {
  id: string;
  firmId: string;
  clientPartyId: string;
  invoiceId: string | null;
  filingId: string | null;
  period: string | null;
  title: string;
  description: string | null;
  documentType: EvidenceDocumentKind;
  status: EvidenceStatus;
  ownerId: string;
  createdBy: string;
  dueAt: string | null;
  version: number;
  latestFileId: string | null;
  acceptedFileId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface EvidenceVersion {
  id: string;
  requestId: string;
  filename: string;
  contentType: EvidenceMediaType;
  byteSize: number;
  sha256: string;
  scanStatus: "quarantined" | "clean" | "rejected";
  scanError: string | null;
  uploadedBy: string;
  createdAt: string;
  scannedAt: string | null;
}
export interface EvidenceHistoryEntry {
  id: string;
  requestId: string;
  actorId: string | null;
  action: string;
  comment: string | null;
  fileId: string | null;
  createdAt: string;
}
export interface EvidenceDetailView {
  request: EvidenceRecord;
  files: EvidenceVersion[];
  events: EvidenceHistoryEntry[];
}
export interface EvidencePageResult {
  items: EvidenceRecord[];
  total: number;
  uploadAvailable: boolean;
  scanAvailable: boolean;
  notice: string | null;
}
export interface EvidenceFilters {
  clientPartyId?: string;
  invoiceId?: string;
  filingId?: string;
  status?: EvidenceStatus;
  offset?: number;
  limit?: number;
}
export interface EvidenceCreateInput {
  clientPartyId: string;
  invoiceId?: string;
  filingId?: string;
  period?: string;
  title: string;
  description?: string;
  documentType: EvidenceDocumentKind;
  dueAt?: string;
  ownerId?: string;
  clientRequestId: string;
}
export interface EvidenceUploadInput {
  clientRequestId: string;
  expectedVersion: number;
  filename: string;
  contentType: EvidenceMediaType;
  contentBase64: string;
}
export interface EvidenceReviewInput {
  clientRequestId: string;
  expectedVersion: number;
  fileId?: string;
  decision: "accepted" | "needs_changes" | "cancelled";
  comment?: string;
}
export interface EvidenceUpdateInput {
  clientRequestId: string;
  expectedVersion: number;
  ownerId?: string;
  dueAt?: string | null;
}
export interface EvidenceAdvice {
  summary: string;
  suggestedDocumentType: string | null;
  checks: Array<{
    label: string;
    status: "match" | "mismatch" | "unknown";
    sourceValue: string | null;
    expectedValue: string | null;
  }>;
  extractedText: string | null;
  clerkCaseId?: string | null;
}
export interface EvidencePrincipal {
  userId: string;
  role: string;
  firmId?: string | null;
  clientPartyId?: string | null;
  workspaceName?: string | null;
  fullName?: string | null;
  capabilities: string[];
  features: string[];
}
export interface EvidenceOption {
  id: string;
  label: string;
}
export interface EvidenceApi {
  clientName?: (id: string, signal: AbortSignal) => Promise<EvidenceOption>;
  invoices?: (
    clientPartyId: string,
    search: string,
    offset: number,
    signal: AbortSignal,
  ) => Promise<{ items: EvidenceOption[]; hasMore: boolean }>;
  filings?: (
    clientPartyId: string,
    search: string,
    offset: number,
    signal: AbortSignal,
  ) => Promise<{ items: EvidenceOption[]; hasMore: boolean }>;
  update: (
    id: string,
    input: EvidenceUpdateInput,
  ) => Promise<EvidenceDetailView>;
  list: (
    filters: EvidenceFilters,
    signal: AbortSignal,
  ) => Promise<EvidencePageResult>;
  detail: (id: string, signal: AbortSignal) => Promise<EvidenceDetailView>;
  create: (input: EvidenceCreateInput) => Promise<EvidenceDetailView>;
  upload: (
    id: string,
    input: EvidenceUploadInput,
  ) => Promise<EvidenceDetailView>;
  review: (
    id: string,
    input: EvidenceReviewInput,
  ) => Promise<EvidenceDetailView>;
  scan: (
    id: string,
    input: { clientRequestId: string },
  ) => Promise<EvidenceDetailView>;
  assist: (id: string, input: { fileId: string }) => Promise<EvidenceAdvice>;
  download: (id: string) => Promise<Blob>;
  pack: (id: string) => Promise<Blob>;
  clients?: (
    search: string,
    offset: number,
    signal: AbortSignal,
  ) => Promise<EvidenceOption[]>;
  owners?: (signal: AbortSignal) => Promise<EvidenceOption[]>;
}
