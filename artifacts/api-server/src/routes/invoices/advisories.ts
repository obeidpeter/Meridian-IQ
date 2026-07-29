import { Router, type IRouter } from "express";
import {
  ListLineItemSuggestionsQueryParams,
  ListLineItemSuggestionsResponse,
  ListPaymentBehaviourQueryParams,
  ListPaymentBehaviourResponse,
  GetUnmatchedCreditsQueryParams,
  GetUnmatchedCreditsResponse,
  GetProjectionAccuracyQueryParams,
  GetProjectionAccuracyResponse,
  GetChaseEffectivenessQueryParams,
  GetChaseEffectivenessResponse,
  GetPenaltyExposureQueryParams,
  GetPenaltyExposureResponse,
  GetMonthEndCloseQueryParams,
  GetMonthEndCloseResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../../lib/parse";
import { assertCan } from "../../modules/auth/rbac";
import { resolveClientAnalyticsScope } from "../../lib/client-scope";
import { listLineItemSuggestions } from "../../modules/invoice/line-items";
import { listPaymentBehaviour } from "../../modules/invoice/payment-behaviour";
import { listUnmatchedCredits } from "../../modules/invoice/unmatched-credits";
import { computeProjectionAccuracy } from "../../modules/invoice/projection-accuracy";
import { computeChaseEffectiveness } from "../../modules/invoice/chase-effectiveness";
import { computePenaltyExposure } from "../../modules/invoice/penalty-exposure";
import { computeMonthEndClose } from "../../modules/invoice/month-end-close";

// Deterministic advisory surfaces mined on demand from the client's own
// records — nothing stored, no model. Every route shares the same SEC-03
// resolution (lib/client-scope.ts): a client_user is pinned to its own
// party; a firm principal names the client.

const router: IRouter = Router();

// Frequent line items (round-4 idea #1): mined on demand from the client's
// own invoices, nothing stored, no model. Same SEC-03 resolution as the
// recurring suggestions: a client_user is pinned to its own party; a firm
// principal names the client.
router.get("/line-item-suggestions", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = parseOrThrow(ListLineItemSuggestionsQueryParams, req.query);
  const { firmId, clientPartyId } = resolveClientAnalyticsScope(
    req.principal,
    query.clientPartyId,
  );
  const items = await listLineItemSuggestions(firmId, clientPartyId);
  res.json(ListLineItemSuggestionsResponse.parse(items));
});

// Buyer payment behaviour (round-9 idea #1): per-buyer days-to-pay medians
// mined on demand from the client's own accepted reconciliation matches.
// Nothing stored, no model. Same SEC-03 resolution as the miners above.
router.get("/payment-behaviour", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = parseOrThrow(ListPaymentBehaviourQueryParams, req.query);
  const { firmId, clientPartyId } = resolveClientAnalyticsScope(
    req.principal,
    query.clientPartyId,
  );
  const behaviour = await listPaymentBehaviour(firmId, clientPartyId);
  res.json(ListPaymentBehaviourResponse.parse(behaviour));
});

// Unmatched-credit detector (round-14 idea #1): bank credits with no invoice
// behind them — the compliance mirror of unbilled income. Mined on demand
// from the client's own committed statements, nothing stored, no model.
// Same SEC-03 resolution as the miners above.
router.get("/unmatched-credits", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = parseOrThrow(GetUnmatchedCreditsQueryParams, req.query);
  const { firmId, clientPartyId } = resolveClientAnalyticsScope(
    req.principal,
    query.clientPartyId,
  );
  const credits = await listUnmatchedCredits(firmId, clientPartyId);
  res.json(GetUnmatchedCreditsResponse.parse(credits));
});

// Projection accuracy (round-14 idea #2): every observed settlement replayed
// against the cash-flow projection rule — the forecast auditing itself.
// Nothing stored, no model. Same SEC-03 resolution as payment-behaviour.
router.get("/projection-accuracy", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = parseOrThrow(GetProjectionAccuracyQueryParams, req.query);
  const { firmId, clientPartyId } = resolveClientAnalyticsScope(
    req.principal,
    query.clientPartyId,
  );
  const accuracy = await computeProjectionAccuracy(firmId, clientPartyId);
  res.json(GetProjectionAccuracyResponse.parse(accuracy));
});

// Reminder effectiveness (round-16 idea #2): the chase ladder joined to the
// settlement exhaust — did reminded invoices actually settle, and how fast?
// Correlation only (the note says so); nothing stored, no model. Same SEC-03
// resolution as projection-accuracy.
router.get("/chase-effectiveness", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = parseOrThrow(GetChaseEffectivenessQueryParams, req.query);
  const { firmId, clientPartyId } = resolveClientAnalyticsScope(
    req.principal,
    query.clientPartyId,
  );
  const report = await computeChaseEffectiveness(firmId, clientPartyId);
  res.json(GetChaseEffectivenessResponse.parse(report));
});

// Penalty exposure (round-18 idea #2): the public penalty model pointed at
// the caller's own overdue paper — per-band estimate, small-band floor,
// estimate-not-advice note. Deterministic, nothing stored. Same SEC-03
// resolution as the miners above.
router.get("/penalty-exposure", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = parseOrThrow(GetPenaltyExposureQueryParams, req.query);
  const { firmId, clientPartyId } = resolveClientAnalyticsScope(
    req.principal,
    query.clientPartyId,
  );
  const report = await computePenaltyExposure(firmId, clientPartyId);
  res.json(GetPenaltyExposureResponse.parse(report));
});

// Month-end close (round-19 idea #2): the platform's deterministic
// advisories composed into one checklist — each line computed by the SAME
// function that powers its own card, so the two can never disagree.
// Nothing stored, nothing blocked. Same SEC-03 resolution as above.
router.get("/month-end-close", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = parseOrThrow(GetMonthEndCloseQueryParams, req.query);
  const { firmId, clientPartyId } = resolveClientAnalyticsScope(
    req.principal,
    query.clientPartyId,
  );
  const close = await computeMonthEndClose(firmId, clientPartyId);
  res.json(GetMonthEndCloseResponse.parse(close));
});

export default router;
