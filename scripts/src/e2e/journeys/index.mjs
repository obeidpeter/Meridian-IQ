// The user journeys that prove MeridianIQ's surfaces against a freshly seeded
// database: portal auth, the operator's Compliance Desk, firm admin tooling,
// the auditor's read-only boundary, consent, supplier bills (payables), the
// VAT position + compliance pack, maker-checker governance, collection
// accounts, Clerk automation (proposals + standing approvals), and the
// credit-note lifecycle. Journeys restore what they mutate
// (flags, consent, passwords, the submit-approval policy, action policies)
// so the suite reruns
// cleanly on the same seed — with two deliberate exceptions: the payables
// journey's payment flags and the collections journey's settlement are
// append-only settlement EVIDENCE and stay behind (see journeyPayables /
// journeyCollections).
// Split by concern (the routes/clerk pattern): shared.mjs carries the demo
// constants and session helpers; the journey groups are contiguous slices of
// the original single file; and runJourneys below keeps the ORIGINAL order —
// journeys mutate shared seed state, so the order is load-bearing.
//   roles.mjs        portal, operator desk, advisory, auditor, consent, TOTP
//   money.mjs        payables, VAT position + compliance pack
//   controls.mjs     maker-checker governance, collections + inbound rail,
//                    Clerk automation (proposals + standing approvals)
//   lifecycle.mjs    credit note + workflow, the two password journeys
//   integration.mjs  API keys, webhooks, payments

import {
  journeyPortalAuth,
  journeyOperatorDesk,
  journeyFirmAdminAdvisory,
  journeyAuditorReadOnly,
  journeyOwnerConsent,
  journeyTotp,
} from "./roles.mjs";
import { journeyPayables, journeyVatPositionAndPack } from "./money.mjs";
import {
  journeyGovernance,
  journeyCollections,
  journeyAutomation,
  journeyObligations,
  journeyFilings,
  journeyWht,
  journeyProfile,
} from "./controls.mjs";
import {
  journeyStaffCreditNoteAndWorkflow,
  journeyPasswordRoundTrip,
  journeyPasswordReset,
} from "./lifecycle.mjs";
import { journeyIntegrationLayer } from "./integration.mjs";

export async function runJourneys(
  page,
  BASE,
  check,
  { hookReceiver, paymentWebhookToken, collectionWebhookToken } = {},
) {
  await journeyPortalAuth(page, BASE, check);
  await journeyOperatorDesk(page, BASE, check);
  await journeyFirmAdminAdvisory(page, BASE, check);
  await journeyAuditorReadOnly(page, BASE, check);
  await journeyOwnerConsent(page, BASE, check);
  await journeyTotp(page, BASE, check);
  await journeyPayables(page, BASE, check);
  await journeyVatPositionAndPack(page, BASE, check);
  await journeyGovernance(page, BASE, check);
  await journeyCollections(page, BASE, check, collectionWebhookToken);
  // Runs BEFORE the credit-note journey on purpose: AUTO-9001 stamps in the
  // background but createdAt ordering keeps INV-1003 the oldest stamped
  // demo-client invoice — see journeyAutomation's placement comment.
  await journeyAutomation(page, BASE, check);
  // Self-contained (creates and closes its own obligation) — placed with the
  // other deterministic control journeys; leaves no open state behind.
  await journeyObligations(page, BASE, check);
  // Self-contained like the obligations journey (mutates only the demo
  // client's filing rows, which no later journey reads); filed rows are
  // terminal periodic evidence, so nothing is restored — the journey itself
  // tolerates an earlier run's filed rows (skip-or-pass).
  await journeyFilings(page, BASE, check);
  // WHT Desk: rides the filings journey's period and mints its own
  // Date.now()-numbered probe documents (both stay draft), so nothing later
  // is disturbed and re-runs stay deterministic.
  await journeyWht(page, BASE, check);
  // Compliance Profile: asserts the demo client's statutory facts — vat AND
  // paye deliberately TRUE, so journeyFilings' mint-both expectation stays
  // honest on kept databases — then proves the annual mint and the estimated
  // exposure figure. The PUT is an idempotent upsert and annual rows are
  // periodic evidence (never walked), so nothing is restored.
  await journeyProfile(page, BASE, check);
  await journeyStaffCreditNoteAndWorkflow(page, BASE, check);
  await journeyPasswordRoundTrip(page, BASE, check);
  await journeyPasswordReset(page, BASE, check);
  await journeyIntegrationLayer(page, BASE, check, hookReceiver, paymentWebhookToken);
}
