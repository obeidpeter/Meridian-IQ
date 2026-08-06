import { test } from "node:test";
import assert from "node:assert/strict";
import {
  actionConfirmButtonLabel,
  actionConfirmDescription,
  actionOutcomeSummary,
  automatableActionKind,
  AUTOMATION_PAUSED_HOME_MESSAGE,
  decisionLine,
  isPolicyPaused,
  pausedPolicyCount,
  POLICY_CAP_DEFAULT,
  policyGrantAlertMessage,
  policyGrantDescription,
  policyKindLabel,
  policyPauseReasonLabel,
  policyStatusLine,
  proposalCountLine,
  proposalMobileGateNote,
} from "./automation.ts";

// The gate is the load-bearing piece: on mobile only the two submit kinds
// may carry an approve (or automate) button — draft_chasers returns
// transient drafts the phone cannot show-and-copy, so running it here would
// silently burn them.

test("automatableActionKind admits exactly the two submit kinds", () => {
  assert.equal(automatableActionKind("submit_overdue"), "submit_overdue");
  assert.equal(automatableActionKind("retry_failed"), "retry_failed");
  assert.equal(automatableActionKind("draft_chasers"), null);
  assert.equal(automatableActionKind("future_kind"), null);
});

test("proposalMobileGateNote: runnable kinds get no note, others get an honest one", () => {
  assert.equal(proposalMobileGateNote("submit_overdue"), null);
  assert.equal(proposalMobileGateNote("retry_failed"), null);
  assert.match(
    proposalMobileGateNote("draft_chasers") ?? "",
    /shown once .* web app .* drafts aren't lost/,
  );
  // An off-contract kind from a newer server points at the web, never a
  // button that could only fail.
  assert.match(proposalMobileGateNote("future_kind") ?? "", /use the web app/);
});

test("proposalCountLine states the batch size, singular and plural", () => {
  assert.equal(
    proposalCountLine({ targets: [1], targetCount: 1, truncated: false }),
    "1 invoice in this batch.",
  );
  assert.equal(
    proposalCountLine({ targets: [1, 2, 3], targetCount: 3, truncated: false }),
    "3 invoices in this batch.",
  );
});

test("proposalCountLine says so when the server truncated the batch", () => {
  assert.equal(
    proposalCountLine({
      targets: Array.from({ length: 20 }),
      targetCount: 45,
      truncated: true,
    }),
    "Showing the oldest 20 of 45 — approve this batch, then come back for the rest.",
  );
});

test("actionConfirmDescription: submit vs resubmit wording, singular count", () => {
  const submit = actionConfirmDescription("submit_overdue", 3);
  assert.match(submit, /^This submits 3 invoices to the e-invoicing rails/);
  assert.match(submit, /validation, consent and any approval policy all apply/);
  assert.match(submit, /recorded under your name/);
  const retry = actionConfirmDescription("retry_failed", 1);
  assert.match(retry, /^This resubmits 1 invoice to the e-invoicing rails/);
});

test("actionConfirmButtonLabel mirrors the web dialogs", () => {
  assert.equal(
    actionConfirmButtonLabel("submit_overdue", 2),
    "Approve 2 invoices",
  );
  assert.equal(actionConfirmButtonLabel("retry_failed", 1), "Approve 1 invoice");
  assert.equal(
    actionConfirmButtonLabel("draft_chasers", 2),
    "Draft 2 reminders",
  );
});

test("actionOutcomeSummary: the three counts in the web's exact shape", () => {
  assert.equal(
    actionOutcomeSummary({
      kind: "submit_overdue",
      executedCount: 3,
      failedCount: 1,
      skippedCount: 2,
    }),
    "3 submitted · 1 need attention · 2 skipped.",
  );
  assert.equal(
    actionOutcomeSummary({
      kind: "draft_chasers",
      executedCount: 2,
      failedCount: 0,
      skippedCount: 0,
    }),
    "2 drafted · 0 need attention · 0 skipped.",
  );
});

test("policyKindLabel: labeled kinds plus a raw-token fallback", () => {
  assert.equal(policyKindLabel("submit_overdue"), "Auto-submit overdue invoices");
  assert.equal(policyKindLabel("retry_failed"), "Auto-retry failed submissions");
  assert.equal(policyKindLabel("mystery_kind"), "mystery_kind");
});

test("policyPauseReasonLabel: tripwire vocabulary, manual default, unknown fallback", () => {
  assert.equal(policyPauseReasonLabel("manual"), "paused manually");
  assert.equal(policyPauseReasonLabel(null), "paused manually");
  assert.equal(
    policyPauseReasonLabel("consent_missing"),
    "paused — compliance consent is missing",
  );
  assert.equal(
    policyPauseReasonLabel("rail_rejections"),
    "paused — the last run's submissions were rejected by the rails",
  );
  // A reason from a newer server still reads as a pause, never a blank.
  assert.equal(policyPauseReasonLabel("solar_flare"), "paused — solar_flare");
});

