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
    ["Trust", "#trust"],
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
          <h2>A considered workspace for what matters.</h2>
          <p>Different teams. One connected record.</p>
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
            Buyer Rails <span>Planned</span>
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
                ? "Your work, with the record to back it."
                : "Your clients. A clearer view of the work."}
            </h3>
            <p>
              {active === "sme"
                ? "Prepare invoices, keep supporting records together and see what needs attention. A clearer working day, in one place."
                : "Move between clients without losing context. Review invoice work, manage access and retrieve the records behind each decision."}
            </p>
            <ul className="editorial-feature-list">
              {(active === "sme"
                ? [
                    "Create and check invoices",
                    "Keep supporting records connected",
                    "Review outstanding invoice work",
                    "Work with your accounting firm",
                  ]
                : [
                    "Review work across clients",
                    "Keep each client's records in context",
                    "Give your team appropriate access",
                    "Export connected invoice records",
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
                  ? "Sign in to your workspace"
                  : "Sign in to the console"}
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
                  {active === "sme" ? "Business workspace" : "Firm workspace"}
                </span>
                <span>Illustrative example</span>
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
              <h3>Meet Clerk</h3>
              <span className="editorial-status is-progress">Rolling out</span>
            </div>
            <p>
              Turn supported photos, messages and voice notes into proposed
              drafts. A person reviews the extracted details before a draft is
              created. Availability depends on your firm's activation.
            </p>
          </div>
          <p className="editorial-clerk-aside">
            A helpful assistant.
            <br />A person in control.
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
        <h2>Less chasing. A clearer record.</h2>
        <div className="editorial-outcome-grid">
          {[
            {
              Icon: FileCheck2,
              title: "Prepare invoices with care.",
              body: "Create and check invoices. Resolve validation feedback before submission.",
            },
            {
              Icon: Paperclip,
              title: "Keep supporting records connected.",
              body: "Invoice information and evidence stay together, so the context is easy to find.",
            },
            {
              Icon: ListTodo,
              title: "See what needs attention.",
              body: "Drafts, review work and submission outcomes, with a clearer next step.",
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
              Invoices in order.
              <br />
              Evidence at hand.
            </h1>
            <p className="editorial-hero-description">
              Valo brings invoicing, compliance tasks and supporting records
              together.
            </p>
            <div className="editorial-hero-actions">
              <EnquiryLink testId="link-hero-contact" />
              <a className="editorial-text-link" href="#product-tour">
                Explore the platform <ArrowRight size={18} aria-hidden="true" />
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
              Good business keeps records.
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
              <h2>One invoice. A traceable record.</h2>
              <p>From invoice to evidence. In four steps.</p>
            </div>
            <ol className="editorial-workflow">
              {[
                ["Create invoice", "Add customer details, items and amounts."],
                [
                  "Review",
                  "Check validation feedback and resolve missing details.",
                ],
                [
                  "Supported submission",
                  "Use the configured route and retain the authority response.",
                ],
                [
                  "Retain evidence",
                  "Keep invoice details, supporting records and recorded payment information together.",
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
              Submission depends on the configured integration and authority
              response. Recording a payment does not mean Valo receives, holds
              or guarantees the funds.
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
              <p className="editorial-label">Trust through transparency</p>
              <h2>
                Keep the record.
                <br />
                Understand what happened.
              </h2>
              <p>
                The context matters: what was checked, what changed and which
                document supports it. Keep a connected history of the work,
                ready to review and export.
              </p>
              <ul className="editorial-trust-list">
                <li>Access shaped by roles and client scope</li>
                <li>Internal review distinct from authority approval</li>
                <li>Recorded history and evidence exports</li>
              </ul>
              <a
                className="editorial-button editorial-button-light"
                href="#product-tour"
              >
                Explore the workspace{" "}
                <ArrowUpRight size={17} aria-hidden="true" />
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
                Sample activity only. No official stamp or approval is
                represented.
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
              <h2>Available now. Thoughtfully expanding.</h2>
              <p>More support for the work ahead.</p>
            </div>
            <dl className="editorial-availability">
              <div>
                <dt>
                  <span className="editorial-status is-checked">
                    Available now
                  </span>
                </dt>
                <dd>
                  <h3>The invoice core</h3>
                  <p>
                    Invoice preparation, validation and supported submission.
                    Client engagements, consent controls and retained records.
                    Access is invite-led.
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
                    Statutory desks, client report packs, supplier bills and
                    Clerk. These require activation and are not enabled for
                    every firm.
                  </p>
                </dd>
              </div>
              <div>
                <dt>
                  <span className="editorial-status is-progress">Planned</span>
                </dt>
                <dd>
                  <h3>More connected workflows</h3>
                  <p>
                    Buyer Rails, bank reconciliation and accounting-software
                    connections. Not part of the standard launch offer.
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
                <h3>Understand potential e-invoicing penalties.</h3>
                <p>
                  An indicative estimate, not tax or legal advice. No account
                  needed.
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
              <p className="editorial-label">A conversation is a good start</p>
              <h2>Bring your records into order.</h2>
              <p>
                Request a walkthrough for your business or accounting firm. We
                will follow up about the right workspace and access.
              </p>
              <p className="editorial-small">
                Valo is invite-led. Sending an enquiry does not create an
                account.
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
                Invoicing. Compliance work.
                <br />A connected record.
              </p>
            </div>
            <nav aria-label="Footer">
              <a href="#product-tour">Product tour</a>
              <a href="#workflow">How it works</a>
              <a href="#roadmap">Release status</a>
              <a href="/penalty-calculator/">Penalty calculator</a>
              <a href={CONTACT} onClick={trackCta}>
                Contact &amp; support
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
            <span>Care in the details.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
