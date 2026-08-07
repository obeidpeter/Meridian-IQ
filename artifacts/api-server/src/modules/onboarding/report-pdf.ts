import PDFDocument from "pdfkit";
import { onboardingStepLabel } from "@workspace/format/onboarding-copy";
import {
  CONTENT_WIDTH,
  MARGIN,
  collectPdf,
  drawBrandHeader,
  drawCoverIntro,
  ensureRoom,
  packLayout,
  resolvePackTheme,
} from "../invoice/pack-pdf";
import type { OnboardingRunView } from "./onboarding";
import type { OpeningPosition } from "./opening-position";

// Onboard with Clerk Phase 3: the READINESS REPORT — the completion
// deliverable of an onboarding run, rendered from the FROZEN record only
// (the final checklist with its evidence and recorded gaps, plus the frozen
// day-one opening position). Deliberately ZERO model calls — unlike the
// compliance pack's cover note there is no phrasing surface here at all:
// the report's whole value is that it states exactly what the record shows
// and names exactly the gaps the firm chose to accept, so every word is
// deterministic. Composed from the pack-pdf seam (collectPdf, packLayout,
// drawBrandHeader — the response-bundle precedent).

export interface OnboardingReportInput {
  run: OnboardingRunView;
  // The frozen baseline — null for a pre-Phase-2 completed run (or one
  // whose stored blob no longer parses); the report then names that gap
  // honestly instead of omitting the section.
  position: OpeningPosition | null;
  firmName: string;
  theme: Record<string, unknown> | null;
}

// The position as label/value report rows — the console kernel's reading
// order, server-side (the two render different surfaces from the same
// frozen object; each stays with its renderer). The automation-evidence
// rows the console shows are DELIBERATELY absent here: the report is the
// certifying record of where the client started, and the backtest is
// advisory consent copy, not a record fact — it stays on the screen
// surfaces.
export function openingReportRows(
  p: OpeningPosition,
): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  rows.push({
    label: "Invoice history",
    value:
      p.history.invoiceCount > 0
        ? `${p.history.invoiceCount} invoice(s), ${p.history.earliestIssueDate} to ${p.history.latestIssueDate}`
        : "0 invoices on record",
  });
  for (const group of p.receivables.groups) {
    rows.push({
      label: `Outstanding receivables (${group.currency})`,
      value: `${group.outstandingTotal} across ${group.invoiceCount} invoice(s)`,
    });
  }
  rows.push({ label: "Net VAT (month to date)", value: `NGN ${p.vat.netVat}` });
  rows.push({
    label: "Unfiled statutory returns",
    value:
      p.filings.unfiled > 0
        ? `${p.filings.unfiled} unfiled (${p.filings.overdue} overdue)`
        : "None",
  });
  if (p.wht.awaiting > 0) {
    rows.push({
      label: "WHT credit notes awaited",
      value: `${p.wht.awaiting} (NGN ${p.wht.awaitingAmount})`,
    });
  }
  if (p.obligations.open > 0) {
    rows.push({
      label: "Open authority notices",
      value: `${p.obligations.open} (${p.obligations.overdue} overdue)`,
    });
  }
  return rows;
}

// One compact evidence phrase per step for the checklist table — the
// step-specific detection facts reduced to a line (never the raw jsonb).
export function stepEvidenceSummary(
  step: OnboardingRunView["steps"][number],
): string {
  if (step.status === "skipped") {
    // The reason is free text up to 500 chars — far beyond kvRow's fixed
    // row height. The checklist row points at the gaps section, where the
    // full reason renders as a flowing paragraph.
    return "Skipped — reason under Recorded gaps";
  }
  const e = step.evidence as Record<string, unknown>;
  switch (step.key) {
    case "history_imported": {
      const n = Number(e.invoiceCount ?? 0);
      return n > 0 ? `${n} invoice(s) on record` : "No invoices on record";
    }
    case "statements_backfilled": {
      const covered = Array.isArray(e.monthsCovered) ? e.monthsCovered : [];
      const missing = Array.isArray(e.monthsMissing) ? e.monthsMissing : [];
      return missing.length === 0
        ? `${covered.length} month(s) covered`
        : `Missing: ${missing.join(", ")}`;
    }
    case "duplicates_reviewed": {
      const suggestions = Array.isArray(e.suggestions) ? e.suggestions : [];
      return suggestions.length === 0
        ? "No duplicate candidates"
        : `${suggestions.length} candidate(s) surfaced`;
    }
    case "filings_synced": {
      const periods = Array.isArray(e.periods) ? e.periods : [];
      return `Register backfilled for ${periods.join(", ")}`;
    }
    case "consent_captured":
      return step.status === "done"
        ? "Layer-1 compliance consent on record"
        : "Consent not yet granted";
    /* c8 ignore next 2 -- future step keys degrade to the status word */
    default:
      return step.status;
  }
}

