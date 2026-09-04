import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
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
  Compass,
  FileCheck2,
  FileStack,
  Gauge,
  Landmark,
  ListChecks,
  LockKeyhole,
  Mail,
  Menu,
  Mic2,
  ReceiptText,
  ScanLine,
  ShieldCheck,
  Sparkles,
  Store,
  X,
} from "lucide-react";
import {
  ADVISORY_EMAIL,
  CSID_EXPANSION,
  IRN_EXPANSION,
} from "@workspace/format";
import { trackUsabilityEvent } from "@workspace/web-ui";

// The one human-contact channel for prospects: the platform is invite-only,
// so every public surface needs a path that is not the sign-in wall. Same
// The inbox is shared by every public surface; deployment readiness tracks
// when its delivery path was last verified.
const CONTACT_MAILTO = `mailto:${ADVISORY_EMAIL}?subject=${encodeURIComponent(
  "MeridianIQ access request",
)}`;

const trackLandingCta = () => trackUsabilityEvent("landing_cta", "landing");

// Copy discipline (PL-02): claim as available only what the launch profile
// lights (the R0 core — invoicing lifecycle, engagements, consent, evidence).
// Launch-dark capabilities (Clerk AI, Buyer Rails, reconciliation, B2C
// clocks, recurring) are framed as rolling out, never as live today.
const PLATFORM_FEATURES = [
  {
    icon: FileCheck2,
    title: "Send invoices the right way",
    body: "We check each invoice against FIRS rules, submit it, retry if the connection drops, and save the stamped copy for you.",
    tone: "bg-teal-100 text-teal-800",
  },
  {
    icon: BadgeCheck,
    title: "Keep the proof attached",
    body: "The official stamp, the payment record and your sharing permissions stay attached to each invoice.",
    tone: "bg-blue-100 text-blue-800",
  },
  {
    icon: BarChart3,
    title: "See deadlines and money early",
    body: "Know what is due, what needs attention and who owes you — before it becomes a problem.",
    tone: "bg-amber-100 text-amber-900",
  },
  {
    icon: Bot,
    title: "Let Clerk do the typing",
    body: "Clerk — our assistant, coming to firms soon — turns voice notes, photos and messages into draft invoices. A person always checks before anything is saved.",
    tone: "bg-lime-100 text-lime-900",
  },
];

const WORKFLOW = [
  {
    number: "01",
    icon: ReceiptText,
    title: "Create",
    body: "Create an invoice, or upload many at once from a spreadsheet.",
  },
  {
    number: "02",
    icon: ScanLine,
    title: "Check",
    body: "We point out anything wrong so you can fix it before it goes out.",
  },
  {
    number: "03",
    icon: ShieldCheck,
    title: "Stamp",
    // First use of the acronyms on the page — expand them here; the evidence-
    // chain mock further down may then use the short forms.
    body: `We send it to FIRS and save the official stamp — the ${IRN_EXPANSION} (IRN) and ${CSID_EXPANSION} (CSID) — as your proof.`,
  },
  {
    number: "04",
    icon: Landmark,
    title: "Get paid",
    body: "When money comes in, the payment record attaches to the invoice.",
  },
];

const WORKSPACES = [
  {
    icon: ReceiptText,
    audience: "For business owners and their teams",
    title: "SME Compliance",
    body: "Create invoices, upload in bulk, see your VAT position and never miss a deadline.",
    accent: "text-teal-700",
    line: "bg-teal-600",
    href: "/login?returnTo=/app/",
    cta: "Sign in to open",
  },
  {
    icon: Building2,
    audience: "For accounting firms",
    title: "Accountant Console",
    body: "Watch every client's compliance, invite your team and clients, and download the records you need.",
    accent: "text-indigo-700",
    line: "bg-indigo-600",
    href: "/login?returnTo=/console/",
    cta: "Sign in to open",
  },
  {
    icon: Store,
    audience: "Coming soon for buyer teams",
    title: "Buyer Rails",
    body: "Check and confirm supplier invoices before you pay, and protect your VAT claims.",
    accent: "text-blue-700",
    line: "bg-blue-600",
    href: "#roadmap",
    cta: "See the roadmap",
  },
  {
    icon: Calculator,
    audience: "Free — no account needed",
    title: "Penalty Calculator",
    body: "See what late or missing e-invoicing could cost your business in fines.",
    accent: "text-amber-700",
    line: "bg-amber-500",
    href: "/penalty-calculator/",
    cta: "Open calculator",
  },
];

