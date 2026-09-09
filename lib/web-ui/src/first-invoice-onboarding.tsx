import {
  AlertTriangle,
  ArrowRight,
  Check,
  Circle,
  RefreshCw,
} from "lucide-react";
import { useId } from "react";
import { firstInvoiceJourney } from "./first-invoice-journey";
import type { TodaySetupStepView } from "./today-types";

export function FirstInvoiceOnboarding({
  setup,
  onOpen,
  error,
  loading = false,
  onRetry,
}: {
  setup: TodaySetupStepView[];
  onOpen: (href: string) => void;
  error?: string | null;
  loading?: boolean;
  onRetry?: () => void;
}) {
  const titleId = useId();
  const nextDescriptionId = useId();
  const journey = firstInvoiceJourney(setup);
  const { next, completed, total, percent, blocked } = journey;
  const unavailable = Boolean(error) || loading;
  const progress = `${completed} of ${total} complete`;

  return (
    <section
      className="mi-today__setup mi-today__journey"
      aria-labelledby={titleId}
      aria-busy={loading}
    >
      <div className="mi-today__setup-heading">
        <div>
          <h2 id={titleId} className="mi-work-queue__title">
            {journey.isInvoiceJourney
              ? "First-invoice journey"
              : "Getting ready"}
          </h2>
          <span>
            {loading
              ? "Checking setup records"
              : error
                ? "Setup records unavailable"
                : total
                  ? progress
                  : "No steps available"}
          </span>
        </div>
        {!unavailable && percent !== null ? <strong>{percent}%</strong> : null}
      </div>

      {loading ? (
        <p className="mi-today__setup-empty" role="status">
          Loading setup records...
        </p>
      ) : error ? (
        <div className="mi-today__setup-empty">
          <p role="alert">Setup progress is unavailable. {error}</p>
          {onRetry ? (
            <button
              type="button"
              className="mi-today__text-action"
              onClick={onRetry}
            >
              <RefreshCw aria-hidden="true" />
              Retry setup
            </button>
          ) : null}
        </div>
      ) : total === 0 ? (
        <p className="mi-today__setup-empty">
          No setup steps apply to this role.
        </p>
      ) : (
        <>
          <div
            className="mi-today__progress"
            role="progressbar"
            aria-label="Workspace setup progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? 0}
            aria-valuetext={progress}
          >
            <span style={{ width: `${percent}%` }} />
          </div>

          <div className="mi-today__setup-empty mi-today__next-step">
            {next ? (
              <>
                <p className="mi-work-item__title">
                  {journey.isInvoiceJourney && !next.stage
                    ? "Next workspace step"
                    : "Recommended next step"}
                </p>
                <p id={nextDescriptionId} className="mi-work-item__description">
                  {next.description}
                </p>
                <button
                  type="button"
                  className="mi-today__text-action"
                  aria-label={`Continue: ${next.label}`}
                  aria-describedby={nextDescriptionId}
                  onClick={() => onOpen(next.href)}
                >
                  {next.label}
                  <ArrowRight aria-hidden="true" />
                </button>
              </>
            ) : (
              <p className="mi-work-item__title">
                {completed === total
                  ? "All available setup steps are complete."
                  : "The remaining steps need attention before you can continue."}
              </p>
            )}
            {blocked ? (
              <p className="mi-work-item__description">
                {blocked} {blocked === 1 ? "step needs" : "steps need"}{" "}
                attention.
              </p>
            ) : null}
          </div>

          <p className="mi-sr-only" role="status">
            {progress}. {next ? `Next: ${next.label}.` : ""}
            {blocked ? ` ${blocked} steps need attention.` : ""}
          </p>

          <ol className="mi-today__setup-list" aria-label="Setup steps">
            {journey.steps.map((step) => {
              const waiting = step.waitingFor.length > 0;
              const blocked = Boolean(step.blockedReason);
              return (
                <li
                  key={step.id}
                  data-complete={step.complete}
                  data-blocked={waiting || blocked}
                  aria-current={step.id === next?.id ? "step" : undefined}
                >
                  <span className="mi-today__setup-marker" aria-hidden="true">
                    {step.complete ? (
                      <Check />
                    ) : waiting || blocked ? (
                      <AlertTriangle />
                    ) : (
                      <Circle />
                    )}
                  </span>
                  <button
                    type="button"
                    disabled={blocked || !step.href.trim()}
                    onClick={() => onOpen(step.href)}
                  >
                    {step.stage ? <small>{step.stage}</small> : null}
                    <strong>{step.label}</strong>
                    <span className="mi-today__step-status">
                      {step.complete
                        ? "Completed"
                        : blocked
                          ? "Blocked"
                          : waiting
                            ? "Waiting"
                            : "Not completed"}
                    </span>
                    <small>{step.description}</small>
                    {step.blockedReason ? (
                      <small className="mi-today__step-blocker">
                        {step.blockedReason}
                      </small>
                    ) : null}
                    {waiting ? (
                      <small className="mi-today__step-blocker">
                        Waiting for:{" "}
                        {step.waitingFor
                          .map((prerequisite) => prerequisite.label)
                          .join("; ")}
                        .
                      </small>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}
