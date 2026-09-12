import { useRef, useState, type ReactNode } from "react";
import type { ClerkCase } from "@workspace/api-client-react";
import { ArrowDownToLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { reviewControlId, reviewTargetLabel } from "./review-derivations";

export function ReviewNavigation({
  kind,
  fields,
  onReviewField,
  children,
}: {
  kind: ClerkCase["kind"];
  fields: string[];
  onReviewField: (field: string) => void;
  children: ReactNode;
}) {
  const pane = useRef<HTMLDivElement>(null);
  const previous = useRef<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const focusNext = () => {
    if (!fields.length || !pane.current) return;
    const index = (fields.indexOf(previous.current ?? "") + 1) % fields.length;
    const field = fields[index];
    const controlId = reviewControlId(kind, field);
    const control = controlId
      ? pane.current.querySelector<HTMLElement>(`#${controlId}`)
      : null;
    const evidence = [
      ...pane.current.querySelectorAll<HTMLElement>("[data-review-field]"),
    ].find((row) => row.dataset.reviewField === field);
    const target = control ?? evidence;
    if (!target) return;
    previous.current = field;
    onReviewField(field);
    target.focus();
    target.scrollIntoView?.({ block: "center", behavior: "auto" });
    setAnnouncement(
      `${reviewTargetLabel(kind, field)}. Review target ${index + 1} of ${fields.length}.`,
    );
  };

  return (
    <div ref={pane} className="clerk-review-pane min-w-0 space-y-4">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b bg-background py-2 md:top-20">
        <Button
          type="button"
          variant="secondary"
          className="h-auto min-h-11 whitespace-normal text-left"
          onClick={focusNext}
          disabled={fields.length === 0}
        >
          <ArrowDownToLine className="h-4 w-4 shrink-0" aria-hidden="true" />
          Next field needing review
        </Button>
        <span className="text-xs text-muted-foreground">
          {fields.length} review targets
        </span>
        <span role="status" className="sr-only">
          {announcement}
        </span>
      </div>
      {children}
    </div>
  );
}