type ProductViewKey = "clerk" | "sme" | "firm" | "buyer";

// Available workspaces lead (SME, Firm — the launch profile); staged views
// carry a status badge on their tab so the label, not just the panel copy,
// says what ships later.
type ProductViewStatus = "rolling-out" | "coming-soon";

const VIEW_STATUS_LABEL: Record<ProductViewStatus, string> = {
  "rolling-out": "Rolling out",
  "coming-soon": "Coming soon",
};

const PRODUCT_VIEWS: Array<{
  key: ProductViewKey;
  label: string;
  eyebrow: string;
  title: string;
  body: string;
  bullets: string[];
  status?: ProductViewStatus;
}> = [
  {
    key: "sme",
    label: "SME",
    eyebrow: "For business owners",
    title: "Know what is done, what is due and what needs you.",
    body: "A simple view of your invoices, deadlines, VAT position and payments — without needing to learn the tax rules behind them.",
    bullets: [
      "Mistakes caught before you submit",
      "Upload many invoices at once",
      "Deadline reminders and a clear VAT view",
    ],
  },
  {
    key: "firm",
    label: "Firm",
    eyebrow: "For accounting firms",
    title: "Manage every client from one screen.",
    body: "See which clients need attention, invite new ones, fix problems early and download the records behind every decision.",
    bullets: [
      "Invite your team and clients yourself",
      "Submit many invoices at once",
      "One view of risk and unpaid invoices across clients",
    ],
  },
  {
    key: "clerk",
    label: "Clerk AI",
    eyebrow: "Your assistant",
    title: "Send a voice note. Get a draft invoice.",
    body: "Clerk listens to voice notes and reads photos and messages, then turns them into drafts. It shows what it found, and a person approves before anything is saved. Coming to firms after launch.",
    bullets: [
      "Works from voice notes, photos and messages",
      "A person approves every action",
      "Every correction makes it better",
    ],
    status: "rolling-out",
  },
  {
    key: "buyer",
    label: "Buyer",
    eyebrow: "Buyer Rails",
    title: "Check supplier invoices before you pay.",
    body: "Buyer teams will confirm or query supplier invoices, record payments and see which suppliers keep getting it right. Arriving in a later release.",
    bullets: [
      "Confirm or query each invoice",
      "See which suppliers get it right",
      "Payment notes saved with each invoice",
    ],
    status: "coming-soon",
  },
];

const PLATFORM_FACTS = [
  ["5,000", "invoices in one upload"],
  ["2", "ways to submit, with backup"],
  ["3", "data-sharing controls you own"],
  ["100%", "of your history kept — nothing erased"],
];

// The staged release plan, in public terms (the engineering source of truth
// is the flag manifest in the api-server; keep the two telling one story).
const ROADMAP_STAGES = [
  {
    icon: CheckCircle2,
    badge: "Live today",
    badgeTone: "border-emerald-200 bg-emerald-50 text-emerald-800",
    iconTone: "bg-emerald-100 text-emerald-800",
    title: "Invoicing done right",
    body: "The heart of the product, live and proven. Everything that comes later builds on these same records.",
    items: [
      "Create, check, stamp and store invoices",
      "Your accountant sets you up and works with you",
      "You control what your data is used for",
      "A full history you can download anytime",
      "Bulk upload, VAT view and deadlines",
    ],
  },
  {
    icon: Clock3,
    badge: "Rolling out",
    badgeTone: "border-amber-200 bg-amber-50 text-amber-900",
    iconTone: "bg-amber-100 text-amber-900",
    title: "More tools for your accountant",
    body: "Switched on step by step as firms come on board — no waiting, no redoing.",
    items: [
      "Tax filings, withholding tax and authority notices",
      "Supplier bills and repeat invoices",
      "A monthly report pack for your business",
      "Buyer confirmations and stamp checks",
      "Clerk, the assistant — always human-checked",
    ],
  },
  {
    icon: Compass,
    badge: "On the horizon",
    badgeTone: "border-slate-200 bg-slate-100 text-slate-700",
    iconTone: "bg-slate-200 text-slate-700",
    title: "Further ahead",
    body: "Connecting banks, buyers and partners around your invoices.",
    items: [
      "Match bank statements to invoices",
      "Same-day reporting for consumer sales",
      "A workspace for buyers",
      "Firm branding, training and accounting-software links",
      "Get ready for loans and financing",
    ],
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
          Invoicing, done right
        </span>
      </span>
    </a>
  );
}

