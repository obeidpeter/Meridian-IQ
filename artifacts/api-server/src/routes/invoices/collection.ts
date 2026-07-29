import { Router, type IRouter } from "express";
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { getDb, invoicesTable, partiesTable } from "@workspace/db";
import {
  ListInvoicesQueryParams,
  ListInvoicesResponse,
  CreateInvoiceBody,
  CreateInvoiceResponse,
  ExportInvoicesCsvQueryParams,
} from "@workspace/api-zod";
import { parseOrThrow } from "../../lib/parse";
import {
  assertCan,
  clientPartyScope,
  requireFirmScope,
  tenantFirmId,
  type Principal,
} from "../../modules/auth/rbac";
import { createDraft } from "../../modules/invoice/service";
import { sendCsvAttachment, toCsv } from "../../lib/csv";
import { likePattern } from "../../lib/sql";

// The invoices collection: list, create, and the CSV export of the same
// scoped list. /invoices/export is a LITERAL path that must stay mounted
// before the /invoices/:id groups (index.ts preserves this order).

const router: IRouter = Router();

// The tenant/SEC-03/status/q conditions shared by the invoices list and its
// CSV export — one definition of "what the caller can read". `q` must already
// be trimmed by the caller.
function invoiceListConditions(
  principal: Principal,
  opts: { status?: string; q?: string },
): SQL[] {
  const tenant = tenantFirmId(principal);
  const conditions: SQL[] = [];
  if (tenant) conditions.push(eq(invoicesTable.firmId, tenant));
  // A client_user only sees invoices where it is the supplier — not sibling
  // clients of the same firm (SEC-03).
  const scope = clientPartyScope(principal);
  if (scope) conditions.push(eq(invoicesTable.supplierPartyId, scope));
  if (opts.status)
    conditions.push(eq(invoicesTable.status, opts.status as never));
  // Search matches the invoice number or either party's legal name.
  if (opts.q) {
    const pattern = likePattern(opts.q);
    conditions.push(sql`(
      ${invoicesTable.invoiceNumber} ILIKE ${pattern}
      OR EXISTS (
        SELECT 1 FROM parties p
        WHERE (p.id = ${invoicesTable.supplierPartyId}
            OR p.id = ${invoicesTable.buyerPartyId})
          AND p.legal_name ILIKE ${pattern}
      )
    )`);
  }
  return conditions;
}

router.get("/invoices", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = ListInvoicesQueryParams.safeParse(req.query);
  const status = query.success ? query.data.status : undefined;
  const limit = query.success ? query.data.limit : undefined;
  const offset = query.success ? query.data.offset : undefined;
  const q = query.success ? query.data.q?.trim() : undefined;
  const conditions = invoiceListConditions(req.principal, { status, q });

  // Paged/search requests are newest-first and bounded; a bare request keeps
  // the legacy full-list oldest-first behaviour for existing clients (mobile).
  const paged = limit !== undefined || offset !== undefined || !!q;
  let builder = getDb()
    .select()
    .from(invoicesTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(
      paged ? desc(invoicesTable.createdAt) : asc(invoicesTable.createdAt),
    )
    .$dynamic();
  if (paged) builder = builder.limit(limit ?? 50).offset(offset ?? 0);
  const rows = await builder;
  res.json(ListInvoicesResponse.parse(rows));
});

router.post("/invoices", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.write");
  const firmId = requireFirmScope(req.principal);
  const parsed = parseOrThrow(CreateInvoiceBody, req.body);
  const bundle = await createDraft(
    { firmId, ...parsed },
    req.principal.userId,
  );
  res.status(201).json(CreateInvoiceResponse.parse(bundle));
});

// CSV export of the same tenant/SEC-03/status/q-scoped list the invoices page
// shows — the rows the caller can already read, in a file their accountant
// can open. Newest first, bounded far above any realistic book.
router.get("/invoices/export", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = ExportInvoicesCsvQueryParams.safeParse(req.query);
  const status = query.success ? query.data.status : undefined;
  const q = query.success ? query.data.q?.trim() : undefined;
  const conditions = invoiceListConditions(req.principal, { status, q });
  const rows = await getDb()
    .select()
    .from(invoicesTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(invoicesTable.createdAt))
    .limit(50_000);

  const partyIds = [
    ...new Set(rows.flatMap((r) => [r.supplierPartyId, r.buyerPartyId])),
  ];
  const names = new Map(
    partyIds.length
      ? (
          await getDb()
            .select({ id: partiesTable.id, legalName: partiesTable.legalName })
            .from(partiesTable)
            .where(inArray(partiesTable.id, partyIds))
        ).map((p) => [p.id, p.legalName])
      : [],
  );

  // Naira view of the grand total (contract 0.45.0): NGN rows ARE naira; a
  // foreign-currency row converts through its captured issue-time rate; no
  // rate means unconvertible — an honest blank, never an assumed 1.0. The FX
  // columns are APPENDED so existing consumers' column positions hold
  // (`currency` already sits mid-row).
  const ngnEquivalent = (r: (typeof rows)[number]): string => {
    if (r.currency === "NGN") return r.grandTotal;
    if (!r.fxRateToNgn) return "";
    return (Number(r.grandTotal) * Number(r.fxRateToNgn)).toFixed(2);
  };
  const csv = toCsv(
    [
      "invoiceNumber",
      "kind",
      "status",
      "category",
      "issueDate",
      "dueDate",
      "currency",
      "subtotal",
      "vatTotal",
      "grandTotal",
      "supplier",
      "buyer",
      "createdAt",
      "fxRateToNgn",
      "ngnEquivalent",
    ],
    rows.map((r) => [
      r.invoiceNumber,
      r.kind,
      r.status,
      r.category,
      r.issueDate,
      r.dueDate,
      r.currency,
      r.subtotal,
      r.vatTotal,
      r.grandTotal,
      names.get(r.supplierPartyId) ?? r.supplierPartyId,
      names.get(r.buyerPartyId) ?? r.buyerPartyId,
      r.createdAt.toISOString(),
      r.fxRateToNgn ?? "",
      ngnEquivalent(r),
    ]),
  );
  sendCsvAttachment(
    res,
    `invoices-${new Date().toISOString().slice(0, 10)}.csv`,
    csv,
  );
});

export default router;
