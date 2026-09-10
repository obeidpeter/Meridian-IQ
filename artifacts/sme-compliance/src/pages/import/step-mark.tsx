import { CheckCircle2 } from "lucide-react";

// Numbered step chip shared by the three cards (the readiness mark at card
// scale), so the import reads as one guided flow: add rows → validate →
// review what happened.
export function StepMark({ n, done }: { n: number; done?: boolean }) {
  return (
    <span
      className={`mi-card-icon text-xs font-bold ${done ? "" : "!bg-muted !text-muted-foreground"}`}
      data-tone={done ? "positive" : undefined}
      aria-hidden="true"
    >
      {done ? <CheckCircle2 /> : n}
    </span>
  );
}
