// Pure helpers for the SME reconciliation page (R126 split): the narration
// lane's cue catalogue and chip/summary wording plus the statement import
// request builder. No React, no hooks — the unit suite imports these through
// the page index ("./reconciliation").
import type {
  BankStatementLine,
  MatchProposalView,
  NarrationSuggestionsResult,
  StatementImportInput,
  StatementImportResult,
} from "@workspace/api-client-react";

// ---- Narration match lane ---------------------------------------------------
// Clerk reads the statement's middle-band narrations and records, per line,
// either a suggested proposal or an abstention (on the LINE, as
// `narrationSuggestion` — the proposals view never carries it). Everything
// here is advisory: the chip never pre-selects Accept, and accepting or
// rejecting stays the untouched decision buttons.

// Closed cue catalogue → client wording. Unknown cues (a newer server) fall
// back to a bare "Clerk suggests" rather than leaking a machine token.
const NARRATION_CUE_LABELS: Record<string, string> = {
  exact_reference: "exact reference",
  reference_fragment: "reference fragment",
  name_abbreviation: "name match",
  payer_context: "payer context",
  multi_invoice_hint: "part-payment hint",
};

/** Human label for a narration cue; null when the cue is absent or unknown. */
export function narrationCueLabel(
  cue: string | null | undefined,
): string | null {
  return (cue && NARRATION_CUE_LABELS[cue]) || null;
}

/**
 * The chip text for one proposal card, or null for no chip. Only the proposal
 * the line's suggestion points at gets one; sibling proposals on the same
 * line, abstentions (proposalId null) and lines Clerk never read all resolve
 * to null.
 */
export function narrationChipFor(
  line: Pick<BankStatementLine, "narrationSuggestion"> | undefined,
  proposalId: string,
): string | null {
  const suggestion = line?.narrationSuggestion;
  if (!suggestion || suggestion.proposalId !== proposalId) return null;
  const cue = narrationCueLabel(suggestion.cue);
  return cue ? `Clerk suggests · ${cue}` : "Clerk suggests";
}

/**
 * Whether the per-statement "Ask Clerk to read the narrations" trigger shows:
 * the caller must hold `reconciliation.act` (the server 403s a client_user
 * without it) AND at least one displayed line must be middle-band undecided —
 * a proposed match strictly below the 0.85 bulk threshold — with a narration
 * for Clerk to read. Confidence exactly 0.85 belongs to bulk accept, not
 * this lane.
 */
export function narrationSuggestVisible(
  proposals:
    | Pick<MatchProposalView, "status" | "confidence" | "narration">[]
    | undefined,
  capabilities: string[] | undefined,
): boolean {
  if (!(capabilities ?? []).includes("reconciliation.act")) return false;
  return (proposals ?? []).some(
    (p) =>
      p.status === "proposed" &&
      Number(p.confidence) < 0.85 &&
      (p.narration ?? "").trim().length > 0,
  );
}

/**
 * The one-line run summary: "Clerk read N lines — S suggestions, A
 * abstentions", with ", F failed" appended only when any line failed.
 */
export function narrationSummaryLine(
  res: Pick<
    NarrationSuggestionsResult,
    "considered" | "suggested" | "abstained" | "failed"
  >,
): string {
  const n = (count: number, word: string) =>
    `${count} ${word}${count === 1 ? "" : "s"}`;
  const base = `Clerk read ${n(res.considered, "line")} — ${n(
    res.suggested,
    "suggestion",
  )}, ${n(res.abstained, "abstention")}`;
  return res.failed > 0 ? `${base}, ${res.failed} failed` : base;
}

/**
 * The import request body for the current inputs. The scanned path's COMMIT
 * posts back the preview's `proposedCsv` (with the preview's formatKey
 * unchanged) instead of the PDF — the server refuses `pdfBase64` with
 * commit:true (contract 0.40.0), so the rows the client checked in the
 * preview are exactly the rows that commit; extraction can never silently
 * re-run between preview and commit. Editing or re-picking a file clears
 * `report`, which drops the held proposedCsv with it. A PDF preview from an
 * older server carries no proposedCsv; the PDF then rides along unchanged
 * and the server stays the authority on whether that commit is accepted.
 */
export function statementImportBody(args: {
  clientPartyId: string;
  csv: string;
  pdf: { name: string; base64: string } | null;
  report: StatementImportResult | null;
  commit: boolean;
  filename: string | null;
}): StatementImportInput {
  const proposedCsv =
    args.commit && args.pdf && args.report && !args.report.committed
      ? (args.report.proposedCsv ?? null)
      : null;
  return {
    clientPartyId: args.clientPartyId,
    ...(proposedCsv !== null
      ? {
          csv: proposedCsv,
          ...(args.report?.formatKey
            ? { formatKey: args.report.formatKey }
            : {}),
        }
      : args.pdf
        ? { pdfBase64: args.pdf.base64 }
        : { csv: args.csv }),
    commit: args.commit,
    ...(args.filename ? { filename: args.filename } : {}),
  };
}
