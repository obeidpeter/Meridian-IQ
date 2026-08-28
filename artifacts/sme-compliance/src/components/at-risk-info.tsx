import { Info } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

// The dashboard's "At risk" count, in words (server source of truth:
// routes/sme/dashboard.ts — overdue statutory deadlines plus failed
// submissions, nothing else; a deadline that is merely closing does NOT
// count). A business owner asked "why does it say 3?" deserves the rule,
// not a mood. Mirrors the console's PenaltyRiskInfo popover.

/** Stated once and unit-tested, so UI copy and server rule drift loudly. */
export const AT_RISK_RULES: string[] = [
  "a statutory submission deadline that has already passed without a stamped invoice, or",
  "an invoice whose latest submission attempt failed.",
];

export function AtRiskInfo() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          aria-label="What counts as at risk"
          data-testid="button-at-risk-info"
        >
          <Info className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 text-sm" align="start">
        <p className="font-medium mb-1">What counts as at risk</p>
        <p className="text-muted-foreground">Each at-risk item is either:</p>
        <ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">
          {AT_RISK_RULES.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">
          Counted from your own record — no AI involved.
        </p>
      </PopoverContent>
    </Popover>
  );
}
