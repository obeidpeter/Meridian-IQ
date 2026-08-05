import type { ReactNode } from "react";

/**
 * The filter/kind pill button shared by the invoices, bills, obligations and
 * capture pages — one home for the markup that was previously copy-pasted
 * per page. Renders aria-pressed by default; role="radio" swaps it for
 * aria-checked (the capture page's radiogroup semantics).
 */
export function PillToggle({
  active,
  onClick,
  role,
  children,
  "data-testid": testId,
}: {
  active: boolean;
  onClick: () => void;
  /** Pass "radio" inside a radiogroup; omitted, the button is a toggle. */
  role?: "radio";
  children: ReactNode;
  "data-testid"?: string;
}) {
  return (
    <button
      type="button"
      role={role}
      {...(role === "radio"
        ? { "aria-checked": active }
        : { "aria-pressed": active })}
      onClick={onClick}
      className={`text-xs font-medium px-3 py-1.5 rounded-full border min-h-9 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
        active
          ? "bg-primary text-primary-foreground border-primary"
          : "bg-card text-foreground hover:bg-muted"
      }`}
      data-testid={testId}
    >
      {children}
    </button>
  );
}
