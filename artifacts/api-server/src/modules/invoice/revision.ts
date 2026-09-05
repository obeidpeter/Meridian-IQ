import { eq } from "drizzle-orm";
import {
  getDb,
  invoicesTable,
  withTransaction,
  type Invoice,
} from "@workspace/db";
import { DomainError } from "../errors";

export function assertContentRevision(actual: number, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 1) {
    throw new DomainError(
      "REVISION_REQUIRED",
      "Refresh the invoice before continuing.",
      428,
    );
  }
  if (actual !== expected) {
    throw new DomainError(
      "INVOICE_CHANGED",
      "This invoice changed after you opened it. Review the latest version before continuing.",
      409,
    );
  }
}

export async function withInvoiceLock<T>(
  invoiceId: string,
  fn: (invoice: Invoice) => Promise<T>,
  expectedRevision?: number,
): Promise<T> {
  return withTransaction(async () => {
    const [invoice] = await getDb()
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, invoiceId))
      .for("update");
    if (!invoice) throw new DomainError("NOT_FOUND", "Invoice not found", 404);
    if (expectedRevision !== undefined) {
      assertContentRevision(invoice.contentRevision, expectedRevision);
    }
    return fn(invoice);
  });
}
