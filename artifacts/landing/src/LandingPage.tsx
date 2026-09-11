import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Calculator,
  FileCheck2,
  ListTodo,
  Paperclip,
  Sparkles,
  FileText,
  Menu,
  X,
} from "lucide-react";
import { ValoMark, trackUsabilityEvent } from "@workspace/web-ui";
import { ADVISORY_EMAIL } from "@workspace/format";
import { LandingAccessRequest } from "./components/landing-access-request";
import { LandingReadiness } from "./components/landing-readiness";
import { LandingProductExample } from "./components/landing-product-example";
import "./landing.css";

const trackCta = () => trackUsabilityEvent("landing_cta", "landing");
type Audience = "sme" | "firm";
const audiences: Audience[] = ["sme", "firm"];
const CONTACT = `mailto:${ADVISORY_EMAIL}?subject=${encodeURIComponent("Valo access request")}`;

function Brand() {
  return (
    <a className="editorial-brand" href="/" aria-label="Valo home">
      <ValoMark aria-hidden="true" />
      <span>Valo</span>
    </a>
  );
}
function EnquiryLink({ testId }: { testId?: string }) {
  return (
    <a
      href="#request-access"
      className="editorial-button"
      onClick={trackCta}
      data-testid={testId}
    >
      Request a demo <ArrowUpRight size={18} aria-hidden="true" />
    </a>
  );
}
function LandingNav({ onAccountants }: { onAccountants: () => void }) {
  const [open, setOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        menuButton.current?.focus();
      }
    };
    const desktop = window.matchMedia("(min-width: 1024px)");
    const resize = () => {
      if (desktop.matches) setOpen(false);
    };
    document.addEventListener("keydown", dismiss);
    desktop.addEventListener("change", resize);
    return () => {
      document.removeEventListener("keydown", dismiss);
      desktop.removeEventListener("change", resize);
    };
  }, [open]);
  const links = [
    ["Product", "#product-tour"],
    ["How it works", "#workflow"],
    ["For accountants", "#for-accountants"],
    ["Security and records", "#trust"],
  ];
  const navLinks = links.map(([label, href]) => (
    <a
      key={href}
      href={href}
      onClick={() => {
        setOpen(false);
        if (href === "#for-accountants") onAccountants();
        // Preserve focus when the mobile disclosure disappears.
        requestAnimationFrame(() =>
          document
            .getElementById(href.slice(1))
            ?.focus({ preventScroll: true }),
        );
      }}
    >
      {label}
    </a>
  ));
  return (
    <header className="editorial-header">
      <div className="editorial-container editorial-header-row">
        <Brand />
        <nav className="editorial-desktop-nav" aria-label="Main navigation">
          {navLinks}
        </nav>
        <div className="editorial-desktop-nav editorial-header-actions">
          <a href="/login" onClick={trackCta} data-testid="link-header-login">
            Sign in
          </a>
          <EnquiryLink />
        </div>
        <button
          ref={menuButton}
          className="editorial-menu-toggle"
          type="button"
          aria-label={open ? "Close navigation" : "Open navigation"}
          aria-expanded={open}
          aria-controls="mobile-navigation"
          onClick={() => setOpen(!open)}
        >
          {open ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
        </button>
      </div>
      {open && (
        <nav
          id="mobile-navigation"
          className="editorial-mobile-nav editorial-container"
          aria-label="Mobile navigation"
        >
          {navLinks}
          <a href="/login" onClick={trackCta}>
            Sign in <ArrowRight size={18} aria-hidden="true" />
          </a>
          <a
            className="editorial-button"
            href="#request-access"
            onClick={() => {
              setOpen(false);
              trackCta();
              requestAnimationFrame(() =>
                document
                  .getElementById("request-access")
                  ?.focus({ preventScroll: true }),
              );
            }}
          >
            Request a demo <ArrowUpRight size={18} aria-hidden="true" />
          </a>
        </nav>
      )}
    </header>
  );
}

