import type { ReactNode } from "react";

/**
 * Shared page header: title (the app-wide `text-page-title` hook the e2e
 * checks select), muted one-line description, and an optional actions slot
 * rendered on the opposite side of the flex-wrap row.
 */
export function PageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold" data-testid="text-page-title">
          {title}
        </h1>
        <p className="text-muted-foreground mt-1">{description}</p>
      </div>
      {children}
    </div>
  );
}
