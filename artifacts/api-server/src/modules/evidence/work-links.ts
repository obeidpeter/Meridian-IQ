import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  evidenceEventsTable,
  evidenceRequestsTable,
  getDb,
  hasDatabaseContext,
  membershipsTable,
  messagesTable,
  withTransaction,
  workItemsTable,
  type EvidenceRequest,
  type EvidenceEvent,
  type WorkItem,
} from "@workspace/db";
import { DomainError } from "../errors";
import { pointerEntityRef, recipientRefFor } from "../messaging/recipient-ref";

const WORK_STATUS: Record<EvidenceRequest["status"], WorkItem["status"]> = {
  requested: "open",
  uploaded: "in_progress",
  needs_changes: "blocked",
  accepted: "done",
  cancelled: "done",
};

function assertMatchingWork(
  item: WorkItem | undefined,
  request: EvidenceRequest,
): asserts item is WorkItem {
  if (
    !item ||
    item.entityType !== "evidence_request" ||
    item.entityId !== request.id ||
    item.clientPartyId !== request.clientPartyId ||
    item.createdBy !== request.createdBy
  ) {
    throw new DomainError(
      "EVIDENCE_WORK_CONFLICT",
      "Document request conflicts with an existing work item",
      409,
    );
  }
}

function projectionMatches(
  item: WorkItem,
  projection: Pick<
    WorkItem,
    "title" | "status" | "assignedTo" | "dueAt" | "href" | "completedAt"
  >,
): boolean {
  return (
    item.title === projection.title &&
    item.status === projection.status &&
    item.assignedTo === projection.assignedTo &&
    item.dueAt?.getTime() === projection.dueAt?.getTime() &&
    item.href === projection.href &&
    item.completedAt?.getTime() === projection.completedAt?.getTime()
  );
}

/** The request API owns this projection; callers retain their transaction. */
export async function syncEvidenceWork(
  request: EvidenceRequest,
): Promise<void> {
  await withTransaction(async () => {
    await getDb().execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`evidence:${request.firmId}`}, 0))`,
    );
    const [current] = await getDb()
      .select()
      .from(evidenceRequestsTable)
      .where(
        and(
          eq(evidenceRequestsTable.id, request.id),
          eq(evidenceRequestsTable.firmId, request.firmId),
          eq(evidenceRequestsTable.clientPartyId, request.clientPartyId),
        ),
      )
      .for("update")
      .limit(1);
    if (!current) {
      throw new DomainError("NOT_FOUND", "Document request not found", 404);
    }

    const [owner] = await getDb()
      .select({ id: membershipsTable.id })
      .from(membershipsTable)
      .where(
        and(
          eq(membershipsTable.firmId, current.firmId),
          eq(membershipsTable.userId, current.ownerId),
          or(
            inArray(membershipsTable.role, ["firm_admin", "firm_staff"]),
            and(
              eq(membershipsTable.role, "client_user"),
              eq(membershipsTable.clientPartyId, current.clientPartyId),
            ),
          ),
        ),
      )
      .limit(1);
    const status = WORK_STATUS[current.status];
    const projection = {
      title: `Document request: ${current.title}`,
      status,
      // A departed owner remains in request history, not as an active assignee.
      assignedTo: owner ? current.ownerId : null,
      dueAt: current.dueAt,
      href: `/evidence?request=${current.id}`,
    };
    const [inserted] = await getDb()
      .insert(workItemsTable)
      .values({
        ...projection,
        firmId: current.firmId,
        clientPartyId: current.clientPartyId,
        createdBy: current.createdBy,
        entityType: "evidence_request",
        entityId: current.id,
        clientRequestId: current.id,
        completedAt: status === "done" ? current.updatedAt : null,
      })
      .onConflictDoNothing({
        target: [workItemsTable.firmId, workItemsTable.clientRequestId],
      })
      .returning({ id: workItemsTable.id });
    if (inserted) return;

    const [item] = await getDb()
      .select()
      .from(workItemsTable)
      .where(
        and(
          eq(workItemsTable.firmId, current.firmId),
          eq(workItemsTable.clientRequestId, current.id),
        ),
      )
      .for("update")
      .limit(1);
    assertMatchingWork(item, current);
    const completedAt =
      status === "done" ? (item.completedAt ?? current.updatedAt) : null;
    if (projectionMatches(item, { ...projection, completedAt })) return;
    await getDb()
      .update(workItemsTable)
      .set({
        ...projection,
        completedAt,
        version: sql`${workItemsTable.version} + 1`,
      })
      .where(
        and(
          eq(workItemsTable.id, item.id),
          eq(workItemsTable.firmId, current.firmId),
          eq(workItemsTable.clientPartyId, current.clientPartyId),
          eq(workItemsTable.entityType, "evidence_request"),
          eq(workItemsTable.entityId, current.id),
        ),
      );
  });
}

const TRANSITION_TEMPLATES = new Map([
  ["requested", "document_request_created"],
  ["uploaded", "document_request_uploaded"],
  ["needs_changes", "document_request_needs_changes"],
  ["accepted", "document_request_accepted"],
  ["cancelled", "document_request_cancelled"],
]);

/** Call after inserting the unique command event, inside the same transaction. */
export async function notifyEvidenceTransition(
  request: EvidenceRequest,
  event: EvidenceEvent,
): Promise<void> {
  if (!hasDatabaseContext())
    throw new Error("Evidence notifications require the event transaction");
  const [stored] = await getDb()
    .select({
      request: evidenceRequestsTable,
      action: evidenceEventsTable.action,
    })
    .from(evidenceEventsTable)
    .innerJoin(
      evidenceRequestsTable,
      and(
        eq(evidenceRequestsTable.id, evidenceEventsTable.requestId),
        eq(evidenceRequestsTable.firmId, evidenceEventsTable.firmId),
      ),
    )
    .where(
      and(
        eq(evidenceEventsTable.id, event.id),
        eq(evidenceEventsTable.requestId, request.id),
        eq(evidenceEventsTable.firmId, request.firmId),
        eq(evidenceRequestsTable.clientPartyId, request.clientPartyId),
      ),
    )
    .limit(1);
  if (!stored)
    throw new DomainError("NOT_FOUND", "Document request event not found", 404);
  const templateKey = TRANSITION_TEMPLATES.get(stored.action);
  if (!templateKey) return;
  const current = stored.request;
  const staff = stored.action === "uploaded";
  const recipientScope = staff
    ? and(
        eq(membershipsTable.userId, current.ownerId),
        inArray(membershipsTable.role, ["firm_admin", "firm_staff"]),
      )
    : and(
        eq(membershipsTable.clientPartyId, current.clientPartyId),
        eq(membershipsTable.role, "client_user"),
      );
  const [recipient] = await getDb()
    .select({ id: membershipsTable.id })
    .from(membershipsTable)
    .where(and(eq(membershipsTable.firmId, current.firmId), recipientScope))
    .for("share")
    .limit(1);
  if (!recipient) return;
  // One recipient identity per transition: the event UUID is the durable replay key.
  await getDb()
    .insert(messagesTable)
    .values({
      id: event.id,
      channel: "in_app",
      templateKey,
      entityType: "evidence_request",
      entityId: current.id,
      recipientRef: staff
        ? pointerEntityRef("usr", current.ownerId)
        : recipientRefFor(current.clientPartyId),
      recipientUserId: staff ? current.ownerId : null,
      recipientPartyId: staff ? null : current.clientPartyId,
      status: "delivered",
    })
    .onConflictDoNothing({ target: messagesTable.id });
}
