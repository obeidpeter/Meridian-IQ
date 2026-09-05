import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, partiesTable, withTransaction } from "@workspace/db";
import { ImportInvoicesBody } from "@workspace/api-zod";
import { createDraft, bulkCreateDrafts } from "./service";
import { DomainError } from "../errors";
import { decimalInputError, isCalendarDate } from "./input-validation";

// The spreadsheet import engine (SME-02, NFR-03), extracted from the
// /invoices/import route: the route keeps auth/scope/size gating and the
// contract parse; this module owns row validation, buyer resolution and the
// two commit strategies. Runs on getDb() inside the caller's ambient request
// transaction.

export type ImportRow = z.infer<typeof ImportInvoicesBody>["rows"][number];

export interface ImportRowResult {
  rowNumber: number;
  status: "valid" | "invalid" | "created";
  invoiceId: string | null;
  invoiceNumber: string | null;
  errors: { field: string; message: string }[];
}

export interface ImportResult {
  total: number;
  validCount: number;
  invalidCount: number;
  createdCount: number;
  committed: boolean;
  rows: ImportRowResult[];
}

// Mandatory-field validation for a single spreadsheet row (SME-02). Mirrors the
// guided single-invoice rules so bulk import gives the same catalogue guidance.
export function validateImportRow(
  row: Record<string, unknown>,
): { field: string; message: string }[] {
  const errors: { field: string; message: string }[] = [];
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const req = (field: string, label: string) => {
    if (!str(row[field]))
      errors.push({ field, message: `${label} is required` });
  };
  req("invoiceNumber", "Invoice number");
  req("buyerName", "Buyer name");
  req("buyerTin", "Buyer TIN");
  req("issueDate", "Issue date");
  req("description", "Line description");

  const issueDate = str(row.issueDate);
  if (issueDate && !isCalendarDate(issueDate)) {
    errors.push({
      field: "issueDate",
      message: "Issue date is not a valid date",
    });
  }
  // dueDate is optional but must be a real date when present — the bulk path
  // inserts rows in one statement, so one bad date would otherwise abort the
  // whole import with a DB error instead of a per-row result.
  const dueDate = str(row.dueDate);
  if (dueDate && !isCalendarDate(dueDate)) {
    errors.push({ field: "dueDate", message: "Due date is not a valid date" });
  }
  const num = (field: string, label: string, min: number) => {
    const raw = str(row[field]);
    if (!raw) {
      errors.push({ field, message: `${label} is required` });
      return;
    }
    const n = Number(raw);
    const decimalError = decimalInputError(
      raw,
      label,
      field === "quantity" ? 14 : 16,
      field === "quantity" ? 4 : 2,
      min > 0,
    );
    if (decimalError) {
      errors.push({ field, message: decimalError });
    } else if (!Number.isFinite(n)) {
      errors.push({ field, message: `${label} must be a number` });
    } else if (n < min) {
      errors.push({ field, message: `${label} must be at least ${min}` });
    }
  };
  num("quantity", "Quantity", 0.0001);
  num("unitPrice", "Unit price", 0);
  const vat = str(row.vatRate);
  if (!vat) {
    errors.push({ field: "vatRate", message: "VAT rate is required" });
  } else {
    const n = Number(vat);
    if (
      decimalInputError(vat, "VAT rate", 2, 4) ||
      !Number.isFinite(n) ||
      n < 0 ||
      n > 1
    ) {
      errors.push({
        field: "vatRate",
        message: "VAT rate must be a fraction between 0 and 1 (e.g. 0.075)",
      });
    }
  }
  return errors;
}

