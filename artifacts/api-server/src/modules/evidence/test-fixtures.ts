import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  engagementsTable,
  evidenceFilesTable,
  evidenceRequestsTable,
  firmsTable,
  getDb,
  membershipsTable,
  partiesTable,
  usersTable,
  type EvidenceRequest,
} from "@workspace/db";
import { makeRunSalt } from "../../test-helpers/fixtures";

export async function evidenceFixture() {
  const salt = makeRunSalt();
  const firmId = randomUUID();
  const otherFirmId = randomUUID();
  const clientPartyId = randomUUID();
  const siblingPartyId = randomUUID();
  const ownerId = randomUUID();
  const clientUserId = randomUUID();
  const siblingUserId = randomUUID();
  const foreignUserId = randomUUID();
  await getDb()
    .insert(firmsTable)
    .values([
      { id: firmId, name: `Evidence work ${salt}` },
      { id: otherFirmId, name: `Other evidence work ${salt}` },
    ]);
  await getDb()
    .insert(partiesTable)
    .values([
      {
        id: clientPartyId,
        type: "client_business",
        legalName: `Evidence client ${salt}`,
      },
      {
        id: siblingPartyId,
        type: "client_business",
        legalName: `Sibling client ${salt}`,
      },
    ]);
  await getDb()
    .insert(usersTable)
    .values(
      [ownerId, clientUserId, siblingUserId, foreignUserId].map((id, i) => ({
        id,
        email: `evidence-work-${i}-${salt}@test.local`,
        fullName: `Evidence member ${i}`,
      })),
    );
  await getDb()
    .insert(membershipsTable)
    .values([
      { firmId, userId: ownerId, role: "firm_staff" },
      { firmId, userId: clientUserId, role: "client_user", clientPartyId },
      {
        firmId,
        userId: siblingUserId,
        role: "client_user",
        clientPartyId: siblingPartyId,
      },
      { firmId: otherFirmId, userId: foreignUserId, role: "firm_staff" },
    ]);
  await getDb()
    .insert(engagementsTable)
    .values([
      {
        firmId,
        clientPartyId,
        type: "retainer",
        title: `Evidence engagement ${salt}`,
      },
      {
        firmId,
        clientPartyId: siblingPartyId,
        type: "retainer",
        title: `Sibling engagement ${salt}`,
      },
      {
        firmId: otherFirmId,
        clientPartyId,
        type: "retainer",
        title: `Other engagement ${salt}`,
      },
    ]);
  return {
    firmId,
    otherFirmId,
    clientPartyId,
    siblingPartyId,
    ownerId,
    clientUserId,
    siblingUserId,
    foreignUserId,
    async request(
      overrides: Partial<typeof evidenceRequestsTable.$inferInsert> = {},
    ) {
      const fileStatus =
        overrides.status === "accepted" || overrides.status === "uploaded"
          ? overrides.status
          : null;
      const [request] = await getDb()
        .insert(evidenceRequestsTable)
        .values({
          firmId,
          clientPartyId,
          title: "Delivery confirmation",
          description: "Private document details must not enter notifications",
          documentType: "delivery_note",
          period: "2099-06",
          ownerId,
          createdBy: ownerId,
          clientRequestId: randomUUID(),
          requestHash: randomUUID(),
          ...overrides,
          ...(fileStatus
            ? {
                status: "requested" as const,
                latestFileId: null,
                acceptedFileId: null,
              }
            : {}),
        })
        .returning();
      if (fileStatus) {
        const file = await cleanEvidenceFile(request);
        const [accepted] = await getDb()
          .update(evidenceRequestsTable)
          .set({
            status: fileStatus,
            latestFileId: file.id,
            acceptedFileId: fileStatus === "accepted" ? file.id : null,
          })
          .where(eq(evidenceRequestsTable.id, request.id))
          .returning();
        return accepted;
      }
      return request;
    },
  };
}

export async function cleanEvidenceFile(request: EvidenceRequest) {
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6vH0AAAAASUVORK5CYII=",
    "base64",
  );
  const [file] = await getDb()
    .insert(evidenceFilesTable)
    .values({
      firmId: request.firmId,
      requestId: request.id,
      filename: "fixture.png",
      contentType: "image/png",
      byteSize: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      encryptedContent: "fixture-only-no-provider",
      scanStatus: "clean",
      uploadedBy: request.createdBy,
      clientRequestId: randomUUID(),
      requestHash: randomUUID(),
    })
    .returning();
  return file;
}
