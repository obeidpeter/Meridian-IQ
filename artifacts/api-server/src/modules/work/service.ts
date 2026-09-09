import { and, desc, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
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
import { decodeWorkCursor, encodeWorkCursor, workFilterKey } from "./cursor";

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
      workItemsTable.id,
    )
    .limit(options.limit);
}

export async function listWorkItemPage(
  principal: Principal,
  options: {
    view: "active" | "done" | "all";
    clientPartyId?: string;
    cursor?: string;
    limit: number;
  },
) {
  const scopedClient = clientPartyScope(principal);
  if (
    scopedClient &&
    options.clientPartyId &&
    scopedClient !== options.clientPartyId
  ) {
    throw new DomainError(
      "CROSS_CLIENT",
      "Resource is not within your client scope",
      403,
    );
  }
  const conditions = [
    ...scopeConditions(principal),
    ...(options.clientPartyId
      ? [eq(workItemsTable.clientPartyId, options.clientPartyId)]
      : []),
    ...(options.view === "active" ? [ne(workItemsTable.status, "done")] : []),
    ...(options.view === "done" ? [eq(workItemsTable.status, "done")] : []),
  ];
  const filter = workFilterKey({
    userId: principal.userId,
    role: principal.role,
    firmId: principal.firmId,
    clientId: scopedClient,
    clientPartyId: options.clientPartyId ?? null,
    view: options.view,
  });
  const rank = sql<number>`case ${workItemsTable.priority} when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`;
  const cursor = options.cursor
    ? decodeWorkCursor(options.cursor, filter)
    : null;
  // Match nulls-last ordering without truncating PostgreSQL timestamp precision.
  const afterCursor = cursor
    ? or(
        sql`${rank} > ${cursor.rank}`,
        and(
          sql`${rank} = ${cursor.rank}`,
          cursor.due === null
            ? and(
                isNull(workItemsTable.dueAt),
                gt(workItemsTable.id, cursor.id),
              )
            : or(
                isNull(workItemsTable.dueAt),
                sql`${workItemsTable.dueAt} > ${cursor.due}::timestamptz`,
                and(
                  sql`${workItemsTable.dueAt} = ${cursor.due}::timestamptz`,
                  gt(workItemsTable.id, cursor.id),
                ),
              ),
        ),
      )
    : undefined;
  // The scoped total rides the same statement as the rows (R114): an
  // uncorrelated scalar subquery is evaluated once per statement, and one
  // statement means one snapshot, so the total can never disagree with the
  // page it is returned with. The inner work_items reference binds to the
  // subquery's own table, not the outer row.
  const scopedTotal = sql<number>`(select count(*) from ${workItemsTable} where ${and(...conditions)})::integer`;
  const rows = await getDb()
    .select({
      ...itemSelection(),
      cursorRank: rank,
      cursorDue: sql<
        string | null
      >`to_char(${workItemsTable.dueAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      scopedTotal: scopedTotal.mapWith(Number),
    })
    .from(workItemsTable)
    .leftJoin(partiesTable, eq(partiesTable.id, workItemsTable.clientPartyId))
    .leftJoin(assigneeUsers, eq(assigneeUsers.id, workItemsTable.assignedTo))
    .leftJoin(creatorUsers, eq(creatorUsers.id, workItemsTable.createdBy))
    .where(and(...conditions, afterCursor))
    .orderBy(
      rank,
      sql`${workItemsTable.dueAt} asc nulls last`,
      workItemsTable.id,
    )
    .limit(options.limit + 1);
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  // An empty page carries no row to read the total from. Without a cursor
  // that means the scoped set is empty; past the last row the caller already
  // holds the total from the page it followed, and only then is a second,
  // separate read made.
  const total =
    rows[0]?.scopedTotal ??
    (cursor
      ? ((
          await getDb()
            .select({ total: sql<number>`count(*)::integer`.mapWith(Number) })
            .from(workItemsTable)
            .where(and(...conditions))
        )[0]?.total ?? 0)
      : 0);
  return {
    total,
    items: page.map(
      ({ cursorRank: _rank, cursorDue: _due, scopedTotal: _total, ...item }) =>
        item,
    ),
    nextCursor:
      rows.length > options.limit && last
        ? encodeWorkCursor(
            { rank: last.cursorRank, due: last.cursorDue, id: last.id },
            filter,
          )
        : null,
  };
}

export async function getWorkItemView(principal: Principal, id: string) {
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