export async function importInvoices(
  firmId: string,
  clientPartyId: string,
  rows: ImportRow[],
  commit: boolean,
  actorId: string,
): Promise<ImportResult> {
  if (
    !commit ||
    !rows.some(
      (row) => validateImportRow(row as Record<string, unknown>).length === 0,
    )
  ) {
    return importInvoiceRows(firmId, clientPartyId, rows, commit, actorId);
  }
  return withTransaction(async () => {
    const isolation = await getDb().execute<{ isolation: string }>(
      sql`SELECT current_setting('transaction_isolation') AS isolation`,
    );
    if (isolation.rows[0]?.isolation !== "read committed") {
      throw new Error(
        "Invoice buyer resolution requires READ COMMITTED isolation",
      );
    }
    // One lock for this supplier, before any buyer read. Acquiring per-TIN
    // locks inside row savepoints can deadlock for reversed row orders and
    // lose locks on bulk fallback; this boundary survives every row rollback.
    const lockScope = JSON.stringify([
      "invoice.import.buyers",
      firmId.toLowerCase(),
      clientPartyId.toLowerCase(),
    ]);
    await getDb().execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockScope}, 0))`,
    );
    return importInvoiceRows(firmId, clientPartyId, rows, true, actorId);
  });
}

function buyerCreator(actorId: string): string | null {
  const parsed = z.string().uuid().safeParse(actorId);
  return parsed.success ? parsed.data : null;
}

async function findImportBuyers(
  firmId: string,
  clientPartyId: string,
  actorId: string,
  tins: string[],
) {
  const creatorId = buyerCreator(actorId);
  // Parties have no tenant RLS. This service lacks the full principal, so use
  // the narrower supplier sphere, never a global TIN match or firm-wide roster.
  return getDb()
    .select({ id: partiesTable.id, tin: partiesTable.tin })
    .from(partiesTable)
    .where(
      and(
        inArray(partiesTable.tin, tins),
        isNull(partiesTable.mergedIntoId),
        or(
          eq(partiesTable.id, clientPartyId),
          creatorId
            ? and(
                eq(partiesTable.createdByFirmId, firmId),
                eq(partiesTable.createdByUserId, creatorId),
              )
            : undefined,
          sql`EXISTS (SELECT 1 FROM invoices i WHERE i.firm_id = ${firmId}::uuid
          AND i.supplier_party_id = ${clientPartyId}::uuid
          AND (i.supplier_party_id = ${partiesTable.id} OR i.buyer_party_id = ${partiesTable.id}))`,
        ),
      ),
    )
    .orderBy(asc(partiesTable.createdAt), asc(partiesTable.id));
}

async function importInvoiceRows(
  firmId: string,
  clientPartyId: string,
  rows: ImportRow[],
  commit: boolean,
  actorId: string,
): Promise<ImportResult> {
  const results: ImportRowResult[] = [];
  let validCount = 0;
  let invalidCount = 0;
  let createdCount = 0;

  // NFR-03: large committed imports take the bulk path — chunked multi-row
  // inserts instead of ~6 statements per row — so a 5,000-row import completes
  // well inside the request-transaction budget.
  const BULK_THRESHOLD = 100;
  if (commit && rows.length > BULK_THRESHOLD) {
    try {
      return await withTransaction(async () => {
        const valid: typeof rows = [];
        for (const row of rows) {
          const errors = validateImportRow(row as Record<string, unknown>);
          if (errors.length > 0) {
            invalidCount += 1;
            results.push({
              rowNumber: row.rowNumber,
              status: "invalid",
              invoiceId: null,
              invoiceNumber: row.invoiceNumber ?? null,
              errors,
            });
            continue;
          }
          valid.push(row);
        }
        if (valid.length === 0) {
          return {
            total: rows.length,
            validCount: 0,
            invalidCount,
            createdCount: 0,
            committed: true,
            rows: results,
          };
        }
        // Resolve every buyer TIN in one pass; create missing buyers in one insert.
        const tins = [...new Set(valid.map((r) => String(r.buyerTin)))];
        const existingBuyers = await findImportBuyers(
          firmId,
          clientPartyId,
          actorId,
          tins,
        );
        const buyerByTin = new Map<string | null, string>();
        for (const buyer of existingBuyers) {
          if (!buyerByTin.has(buyer.tin)) buyerByTin.set(buyer.tin, buyer.id);
        }
        const missing = valid.filter(
          (r) => !buyerByTin.has(String(r.buyerTin)),
        );
        const missingByTin = new Map(
          missing.map((r) => [String(r.buyerTin), String(r.buyerName)]),
        );
        if (missingByTin.size > 0) {
          const createdBuyers = await getDb()
            .insert(partiesTable)
            .values(
              [...missingByTin.entries()].map(([tin, legalName]) => ({
                type: "buyer" as const,
                legalName,
                tin,
                countryCode: "NG",
                createdByFirmId: firmId,
                createdByUserId: buyerCreator(actorId),
              })),
            )
            .returning({ id: partiesTable.id, tin: partiesTable.tin });
          for (const b of createdBuyers) buyerByTin.set(b.tin, b.id);
        }
        const created = await bulkCreateDrafts(
          firmId,
          valid.map((row) => ({
            rowNumber: row.rowNumber,
            supplierPartyId: clientPartyId,
            buyerPartyId: buyerByTin.get(String(row.buyerTin))!,
            invoiceNumber: String(row.invoiceNumber),
            issueDate: String(row.issueDate),
            dueDate: row.dueDate ? String(row.dueDate) : null,
            currency: row.currency ? String(row.currency) : "NGN",
            line: {
              description: String(row.description),
              quantity: String(row.quantity),
              unitPrice: String(row.unitPrice),
              vatRate: String(row.vatRate),
            },
          })),
          actorId,
        );
        for (const c of created) {
          createdCount += 1;
          validCount += 1;
          results.push({
            rowNumber: c.rowNumber,
            status: "created",
            invoiceId: c.invoiceId,
            invoiceNumber: c.invoiceNumber,
            errors: [],
          });
        }
        results.sort((a, b) => a.rowNumber - b.rowNumber);
        return {
          total: rows.length,
          validCount,
          invalidCount,
          createdCount,
          committed: true,
          rows: results,
        };
      });
    } catch (error) {
      if (!isRowFailure(error)) throw error;
      // The bulk savepoint has rolled back all attempted rows before retry.
      const chunks: ImportResult[] = [];
      for (let start = 0; start < rows.length; start += BULK_THRESHOLD) {
        chunks.push(
          await importInvoiceRows(
            firmId,
            clientPartyId,
            rows.slice(start, start + BULK_THRESHOLD),
            true,
            actorId,
          ),
        );
      }
      return {
        total: rows.length,
        validCount: chunks.reduce((sum, chunk) => sum + chunk.validCount, 0),
        invalidCount: chunks.reduce(
          (sum, chunk) => sum + chunk.invalidCount,
          0,
        ),
        createdCount: chunks.reduce(
          (sum, chunk) => sum + chunk.createdCount,
          0,
        ),
        committed: true,
        rows: chunks
          .flatMap((chunk) => chunk.rows)
          .sort((a, b) => a.rowNumber - b.rowNumber),
      };
    }
  }

  for (const row of rows) {
    const errors = validateImportRow(row as Record<string, unknown>);
    if (errors.length > 0) {
      invalidCount += 1;
      results.push({
        rowNumber: row.rowNumber,
        status: "invalid",
        invoiceId: null,
        invoiceNumber: row.invoiceNumber ?? null,
        errors,
      });
      continue;
    }
    validCount += 1;
    if (!commit) {
      results.push({
        rowNumber: row.rowNumber,
        status: "valid",
        invoiceId: null,
        invoiceNumber: row.invoiceNumber ?? null,
        errors: [],
      });
      continue;
    }

    // Commit a single row in isolation: a failure here (duplicate invoice
    // number, DB constraint, etc.) must be reported as a row-level error rather
    // than aborting the whole batch and leaving partial commits unreported.
    try {
      const invoice = await withTransaction(async () => {
        // Resolve (or create) the buyer party by TIN so repeated imports reuse the
        // same buyer record.
        const buyerTin = String(row.buyerTin);
        const [existingBuyer] = await findImportBuyers(
          firmId,
          clientPartyId,
          actorId,
          [buyerTin],
        );
        let buyerPartyId = existingBuyer?.id;
        if (!buyerPartyId) {
          const [buyer] = await getDb()
            .insert(partiesTable)
            .values({
              type: "buyer",
              legalName: String(row.buyerName),
              tin: buyerTin,
              countryCode: "NG",
              createdByFirmId: firmId,
              createdByUserId: buyerCreator(actorId),
            })
            .returning();
          buyerPartyId = buyer.id;
        }

        const { invoice } = await createDraft(
          {
            firmId,
            supplierPartyId: clientPartyId,
            buyerPartyId,
            invoiceNumber: String(row.invoiceNumber),
            issueDate: String(row.issueDate),
            dueDate: row.dueDate ? String(row.dueDate) : null,
            currency: row.currency ? String(row.currency) : "NGN",
            lines: [
              {
                description: String(row.description),
                quantity: String(row.quantity),
                unitPrice: String(row.unitPrice),
                vatRate: String(row.vatRate),
              },
            ],
          },
          actorId,
        );
        return invoice;
      });
      createdCount += 1;
      results.push({
        rowNumber: row.rowNumber,
        status: "created",
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        errors: [],
      });
    } catch (err) {
      if (!isRowFailure(err)) throw err;
      validCount -= 1;
      invalidCount += 1;
      const message =
        err instanceof DomainError
          ? err.message
          : "Could not save this invoice. Please review and retry.";
      results.push({
        rowNumber: row.rowNumber,
        status: "invalid",
        invoiceId: null,
        invoiceNumber: row.invoiceNumber ?? null,
        errors: [{ field: "row", message }],
      });
    }
  }

  return {
    total: rows.length,
    validCount,
    invalidCount,
    createdCount,
    committed: commit,
    rows: results,
  };
}

function isRowFailure(error: unknown): boolean {
  if (error instanceof DomainError) return error.status < 500;
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 4 && current && typeof current === "object";
    depth++
  ) {
    const candidate = current as { code?: string; cause?: unknown };
    if (candidate.code && /^(22|23)/.test(candidate.code)) return true;
    current = candidate.cause;
  }
  return false;
}
