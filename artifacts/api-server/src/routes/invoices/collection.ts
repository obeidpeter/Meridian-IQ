import { Router, type IRouter } from "express";
import { and, desc, eq, getTableColumns, sql, type SQL } from "drizzle-orm";
import { getDb, invoicesTable } from "@workspace/db";
import {
  ListInvoicesQueryParams,
  ListInvoicesResponse,
  ListInvoicesPagedQueryParams,
  ListInvoicesPagedResponse,
  CreateInvoiceBody,
  CreateInvoiceResponse,
  ExportInvoicesCsvQueryParams,
} from "@workspace/api-zod";
import { parseOrThrow } from "../../lib/parse";
import { pageBounds } from "../../lib/page";
import {
  assertCan,
  assertPartyAccess,
  clientPartyScope,
  requireFirmScope,
  tenantFirmId,
  type Principal,
} from "../../modules/auth/rbac";
import { createDraft } from "../../modules/invoice/service";
import { executeHttpOperation } from "../../modules/operations/http";
import { invoicePageFilters } from "../../modules/invoice/list-filters";
import { invoiceNgnEquivalent } from "../../modules/invoice/ngn-equivalent";
import { partyNamesById } from "../../modules/party/party";
import { sendCsvAttachment, toCsv } from "../../lib/csv";
import { likePattern } from "../../lib/sql";
import {
  decodeInvoiceCursor,
  encodeInvoiceCursor,
  invoiceFilterKey,
} from "../../modules/invoice/cursor";

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
  const query = parseOrThrow(ListInvoicesQueryParams, req.query);
  const q = query.q?.trim();
  const conditions = invoiceListConditions(req.principal, {
    status: query.status,
    q,
  });
  // Bounded reads (R98, lib/page.ts): every request is newest-first and
  // bounded — a bare request is the default page, not the whole tenant book
  // the legacy full-list mode used to return. New clients use /invoices/page
  // because deterministic ordering alone cannot prevent offset drift.
  const { limit, offset } = pageBounds(query);
  const rows = await getDb()
    .select()
    .from(invoicesTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(invoicesTable.createdAt), desc(invoicesTable.id))
    .limit(limit)
    .offset(offset);
  res.json(ListInvoicesResponse.parse(rows));
});

router.get("/invoices/page", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = parseOrThrow(ListInvoicesPagedQueryParams, req.query);
  const q = query.q?.trim();
  const baseConditions = [
    ...invoiceListConditions(req.principal, { status: query.status, q }),
    ...invoicePageFilters(query),
  ];
  const conditions = [...baseConditions];
  const filter = invoiceFilterKey({
    userId: req.principal.userId,
    firmId: tenantFirmId(req.principal),
    clientPartyId: clientPartyScope(req.principal),
    status: query.status ?? "",
    q: q ?? "",
    statusGroup: query.statusGroup ?? "all",
    fromDate: query.fromDate ?? "",
    toDate: query.toDate ?? "",
    minAmount: query.minAmount ?? "",
    maxAmount: query.maxAmount ?? "",
  });
  if (query.cursor) {
    const cursor = decodeInvoiceCursor(query.cursor, filter);
    conditions.push(
      sql`(${invoicesTable.createdAt}, ${invoicesTable.id}) < (${cursor.timestamp}::timestamptz, ${cursor.id}::uuid)`,
    );
  }
  const { limit } = pageBounds(query);
  const rows = await getDb()
    .select({
      ...getTableColumns(invoicesTable),
      cursorTimestamp: sql<string>`to_char(${invoicesTable.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(invoicesTable)
    .where(and(...conditions))
    .orderBy(desc(invoicesTable.createdAt), desc(invoicesTable.id))
    .limit(limit + 1);
  const [count] = await getDb()
    .select({ total: sql<number>`count(*)::int` })
    .from(invoicesTable)
    .where(and(...baseConditions));
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  res.json(
    ListInvoicesPagedResponse.parse({
      items,
      total: count?.total ?? 0,
      nextCursor:
        rows.length > limit && last
          ? encodeInvoiceCursor(last.cursorTimestamp, last.id, filter)
          : null,
    }),
  );
});

router.post("/invoices", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.write");
  const firmId = requireFirmScope(req.principal);
  const parsed = parseOrThrow(CreateInvoiceBody, req.body);
  await assertPartyAccess(req.principal, parsed.supplierPartyId);
  await executeHttpOperation(req, res, {
    command: "invoice.create",
    clientPartyId: parsed.supplierPartyId,
    payload: parsed,
    execute: async () => ({
      statusCode: 201,
      body: CreateInvoiceResponse.parse(
        await createDraft({ firmId, ...parsed }, req.principal.userId),
      ),
      summary: "1 invoice draft created.",
    }),
  });
});

// CSV export of the same tenant/SEC-03/status/q-scoped list the invoices page
// shows — the rows the caller can already read, in a file their accountant
// can open. Newest first, bounded far above any realistic book.
router.get("/invoices/export", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = parseOrThrow(ExportInvoicesCsvQueryParams, req.query);
  const status = query.status;
  const q = query.q?.trim();
  const conditions = invoiceListConditions(req.principal, { status, q });
  const rows = await getDb()
    .select()
    .from(invoicesTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(invoicesTable.createdAt), desc(invoicesTable.id))
    .limit(50_000);

  const names = await partyNamesById(
    rows.flatMap((r) => [r.supplierPartyId, r.buyerPartyId]),
  );

  // Naira view of the grand total (contract 0.45.0): NGN rows ARE naira; a
  // foreign-currency row converts through its captured issue-time rate; no
  // rate means unconvertible — an honest blank, never an assumed 1.0. The FX
  // columns are APPENDED so existing consumers' column positions hold
  // (`currency` already sits mid-row).
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
      invoiceNgnEquivalent(r),
    ]),
  );
  sendCsvAttachment(
    res,
    `invoices-${new Date().toISOString().slice(0, 10)}.csv`,
    csv,
  );
});

export default router;
