// The console dock's pure kernels: the failure line and the compact answer
// view. Kept DOM-free so they are unit-tested under the node environment.
import { clerkBudgetExhausted } from "@workspace/api-errors";
import { killSwitchTripped, serverErrorMessage } from "@/lib/errors";

/** The dock's failure line: the same split the full Ask page makes, in one string. */
export function dockErrorMessage(err: unknown): string {
  if (killSwitchTripped(err)) {
    return "Clerk is switched off right now — an operator can restore it. Nothing was changed.";
  }
  if (clerkBudgetExhausted(err)) {
    return "This month's Clerk allowance is used up — questions resume next month. Nothing was changed.";
  }
  return `${serverErrorMessage(err) ?? "Clerk could not answer that question."} Nothing was changed.`;
}

const DOCK_FACT_CAP = 6;

/** Scope suffix for a data answer's source line: the resolved display labels. */
function dataAnswerScope(
  dataParams: Record<string, string> | undefined,
): string {
  return Object.values(dataParams ?? {})
    .filter((v) => v.trim().length > 0)
    .join(" · ");
}

/**
 * The dock's compact view of an answer: the fact cap, the SOURCE line the
 * full page shows, and whether anything was dropped so the dock can point
 * at the full workspace rather than imply this is everything.
 */
export function dockAnswerView(answer: {
  answered: boolean;
  refusalReason?: string | null;
  proposition?: string | null;
  citation?: string | null;
  dataIntent?: string | null;
  dataParams?: Record<string, string>;
  claimKey?: string | null;
  claimVersion?: number | string | null;
  facts?: { key: string; label: string; value: string; unit?: string | null }[];
  sections?: {
    facts: {
      key: string;
      label: string;
      value: string;
      unit?: string | null;
    }[];
    action?: unknown;
  }[];
  links?: unknown[];
}) {
  const allFacts =
    answer.sections?.flatMap((s) => s.facts) ?? answer.facts ?? [];
  const scope = dataAnswerScope(answer.dataParams);
  const sourceLine = answer.dataIntent
    ? `From firm records${scope ? ` (${scope})` : ""}${answer.citation ? ` · ${answer.citation}` : ""}`
    : answer.claimKey
      ? `Source: ${answer.citation ?? "approved claim"} · approved claim ${answer.claimKey}${answer.claimVersion != null ? ` v${answer.claimVersion}` : ""}`
      : answer.citation
        ? `Source: ${answer.citation}`
        : null;
  const hasMore =
    allFacts.length > DOCK_FACT_CAP ||
    (answer.links?.length ?? 0) > 0 ||
    (answer.sections?.some((s) => !!s.action) ?? false);
  return {
    answered: answer.answered,
    refusalReason: answer.refusalReason,
    proposition: answer.proposition,
    facts: allFacts.slice(0, DOCK_FACT_CAP),
    sourceLine,
    hasMore,
  };
}
