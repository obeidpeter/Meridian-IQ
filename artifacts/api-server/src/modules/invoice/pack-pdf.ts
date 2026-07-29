// Monthly compliance-pack PDF (contract 0.45.0): the client-facing paper for
// one client's computed month — firm whitelabel branding from firms.theme, the
// cover note, then one section per facts group (document register, receivables
// aging, payables commitments, VAT position, deadlines). Same conventions as
// the branded invoice PDF (pdf.ts): A4 + Helvetica, theme resolution with the
// hslTripleToHex fallback chain, and a deterministic info.CreationDate —
// pinned here to Lagos midnight on the month start, so pdfkit's only
// nondeterministic input is fixed and identical facts render byte-identical
// buffers (the facts themselves carry "as of" dates where honesty needs
// them). Rendering is pure — no DB access — so the route owns loading and
// every tenancy/SEC-03 gate.
import PDFDocument from "pdfkit";
import { lagosMidnight } from "../../lib/lagos-time";
import { hslTripleToHex } from "./pdf";
import type { CompliancePackFacts } from "./compliance-pack";

// --- Theme resolution --------------------------------------------------------
// Mirrors pdf.ts (its DEFAULT_* constants and helpers are module-private by
// design); hslTripleToHex is the shared, exported piece so a malformed theme
// falls back identically on both papers.
const DEFAULT_PRIMARY_HSL = "152 60% 30%";
const DEFAULT_BRAND = "MeridianIQ";

function themeString(
  theme: Record<string, unknown> | null,
  key: string,
): string {
  const v = theme?.[key];
  return typeof v === "string" ? v.trim() : "";
}

function initialsFor(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  const initials = parts.map((p) => p[0]).join("");
  return (initials || "MQ").slice(0, 2).toUpperCase();
}

