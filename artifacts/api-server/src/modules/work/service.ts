import { and, desc, eq, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  getDb,
  partiesTable,
  usersTable,
  workItemCommentsTable,
  workItemsTable,
} from "@workspace/db";
import type { Principal } from "../auth/rbac";
import { clientPartyScope, requireFirmScope } from "../auth/rbac";
import { DomainError } from "../errors";

const assigneeUsers = alias(usersTable, "work_assignee_users");
const creatorUsers = alias(usersTable, "work_creator_users");
const authorUsers = alias(usersTable, "work_comment_author_users");

function itemSelection() {
  return {
    id: workItemsTable.id,
    firmId: workItemsTable.firmId,
    clientPartyId: workItemsTable.clientPartyId,
    clientName: partiesTable.legalName,
    title: workItemsTable.title,
    description: workItemsTable.description,
    status: workItemsTable.status,
    priority: workItemsTable.priority,
    dueAt: workItemsTable.dueAt,
    assignedTo: workItemsTable.assignedTo,
    assignedToName: assigneeUsers.fullName,
    createdBy: workItemsTable.createdBy,
    createdByName: creatorUsers.fullName,
    entityType: workItemsTable.entityType,
    entityId: workItemsTable.entityId,
    href: workItemsTable.href,
    version: workItemsTable.version,
    completedAt: workItemsTable.completedAt,
    createdAt: workItemsTable.createdAt,
    updatedAt: workItemsTable.updatedAt,
  };
}

function itemQuery() {
  return getDb()
    .select(itemSelection())
    .from(workItemsTable)
    .leftJoin(partiesTable, eq(partiesTable.id, workItemsTable.clientPartyId))
    .leftJoin(assigneeUsers, eq(assigneeUsers.id, workItemsTable.assignedTo))
    .leftJoin(creatorUsers, eq(creatorUsers.id, workItemsTable.createdBy));
}

function commentSelection() {
  return {
    id: workItemCommentsTable.id,
    workItemId: workItemCommentsTable.workItemId,
    authorId: workItemCommentsTable.authorId,
    authorName: authorUsers.fullName,
    body: workItemCommentsTable.body,
    mentionedUserIds: workItemCommentsTable.mentionedUserIds,
    createdAt: workItemCommentsTable.createdAt,
  };
}

function commentQuery() {
  return getDb()
    .select(commentSelection())
    .from(workItemCommentsTable)
    .leftJoin(authorUsers, eq(authorUsers.id, workItemCommentsTable.authorId));
}

function scopeConditions(principal: Principal) {
  const firmId = requireFirmScope(principal);
  const clientId = clientPartyScope(principal);
  return [
    eq(workItemsTable.firmId, firmId),
    ...(clientId ? [eq(workItemsTable.clientPartyId, clientId)] : []),
  ];
}

export async function listWorkItemViews(
  principal: Principal,
  options: {
    status?: "open" | "in_progress" | "blocked" | "done";
    clientPartyId?: string;
    openOnly?: boolean;
    limit: number;
  },
) {
  const scopedClient = clientPartyScope(principal);
  const conditions = [
    ...scopeConditions(principal),
    ...(options.clientPartyId
      ? [eq(workItemsTable.clientPartyId, options.clientPartyId)]
      : []),
    ...(options.status ? [eq(workItemsTable.status, options.status)] : []),
    ...(options.openOnly ? [ne(workItemsTable.status, "done")] : []),
  ];
  if (
    scopedClient &&
    options.clientPartyId &&
    options.clientPartyId !== scopedClient
  ) {
    throw new DomainError(
      "CROSS_CLIENT",
      "Resource is not within your client scope",
      403,
    );
  }
  return itemQuery()
    .where(and(...conditions))
    .orderBy(
      sql`case ${workItemsTable.priority}
        when 'urgent' then 0 when 'high' then 1
        when 'normal' then 2 else 3 end`,
      sql`${workItemsTable.dueAt} asc nulls last`,
      desc(workItemsTable.createdAt),
    )
    .limit(options.limit);
}

export async function getWorkItemView(
  principal: Principal,
  id: string,
) {
  const [row] = await itemQuery()
    .where(and(...scopeConditions(principal), eq(workItemsTable.id, id)))
    .limit(1);
  if (!row) {
    throw new DomainError("NOT_FOUND", "Work item not found", 404);
  }
  return row;
}

export async function listCommentViews(
  principal: Principal,
  workItemId: string,
) {
  await getWorkItemView(principal, workItemId);
  const rows = await commentQuery()
    .where(
      and(
        eq(workItemCommentsTable.firmId, requireFirmScope(principal)),
        eq(workItemCommentsTable.workItemId, workItemId),
      ),
    )
    .orderBy(desc(workItemCommentsTable.createdAt))
    .limit(200);
  return rows.reverse();
}

export async function getWorkItemCommentView(
  principal: Principal,
  workItemId: string,
  id: string,
) {
  await getWorkItemView(principal, workItemId);
  const [row] = await commentQuery()
    .where(
      and(
        eq(workItemCommentsTable.firmId, requireFirmScope(principal)),
        eq(workItemCommentsTable.workItemId, workItemId),
        eq(workItemCommentsTable.id, id),
      ),
    )
    .limit(1);
  if (!row) {
    throw new DomainError("NOT_FOUND", "Work item comment not found", 404);
  }
  return row;
}
