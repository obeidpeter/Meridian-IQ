import { type ReceivablesBucket } from "@workspace/api-client-react";
import { formatNaira } from "@/lib/format";

export function AgingBucketRow({
  label,
  bucket,
  tone,
}: {
  label: string;
  bucket: ReceivablesBucket;
  tone?: "warning" | "danger";
}) {
  // The late buckets only take their warning/danger tone once something is
  // actually sitting in them.
  const nonZero = bucket.count > 0 || Number(bucket.amount) > 0;
  const toneClass =
    nonZero && tone === "danger"
      ? "text-destructive"
      : nonZero && tone === "warning"
        ? "text-amber-700 dark:text-amber-400"
        : "";
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-medium tabular-nums ${toneClass}`}>
        {formatNaira(bucket.amount)}
        <span className="text-xs text-muted-foreground font-normal">
          {" "}
          · {bucket.count}
        </span>
      </span>
    </div>
  );
}
