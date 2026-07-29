import { Router, type IRouter } from "express";
import { asc, eq, inArray } from "drizzle-orm";
import {
  getDb,
  firmsTable,
  stampRecordsTable,
  submissionAttemptsTable,
  confirmationsTable,
  partiesTable,
} from "@workspace/db";
import {
  GetInvoicePdfParams,
  GetInvoiceUblParams,
  GetInvoiceUblResponse,
  GetInvoiceCanonicalParams,
  GetInvoiceCanonicalResponse,
  GetInvoiceStampParams,
  GetInvoiceStampResponse,
  ListSubmissionAttemptsParams,
  ListSubmissionAttemptsResponse,
  GetInvoiceStatusLightParams,
  GetInvoiceStatusLightResponse,
  GetInvoiceRejectionRiskParams,
  GetInvoiceRejectionRiskResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../../lib/parse";
import { assertCan } from "../../modules/auth/rbac";
import { computeStatusLight } from "../../modules/clerk/status-light";
import { awaitingApproval } from "../../modules/invoice/approvals";
import { computeRejectionRisk } from "../../modules/invoice/rejection-risk";
import { buildCanonical } from "../../modules/invoice/service";
import { serializeToUbl } from "../../modules/invoice/canonical";
import { renderInvoicePdf, sendPdfAttachment } from "../../modules/invoice/pdf";
import { DomainError } from "../../modules/errors";
import { loadForTenant } from "./shared";

// Read-only views of a single invoice's documents and submission evidence:
// the branded PDF, UBL/canonical renderings, the stamp, attempt history, the
// deterministic status light and the draft-time rejection risk. Every route
// carries the GET /invoices/:id gate exactly — invoice.read + loadForTenant
// (404 unknown, tenant + SEC-03).

const router: IRouter = Router();

// Branded invoice PDF: the client-facing paper for a document the platform
// already holds. Same gate and scoping as GET /invoices/:id exactly —
// invoice.read + loadForTenant (404 unknown, tenant + SEC-03: a client_user
// only downloads its own invoices, never a sibling's). Rendering is pure
// (modules/invoice/pdf.ts); this route owns loading the parties, the firm's
// whitelabel theme and the stamp record.
router.get("/invoices/:id/pdf", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const params = parseOrThrow(GetInvoicePdfParams, req.params);
  const { invoice, lines } = await loadForTenant(req, params.id);
  const [parties, stamps, firms] = await Promise.all([
    getDb()
      .select()
      .from(partiesTable)
      .where(
        inArray(partiesTable.id, [
          invoice.supplierPartyId,
          invoice.buyerPartyId,
        ]),
      ),
    getDb()
      .select()
      .from(stampRecordsTable)
      .where(eq(stampRecordsTable.invoiceId, params.id))
      .orderBy(asc(stampRecordsTable.createdAt))
      .limit(1),
    getDb()
      .select({ name: firmsTable.name, theme: firmsTable.theme })
      .from(firmsTable)
      .where(eq(firmsTable.id, invoice.firmId))
      .limit(1),
  ]);
  const supplier = parties.find((p) => p.id === invoice.supplierPartyId);
  const buyer = parties.find((p) => p.id === invoice.buyerPartyId);
  if (!supplier || !buyer) {
    throw new DomainError("NOT_FOUND", "Invoice parties not found", 404);
  }
  // brandName falls back to the firm's own name — the whitelabel page's rule.
  const theme: Record<string, unknown> = { ...(firms[0]?.theme ?? {}) };
  if (typeof theme.brandName !== "string" || !theme.brandName.trim()) {
    if (firms[0]?.name) theme.brandName = firms[0].name;
  }
  const pdf = await renderInvoicePdf({
    invoice,
    lines,
    supplier,
    buyer,
    stamp: stamps[0] ?? null,
    theme,
  });
  sendPdfAttachment(res, `invoice-${invoice.invoiceNumber}.pdf`, pdf);
});

router.get("/invoices/:id/ubl", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const params = parseOrThrow(GetInvoiceUblParams, req.params);
  await loadForTenant(req, params.id);
  const canonical = await buildCanonical(params.id);
  res.json(GetInvoiceUblResponse.parse({ xml: serializeToUbl(canonical) }));
});

router.get("/invoices/:id/canonical", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const params = parseOrThrow(GetInvoiceCanonicalParams, req.params);
  await loadForTenant(req, params.id);
  const canonical = await buildCanonical(params.id);
  res.json(GetInvoiceCanonicalResponse.parse(canonical));
});

router.get("/invoices/:id/stamp", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const params = parseOrThrow(GetInvoiceStampParams, req.params);
  await loadForTenant(req, params.id);
  const [stamp] = await getDb()
    .select()
    .from(stampRecordsTable)
    .where(eq(stampRecordsTable.invoiceId, params.id))
    .orderBy(asc(stampRecordsTable.createdAt))
    .limit(1);
  if (!stamp) {
    throw new DomainError("NOT_FOUND", "No stamp for this invoice", 404);
  }
  res.json(GetInvoiceStampResponse.parse(stamp));
});

router.get("/invoices/:id/attempts", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const params = parseOrThrow(ListSubmissionAttemptsParams, req.params);
  await loadForTenant(req, params.id);
  const rows = await getDb()
    .select()
    .from(submissionAttemptsTable)
    .where(eq(submissionAttemptsTable.invoiceId, params.id))
    .orderBy(asc(submissionAttemptsTable.attemptNo));
  res.json(ListSubmissionAttemptsResponse.parse(rows));
});

// Task #40: deterministic status light. Pure rules over spine data — no AI
// involved — so it is safe for every invoice reader and needs no flag.
router.get("/invoices/:id/status-light", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const params = parseOrThrow(GetInvoiceStatusLightParams, req.params);
  const { invoice } = await loadForTenant(req, params.id);
  const [attempts, confirmations, stamps] = await Promise.all([
    getDb()
      .select()
      .from(submissionAttemptsTable)
      .where(eq(submissionAttemptsTable.invoiceId, params.id)),
    getDb()
      .select()
      .from(confirmationsTable)
      .where(eq(confirmationsTable.invoiceId, params.id)),
    getDb()
      .select()
      .from(stampRecordsTable)
      .where(eq(stampRecordsTable.invoiceId, params.id))
      .orderBy(asc(stampRecordsTable.createdAt))
      .limit(1),
  ]);
  const light = computeStatusLight({
    invoice,
    attempts,
    confirmations,
    stamp: stamps[0] ?? null,
    // Maker-checker: the light's honest answer to "why can't I submit?".
    awaitingApproval: await awaitingApproval(invoice),
  });
  res.json(GetInvoiceStatusLightResponse.parse(light));
});

// Draft-time rejection risk: the firm's own recent rejection history joined
// to this draft's supplier/buyer, catalogue-grounded — deterministic, nothing
// stored, no AI, so it is safe for every invoice reader and needs no flag.
// Same load/scope gate as GET /invoices/:id: 404 unknown, tenant + SEC-03
// enforced by loadForTenant (a client_user may only read its own invoices'
// risk, never a sibling's).
router.get("/invoices/:id/rejection-risk", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const params = parseOrThrow(GetInvoiceRejectionRiskParams, req.params);
  const { invoice } = await loadForTenant(req, params.id);
  const report = await computeRejectionRisk(invoice);
  res.json(GetInvoiceRejectionRiskResponse.parse(report));
});

export default router;
