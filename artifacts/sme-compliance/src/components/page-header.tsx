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
    <div className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-200 pb-5">
      <div className="min-w-0">
        <h1
          className="text-2xl font-extrabold text-slate-950 md:text-3xl"
          data-testid="text-page-title"
        >
          {title}
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      </div>
      {children ? <div className="shrink-0">{children}</div> : null}
    </div>
  );
}
