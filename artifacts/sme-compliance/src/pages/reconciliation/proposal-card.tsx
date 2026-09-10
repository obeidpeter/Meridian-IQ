import { Link } from "wouter";
import type {
  MatchProposalView,
  MatchAssist,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Check, Sparkles, X } from "lucide-react";
import {
  formatNaira,
  formatDate,
  formatPct,
  pillClasses,
  statusLabel,
  proposalStatusLabel,
  proposalBadgeClasses,
  confidenceBadgeClasses,
} from "@/lib/format";

/**
 * One match proposal's card in section 3 — render + per-row callbacks only;
 * every hook (decisions, assist, narration join) stays in Reconciliation.
 * The assist button is disabled while ANY row's assist is in flight
 * (assistingId non-null) but labelled only on its own row, so the component
 * takes the full assistingId rather than a boolean.
 */
export function ProposalCard({
  proposal: p,
  narrationChip,
  decidingId,
  assistingId,
  assist,
  onDecide,
  onExplain,
}: {
  proposal: MatchProposalView;
  narrationChip: string | null;
  decidingId: string | null;
  assistingId: string | null;
  assist: MatchAssist | undefined;
  onDecide: (proposal: MatchProposalView, action: "accept" | "reject") => void;
  onExplain: (proposal: MatchProposalView) => void;
}) {
  return (
    <div className="border rounded-md px-3 py-2 text-sm space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <Link
            href={`/invoices/${p.invoiceId}`}
            className="font-semibold truncate hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
            data-testid={`link-proposal-invoice-${p.id}`}
          >
            {p.invoiceNumber}
          </Link>
          <span className={confidenceBadgeClasses(p.confidence)}>
            {formatPct(p.confidence, 0)} match
          </span>
          <span className={proposalBadgeClasses(p.status)}>
            {proposalStatusLabel(p.status)}
          </span>
          {narrationChip && (
            <span
              className={pillClasses("violet")}
              data-testid={`narration-chip-${p.id}`}
            >
              <Sparkles className="w-3 h-3" aria-hidden="true" />
              {narrationChip}
            </span>
          )}
        </div>
        {p.status === "proposed" && (
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => onDecide(p, "accept")}
              disabled={decidingId === p.id}
            >
              <Check className="w-4 h-4 mr-1" aria-hidden="true" />
              {decidingId === p.id ? "Saving…" : "Accept"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onDecide(p, "reject")}
              disabled={decidingId === p.id}
            >
              <X className="w-4 h-4 mr-1" aria-hidden="true" /> Reject
            </Button>
          </div>
        )}
      </div>
      <p className="text-muted-foreground">
        {p.buyerName} · statement line {p.lineNo ?? "—"} of{" "}
        {formatDate(p.lineDate)}
      </p>
      {p.narration && (
        <p className="text-xs font-mono text-muted-foreground truncate">
          {p.narration}
        </p>
      )}
      <div className="flex flex-wrap gap-4 text-xs">
        <span>
          Line amount:{" "}
          <span className="font-medium tabular-nums">
            {formatNaira(p.lineAmount)}
          </span>
        </span>
        <span>
          Invoice total:{" "}
          <span className="font-medium tabular-nums">
            {formatNaira(p.invoiceTotal)}
          </span>
        </span>
        <span className="text-muted-foreground">
          Invoice status: {statusLabel(p.invoiceStatus)}
        </span>
      </div>
      {p.status === "proposed" && Number(p.confidence) < 0.85 && !assist && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => onExplain(p)}
          disabled={assistingId !== null}
          data-testid={`button-assist-${p.id}`}
        >
          <Sparkles className="w-3.5 h-3.5 mr-1" aria-hidden="true" />
          {assistingId === p.id ? "Asking Clerk…" : "Why this match?"}
        </Button>
      )}
      {assist && (
        <div
          className="rounded-md border border-violet-200 dark:border-violet-900 bg-violet-50 dark:bg-violet-950/40 px-3 py-2 space-y-1"
          data-testid={`assist-${p.id}`}
        >
          <p className="text-xs font-medium text-violet-800 dark:text-violet-300 flex items-center gap-1">
            <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
            {assist.source === "clerk"
              ? "Clerk's read on this line"
              : "Match evidence"}
          </p>
          <p className="text-sm">{assist.explanation}</p>
          {(assist.ranked.find((r) => r.proposalId === p.id)?.highlights
            .length ?? 0) > 0 && (
            <ul className="text-xs text-muted-foreground list-disc pl-4 space-y-0.5">
              {assist.ranked
                .find((r) => r.proposalId === p.id)!
                .highlights.map((h, i) => (
                  <li key={i}>{h}</li>
                ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">
            Ranked by the deterministic matcher — accepting stays your decision.
          </p>
        </div>
      )}
    </div>
  );
}
