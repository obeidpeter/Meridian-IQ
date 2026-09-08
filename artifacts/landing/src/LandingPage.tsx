import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  FileText,
  Menu,
  X,
} from "lucide-react";
import { ValoMark, trackUsabilityEvent } from "@workspace/web-ui";
import { ADVISORY_EMAIL } from "@workspace/format";
import { LandingAccessRequest } from "./components/landing-access-request";
import { LandingReadiness } from "./components/landing-readiness";
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
      Talk to us <ArrowUpRight size={18} aria-hidden="true" />
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
            Talk to us <ArrowUpRight size={18} aria-hidden="true" />
          </a>
        </nav>
      )}
    </header>
  );
}

function BusinessExample() {
  return (
    <div className="editorial-invoice">
      <div className="editorial-demo-title">
        <div>
          <p className="editorial-label">Invoice detail</p>
          <h3>July design services</h3>
          <p className="editorial-mono">INV-2026-041</p>
        </div>
        <span className="editorial-status is-review">Needs review</span>
      </div>
      <dl className="editorial-invoice-parties">
        <div>
          <dt>From</dt>
          <dd>Ade Studio</dd>
        </div>
        <div>
          <dt>To</dt>
          <dd>Northline Trading</dd>
        </div>
        <div>
          <dt>Invoice date</dt>
          <dd>20 Jul 2026</dd>
        </div>
      </dl>
      <div className="editorial-invoice-line">
        <span>Design services</span>
        <span className="editorial-mono">NGN 240,000.00</span>
      </div>
      <div className="editorial-invoice-line">
        <span>VAT</span>
        <span className="editorial-mono">NGN 18,000.00</span>
      </div>
      <div className="editorial-invoice-total">
        <span>Total</span>
        <strong className="editorial-mono">NGN 258,000.00</strong>
      </div>
      <div className="editorial-review-note">
        <FileText size={18} aria-hidden="true" />
        <div>
          <strong>Review before submission</strong>
          <p>
            Check the buyer details and supporting record. This draft has not
            been submitted to a tax authority.
          </p>
        </div>
      </div>
      <div className="editorial-demo-foot">
        <span>Supporting record</span>
        <span className="editorial-mono">Brief-041.pdf</span>
      </div>
    </div>
  );
}
function FirmExample() {
  return (
    <div className="editorial-firm-example">
      <div className="editorial-demo-title">
        <div>
          <p className="editorial-label">Accountant Console</p>
          <h3>Client attention</h3>
          <p>Invoice work across your client list</p>
        </div>
        <span className="editorial-mono">3 clients</span>
      </div>
      <ul className="editorial-client-list">
        {[
          {
            name: "Ade Studio",
            task: "Buyer details need a review",
            ref: "INV-2026-041",
            status: "Review needed",
            tone: "is-review",
          },
          {
            name: "Northline Trading",
            task: "Supporting records ready to check",
            ref: "INV-2026-038",
            status: "In progress",
            tone: "is-progress",
          },
          {
            name: "Kola Works",
            task: "Invoice checks completed",
            ref: "INV-2026-035",
            status: "Checked internally",
            tone: "is-checked",
          },
        ].map((client) => (
          <li key={client.name}>
            <div>
              <strong>{client.name}</strong>
              <p>{client.task}</p>
              <span className="editorial-mono">{client.ref}</span>
            </div>
            <span className={`editorial-status ${client.tone}`}>
              {client.status}
            </span>
          </li>
        ))}
      </ul>
      <p className="editorial-demo-foot">
        Internal review states, not tax-authority approvals.
      </p>
    </div>
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
          <p className="editorial-label">01 / The workspace</p>
          <p>One connected record. Two useful perspectives.</p>
        </div>
        <div className="editorial-product-grid">
          <div className="editorial-product-copy">
            <h2>A clear view of the work that matters.</h2>
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
            <p>
              {active === "sme"
                ? "Prepare invoices, check the details and keep the supporting records together. See where each invoice stands without piecing the story together."
                : "Move between clients with a clear view of invoice work. Review details, manage invitations and retrieve the records behind each decision."}
            </p>
            <ul className="editorial-feature-list">
              {(active === "sme"
                ? [
                    "Draft and check invoices",
                    "Keep evidence with the record",
                    "Review outstanding invoice work",
                  ]
                : [
                    "Review work across clients",
                    "Give your team appropriate access",
                    "Export connected invoice records",
                  ]
              ).map((item) => (
                <li key={item}>
                  <Check size={16} aria-hidden="true" />
                  {item}
                </li>
              ))}
            </ul>
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
              <ArrowUpRight size={17} aria-hidden="true" />
            </a>
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
                <span className="editorial-demo-brand">
                  <ValoMark aria-hidden="true" /> Valo
                </span>
                <span>Illustrative example</span>
              </figcaption>
              <div className="editorial-demo-examples">
                <div aria-hidden={active !== "sme"}>
                  <BusinessExample />
                </div>
                <div aria-hidden={active !== "firm"}>
                  <FirmExample />
                </div>
              </div>
            </figure>
          </div>
        </div>
        <div className="editorial-clerk-note">
          <p className="editorial-label">Clerk / Rolling out</p>
          <p>
            An assistant within your workspace. Turn supported photos, messages
            and voice notes into proposed drafts. A person reviews the extracted
            details before a draft is created. Availability depends on your
            firm's activation.
          </p>
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
              media="(max-width: 639px)"
              srcSet="/valo-records-mobile.webp"
            />
            <img
              src="/valo-records-hero.webp"
              width="1942"
              height="809"
              alt=""
              fetchPriority="high"
            />
          </picture>
          <div className="editorial-container editorial-hero-content">
            <p className="editorial-label">
              For Nigerian businesses and their accountants
            </p>
            <h1>
              E-invoicing.
              <br />
              Evidence in order.
            </h1>
            <p className="editorial-hero-description">
              Valo brings invoices, compliance tasks and supporting records into
              one clear workspace.
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
          </div>
          <span className="editorial-photo-caption">
            A little more order. Every working day.
          </span>
        </section>
        <ProductTour active={audience} setActive={setAudience} />
        <section
          id="platform"
          tabIndex={-1}
          className="editorial-section editorial-outcomes"
        >
          <div className="editorial-container">
            <div className="editorial-heading-pair">
              <p className="editorial-label">02 / Everyday clarity</p>
              <h2>
                Less chasing.
                <br />A clearer record.
              </h2>
            </div>
            <div className="editorial-outcome-grid">
              {[
                [
                  "01",
                  "Prepare invoices with care.",
                  "Create an invoice or import a batch. Review validation feedback and correct the details before submission.",
                ],
                [
                  "02",
                  "Keep supporting records connected.",
                  "Bring invoice details, evidence and recorded payment information together, so the context stays with the work.",
                ],
                [
                  "03",
                  "See what needs attention.",
                  "Distinguish drafts, review work and submission outcomes. Know which invoice needs a closer look.",
                ],
              ].map(([number, title, body]) => (
                <article key={number}>
                  <span className="editorial-mono">{number}</span>
                  <h3>{title}</h3>
                  <p>{body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>
        <section id="workflow" tabIndex={-1} className="editorial-section">
          <div className="editorial-container">
            <div className="editorial-heading-pair">
              <p className="editorial-label">03 / From draft to record</p>
              <h2>
                One invoice.
                <br />A traceable record.
              </h2>
            </div>
            <ol className="editorial-workflow">
              {[
                [
                  "Prepare",
                  "Create the invoice and add its supporting details.",
                ],
                [
                  "Review",
                  "Check validation feedback and resolve details that need attention.",
                ],
                [
                  "Submit",
                  "Use the supported submission route. Keep the authority response distinct from your internal review.",
                ],
                [
                  "Retain",
                  "Keep returned references, evidence and recorded payment information with the invoice.",
                ],
              ].map(([title, body], index) => (
                <li key={title}>
                  <span className="editorial-step">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <h3>{title}</h3>
                  <p>{body}</p>
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
            <div>
              <p className="editorial-label">04 / Evidence, not guesswork</p>
              <h2>
                Keep the record.
                <br />
                Understand what happened.
              </h2>
              <p>
                Useful evidence is more than a final document. It is the context
                of the work: what was checked, what changed and which record
                supports it.
              </p>
              <ul className="editorial-trust-list">
                <li>Access shaped by roles and client scope</li>
                <li>Review steps that distinguish drafts from submissions</li>
                <li>Recorded history and evidence exports</li>
              </ul>
              <LandingReadiness />
            </div>
            <figure className="editorial-history">
              <figcaption>
                <span>Invoice history</span>
                <span>Illustrative example</span>
              </figcaption>
              <div className="editorial-history-reference">
                <FileText size={24} aria-hidden="true" />
                <div>
                  <h3 className="editorial-mono">INV-2026-041</h3>
                  <p>20 July 2026 / All times WAT</p>
                </div>
              </div>
              <ol>
                {[
                  [
                    "09:42",
                    "Draft created",
                    "Invoice details recorded.",
                    "2026-07-20T09:42:00+01:00",
                  ],
                  [
                    "09:47",
                    "Internal review recorded",
                    "Buyer details checked by the team.",
                    "2026-07-20T09:47:00+01:00",
                  ],
                  [
                    "10:03",
                    "Submission response retained",
                    "Response linked to the invoice record.",
                    "2026-07-20T10:03:00+01:00",
                  ],
                  [
                    "14:26",
                    "Payment evidence added",
                    "A supporting record, not a movement of funds.",
                    "2026-07-20T14:26:00+01:00",
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
              <p className="editorial-history-note">
                Sample activity only. No official stamp or approval is
                represented.
              </p>
            </figure>
          </div>
        </section>
        <section id="roadmap" tabIndex={-1} className="editorial-section">
          <div className="editorial-container">
            <div className="editorial-heading-pair">
              <p className="editorial-label">05 / Availability</p>
              <div>
                <h2>
                  Available now.
                  <br />
                  Thoughtfully expanding.
                </h2>
                <p className="editorial-intro">
                  The invoice core comes first. Additional capabilities are
                  activated by release and by firm.
                </p>
              </div>
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
                    Invoice preparation, validation and supported submission,
                    client engagements, consent controls and retained records.
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
              <div>
                <p className="editorial-label">A useful starting point</p>
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
                Tell us about your business or accounting firm. We will follow
                up about the right workspace and access.
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
                Talk to us <ArrowUpRight size={16} aria-hidden="true" />
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
