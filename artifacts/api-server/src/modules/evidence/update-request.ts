import { eq } from "drizzle-orm";
import { evidenceRequestsTable, getDb, withTransaction } from "@workspace/db";
import type { Principal } from "../auth/rbac";
import { DomainError } from "../errors";
import {
  assertEvidenceOwner,
  assertEvidenceRequest,
  evidenceIdentity,
} from "./access";
import {
  assertEvidenceVersion,
  commandHash,
  lockEvidenceFirm,
  recordEvidenceEvent,
  replayEvidenceEvent,
} from "./commands";
import { evidenceDetail } from "./views";
import { normalizeEvidenceIds } from "./identifiers";
import { syncEvidenceWork } from "./work-links";

export interface UpdateEvidenceInput {
  clientRequestId: string;
  expectedVersion: number;
  ownerId?: string;
  dueAt?: string | null;
}

export async function updateEvidenceRequest(
  principal: Principal,
  requestId: string,
  input: UpdateEvidenceInput,
) {
  input = normalizeEvidenceIds(input);
  return withTransaction(async () => {
    const firmId = await evidenceIdentity(principal, "evidence.request");
    await lockEvidenceFirm(firmId);
    const request = await assertEvidenceRequest(principal, requestId, true);
    const hash = commandHash({ action: "assignment_updated", ...input });
    if (await replayEvidenceEvent(requestId, input.clientRequestId, hash))
      return evidenceDetail(principal, requestId);
    assertEvidenceVersion(request, input.expectedVersion);
    if (request.status === "accepted" || request.status === "cancelled")
      throw new DomainError(
        "EVIDENCE_CLOSED",
        "This request is closed. Request changes before changing its assignment.",
        409,
      );
    if (input.ownerId === undefined && input.dueAt === undefined)
      throw new DomainError(
        "EVIDENCE_CHANGE_REQUIRED",
        "Choose an owner or due date to update.",
        400,
      );
    const ownerId = input.ownerId ?? request.ownerId;
    await assertEvidenceOwner(firmId, request.clientPartyId, ownerId);
    const dueAt =
      input.dueAt === undefined
        ? request.dueAt
        : input.dueAt === null
          ? null
          : new Date(input.dueAt);
    const [updated] = await getDb()
      .update(evidenceRequestsTable)
      .set({
        ownerId,
        dueAt,
        version: request.version + 1,
        updatedAt: new Date(),
        lastReminderAt: null,
      })
      .where(eq(evidenceRequestsTable.id, requestId))
      .returning();
    await syncEvidenceWork(updated);
    await recordEvidenceEvent(principal, updated, {
      action: "assignment_updated",
      clientRequestId: input.clientRequestId,
      requestHash: hash,
    });
    return evidenceDetail(principal, requestId);
  });
}
