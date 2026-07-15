import { useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Copy, FileCheck2, Grid2x2 } from "lucide-react";
import { Toaster } from "@/components/ui/toaster";
import { useToast } from "@/hooks/use-toast";
import {
  calculatePenalty,
  formatNaira,
  BAND_LABELS,
  SMALL_TURNOVER_CEILING,
  MEDIUM_TURNOVER_CEILING,
  S103_FIRST_DAY,
  S103_PER_ADDITIONAL_DAY,
  S104_PER_INVOICE,
} from "@/lib/penalty";
import { WAVES, waveForBand, waveStatus, formatWaveDate, type WaveStatus } from "@/lib/deadlines";

// TODO(product): confirm the advisory inbox address before wide promotion.
const ADVISORY_EMAIL = "advisory@meridianiq.com";

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

/** Thousands-grouped plain number, e.g. 850,000,000 (no currency symbol). */
const GROUPED_NUMBER = new Intl.NumberFormat("en-NG", { maximumFractionDigits: 2 });

interface ParsedNumber {
  /** True when the field is empty — distinct from an explicit 0. */
  isBlank: boolean;
  /** False when the text cannot be read as a single number (e.g. "5m", "1.5.3"). */
  isValid: boolean;
  /** Parsed value; 0 when blank or invalid. */
  value: number;
}

function parseNumberInput(raw: string): ParsedNumber {
  const trimmed = raw.trim();
  if (trimmed === "") return { isBlank: true, isValid: true, value: 0 };
  const cleaned = trimmed.replace(/^₦/, "").replace(/[,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return { isBlank: false, isValid: false, value: 0 };
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return { isBlank: false, isValid: false, value: 0 };
  return { isBlank: false, isValid: true, value: n };
}

function NumberField({
  id,
  label,
  hint,
  prefix,
  value,
  onChange,
  onBlur,
  error,
  echo,
  inputMode = "numeric",
}: {
  id: string;
  label: string;
  hint: string;
  prefix?: string;
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  /** Inline validation message; when set the field is marked invalid. */
  error?: string;
  /** Echo of how the input was interpreted, e.g. "= ₦850,000,000 — Large band". */
  echo?: string;
  inputMode?: "numeric" | "decimal";
}) {
  const hintId = `${id}-hint`;
  const echoId = `${id}-echo`;
  const errorId = `${id}-error`;
  const describedBy = [error ? errorId : null, echo && !error ? echoId : null, hintId]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-foreground">
        {label}
      </label>
      <div className="relative">
        {prefix && (
          <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-muted-foreground">
            {prefix}
          </span>
        )}
        <input
          id={id}
          inputMode={inputMode}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          placeholder="0"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={`w-full rounded-lg border bg-card py-2.5 pr-3 text-foreground shadow-sm outline-none transition focus:ring-2 ${
            error
              ? "border-destructive focus:border-destructive focus:ring-destructive/30"
              : "border-input focus:border-ring focus:ring-ring/30"
          } ${prefix ? "pl-8" : "pl-3"}`}
        />
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : (
        echo && (
          <p id={echoId} className="text-xs font-medium text-foreground">
            {echo}
          </p>
        )
      )}
      <p id={hintId} className="text-xs text-muted-foreground">
        {hint}
      </p>
    </div>
  );
}

function ResultRow({
  label,
  detail,
  amount,
  strong,
}: {
  label: string;
  detail: string;
  amount: number;
  strong?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div>
        <p className={`text-sm ${strong ? "font-semibold text-foreground" : "font-medium text-foreground"}`}>
          {label}
        </p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
      <p
        className={`shrink-0 tabular-nums ${
          strong ? "text-xl font-bold text-primary" : "text-base font-semibold text-foreground"
        }`}
      >
        {formatNaira(amount)}
      </p>
    </div>
  );
}

const WAVE_STATUS_PILL: Record<WaveStatus, string> = {
  upcoming:
    "bg-slate-100 text-slate-800 border-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:border-slate-800",
  onboarding:
    "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-900",
  "deadline-passed":
    "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-900",
  "enforcement-active":
    "bg-red-100 text-red-800 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-900",
};

