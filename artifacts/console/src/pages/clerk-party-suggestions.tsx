import type { ClerkPartySuggestion } from "@workspace/api-client-react";
import { pillClasses } from "@/lib/format";

// Clickable party-match chips under the supplier/buyer selects. Suggestions
// are only ever suggestions: clicking one sets the select, and the dropdown
// stays fully usable for anything else.
export function PartySuggestionChips({
  suggestions,
  value,
  onPick,
  testId,
}: {
  suggestions: ClerkPartySuggestion[];
  value: string;
  onPick: (partyId: string) => void;
  testId: string;
}) {
  if (suggestions.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 pt-1" data-testid={testId}>
      {suggestions.map((s) => (
        <button
          key={s.partyId}
          type="button"
          onClick={() => onPick(s.partyId)}
          className={`${pillClasses(value === s.partyId ? "blue" : "slate")} hover:opacity-80 transition-opacity`}
          data-testid={`${testId}-${s.partyId}`}
        >
          {s.legalName} · {Math.round(s.confidence * 100)}%
          {s.tinScore === 1 && (
            <span className="text-[10px] uppercase font-semibold">
              TIN match
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
