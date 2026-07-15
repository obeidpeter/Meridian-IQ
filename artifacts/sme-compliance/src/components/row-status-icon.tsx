import { CheckCircle2, XCircle } from "lucide-react";

/**
 * The valid/invalid leading icon for per-row report lists (bulk import,
 * statement parse reports). Class strings pinned here once so both reports
 * render identically.
 */
export function RowStatusIcon({ invalid }: { invalid: boolean }) {
  return invalid ? (
    <XCircle
      className="w-4 h-4 text-destructive mt-0.5 shrink-0"
      aria-hidden="true"
    />
  ) : (
    <CheckCircle2
      className="w-4 h-4 text-emerald-600 dark:text-emerald-400 mt-0.5 shrink-0"
      aria-hidden="true"
    />
  );
}
