import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CREDIT_POLICY,
  evaluateEligibility,
  type EligibilityFacts,
} from "./engine.ts";

const eligibleFacts: EligibilityFacts = {
  invoiceActive: true,
  amountConvertible: true,
  stampVerified: true,
  liveRailProvenance: true,
  buyerConfirmed: true,
  noSetOffConfirmed: true,
  settlementObserved: true,
  settlementSource: "collection_account",
  kybVerified: true,
  invoiceAmountNgn: 2_000_000,
  supplierOutstandingNgn: 8_000_000,
  priorHistoryInvoices: 8,
  buyerConcentrationBps: 3_500,
  buyerPriorObservations: 5,
  relatedPartySignal: false,
  reverseTradeCount: 0,
  volumeVsPriorAverageBps: 12_000,
};

test("complete mandatory evidence produces a traceable eligible decision", () => {
  const result = evaluateEligibility(eligibleFacts);
  assert.equal(result.decision, "eligible");
  assert.equal(result.score, 100);
  assert.equal(result.rules.length, 16);
  assert.ok(result.rules.every((item) => item.outcome === "pass"));
  assert.deepEqual(result.reasons, []);
});

test("uploaded evidence never satisfies the mandatory settlement source", () => {
  const result = evaluateEligibility({
    ...eligibleFacts,
    settlementObserved: false,
    settlementSource: null,
  });
  assert.equal(result.decision, "ineligible");
  assert.equal(
    result.rules.find((item) => item.key === "settlement_observed")?.outcome,
    "fail",
  );
});

test("a buyer confirmation without a no-set-off attestation is ineligible", () => {
  const result = evaluateEligibility({
    ...eligibleFacts,
    noSetOffConfirmed: false,
  });
  assert.equal(result.decision, "ineligible");
  assert.equal(
    result.rules.find((item) => item.key === "no_set_off_confirmed")?.outcome,
    "fail",
  );
});

test("rules-first fraud signals route to manual review without inventing a score", () => {
  const result = evaluateEligibility({
    ...eligibleFacts,
    relatedPartySignal: true,
    reverseTradeCount: 2,
    volumeVsPriorAverageBps: 45_000,
  });
  assert.equal(result.decision, "manual_review");
  assert.deepEqual(
    result.rules
      .filter((item) => item.outcome === "review")
      .map((item) => item.key),
    ["related_party", "circular_trade", "volume_anomaly"],
  );
});

test("thin history cannot auto-approve and does not hard-fail concentration", () => {
  const result = evaluateEligibility({
    ...eligibleFacts,
    priorHistoryInvoices: CREDIT_POLICY.minimumHistoryInvoices - 1,
    buyerConcentrationBps: 10_000,
  });
  assert.equal(result.decision, "manual_review");
  assert.equal(
    result.rules.find((item) => item.key === "buyer_concentration")?.outcome,
    "review",
  );
});

test("policy caps are hard eligibility boundaries", () => {
  const result = evaluateEligibility({
    ...eligibleFacts,
    invoiceAmountNgn: CREDIT_POLICY.maxInvoiceAmountNgn + 1,
    supplierOutstandingNgn: CREDIT_POLICY.maxSupplierOutstandingNgn + 1,
    buyerConcentrationBps: CREDIT_POLICY.maxBuyerConcentrationBps + 1,
  });
  assert.equal(result.decision, "ineligible");
  assert.deepEqual(
    result.rules
      .filter((item) => item.outcome === "fail")
      .map((item) => item.key),
    ["invoice_cap", "supplier_cap", "buyer_concentration"],
  );
});

test("the same source and policy replay byte-for-byte in logical output", () => {
  assert.deepEqual(
    evaluateEligibility(eligibleFacts, CREDIT_POLICY),
    evaluateEligibility(structuredClone(eligibleFacts), {
      ...CREDIT_POLICY,
      permittedSettlementSources: [...CREDIT_POLICY.permittedSettlementSources],
    }),
  );
});
