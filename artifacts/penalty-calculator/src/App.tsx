import { useMemo, useState } from "react";
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
import { WAVES, waveForBand } from "@/lib/deadlines";

function parseNumber(value: string): number {
  const cleaned = value.replace(/[^0-9.]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function NumberField({
  id,
  label,
  hint,
  prefix,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  prefix?: string;
  value: string;
  onChange: (v: string) => void;
}) {
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
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0"
          className={`w-full rounded-lg border border-input bg-card py-2.5 pr-3 text-foreground shadow-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/30 ${
            prefix ? "pl-8" : "pl-3"
          }`}
        />
      </div>
      <p className="text-xs text-muted-foreground">{hint}</p>
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

export default function App() {
  const [turnover, setTurnover] = useState("");
  const [days, setDays] = useState("");
  const [invoices, setInvoices] = useState("");
  const [email, setEmail] = useState("");

  const input = {
    annualTurnover: parseNumber(turnover),
    daysAccessNotGranted: parseNumber(days),
    nonCompliantInvoiceCount: parseNumber(invoices),
  };

  const result = useMemo(() => calculatePenalty(input), [turnover, days, invoices]);
  const activeWave = waveForBand(result.band);

  const perInvoice = S104_PER_INVOICE[result.band];
  const dayCount = Math.floor(Math.max(0, input.daysAccessNotGranted));
  const invoiceCount = Math.floor(Math.max(0, input.nonCompliantInvoiceCount));

  const mailtoHref = useMemo(() => {
    const subject = "MeridianIQ compliance review request";
    const body = [
      "Estimated exposure from the public calculator:",
      `Turnover band: ${BAND_LABELS[result.band]}`,
      `s.103 (access): ${formatNaira(result.section103)}`,
      `s.104 (invoices): ${formatNaira(result.section104)}`,
      `Total estimate: ${formatNaira(result.total)}`,
      "",
      email.trim() ? `Reply to: ${email.trim()}` : "",
      "Please contact me to review my e-invoicing compliance.",
    ]
      .filter(Boolean)
      .join("\n");
    return `mailto:advisory@meridianiq.example?subject=${encodeURIComponent(
      subject,
    )}&body=${encodeURIComponent(body)}`;
  }, [result, email]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-4 sm:px-6">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold">
            M
          </div>
          <div>
            <p className="text-sm font-semibold leading-tight">MeridianIQ</p>
            <p className="text-xs text-muted-foreground leading-tight">
              Nigerian e-invoicing compliance
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-10">
        {/* Intro */}
        <div className="max-w-2xl">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            E-invoicing penalty estimator
          </h1>
          <p className="mt-2 text-sm text-muted-foreground sm:text-base">
            Estimate your potential exposure under s.103 (failure to grant systems access) and
            s.104 (non-compliant electronic invoices). Everything runs in your browser — nothing
            you enter is sent or stored.
          </p>
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-5">
          {/* Inputs */}
          <section className="lg:col-span-3">
            <div className="rounded-xl border border-card-border bg-card p-5 shadow-sm sm:p-6">
              <h2 className="text-base font-semibold">Your details</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Enter figures for the affected period. Leave a field at zero if it does not apply.
              </p>

              <div className="mt-5 space-y-5">
                <NumberField
                  id="turnover"
                  label="Annual turnover"
                  prefix="₦"
                  hint={`Determines your band — Small ≤ ${formatNaira(
                    SMALL_TURNOVER_CEILING,
                  )}, Medium ≤ ${formatNaira(MEDIUM_TURNOVER_CEILING)}, Large above.`}
                  value={turnover}
                  onChange={setTurnover}
                />
                <NumberField
                  id="days"
                  label="Days access was not granted (s.103)"
                  hint={`${formatNaira(S103_FIRST_DAY)} for the first day, then ${formatNaira(
                    S103_PER_ADDITIONAL_DAY,
                  )} for each additional day.`}
                  value={days}
                  onChange={setDays}
                />
                <NumberField
                  id="invoices"
                  label="Non-compliant electronic invoices (s.104)"
                  hint="Invoices that were not fiscalised or were issued incorrectly, charged per invoice by band."
                  value={invoices}
                  onChange={setInvoices}
                />
              </div>
            </div>

            {/* Optional contact */}
            <div className="mt-6 rounded-xl border border-card-border bg-card p-5 shadow-sm sm:p-6">
              <h2 className="text-base font-semibold">Talk to an advisor (optional)</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Optional. We don't store anything — this just opens your email app with the estimate
                pre-filled so you can reach out if you'd like a review.
              </p>
              <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  className="w-full rounded-lg border border-input bg-card px-3 py-2.5 text-foreground shadow-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/30"
                />
                <a
                  href={mailtoHref}
                  className="inline-flex shrink-0 items-center justify-center rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:opacity-90"
                >
                  Request a review
                </a>
              </div>
            </div>
          </section>

          {/* Results */}
          <section className="lg:col-span-2">
            <div className="sticky top-6 rounded-xl border border-card-border bg-card p-5 shadow-sm sm:p-6">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold">Estimated exposure</h2>
                <span className="rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground">
                  {BAND_LABELS[result.band]} band
                </span>
              </div>

              <div className="mt-4 rounded-lg bg-primary/5 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Total estimate
                </p>
                <p className="mt-1 text-3xl font-bold tabular-nums text-primary">
                  {formatNaira(result.total)}
                </p>
              </div>

              <div className="mt-2 divide-y divide-border">
                <ResultRow
                  label="s.103 — Systems access"
                  detail={
                    dayCount > 0
                      ? `${dayCount} day${dayCount === 1 ? "" : "s"} not granted`
                      : "No days entered"
                  }
                  amount={result.section103}
                />
                <ResultRow
                  label="s.104 — Invoice compliance"
                  detail={
                    invoiceCount > 0
                      ? `${invoiceCount} × ${formatNaira(perInvoice)}`
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
            </div>
          </section>
        </div>

        {/* Deadlines */}
        <section className="mt-12">
          <h2 className="text-xl font-bold tracking-tight">Onboarding & enforcement waves</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            The e-invoicing mandate is rolling out in waves by taxpayer size. Indicative planning
            dates — always confirm against the tax authority's official notices.
          </p>

          <div className="mt-5 grid gap-4 md:grid-cols-3">
            {WAVES.map((wave) => {
              const isActive = wave.band === result.band;
              return (
                <div
                  key={wave.band}
                  className={`rounded-xl border p-5 shadow-sm transition ${
                    isActive
                      ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                      : "border-card-border bg-card"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">{wave.name}</p>
                    {isActive && (
                      <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-foreground">
                        You
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{wave.threshold}</p>
                  <dl className="mt-3 space-y-1.5 text-xs">
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">Onboard by</dt>
                      <dd className="font-medium">{wave.onboardingBy}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">Enforcement</dt>
                      <dd className="font-medium">{wave.enforcementFrom}</dd>
                    </div>
                  </dl>
                  <p className="mt-3 text-xs leading-relaxed text-foreground/80">{wave.summary}</p>
                </div>
              );
            })}
          </div>

          <div className="mt-4 rounded-lg border border-border bg-secondary/40 p-4 text-sm">
            <span className="font-medium">Your band ({BAND_LABELS[result.band]}):</span>{" "}
            <span className="text-muted-foreground">
              {activeWave.summary}
            </span>
          </div>
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
              {formatNaira(S103_FIRST_DAY)} for the first day access is not granted, plus{" "}
              {formatNaira(S103_PER_ADDITIONAL_DAY)} for every additional day.
            </li>
            <li>
              <span className="font-medium text-foreground">s.104</span> — per non-compliant
              invoice: {formatNaira(S104_PER_INVOICE.small)} (Small),{" "}
              {formatNaira(S104_PER_INVOICE.medium)} (Medium),{" "}
              {formatNaira(S104_PER_INVOICE.large)} (Large).
            </li>
          </ul>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto max-w-5xl px-4 py-6 text-xs text-muted-foreground sm:px-6">
          © {new Date().getFullYear()} MeridianIQ. Estimates only — not legal or tax advice. No data
          entered here leaves your device.
        </div>
      </footer>
    </div>
  );
}
