// The user journeys that prove Valo's surfaces against a freshly seeded
// database: portal auth, the operator's Compliance Desk, firm admin tooling,
// the auditor's read-only boundary, consent, supplier bills (payables), the
// VAT position + compliance pack, maker-checker governance, collection
// accounts, Clerk automation (proposals + standing approvals), and the
// credit-note lifecycle. Journeys restore what they mutate
// (flags, consent, passwords, the submit-approval policy, action policies)
// so the suite reruns
// cleanly on the same seed — with three deliberate exceptions: the payables
// journey's payment flags and the collections journey's settlement are
// append-only settlement EVIDENCE (see journeyPayables / journeyCollections),
// and the integration journey's rejected probe — a failed invoice, its dead
// outbox row and an open high-priority Desk case — is append-only RAIL
// evidence, numbered fresh per run so nothing reads it by position (see
// journeyIntegrationLayer). All three stay behind.
// Split by concern (the routes/clerk pattern): shared.mjs carries the demo
// constants and session helpers; the journey groups are contiguous slices of
// the original single file; and runJourneys below keeps the ORIGINAL order —
// journeys mutate shared seed state, so the order is load-bearing.
//   roles.mjs        portal, operator desk, advisory, auditor, consent, TOTP
//   money.mjs        payables, VAT position + compliance pack
//   controls.mjs     maker-checker governance, collections + inbound rail,
//                    Clerk automation (proposals + standing approvals)
//   lifecycle.mjs    credit note + workflow, the two password journeys
//   integration.mjs  API keys, webhooks, the rail's rejected path, payments

import {
  journeyPortalAuth,
  journeyOperatorDesk,
  journeyFirmAdminAdvisory,
  journeyAuditorReadOnly,
  journeyOwnerConsent,
  journeyFirstLandingConsent,
  journeyClientAssignment,
  journeyAccessReview,
  journeyPipeline,
  journeyTotp,
} from "./roles.mjs";
import {
  journeyPayables,
  journeyVatPositionAndPack,
  journeyBulkImport,
} from "./money.mjs";
import {
  journeyGovernance,
  journeyCollections,
  journeyAutomation,
  journeyObligations,
  journeyFilings,
  journeyWht,
} from "./controls.mjs";
import {
  journeyStaffCreditNoteAndWorkflow,
  journeyPasswordRoundTrip,
  journeyPasswordReset,
} from "./lifecycle.mjs";
import { journeyIntegrationLayer } from "./integration.mjs";
import { journeyAccessibilityMatrix } from "./accessibility.mjs";
import { reliabilityJourneys } from "./reliability.mjs";
import { mkdirSync } from "node:fs";
import path from "node:path";

async function runReliability(page, BASE, check) {
  const selected = process.env.E2E_RELIABILITY_ONLY;
  if (
    selected &&
    !reliabilityJourneys.some((journey) => journey.name === selected)
  )
    throw new Error(`Unknown reliability journey: ${selected}`);
  const journeys = selected
    ? reliabilityJourneys.filter((journey) => journey.name === selected)
    : [...reliabilityJourneys];
  if (process.env.E2E_RELIABILITY_REVERSE === "1") journeys.reverse();
  for (const journey of journeys) {
    const context = await page
      .context()
      .browser()
      .newContext({ viewport: { width: 1360, height: 900 } });
    await context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
    });
    const isolated = await context.newPage();
    let failed = false;
    try {
      await journey(isolated, BASE, (label, ok, detail) => {
        if (!ok) failed = true;
        check(label, ok, detail);
      });
    } catch (error) {
      failed = true;
      check(`${journey.name}: isolated journey failed`, false, error.message);
    } finally {
      const dir = path.resolve("test-results/reliability");
      if (failed) {
        mkdirSync(dir, { recursive: true });
        await isolated
          .screenshot({
            path: path.join(dir, `${journey.name}.png`),
            fullPage: true,
          })
          .catch(() => {});
      }
      await context.tracing.stop(
        failed ? { path: path.join(dir, `${journey.name}.zip`) } : {},
      );
      await context.close();
    }
  }
}

export async function runJourneys(
  page,
  BASE,
  check,
  {
    hookReceiver,
    paymentWebhookToken,
    collectionWebhookKey,
    sweepToken,
    fakeRailUrl,
    fakeRailToken,
  } = {},
) {
  if (process.env.E2E_RELIABILITY_ONLY) {
    await runReliability(page, BASE, check);
    return;
  }
  await journeyPortalAuth(page, BASE, check);
  await journeyOperatorDesk(page, BASE, check);
  await journeyFirmAdminAdvisory(page, BASE, check);
  await journeyAuditorReadOnly(page, BASE, check);
  await journeyOwnerConsent(page, BASE, check);
  await journeyFirstLandingConsent(page, BASE, check);
  await journeyClientAssignment(page, BASE, check);
  await journeyAccessReview(page, BASE, check);
  await journeyPipeline(page, BASE, check);
  await journeyTotp(page, BASE, check);
  await journeyPayables(page, BASE, check);
  await journeyVatPositionAndPack(page, BASE, check);
  await journeyBulkImport(page, BASE, check);
  await journeyGovernance(page, BASE, check);
  await journeyCollections(page, BASE, check, collectionWebhookKey);
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
  await journeyStaffCreditNoteAndWorkflow(page, BASE, check);
  await journeyPasswordRoundTrip(page, BASE, check);
  await journeyPasswordReset(page, BASE, check);
  await journeyIntegrationLayer(
    page,
    BASE,
    check,
    hookReceiver,
    paymentWebhookToken,
    sweepToken,
    fakeRailUrl,
    fakeRailToken,
  );
  // End with a read-only WCAG smoke across every static route and role. It
  // runs after stateful journeys so it cannot perturb their load-bearing order.
  await journeyAccessibilityMatrix(page, BASE, check);
  await runReliability(page, BASE, check);
}
