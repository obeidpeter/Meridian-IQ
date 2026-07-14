import { useState, type KeyboardEvent, type ReactNode } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  BarChart3,
  Bot,
  Building2,
  Calculator,
  Check,
  CheckCircle2,
  Clock3,
  FileCheck2,
  FileStack,
  Gauge,
  Landmark,
  ListChecks,
  LockKeyhole,
  Menu,
  Mic2,
  ReceiptText,
  ScanLine,
  ShieldCheck,
  Sparkles,
  Store,
  X,
} from "lucide-react";

const PLATFORM_FEATURES = [
  {
    icon: Bot,
    title: "Catch the work at source",
    body: "MeridianIQ Clerk turns voice notes, scans and messages into structured cases that stay under human review.",
    tone: "bg-lime-100 text-lime-900",
  },
  {
    icon: FileCheck2,
    title: "Move compliance on reliable rails",
    body: "Validate, submit, retry and vault Nigerian e-invoices from one controlled workflow.",
    tone: "bg-teal-100 text-teal-800",
  },
  {
    icon: BadgeCheck,
    title: "Build evidence into the transaction",
    body: "Keep stamps, buyer decisions, consent and settlement evidence attached to the invoice record.",
    tone: "bg-blue-100 text-blue-800",
  },
  {
    icon: BarChart3,
    title: "See the risk and the cash",
    body: "Track deadlines, portfolio exceptions, receivables aging and reconciliation gaps before they compound.",
    tone: "bg-amber-100 text-amber-900",
  },
];

const WORKFLOW = [
  {
    number: "01",
    icon: ReceiptText,
    title: "Capture",
    body: "Create, import or brief Clerk by voice, document or message.",
  },
  {
    number: "02",
    icon: ScanLine,
    title: "Review",
    body: "Resolve field, party and policy issues before anything is submitted.",
  },
  {
    number: "03",
    icon: ShieldCheck,
    title: "Stamp",
    body: "Transmit with retry and failover, then preserve the IRN, CSID and artifact.",
  },
  {
    number: "04",
    icon: Landmark,
    title: "Settle",
    body: "Add buyer confirmation and bank evidence to a trusted receivable.",
  },
];

const WORKSPACES = [
  {
    icon: ReceiptText,
    audience: "For owners and finance teams",
    title: "SME Compliance",
    body: "Guided and recurring invoicing, bulk import, reconciliation, B2C clocks and deadline alerts.",
    accent: "text-teal-700",
    line: "bg-teal-600",
    href: "/login",
    cta: "Sign in to open",
  },
  {
    icon: Building2,
    audience: "For firms and operators",
    title: "Accountant Console",
    body: "Portfolio risk, receivables aging, firm invitations, Clerk operations and audit evidence.",
    accent: "text-indigo-700",
    line: "bg-indigo-600",
    href: "/login",
    cta: "Sign in to open",
  },
  {
    icon: Store,
    audience: "For buyer finance teams",
    title: "Buyer Rails",
    body: "Confirm supplier invoices, flag payments, protect input VAT and monitor supplier quality.",
    accent: "text-blue-700",
    line: "bg-blue-600",
    href: "/login",
    cta: "Sign in to open",
  },
  {
    icon: Calculator,
    audience: "Public, no account needed",
    title: "Penalty Calculator",
    body: "Estimate exposure under sections 103 and 104 before non-compliance disrupts the business.",
    accent: "text-amber-700",
    line: "bg-amber-500",
    href: "/penalty-calculator/",
    cta: "Open calculator",
  },
];

type ProductViewKey = "clerk" | "sme" | "firm" | "buyer";

const PRODUCT_VIEWS: Array<{
  key: ProductViewKey;
  label: string;
  eyebrow: string;
  title: string;
  body: string;
  bullets: string[];
}> = [
  {
    key: "clerk",
    label: "Clerk AI",
    eyebrow: "Governed AI intake",
    title: "Turn unstructured requests into review-ready work.",
    body: "Clerk captures what arrived, extracts the useful facts and shows the reviewer exactly what needs a decision. Every case keeps its source, status and correction history.",
    bullets: [
      "Voice, document and message intake",
      "Human approval before action",
      "Corrections feed measurable quality controls",
    ],
  },
  {
    key: "sme",
    label: "SME",
    eyebrow: "Compliance workspace",
    title: "Know what is ready, at risk and already evidenced.",
    body: "SME teams get a focused operating view for invoices, recurring work, submission deadlines and settlement evidence without needing to learn the underlying rail complexity.",
    bullets: [
      "Local validation and draft recovery",
      "Bulk import with row-level outcomes",
      "Deadline and B2C breach alerts",
    ],
  },
  {
    key: "firm",
    label: "Firm",
    eyebrow: "Accountant console",
    title: "Run the whole client book from one risk-ranked view.",
    body: "Firms can onboard teams, see receivables and compliance exposure across clients, resolve exceptions and export the evidence behind every decision.",
    bullets: [
      "Self-serve firm and client invitations",
      "Bulk submission and operator queues",
      "Portfolio receivables and risk rollups",
    ],
  },
  {
    key: "buyer",
    label: "Buyer",
    eyebrow: "Buyer Rails",
    title: "Verify supplier invoices before VAT exposure grows.",
    body: "Buyer finance teams can confirm, query or reject invoices, record payment signals and monitor supplier compliance from a dedicated workspace.",
    bullets: [
      "Formal confirmation decisions",
      "Supplier quality scoreboard",
      "Payment flags linked to the invoice history",
    ],
  },
];

