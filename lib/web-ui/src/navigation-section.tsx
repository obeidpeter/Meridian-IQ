import { useEffect, useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export function NavigationSection({
  title,
  active,
  route,
  primary,
  children,
}: {
  title: string;
  active: boolean;
  route: string;
  primary?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(Boolean(primary || active));
  useEffect(() => {
    if (active) setOpen(true);
  }, [active, route]);
  return (
    <div className="mi-nav__group">
      <button
        type="button"
        className="mi-nav__section-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{title}</span>
        <ChevronDown aria-hidden="true" />
      </button>
      <div id={id} hidden={!open}>
        {children}
      </div>
    </div>
  );
}
