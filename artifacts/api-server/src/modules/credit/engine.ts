import type { CreditRuleResult } from "@workspace/db";

export const CREDIT_SCORECARD_VERSION = "miq-credit-scorecard-1.0.0";
export const CREDIT_RULESET_VERSION = "miq-credit-rules-1.0.0";

export interface CreditPolicy {
  scorecardVersion: string;
  rulesetVersion: string;
  maxInvoiceAmountNgn: number;
  maxSupplierOutstandingNgn: number;
  maxBuyerConcentrationBps: number;
  volumeAnomalyMultiplierBps: number;
  minimumHistoryInvoices: number;
  minimumBuyerObservations: number;
  permittedSettlementSources: readonly [
    "statement_match",
    "buyer_flag",
    "collection_account",
  ];
}

// A policy change is a code-reviewed scorecard release. The complete snapshot
// is persisted on every assessment, so future versions cannot rewrite history.
export const CREDIT_POLICY: CreditPolicy = Object.freeze({
  scorecardVersion: CREDIT_SCORECARD_VERSION,
  rulesetVersion: CREDIT_RULESET_VERSION,
  maxInvoiceAmountNgn: 50_000_000,
  maxSupplierOutstandingNgn: 100_000_000,
  maxBuyerConcentrationBps: 5_000,
  volumeAnomalyMultiplierBps: 30_000,
  minimumHistoryInvoices: 3,
  minimumBuyerObservations: 2,
  permittedSettlementSources: [
    "statement_match",
    "buyer_flag",
    "collection_account",
  ] as const,
});

export type ObservedSettlementSource =
  | "statement_match"
  | "buyer_flag"
  | "collection_account"
  | null;

export interface EligibilityFacts {
  invoiceActive: boolean;
  amountConvertible: boolean;
  stampVerified: boolean;
  liveRailProvenance: boolean;
  buyerConfirmed: boolean;
  noSetOffConfirmed: boolean;
  settlementObserved: boolean;
  settlementSource: ObservedSettlementSource;
  kybVerified: boolean;
  invoiceAmountNgn: number | null;
  supplierOutstandingNgn: number | null;
  priorHistoryInvoices: number;
  buyerConcentrationBps: number | null;
  buyerPriorObservations: number;
  relatedPartySignal: boolean;
  reverseTradeCount: number;
  volumeVsPriorAverageBps: number | null;
}

export interface EligibilityResult {
  decision: "eligible" | "ineligible" | "manual_review";
  score: number;
  rules: CreditRuleResult[];
  reasons: string[];
  features: Record<string, string | number | boolean | null>;
}

type RuleInput = Omit<CreditRuleResult, "points">;

function rule(input: RuleInput): CreditRuleResult {
  return { ...input, points: input.outcome === "pass" ? input.weight : 0 };
}

function passFail(input: {
  key: string;
  pass: boolean;
  passReason: string;
  failReason: string;
  observed: CreditRuleResult["observed"];
  threshold: CreditRuleResult["threshold"];
  weight: number;
}): CreditRuleResult {
  return rule({
    key: input.key,
    outcome: input.pass ? "pass" : "fail",
    reason: input.pass ? input.passReason : input.failReason,
    observed: input.observed,
    threshold: input.threshold,
    weight: input.weight,
  });
}

function passReview(input: {
  key: string;
  pass: boolean;
  passReason: string;
  reviewReason: string;
  observed: CreditRuleResult["observed"];
  threshold: CreditRuleResult["threshold"];
  weight: number;
}): CreditRuleResult {
  return rule({
    key: input.key,
    outcome: input.pass ? "pass" : "review",
    reason: input.pass ? input.passReason : input.reviewReason,
    observed: input.observed,
    threshold: input.threshold,
    weight: input.weight,
  });
}

/**
 * Deterministic, rules-first eligibility. No model output or user-supplied
 * score can enter this function. A mandatory-source or cap failure is
 * ineligible; a fraud, provenance or thin-file signal requires human review.
 */
