import type { ComponentType, ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

// The one stat-tile recipe shared across pages: Card > label > big
// tabular-nums value, with optional detail line, loading skeleton and icon.
// Two independent color axes:
//  - `tone` colors the VALUE (import-summary style shades);
//  - `iconTone` colors the ICON (portfolio style shades; value stays plain).

const VALUE_TONE: Record<string, string> = {
  success: "text-emerald-700 dark:text-emerald-400",
  warning: "text-amber-700 dark:text-amber-400",
  danger: "text-red-700 dark:text-red-400",
};

export function StatTile({
  label,
  value,
  testId,
  detail,
  loading,
  icon: Icon,
  iconTone,
  tone,
}: {
  label: string;
  value: ReactNode;
  testId: string;
  detail?: string;
  loading?: boolean;
  icon?: ComponentType<{
    className?: string;
    "aria-hidden"?: boolean | "true" | "false";
  }>;
  iconTone?: "danger" | "warning";
  tone?: "success" | "warning" | "danger";
}) {
  const valueTone = (tone && VALUE_TONE[tone]) || "";
  const valueEl = loading ? (
    <Skeleton className="mt-2 h-8 w-20" />
  ) : (
    <p
      className={`mt-2 break-words text-xl font-extrabold leading-tight tabular-nums sm:text-2xl ${valueTone}`}
    >
      {value}
    </p>
  );
  const iconClasses =
    iconTone === "danger"
      ? "bg-red-50 text-red-600 dark:bg-red-950/50 dark:text-red-400"
      : iconTone === "warning"
        ? "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400"
        : "bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300";

  return (
    <Card
      className="overflow-hidden rounded-lg border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-card"
      data-testid={testId}
    >
      <CardContent className="min-h-28 p-4 sm:p-5">
        {Icon ? (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-bold text-muted-foreground">{label}</p>
              {valueEl}
            </div>
            <span
              className={`grid size-10 shrink-0 place-items-center rounded-md ${iconClasses}`}
            >
              <Icon aria-hidden="true" className="size-5" />
            </span>
          </div>
        ) : (
          <>
            <p className="text-xs font-bold text-muted-foreground">{label}</p>
            {valueEl}
          </>
        )}
        {detail && (
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {detail}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
