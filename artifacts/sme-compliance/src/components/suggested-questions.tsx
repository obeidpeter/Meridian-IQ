// Clickable opener chips for Ask Clerk. Picking one asks it straight away —
// the questions are pre-phrased to land in the grounded data intents, so the
// first answer comes from the asker's own records rather than a refusal.
export function SuggestedQuestions({
  questions,
  disabled,
  onPick,
}: {
  questions: string[];
  disabled?: boolean;
  onPick: (question: string) => void;
}) {
  if (questions.length === 0) return null;
  return (
    <div
      className="flex flex-wrap gap-2"
      data-testid="chips-suggested-questions"
    >
      {questions.map((q) => (
        <button
          key={q}
          type="button"
          onClick={() => onPick(q)}
          disabled={disabled}
          className="rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {q}
        </button>
      ))}
    </div>
  );
}