test("policyStatusLine: a paused grant leads with why — the sweep is NOT running", () => {
  assert.equal(
    policyStatusLine({
      pausedAt: "2026-07-01T09:00:00Z",
      pausedReason: "failed_targets",
      maxTargetsPerRun: 10,
      lastRunAt: "2026-06-30T05:00:00Z",
    }),
    "paused — too many failures in the last run",
  );
});

test("policyStatusLine: an active grant says cadence, cap, and last run", () => {
  assert.equal(
    policyStatusLine({
      pausedAt: null,
      pausedReason: null,
      maxTargetsPerRun: 10,
      lastRunAt: null,
    }),
    "runs daily · up to 10 per run · has not run yet",
  );
  const withRun = policyStatusLine({
    pausedAt: null,
    pausedReason: null,
    maxTargetsPerRun: 5,
    lastRunAt: "2026-07-29T05:00:00Z",
  });
  assert.match(withRun, /^runs daily · up to 5 per run · last ran /);
});

test("pause prominence: isPolicyPaused and pausedPolicyCount", () => {
  assert.equal(isPolicyPaused({ pausedAt: "2026-07-01T09:00:00Z" }), true);
  assert.equal(isPolicyPaused({ pausedAt: null }), false);
  assert.equal(
    pausedPolicyCount([
      { pausedAt: null },
      { pausedAt: "2026-07-01T09:00:00Z" },
      { pausedAt: "2026-07-02T09:00:00Z" },
    ]),
    2,
  );
  assert.equal(pausedPolicyCount([]), 0);
  assert.equal(AUTOMATION_PAUSED_HOME_MESSAGE.includes("Automation"), true);
});

test("policyGrantDescription states the cap being consented to", () => {
  const grant = policyGrantDescription("submit_overdue", POLICY_CAP_DEFAULT);
  assert.match(
    grant,
    /submit up to 10 invoices past the statutory window under your name/,
  );
  assert.match(grant, /re-checks consent, your access and each invoice/);
  assert.match(grant, /pause or revoke this at any time/);
});

test("policyGrantDescription: retry wording and the singular cap", () => {
  assert.match(
    policyGrantDescription("retry_failed", 1),
    /resubmit up to 1 invoice that failed on the rails/,
  );
});

test("policyGrantAlertMessage: the consent copy, then the client's own record as a second paragraph", () => {
  assert.equal(
    policyGrantAlertMessage("retry_failed", POLICY_CAP_DEFAULT, [
      // Only the granting kind's entry phrases the record.
      { kind: "reconcile_matches", sample: 40, agreed: 38, medianLeadDays: null },
      { kind: "retry_failed", sample: 5, agreed: 3, medianLeadDays: 2 },
    ]),
    `${policyGrantDescription("retry_failed", POLICY_CAP_DEFAULT)}\n\n` +
      "Your own record, last 6 months: 3 of 5 failed submissions were eventually retried by hand, after a median 2 days.",
  );
  assert.equal(
    policyGrantAlertMessage("submit_overdue", POLICY_CAP_DEFAULT, [
      { kind: "submit_overdue", sample: 12, agreed: 9, medianLeadDays: 4 },
    ]),
    `${policyGrantDescription("submit_overdue", POLICY_CAP_DEFAULT)}\n\n` +
      "Your own record, last 6 months: you eventually submitted 9 of 12 such invoices yourself, a median 4 days late.",
  );
});

test("policyGrantAlertMessage: no backtest, no matching kind, or an empty sample appends nothing", () => {
  const consent = policyGrantDescription("submit_overdue", POLICY_CAP_DEFAULT);
  // Absent payload (failed fetch, older server) — the Alert reads as before.
  assert.equal(
    policyGrantAlertMessage("submit_overdue", POLICY_CAP_DEFAULT, undefined),
    consent,
  );
  assert.equal(
    policyGrantAlertMessage("submit_overdue", POLICY_CAP_DEFAULT, null),
    consent,
  );
  // The payload carries other kinds only.
  assert.equal(
    policyGrantAlertMessage("submit_overdue", POLICY_CAP_DEFAULT, [
      { kind: "retry_failed", sample: 5, agreed: 3, medianLeadDays: 2 },
    ]),
    consent,
  );
  // An empty sample: never a rate from nothing.
  assert.equal(
    policyGrantAlertMessage("submit_overdue", POLICY_CAP_DEFAULT, [
      { kind: "submit_overdue", sample: 0, agreed: 0, medianLeadDays: null },
    ]),
    consent,
  );
});

test("decisionLine carries the counts and tags policy runs with · auto", () => {
  const auto = decisionLine({
    createdAt: "2026-07-29T05:00:00Z",
    kind: "submit_overdue",
    executedCount: 3,
    skippedCount: 1,
    failedCount: 0,
    policyId: "pol_1",
  });
  assert.match(
    auto,
    / · submit_overdue · 3 executed · 1 skipped · 0 failed · auto$/,
  );
  const manual = decisionLine({
    createdAt: "2026-07-29T05:00:00Z",
    kind: "retry_failed",
    executedCount: 2,
    skippedCount: 0,
    failedCount: 1,
    policyId: null,
  });
  assert.match(manual, / · retry_failed · 2 executed · 0 skipped · 1 failed$/);
  assert.equal(manual.includes("auto"), false);
});
