/** Inline field error (§7): red text tied to its input via aria-describedby. */
export function FieldError({ id, children }: { id: string; children: string }) {
  return (
    <p id={id} role="alert" className="text-sm text-destructive mt-1">
      {children}
    </p>
  );
}

/** Destructive border/ring for an input currently failing validation. */
export const invalidClass = (bad: boolean): string =>
  bad ? "border-destructive focus-visible:ring-destructive" : "";
