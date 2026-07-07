// Operator-editable validation-error catalogue (ADV-03). The built-in seed set
// (modules/errors.ts) is persisted into the error_catalogue table on boot; from
// there operators can add or edit entries within a working day without an
// engineering release, and every surface reuses the same rows as in-app help.

import { eq } from "drizzle-orm";
import { getDb, errorCatalogueTable } from "@workspace/db";
import { ERROR_CATALOGUE } from "../errors";

export interface CatalogueEntryView {
  code: string;
  category: string;
  cause: string;
  fix: string;
  retriable: boolean;
  source: "builtin" | "operator";
  updatedBy: string | null;
  updatedAt: Date;
}

type Row = typeof errorCatalogueTable.$inferSelect;

function toView(row: Row): CatalogueEntryView {
  return {
    code: row.code,
    category: row.category,
    cause: row.cause,
    fix: row.fix,
    retriable: row.retriable,
    source: row.source,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}

// Seed the built-in rejection codes as immutable-source reference data. Uses
// onConflictDoNothing so operator edits to a seeded code are never overwritten.
export async function seedCatalogue(): Promise<number> {
  const rows = Object.values(ERROR_CATALOGUE).map((e) => ({
    code: e.code,
    category: e.code.startsWith("MBS_")
      ? "mbs"
      : e.code.startsWith("RAIL_")
        ? "rail"
        : "general",
    cause: e.cause,
    fix: e.fix,
    retriable: e.retriable,
    source: "builtin" as const,
  }));
  for (const r of rows) {
    await getDb()
      .insert(errorCatalogueTable)
      .values(r)
      .onConflictDoNothing({ target: errorCatalogueTable.code });
  }
  return rows.length;
}

export async function listCatalogue(): Promise<CatalogueEntryView[]> {
  const rows = await getDb()
    .select()
    .from(errorCatalogueTable)
    .orderBy(errorCatalogueTable.code);
  return rows.map(toView);
}

export async function getCatalogueEntry(
  code: string,
): Promise<CatalogueEntryView | null> {
  const [row] = await getDb()
    .select()
    .from(errorCatalogueTable)
    .where(eq(errorCatalogueTable.code, code))
    .limit(1);
  return row ? toView(row) : null;
}

export interface UpsertInput {
  code: string;
  category?: string;
  cause: string;
  fix: string;
  retriable?: boolean;
}

// Create or overwrite an entry. An operator write always marks the row as
// operator-sourced and stamps the actor.
export async function upsertCatalogueEntry(
  input: UpsertInput,
  actorId: string,
): Promise<CatalogueEntryView> {
  const values = {
    code: input.code,
    category: input.category ?? "general",
    cause: input.cause,
    fix: input.fix,
    retriable: input.retriable ?? false,
    source: "operator" as const,
    updatedBy: actorId,
    updatedAt: new Date(),
  };
  const [row] = await getDb()
    .insert(errorCatalogueTable)
    .values(values)
    .onConflictDoUpdate({
      target: errorCatalogueTable.code,
      set: {
        category: values.category,
        cause: values.cause,
        fix: values.fix,
        retriable: values.retriable,
        source: values.source,
        updatedBy: values.updatedBy,
        updatedAt: values.updatedAt,
      },
    })
    .returning();
  return toView(row);
}

export interface PatchInput {
  category?: string;
  cause?: string;
  fix?: string;
  retriable?: boolean;
}

export async function updateCatalogueEntry(
  code: string,
  patch: PatchInput,
  actorId: string,
): Promise<CatalogueEntryView | null> {
  const [existing] = await getDb()
    .select()
    .from(errorCatalogueTable)
    .where(eq(errorCatalogueTable.code, code))
    .limit(1);
  if (!existing) return null;
  const [row] = await getDb()
    .update(errorCatalogueTable)
    .set({
      category: patch.category ?? existing.category,
      cause: patch.cause ?? existing.cause,
      fix: patch.fix ?? existing.fix,
      retriable: patch.retriable ?? existing.retriable,
      source: "operator",
      updatedBy: actorId,
      updatedAt: new Date(),
    })
    .where(eq(errorCatalogueTable.code, code))
    .returning();
  return toView(row);
}
