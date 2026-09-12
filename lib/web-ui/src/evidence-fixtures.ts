import type { EvidenceDetailView, EvidencePrincipal } from "./evidence-types";

export const evidenceFixtureIds = {
  request: "00000000-0000-4000-8000-000000000001",
  firm: "00000000-0000-4000-8000-000000000002",
  client: "00000000-0000-4000-8000-000000000003",
  invoice: "00000000-0000-4000-8000-000000000004",
  user: "00000000-0000-4000-8000-000000000005",
  file: "00000000-0000-4000-8000-000000000006",
};
export const evidenceFixtureMe: EvidencePrincipal = {
  userId: evidenceFixtureIds.user,
  firmId: evidenceFixtureIds.firm,
  role: "firm_staff",
  fullName: "Ada Okafor",
  workspaceName: "Example Practice",
  capabilities: [
    "evidence.read",
    "evidence.request",
    "evidence.upload",
    "evidence.review",
    "party.read",
    "console.portfolio.read",
  ],
  features: ["evidence_hub"],
};
export const evidenceFixtureDetail: EvidenceDetailView = {
  request: {
    id: evidenceFixtureIds.request,
    firmId: evidenceFixtureIds.firm,
    clientPartyId: evidenceFixtureIds.client,
    invoiceId: evidenceFixtureIds.invoice,
    filingId: null,
    period: null,
    title: "Delivery note for September order",
    description: "Please supply the signed delivery note.",
    documentType: "delivery_note",
    status: "uploaded",
    ownerId: evidenceFixtureIds.user,
    createdBy: evidenceFixtureIds.user,
    dueAt: "2026-09-30T16:00:00Z",
    version: 2,
    latestFileId: evidenceFixtureIds.file,
    acceptedFileId: null,
    createdAt: "2026-09-01T09:00:00Z",
    updatedAt: "2026-09-02T09:00:00Z",
  },
  files: [
    {
      id: evidenceFixtureIds.file,
      requestId: evidenceFixtureIds.request,
      filename: "delivery.pdf",
      contentType: "application/pdf",
      byteSize: 9,
      sha256: "a".repeat(64),
      scanStatus: "clean",
      scanError: null,
      uploadedBy: evidenceFixtureIds.user,
      createdAt: "2026-09-02T09:00:00Z",
      scannedAt: "2026-09-02T09:01:00Z",
    },
  ],
  events: [
    {
      id: "event-1",
      requestId: evidenceFixtureIds.request,
      actorId: evidenceFixtureIds.user,
      action: "requested",
      comment: "Signed copy required.",
      fileId: null,
      createdAt: "2026-09-01T09:00:00Z",
    },
  ],
};