function LandingNav() {
  const [open, setOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeMenu = () => setOpen(false);
  const links = [
    ["What it does", "#platform"],
    ["Product tour", "#product-tour"],
    ["How it works", "#workflow"],
    ["What's coming", "#roadmap"],
    ["Workspaces", "#workspaces"],
    ["Penalty calculator", "/penalty-calculator/"],
  ];

  useEffect(() => {
    if (!open) return;

    const dismissMenu = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      requestAnimationFrame(() => menuButtonRef.current?.focus());
    };

    document.addEventListener("keydown", dismissMenu);
    return () => document.removeEventListener("keydown", dismissMenu);
  }, [open]);

  return (
    <header className="relative z-20 border-b border-white/15 bg-[#071a1c]">
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
            onClick={trackLandingCta}
            className="inline-flex h-10 items-center gap-2 rounded-md bg-lime-300 px-4 text-sm font-bold text-[#071a1c] transition-colors hover:bg-lime-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#071a1c]"
            data-testid="link-header-login"
          >
            Sign in
            <ArrowRight className="size-4" aria-hidden="true" />
          </a>
        </div>

        <button
          ref={menuButtonRef}
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
            onClick={() => {
              closeMenu();
              trackLandingCta();
            }}
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
            {["Portfolio", "Clients", "Advisory", "Receivables", "Audit"].map(
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
  const [activeView, setActiveView] = useState<ProductViewKey>("sme");
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
      className="scroll-mt-20 bg-[#eef3f1] py-14 sm:py-24"
    >
      <div className="mx-auto max-w-7xl px-5 sm:px-8 lg:px-10">
        <div className="max-w-3xl">
          <p className="text-sm font-extrabold uppercase text-teal-700">
            Product tour
          </p>
          <h2 className="landing-display mt-4 text-4xl font-bold leading-tight text-slate-950 sm:text-5xl">
            One platform. A clear view for each person.
          </h2>
          <p className="mt-5 max-w-2xl text-base leading-7 text-slate-600">
            Business owners, accountants and buyers each get their own view of
            the same records. Views marked "Rolling out" or "Coming soon" arrive
            in later releases.
          </p>
        </div>

        <div className="mt-8 grid items-start gap-10 sm:mt-12 lg:grid-cols-[0.72fr_1.28fr] lg:gap-14">
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
                      "min-h-11 rounded-sm px-3 py-1.5 text-sm font-extrabold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 " +
                      (selected
                        ? "bg-[#0a2425] text-white"
                        : "text-slate-600 hover:bg-slate-100 hover:text-slate-950")
                    }
                  >
                    {view.label}
                    {view.status && (
                      <span
                        className={
                          "mt-0.5 block text-[9px] font-bold uppercase tracking-wide " +
                          (selected ? "text-lime-300" : "text-amber-700")
                        }
                      >
                        {VIEW_STATUS_LABEL[view.status]}
                      </span>
                    )}
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
              <p className="flex flex-wrap items-center gap-2 text-xs font-extrabold uppercase text-teal-700">
                {active.eyebrow}
                {active.status && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-[10px] font-bold normal-case tracking-normal text-amber-900">
                    <Clock3 className="size-3" aria-hidden="true" />
                    {VIEW_STATUS_LABEL[active.status]}
                  </span>
                )}
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
                href={active.status ? "#roadmap" : "/login"}
                onClick={active.status ? undefined : trackLandingCta}
                className="mt-8 inline-flex items-center gap-2 text-sm font-extrabold text-teal-800 transition-colors hover:text-teal-950"
              >
                {active.status ? "See the release plan" : "Open your workspace"}
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
              E-invoicing for Nigerian businesses
            </div>
            <h1 className="landing-display text-5xl font-extrabold leading-none text-white sm:text-7xl lg:text-8xl">
              MeridianIQ
            </h1>
            <p className="landing-display mt-5 max-w-3xl text-3xl font-semibold leading-tight text-white sm:text-4xl lg:text-5xl">
              Send correct invoices. Keep the proof.
            </p>
            <p className="mt-6 max-w-2xl text-base leading-7 text-white/80 sm:text-lg">
              Create invoices, check them against FIRS rules and send them for
              stamping. Everything you might need to show an auditor stays saved
              in one place.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <a
                href="/login"
                onClick={trackLandingCta}
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
              <a
                href={CONTACT_MAILTO}
                onClick={trackLandingCta}
                data-testid="link-hero-contact"
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md border border-white/35 bg-[#071a1c]/30 px-5 text-sm font-bold text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300"
              >
                Talk to us
                <Mail className="size-4" aria-hidden="true" />
              </a>
            </div>

            <div className="mt-9 flex flex-wrap gap-x-6 gap-y-3 text-sm text-white/75">
              {[
                "You approve every important step",
                "Each person sees only their own work",
                "A full history for every invoice",
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

        <section id="platform" className="scroll-mt-20 py-14 sm:py-24">
          <div className="mx-auto max-w-7xl px-5 sm:px-8 lg:px-10">
            <div className="grid gap-12 lg:grid-cols-[0.8fr_1.2fr] lg:gap-20">
              <div>
                <p className="text-sm font-extrabold uppercase text-teal-700">
                  One connected platform
                </p>
                <h2 className="landing-display mt-4 max-w-lg text-4xl font-bold leading-tight text-slate-950 sm:text-5xl">
                  Less chasing. Fewer surprises.
                </h2>
                <p className="mt-5 max-w-lg text-base leading-7 text-slate-600">
                  Your invoices, your compliance work and your payment records
                  live in one place — so you and your accountant always see the
                  same thing.
                </p>
                <a
                  href="#product-tour"
                  className="mt-7 inline-flex items-center gap-2 text-sm font-extrabold text-teal-800 hover:text-teal-950"
                >
                  See how each person uses it
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

        <section id="workflow" className="scroll-mt-20 bg-white py-14 sm:py-24">
          <div className="mx-auto max-w-7xl px-5 sm:px-8 lg:px-10">
            <div className="flex flex-col justify-between gap-6 md:flex-row md:items-end">
              <div className="max-w-3xl">
                <p className="text-sm font-extrabold uppercase text-teal-700">
                  How it works
                </p>
                <h2 className="landing-display mt-4 text-4xl font-bold leading-tight sm:text-5xl">
                  One invoice. One complete story.
                </h2>
              </div>
              <p className="max-w-md text-sm leading-6 text-slate-600">
                Each step adds to the invoice's record. Nothing is overwritten,
                so you can always see what happened and when.
              </p>
            </div>

            <div className="mt-8 grid gap-8 sm:mt-12 sm:grid-cols-2 lg:grid-cols-4">
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
          className="scroll-mt-20 bg-[#071a1c] py-14 text-white sm:py-24"
        >
          <div className="mx-auto grid max-w-7xl items-center gap-14 px-5 sm:px-8 lg:grid-cols-[0.9fr_1.1fr] lg:px-10">
            <div>
              <p className="text-sm font-extrabold uppercase text-lime-300">
                Built to be trusted
              </p>
              <h2 className="landing-display mt-4 text-4xl font-bold leading-tight sm:text-5xl">
                Proof you can stand behind.
              </h2>
              <p className="mt-5 max-w-xl text-base leading-7 text-white/70">
                Every decision stays attached to its invoice. Only the right
                people can see your records — and the history can be checked
                outside MeridianIQ.
              </p>

              <div className="mt-8 grid gap-x-8 gap-y-5 sm:grid-cols-2">
                {[
                  [
                    "Your data is yours",
                    "Each business's records are locked to that business.",
                  ],
                  [
                    "Nothing gets erased",
                    "Changes are added on top — the original record always remains.",
                  ],
                  [
                    "History you can check",
                    "Download your records and verify them outside the app.",
                  ],
                  [
                    "You control sharing",
                    "You decide what your data is used for, and you can change your mind.",
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
                    title: "Drafted",
                    body: "Created for the July delivery and checked",
                    Icon: ReceiptText,
                    time: "09:42",
                  },
                  {
                    title: "Reviewed",
                    body: "Details checked and fixed by Tola",
                    Icon: ListChecks,
                    time: "09:47",
                  },
                  {
                    title: "Stamped",
                    body: "Official stamp (IRN and CSID) saved",
                    Icon: BadgeCheck,
                    time: "10:03",
                  },
                  {
                    title: "Paid",
                    body: "Payment record attached to the invoice",
                    Icon: Landmark,
                    time: "14:26",
                  },
                  {
                    title: "Exported",
                    body: "Full history downloaded and verified",
                    Icon: ShieldCheck,
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

        <section id="roadmap" className="scroll-mt-20 bg-white py-14 sm:py-24">
          <div className="mx-auto max-w-7xl px-5 sm:px-8 lg:px-10">
            <div className="flex flex-col justify-between gap-6 md:flex-row md:items-end">
              <div className="max-w-3xl">
                <p className="text-sm font-extrabold uppercase text-teal-700">
                  The release plan
                </p>
                <h2 className="landing-display mt-4 text-4xl font-bold leading-tight text-slate-950 sm:text-5xl">
                  What's live now. What's coming next.
                </h2>
              </div>
              <p className="max-w-md text-sm leading-6 text-slate-600">
                The core is live and proven. Each new part switches on when it
                is ready — on the same records, with nothing to redo.
              </p>
            </div>

            <div className="mt-8 grid gap-6 sm:mt-12 lg:grid-cols-3">
              {ROADMAP_STAGES.map((stage) => {
                const Icon = stage.icon;
                return (
                  <article
                    key={stage.badge}
                    className="flex flex-col rounded-md border border-slate-200 bg-[#f8faf9] p-6"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span
                        className={
                          "grid size-11 place-items-center rounded-md " +
                          stage.iconTone
                        }
                      >
                        <Icon className="size-5" aria-hidden="true" />
                      </span>
                      <span
                        className={
                          "inline-flex items-center rounded-full border px-3 py-1 text-[11px] font-bold " +
                          stage.badgeTone
                        }
                      >
                        {stage.badge}
                      </span>
                    </div>
                    <h3 className="mt-6 text-xl font-extrabold text-slate-950">
                      {stage.title}
                    </h3>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                      {stage.body}
                    </p>
                    <ul className="mt-5 space-y-2.5 border-t border-slate-200 pt-5 text-sm font-semibold text-slate-800">
                      {stage.items.map((item) => (
                        <li key={item} className="flex items-start gap-2.5">
                          <Check
                            className="mt-0.5 size-4 shrink-0 text-teal-700"
                            aria-hidden="true"
                          />
                          {item}
                        </li>
                      ))}
                    </ul>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        <section
          id="workspaces"
          className="scroll-mt-20 bg-[#e7eeec] py-14 sm:py-24"
        >
          <div className="mx-auto max-w-7xl px-5 sm:px-8 lg:px-10">
            <div className="flex flex-col justify-between gap-5 md:flex-row md:items-end">
              <div className="max-w-3xl">
                <p className="text-sm font-extrabold uppercase text-teal-700">
                  Who uses MeridianIQ
                </p>
                <h2 className="landing-display mt-4 text-4xl font-bold leading-tight sm:text-5xl">
                  One account. The right workspace for you.
                </h2>
              </div>
              <a
                href="/login"
                onClick={trackLandingCta}
                className="inline-flex items-center gap-2 self-start text-sm font-extrabold text-teal-800 hover:text-teal-950 md:self-auto"
              >
                Go to sign-in
                <ArrowRight className="size-4" aria-hidden="true" />
              </a>
            </div>

            <div className="mt-8 grid gap-5 sm:mt-12 md:grid-cols-2 xl:grid-cols-4">
              {WORKSPACES.map((workspace) => {
                const Icon = workspace.icon;
                return (
                  <a
                    key={workspace.title}
                    href={workspace.href}
                    onClick={trackLandingCta}
                    className="group flex flex-col rounded-md border border-slate-200 bg-white p-5 shadow-sm transition-transform hover:-translate-y-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 sm:p-6 md:min-h-[18rem] xl:min-h-[22rem]"
                  >
                    <span className={"block h-1 w-12 " + workspace.line} />
                    <Icon
                      className={"mt-6 size-7 sm:mt-8 " + workspace.accent}
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
                      {workspace.href.startsWith("/login") ? (
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

            <p className="mt-8 text-sm leading-6 text-slate-600">
              No account yet? MeridianIQ works through your accounting firm —
              they invite you. Or email{" "}
              <a
                href={CONTACT_MAILTO}
                onClick={trackLandingCta}
                data-testid="link-workspaces-contact"
                className="font-bold text-teal-800 underline underline-offset-2 hover:text-teal-950"
              >
                {ADVISORY_EMAIL}
              </a>{" "}
              and we will help you get started.
            </p>
          </div>
        </section>

        <section className="bg-lime-300 py-12 sm:py-20">
          <div className="mx-auto flex max-w-7xl flex-col justify-between gap-8 px-5 sm:px-8 lg:flex-row lg:items-center lg:px-10">
            <div className="max-w-3xl">
              <p className="text-sm font-extrabold uppercase text-[#1c4443]">
                Ready when you are
              </p>
              <h2 className="landing-display mt-3 text-4xl font-bold leading-tight text-[#071a1c] sm:text-5xl">
                Get your invoicing right — and keep the proof.
              </h2>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row lg:shrink-0">
              <a
                href="/login"
                onClick={trackLandingCta}
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md bg-[#071a1c] px-6 text-sm font-extrabold text-white transition-colors hover:bg-[#12383a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#071a1c] focus-visible:ring-offset-2 focus-visible:ring-offset-lime-300"
                data-testid="link-cta-login"
              >
                Sign in
                <ArrowRight className="size-4" aria-hidden="true" />
              </a>
              <a
                href={CONTACT_MAILTO}
                onClick={trackLandingCta}
                data-testid="link-cta-contact"
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md border border-[#071a1c]/30 px-5 text-sm font-extrabold text-[#071a1c] transition-colors hover:bg-[#071a1c]/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#071a1c]"
              >
                Talk to us
                <Mail className="size-4" aria-hidden="true" />
              </a>
              <a
                href="/penalty-calculator/"
                onClick={trackLandingCta}
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md border border-[#071a1c]/30 px-5 text-sm font-extrabold text-[#071a1c] transition-colors hover:bg-[#071a1c]/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#071a1c]"
              >
                Check possible fines
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
              E-invoicing for Nigerian businesses — done right, with the proof
              to show for it.
            </p>
          </div>
          <nav
            className="flex flex-wrap gap-x-6 gap-y-3 text-sm text-white/70"
            aria-label="Footer"
          >
            <a className="hover:text-white" href="#platform">
              What it does
            </a>
            <a className="hover:text-white" href="#product-tour">
              Product tour
            </a>
            <a className="hover:text-white" href="#evidence">
              Trust &amp; proof
            </a>
            <a className="hover:text-white" href="#roadmap">
              What's coming
            </a>
            <a className="hover:text-white" href="/penalty-calculator/">
              Penalty calculator
            </a>
            <a
              className="hover:text-white"
              href={CONTACT_MAILTO}
              onClick={trackLandingCta}
              data-testid="link-footer-contact"
            >
              Talk to us
            </a>
            <a
              className="font-bold text-lime-300 hover:text-lime-200"
              href="/login"
              onClick={trackLandingCta}
            >
              Sign in
            </a>
          </nav>
        </div>
        <div className="mx-auto mt-9 flex max-w-7xl flex-col gap-2 border-t border-white/10 px-5 pt-6 text-xs text-white/45 sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-10">
          <span>MeridianIQ, Lagos, Nigeria.</span>
          <span>Correct invoices, from first draft to final payment.</span>
        </div>
      </footer>
    </div>
  );
}
