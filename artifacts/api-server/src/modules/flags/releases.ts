// The release manifest (PL-02): every seeded platform flag, its roadmap
// release tag, and its default in each environment — ONE source of truth for
// the activation posture. Two defaults per flag:
//
//  - launchDefault: the LAUNCH PROFILE — what a fresh PRODUCTION database
//    boots with. Only the R0 core is lit; every other capability ships dark
//    and awaits its roadmap activation gate (an operator flips the platform
//    flag, or a per-firm override activates a named pilot). The launch
//    profile is pinned by launch-profile-posture.test.ts — changing a
//    launchDefault is an activation decision, not a code style choice.
//
//  - devDefault: what dev/CI/demo databases boot with. The demo deployment
//    is deliberately FULLY LIT (the live demonstration is the sales deck),
//    and the e2e journeys drive the whole platform; flags that tests manage
//    themselves (messaging, the clerk opt-ins) keep their historical dark
//    default here so suite-level guards stay meaningful.
//
// Flags NOT in this manifest ("dark-by-absence", e.g. clerk_digest,
// clerk_client_statements, clerk_triage) resolve to false everywhere until a
// row is inserted deliberately; that stricter posture is preserved.

export interface ReleaseFlag {
  key: string;
  releaseTag: "R0" | "R1" | "R2" | "R3" | "R4";
  description: string;
  launchDefault: boolean;
  devDefault: boolean;
  /** Flags that must be effectively lit before this capability can be used. */
  requires?: readonly string[];
}

