import { useRef, useState, type KeyboardEvent } from "react";
import {
  Check,
  FileText,
  FolderOpen,
  LayoutDashboard,
  ListTodo,
  Paperclip,
  ShieldCheck,
  Users,
} from "lucide-react";

type View = "overview" | "evidence" | "history";
const views: View[] = ["overview", "evidence", "history"];
const clients = [
  {
    name: "Ade Studio",
    task: "Customer details need review",
    ref: "INV-2026-041",
    status: "Needs review",
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
];

function InvoiceOverview() {
  return (
    <>
      <div className="editorial-document-label">
        <FileText size={16} aria-hidden="true" /> Draft invoice{" "}
        <span>July 2026</span>
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
        <ShieldCheck size={18} aria-hidden="true" />
        <div>
          <strong>Review before submission</strong>
          <p>
            Check the customer details and supporting document. This draft has
            not been submitted to a tax authority.
          </p>
        </div>
      </div>
      <div className="editorial-demo-foot">
        <span>
          <Paperclip size={14} aria-hidden="true" /> Supporting record
        </span>
        <span className="editorial-mono">Brief-041.pdf</span>
      </div>
    </>
  );
}

function ClientOverview() {
  return (
    <>
      <div className="editorial-document-label">
        <Users size={16} aria-hidden="true" /> Clients needing review{" "}
        <span>3 clients</span>
      </div>
      <ul className="editorial-client-list">
        {clients.map((client) => (
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
        These are internal review results, not tax-authority approvals.
      </p>
    </>
  );
}

function Evidence({ firm }: { firm: boolean }) {
  const records = firm
    ? [
        ["Brief-041.pdf", "Ade Studio / Invoice support", "PDF"],
        ["Delivery-038.pdf", "Northline Trading / Delivery record", "PDF"],
        ["Review-035.csv", "Kola Works / Internal review", "CSV"],
      ]
    : [
        ["Brief-041.pdf", "Project scope and agreed work", "PDF"],
        ["Buyer-details.txt", "Customer information for review", "TXT"],
        ["Delivery-041.pdf", "Supporting delivery record", "PDF"],
      ];
  return (
    <>
      <div className="editorial-document-label">
        <FolderOpen size={16} aria-hidden="true" /> Supporting records{" "}
        <span>3 files</span>
      </div>
      <ul className="editorial-evidence-list">
        {records.map(([name, description, type]) => (
          <li key={name}>
            <FileText size={20} aria-hidden="true" />
            <div>
              <strong>{name}</strong>
              <p>{description}</p>
            </div>
            <span className="editorial-file-type">{type}</span>
          </li>
        ))}
      </ul>
      <div className="editorial-review-note">
        <Paperclip size={18} aria-hidden="true" />
        <div>
          <strong>Documents stay with the invoice</strong>
          <p>
            Supporting files and invoice details can be reviewed together. These
            are sample file names, not downloadable client documents.
          </p>
        </div>
      </div>
    </>
  );
}

function History({ firm }: { firm: boolean }) {
  const events = firm
    ? [
        ["10:16", "Internal checks completed", "Kola Works / INV-2026-035"],
        [
          "10:02",
          "Supporting record added",
          "Northline Trading / INV-2026-038",
        ],
        ["09:47", "Review requested", "Ade Studio / INV-2026-041"],
      ]
    : [
        ["09:47", "Internal review requested", "Customer details need review."],
        [
          "09:45",
          "Supporting record added",
          "Brief-041.pdf linked to the draft.",
        ],
        ["09:42", "Draft created", "Invoice details recorded by the team."],
      ];
  return (
    <>
      <div className="editorial-document-label">
        <ListTodo size={16} aria-hidden="true" /> Recorded activity{" "}
        <span>20 Jul 2026</span>
      </div>
      <ol className="editorial-preview-history">
        {events.map(([time, title, detail]) => (
          <li key={time}>
            <time dateTime={`2026-07-20T${time}:00+01:00`}>{time}</time>
            <div>
              <strong>{title}</strong>
              <p>{detail}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="editorial-demo-foot">
        <Check size={15} aria-hidden="true" /> Internal activity only. All times
        WAT.
      </p>
    </>
  );
}

export function LandingProductExample({
  audience,
}: {
  audience: "sme" | "firm";
}) {
  const [active, setActive] = useState<View>("overview");
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const firm = audience === "firm";
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % views.length;
    else if (event.key === "ArrowLeft")
      next = (index - 1 + views.length) % views.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = views.length - 1;
    else return;
    event.preventDefault();
    setActive(views[next]);
    tabs.current[next]?.focus();
  };
  return (
    <div className="editorial-preview-shell">
      <div className="editorial-preview-rail" aria-hidden="true">
        <span className="editorial-preview-wordmark">Valo</span>
        {[
          { Icon: LayoutDashboard, text: "Today" },
          {
            Icon: FileText,
            text: firm ? "Clients" : "Invoices",
            selected: true,
          },
          { Icon: ShieldCheck, text: "Compliance" },
          { Icon: FolderOpen, text: "Records" },
          { Icon: ListTodo, text: "Tasks" },
        ].map(({ Icon, text, selected }) => (
          <span className={selected ? "is-current" : ""} key={text}>
            <Icon size={15} />
            {text}
          </span>
        ))}
      </div>
      <div className="editorial-preview-main">
        <div className="editorial-demo-title">
          <div>
            <p className="editorial-label">
              {firm ? "Accountant workspace" : "INV-2026-041"}
            </p>
            <h3>{firm ? "Clients needing action" : "July design services"}</h3>
          </div>
          <span
            className={`editorial-status ${firm ? "is-progress" : "is-review"}`}
          >
            {firm ? "Client work" : "Needs review"}
          </span>
        </div>
        <div
          className="editorial-record-tabs"
          role="tablist"
          aria-label={firm ? "Client example views" : "Invoice example views"}
        >
          {views.map((view, index) => (
            <button
              key={view}
              ref={(node) => {
                tabs.current[index] = node;
              }}
              type="button"
              role="tab"
              id={`sample-${audience}-tab-${view}`}
              aria-controls={`sample-${audience}-panel-${view}`}
              aria-selected={active === view}
              tabIndex={active === view ? 0 : -1}
              onClick={() => setActive(view)}
              onKeyDown={(event) => keyDown(event, index)}
            >
              {view === "overview"
                ? "Overview"
                : view === "evidence"
                  ? "Evidence"
                  : "History"}
              {view === "evidence" && (
                <span className="editorial-tab-count">3</span>
              )}
            </button>
          ))}
        </div>
        <div className="editorial-record-panes">
          {views.map((view) => (
            <div
              key={view}
              id={`sample-${audience}-panel-${view}`}
              role="tabpanel"
              aria-labelledby={`sample-${audience}-tab-${view}`}
              aria-hidden={active !== view}
              tabIndex={active === view ? 0 : -1}
            >
              {view === "overview" ? (
                firm ? (
                  <ClientOverview />
                ) : (
                  <InvoiceOverview />
                )
              ) : view === "evidence" ? (
                <Evidence firm={firm} />
              ) : (
                <History firm={firm} />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
