import { Router, type IRouter } from "express";
import {
  GetVatPackQueryParams,
  GetVatPackResponse,
  DraftVatPackCoverNoteBody,
  DraftVatPackCoverNoteResponse,
  GetVatSettlementCheckQueryParams,
  GetVatSettlementCheckResponse,
  GetVatPositionQueryParams,
  GetVatPositionResponse,
  GetQuarterlyReviewQueryParams,
  GetQuarterlyReviewResponse,
  DraftQuarterlyCoverNoteBody,
  DraftQuarterlyCoverNoteResponse,
  GetBillingStatementQueryParams,
  GetBillingStatementResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../../lib/parse";
import {
  assertCan,
  requireFirmScope,
  type Principal,
} from "../../modules/auth/rbac";
import {
  closedLagosMonths,
  computeVatPack,
} from "../../modules/clerk/vat-pack";
import { draftVatCoverNote } from "../../modules/clerk/vat-note";
import { computeVatSettlementCheck } from "../../modules/clerk/vat-settlement";
import { computeVatPosition } from "../../modules/clerk/vat-input";
import {
  closedLagosQuarters,
  computeQuarterlyReview,
} from "../../modules/advisory/quarterly-pack";
import { draftQuarterlyCoverNote } from "../../modules/advisory/quarterly-note";
import { gatewayOrNull } from "../../modules/clerk/provider";
import { computeBillingStatement } from "../../modules/invoice/billing-statement";
import { sendCsvAttachment, toCsv } from "../../lib/csv";
import { DomainError } from "../../modules/errors";

// Firm-level pack surfaces over closed Lagos periods: the monthly VAT pack
// family, the quarterly review, and the platform-billing statement. All firm
// principals only, all deterministic-on-demand; the two cover notes are
// digest-posture model calls (template fallback, never an error).

const router: IRouter = Router();

// The closed-period discipline shared by every VAT-pack/quarterly surface:
// the requested month/quarter (or the newest closed one when omitted) must be
// on the module's own closed-period option list, or the request is refused
// with the matching catalogue code. One definition so the five call sites
// cannot drift.
function resolveClosedPeriod(
  raw: string | undefined,
  list: string[],
  code: "BAD_MONTH" | "BAD_QUARTER",
): string {
  const period = raw ?? list[0];
  if (!list.includes(period)) {
    throw new DomainError(
      code,
      code === "BAD_MONTH"
        ? "month must be one of the last 12 closed Lagos months (YYYY-MM-01)"
        : "quarter must be the first month of one of the last 4 closed Lagos quarters (YYYY-MM-01)",
      400,
    );
  }
  return period;
}

// Monthly VAT filing pack (exhaust idea #2): per-client output VAT for a
// closed Lagos month, deterministic and computed on demand — the firm-level
// view of the per-client statement facts. Firm principals only (a client_user
// must never see sibling clients' VAT figures).
async function resolveVatPack(principal: Principal, rawQuery: unknown) {
  assertCan(principal, "console.portfolio.read");
  const firmId = requireFirmScope(principal);
  const query = parseOrThrow(GetVatPackQueryParams, rawQuery);
  const month = resolveClosedPeriod(
    query.month,
    closedLagosMonths(),
    "BAD_MONTH",
  );
  return computeVatPack(firmId, month);
}

router.get("/vat-pack", async (req, res): Promise<void> => {
  const pack = await resolveVatPack(req.principal, req.query);
  res.json(GetVatPackResponse.parse(pack));
});

router.get("/vat-pack/export", async (req, res): Promise<void> => {
  // resolveVatPack parses the (identical) query schema; no second parse.
  const pack = await resolveVatPack(req.principal, req.query);
  const csv = toCsv(
    [
      "client",
      "acceptedInvoices",
      "acceptedTotal",
      "outputVat",
      "creditNotes",
      "creditVat",
      "netOutputVat",
    ],
    [
      ...pack.rows.map((r) => [
        r.clientName,
        String(r.acceptedCount),
        r.acceptedTotal,
        r.acceptedVat,
        String(r.creditCount),
        r.creditVat,
        r.netVat,
      ]),
      [
        "TOTAL",
        String(pack.totals.acceptedCount),
        pack.totals.acceptedTotal,
        pack.totals.acceptedVat,
        String(pack.totals.creditCount),
        pack.totals.creditVat,
        pack.totals.netVat,
      ],
      // The disclosure travels WITH the file a partner hands around.
      [pack.note, "", "", "", "", "", ""],
    ],
  );
  sendCsvAttachment(res, `vat-pack-${pack.monthStart.slice(0, 7)}.csv`, csv);
});

// VAT filing cover note (round-4 idea #6): phrases the pack's computed facts
// into a note the partner edits and owns. Digest posture end to end — kill
// switch, missing provider, exhausted budget or invalid output all answer
// with the deterministic template (never an error), so there is no route
// budget pre-check: the module treats the gateway backstop's typed
// budget-exhausted failure as one more reason to answer with the template.
router.post("/vat-pack/cover-note", async (req, res): Promise<void> => {
  assertCan(req.principal, "console.portfolio.read");
  const firmId = requireFirmScope(req.principal);
  const body = parseOrThrow(DraftVatPackCoverNoteBody, req.body ?? {});
  const month = resolveClosedPeriod(
    body.month,
    closedLagosMonths(),
    "BAD_MONTH",
  );
  const gateway = await gatewayOrNull();
  const note = await draftVatCoverNote(firmId, month, gateway);
  res.json(DraftVatPackCoverNoteResponse.parse(note));
});

// VAT settlement cross-check (round-13 idea #6): how much of the pack
// month's accepted value has the platform OBSERVED settling. Same gate and
// month discipline as the pack itself; deterministic, nothing stored. The
// module's note carries the assurance-not-accusation disclosure.
router.get("/vat-pack/settlement-check", async (req, res): Promise<void> => {
  assertCan(req.principal, "console.portfolio.read");
  const firmId = requireFirmScope(req.principal);
  const query = parseOrThrow(GetVatSettlementCheckQueryParams, req.query);
  const month = resolveClosedPeriod(
    query.month,
    closedLagosMonths(),
    "BAD_MONTH",
  );
  const check = await computeVatSettlementCheck(firmId, month);
  res.json(GetVatSettlementCheckResponse.parse(check));
});

// Net VAT position (round-15 idea #1): the pack's output VAT joined to the
// bills ledger's input side — input VAT counts only when the bill's newest
// stamp verification says valid, so the position is a filing number, not a
// hope. Same gate and month discipline as the pack; deterministic, nothing
// stored.
router.get("/vat-pack/position", async (req, res): Promise<void> => {
  assertCan(req.principal, "console.portfolio.read");
  const firmId = requireFirmScope(req.principal);
  const query = parseOrThrow(GetVatPositionQueryParams, req.query);
  const month = resolveClosedPeriod(
    query.month,
    closedLagosMonths(),
    "BAD_MONTH",
  );
  const position = await computeVatPosition(firmId, month);
  res.json(GetVatPositionResponse.parse(position));
});

// Quarterly review pack (round-13 idea #4): the firm's closed quarter in one
// deterministic document — the monthly VAT packs summed, submission
// outcomes, top rejection causes, a receivables snapshot and Clerk
// throughput. Firm principals only, same as the VAT pack.
async function resolveQuarterlyReview(principal: Principal, rawQuery: unknown) {
  assertCan(principal, "console.portfolio.read");
  const firmId = requireFirmScope(principal);
  const query = parseOrThrow(GetQuarterlyReviewQueryParams, rawQuery);
  const quarter = resolveClosedPeriod(
    query.quarter,
    closedLagosQuarters(),
    "BAD_QUARTER",
  );
  return computeQuarterlyReview(firmId, quarter);
}

router.get("/quarterly-review", async (req, res): Promise<void> => {
  const review = await resolveQuarterlyReview(req.principal, req.query);
  res.json(GetQuarterlyReviewResponse.parse(review));
});

// Quarterly review cover note: digest posture end to end — kill switch,
// missing provider, exhausted budget or invalid output all answer with the
// deterministic template (never an error), so there is no route budget
// pre-check, exactly like the VAT cover note.
router.post("/quarterly-review/cover-note", async (req, res): Promise<void> => {
  assertCan(req.principal, "console.portfolio.read");
  const firmId = requireFirmScope(req.principal);
  const body = parseOrThrow(DraftQuarterlyCoverNoteBody, req.body ?? {});
  const quarter = resolveClosedPeriod(
    body.quarter,
    closedLagosQuarters(),
    "BAD_QUARTER",
  );
  const gateway = await gatewayOrNull();
  const note = await draftQuarterlyCoverNote(firmId, quarter, gateway);
  res.json(DraftQuarterlyCoverNoteResponse.parse(note));
});

// Monthly platform-billing statement (round-15): tier, metered usage and the
// computed fee for a closed Lagos month — deterministic, nothing stored, the
// vat-pack posture pointed at the platform's own bill. Same gates as the VAT
// pack: firm principals only (console.portfolio.read + firm scope), and the
// month must be on the closed-month option list.
async function resolveBillingStatement(
  principal: Principal,
  rawQuery: unknown,
) {
  assertCan(principal, "console.portfolio.read");
  const firmId = requireFirmScope(principal);
  const query = parseOrThrow(GetBillingStatementQueryParams, rawQuery);
  const month = resolveClosedPeriod(
    query.month,
    closedLagosMonths(),
    "BAD_MONTH",
  );
  return computeBillingStatement(firmId, month);
}

router.get("/billing/statement", async (req, res): Promise<void> => {
  const statement = await resolveBillingStatement(req.principal, req.query);
  res.json(GetBillingStatementResponse.parse(statement));
});

router.get("/billing/statement/export", async (req, res): Promise<void> => {
  // resolveBillingStatement parses the (identical) query schema; no second parse.
  const s = await resolveBillingStatement(req.principal, req.query);
  const csv = toCsv(
    ["item", "value"],
    [
      ["month", s.monthLabel],
      ["tier", `${s.tier.name} (${s.tier.key})`],
      ["baseFee", s.fee.base],
      ["includedInvoices", String(s.tier.includedInvoices)],
      ["acceptedInvoices", String(s.usage.acceptedInvoices)],
      ["overageInvoices", String(s.fee.overageInvoices)],
      ["overagePrice", s.tier.overagePrice],
      ["overageFee", s.fee.overage],
      ["totalFee", s.fee.total],
      ["submissionAttempts", String(s.usage.submissionAttempts)],
      ["clerkCalls", String(s.usage.clerkCalls)],
      ["clerkTokens", String(s.usage.clerkTokens)],
      ...s.usage.byPurpose.map(
        (p) => [`clerkTokens:${p.purpose}`, String(p.tokens)] as string[],
      ),
      // The disclosure travels WITH the file a partner hands around.
      ["note", s.note],
    ],
  );
  sendCsvAttachment(
    res,
    `billing-statement-${s.monthStart.slice(0, 7)}.csv`,
    csv,
  );
});

export default router;
