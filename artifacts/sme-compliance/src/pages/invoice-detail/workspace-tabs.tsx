import { useId, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

export const INVOICE_TABS = [
  "overview",
  "documents",
  "approvals",
  "payments",
  "history",
] as const;
export type InvoiceTab = (typeof INVOICE_TABS)[number];

export function WorkspaceTabs({
  value,
  onChange,
  panels,
  issues = {},
}: {
  value: InvoiceTab;
  onChange: (value: InvoiceTab) => void;
  panels: Record<InvoiceTab, ReactNode>;
  issues?: Partial<Record<InvoiceTab, string>>;
}) {
  const id = useId();
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  return (
    <div className="min-w-0 space-y-5">
      <div
        role="tablist"
        aria-label="Invoice workspace"
        className="flex max-w-full gap-1 overflow-x-auto border-b pb-1"
      >
        {INVOICE_TABS.map((tab, index) => (
          <Button
            key={tab}
            ref={(button) => {
              buttons.current[index] = button;
            }}
            type="button"
            role="tab"
            id={`${id}-${tab}-tab`}
            aria-controls={`${id}-${tab}-panel`}
            aria-selected={value === tab}
            aria-label={tab[0].toUpperCase() + tab.slice(1)}
            aria-describedby={issues[tab] ? `${id}-${tab}-issue` : undefined}
            tabIndex={value === tab ? 0 : -1}
            variant="ghost"
            className={`relative min-h-11 shrink-0 rounded-none border-b-2 px-3 ${value === tab ? "border-primary bg-muted text-foreground" : "border-transparent text-muted-foreground"}`}
            onClick={() => onChange(tab)}
            onKeyDown={(event) => {
              let next: number;
              if (event.key === "ArrowRight")
                next = (index + 1) % INVOICE_TABS.length;
              else if (event.key === "ArrowLeft")
                next = (index + INVOICE_TABS.length - 1) % INVOICE_TABS.length;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = INVOICE_TABS.length - 1;
              else return;
              event.preventDefault();
              onChange(INVOICE_TABS[next]);
              buttons.current[next]?.focus();
            }}
          >
            {tab[0].toUpperCase() + tab.slice(1)}
            {issues[tab] && (
              <>
                <AlertTriangle
                  className="ml-1.5 size-4 shrink-0 text-destructive"
                  aria-hidden="true"
                />
                <span id={`${id}-${tab}-issue`} className="sr-only">
                  {issues[tab]}
                </span>
              </>
            )}
          </Button>
        ))}
      </div>
      {Object.keys(issues).length > 0 && (
        <p
          role="status"
          className="text-sm text-destructive dark:text-red-300"
          data-testid="invoice-workspace-issues"
        >
          Needs attention:{" "}
          {INVOICE_TABS.filter((tab) => issues[tab])
            .map((tab) => tab[0].toUpperCase() + tab.slice(1))
            .join(", ")}
          .
        </p>
      )}
      {INVOICE_TABS.map((tab) => (
        <div
          key={tab}
          role="tabpanel"
          id={`${id}-${tab}-panel`}
          aria-labelledby={`${id}-${tab}-tab`}
          hidden={value !== tab}
          tabIndex={0}
          className="min-w-0 space-y-5 outline-none focus-visible:ring-2 focus-visible:ring-ring [&_button]:max-w-full [&_button]:whitespace-normal [&_button]:h-auto [&_button]:min-h-9 [&_button]:py-2 dark:[&_.text-destructive]:text-red-300 [overflow-wrap:anywhere]"
        >
          {panels[tab]}
        </div>
      ))}
    </div>
  );
}