export default function App() {
  const { toast } = useToast();
  const [turnover, setTurnover] = useState("");
  const [days, setDays] = useState("");
  const [invoices, setInvoices] = useState("");
  const [email, setEmail] = useState("");

  const turnoverParsed = parseNumberInput(turnover);
  const daysParsed = parseNumberInput(days);
  const invoicesParsed = parseNumberInput(invoices);

  const result = useMemo(
    () =>
      calculatePenalty({
        annualTurnover: turnoverParsed.value,
        daysAccessNotGranted: daysParsed.value,
        nonCompliantInvoiceCount: invoicesParsed.value,
      }),
    [turnover, days, invoices],
  );

  /** Turnover blank/invalid is distinct from ₦0 — never assert a band without it. */
  const hasTurnover = !turnoverParsed.isBlank && turnoverParsed.isValid;
  const activeWave = waveForBand(result.band);
  const activeWaveStatus = waveStatus(activeWave);

  const perInvoice = S104_PER_INVOICE[result.band];
  const dayCount = Math.floor(Math.max(0, daysParsed.value));
  const invoiceCount = Math.floor(Math.max(0, invoicesParsed.value));

  const turnoverError = turnoverParsed.isValid
    ? undefined
    : "Enter a number, like 850,000,000 — digits only.";
  const daysError = daysParsed.isValid ? undefined : "Enter a whole number of days, like 3.";
  const invoicesError = invoicesParsed.isValid
    ? undefined
    : "Enter a whole number of invoices, like 12.";

  const turnoverEcho = hasTurnover
    ? `= ${formatNaira(turnoverParsed.value)} — ${BAND_LABELS[result.band]} band`
    : undefined;
  const daysEcho =
    daysParsed.isValid && !daysParsed.isBlank && !Number.isInteger(daysParsed.value)
      ? `Counted as ${dayCount} day${dayCount === 1 ? "" : "s"}`
      : undefined;
  const invoicesEcho =
    invoicesParsed.isValid && !invoicesParsed.isBlank && !Number.isInteger(invoicesParsed.value)
      ? `Counted as ${invoiceCount} invoice${invoiceCount === 1 ? "" : "s"}`
      : undefined;

  const handleTurnoverBlur = () => {
    if (hasTurnover) setTurnover(GROUPED_NUMBER.format(turnoverParsed.value));
  };

  const summaryText = useMemo(() => {
    return [
      "MeridianIQ e-invoicing penalty estimate",
      hasTurnover
        ? `Annual turnover: ${formatNaira(turnoverParsed.value)} (${BAND_LABELS[result.band]} band)`
        : "Annual turnover: not provided",
      `Days a systems audit was blocked (s.103): ${dayCount} — ${formatNaira(result.section103)}`,
      `Invoices without a valid e-invoice stamp (s.104): ${invoiceCount} — ${formatNaira(result.section104)}`,
      `Total estimate: ${formatNaira(result.total)}`,
      "",
      "Estimate only — not legal or tax advice. Actual penalties are determined by the tax authority.",
    ].join("\n");
  }, [hasTurnover, turnoverParsed.value, result, dayCount, invoiceCount]);

  const handleCopySummary = async () => {
    try {
      await navigator.clipboard.writeText(summaryText);
      toast({ title: "Estimate summary copied to clipboard" });
    } catch {
      toast({
        title: "Couldn't copy",
        description: "Your browser blocked clipboard access.",
        variant: "destructive",
      });
    }
  };

  const mailtoHref = useMemo(() => {
    const subject = "MeridianIQ compliance review request";
    const body = [
      summaryText,
      "",
      email.trim() ? `Reply to: ${email.trim()}` : "",
      "Please contact me to review my e-invoicing compliance.",
    ]
      .filter(Boolean)
      .join("\n");
    return `mailto:${ADVISORY_EMAIL}?subject=${encodeURIComponent(
      subject,
    )}&body=${encodeURIComponent(body)}`;
  }, [summaryText, email]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <a
        href="#main-content"
        className={`sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-primary-foreground focus:shadow-sm ${FOCUS_RING}`}
      >
        Skip to content
      </a>
      <Toaster />
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-4 sm:px-6">
          <a
            href="/"
            aria-label="MeridianIQ home"
            className={`inline-flex items-center gap-3 rounded-lg ${FOCUS_RING}`}
          >
            <div className="rounded-lg bg-primary p-1.5 text-primary-foreground">
              <FileCheck2 className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <p className="text-base font-bold leading-none">MeridianIQ</p>
              <p className="text-xs text-muted-foreground leading-tight">
                Nigerian e-invoicing compliance
              </p>
            </div>
          </a>
          <a
            href="/"
            data-testid="link-back-to-website"
            className={`ml-auto inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-foreground transition hover:bg-muted ${FOCUS_RING}`}
          >
            <ArrowLeft className="h-5 w-5" aria-hidden="true" />
            Back to website
          </a>
          <a
            href="/login"
            data-testid="link-all-apps"
            className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-foreground transition hover:bg-muted ${FOCUS_RING}`}
          >
            <Grid2x2 className="h-5 w-5" aria-hidden="true" />
            All apps
          </a>
        </div>
      </header>

      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto max-w-5xl px-4 py-8 focus:outline-none sm:px-6 sm:py-10"
      >
        {/* Intro */}
        <div className="max-w-2xl">
          <h1 className="text-2xl md:text-3xl font-bold" data-testid="text-page-title">
            E-invoicing penalty estimator
          </h1>
          <p className="text-muted-foreground mt-1">
            Estimate your potential exposure under s.103 (blocking a tax-authority systems audit)
            and s.104 (invoices issued without a valid e-invoice stamp). Everything runs in your
            browser — nothing you enter is sent or stored.
          </p>
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-5">
          {/* Inputs */}
          <div className="order-1 lg:order-none lg:col-span-3 lg:col-start-1 lg:row-start-1">
            <div className="rounded-xl border border-card-border bg-card p-5 shadow-sm sm:p-6">
              <h2 className="text-base font-semibold">Your details</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Enter figures for the affected period. Leave a field blank if it does not apply.
              </p>

              <div className="mt-5 space-y-5">
                <NumberField
                  id="turnover"
                  label="Annual turnover"
                  prefix="₦"
                  inputMode="decimal"
                  hint={`Determines your band — Small ≤ ${formatNaira(
                    SMALL_TURNOVER_CEILING,
                  )}, Medium ≤ ${formatNaira(MEDIUM_TURNOVER_CEILING)}, Large above.`}
                  value={turnover}
                  onChange={setTurnover}
                  onBlur={handleTurnoverBlur}
                  error={turnoverError}
                  echo={turnoverEcho}
                />
                <NumberField
                  id="days"
                  label="Days you blocked a tax-authority systems audit (s.103)"
                  inputMode="numeric"
                  hint={`${formatNaira(S103_FIRST_DAY)} for the first day, then ${formatNaira(
                    S103_PER_ADDITIONAL_DAY,
                  )} for each additional day.`}
                  value={days}
                  onChange={setDays}
                  error={daysError}
                  echo={daysEcho}
                />
                <NumberField
                  id="invoices"
                  label="Invoices issued without a valid e-invoice stamp (s.104)"
                  inputMode="numeric"
                  hint={
                    hasTurnover
                      ? `${formatNaira(perInvoice)} per invoice at your ${
                          BAND_LABELS[result.band]
                        } band.`
                      : `Charged per invoice by band — ${formatNaira(
                          S104_PER_INVOICE.small,
                        )} (Small), ${formatNaira(S104_PER_INVOICE.medium)} (Medium), ${formatNaira(
                          S104_PER_INVOICE.large,
                        )} (Large).`
                  }
                  value={invoices}
                  onChange={setInvoices}
                  error={invoicesError}
                  echo={invoicesEcho}
                />
              </div>
            </div>
          </div>

          {/* Results */}
          <section
            aria-label="Estimated exposure"
            className="order-2 lg:order-none lg:col-span-2 lg:col-start-4 lg:row-span-2 lg:row-start-1"
          >
            <div className="sticky top-6 rounded-xl border border-card-border bg-card p-5 shadow-sm sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold">Estimated exposure</h2>
                <span className="rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground">
                  {hasTurnover
                    ? `${BAND_LABELS[result.band]} band`
                    : "Enter turnover to see your band"}
                </span>
              </div>

              <div aria-live="polite" className="mt-4 rounded-lg bg-primary/5 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Total estimate
                </p>
                <p
                  className="mt-1 text-3xl font-bold tabular-nums text-primary"
                  data-testid="text-total"
                >
                  {formatNaira(result.total)}
                </p>
              </div>

              <div className="mt-2 divide-y divide-border">
                <ResultRow
                  label="s.103 — Systems access"
                  detail={
                    dayCount > 0
                      ? `${dayCount} day${dayCount === 1 ? "" : "s"} audit was blocked`
                      : "No days entered"
                  }
                  amount={result.section103}
                />
                <ResultRow
                  label="s.104 — Invoice compliance"
                  detail={
                    invoiceCount > 0
                      ? hasTurnover
                        ? `${invoiceCount} × ${formatNaira(perInvoice)}`
                        : `${invoiceCount} × ${formatNaira(perInvoice)} (assumes Small band — enter turnover)`
                      : "No invoices entered"
                  }
                  amount={result.section104}
                />
                <ResultRow label="Combined total" detail="s.103 + s.104" amount={result.total} strong />
              </div>

              <p className="mt-4 text-xs text-muted-foreground">
                This is an estimate for guidance only — not legal or tax advice, and not a demand
                from any authority. Actual penalties are determined by the tax authority.
              </p>

              <a
                href="/app/"
                data-testid="link-product-cta"
                className={`mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:opacity-90 ${FOCUS_RING}`}
              >
                See how MeridianIQ keeps you compliant
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </a>
            </div>
          </section>

          {/* Optional contact */}
          <div className="order-3 lg:order-none lg:col-span-3 lg:col-start-1 lg:row-start-2">
            <div className="rounded-xl border border-card-border bg-card p-5 shadow-sm sm:p-6">
              <h2 className="text-base font-semibold">Talk to an advisor (optional)</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                "Request a review" opens your email app with the estimate pre-filled — nothing is
                sent until you press send. Prefer another channel? Copy the summary instead.
              </p>
              <div className="mt-4 space-y-1.5">
                <label
                  htmlFor="advisor-email"
                  className="block text-sm font-medium text-foreground"
                >
                  Your email
                </label>
                <input
                  id="advisor-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  className="w-full rounded-lg border border-input bg-card px-3 py-2.5 text-foreground shadow-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/30"
                />
              </div>
              <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                <a
                  href={mailtoHref}
                  data-testid="link-request-review"
                  className={`inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:opacity-90 ${FOCUS_RING}`}
                >
                  Request a review
                </a>
                <button
                  type="button"
                  onClick={handleCopySummary}
                  data-testid="button-copy-summary"
                  className={`inline-flex items-center justify-center gap-2 rounded-lg border border-input bg-card px-4 py-2.5 text-sm font-semibold text-foreground shadow-sm transition hover:bg-muted ${FOCUS_RING}`}
                >
                  <Copy className="h-4 w-4" aria-hidden="true" />
                  Copy estimate summary
                </button>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Or email us directly at{" "}
                <a
                  href={`mailto:${ADVISORY_EMAIL}`}
                  className={`font-medium text-foreground underline underline-offset-2 rounded ${FOCUS_RING}`}
                >
                  {ADVISORY_EMAIL}
                </a>
                .
              </p>
            </div>
          </div>
        </div>

        {/* Deadlines */}
        <section className="mt-12">
          <h2 className="text-xl font-bold">Onboarding & enforcement waves</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            The e-invoicing mandate is rolling out in waves by taxpayer size. Indicative planning
            dates — always confirm against the tax authority's official notices.
          </p>

          <div className="mt-5 grid gap-4 md:grid-cols-3">
            {WAVES.map((wave) => {
              const isActive = hasTurnover && wave.band === result.band;
              const status = waveStatus(wave);
              return (
                <div
                  key={wave.band}
                  aria-current={isActive ? "true" : undefined}
                  className={`rounded-xl border p-5 shadow-sm transition ${
                    isActive
                      ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                      : "border-card-border bg-card"
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold">{wave.name}</h3>
                    {isActive && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">
                        <Check className="h-3 w-3" aria-hidden="true" />
                        Your band
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{wave.threshold}</p>
                  <div className="mt-3">
                    <span
                      className={`inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full border ${
                        WAVE_STATUS_PILL[status.status]
                      }`}
                    >
                      {status.label}
                    </span>
                  </div>
                  <dl className="mt-3 space-y-1.5 text-xs">
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">Onboard by</dt>
                      <dd className="font-medium">{formatWaveDate(wave.onboardingBy)}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">Enforcement</dt>
                      <dd className="font-medium">{formatWaveDate(wave.enforcementFrom)}</dd>
                    </div>
                  </dl>
                  <p className="mt-3 text-xs font-medium text-foreground">{status.detail}</p>
                  <p className="mt-2 text-xs leading-relaxed text-foreground/80">{wave.summary}</p>
                </div>
              );
            })}
          </div>

          {hasTurnover && (
            <div className="mt-4 rounded-lg border border-border bg-secondary/40 p-4 text-sm">
              <span className="font-medium">Your band ({BAND_LABELS[result.band]}):</span>{" "}
              <span className="text-muted-foreground">
                {activeWaveStatus.detail}. {activeWave.summary}
              </span>
            </div>
          )}
        </section>

        {/* Methodology */}
        <section className="mt-12 rounded-xl border border-card-border bg-card p-5 shadow-sm sm:p-6">
          <h2 className="text-base font-semibold">How this is calculated</h2>
          <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
            <li>
              <span className="font-medium text-foreground">Band</span> — set by annual turnover:
              Small ≤ {formatNaira(SMALL_TURNOVER_CEILING)}, Medium ≤{" "}
              {formatNaira(MEDIUM_TURNOVER_CEILING)}, Large above.
            </li>
            <li>
              <span className="font-medium text-foreground">s.103</span> —{" "}
              {formatNaira(S103_FIRST_DAY)} for the first day a systems audit is blocked, plus{" "}
              {formatNaira(S103_PER_ADDITIONAL_DAY)} for every additional day.
            </li>
            <li>
              <span className="font-medium text-foreground">s.104</span> — per invoice issued
              without a valid e-invoice stamp: {formatNaira(S104_PER_INVOICE.small)} (Small),{" "}
              {formatNaira(S104_PER_INVOICE.medium)} (Medium),{" "}
              {formatNaira(S104_PER_INVOICE.large)} (Large).
            </li>
          </ul>
        </section>
      </main>

      {/* Live total bar on small screens (visual duplicate of the results card) */}
      {hasTurnover && (
        <div
          aria-hidden="true"
          className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 backdrop-blur lg:hidden"
        >
          <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3 sm:px-6">
            <span className="text-sm text-muted-foreground">Total estimate</span>
            <span className="text-base font-bold tabular-nums text-primary">
              {formatNaira(result.total)}
            </span>
          </div>
        </div>
      )}

      <footer className="border-t border-border">
        <div className="mx-auto max-w-5xl px-4 py-6 pb-20 text-xs text-muted-foreground sm:px-6 lg:pb-6">
          © {new Date().getFullYear()} MeridianIQ. Estimates only — not legal or tax advice. No data
          entered here leaves your device.
        </div>
      </footer>
    </div>
  );
}
