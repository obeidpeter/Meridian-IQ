import { useState } from "react";
import {
  ArrowRight,
  BadgeCheck,
  BarChart3,
  Building2,
  Calculator,
  Check,
  FileCheck2,
  Landmark,
  LockKeyhole,
  Menu,
  ReceiptText,
  ScanLine,
  ShieldCheck,
  Store,
  X,
  Zap,
} from "lucide-react";

const PLATFORM_FEATURES = [
  {
    icon: FileCheck2,
    title: "Comply without the scramble",
    body: "Create, submit, reconcile and retain Nigerian e-invoices from one guided workflow.",
    tone: "bg-teal-100 text-teal-800",
  },
  {
    icon: BadgeCheck,
    title: "Build a verifiable record",
    body: "Keep every stamp, consent decision and audit event connected to the underlying transaction.",
    tone: "bg-blue-100 text-blue-800",
  },
  {
    icon: BarChart3,
    title: "See risk before it compounds",
    body: "Surface deadline exposure, reconciliation gaps and portfolio-level exceptions early.",
    tone: "bg-amber-100 text-amber-900",
  },
  {
    icon: Zap,
    title: "Move from proof to liquidity",
    body: "Turn compliant invoices into verified receivables that buyers and finance partners can trust.",
    tone: "bg-lime-100 text-lime-900",
  },
];

const WORKFLOW = [
  {
    number: "01",
    icon: ReceiptText,
    title: "Capture",
    body: "Create or import invoice data once.",
  },
  {
    number: "02",
    icon: ScanLine,
    title: "Validate",
    body: "Resolve issues before submission.",
  },
  {
    number: "03",
    icon: ShieldCheck,
    title: "Verify",
    body: "Preserve stamps, consent and evidence.",
  },
  {
    number: "04",
    icon: Landmark,
    title: "Finance",
    body: "Use trusted receivables with confidence.",
  },
];

const WORKSPACES = [
  {
    icon: FileCheck2,
    title: "SME Compliance",
    body: "Guided invoicing, reconciliation, B2C clocks and deadline alerts for growing businesses.",
    accent: "text-teal-700",
    line: "bg-teal-600",
  },
  {
    icon: Building2,
    title: "Accountant Console",
    body: "A multi-client command centre for onboarding, compliance, advisory and operations.",
    accent: "text-indigo-700",
    line: "bg-indigo-600",
  },
  {
    icon: Store,
    title: "Buyer Rails",
    body: "Confirm supplier invoices, flag payments and track input-VAT exposure from one view.",
    accent: "text-blue-700",
    line: "bg-blue-600",
  },
  {
    icon: Calculator,
    title: "Penalty Calculator",
    body: "Estimate non-compliance exposure before it becomes a business disruption.",
    accent: "text-amber-700",
    line: "bg-amber-500",
    href: "/penalty-calculator/",
  },
];

function BrandLockup({ inverted = false }: { inverted?: boolean }) {
  return (
    <a
      href="/"
      className="inline-flex items-center gap-3 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#071a1c]"
      aria-label="MeridianIQ home"
    >
      <span
        className={`grid size-10 place-items-center rounded-md ${
          inverted ? "bg-lime-300 text-[#071a1c]" : "bg-teal-700 text-white"
        }`}
      >
        <FileCheck2 className="size-5" aria-hidden="true" />
      </span>
      <span>
        <span
          className={`block text-base font-extrabold leading-none ${
            inverted ? "text-white" : "text-slate-950"
          }`}
        >
          MeridianIQ
        </span>
        <span
          className={`mt-1 block text-xs ${
            inverted ? "text-white/65" : "text-slate-500"
          }`}
        >
          Compliance. Verified.
        </span>
      </span>
    </a>
  );
}

