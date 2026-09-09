export function ConfidenceBadge({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  const tone =
    confidence >= 0.9
      ? "text-muted-foreground"
      : "text-amber-700 dark:text-amber-400 font-medium";
  return <span className={`text-xs tabular-nums ${tone}`}>{pct}%</span>;
}
