import { and, eq, inArray } from "drizzle-orm";
import { getDb, operatorCasesTable, invoicesTable } from "@workspace/db";

// Compliance Desk case intake (SME-06, CON-04): client escalations and
// pipeline dead letters land in the cross-tenant operator queue instead of
// dying in a table nobody reads. One live case per invoice — a repeat signal
// raises the existing case's priority rather than duplicating queue items.

const PRIORITY_RANK = { low: 0, medium: 1, high: 2 } as const;
type Priority = keyof typeof PRIORITY_RANK;

export async function openInvoiceCase(input: {
  invoiceId: string;
  // A literal title, or a builder receiving the invoice number (for callers
  // like the pipeline worker that only hold the invoice id).
  title: string | ((invoiceNumber: string) => string);
  errorCode?: string | null;
  priority?: Priority;
}): Promise<void> {
  const [invoice] = await getDb()
    .select({
      id: invoicesTable.id,
      firmId: invoicesTable.firmId,
      supplierPartyId: invoicesTable.supplierPartyId,
      invoiceNumber: invoicesTable.invoiceNumber,
    })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, input.invoiceId))
    .limit(1);
  // Cases require a firm to bill the work against; an unreadable invoice
  // stays visible through the dead-letter queue instead.
  if (!invoice) return;

  const title =
    typeof input.title === "function"
      ? input.title(invoice.invoiceNumber)
      : input.title;
  const priority = input.priority ?? "medium";
  const [existing] = await getDb()
    .select({
      id: operatorCasesTable.id,
      priority: operatorCasesTable.priority,
    })
    .from(operatorCasesTable)
    .where(
      and(
        eq(operatorCasesTable.invoiceId, invoice.id),
        inArray(operatorCasesTable.status, ["open", "in_progress"]),
      ),
    )
    .limit(1);

  if (existing) {
    if (PRIORITY_RANK[priority] > PRIORITY_RANK[existing.priority]) {
      await getDb()
        .update(operatorCasesTable)
        .set({ priority })
        .where(eq(operatorCasesTable.id, existing.id));
    }
    return;
  }

  await getDb().insert(operatorCasesTable).values({
    firmId: invoice.firmId,
    clientPartyId: invoice.supplierPartyId,
    invoiceId: invoice.id,
    title,
    errorCode: input.errorCode ?? null,
    priority,
    status: "open",
  });
}
