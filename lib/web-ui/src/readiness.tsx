import type { ReactNode } from "react";

/**
 * A guided checklist for a multi-part form (R70): each step reports done /
 * to-do / needs-attention, links to its section, and the header sums the
 * progress. Pure presentation — the page decides what "ready" means.
 */

export type ReadinessState = "done" | "todo" | "attention";

export interface ReadinessStep {
  id: string;
  label: string;
  state: ReadinessState;
  /** One line under the label: what is missing, or why it needs a look. */
  detail?: ReactNode;
  /** Anchor of the form section this step belongs to (e.g. "#details"). */
  href?: string;
}

const STATE_SUFFIX: Record<ReadinessState, string> = {
  done: " — complete",
  todo: " — not yet",
  attention: " — needs attention",
};

export function readinessSummary(steps: ReadinessStep[]): string {
  const done = steps.filter((s) => s.state === "done").length;
  return `${done} of ${steps.length} ready`;
}

export function ReadinessList({
  steps,
  className,
  summaryTestId = "text-readiness-summary",
}: {
  steps: ReadinessStep[];
  className?: string;
  summaryTestId?: string;
}) {
  const done = steps.filter((s) => s.state === "done").length;
  const percent = steps.length ? Math.round((done / steps.length) * 100) : 0;
  return (
    <div className={["mi-readiness", className].filter(Boolean).join(" ")}>
      <div className="mi-readiness__summary">
        <span data-testid={summaryTestId}>{readinessSummary(steps)}</span>
        <span
          className="mi-readiness__bar"
          role="progressbar"
          aria-label="Invoice readiness"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span style={{ width: `${percent}%` }} />
        </span>
      </div>
      <ol className="mi-readiness__list">
        {steps.map((step, index) => {
          const suffix = (
            <span className="mi-sr-only">{STATE_SUFFIX[step.state]}</span>
          );
          return (
            <li
              key={step.id}
              className="mi-readiness__step"
              data-state={step.state}
              data-testid={`readiness-${step.id}`}
            >
              <span className="mi-readiness__mark" aria-hidden="true">
                {step.state === "done" ? "✓" : step.state === "attention" ? "!" : index + 1}
              </span>
              <div className="mi-readiness__copy">
                {step.href ? (
                  <a href={step.href} className="mi-readiness__label">
                    {step.label}
                    {suffix}
                  </a>
                ) : (
                  <span className="mi-readiness__label">
                    {step.label}
                    {suffix}
                  </span>
                )}
                {step.detail ? (
                  <span className="mi-readiness__detail">{step.detail}</span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
