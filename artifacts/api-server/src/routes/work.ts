import { Router, type IRouter } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  getDb,
  membershipsTable,
  workItemCommentsTable,
  workItemsTable,
} from "@workspace/db";
import {
  CreateWorkItemBody,
  CreateWorkItemCommentBody,
  CreateWorkItemCommentParams,
  CreateWorkItemCommentResponse,
  CreateWorkItemResponse,
  ListWorkItemCommentsParams,
  ListWorkItemCommentsResponse,
  ListWorkItemsQueryParams,
  ListWorkItemsResponse,
  ListWorkItemsPageQueryParams,
  ListWorkItemsPageResponse,
  UpdateWorkItemBody,
  UpdateWorkItemParams,
  UpdateWorkItemResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import { pageBounds } from "../lib/page";
import { isUuid } from "../lib/uuid";
import {
  assertCan,
  assertPartyAccess,
  clientPartyScope,
  requireFirmScope,
} from "../modules/auth/rbac";
import { appendAudit } from "../modules/audit/audit";
import { DomainError } from "../modules/errors";
import {
  getWorkItemCommentView,
  getWorkItemView,
  listCommentViews,
  listWorkItemViews,
  listWorkItemPage,
} from "../modules/work/service";

const router: IRouter = Router();

function requireUserId(userId: string): string {
  if (!isUuid(userId)) {
    throw new DomainError(
      "WORK_IDENTITY_REQUIRED",
      "A persisted user account is required for collaborative work",
      403,
    );
  }
  return userId;
}

function safeHref(href: string | undefined): string | null {
  if (href === undefined) return null;
  if (
    !href.startsWith("/") ||
    href.startsWith("//") ||
    href.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(href)
  ) {
    throw new DomainError("INVALID_WORK_LINK", "Work link is invalid", 400);
  }
  return href;
}

async function assertAssignable(
  firmId: string,
  userId: string | null | undefined,
  clientPartyId: string | null,
): Promise<void> {
  if (!userId) return;
  const memberships = await getDb()
    .select({
      userId: membershipsTable.userId,
      role: membershipsTable.role,
      clientPartyId: membershipsTable.clientPartyId,
    })
    .from(membershipsTable)
    .where(
      and(
        eq(membershipsTable.firmId, firmId),
        eq(membershipsTable.userId, userId),
      ),
    );
  if (memberships.length === 0) {
    throw new DomainError(
      "INVALID_ASSIGNEE",
      "Assignee is not a member of this workspace",
      400,
    );
  }
  const mayAccessTask = memberships.some(
    (membership) =>
      membership.role !== "client_user" ||
      (Boolean(clientPartyId) && membership.clientPartyId === clientPartyId),
  );
  if (!mayAccessTask) {
    throw new DomainError(
      "INVALID_ASSIGNEE",
      "A client user may only own work for their own business",
      400,
    );
  }
}

function workEntityType(body: {
  entityType?: string;
  entityId?: string;
}): string | undefined {
  if ((body.entityType === undefined) !== (body.entityId === undefined)) {
    throw new DomainError(
      "INVALID_WORK_ENTITY",
      "Entity type and entity id must be provided together",
      400,
    );
  }
  const entityType = body.entityType?.trim();
  if (entityType?.toLowerCase() === "evidence_request") {
    throw new DomainError(
      "EVIDENCE_WORK_CONTROLLED",
      "Create document requests through the Evidence Hub",
      403,
    );
  }
  if (body.entityType !== undefined && !entityType) {
    throw new DomainError(
      "INVALID_WORK_ENTITY",
      "Entity type must not be blank",
      400,
    );
  }
  return entityType;
}

function assertEvidenceWorkPatch(
  entityType: string | null,
  changedFields: string[],
): void {
  if (
    entityType === "evidence_request" &&
    changedFields.some((field) => field !== "priority")
  ) {
    throw new DomainError(
      "EVIDENCE_WORK_CONTROLLED",
      "Update document requests through the Evidence Hub; work comments and priority remain available",
      403,
    );
  }
}

router.get("/work-items", async (req, res): Promise<void> => {
  assertCan(req.principal, "work.read");
  const query = parseOrThrow(ListWorkItemsQueryParams, req.query);
  const rows = await listWorkItemViews(req.principal, {
    status: query.status,
    clientPartyId: query.clientPartyId,
    limit: query.limit,
  });
  res.json(ListWorkItemsResponse.parse(rows));
});

router.get("/work-items/page", async (req, res): Promise<void> => {
  assertCan(req.principal, "work.read");
  const query = parseOrThrow(ListWorkItemsPageQueryParams, req.query);
  // Bounded read (R114): the contract's default and ceiling are restated
  // through the one home for list bounds, so lib/page.ts governs this route
  // like every other list.
  const { limit } = pageBounds(query, { defaultLimit: 50, maxLimit: 100 });
  res.json(
    ListWorkItemsPageResponse.parse(
      await listWorkItemPage(req.principal, { ...query, limit }),
    ),
  );
});

router.post("/work-items", async (req, res): Promise<void> => {
  assertCan(req.principal, "work.write");
  const body = parseOrThrow(CreateWorkItemBody.strict(), req.body);
  const firmId = requireFirmScope(req.principal);
  const userId = requireUserId(req.principal.userId);
  const title = body.title.trim();
  if (title.length < 2) {
    throw new DomainError(
      "WORK_TITLE_REQUIRED",
      "Work item title must contain at least two visible characters",
      400,
    );
  }
  const ownClient = clientPartyScope(req.principal);
  if (ownClient && body.clientPartyId && body.clientPartyId !== ownClient) {
    throw new DomainError(
      "CROSS_CLIENT",
      "Resource is not within your client scope",
      403,
    );
  }
  const clientPartyId = ownClient ?? body.clientPartyId ?? null;
  if (clientPartyId) await assertPartyAccess(req.principal, clientPartyId);
  if (req.principal.role === "client_user" && body.assignedTo !== userId) {
    if (body.assignedTo !== undefined) {
      throw new DomainError(
        "INVALID_ASSIGNEE",
        "Client users may only assign work to themselves",
        403,
      );
    }
  }
  await assertAssignable(firmId, body.assignedTo, clientPartyId);
  const entityType = workEntityType(body);

  const [inserted] = await getDb()
    .insert(workItemsTable)
    .values({
      firmId,
      clientPartyId,
      title,
      description: body.description?.trim() || null,
      priority: body.priority ?? "normal",
      dueAt: body.dueAt ?? null,
      assignedTo: body.assignedTo ?? null,
      createdBy: userId,
      entityType: entityType ?? null,
      entityId: body.entityId ?? null,
      href: safeHref(body.href),
      clientRequestId: body.clientRequestId,
    })
    .onConflictDoNothing({
      target: [workItemsTable.firmId, workItemsTable.clientRequestId],
    })
    .returning({ id: workItemsTable.id });

  const existing = inserted
    ? undefined
    : (
        await getDb()
          .select({
            id: workItemsTable.id,
            entityType: workItemsTable.entityType,
          })
          .from(workItemsTable)
          .where(
            and(
              eq(workItemsTable.firmId, firmId),
              eq(workItemsTable.clientRequestId, body.clientRequestId),
            ),
          )
          .limit(1)
      )[0];
  if (existing?.entityType === "evidence_request") {
    throw new DomainError(
      "EVIDENCE_WORK_CONTROLLED",
      "Document request work is managed through the Evidence Hub",
      403,
    );
  }
  const id = inserted?.id ?? existing?.id;
  if (!id) {
    throw new DomainError(
      "WORK_CREATE_FAILED",
      "Work item could not be created",
      500,
    );
  }
  if (inserted) {
    await appendAudit({
      actorId: userId,
      firmId,
      action: "work_item.created",
      entityType: "work_item",
      entityId: id,
      after: { clientPartyId, priority: body.priority ?? "normal" },
    });
  }
  res
    .status(201)
    .json(
      CreateWorkItemResponse.parse(await getWorkItemView(req.principal, id)),
    );
});

router.patch("/work-items/:id", async (req, res): Promise<void> => {
  assertCan(req.principal, "work.write");
  const params = parseOrThrow(UpdateWorkItemParams, req.params);
  const body = parseOrThrow(UpdateWorkItemBody.strict(), req.body);
  if (!isUuid(params.id)) {
    throw new DomainError("NOT_FOUND", "Work item not found", 404);
  }
  const changedFields = Object.keys(body).filter((key) => key !== "version");
  if (changedFields.length === 0) {
    throw new DomainError("NO_CHANGES", "Provide a field to update", 400);
  }
  const current = await getWorkItemView(req.principal, params.id);
  assertEvidenceWorkPatch(current.entityType, changedFields);
  const title = body.title?.trim();
  if (body.title !== undefined && (!title || title.length < 2)) {
    throw new DomainError(
      "WORK_TITLE_REQUIRED",
      "Work item title must contain at least two visible characters",
      400,
    );
  }
  if (
    req.principal.role === "client_user" &&
    changedFields.some((field) => field !== "status" && field !== "assignedTo")
  ) {
    throw new DomainError(
      "WORK_UPDATE_FORBIDDEN",
      "Client users may update task status and self-assignment only",
      403,
    );
  }
  if (
    req.principal.role === "client_user" &&
    body.assignedTo !== undefined &&
    ((body.assignedTo !== null && body.assignedTo !== req.principal.userId) ||
      (body.assignedTo === null &&
        current.assignedTo !== null &&
        current.assignedTo !== req.principal.userId))
  ) {
    throw new DomainError(
      "INVALID_ASSIGNEE",
      "Client users may only assign work to themselves",
      403,
    );
  }
  await assertAssignable(
    current.firmId,
    body.assignedTo,
    current.clientPartyId,
  );
  const completedAt =
    body.status === "done"
      ? (current.completedAt ?? new Date())
      : body.status !== undefined
        ? null
        : current.completedAt;
  const [updated] = await getDb()
    .update(workItemsTable)
    .set({
      ...(title !== undefined ? { title } : {}),
      ...(body.description !== undefined
        ? { description: body.description?.trim() || null }
        : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      ...(body.dueAt !== undefined ? { dueAt: body.dueAt } : {}),
      ...(body.assignedTo !== undefined ? { assignedTo: body.assignedTo } : {}),
      completedAt,
      version: sql`${workItemsTable.version} + 1`,
    })
    .where(
      and(
        eq(workItemsTable.id, params.id),
        eq(workItemsTable.firmId, current.firmId),
        eq(workItemsTable.version, body.version),
      ),
    )
    .returning({ id: workItemsTable.id });
  if (!updated) {
    throw new DomainError(
      "WORK_ITEM_CHANGED",
      "This work item changed elsewhere. Refresh it before saving again.",
      409,
    );
  }
  await appendAudit({
    actorId: req.principal.userId,
    firmId: current.firmId,
    action: "work_item.updated",
    entityType: "work_item",
    entityId: params.id,
    before: { status: current.status, version: current.version },
    after: { status: body.status ?? current.status, changedFields },
  });
  res.json(
    UpdateWorkItemResponse.parse(
      await getWorkItemView(req.principal, params.id),
    ),
  );
});

router.get("/work-items/:id/comments", async (req, res): Promise<void> => {
  assertCan(req.principal, "work.read");
  const params = parseOrThrow(ListWorkItemCommentsParams, req.params);
  if (!isUuid(params.id)) {
    throw new DomainError("NOT_FOUND", "Work item not found", 404);
  }
  res.json(
    ListWorkItemCommentsResponse.parse(
      await listCommentViews(req.principal, params.id),
    ),
  );
});

router.post("/work-items/:id/comments", async (req, res): Promise<void> => {
  assertCan(req.principal, "work.write");
  const params = parseOrThrow(CreateWorkItemCommentParams, req.params);
  const body = parseOrThrow(CreateWorkItemCommentBody.strict(), req.body);
  if (!isUuid(params.id)) {
    throw new DomainError("NOT_FOUND", "Work item not found", 404);
  }
  const item = await getWorkItemView(req.principal, params.id);
  const authorId = requireUserId(req.principal.userId);
  const mentionedUserIds = [...new Set(body.mentionedUserIds ?? [])];
  if (mentionedUserIds.length > 0) {
    const memberships = await getDb()
      .select({
        userId: membershipsTable.userId,
        role: membershipsTable.role,
        clientPartyId: membershipsTable.clientPartyId,
      })
      .from(membershipsTable)
      .where(
        and(
          eq(membershipsTable.firmId, item.firmId),
          inArray(membershipsTable.userId, mentionedUserIds),
        ),
      );
    const permitted = new Set(
      memberships
        .filter(
          (membership) =>
            membership.role !== "client_user" ||
            (Boolean(item.clientPartyId) &&
              membership.clientPartyId === item.clientPartyId),
        )
        .map((membership) => membership.userId),
    );
    if (mentionedUserIds.some((userId) => !permitted.has(userId))) {
      throw new DomainError(
        "INVALID_MENTION",
        "Every mentioned user must belong to the permitted task scope",
        400,
      );
    }
  }
  const commentBody = body.body.trim();
  if (!commentBody) {
    throw new DomainError(
      "COMMENT_BODY_REQUIRED",
      "Comment must contain visible text",
      400,
    );
  }
  const [inserted] = await getDb()
    .insert(workItemCommentsTable)
    .values({
      firmId: item.firmId,
      workItemId: item.id,
      authorId,
      body: commentBody,
      mentionedUserIds,
      clientRequestId: body.clientRequestId,
    })
    .onConflictDoNothing({
      target: [
        workItemCommentsTable.workItemId,
        workItemCommentsTable.clientRequestId,
      ],
    })
    .returning({ id: workItemCommentsTable.id });
  const id =
    inserted?.id ??
    (
      await getDb()
        .select({ id: workItemCommentsTable.id })
        .from(workItemCommentsTable)
        .where(
          and(
            eq(workItemCommentsTable.workItemId, item.id),
            eq(workItemCommentsTable.clientRequestId, body.clientRequestId),
          ),
        )
        .limit(1)
    )[0]?.id;
  if (!id) {
    throw new DomainError(
      "COMMENT_CREATE_FAILED",
      "Comment could not be created",
      500,
    );
  }
  const comment = await getWorkItemCommentView(req.principal, item.id, id);
  if (inserted) {
    await appendAudit({
      actorId: authorId,
      firmId: item.firmId,
      action: "work_item.comment_added",
      entityType: "work_item",
      entityId: item.id,
      after: { mentionedUserCount: mentionedUserIds.length },
    });
  }
  res.status(201).json(CreateWorkItemCommentResponse.parse(comment));
});

export default router;