function ProductTour({
  active,
  setActive,
}: {
  active: Audience;
  setActive: (value: Audience) => void;
}) {
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % audiences.length;
    else if (event.key === "ArrowLeft")
      next = (index - 1 + audiences.length) % audiences.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = audiences.length - 1;
    else return;
    event.preventDefault();
    setActive(audiences[next]);
    tabs.current[next]?.focus();
  };
  return (
    <section
      id="product-tour"
      tabIndex={-1}
      className="editorial-section editorial-product"
    >
      <div className="editorial-container">
        <div className="editorial-section-heading">
          <h2>Invoices and records for your team</h2>
          <p>Manage your business invoices or your clients' compliance work.</p>
        </div>
        <div className="editorial-audience-row">
          <div
            id="for-accountants"
            tabIndex={-1}
            className="editorial-tabs"
            role="tablist"
            aria-label="Workspace audience"
          >
            {audiences.map((key, index) => (
              <button
                key={key}
                ref={(node) => {
                  tabs.current[index] = node;
                }}
                id={`product-tab-${key}`}
                type="button"
                role="tab"
                aria-selected={active === key}
                aria-controls="product-panel"
                tabIndex={active === key ? 0 : -1}
                onKeyDown={(event) => onKeyDown(event, index)}
                onClick={() => setActive(key)}
              >
                {key === "sme" ? "Businesses" : "Accounting firms"}
              </button>
            ))}
          </div>
          <span className="editorial-upcoming">
            Buyer workspace <span>Planned</span>
          </span>
        </div>
        <div className="editorial-product-grid">
          <div className="editorial-product-copy">
            <p className="editorial-label">
              {active === "sme"
                ? "For Nigerian businesses"
                : "For accounting firms"}
            </p>
            <h3>
              {active === "sme"
                ? "Manage your invoices and supporting records"
                : "Review work across your clients"}
            </h3>
            <p>
              {active === "sme"
                ? "Create invoices, check missing details and keep supporting documents with each invoice. See which items still need action."
                : "Open each client's records to review invoices, manage team access and find the documents behind a decision."}
            </p>
            <ul className="editorial-feature-list">
              {(active === "sme"
                ? [
                    "Create and check invoices",
                    "Keep documents with each invoice",
                    "See invoices that need action",
                    "Work with your accounting firm",
                  ]
                : [
                    "Review work across clients",
                    "Keep each client's records together",
                    "Give your team appropriate access",
                    "Export invoices and supporting records",
                  ]
              ).map((item) => (
                <li key={item}>
                  <span>
                    <Check size={13} aria-hidden="true" />
                  </span>
                  {item}
                </li>
              ))}
            </ul>
            <div className="editorial-product-actions">
              <EnquiryLink />
              <a
                className="editorial-text-link"
                href={
                  active === "sme"
                    ? "/login?returnTo=/app/"
                    : "/login?returnTo=/console/"
                }
                onClick={trackCta}
              >
                {active === "sme"
                  ? "Open business workspace"
                  : "Open accountant workspace"}
                <ArrowUpRight size={16} aria-hidden="true" />
              </a>
            </div>
            <p className="editorial-small">
              Access is by invitation through your accounting firm or the Valo
              team.
            </p>
          </div>
          <div
            id="product-panel"
            className="editorial-product-panel"
            role="tabpanel"
            aria-labelledby={`product-tab-${active}`}
            tabIndex={0}
          >
            <figure className="editorial-demo">
              <figcaption className="editorial-demo-caption">
                <span>
                  {active === "sme"
                    ? "Business workspace"
                    : "Accountant workspace"}
                </span>
                <span>Sample data</span>
              </figcaption>
              <div className="editorial-demo-examples">
                <div aria-hidden={active !== "sme"}>
                  <LandingProductExample audience="sme" />
                </div>
                <div aria-hidden={active !== "firm"}>
                  <LandingProductExample audience="firm" />
                </div>
              </div>
            </figure>
          </div>
        </div>
        <div className="editorial-clerk-note">
          <Sparkles size={24} strokeWidth={1.5} aria-hidden="true" />
          <div>
            <div className="editorial-clerk-title">
              <h3>Clerk, Valo's AI assistant</h3>
              <span className="editorial-status is-progress">Rolling out</span>
            </div>
            <p>
              Clerk suggests invoice details from supported photos, messages and
              voice notes. A person reviews and approves the details to create a
              draft. Clerk does not submit it. Your firm must have Clerk
              enabled.
            </p>
          </div>
          <p className="editorial-clerk-aside">
            AI suggestions.
            <br />
            Human approval.
          </p>
        </div>
      </div>
    </section>
  );
}

