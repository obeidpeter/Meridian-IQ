import type { ReactNode } from "react";
import { WorkspaceHeader } from "@workspace/web-ui";

/**
 * Shared page header: title (the app-wide `text-page-title` hook the e2e
 * checks select), muted one-line description, and an optional actions slot.
 * Renders the design-system WorkspaceHeader (R70), whose actions slot wraps
 * under 640px — the previous `shrink-0` row pushed three buttons past the
 * edge of a 390px viewport.
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
    <WorkspaceHeader
      title={title}
      description={description}
      actions={children}
    />
  );
}