export const RELEASE_FLAGS: ReleaseFlag[] = [
  // --- R0 — the Field Kit core. The only flags lit at launch. -------------
  {
    key: "invoice_lifecycle",
    releaseTag: "R0",
    description: "Core invoice draft/validate/submit lifecycle",
    launchDefault: true,
    devDefault: true,
  },
  {
    key: "advisory_engagements",
    releaseTag: "R0",
    description: "Advisory engagement spine",
    launchDefault: true,
    devDefault: true,
  },
  {
    key: "consent_ledger",
    releaseTag: "R0",
    description: "Three-layer consent ledger",
    launchDefault: true,
    devDefault: true,
  },
  // --- R1 — Compliance MVP: lights on the platform gates. -----------------
  {
    key: "buyer_confirmations",
    releaseTag: "R1",
    description: "Buyer confirmation workflow",
    launchDefault: false,
    devDefault: true,
  },
  {
    key: "messaging_notifications",
    releaseTag: "R1",
    description: "WhatsApp/SMS/email notifications",
    launchDefault: false,
    devDefault: false,
  },
  // The beyond-plan ledger surfaces (Roadmap v1.2, Section 6), grouped into
  // four activation units. They carry R1 tags: statutory desks and client
  // reporting are accountant-value that lights with the console, money
  // analytics with the SME app. Dev/demo keeps them lit — the e2e journeys
  // drive all four.
  {
    key: "statutory_desks",
    releaseTag: "R1",
    description:
      "Statutory desks: filings register + cockpit, filing matrix, withholding-tax desk, authority-notice obligations",
    launchDefault: false,
    devDefault: true,
  },
  {
    key: "money_analytics",
    releaseTag: "R1",
    description:
      "Money surfaces beyond the invoice core: payables/bills with the double-payment guard, recurring invoices",
    launchDefault: false,
    devDefault: true,
  },
  {
    key: "client_reports",
    releaseTag: "R1",
    description:
      "Client-facing report packs: the monthly compliance pack (register, VAT position, deadlines) and its notify rail",
    launchDefault: false,
    devDefault: true,
  },
  {
    key: "collection_accounts",
    releaseTag: "R1",
    description:
      "Collection accounts: registration and firm-facing views. The inbound provider webhook is NOT behind this flag — it stays governed solely by its fail-closed shared token",
    launchDefault: false,
    devDefault: true,
  },
  // --- R2 — Channel Scale and Buyer Rails v1. Shipped dark (PL-02). -------
  {
    key: "anonymized_benchmarks",
    releaseTag: "R2",
    description: "Layer-2 anonymized aggregate analytics",
    launchDefault: false,
    devDefault: false,
    requires: ["consent_ledger"],
  },
  {
    key: "reconciliation",
    releaseTag: "R2",
    description:
      "Bank-statement ingestion and reconciliation v1 (SME-07, INT-05)",
    launchDefault: false,
    devDefault: false,
    requires: ["invoice_lifecycle", "consent_ledger"],
  },
  {
    key: "b2c_reporting",
    releaseTag: "R2",
    description: "B2C 24-hour reporting module with compliance clocks (SME-08)",
    launchDefault: false,
    devDefault: false,
    requires: ["invoice_lifecycle"],
  },
  {
    key: "buyer_rails",
    releaseTag: "R2",
    description:
      "Buyer Rails v1: supplier verification, payment flags, scoreboard (BR-01..BR-05)",
    launchDefault: false,
    devDefault: false,
    requires: ["buyer_confirmations"],
  },
  {
    key: "white_label",
    releaseTag: "R2",
    description:
      "White-label theming, subdomains, bulk client import, certification (CON-05)",
    launchDefault: false,
    devDefault: false,
  },
  {
    key: "erp_connectors",
    releaseTag: "R2",
    description:
      "ERP connector contract and first two connectors (PL-03, INT-06)",
    launchDefault: false,
    devDefault: false,
  },
  {
    key: "bank_feeds",
    releaseTag: "R2",
    description:
      "Bank-feed statement connectors: scheduled pulls landing through the ordinary ingest/reconcile path (INT-05 seam)",
    launchDefault: false,
    devDefault: false,
    requires: ["reconciliation"],
  },
  // --- R3/R4 — credit perimeter and the Clerk program. ---------------------
  {
    key: "credit_readiness",
    releaseTag: "R3",
    description: "Layer-3 credit readiness scoring",
    launchDefault: false,
    devDefault: false,
    requires: ["consent_ledger", "invoice_lifecycle"],
  },
  {
    key: "bank_data_room",
    releaseTag: "R4",
    description: "Bank data room and financing origination",
    launchDefault: false,
    devDefault: false,
    requires: ["credit_readiness"],
  },
  // Clerk has two independent controls. The runtime switch is the global
  // safety wall: a watchdog or operator can stop every model call even when a
  // pilot firm remains entitled. The rollout flag below decides which firms
  // may see and use Clerk. Keeping the controls separate prevents a firm
  // override from accidentally bypassing the global kill switch.
  {
    key: "clerk_ai_runtime",
    releaseTag: "R3",
    description:
      "Clerk AI global runtime safety switch: disabling stops every Clerk surface and model call, including entitled pilot firms",
    launchDefault: false,
    devDefault: true,
  },
  {
    key: "clerk_ai",
    releaseTag: "R3",
    description:
      "Clerk AI rollout entitlement: capture extraction and register-backed Q&A; enable per firm for pilots",
    launchDefault: false,
    devDefault: true,
    requires: ["clerk_ai_runtime", "consent_ledger"],
  },
  // Proposed actions (round 21): Clerk assembles a batch from the detector
  // predicates, a human approves it, execution rides the ordinary per-invoice
  // submission path. Shipped dark (PL-02); enable per firm via override once
  // a pilot firm opts in.
  {
    key: "clerk_actions",
    releaseTag: "R3",
    description:
      "Clerk proposed actions: human-approved batch execution over the closed action catalogue (submit_overdue)",
    launchDefault: false,
    devDefault: false,
    requires: ["clerk_ai"],
  },
  // Standing approvals (round 28): a durable, revocable per-client grant lets
  // the daily sweep run a submit kind without a fresh per-batch approval,
  // re-validated on every run. Layered ON clerk_actions — both must be lit.
  // Shipped dark (PL-02); enable per firm via override alongside a pilot.
  {
    key: "clerk_action_policies",
    releaseTag: "R3",
    description:
      "Clerk standing approvals: policy-driven daily execution of approved action kinds (layered on clerk_actions)",
    launchDefault: false,
    devDefault: false,
    requires: ["clerk_actions"],
  },
  // Round 35 (Close with Clerk Phase 2): auto-accepting reconciliation
  // matches is the riskiest deterministic step, so it rides its OWN opt-in
  // beside clerk_actions — dark means the reconcile step simply never
  // assembles.
  {
    key: "clerk_auto_reconcile",
    releaseTag: "R3",
    description:
      "Clerk auto-reconcile: HUMAN-APPROVED plan runs may accept high-confidence RECEIVABLE statement matches (threshold 0.9, capped 20, layered on the reconciliation flag) through the ordinary acceptProposal path; never rides recurring policies",
    launchDefault: false,
    devDefault: false,
    requires: ["clerk_actions", "reconciliation"],
  },
  // Round 45 (pgvector firm memory): the semantic index over a firm's own
  // Clerk records. Spends firm tokens on embeddings (the indexer sweep), so
  // it rides its own opt-in beside clerk_ai — dark means the indexer never
  // runs and retrieval surfaces fall back to today's exact-key behavior.
  {
    key: "clerk_memory",
    releaseTag: "R3",
    description:
      "Clerk firm memory: pgvector semantic index over the firm's own Clerk records (embedding indexer + retrieval; layered on clerk_ai). Requires the pgvector extension; spends firm tokens on embeddings",
    launchDefault: false,
    devDefault: false,
    requires: ["clerk_ai"],
  },
  // Round 50 (Advise with Clerk Phase 2): the monthly brief sweep can spend
  // firm tokens on every engaged client's adviser's note, so generation is
  // opt-in and dark. Delivery is deliberately NOT gated by this flag (the
  // statement-rail rule); the on-demand console generate button works
  // regardless — this only governs the background sweep.
  {
    key: "clerk_advisory_briefs",
    releaseTag: "R3",
    description:
      "Advisory brief sweep: monthly GENERATION of each engaged client's brief (spends firm tokens on the phrased note; template fallback). Delivery of already-generated briefs runs regardless of this flag",
    launchDefault: false,
    devDefault: false,
    requires: ["clerk_ai"],
  },
  // Round 47 (retrieval eval lane): seeded — unlike its phrasing sibling,
  // which is dark-by-absence and can only be lit by a manual row insert
  // (setFlag is UPDATE-only) — so operators can enable the nightly run
  // through the ordinary platform flags surface.
  {
    key: "clerk_auto_retrieval_eval",
    releaseTag: "R3",
    description:
      "Clerk retrieval eval: nightly embedding-retrieval eval run (recall@k/MRR over the fixed labeled corpus) plus the quality-drop watch. Spends platform tokens (one embedding batch per day)",
    launchDefault: false,
    devDefault: false,
    requires: ["clerk_memory"],
  },
];

