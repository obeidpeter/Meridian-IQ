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
    <div
      className={cn(
        "flex flex-col items-center gap-2 px-6 py-12 text-center",
        className,
      )}
    >
      <span className="mb-2 grid size-12 place-items-center rounded-md bg-muted text-muted-foreground">
        <Icon className="size-5" aria-hidden="true" />
      </span>
      {title && (
        <p className="font-semibold" data-testid={testId}>
          {title}
        </p>
      )}
      {description && (
        <p className="max-w-md text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      )}
      {children}
    </div>
  );
}
