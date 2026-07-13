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
    <Skeleton className="h-8 w-16 mt-1" />
  ) : (
    <p className={`text-2xl font-bold mt-1 tabular-nums ${valueTone}`}>
      {value}
    </p>
  );
  return (
    <Card data-testid={testId}>
      <CardContent className="pt-6">
        {Icon ? (
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">{label}</p>
              {valueEl}
            </div>
            <Icon
              aria-hidden="true"
              className={`w-8 h-8 ${
                iconTone === "danger"
                  ? "text-red-500 dark:text-red-400"
                  : iconTone === "warning"
                    ? "text-amber-500 dark:text-amber-400"
                    : "text-primary"
              }`}
            />
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{label}</p>
            {valueEl}
          </>
        )}
        {detail && (
          <p className="text-xs text-muted-foreground mt-1">{detail}</p>
        )}
      </CardContent>
    </Card>
  );
}
