import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Horizontal-scroll wrapper for wide tables. A scrollable region containing
 * no focusable element cannot be scrolled with the keyboard, so the wrapper
 * itself takes focus (the buyer portal's suppliers/scoreboard pattern:
 * tabIndex + role="region" + an aria-label naming the table) and shows an
 * INSET focus ring — several call sites sit inside overflow-hidden cards,
 * where an offset ring would clip.
 */
export function ScrollRegion({
  label,
  children,
  className,
  id,
}: {
  /** The table's name; ", scrollable" is appended for the accessible name. */
  label: string;
  children: ReactNode;
  className?: string;
  /** Only for wrappers other markup targets via aria-controls. */
  id?: string;
}) {
  return (
    <div
      id={id}
      className={cn(
        "overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        className,
      )}
      tabIndex={0}
      role="region"
      aria-label={`${label}, scrollable`}
    >
      {children}
    </div>
  );
}
