import { Router, type IRouter } from "express";
import {
  GetClientVatPositionQueryParams,
  GetClientVatPositionResponse,
  ExportVatPositionCsvQueryParams,
  GetFirmVatPositionsQueryParams,
  GetFirmVatPositionsResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import { resolveClientAnalyticsScope } from "../lib/client-scope";
import { sendCsvAttachment, toCsv } from "../lib/csv";
import { assertCan, firmScope } from "../modules/auth/rbac";
import {
  computeFirmVatPositions,
  computeVatPosition,
  listVatPositionDocuments,
  vatPositionMonths,
} from "../modules/invoice/vat-position";
import { DomainError } from "../modules/errors";

// Monthly VAT position (contract 0.45.0): output VAT vs input VAT for a
// Lagos month, per client and across the firm's book, with the verified-input
// (defensible) split. Deterministic, computed on demand, nothing stored.
// NOTE: this router is NOT self-registering — it must be mounted in
// routes/index.ts (the orchestrator wires that up).

const router: IRouter = Router();

// The live-month discipline — the position's mirror of resolveClosedPeriod
// (routes/invoices/packs.ts): the requested month, or the CURRENT Lagos month when
// omitted, must be on the position's own 12-month option list. Unlike the
// closed-month VAT pack, that list INCLUDES the current month — a position is
// a live month-to-date number.
function resolvePositionMonth(raw: string | undefined): string {
  const months = vatPositionMonths();
  const month = raw ?? months[0];
  if (!months.includes(month)) {
    throw new DomainError(
      "BAD_MONTH",
      "month must be one of the last 12 Lagos months, current month included (YYYY-MM-01)",
      400,
    );
  }
  return month;
}

// The firm a console rollup is scoped to: firmScope, imported from rbac —
// the ONE definition, so /console/vat-positions carries EXACTLY the gate of
// the existing firm rollup (/console/receivables) by construction.

router.get("/vat-position", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = parseOrThrow(GetClientVatPositionQueryParams, req.query);
  // SEC-03: a client_user is pinned to its own party; a firm principal names
  // the client — the bills/analytics routes' exact scope resolution.
  const { firmId, clientPartyId } = resolveClientAnalyticsScope(
    req.principal,
    query.clientPartyId,
  );
  const month = resolvePositionMonth(query.month);
  const position = await computeVatPosition(firmId, clientPartyId, month);
  res.json(GetClientVatPositionResponse.parse(position));
});

// The same position as a file — one row per document (signed vatNgn, so each
// side's column sums to its total), verified posture per bill, and the
// disclosure note as a trailing row so it travels WITH the file a partner
// hands around (the /vat-pack/export shape).
router.get("/vat-position/export", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = parseOrThrow(ExportVatPositionCsvQueryParams, req.query);
  const { firmId, clientPartyId } = resolveClientAnalyticsScope(
    req.principal,
    query.clientPartyId,
  );
  const month = resolvePositionMonth(query.month);
  const position = await computeVatPosition(firmId, clientPartyId, month);
  const docs = await listVatPositionDocuments(firmId, clientPartyId, month);
  const csv = toCsv(
    [
      "docType",
      "invoiceNumber",
      "counterparty",
      "currency",
      "fxRateToNgn",
      "vatOriginal",
      "vatNgn",
      "verified",
    ],
    [
      ...docs.map((d) => [
        d.docType,
        d.invoiceNumber,
        d.counterparty,
        d.currency,
        d.fxRateToNgn ?? "",
        d.vatOriginal,
        // Blank = excluded for a missing FX rate (see the note row).
        d.vatNgn ?? "",
        d.verified === null ? "" : d.verified ? "yes" : "no",
      ]),
      [position.note, "", "", "", "", "", "", ""],
    ],
  );
  sendCsvAttachment(res, `vat-position-${month.slice(0, 7)}.csv`, csv);
});

// VAT position across the firm's whole book — per-client output vs input VAT
// with firm totals. Firm principals only (a client_user must never see
// sibling clients' VAT figures); same gate as /console/receivables.
router.get("/console/vat-positions", async (req, res): Promise<void> => {
  assertCan(req.principal, "console.portfolio.read");
  const firmId = firmScope(req.principal);
  const query = parseOrThrow(GetFirmVatPositionsQueryParams, req.query);
  const month = resolvePositionMonth(query.month);
  const positions = await computeFirmVatPositions(firmId, month);
  res.json(GetFirmVatPositionsResponse.parse(positions));
});

export default router;