export async function renderOnboardingReportPdf(
  input: OnboardingReportInput,
): Promise<Buffer> {
  const theme = resolvePackTheme(input.theme);
  // The pack seam's determinism property: identical frozen inputs must
  // render identical bytes, so CreationDate pins to the run's own
  // completion instant (never the wall clock) and the margin matches the
  // seam (the implicit-page-add safety net kvRow's fixed rows rely on).
  const doc = new PDFDocument({
    size: "A4",
    margin: MARGIN,
    info: {
      Title: "Onboarding readiness report",
      Author: theme.brandName,
      CreationDate: input.run.completedAt
        ? new Date(input.run.completedAt)
        : new Date(0),
    },
  });
  const done = collectPdf(doc);

  const afterHeader = drawBrandHeader(
    doc,
    theme,
    "Onboarding readiness report",
    input.run.completedAt
      ? `Completed ${input.run.completedAt.slice(0, 10)}`
      : "In progress",
  );
  const layout = packLayout(doc, theme.primary);
  layout.cursor.y = afterHeader;
  const settled = input.run.steps.filter((s) => s.status !== "pending");
  const gaps = input.run.steps.filter((s) => s.status === "skipped");
  drawCoverIntro(
    doc,
    layout.cursor,
    input.run.clientName,
    `Prepared by ${input.firmName} — ${settled.length} of ${input.run.steps.length} checklist steps settled, ${gaps.length} gap(s) on record.`,
  );
  // drawCoverIntro leaves the cursor at the subline's start (the seam's
  // "each caller keeps its own trailing advance" rule) — advance past it
  // or the first section title overprints the subline.
  layout.cursor.y = doc.y + 12;

  layout.section("Onboarding checklist");
  for (const step of input.run.steps) {
    const outcome =
      step.status === "done"
        ? "Done"
        : step.status === "skipped"
          ? "Skipped"
          : "Pending";
    layout.kvRow(
      `${onboardingStepLabel(step.key)} — ${outcome}`,
      stepEvidenceSummary(step),
    );
  }

  layout.section("Recorded gaps");
  if (gaps.length === 0) {
    layout.emptyLine(
      "No gaps were recorded — every checklist step was satisfied by the record.",
    );
  } else {
    for (const gap of gaps) {
      // Label as a fixed row, the free-text reason (up to 500 chars) as a
      // FLOWING paragraph — emptyLine advances by doc.y, so a long reason
      // wraps instead of overprinting the next row.
      layout.kvRow(onboardingStepLabel(gap.key), "", true);
      layout.emptyLine(gap.skippedReason ?? "Skipped");
    }
  }

  layout.section("Day-one opening position");
  if (input.position) {
    for (const row of openingReportRows(input.position)) {
      layout.kvRow(row.label, row.value);
    }
  } else {
    layout.emptyLine(
      "No frozen baseline is available for this run — the opening position predates it or can no longer be read.",
    );
  }

  layout.cursor.y = ensureRoom(doc, layout.cursor.y + 10, 40);
  doc
    .font("Helvetica-Oblique")
    .fontSize(8)
    .fillColor("#888888")
    .text(
      "Every figure in this report was computed from the client's records at completion; the recorded gaps are steps the firm deliberately skipped, each with its reason. Nothing here was estimated.",
      MARGIN,
      layout.cursor.y,
      { width: CONTENT_WIDTH },
    );

  doc.end();
  return done;
}