// --- Formatting --------------------------------------------------------------
function formatMoney(v: string | number): string {
  const n = Number(v);
  return (Number.isFinite(n) ? n : 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

const KIND_LABELS: Record<string, string> = {
  invoice: "Invoice",
  credit_note: "Credit note",
};

// --- Layout constants (A4, pdf.ts's grid) ------------------------------------
const MARGIN = 48;
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;
const PAGE_BOTTOM = PAGE_HEIGHT - MARGIN - 20;

// Register columns: number | kind | status | counterparty | ccy | amount.
const COL = {
  no: { x: MARGIN, w: 100 },
  kind: { x: MARGIN + 106, w: 52 },
  status: { x: MARGIN + 162, w: 58 },
  party: { x: MARGIN + 224, w: 158 },
  ccy: { x: MARGIN + 388, w: 32 },
  amount: { x: MARGIN + 424, w: CONTENT_WIDTH - 424 },
} as const;

export interface CompliancePackPdfInput {
  facts: CompliancePackFacts;
  // The (possibly Clerk-phrased, always template-backed) cover note text —
  // drafted by clerk/pack-note.ts; this module never touches a model.
  coverNote: string;
  // firms.theme jsonb — brandName / primary / logoInitials, all optional.
  theme: Record<string, unknown> | null;
}

// Start a new page when fewer than `needed` points remain under the cursor.
function ensureRoom(doc: PDFKit.PDFDocument, y: number, needed: number): number {
  if (y + needed > PAGE_BOTTOM) {
    doc.addPage();
    return MARGIN;
  }
  return y;
}

function drawRegisterHeader(doc: PDFKit.PDFDocument, y: number): number {
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#666666");
  doc.text("NUMBER", COL.no.x, y, { width: COL.no.w });
  doc.text("KIND", COL.kind.x, y, { width: COL.kind.w });
  doc.text("STATUS", COL.status.x, y, { width: COL.status.w });
  doc.text("COUNTERPARTY", COL.party.x, y, { width: COL.party.w });
  doc.text("CCY", COL.ccy.x, y, { width: COL.ccy.w });
  doc.text("AMOUNT", COL.amount.x, y, { width: COL.amount.w, align: "right" });
  const lineY = y + 12;
  doc
    .moveTo(MARGIN, lineY)
    .lineTo(PAGE_WIDTH - MARGIN, lineY)
    .lineWidth(0.7)
    .strokeColor("#999999")
    .stroke();
  return lineY + 6;
}

/**
 * Render one client's compliance pack to a PDF buffer. Pure and
 * deterministic: identical inputs produce byte-identical output
 * (CreationDate pinned to Lagos midnight on the month start).
 */
export async function renderCompliancePackPdf(
  input: CompliancePackPdfInput,
): Promise<Buffer> {
  const { facts, coverNote, theme } = input;
  const brandName = themeString(theme, "brandName") || DEFAULT_BRAND;
  const primary = hslTripleToHex(
    themeString(theme, "primary") || DEFAULT_PRIMARY_HSL,
  );
  const logoInitials =
    themeString(theme, "logoInitials").slice(0, 2).toUpperCase() ||
    initialsFor(brandName);

  const doc = new PDFDocument({
    size: "A4",
    margin: MARGIN,
    info: {
      Title: `COMPLIANCE PACK ${facts.monthLabel} — ${facts.clientName}`,
      Author: brandName,
      // Determinism pin: pdfkit defaults CreationDate to `new Date()`, which
      // would make every render unique. The month the pack describes is the
      // honest anchor and stable per request.
      CreationDate: lagosMidnight(facts.monthStart),
    },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  // --- Brand header (pdf.ts's block, pack-titled) ----------------------------
  const headerY = MARGIN;
  doc.save();
  doc.roundedRect(MARGIN, headerY, 40, 40, 6).fill(primary);
  doc
    .font("Helvetica-Bold")
    .fontSize(16)
    .fillColor("#ffffff")
    .text(logoInitials, MARGIN, headerY + 12, { width: 40, align: "center" });
  doc.restore();
  doc
    .font("Helvetica-Bold")
    .fontSize(18)
    .fillColor("#222222")
    .text(brandName, MARGIN + 52, headerY + 2, { width: 280 });
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#666666")
    .text("E-invoicing compliance by MeridianIQ", MARGIN + 52, headerY + 24, {
      width: 280,
    });
  doc
    .font("Helvetica-Bold")
    .fontSize(14)
    .fillColor(primary)
    .text("COMPLIANCE PACK", MARGIN, headerY, {
      width: CONTENT_WIDTH,
      align: "right",
    });
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor("#222222")
    .text(facts.monthLabel, MARGIN, headerY + 20, {
      width: CONTENT_WIDTH,
      align: "right",
    });
  doc
    .moveTo(MARGIN, headerY + 52)
    .lineTo(PAGE_WIDTH - MARGIN, headerY + 52)
    .lineWidth(1.4)
    .strokeColor(primary)
    .stroke();

  // --- Cover block: who, which month, and the note ---------------------------
  let y = headerY + 64;
  doc
    .font("Helvetica-Bold")
    .fontSize(13)
    .fillColor("#222222")
    .text(facts.clientName, MARGIN, y, { width: CONTENT_WIDTH });
  y = doc.y + 2;
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#666666")
    .text(
      `Monthly compliance pack for ${facts.monthLabel} · Prepared by ${facts.firmName}`,
      MARGIN,
      y,
      { width: CONTENT_WIDTH },
    );
  y = doc.y + 10;
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor("#333333")
    .text(coverNote, MARGIN, y, { width: CONTENT_WIDTH });
  y = doc.y + 14;

  // Section title + rule; page-breaks itself so a heading never strands at
  // the very bottom of a page.
  const section = (title: string): void => {
    y = ensureRoom(doc, y, 60);
    doc
      .font("Helvetica-Bold")
      .fontSize(11)
      .fillColor(primary)
      .text(title.toUpperCase(), MARGIN, y, { width: CONTENT_WIDTH });
    const lineY = y + 15;
    doc
      .moveTo(MARGIN, lineY)
      .lineTo(PAGE_WIDTH - MARGIN, lineY)
      .lineWidth(0.7)
      .strokeColor(primary)
      .stroke();
    y = lineY + 8;
  };

  // Label left, value right — the totals-row idiom from pdf.ts, full width.
  const kvRow = (label: string, value: string, bold = false): void => {
    y = ensureRoom(doc, y, 16);
    doc
      .font(bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(bold ? 10.5 : 9.5)
      .fillColor(bold ? primary : "#444444");
    doc.text(label, MARGIN, y, { width: CONTENT_WIDTH * 0.7 });
    doc.text(value, MARGIN, y, { width: CONTENT_WIDTH, align: "right" });
    y += bold ? 17 : 14;
  };

  const emptyLine = (text: string): void => {
    y = ensureRoom(doc, y, 14);
    doc
      .font("Helvetica-Oblique")
      .fontSize(9)
      .fillColor("#666666")
      .text(text, MARGIN, y, { width: CONTENT_WIDTH });
    y = doc.y + 6;
  };

  // --- Document register -----------------------------------------------------
  section("Document register");
  if (facts.register.rows.length === 0) {
    emptyLine("No invoices or credit notes were issued in this Lagos month.");
  } else {
    y = drawRegisterHeader(doc, y);
    doc.font("Helvetica").fontSize(8.5).fillColor("#222222");
    for (const row of facts.register.rows) {
      const rowH = Math.max(
        doc.heightOfString(row.counterparty, { width: COL.party.w }),
        doc.heightOfString(row.invoiceNumber, { width: COL.no.w }),
        10,
      );
      if (y + rowH > PAGE_BOTTOM - 20) {
        doc.addPage();
        y = drawRegisterHeader(doc, MARGIN);
        doc.font("Helvetica").fontSize(8.5).fillColor("#222222");
      }
      doc.text(row.invoiceNumber, COL.no.x, y, { width: COL.no.w });
      doc.text(KIND_LABELS[row.kind] ?? row.kind, COL.kind.x, y, {
        width: COL.kind.w,
      });
      doc.text(row.status, COL.status.x, y, { width: COL.status.w });
      doc.text(row.counterparty, COL.party.x, y, { width: COL.party.w });
      doc.text(row.currency, COL.ccy.x, y, { width: COL.ccy.w });
      doc.text(formatMoney(row.grandTotal), COL.amount.x, y, {
        width: COL.amount.w,
        align: "right",
      });
      y += rowH + 5;
    }
    if (facts.register.truncated) {
      emptyLine(
        `Register truncated: only the first ${facts.register.rows.length} documents of the month are listed above.`,
      );
    }
  }
  y += 8;

  // --- Receivables aging -----------------------------------------------------
  section("Receivables");
  if (facts.receivables.groups.length === 0) {
    emptyLine("No outstanding receivables.");
  } else {
    for (const g of facts.receivables.groups) {
      kvRow(
        `${g.currency} outstanding (${g.invoiceCount} invoice(s))`,
        `${g.currency} ${formatMoney(g.outstandingTotal)}`,
        true,
      );
      kvRow(
        `  Current (up to 30 days) — ${g.buckets.current.count} invoice(s)`,
        formatMoney(g.buckets.current.amount),
      );
      kvRow(
        `  31–60 days — ${g.buckets.days31to60.count} invoice(s)`,
        formatMoney(g.buckets.days31to60.amount),
      );
      kvRow(
        `  61–90 days — ${g.buckets.days61to90.count} invoice(s)`,
        formatMoney(g.buckets.days61to90.amount),
      );
      kvRow(
        `  Over 90 days — ${g.buckets.days90plus.count} invoice(s)`,
        formatMoney(g.buckets.days90plus.amount),
      );
    }
    emptyLine(`Aged as of ${facts.receivables.asOf} (Lagos calendar).`);
  }
  y += 8;

  // --- Payables commitments --------------------------------------------------
  section("Payables");
  if (facts.payables.groups.length === 0) {
    emptyLine("No unpaid supplier bills captured.");
  } else {
    for (const g of facts.payables.groups) {
      kvRow(
        `${g.currency} unpaid bills (${g.total.count})`,
        `${g.currency} ${formatMoney(g.total.amount)}`,
        true,
      );
      kvRow(`  Overdue — ${g.overdue.count} bill(s)`, formatMoney(g.overdue.amount));
      for (const w of g.dueWeeks) {
        kvRow(
          `  Week of ${w.startDate} — ${w.count} bill(s)`,
          formatMoney(w.amount),
        );
      }
      kvRow(
        `  Later or undated — ${g.later.count} bill(s)`,
        formatMoney(g.later.amount),
      );
    }
    if (facts.payables.topSuppliers.length > 0) {
      y = ensureRoom(doc, y, 20);
      doc
        .font("Helvetica-Bold")
        .fontSize(8)
        .fillColor("#666666")
        .text("TOP SUPPLIERS", MARGIN, y);
      y += 12;
      for (const s of facts.payables.topSuppliers) {
        kvRow(`  ${s.supplierName} — ${s.count} bill(s)`, formatMoney(s.amount));
      }
    }
  }
  y += 8;

  // --- VAT position ----------------------------------------------------------
  section(`VAT position — ${facts.vat.monthLabel}`);
  kvRow(
    `Output VAT (${facts.vat.outputInvoiceCount} accepted invoice(s), credits netted)`,
    `NGN ${formatMoney(facts.vat.outputVat)}`,
  );
  kvRow(
    `Input VAT (${facts.vat.billCount} captured bill(s))`,
    `NGN ${formatMoney(facts.vat.inputVat)}`,
  );
  kvRow(
    "  of which stamp-verified",
    `NGN ${formatMoney(facts.vat.inputVatVerified)}`,
  );
  kvRow("  unverified", `NGN ${formatMoney(facts.vat.inputVatUnverified)}`);
  kvRow("Net VAT (all input)", `NGN ${formatMoney(facts.vat.netVat)}`);
  kvRow(
    "Defensible net VAT (verified input only)",
    `NGN ${formatMoney(facts.vat.defensibleNetVat)}`,
    true,
  );
  kvRow(
    "Documents excluded for a missing FX rate",
    String(facts.vat.excludedForFx),
  );
  // The basis disclosure travels IN the paper (the vat-note.ts rule): the
  // caveats must survive however the PDF is handed around.
  y = ensureRoom(doc, y, 40);
  doc
    .font("Helvetica")
    .fontSize(7.5)
    .fillColor("#666666")
    .text(facts.vat.note, MARGIN, y, { width: CONTENT_WIDTH });
  y = doc.y + 10;

  // --- Deadlines -------------------------------------------------------------
  section("Deadlines");
  kvRow(
    "Next VAT return and remittance due (FIRS, 21st of the following month)",
    facts.deadlines.nextVatReturnDue,
    true,
  );
  kvRow(
    "Documents awaiting submission to the e-invoicing rails",
    String(facts.deadlines.unsubmittedReceivables),
  );

  // --- Footer ----------------------------------------------------------------
  doc.font("Helvetica").fontSize(7.5).fillColor("#999999");
  doc.text(
    `Generated by MeridianIQ for ${brandName} · ${facts.clientName} · ${facts.monthLabel}`,
    MARGIN,
    PAGE_HEIGHT - MARGIN - 10,
    { width: CONTENT_WIDTH, align: "center", lineBreak: false },
  );

  doc.end();
  return done;
}
