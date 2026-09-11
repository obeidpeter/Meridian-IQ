import type {
  OnboardingRun,
  OnboardingStep,
  OpeningPosition,
} from "@workspace/api-client-react";
import type { BadgeTone } from "@/lib/format";
import { onboardingStepLabel as sharedOnboardingStepLabel } from "@workspace/format/onboarding-copy";

// ---- Pure helpers (unit-tested directly) -----------------------------------

// Labels come from the shared vocabulary (@workspace/format/onboarding-copy
// — one home with the server-side readiness report), narrowed here to the
// contract's key type; re-exported so the card's tests keep their surface.
export function onboardingStepLabel(key: OnboardingStep["key"]): string {
  return sharedOnboardingStepLabel(key);
}

/**
 * Pill tone per step state: done emerald, skipped slate (a recorded gap, not
 * an achievement), pending amber (work outstanding — never red: onboarding
 * is a checklist, not an overdue alarm).
 */
export function onboardingStepPill(step: Pick<OnboardingStep, "status">): {
  tone: BadgeTone;
  label: string;
} {
  if (step.status === "done") return { tone: "emerald", label: "Done" };
  if (step.status === "skipped") return { tone: "slate", label: "Skipped" };
  return { tone: "amber", label: "Pending" };
}

/** "3 of 5 settled" — done and skipped both settle a step. */
export function onboardingProgress(run: Pick<OnboardingRun, "steps">): string {
  const settled = run.steps.filter((s) => s.status !== "pending").length;
  return `${settled} of ${run.steps.length} done or skipped`;
}

/** The run the card shows: the active one if any, else the newest. */
export function pickOnboardingRun(runs: OnboardingRun[]): OnboardingRun | null {
  return runs.find((r) => r.status === "active") ?? runs[0] ?? null;
}

const AUTOMATION_LABELS: Record<string, string> = {
  reconcile_matches: "Receipt matching",
  submit_overdue: "Overdue submission",
  retry_failed: "Failed-submission retry",
  draft_recurring: "Recurring drafts",
};

/**
 * The opening position as compact label/value lines, in reading order.
 * The core day-one facts always render — "0 invoices" and "None" are
 * honest baseline statements. Receivables emit ONE LINE PER CURRENCY
 * (cross-currency totals cannot be summed, and dropping a currency would
 * understate the book). The conditional sections (WHT, notices,
 * automation evidence) render only when there is something to report.
 */
export function openingSummaryLines(
  p: OpeningPosition,
): { label: string; value: string }[] {
  const lines: { label: string; value: string }[] = [];
  lines.push({
    label: "Invoice history",
    value:
      p.history.invoiceCount > 0
        ? `${p.history.invoiceCount} invoice(s), ${p.history.earliestIssueDate} → ${p.history.latestIssueDate}`
        : "0 invoices on record",
  });
  for (const group of p.receivables.groups) {
    lines.push({
      label:
        p.receivables.groups.length > 1
          ? `Outstanding receivables (${group.currency})`
          : "Outstanding receivables",
      value: `${group.currency} ${group.outstandingTotal} across ${group.invoiceCount} invoice(s)`,
    });
  }
  lines.push({
    // All VAT-position amounts are NGN by module doctrine (non-NGN
    // documents convert at their captured rate) — say so.
    label: "Net VAT (this month)",
    value: `NGN ${p.vat.netVat}`,
  });
  lines.push({
    label: "Unfiled returns",
    value:
      p.filings.unfiled > 0
        ? `${p.filings.unfiled} unfiled (${p.filings.overdue} overdue)`
        : "None",
  });
  if (p.wht.awaiting > 0) {
    lines.push({
      label: "WHT credit notes awaited",
      value: `${p.wht.awaiting} (${p.wht.awaitingAmount})`,
    });
  }
  if (p.obligations.open > 0) {
    lines.push({
      label: "Open authority notices",
      value: `${p.obligations.open} (${p.obligations.overdue} overdue)`,
    });
  }
  for (const kind of p.automation.kinds) {
    if (kind.sample > 0 && kind.agreementRate !== null) {
      lines.push({
        label: `${AUTOMATION_LABELS[kind.kind] ?? kind.kind} evidence`,
        value: `${Math.round(kind.agreementRate * 100)}% agreement over ${kind.sample} decision(s)`,
      });
    }
  }
  return lines;
}