function Benefits() {
  return (
    <section id="platform" tabIndex={-1} className="editorial-outcomes">
      <div className="editorial-container">
        <h2>Prepare, check and track invoices</h2>
        <div className="editorial-outcome-grid">
          {[
            {
              Icon: FileCheck2,
              title: "Check invoices before submission",
              body: "Create invoices and fix missing or incorrect details before submitting.",
            },
            {
              Icon: Paperclip,
              title: "Keep supporting documents together",
              body: "Find invoice details and the documents that support them in one place.",
            },
            {
              Icon: ListTodo,
              title: "See what needs action",
              body: "Track drafts, reviews and submission results to see what to do next.",
            },
          ].map(({ Icon, title, body }) => (
            <article key={title}>
              <span className="editorial-outcome-icon">
                <Icon size={22} strokeWidth={1.5} aria-hidden="true" />
              </span>
              <div>
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export default function LandingPage() {
  const [audience, setAudience] = useState<Audience>(() =>
    typeof window !== "undefined" && window.location.hash === "#for-accountants"
      ? "firm"
      : "sme",
  );
  return (
    <div className="valo-editorial">
      <a className="editorial-skip" href="#main-content">
        Skip to content
      </a>
      <LandingNav onAccountants={() => setAudience("firm")} />
      <main id="main-content" tabIndex={-1}>
        <section className="editorial-hero">
          <picture className="editorial-hero-image">
            <source
              media="(min-width: 640px) and (max-width: 1023px) and (max-height: 850px)"
              srcSet="/valo-workspace-hero.webp"
            />
            <source
              media="(max-width: 1023px)"
              srcSet="/valo-workspace-mobile.webp"
            />
            <img
              src="/valo-workspace-hero.webp"
              width="1942"
              height="809"
              alt=""
              fetchPriority="high"
            />
          </picture>
          <div className="editorial-container editorial-hero-content">
            <p className="editorial-label">
              E-invoicing and tax compliance
              <br />
              For Nigerian businesses
            </p>
            <h1>
              Valo e-invoicing.
              <br />
              Records together.
            </h1>
            <p className="editorial-hero-description">
              Create and check invoices, track compliance tasks and keep
              supporting documents with your records.
            </p>
            <div className="editorial-hero-actions">
              <EnquiryLink testId="link-hero-contact" />
              <a className="editorial-text-link" href="#product-tour">
                See the workspaces <ArrowRight size={18} aria-hidden="true" />
              </a>
            </div>
            <a
              className="editorial-invited"
              href="/login"
              onClick={trackCta}
              data-testid="link-hero-login"
            >
              Already invited? Sign in{" "}
              <ArrowUpRight size={15} aria-hidden="true" />
            </a>
            <p className="editorial-hero-signoff">
              For businesses and their accountants.
            </p>
          </div>
          <span className="editorial-photo-caption">
            Illustrative workspace
          </span>
        </section>
        <Benefits />
        <ProductTour active={audience} setActive={setAudience} />
        <section
          id="workflow"
          tabIndex={-1}
          className="editorial-section editorial-process"
        >
          <div className="editorial-container">
            <div className="editorial-section-heading">
              <h2>From draft to submission record</h2>
              <p>Prepare an invoice and keep a record of what happens next.</p>
            </div>
            <ol className="editorial-workflow">
              {[
                ["Create invoice", "Add customer details, items and amounts."],
                ["Review", "Check for errors and add any missing details."],
                [
                  "Submit invoice",
                  "Use your configured submission service and keep any tax-authority response returned.",
                ],
                [
                  "Keep records",
                  "Keep invoice details, supporting documents and payment records together.",
                ],
              ].map(([title, body], index) => (
                <li key={title}>
                  <span className="editorial-step">{index + 1}</span>
                  <div>
                    <h3>{title}</h3>
                    <p>{body}</p>
                  </div>
                  {index < 3 && (
                    <ArrowRight
                      className="editorial-step-arrow"
                      size={19}
                      aria-hidden="true"
                    />
                  )}
                </li>
              ))}
            </ol>
            <p className="editorial-workflow-note">
              Submission and stamping depend on your configured service and the
              tax authority's response. Recording a payment does not confirm
              that money was received. Valo does not receive, hold or guarantee
              the funds.
            </p>
          </div>
        </section>
        <section
          id="trust"
          tabIndex={-1}
          className="editorial-section editorial-trust"
        >
          <div className="editorial-container editorial-trust-grid">
            <div className="editorial-trust-copy">
              <p className="editorial-label">Access and records</p>
              <h2>
                Keep the record.
                <br />
                Understand what happened.
              </h2>
              <p>
                See what was checked, what changed and which documents support
                each invoice. Review or export the recorded history.
              </p>
              <ul className="editorial-trust-list">
                <li>Access limited by your role and assigned clients</li>
                <li>
                  Internal review kept separate from tax-authority approval
                </li>
                <li>Invoice history and supporting records you can export</li>
              </ul>
              <a
                className="editorial-button editorial-button-light"
                href="#product-tour"
              >
                See the workspaces <ArrowUpRight size={17} aria-hidden="true" />
              </a>
              <LandingReadiness />
            </div>
            <figure className="editorial-history">
              <figcaption>
                <span>Invoice history</span>
                <span>Illustrative example</span>
              </figcaption>
              <div className="editorial-history-reference">
                <FileText size={22} aria-hidden="true" />
                <div>
                  <h3 className="editorial-mono">INV-2026-041</h3>
                  <p>20 July 2026 / All times WAT</p>
                </div>
              </div>
              <div className="editorial-history-grid">
                <ol>
                  {[
                    [
                      "09:42",
                      "Draft created",
                      "Invoice details recorded.",
                      "2026-07-20T09:42:00+01:00",
                    ],
                    [
                      "09:45",
                      "Supporting record added",
                      "Brief linked to the invoice.",
                      "2026-07-20T09:45:00+01:00",
                    ],
                    [
                      "09:47",
                      "Internal review requested",
                      "Buyer details need a closer look.",
                      "2026-07-20T09:47:00+01:00",
                    ],
                    [
                      "10:03",
                      "Record exported",
                      "A copy retained for review.",
                      "2026-07-20T10:03:00+01:00",
                    ],
                  ].map(([time, title, body, date]) => (
                    <li key={time}>
                      <time dateTime={date}>{time}</time>
                      <div>
                        <h4>{title}</h4>
                        <p>{body}</p>
                      </div>
                    </li>
                  ))}
                </ol>
                <div className="editorial-related-records">
                  <h4>Related records</h4>
                  <ul>
                    {[
                      "Invoice draft",
                      "Project brief",
                      "Buyer details",
                      "Delivery record",
                    ].map((item) => (
                      <li key={item}>
                        <FileText size={16} aria-hidden="true" />
                        {item}
                      </li>
                    ))}
                  </ul>
                  <p>Kept with the invoice.</p>
                </div>
              </div>
              <p className="editorial-history-note">
                Sample activity only. This example shows no official stamp or
                tax-authority approval.
              </p>
            </figure>
          </div>
        </section>
        <section
          id="roadmap"
          tabIndex={-1}
          className="editorial-section editorial-roadmap"
        >
          <div className="editorial-container">
            <div className="editorial-section-heading">
              <h2>What is available</h2>
              <p>
                Check what is included, needs activation or is still planned.
              </p>
            </div>
            <dl className="editorial-availability">
              <div>
                <dt>
                  <span className="editorial-status is-checked">
                    Available now
                  </span>
                </dt>
                <dd>
                  <h3>Invoices and client records</h3>
                  <p>
                    Create and check invoices, and submit through a supported
                    service. Manage client work, consent and saved records.
                    Access is by invitation.
                  </p>
                </dd>
              </div>
              <div>
                <dt>
                  <span className="editorial-status is-review">
                    Rolling out
                  </span>
                </dt>
                <dd>
                  <h3>More support for your firm</h3>
                  <p>
                    Tax filing tools, client reports, supplier bills and Clerk.
                    These need activation and are not enabled for every firm.
                  </p>
                </dd>
              </div>
              <div>
                <dt>
                  <span className="editorial-status is-progress">Planned</span>
                </dt>
                <dd>
                  <h3>Buyer and accounting connections</h3>
                  <p>
                    Buyer workspace, bank reconciliation and connections to
                    accounting software. Not included in the standard launch
                    offer.
                  </p>
                </dd>
              </div>
            </dl>
            <aside
              className="editorial-calculator"
              aria-label="Penalty calculator"
            >
              <Calculator size={28} strokeWidth={1.5} aria-hidden="true" />
              <div>
                <h3>Estimate possible e-invoicing penalties</h3>
                <p>
                  Based on planning assumptions, not official penalty amounts or
                  tax or legal advice. No account needed.
                </p>
              </div>
              <a
                className="editorial-text-link"
                href="/penalty-calculator/"
                onClick={trackCta}
              >
                Open penalty calculator{" "}
                <ArrowUpRight size={18} aria-hidden="true" />
              </a>
            </aside>
          </div>
        </section>
        <section
          id="request-access"
          tabIndex={-1}
          className="editorial-section editorial-contact"
        >
          <div className="editorial-container editorial-contact-grid">
            <div>
              <p className="editorial-label">Contact Valo</p>
              <h2>Request a demo</h2>
              <p>
                Tell us about your business or accounting firm. We will contact
                you about a demo and workspace access.
              </p>
              <p className="editorial-small">
                Valo is available by invitation. Sending a request does not
                create an account.
              </p>
              <a
                className="editorial-text-link"
                href={CONTACT}
                onClick={trackCta}
              >
                <span>{ADVISORY_EMAIL}</span>
                <ArrowUpRight size={18} aria-hidden="true" />
              </a>
              <a
                className="editorial-invited"
                href="/login"
                onClick={trackCta}
                data-testid="link-cta-login"
              >
                Already invited? Sign in{" "}
                <ArrowUpRight size={15} aria-hidden="true" />
              </a>
            </div>
            <LandingAccessRequest contact={CONTACT} />
          </div>
        </section>
      </main>
      <footer className="editorial-footer">
        <div className="editorial-container">
          <div className="editorial-footer-top">
            <div>
              <Brand />
              <p>
                Invoices and compliance tasks.
                <br />
                Supporting records together.
              </p>
            </div>
            <nav aria-label="Footer">
              <a href="#product-tour">Product tour</a>
              <a href="#workflow">How it works</a>
              <a href="#roadmap">Availability</a>
              <a href="/penalty-calculator/">Penalty calculator</a>
              <a href={CONTACT} onClick={trackCta}>
                Contact and support
              </a>
              <a href="/login" onClick={trackCta}>
                Sign in
              </a>
              <a
                href="#request-access"
                onClick={trackCta}
                data-testid="link-footer-contact"
              >
                Request a demo <ArrowUpRight size={16} aria-hidden="true" />
              </a>
            </nav>
          </div>
          <div className="editorial-footer-bottom">
            <span>Valo / Lagos, Nigeria</span>
            <span>For Nigerian businesses and their accountants.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
