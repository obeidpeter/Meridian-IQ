import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Shared centered empty state (mirrors the SME app's component): muted icon,
 * optional semibold title (carrying the `text-empty` testid by default),
 * optional muted description, and an optional action slot. The px-6/py-12
 * default matches the Card sites, which mount it in place of CardContent;
 * inline sites override the padding via className (twMerge lets the passed
 * classes win).
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
  className,
  testId = "text-empty",
}: {
  icon: LucideIcon;
  title?: string;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div className={cn("py-12 px-6 flex flex-col items-center text-center gap-2", className)}>
      <Icon className="w-10 h-10 text-muted-foreground" aria-hidden="true" />
      {title && (
        <p className="font-semibold" data-testid={testId}>
          {title}
        </p>
      )}
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
      {children}
    </div>
  );
}
