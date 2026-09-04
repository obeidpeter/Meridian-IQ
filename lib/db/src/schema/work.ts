import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id, updatedAt } from "./columns.ts";
import { firmsTable, usersTable } from "./organizations.ts";
import { partiesTable } from "./parties.ts";

// Shared human work, separate from machine-owned outbox jobs. Work items are
// deliberately small pointers into the compliance spine: comments may contain
// coordination notes, but invoices, filings and evidence remain in their
// authoritative tables. `version` provides an explicit lost-update guard and
// `client_request_id` makes retrying a create safe across poor connections.
export const workItemStatusEnum = pgEnum("work_item_status", [
  "open",
  "in_progress",
  "blocked",
  "done",
]);

export const workItemPriorityEnum = pgEnum("work_item_priority", [
  "low",
  "normal",
  "high",
  "urgent",
]);

export const workItemsTable = pgTable(
  "work_items",
  {
    id: id(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    clientPartyId: uuid("client_party_id").references(() => partiesTable.id),
    title: text("title").notNull(),
    description: text("description"),
    status: workItemStatusEnum("status").notNull().default("open"),
    priority: workItemPriorityEnum("priority").notNull().default("normal"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    assignedTo: uuid("assigned_to").references(() => usersTable.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => usersTable.id),
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    href: text("href"),
    clientRequestId: uuid("client_request_id").notNull(),
    version: integer("version").notNull().default(1),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("work_items_firm_request_uq").on(
      t.firmId,
      t.clientRequestId,
    ),
    index("work_items_firm_status_due_idx").on(
      t.firmId,
      t.status,
      t.dueAt,
    ),
    index("work_items_client_status_idx").on(t.clientPartyId, t.status),
    index("work_items_assignee_status_idx").on(t.assignedTo, t.status),
  ],
);

// Comments are append-only coordination evidence. A client request id is
// unique per work item so a retried offline/slow-network submission cannot
// create the same note twice. Mention ids are validated against memberships
// before insertion; JSON keeps the notification-ready list compact.
export const workItemCommentsTable = pgTable(
  "work_item_comments",
  {
    id: id(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    workItemId: uuid("work_item_id")
      .notNull()
      .references(() => workItemsTable.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => usersTable.id),
    body: text("body").notNull(),
    mentionedUserIds: jsonb("mentioned_user_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    clientRequestId: uuid("client_request_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("work_item_comments_item_request_uq").on(
      t.workItemId,
      t.clientRequestId,
    ),
    index("work_item_comments_item_created_idx").on(
      t.workItemId,
      t.createdAt,
    ),
    index("work_item_comments_firm_idx").on(t.firmId),
  ],
);

export type WorkItem = typeof workItemsTable.$inferSelect;
export type WorkItemComment = typeof workItemCommentsTable.$inferSelect;