function LandingNav() {
  const [open, setOpen] = useState(false);

  const closeMenu = () => setOpen(false);

  return (
    <header className="relative z-20 border-b border-white/15">
      <div className="mx-auto flex h-[4.5rem] max-w-7xl items-center justify-between px-5 sm:px-8 lg:px-10">
        <BrandLockup inverted />

        <nav
          className="hidden items-center gap-7 text-sm font-medium text-white/80 md:flex"
          aria-label="Main navigation"
        >
          <a className="transition-colors hover:text-white" href="#platform">
            Platform
          </a>
          <a className="transition-colors hover:text-white" href="#workflow">
            How it works
          </a>
          <a className="transition-colors hover:text-white" href="#workspaces">
            Workspaces
          </a>
          <a
            className="transition-colors hover:text-white"
            href="/penalty-calculator/"
          >
            Penalty calculator
          </a>
        </nav>

        <div className="hidden md:block">
          <a
            href="/login"
            className="inline-flex h-10 items-center gap-2 rounded-md bg-lime-300 px-4 text-sm font-bold text-[#071a1c] transition-colors hover:bg-lime-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#071a1c]"
            data-testid="link-header-login"
          >
            Sign in
            <ArrowRight className="size-4" aria-hidden="true" />
          </a>
        </div>

        <button
          type="button"
          className="grid size-10 place-items-center rounded-md border border-white/20 text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300 md:hidden"
          aria-label={open ? "Close navigation" : "Open navigation"}
          aria-expanded={open}
          aria-controls="mobile-navigation"
          onClick={() => setOpen((current) => !current)}
        >
          {open ? (
            <X className="size-5" aria-hidden="true" />
          ) : (
            <Menu className="size-5" aria-hidden="true" />
          )}
        </button>
      </div>

      {open && (
        <nav
          id="mobile-navigation"
          className="absolute left-4 right-4 top-[4.75rem] rounded-md border border-white/15 bg-[#0b2527] p-3 shadow-2xl md:hidden"
          aria-label="Mobile navigation"
        >
          {[
            ["Platform", "#platform"],
            ["How it works", "#workflow"],
            ["Workspaces", "#workspaces"],
            ["Penalty calculator", "/penalty-calculator/"],
          ].map(([label, href]) => (
            <a
              key={href}
              href={href}
              onClick={closeMenu}
              className="flex min-h-11 items-center rounded-md px-3 text-sm font-medium text-white/80 transition-colors hover:bg-white/10 hover:text-white"
            >
              {label}
            </a>
          ))}
          <a
            href="/login"
            onClick={closeMenu}
            className="mt-2 flex min-h-11 items-center justify-between rounded-md bg-lime-300 px-3 text-sm font-bold text-[#071a1c]"
          >
            Sign in
            <ArrowRight className="size-4" aria-hidden="true" />
          </a>
        </nav>
      )}
    </header>
  );
}

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-[#f7faf9] text-slate-950">
      <a
        href="#landing-main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-slate-950"
      >
        Skip to content
      </a>

      <section className="landing-hero text-white">
        <LandingNav />
        <div className="relative z-10 mx-auto flex min-h-[calc(100svh-9.5rem)] max-w-7xl items-end px-5 pb-12 pt-16 sm:px-8 sm:pb-16 lg:px-10 lg:pb-20">
          <div className="max-w-4xl">
            <div className="mb-6 inline-flex items-center gap-2 border-l-2 border-lime-300 pl-3 text-sm font-semibold text-lime-200">
              <ShieldCheck className="size-4" aria-hidden="true" />
              Built for Nigeria's next era of digital compliance
            </div>
            <h1 className="landing-display text-6xl font-extrabold leading-[0.95] text-white sm:text-7xl lg:text-8xl">
              MeridianIQ
            </h1>
            <p className="landing-display mt-5 max-w-3xl text-3xl font-semibold leading-tight text-white sm:text-4xl lg:text-5xl">
              Compliance that keeps cash moving.
            </p>
            <p className="mt-6 max-w-2xl text-base leading-7 text-white/75 sm:text-lg">
              One connected platform for Nigerian e-invoicing, audit-ready
              evidence and verified receivables. Stay compliant, see risk
              sooner and turn trusted invoices into stronger working capital.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <a
                href="/login"
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md bg-lime-300 px-5 text-sm font-extrabold text-[#071a1c] transition-colors hover:bg-lime-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#071a1c]"
                data-testid="link-hero-login"
              >
                Sign in to MeridianIQ
                <ArrowRight className="size-4" aria-hidden="true" />
              </a>
              <a
                href="#platform"
                className="inline-flex min-h-12 items-center justify-center rounded-md border border-white/30 px-5 text-sm font-bold text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300"
              >
                Explore the platform
              </a>
            </div>

            <div className="mt-9 flex flex-wrap gap-x-6 gap-y-3 text-sm text-white/70">
              {["Role-based access", "Traceable evidence", "One data spine"].map(
                (item) => (
                  <span key={item} className="inline-flex items-center gap-2">
                    <Check className="size-4 text-lime-300" aria-hidden="true" />
                    {item}
                  </span>
                ),
              )}
            </div>
          </div>
        </div>
      </section>

      <main id="landing-main" tabIndex={-1} className="focus:outline-none">
        <section className="bg-lime-300" aria-label="Platform highlights">
          <div className="mx-auto grid max-w-7xl divide-y divide-[#071a1c]/20 px-5 sm:grid-cols-3 sm:divide-x sm:divide-y-0 sm:px-8 lg:px-10">
            {[
              ["One record", "From invoice creation to audit evidence"],
              ["Four workspaces", "For SMEs, accountants, buyers and operators"],
              ["One clear view", "Of deadlines, exceptions and receivables"],
            ].map(([title, body]) => (
              <div key={title} className="py-5 sm:px-6 sm:first:pl-0">
                <p className="text-sm font-extrabold text-[#071a1c]">{title}</p>
                <p className="mt-1 text-sm leading-5 text-[#173536]">{body}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="platform" className="scroll-mt-10 py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-5 sm:px-8 lg:px-10">
            <div className="grid gap-12 lg:grid-cols-[0.8fr_1.2fr] lg:gap-20">
              <div>
                <p className="text-sm font-extrabold uppercase text-teal-700">
                  One connected platform
                </p>
                <h2 className="landing-display mt-4 max-w-lg text-4xl font-bold leading-tight text-slate-950 sm:text-5xl">
                  Every invoice tells the whole story.
                </h2>
                <p className="mt-5 max-w-lg text-base leading-7 text-slate-600">
                  MeridianIQ connects compliance work, transaction evidence and
                  receivables intelligence so teams can act from the same trusted
                  record.
                </p>
              </div>

              <div className="grid gap-x-10 gap-y-9 sm:grid-cols-2">
                {PLATFORM_FEATURES.map((feature) => {
                  const Icon = feature.icon;
                  return (
                    <article
                      key={feature.title}
                      className="border-t border-slate-300 pt-5"
                    >
                      <span
                        className={`grid size-11 place-items-center rounded-md ${feature.tone}`}
                      >
                        <Icon className="size-5" aria-hidden="true" />
                      </span>
                      <h3 className="mt-5 text-lg font-extrabold text-slate-950">
                        {feature.title}
                      </h3>
                      <p className="mt-2 text-sm leading-6 text-slate-600">
                        {feature.body}
                      </p>
                    </article>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        <section className="bg-[#0a2224] py-20 text-white sm:py-24">
          <div className="mx-auto grid max-w-7xl items-center gap-12 px-5 sm:px-8 lg:grid-cols-[0.72fr_1.28fr] lg:gap-16 lg:px-10">
            <div>
              <p className="text-sm font-extrabold uppercase text-lime-300">
                Designed for the work
              </p>
              <h2 className="landing-display mt-4 text-4xl font-bold leading-tight sm:text-5xl">
                Clarity at every handoff.
              </h2>
              <p className="mt-5 text-base leading-7 text-white/70">
                Open the workspace that matches your role while MeridianIQ keeps
                the evidence, permissions and transaction history connected
                behind the scenes.
              </p>
              <ul className="mt-7 space-y-4 text-sm text-white/80">
                {[
                  "One secure sign-in across every workspace",
                  "Role-aware tools without duplicated records",
                  "A public penalty calculator for early risk visibility",
                ].map((item) => (
                  <li key={item} className="flex items-start gap-3">
                    <Check
                      className="mt-0.5 size-4 shrink-0 text-lime-300"
                      aria-hidden="true"
                    />
                    {item}
                  </li>
                ))}
              </ul>
              <a
                href="/login"
                className="mt-8 inline-flex items-center gap-2 text-sm font-extrabold text-lime-300 transition-colors hover:text-lime-200"
              >
                Open your workspace
                <ArrowRight className="size-4" aria-hidden="true" />
              </a>
            </div>

            <figure className="overflow-hidden rounded-md border border-white/15 bg-white shadow-2xl shadow-black/30">
              <div className="flex h-10 items-center gap-2 border-b border-slate-200 bg-slate-100 px-4">
                <span className="size-2.5 rounded-full bg-rose-400" />
                <span className="size-2.5 rounded-full bg-amber-400" />
                <span className="size-2.5 rounded-full bg-emerald-400" />
                <span className="ml-3 text-xs font-medium text-slate-500">
                  app.meridianiq.com
                </span>
              </div>
              <img
                src="/opengraph.jpg"
                alt="MeridianIQ workspace portal showing compliance, accountant, buyer and penalty tools"
                className="block aspect-[3/2] w-full object-cover object-top"
              />
            </figure>
          </div>
        </section>

        <section id="workflow" className="scroll-mt-10 py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-5 sm:px-8 lg:px-10">
            <div className="max-w-3xl">
              <p className="text-sm font-extrabold uppercase text-teal-700">
                From invoice to insight
              </p>
              <h2 className="landing-display mt-4 text-4xl font-bold leading-tight sm:text-5xl">
                A cleaner path through compliance.
              </h2>
            </div>
            <div className="mt-12 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
              {WORKFLOW.map((step) => {
                const Icon = step.icon;
                return (
                  <article key={step.number} className="border-t-2 border-slate-950 pt-5">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-extrabold text-teal-700">
                        {step.number}
                      </span>
                      <Icon className="size-5 text-slate-500" aria-hidden="true" />
                    </div>
                    <h3 className="mt-8 text-xl font-extrabold">{step.title}</h3>
                    <p className="mt-2 text-sm leading-6 text-slate-600">{step.body}</p>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        <section id="workspaces" className="scroll-mt-10 bg-[#e8efed] py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-5 sm:px-8 lg:px-10">
            <div className="flex flex-col justify-between gap-5 md:flex-row md:items-end">
              <div className="max-w-3xl">
                <p className="text-sm font-extrabold uppercase text-teal-700">
                  Built around each role
                </p>
                <h2 className="landing-display mt-4 text-4xl font-bold leading-tight sm:text-5xl">
                  The right workspace, backed by the same truth.
                </h2>
              </div>
              <a
                href="/login"
                className="inline-flex items-center gap-2 self-start text-sm font-extrabold text-teal-800 hover:text-teal-950 md:self-auto"
              >
                View all workspaces
                <ArrowRight className="size-4" aria-hidden="true" />
              </a>
            </div>

            <div className="mt-12 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
              {WORKSPACES.map((workspace) => {
                const Icon = workspace.icon;
                const content = (
                  <>
                    <span className={`block h-1 w-12 ${workspace.line}`} />
                    <Icon
                      className={`mt-8 size-7 ${workspace.accent}`}
                      aria-hidden="true"
                    />
                    <h3 className="mt-7 text-xl font-extrabold text-slate-950">
                      {workspace.title}
                    </h3>
                    <p className="mt-3 text-sm leading-6 text-slate-600">
                      {workspace.body}
                    </p>
                    <span className="mt-8 inline-flex items-center gap-2 text-sm font-bold text-slate-950">
                      {workspace.href ? "Open calculator" : "Available after sign-in"}
                      {workspace.href ? (
                        <ArrowRight className="size-4" aria-hidden="true" />
                      ) : (
                        <LockKeyhole className="size-4 text-slate-400" aria-hidden="true" />
                      )}
                    </span>
                  </>
                );

                return workspace.href ? (
                  <a
                    key={workspace.title}
                    href={workspace.href}
                    className="flex min-h-[21rem] flex-col rounded-md border border-slate-200 bg-white p-6 shadow-sm transition-transform hover:-translate-y-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700"
                  >
                    {content}
                  </a>
                ) : (
                  <article
                    key={workspace.title}
                    className="flex min-h-[21rem] flex-col rounded-md border border-slate-200 bg-white p-6 shadow-sm"
                  >
                    {content}
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        <section className="bg-lime-300 py-16 sm:py-20">
          <div className="mx-auto flex max-w-7xl flex-col justify-between gap-8 px-5 sm:px-8 lg:flex-row lg:items-center lg:px-10">
            <div className="max-w-3xl">
              <p className="text-sm font-extrabold uppercase text-[#1c4443]">
                Your workspace is ready
              </p>
              <h2 className="landing-display mt-3 text-4xl font-bold leading-tight text-[#071a1c] sm:text-5xl">
                Make every compliant invoice work harder.
              </h2>
            </div>
            <a
              href="/login"
              className="inline-flex min-h-12 shrink-0 items-center justify-center gap-2 self-start rounded-md bg-[#071a1c] px-6 text-sm font-extrabold text-white transition-colors hover:bg-[#12383a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#071a1c] focus-visible:ring-offset-2 focus-visible:ring-offset-lime-300 lg:self-auto"
              data-testid="link-cta-login"
            >
              Sign in
              <ArrowRight className="size-4" aria-hidden="true" />
            </a>
          </div>
        </section>
      </main>

      <footer className="bg-[#071a1c] py-10 text-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-8 px-5 sm:px-8 md:flex-row md:items-end md:justify-between lg:px-10">
          <div>
            <BrandLockup inverted />
            <p className="mt-5 max-w-sm text-sm leading-6 text-white/60">
              Nigerian e-invoicing compliance and verified receivables, built
              around the people who keep business moving.
            </p>
          </div>
          <nav className="flex flex-wrap gap-x-6 gap-y-3 text-sm text-white/70" aria-label="Footer">
            <a className="hover:text-white" href="#platform">
              Platform
            </a>
            <a className="hover:text-white" href="/penalty-calculator/">
              Penalty calculator
            </a>
            <a className="font-bold text-lime-300 hover:text-lime-200" href="/login">
              Sign in
            </a>
          </nav>
        </div>
        <div className="mx-auto mt-9 max-w-7xl border-t border-white/10 px-5 pt-6 text-xs text-white/45 sm:px-8 lg:px-10">
          MeridianIQ, Lagos, Nigeria.
        </div>
      </footer>
    </div>
  );
}
