import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, getDb, invoiceDraftsTable as drafts } from "@workspace/db";
import {
  assertCan,
  assertPartyAccess,
  requireFirmScope,
  type Principal,
} from "../auth/rbac";
import { DomainError } from "../errors";
import { DraftContent, type DraftWrite } from "./contract";

const TTL = 7 * 24 * 60 * 60 * 1000;
async function scope(principal: Principal, clientPartyId: string) {
  if (
    ["operator", "auditor", "bank_user", "buyer_user"].includes(principal.role)
  ) {
    throw new DomainError(
      "FORBIDDEN",
      "Draft recovery requires a firm-scoped owner without bypass",
      403,
    );
  }
  assertCan(principal, "invoice.write");
  const firmId = requireFirmScope(principal);
  const tx = getDb();
  if (tx === db)
    throw new Error("Draft recovery requires the caller's tenant transaction");
  await assertPartyAccess(principal, clientPartyId);
  const engagement = await tx.execute(
    sql`SELECT 1 FROM engagements WHERE firm_id = ${firmId}::uuid AND client_party_id = ${clientPartyId}::uuid AND status <> 'archived' LIMIT 1`,
  );
  if (!engagement.rows.length)
    throw new DomainError(
      "FORBIDDEN",
      "Client is not engaged by this firm",
      403,
    );
  await tx.execute(
    sql`SELECT set_config('app.invoice_draft_user_id', ${principal.userId}, true), set_config('app.invoice_draft_client_id', ${clientPartyId}, true)`,
  );
  return { firmId, userId: principal.userId, clientPartyId };
}
const conditions = (owner: {
  firmId: string;
  userId: string;
  clientPartyId: string;
}) => [
  eq(drafts.firmId, owner.firmId),
  eq(drafts.userId, owner.userId),
  eq(drafts.clientPartyId, owner.clientPartyId),
];
const view = (row: typeof drafts.$inferSelect) => ({
  id: row.id,
  revision: row.revision,
  writeId: row.writeId,
  draft: DraftContent.parse(row.content),
  updatedAt: row.updatedAt.toISOString(),
  expiresAt: row.expiresAt.toISOString(),
});
const conflict = () =>
  new DomainError(
    "DRAFT_CONFLICT",
    "This draft changed or was discarded elsewhere. Reload it or save your edits as a new draft.",
    409,
  );

export async function listInvoiceDrafts(
  principal: Principal,
  clientPartyId: string,
  offset = 0,
) {
  const owner = await scope(principal, clientPartyId);
  const rows = await getDb()
    .select()
    .from(drafts)
    .where(
      and(
        ...conditions(owner),
        isNull(drafts.deletedAt),
        gt(drafts.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(drafts.updatedAt), desc(drafts.id))
    .limit(51)
    .offset(offset);
  return {
    items: rows.slice(0, 50).map(view),
    nextOffset: rows.length > 50 ? offset + 50 : null,
  };
}

export async function getInvoiceDraft(
  principal: Principal,
  clientPartyId: string,
  id: string,
) {
  const owner = await scope(principal, clientPartyId);
  const [row] = await getDb()
    .select()
    .from(drafts)
    .where(
      and(
        ...conditions(owner),
        eq(drafts.id, id),
        isNull(drafts.deletedAt),
        gt(drafts.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!row)
    throw new DomainError("NOT_FOUND", "Draft not found or expired", 404);
  return view(row);
}

export async function saveInvoiceDraft(
  principal: Principal,
  id: string,
  input: DraftWrite,
) {
  const owner = await scope(principal, input.clientPartyId);
  return getDb().transaction(async (tx) => {
    const now = new Date();
    const values = {
      ...owner,
      id,
      content: input.draft,
      revision: 1,
      writeId: input.writeId,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + TTL),
    };
    if (input.expectedRevision === 0) {
      const [inserted] = await tx
        .insert(drafts)
        .values(values)
        .onConflictDoNothing()
        .returning();
      if (inserted) return view(inserted);
    }
    const [row] = await tx
      .select()
      .from(drafts)
      .where(and(...conditions(owner), eq(drafts.id, id)))
      .for("update");
    if (!row || row.deletedAt || row.expiresAt <= now) throw conflict();
    if (row.writeId === input.writeId) {
      if (
        JSON.stringify(DraftContent.parse(row.content)) !==
        JSON.stringify(input.draft)
      )
        throw conflict();
      return view(row);
    }
    if (row.revision !== input.expectedRevision) throw conflict();
    const [saved] = await tx
      .update(drafts)
      .set({
        content: input.draft,
        revision: row.revision + 1,
        writeId: input.writeId,
        updatedAt: now,
        expiresAt: values.expiresAt,
      })
      .where(
        and(
          ...conditions(owner),
          eq(drafts.id, id),
          eq(drafts.revision, input.expectedRevision),
        ),
      )
      .returning();
    if (!saved) throw conflict();
    return view(saved);
  });
}

export async function deleteInvoiceDraft(
  principal: Principal,
  clientPartyId: string,
  id: string,
  expectedRevision: number,
) {
  const owner = await scope(principal, clientPartyId);
  return getDb().transaction(async (tx) => {
    if (expectedRevision === 0) {
      const now = new Date();
      const [tombstone] = await tx
        .insert(drafts)
        .values({
          ...owner,
          id,
          revision: 1,
          writeId: randomUUID(),
          content: {},
          deletedAt: now,
          updatedAt: now,
          expiresAt: new Date(now.getTime() + TTL),
        })
        .onConflictDoNothing()
        .returning();
      if (tombstone) return;
    }
    const [row] = await tx
      .select()
      .from(drafts)
      .where(and(...conditions(owner), eq(drafts.id, id)))
      .for("update");
    if (!row) {
      if (expectedRevision === 0) return;
      throw conflict();
    }
    if (row.deletedAt) return;
    if (row.revision !== expectedRevision) throw conflict();
    // Keep the revision tombstone so a late autosave cannot resurrect a discard.
    await tx
      .update(drafts)
      .set({ deletedAt: new Date(), content: {}, revision: row.revision + 1 })
      .where(and(...conditions(owner), eq(drafts.id, id)));
  });
}