const PLATFORM_FACTS = [
  ["5,000", "rows per bulk import"],
  ["2", "submission rails with failover"],
  ["3", "client-owned consent layers"],
  ["24h", "B2C deadline monitoring"],
];

function BrandLockup({ inverted = false }: { inverted?: boolean }) {
  return (
    <a
      href="/"
      className="inline-flex items-center gap-3 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#071a1c]"
      aria-label="MeridianIQ home"
    >
      <span
        className={
          "grid size-10 place-items-center rounded-md " +
          (inverted ? "bg-lime-300 text-[#071a1c]" : "bg-teal-700 text-white")
        }
      >
        <FileCheck2 className="size-5" aria-hidden="true" />
      </span>
      <span>
        <span
          className={
            "block text-base font-extrabold leading-none " +
            (inverted ? "text-white" : "text-slate-950")
          }
        >
          MeridianIQ
        </span>
        <span
          className={
            "mt-1 block text-xs " +
            (inverted ? "text-white/65" : "text-slate-500")
          }
        >
          Compliance intelligence
        </span>
      </span>
    </a>
  );
}

function LandingNav() {
  const [open, setOpen] = useState(false);
  const closeMenu = () => setOpen(false);
  const links = [
    ["Platform", "#platform"],
    ["Product tour", "#product-tour"],
    ["How it works", "#workflow"],
    ["Workspaces", "#workspaces"],
    ["Penalty calculator", "/penalty-calculator/"],
  ];

  return (
    <header className="relative z-20 border-b border-white/15">
      <div className="mx-auto flex h-[4.5rem] max-w-7xl items-center justify-between px-5 sm:px-8 lg:px-10">
        <BrandLockup inverted />

        <nav
          className="hidden items-center gap-6 text-sm font-medium text-white/75 lg:flex"
          aria-label="Main navigation"
        >
          {links.map(([label, href]) => (
            <a
              key={href}
              className="transition-colors hover:text-white"
              href={href}
            >
              {label}
            </a>
          ))}
        </nav>

        <div className="hidden lg:block">
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
          className="grid size-10 place-items-center rounded-md border border-white/20 text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300 lg:hidden"
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
          className="absolute left-4 right-4 top-[4.75rem] rounded-md border border-white/15 bg-[#0b2527] p-3 shadow-2xl lg:hidden"
          aria-label="Mobile navigation"
        >
          {links.map(([label, href]) => (
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

function PreviewFrame({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <figure className="overflow-hidden rounded-md border border-slate-300 bg-white shadow-[0_24px_70px_rgba(15,23,42,0.16)]">
      <div className="flex h-11 items-center gap-2 border-b border-slate-200 bg-slate-100 px-4">
        <span className="size-2.5 rounded-full bg-rose-400" />
        <span className="size-2.5 rounded-full bg-amber-400" />
        <span className="size-2.5 rounded-full bg-emerald-400" />
        <span className="ml-3 truncate text-xs font-semibold text-slate-500">
          app.meridianiq.com
        </span>
        <span className="ml-auto hidden items-center gap-1.5 text-xs font-semibold text-teal-700 sm:inline-flex">
          <span className="size-1.5 rounded-full bg-teal-500" />
          Connected
        </span>
      </div>
      <div className="landing-preview-body">{children}</div>
      <figcaption className="sr-only">{label}</figcaption>
    </figure>
  );
}

function ClerkPreview() {
  return (
    <PreviewFrame label="MeridianIQ Clerk intake and review workspace">
      <div className="grid h-full bg-[#f4f7f6] sm:grid-cols-[10.5rem_minmax(0,1fr)]">
        <aside className="hidden border-r border-slate-200 bg-[#0a2425] p-4 text-white sm:flex sm:flex-col">
          <div className="flex items-center gap-2 text-sm font-extrabold">
            <Sparkles className="size-4 text-lime-300" aria-hidden="true" />
            Clerk
          </div>
          <nav className="mt-7 space-y-1 text-xs font-semibold text-white/60">
            <span className="flex items-center gap-2 rounded-sm bg-white/10 px-3 py-2.5 text-white">
              <ListChecks className="size-3.5" aria-hidden="true" />
              Intake queue
            </span>
            <span className="flex items-center gap-2 px-3 py-2.5">
              <FileStack className="size-3.5" aria-hidden="true" />
              Claims
            </span>
            <span className="flex items-center gap-2 px-3 py-2.5">
              <Gauge className="size-3.5" aria-hidden="true" />
              Health
            </span>
          </nav>
          <div className="mt-auto border-t border-white/10 pt-4 text-[11px] leading-5 text-white/50">
            Human review is required before a case changes a record.
          </div>
        </aside>

        <div className="min-w-0 overflow-hidden p-4 sm:p-5">
          <header className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-extrabold uppercase text-teal-700">
                Intake and review
              </p>
              <h3 className="mt-1 text-lg font-extrabold text-slate-950">
                Good morning, Tola
              </h3>
            </div>
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[10px] font-bold text-emerald-800">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              Guardrails on
            </span>
          </header>

          <div className="mt-4 grid gap-3 lg:grid-cols-[0.82fr_1.18fr]">
            <section className="hidden rounded-md border border-slate-200 bg-white p-3.5 lg:block">
              <div className="flex items-center justify-between">
                <p className="text-xs font-extrabold text-slate-900">
                  New intake
                </p>
                <span className="text-[10px] font-bold text-slate-400">
                  3 open
                </span>
              </div>
              <div className="mt-3 space-y-2">
                {[
                  {
                    kind: "Voice note",
                    detail: "Create July invoice",
                    Icon: Mic2,
                    status: "Review",
                  },
                  {
                    kind: "Invoice scan",
                    detail: "INV-2027-041",
                    Icon: ScanLine,
                    status: "Extracted",
                  },
                  {
                    kind: "Message",
                    detail: "Correct buyer TIN",
                    Icon: Bot,
                    status: "Needs input",
                  },
                ].map(({ kind, detail, Icon, status }) => (
                  <div
                    key={String(detail)}
                    className="rounded-sm border border-slate-200 p-2.5"
                  >
                    <div className="flex items-start gap-2.5">
                      <span className="grid size-7 shrink-0 place-items-center rounded-sm bg-teal-50 text-teal-700">
                        <Icon className="size-3.5" aria-hidden="true" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-[10px] font-bold text-slate-400">
                          {kind}
                        </p>
                        <p className="truncate text-xs font-bold text-slate-800">
                          {detail}
                        </p>
                      </div>
                    </div>
                    <p className="mt-2 text-[10px] font-bold text-teal-700">
                      {status}
                    </p>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-md border border-slate-200 bg-white p-3.5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] font-bold text-slate-400">
                    VOICE INTAKE
                  </p>
                  <p className="mt-1 text-sm font-extrabold text-slate-900">
                    Create customer invoice
                  </p>
                </div>
                <span className="rounded-full bg-amber-100 px-2 py-1 text-[10px] font-bold text-amber-900">
                  Review
                </span>
              </div>

              <div className="mt-3 rounded-sm border border-slate-200 bg-slate-50 p-3">
                <div className="flex items-center gap-2 text-[11px] font-semibold text-slate-600">
                  <span className="grid size-7 place-items-center rounded-full bg-[#0f7773] text-white">
                    <Mic2 className="size-3.5" aria-hidden="true" />
                  </span>
                  00:18 voice note
                  <span className="ml-auto text-slate-400">Today, 09:42</span>
                </div>
                <p className="mt-2 text-[11px] leading-5 text-slate-600">
                  Invoice Northstar Retail for the July delivery. Use the agreed
                  unit rate and thirty-day terms.
                </p>
              </div>

              <div className="mt-3 space-y-2">
                {[
                  ["Customer", "Northstar Retail Ltd"],
                  ["Invoice", "INV-2027-041"],
                  ["Terms", "Net 30"],
                  ["Total", "NGN 428,750"],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="flex items-center justify-between gap-4 border-b border-slate-100 pb-2 text-[11px]"
                  >
                    <span className="text-slate-500">{label}</span>
                    <span className="truncate font-bold text-slate-900">
                      {value}
                    </span>
                  </div>
                ))}
              </div>

              <div className="mt-3 flex items-center justify-between gap-3">
                <p className="inline-flex items-center gap-1.5 text-[10px] font-bold text-emerald-700">
                  <CheckCircle2 className="size-3.5" aria-hidden="true" />4
                  fields verified
                </p>
                <span className="rounded-sm bg-[#0a2425] px-3 py-2 text-[10px] font-bold text-white">
                  Review draft
                </span>
              </div>
            </section>
          </div>
        </div>
      </div>
    </PreviewFrame>
  );
}

function SmePreview() {
  return (
    <PreviewFrame label="MeridianIQ SME Compliance dashboard">
      <div className="flex h-full items-center justify-center bg-white">
        <img
          src="/compliance-dashboard.jpg"
          alt="MeridianIQ Compliance dashboard showing invoice status, activity and the next filing deadline"
          className="h-full w-full object-contain object-top"
        />
      </div>
    </PreviewFrame>
  );
}

function FirmPreview() {
  const rows = [
    ["Adaeze Foods", "High", "NGN 4.8m", "3 overdue"],
    ["Northstar Retail", "Medium", "NGN 2.2m", "1 exception"],
    ["Cedar Works", "Low", "NGN 1.7m", "On track"],
  ];

  return (
    <PreviewFrame label="MeridianIQ accountant portfolio view">
      <div className="grid h-full bg-[#f4f7f6] sm:grid-cols-[10.5rem_minmax(0,1fr)]">
        <aside className="hidden border-r border-slate-200 bg-white p-4 sm:block">
          <p className="text-sm font-extrabold text-teal-800">MeridianIQ</p>
          <nav className="mt-7 space-y-1 text-xs font-semibold text-slate-500">
            {["Portfolio", "Clients", "Clerk", "Receivables", "Audit"].map(
              (item, index) => (
                <span
                  key={item}
                  className={
                    "block rounded-sm px-3 py-2.5 " +
                    (index === 0 ? "bg-teal-50 text-teal-800" : "")
                  }
                >
                  {item}
                </span>
              ),
            )}
          </nav>
        </aside>
        <div className="min-w-0 overflow-hidden p-4 sm:p-5">
          <header className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[10px] font-bold uppercase text-slate-400">
                Demo portfolio
              </p>
              <h3 className="mt-1 text-lg font-extrabold text-slate-950">
                Client risk and receivables
              </h3>
            </div>
            <span className="rounded-sm bg-[#0f7773] px-3 py-2 text-[10px] font-bold text-white">
              Invite client
            </span>
          </header>

          <div className="mt-4 grid grid-cols-3 gap-2">
            {[
              ["24", "Active clients"],
              ["3", "High risk"],
              ["NGN 18.4m", "Open receivables"],
            ].map(([value, label]) => (
              <div
                key={label}
                className="rounded-sm border border-slate-200 bg-white p-3"
              >
                <p className="text-sm font-extrabold text-slate-950 sm:text-base">
                  {value}
                </p>
                <p className="mt-1 text-[9px] font-semibold leading-4 text-slate-500 sm:text-[10px]">
                  {label}
                </p>
              </div>
            ))}
          </div>

          <section className="mt-3 overflow-hidden rounded-md border border-slate-200 bg-white">
            <div className="grid grid-cols-[1.2fr_0.7fr_0.9fr] gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 text-[9px] font-extrabold uppercase text-slate-400 sm:grid-cols-[1.3fr_0.7fr_0.9fr_0.9fr]">
              <span>Client</span>
              <span>Risk</span>
              <span>Receivables</span>
              <span className="hidden sm:block">Next action</span>
            </div>
            {rows.map(([client, risk, amount, action]) => (
              <div
                key={client}
                className="grid grid-cols-[1.2fr_0.7fr_0.9fr] items-center gap-2 border-b border-slate-100 px-3 py-3 text-[10px] last:border-0 sm:grid-cols-[1.3fr_0.7fr_0.9fr_0.9fr]"
              >
                <span className="truncate font-bold text-slate-900">
                  {client}
                </span>
                <span
                  className={
                    "font-bold " +
                    (risk === "High"
                      ? "text-rose-700"
                      : risk === "Medium"
                        ? "text-amber-700"
                        : "text-emerald-700")
                  }
                >
                  {risk}
                </span>
                <span className="font-semibold text-slate-700">{amount}</span>
                <span className="hidden truncate text-slate-500 sm:block">
                  {action}
                </span>
              </div>
            ))}
          </section>

          <div className="mt-3 flex items-center justify-between text-[10px]">
            <span className="font-semibold text-slate-500">
              12 drafts ready for review
            </span>
            <span className="font-extrabold text-teal-700">Open portfolio</span>
          </div>
        </div>
      </div>
    </PreviewFrame>
  );
}

function BuyerPreview() {
  return (
    <PreviewFrame label="MeridianIQ Buyer Rails verification queue">
      <div className="h-full bg-[#f4f7f6] p-4 sm:p-6">
        <header className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-extrabold uppercase text-blue-700">
              Buyer Rails
            </p>
            <h3 className="mt-1 text-lg font-extrabold text-slate-950">
              Supplier invoice queue
            </h3>
            <p className="mt-1 text-[11px] text-slate-500">
              Verify the invoice before it enters the payment run.
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[10px] font-bold text-amber-900">
            <Clock3 className="size-3" aria-hidden="true" />4 pending
          </span>
        </header>

        <div className="mt-5 grid gap-3 lg:grid-cols-[1fr_0.72fr]">
          <section className="overflow-hidden rounded-md border border-slate-200 bg-white">
            <div className="grid grid-cols-[1.2fr_0.8fr_0.7fr] gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 text-[9px] font-extrabold uppercase text-slate-400">
              <span>Supplier</span>
              <span>Invoice</span>
              <span>Status</span>
            </div>
            {[
              ["Adaeze Foods", "INV-1005", "Ready"],
              ["Cedar Works", "INV-2041", "Query"],
              ["Kora Logistics", "INV-8730", "Ready"],
              ["Luma Energy", "INV-3218", "Checked"],
            ].map(([supplier, invoice, status]) => (
              <div
                key={invoice}
                className="grid grid-cols-[1.2fr_0.8fr_0.7fr] items-center gap-2 border-b border-slate-100 px-3 py-3 text-[10px] last:border-0"
              >
                <span className="truncate font-bold text-slate-900">
                  {supplier}
                </span>
                <span className="text-slate-500">{invoice}</span>
                <span
                  className={
                    "font-bold " +
                    (status === "Query"
                      ? "text-amber-700"
                      : status === "Checked"
                        ? "text-emerald-700"
                        : "text-blue-700")
                  }
                >
                  {status}
                </span>
              </div>
            ))}
          </section>

          <section className="hidden rounded-md border border-slate-200 bg-white p-4 lg:block">
            <p className="text-[10px] font-bold text-slate-400">
              SELECTED INVOICE
            </p>
            <p className="mt-1 text-sm font-extrabold text-slate-900">
              INV-1005
            </p>
            <div className="mt-4 space-y-2.5 text-[10px]">
              {[
                ["FIRS stamp", "Verified"],
                ["Supplier TIN", "Matched"],
                ["Amount", "NGN 1,290,000"],
                ["No set-off", "Requested"],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="flex justify-between gap-3 border-b border-slate-100 pb-2"
                >
                  <span className="text-slate-500">{label}</span>
                  <span className="font-bold text-slate-800">{value}</span>
                </div>
              ))}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 text-center text-[10px] font-bold">
              <span className="rounded-sm border border-slate-300 px-2 py-2 text-slate-700">
                Query
              </span>
              <span className="rounded-sm bg-blue-700 px-2 py-2 text-white">
                Confirm
              </span>
            </div>
          </section>
        </div>
      </div>
    </PreviewFrame>
  );
}

function ProductPreview({ active }: { active: ProductViewKey }) {
  return (
    <div key={active} className="landing-preview-enter" aria-live="polite">
      {active === "clerk" && <ClerkPreview />}
      {active === "sme" && <SmePreview />}
      {active === "firm" && <FirmPreview />}
      {active === "buyer" && <BuyerPreview />}
    </div>
  );
}

function ProductTour() {
  const [activeView, setActiveView] = useState<ProductViewKey>("clerk");
  const active =
    PRODUCT_VIEWS.find((view) => view.key === activeView) ?? PRODUCT_VIEWS[0];

  function handleTabKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) {
    let nextIndex = currentIndex;

    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % PRODUCT_VIEWS.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex =
        (currentIndex - 1 + PRODUCT_VIEWS.length) % PRODUCT_VIEWS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = PRODUCT_VIEWS.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    const nextView = PRODUCT_VIEWS[nextIndex];
    setActiveView(nextView.key);
    document.getElementById("product-tab-" + nextView.key)?.focus();
  }

  return (
    <section
      id="product-tour"
      className="scroll-mt-20 bg-[#eef3f1] py-20 sm:py-24"
    >
      <div className="mx-auto max-w-7xl px-5 sm:px-8 lg:px-10">
        <div className="max-w-3xl">
          <p className="text-sm font-extrabold uppercase text-teal-700">
            Product tour
          </p>
          <h2 className="landing-display mt-4 text-4xl font-bold leading-tight text-slate-950 sm:text-5xl">
            One platform, tuned to the decision in front of you.
          </h2>
          <p className="mt-5 max-w-2xl text-base leading-7 text-slate-600">
            Move between intake, compliance, portfolio oversight and buyer
            verification without rebuilding the invoice history at each handoff.
          </p>
        </div>

        <div className="mt-12 grid items-start gap-10 lg:grid-cols-[0.72fr_1.28fr] lg:gap-14">
          <div>
            <div
              className="grid grid-cols-2 gap-1 rounded-md border border-slate-300 bg-white p-1"
              role="tablist"
              aria-label="Product views"
            >
              {PRODUCT_VIEWS.map((view, index) => {
                const selected = activeView === view.key;
                return (
                  <button
                    key={view.key}
                    id={"product-tab-" + view.key}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-controls="product-tour-panel"
                    tabIndex={selected ? 0 : -1}
                    onClick={() => setActiveView(view.key)}
                    onKeyDown={(event) => handleTabKeyDown(event, index)}
                    className={
                      "min-h-11 rounded-sm px-3 text-sm font-extrabold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 " +
                      (selected
                        ? "bg-[#0a2425] text-white"
                        : "text-slate-600 hover:bg-slate-100 hover:text-slate-950")
                    }
                  >
                    {view.label}
                  </button>
                );
              })}
            </div>

            <div
              id="product-tour-panel"
              role="tabpanel"
              aria-labelledby={"product-tab-" + active.key}
              className="mt-9"
            >
              <p className="text-xs font-extrabold uppercase text-teal-700">
                {active.eyebrow}
              </p>
              <h3 className="landing-display mt-3 text-3xl font-bold leading-tight text-slate-950">
                {active.title}
              </h3>
              <p className="mt-4 text-sm leading-7 text-slate-600">
                {active.body}
              </p>
              <ul className="mt-6 space-y-3 text-sm font-semibold text-slate-800">
                {active.bullets.map((bullet) => (
                  <li key={bullet} className="flex items-start gap-3">
                    <Check
                      className="mt-0.5 size-4 shrink-0 text-teal-700"
                      aria-hidden="true"
                    />
                    {bullet}
                  </li>
                ))}
              </ul>
              <a
                href="/login"
                className="mt-8 inline-flex items-center gap-2 text-sm font-extrabold text-teal-800 transition-colors hover:text-teal-950"
              >
                Open your workspace
                <ArrowRight className="size-4" aria-hidden="true" />
              </a>
            </div>
          </div>

          <ProductPreview active={activeView} />
        </div>
      </div>
    </section>
  );
}

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-[#f8faf9] text-slate-950">
      <a
        href="#landing-main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-slate-950"
      >
        Skip to content
      </a>

      <section className="landing-hero text-white">
        <LandingNav />
        <div className="relative z-10 mx-auto flex min-h-[calc(100svh-10rem)] max-w-7xl items-end px-5 pb-12 pt-14 sm:px-8 sm:pb-16 sm:pt-20 lg:px-10 lg:pb-20">
          <div className="max-w-4xl">
            <div className="mb-6 inline-flex items-center gap-2 border-l-2 border-lime-300 pl-3 text-sm font-semibold text-lime-200">
              <ShieldCheck className="size-4" aria-hidden="true" />
              Nigerian e-invoicing, built around evidence
            </div>
            <h1 className="landing-display text-5xl font-extrabold leading-none text-white sm:text-7xl lg:text-8xl">
              MeridianIQ
            </h1>
            <p className="landing-display mt-5 max-w-3xl text-3xl font-semibold leading-tight text-white sm:text-4xl lg:text-5xl">
              Turn every invoice into evidence.
            </p>
            <p className="mt-6 max-w-2xl text-base leading-7 text-white/80 sm:text-lg">
              Capture the work with Clerk, move invoices through Nigerian
              compliance rails and keep the proof buyers, auditors and finance
              teams need on one trusted record.
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
                href="#product-tour"
                className="inline-flex min-h-12 items-center justify-center rounded-md border border-white/35 bg-[#071a1c]/30 px-5 text-sm font-bold text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300"
              >
                See the product
              </a>
            </div>

            <div className="mt-9 flex flex-wrap gap-x-6 gap-y-3 text-sm text-white/75">
              {[
                "AI-assisted, human-controlled",
                "Role and tenant aware",
                "Traceable from intake to settlement",
              ].map((item) => (
                <span key={item} className="inline-flex items-center gap-2">
                  <Check className="size-4 text-lime-300" aria-hidden="true" />
                  {item}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      <main id="landing-main" tabIndex={-1} className="focus:outline-none">
        <section className="bg-lime-300" aria-label="Platform facts">
          <dl className="mx-auto grid max-w-7xl grid-cols-2 px-5 sm:px-8 lg:grid-cols-4 lg:px-10">
            {PLATFORM_FACTS.map(([value, label]) => (
              <div
                key={label}
                className="border-b border-[#071a1c]/20 py-5 odd:pr-4 even:border-l even:pl-4 lg:border-b-0 lg:border-l lg:px-6 lg:first:border-l-0 lg:first:pl-0"
              >
                <dt className="text-xs font-bold leading-5 text-[#244746]">
                  {label}
                </dt>
                <dd className="landing-display mt-1 text-2xl font-extrabold text-[#071a1c]">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section id="platform" className="scroll-mt-20 py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-5 sm:px-8 lg:px-10">
            <div className="grid gap-12 lg:grid-cols-[0.8fr_1.2fr] lg:gap-20">
              <div>
                <p className="text-sm font-extrabold uppercase text-teal-700">
                  One connected platform
                </p>
                <h2 className="landing-display mt-4 max-w-lg text-4xl font-bold leading-tight text-slate-950 sm:text-5xl">
                  Less chasing. More controlled movement.
                </h2>
                <p className="mt-5 max-w-lg text-base leading-7 text-slate-600">
                  MeridianIQ connects AI intake, compliance operations and
                  receivables evidence so every team acts from the same invoice
                  history.
                </p>
                <a
                  href="#product-tour"
                  className="mt-7 inline-flex items-center gap-2 text-sm font-extrabold text-teal-800 hover:text-teal-950"
                >
                  Explore each role
                  <ArrowRight className="size-4" aria-hidden="true" />
                </a>
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
                        className={
                          "grid size-11 place-items-center rounded-md " +
                          feature.tone
                        }
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

        <ProductTour />

        <section id="workflow" className="scroll-mt-20 bg-white py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-5 sm:px-8 lg:px-10">
            <div className="flex flex-col justify-between gap-6 md:flex-row md:items-end">
              <div className="max-w-3xl">
                <p className="text-sm font-extrabold uppercase text-teal-700">
                  From intake to settlement
                </p>
                <h2 className="landing-display mt-4 text-4xl font-bold leading-tight sm:text-5xl">
                  One invoice. One continuous history.
                </h2>
              </div>
              <p className="max-w-md text-sm leading-6 text-slate-600">
                Each step adds evidence instead of replacing what came before,
                so the transaction stays understandable after every handoff.
              </p>
            </div>

            <div className="mt-12 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
              {WORKFLOW.map((step) => {
                const Icon = step.icon;
                return (
                  <article
                    key={step.number}
                    className="relative border-t-2 border-slate-950 pt-5"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-extrabold text-teal-700">
                        {step.number}
                      </span>
                      <Icon
                        className="size-5 text-slate-500"
                        aria-hidden="true"
                      />
                    </div>
                    <h3 className="mt-8 text-xl font-extrabold">
                      {step.title}
                    </h3>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                      {step.body}
                    </p>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        <section
          id="evidence"
          className="scroll-mt-20 bg-[#071a1c] py-20 text-white sm:py-24"
        >
          <div className="mx-auto grid max-w-7xl items-center gap-14 px-5 sm:px-8 lg:grid-cols-[0.9fr_1.1fr] lg:px-10">
            <div>
              <p className="text-sm font-extrabold uppercase text-lime-300">
                Evidence by design
              </p>
              <h2 className="landing-display mt-4 text-4xl font-bold leading-tight sm:text-5xl">
                Compliance is only useful if the proof survives.
              </h2>
              <p className="mt-5 max-w-xl text-base leading-7 text-white/70">
                MeridianIQ keeps decisions attached to the transaction, limits
                access by role and tenant, and makes the audit trail
                independently verifiable.
              </p>

              <div className="mt-8 grid gap-x-8 gap-y-5 sm:grid-cols-2">
                {[
                  [
                    "Tenant boundaries",
                    "Data access is scoped at the request and database layers.",
                  ],
                  [
                    "Append-only history",
                    "Submitted invoice records preserve every later adjustment.",
                  ],
                  [
                    "Hash-chained audit",
                    "Audit bundles can be exported and verified outside the app.",
                  ],
                  [
                    "Client-owned consent",
                    "Clients grant and revoke each data-use layer themselves.",
                  ],
                ].map(([title, body]) => (
                  <div key={title} className="border-t border-white/15 pt-4">
                    <p className="inline-flex items-center gap-2 text-sm font-extrabold text-white">
                      <ShieldCheck
                        className="size-4 text-lime-300"
                        aria-hidden="true"
                      />
                      {title}
                    </p>
                    <p className="mt-2 text-xs leading-5 text-white/60">
                      {body}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-md border border-white/15 bg-white/[0.04] p-5 sm:p-7">
              <div className="flex items-center justify-between gap-4 border-b border-white/10 pb-5">
                <div>
                  <p className="text-xs font-extrabold uppercase text-lime-300">
                    Invoice evidence chain
                  </p>
                  <p className="mt-1 text-lg font-extrabold">INV-2027-041</p>
                </div>
                <span className="inline-flex items-center gap-2 rounded-full border border-emerald-300/30 bg-emerald-300/10 px-3 py-1.5 text-xs font-bold text-emerald-200">
                  <CheckCircle2 className="size-3.5" aria-hidden="true" />
                  Verified
                </span>
              </div>

              <ol className="mt-6 space-y-0">
                {[
                  {
                    title: "Captured",
                    body: "Voice note and original source retained",
                    Icon: Mic2,
                    time: "09:42",
                  },
                  {
                    title: "Reviewed",
                    body: "4 extracted fields approved by Tola",
                    Icon: ListChecks,
                    time: "09:47",
                  },
                  {
                    title: "Stamped",
                    body: "IRN and CSID written to the vault",
                    Icon: BadgeCheck,
                    time: "10:03",
                  },
                  {
                    title: "Confirmed",
                    body: "Buyer accepted amount and no set-off",
                    Icon: Store,
                    time: "14:26",
                  },
                  {
                    title: "Settled",
                    body: "Bank statement match accepted",
                    Icon: Landmark,
                    time: "Jul 29",
                  },
                ].map(({ title, body, Icon, time }, index) => (
                  <li
                    key={String(title)}
                    className="grid grid-cols-[2.25rem_minmax(0,1fr)_auto] gap-3"
                  >
                    <div className="flex flex-col items-center">
                      <span className="grid size-9 place-items-center rounded-full border border-lime-300/30 bg-lime-300/10 text-lime-300">
                        <Icon className="size-4" aria-hidden="true" />
                      </span>
                      {index < 4 && (
                        <span
                          className="h-8 w-px bg-white/15"
                          aria-hidden="true"
                        />
                      )}
                    </div>
                    <div className="pt-1">
                      <p className="text-sm font-extrabold">{title}</p>
                      <p className="mt-1 text-xs leading-5 text-white/55">
                        {body}
                      </p>
                    </div>
                    <time className="pt-1 text-[10px] font-bold text-white/40">
                      {time}
                    </time>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        <section
          id="workspaces"
          className="scroll-mt-20 bg-[#e7eeec] py-20 sm:py-24"
        >
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
                View the sign-in portal
                <ArrowRight className="size-4" aria-hidden="true" />
              </a>
            </div>

            <div className="mt-12 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
              {WORKSPACES.map((workspace) => {
                const Icon = workspace.icon;
                return (
                  <a
                    key={workspace.title}
                    href={workspace.href}
                    className="group flex min-h-[22rem] flex-col rounded-md border border-slate-200 bg-white p-6 shadow-sm transition-transform hover:-translate-y-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700"
                  >
                    <span className={"block h-1 w-12 " + workspace.line} />
                    <Icon
                      className={"mt-8 size-7 " + workspace.accent}
                      aria-hidden="true"
                    />
                    <p className="mt-6 text-xs font-bold uppercase text-slate-400">
                      {workspace.audience}
                    </p>
                    <h3 className="mt-2 text-xl font-extrabold text-slate-950">
                      {workspace.title}
                    </h3>
                    <p className="mt-3 text-sm leading-6 text-slate-600">
                      {workspace.body}
                    </p>
                    <span className="mt-auto inline-flex items-center gap-2 pt-8 text-sm font-bold text-slate-950">
                      {workspace.cta}
                      {workspace.href === "/login" ? (
                        <LockKeyhole
                          className="size-4 text-slate-400"
                          aria-hidden="true"
                        />
                      ) : (
                        <ArrowUpRight
                          className="size-4 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                          aria-hidden="true"
                        />
                      )}
                    </span>
                  </a>
                );
              })}
            </div>
          </div>
        </section>

        <section className="bg-lime-300 py-16 sm:py-20">
          <div className="mx-auto flex max-w-7xl flex-col justify-between gap-8 px-5 sm:px-8 lg:flex-row lg:items-center lg:px-10">
            <div className="max-w-3xl">
              <p className="text-sm font-extrabold uppercase text-[#1c4443]">
                Start where the work is
              </p>
              <h2 className="landing-display mt-3 text-4xl font-bold leading-tight text-[#071a1c] sm:text-5xl">
                Keep compliance moving. Keep the evidence attached.
              </h2>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row lg:shrink-0">
              <a
                href="/login"
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md bg-[#071a1c] px-6 text-sm font-extrabold text-white transition-colors hover:bg-[#12383a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#071a1c] focus-visible:ring-offset-2 focus-visible:ring-offset-lime-300"
                data-testid="link-cta-login"
              >
                Sign in
                <ArrowRight className="size-4" aria-hidden="true" />
              </a>
              <a
                href="/penalty-calculator/"
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md border border-[#071a1c]/30 px-5 text-sm font-extrabold text-[#071a1c] transition-colors hover:bg-[#071a1c]/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#071a1c]"
              >
                Estimate exposure
                <Calculator className="size-4" aria-hidden="true" />
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="bg-[#071a1c] py-10 text-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-8 px-5 sm:px-8 md:flex-row md:items-end md:justify-between lg:px-10">
          <div>
            <BrandLockup inverted />
            <p className="mt-5 max-w-sm text-sm leading-6 text-white/60">
              Nigerian e-invoicing, governed AI intake and verified receivables
              on one connected record.
            </p>
          </div>
          <nav
            className="flex flex-wrap gap-x-6 gap-y-3 text-sm text-white/70"
            aria-label="Footer"
          >
            <a className="hover:text-white" href="#platform">
              Platform
            </a>
            <a className="hover:text-white" href="#product-tour">
              Product tour
            </a>
            <a className="hover:text-white" href="#evidence">
              Evidence
            </a>
            <a className="hover:text-white" href="/penalty-calculator/">
              Penalty calculator
            </a>
            <a
              className="font-bold text-lime-300 hover:text-lime-200"
              href="/login"
            >
              Sign in
            </a>
          </nav>
        </div>
        <div className="mx-auto mt-9 flex max-w-7xl flex-col gap-2 border-t border-white/10 px-5 pt-6 text-xs text-white/45 sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-10">
          <span>MeridianIQ, Lagos, Nigeria.</span>
          <span>Compliance intelligence for the full invoice lifecycle.</span>
        </div>
      </footer>
    </div>
  );
}