/** Fail startup/tests on a missing prerequisite or a dependency cycle. */
export function validateFeatureDependencies(
  flags: readonly ReleaseFlag[] = RELEASE_FLAGS,
): void {
  const byKey = new Map(flags.map((flag) => [flag.key, flag]));
  if (byKey.size !== flags.length) {
    throw new Error("Feature flag keys must be unique");
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string, path: string[]): void => {
    if (visiting.has(key)) {
      throw new Error(
        `Feature dependency cycle: ${[...path, key].join(" -> ")}`,
      );
    }
    if (visited.has(key)) return;
    const flag = byKey.get(key);
    if (!flag) {
      throw new Error(`Unknown feature prerequisite: ${key}`);
    }
    visiting.add(key);
    for (const required of flag.requires ?? []) {
      if (!byKey.has(required)) {
        throw new Error(
          `Feature ${flag.key} requires unknown feature ${required}`,
        );
      }
      visit(required, [...path, key]);
    }
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of byKey.keys()) visit(key, []);
}

validateFeatureDependencies();

export type ReleaseTag = ReleaseFlag["releaseTag"];

// Flags retired from the manifest (D17). Public stamp verification is part
// of the R0 core — it is the QR link printed on every stamped PDF and
// nothing ever read the flag — so `stamp_verification` gated nothing while
// blocking the R1 badge. The seed removes a retired flag's row (and its
// overrides) from databases that booted before its retirement; a retired
// key can never be re-seeded by accident because it is absent from
// RELEASE_FLAGS.
export const RETIRED_FLAGS: readonly string[] = ["stamp_verification"];

const RELEASE_ORDER: ReleaseTag[] = ["R0", "R1", "R2", "R3", "R4"];

/**
 * The activation stage a set of lit flag keys amounts to: the highest
 * release whose EVERY manifest flag (at that tag and below) is lit. A
 * partially activated release does not count — the badge the apps render
 * from this must move only on a deliberate, complete activation, never on a
 * single pilot override. R0 is the floor even when the core is incomplete.
 */
export function activationReleaseTag(litKeys: Iterable<string>): ReleaseTag {
  const lit = new Set(litKeys);
  let stage: ReleaseTag = "R0";
  for (const tag of RELEASE_ORDER) {
    const complete = RELEASE_FLAGS.filter((f) => f.releaseTag === tag).every(
      (f) => lit.has(f.key),
    );
    if (!complete) break;
    stage = tag;
  }
  return stage;
}
