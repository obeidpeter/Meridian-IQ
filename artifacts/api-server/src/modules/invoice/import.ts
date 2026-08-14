import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, partiesTable } from "@workspace/db";
import { ImportInvoicesBody } from "@workspace/api-zod";
import { createDraft, bulkCreateDrafts } from "./service";
import { DomainError } from "../errors";

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
    if (!str(row[field])) errors.push({ field, message: `${label} is required` });
  };
  req("invoiceNumber", "Invoice number");
  req("buyerName", "Buyer name");
  req("buyerTin", "Buyer TIN");
  req("issueDate", "Issue date");
  req("description", "Line description");

  const issueDate = str(row.issueDate);
  if (issueDate && Number.isNaN(new Date(issueDate).getTime())) {
    errors.push({ field: "issueDate", message: "Issue date is not a valid date" });
  }
  // dueDate is optional but must be a real date when present — the bulk path
  // inserts rows in one statement, so one bad date would otherwise abort the
  // whole import with a DB error instead of a per-row result.
  const dueDate = str(row.dueDate);
  if (dueDate && Number.isNaN(new Date(dueDate).getTime())) {
    errors.push({ field: "dueDate", message: "Due date is not a valid date" });
  }
  const num = (field: string, label: string, min: number) => {
    const raw = str(row[field]);
    if (!raw) {
      errors.push({ field, message: `${label} is required` });
      return;
    }
    const n = Number(raw);
    if (Number.isNaN(n)) {
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
    if (Number.isNaN(n) || n < 0 || n > 1) {
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
  const results: ImportRowResult[] = [];
  let validCount = 0;
  let invalidCount = 0;
  let createdCount = 0;

  // NFR-03: large committed imports take the bulk path — chunked multi-row
  // inserts instead of ~6 statements per row — so a 5,000-row import completes
  // well inside the request-transaction budget.
  const BULK_THRESHOLD = 100;
  if (commit && rows.length > BULK_THRESHOLD) {
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
    // Resolve every buyer TIN in one pass; create missing buyers in one insert.
    const tins = [...new Set(valid.map((r) => String(r.buyerTin)))];
    const existingBuyers = tins.length
      ? await getDb()
          .select({ id: partiesTable.id, tin: partiesTable.tin })
          .from(partiesTable)
          .where(inArray(partiesTable.tin, tins))
      : [];
    const buyerByTin = new Map(existingBuyers.map((b) => [b.tin, b.id]));
    const missing = valid.filter((r) => !buyerByTin.has(String(r.buyerTin)));
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
      // Resolve (or create) the buyer party by TIN so repeated imports reuse the
      // same buyer record.
      const buyerTin = String(row.buyerTin);
      const [existingBuyer] = await getDb()
        .select()
        .from(partiesTable)
        .where(eq(partiesTable.tin, buyerTin))
        .limit(1);
      let buyerPartyId = existingBuyer?.id;
      if (!buyerPartyId) {
        const [buyer] = await getDb()
          .insert(partiesTable)
          .values({
            type: "buyer",
            legalName: String(row.buyerName),
            tin: buyerTin,
            countryCode: "NG",
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
      createdCount += 1;
      results.push({
        rowNumber: row.rowNumber,
        status: "created",
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        errors: [],
      });
    } catch (err) {
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
