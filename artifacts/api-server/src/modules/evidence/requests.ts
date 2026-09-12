import { and, count, eq } from "drizzle-orm";
import {
  evidenceRequestsTable,
  getDb,
  withTransaction,
  type EvidenceRequest,
} from "@workspace/db";
import type { Principal } from "../auth/rbac";
import { DomainError } from "../errors";
import {
  assertEvidenceAnchor,
  assertEvidenceClient,
  assertEvidenceOwner,
  evidenceIdentity,
} from "./access";
import {
  assertReplay,
  commandHash,
  lockEvidenceFirm,
  recordEvidenceEvent,
} from "./commands";
import { evidenceDetail } from "./views";
import { normalizeEvidenceIds } from "./identifiers";
import { syncEvidenceWork } from "./work-links";

export interface CreateEvidenceInput {
  clientPartyId: string;
  invoiceId?: string;
  filingId?: string;
  period?: string;
  title: string;
  description?: string;
  documentType: EvidenceRequest["documentType"];
  dueAt?: string;
  ownerId?: string;
  clientRequestId: string;
}

export async function createEvidenceRequest(
  principal: Principal,
  input: CreateEvidenceInput,
) {
  input = normalizeEvidenceIds(input);
  return withTransaction(async () => {
    const firmId = await evidenceIdentity(principal, "evidence.request");
    await assertEvidenceClient(principal, input.clientPartyId);
    await lockEvidenceFirm(firmId);
    const normalized = {
      ...input,
      title: input.title.trim(),
      description: input.description?.trim() || null,
      ownerId: input.ownerId ?? principal.userId,
    };
    if (normalized.title.length < 2)
      throw new DomainError(
        "EVIDENCE_TITLE_REQUIRED",
        "Give this request a clear name.",
        400,
      );
    const hash = commandHash(normalized);
    const [existing] = await getDb()
      .select()
      .from(evidenceRequestsTable)
      .where(
        and(
          eq(evidenceRequestsTable.firmId, firmId),
          eq(evidenceRequestsTable.clientRequestId, input.clientRequestId),
        ),
      )
      .limit(1);
    if (existing) {
      assertReplay(existing.requestHash, hash);
      return evidenceDetail(principal, existing.id);
    }
    await assertEvidenceAnchor(firmId, input);
    await assertEvidenceOwner(firmId, input.clientPartyId, normalized.ownerId);
    const [usage] = await getDb()
      .select({ total: count() })
      .from(evidenceRequestsTable)
      .where(eq(evidenceRequestsTable.firmId, firmId));
    if (usage.total >= 5000)
      throw new DomainError(
        "EVIDENCE_REQUEST_LIMIT",
        "This workspace has reached its evidence-request limit. Contact support.",
        409,
      );
    const [request] = await getDb()
      .insert(evidenceRequestsTable)
      .values({
        ...normalized,
        firmId,
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
        createdBy: principal.userId,
        requestHash: hash,
      })
      .returning();
    await syncEvidenceWork(request);
    await recordEvidenceEvent(principal, request, {
      action: "requested",
      clientRequestId: input.clientRequestId,
      requestHash: hash,
    });
    return evidenceDetail(principal, request.id);
  });
}