export function evaluateEligibility(
  facts: EligibilityFacts,
  policy: CreditPolicy = CREDIT_POLICY,
): EligibilityResult {
  const historySufficient =
    facts.priorHistoryInvoices >= policy.minimumHistoryInvoices;
  const concentrationWithinPolicy =
    facts.buyerConcentrationBps !== null &&
    facts.buyerConcentrationBps <= policy.maxBuyerConcentrationBps;
  const volumeNormal =
    facts.volumeVsPriorAverageBps === null ||
    facts.volumeVsPriorAverageBps <= policy.volumeAnomalyMultiplierBps;

  const rules: CreditRuleResult[] = [
    passFail({
      key: "invoice_active",
      pass: facts.invoiceActive,
      passReason: "Invoice is in an active credit-observable lifecycle state.",
      failReason: "Invoice is draft, failed, cancelled or credited.",
      observed: facts.invoiceActive,
      threshold: true,
      weight: 0,
    }),
    passFail({
      key: "amount_convertible",
      pass: facts.amountConvertible,
      passReason: "Invoice and portfolio exposure can be measured in NGN.",
      failReason: "A reliable NGN amount is unavailable.",
      observed: facts.amountConvertible,
      threshold: true,
      weight: 5,
    }),
    passFail({
      key: "stamp_verified",
      pass: facts.stampVerified,
      passReason: "A canonical APP stamp is present.",
      failReason: "A canonical APP stamp is required.",
      observed: facts.stampVerified,
      threshold: true,
      weight: 15,
    }),
    passReview({
      key: "live_rail_provenance",
      pass: facts.liveRailProvenance,
      passReason: "The stamp carries live-rail provenance.",
      reviewReason: "Sandbox or legacy stamp provenance requires review.",
      observed: facts.liveRailProvenance,
      threshold: true,
      weight: 5,
    }),
    passFail({
      key: "buyer_confirmed",
      pass: facts.buyerConfirmed,
      passReason: "The buyer's latest response confirms the invoice.",
      failReason: "Buyer confirmation is mandatory.",
      observed: facts.buyerConfirmed,
      threshold: true,
      weight: 10,
    }),
    passFail({
      key: "no_set_off_confirmed",
      pass: facts.noSetOffConfirmed,
      passReason: "The buyer confirms there is no known set-off or dispute.",
      failReason: "A buyer no-set-off confirmation is mandatory.",
      observed: facts.noSetOffConfirmed,
      threshold: true,
      weight: 5,
    }),
    passFail({
      key: "settlement_observed",
      pass:
        facts.settlementObserved &&
        facts.settlementSource !== null &&
        policy.permittedSettlementSources.includes(facts.settlementSource),
      passReason: "Settlement is observed through an approved source.",
      failReason:
        "Settlement must be observed by statement match, paid buyer flag or collection account; uploaded evidence alone is insufficient.",
      observed: facts.settlementSource,
      threshold: policy.permittedSettlementSources.join(","),
      weight: 20,
    }),
    passFail({
      key: "kyb_verified",
      pass: facts.kybVerified,
      passReason:
        "The latest financing-grade KYB check is current and verified.",
      failReason: "A current verified KYB check is mandatory.",
      observed: facts.kybVerified,
      threshold: true,
      weight: 20,
    }),
    passFail({
      key: "invoice_cap",
      pass:
        facts.invoiceAmountNgn !== null &&
        facts.invoiceAmountNgn <= policy.maxInvoiceAmountNgn,
      passReason: "Invoice amount is within the policy cap.",
      failReason: "Invoice amount exceeds the policy cap.",
      observed: facts.invoiceAmountNgn,
      threshold: policy.maxInvoiceAmountNgn,
      weight: 5,
    }),
    passFail({
      key: "supplier_cap",
      pass:
        facts.supplierOutstandingNgn !== null &&
        facts.supplierOutstandingNgn <= policy.maxSupplierOutstandingNgn,
      passReason: "Supplier outstanding exposure is within the policy cap.",
      failReason: "Supplier outstanding exposure exceeds the policy cap.",
      observed: facts.supplierOutstandingNgn,
      threshold: policy.maxSupplierOutstandingNgn,
      weight: 5,
    }),
    passReview({
      key: "history_depth",
      pass: historySufficient,
      passReason: "Supplier history meets the minimum observation depth.",
      reviewReason: "The supplier has a thin invoice history.",
      observed: facts.priorHistoryInvoices,
      threshold: policy.minimumHistoryInvoices,
      weight: 0,
    }),
    rule({
      key: "buyer_concentration",
      outcome: !historySufficient
        ? "review"
        : concentrationWithinPolicy
          ? "pass"
          : "fail",
      reason: !historySufficient
        ? "Buyer concentration is not conclusive on a thin history."
        : concentrationWithinPolicy
          ? "Buyer concentration is within the policy limit."
          : "Buyer concentration exceeds the policy limit.",
      observed: facts.buyerConcentrationBps,
      threshold: policy.maxBuyerConcentrationBps,
      weight: 5,
    }),
    passReview({
      key: "buyer_observation_depth",
      pass: facts.buyerPriorObservations >= policy.minimumBuyerObservations,
      passReason: "The buyer has sufficient prior observations.",
      reviewReason: "The buyer has limited prior observed history.",
      observed: facts.buyerPriorObservations,
      threshold: policy.minimumBuyerObservations,
      weight: 1,
    }),
    passReview({
      key: "related_party",
      pass: !facts.relatedPartySignal,
      passReason: "No deterministic related-party signal was found.",
      reviewReason: "Supplier and buyer identifiers indicate a related party.",
      observed: facts.relatedPartySignal,
      threshold: false,
      weight: 2,
    }),
    passReview({
      key: "circular_trade",
      pass: facts.reverseTradeCount === 0,
      passReason: "No reverse-trade pattern was found in the lookback window.",
      reviewReason: "Reverse invoices create a circular-trade review signal.",
      observed: facts.reverseTradeCount,
      threshold: 0,
      weight: 1,
    }),
    passReview({
      key: "volume_anomaly",
      pass: volumeNormal,
      passReason: "Invoice volume is within the prior-history range.",
      reviewReason: "Invoice value is anomalously high against prior history.",
      observed: facts.volumeVsPriorAverageBps,
      threshold: policy.volumeAnomalyMultiplierBps,
      weight: 1,
    }),
  ];

  const decision = rules.some((item) => item.outcome === "fail")
    ? "ineligible"
    : rules.some((item) => item.outcome === "review")
      ? "manual_review"
      : "eligible";
  return {
    decision,
    score: rules.reduce((total, item) => total + item.points, 0),
    rules,
    reasons: rules
      .filter((item) => item.outcome !== "pass")
      .map((item) => item.reason),
    features: {
      stampVerified: facts.stampVerified,
      liveRailProvenance: facts.liveRailProvenance,
      buyerConfirmed: facts.buyerConfirmed,
      noSetOffConfirmed: facts.noSetOffConfirmed,
      settlementObserved: facts.settlementObserved,
      settlementSource: facts.settlementSource,
      kybVerified: facts.kybVerified,
      invoiceAmountNgn: facts.invoiceAmountNgn,
      supplierOutstandingNgn: facts.supplierOutstandingNgn,
      priorHistoryInvoices: facts.priorHistoryInvoices,
      buyerConcentrationBps: facts.buyerConcentrationBps,
      buyerPriorObservations: facts.buyerPriorObservations,
      relatedPartySignal: facts.relatedPartySignal,
      reverseTradeCount: facts.reverseTradeCount,
      volumeVsPriorAverageBps: facts.volumeVsPriorAverageBps,
    },
  };
}
