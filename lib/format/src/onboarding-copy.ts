// Onboard with Clerk display vocabulary — the ONE home for the onboarding
// checklist's step labels, shared by the console card and the server-side
// readiness report so the two can never drift (the filing-copy lesson).
//
// This module must import NOTHING: it is exported as the
// "@workspace/format/onboarding-copy" subpath so consumers share the wording
// without executing the package root's module-load Intl formatter
// construction (the action-copy precedent).

export const ONBOARDING_STEP_LABELS: Record<string, string> = {
  consent_captured: "Consent recorded",
  history_imported: "Invoice history imported",
  statements_backfilled: "Past bank statements added",
  duplicates_reviewed: "No duplicates left to review",
  filings_synced: "Past filing records added",
};

// An off-catalogue key from a newer server degrades to itself, never a
// crash — the console card's rule.
export function onboardingStepLabel(key: string): string {
  return ONBOARDING_STEP_LABELS[key] ?? key;
}
