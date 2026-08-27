import { Info } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

// The deterministic penalty-risk rule, in words (server source of truth:
// modules/invoice/compliance-window.ts penaltyRisk + the console portfolio
// route's due-soon window). The badge appears on the portfolio workbench
// and the client header, so the explanation lives in one popover both
// pages mount — an accountant defending the ranking has something to
// point at.

/** Stated once and unit-tested, so UI copy and server rule drift loudly. */
export const PENALTY_RISK_RULES: Array<{ level: string; rule: string }> = [
  {
    level: "High",
    rule: "an invoice past its 7-day submission window, or more than one failed submission.",
  },
  {
    level: "Medium",
    rule: "a failed submission, or an unsubmitted invoice within 3 days of its window closing.",
  },
  { level: "Low", rule: "everything else." },
];

export function PenaltyRiskInfo() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          aria-label="How penalty risk is computed"
          data-testid="button-risk-info"
        >
          <Info className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 text-sm" align="start">
        <p className="font-medium mb-1">How penalty risk is computed</p>
        <ul className="space-y-1 text-muted-foreground">
          {PENALTY_RISK_RULES.map((r) => (
            <li key={r.level}>
              <span className="font-medium text-foreground">{r.level}</span> —{" "}
              {r.rule}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">
          Computed from the client's own record — no AI involved.
        </p>
      </PopoverContent>
    </Popover>
  );
}
