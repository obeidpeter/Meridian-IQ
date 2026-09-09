import type { ReactNode } from "react";

/**
 * A polite live region that exists before it has anything to say (R115).
 *
 * Assistive technology announces CHANGES inside a region that is already in
 * the accessibility tree; a `role="status"` element that mounts together with
 * its message is a new node, not a change, and is routinely missed. This
 * renders the paragraph on every render: with the visible class while it
 * carries content, and visually hidden but still present while it is empty,
 * so the first message arrives as a change to an existing region.
 *
 * `role="alert"` does not need this treatment. Browsers raise a system alert
 * when an alert element is inserted, so alerts may keep mounting with their
 * content, and the components here leave them alone.
 */
export function LiveStatus({
  className = "mi-sr-only",
  children,
}: {
  /** Applied while the region has content; empty regions are `mi-sr-only`. */
  className?: string;
  children?: ReactNode;
}) {
  const active =
    children !== null &&
    children !== undefined &&
    children !== false &&
    children !== "";
  return (
    <p
      role="status"
      aria-atomic="true"
      className={active ? className : "mi-sr-only"}
    >
      {active ? children : null}
    </p>
  );
}
