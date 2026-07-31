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
//
// Response Desk (Task #207): the layout cursor, theme/header pieces and the
// register/receivables/payables/VAT section drawers are extracted to module
// level and EXPORTED so the obligation response bundle (modules/obligations/
// response-pack-pdf.ts) renders the same sections from the same code — the
// two papers can never disagree about how a month's figures are drawn.
// renderCompliancePackPdf is a composition of the pieces; its output bytes
// are pinned by the compliance-pack tests and the e2e journeys.
import PDFDocument from "pdfkit";
import { lagosMidnight } from "../../lib/lagos-time";
import { hslTripleToHex } from "./pdf";
import { OBLIGATION_DUE_SOON_DAYS } from "../obligations/obligations";
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

export interface PackTheme {
  brandName: string;
  primary: string;
  logoInitials: string;
}

// firms.theme jsonb -> the resolved brand triple both pack-family papers use.
export function resolvePackTheme(
  theme: Record<string, unknown> | null,
): PackTheme {
  const brandName = themeString(theme, "brandName") || DEFAULT_BRAND;
  const primary = hslTripleToHex(
    themeString(theme, "primary") || DEFAULT_PRIMARY_HSL,
  );
  const logoInitials =
    themeString(theme, "logoInitials").slice(0, 2).toUpperCase() ||
    initialsFor(brandName);
  return { brandName, primary, logoInitials };
}

// --- Formatting --------------------------------------------------------------
export function formatMoney(v: string | number): string {
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
export const MARGIN = 48;
export const PAGE_WIDTH = 595.28;
export const PAGE_HEIGHT = 841.89;
export const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;
export const PAGE_BOTTOM = PAGE_HEIGHT - MARGIN - 20;

// Register columns: number | kind | status | counterparty | ccy | amount.
export const COL = {
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
export function ensureRoom(
  doc: PDFKit.PDFDocument,
  y: number,
  needed: number,
): number {
  if (y + needed > PAGE_BOTTOM) {
    doc.addPage();
    return MARGIN;
  }
  return y;
}

export function drawRegisterHeader(doc: PDFKit.PDFDocument, y: number): number {
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

// --- Layout cursor factory ---------------------------------------------------
// The section/kvRow/emptyLine trio over ONE mutable cursor, shared by every
// drawer below. Callers position the cursor (layout.cursor.y = ...) after
// drawing their header/cover block, then hand the layout to the drawers.
export interface PackLayout {
  cursor: { y: number };
  // Section title + rule; page-breaks itself so a heading never strands at
  // the very bottom of a page.
  section(title: string): void;
  // Label left, value right — the totals-row idiom from pdf.ts, full width.
  kvRow(label: string, value: string, bold?: boolean): void;
  emptyLine(text: string): void;
}

export function packLayout(
  doc: PDFKit.PDFDocument,
  primary: string,
): PackLayout {
  const cursor = { y: MARGIN };

  const section = (title: string): void => {
    cursor.y = ensureRoom(doc, cursor.y, 60);
    doc
      .font("Helvetica-Bold")
      .fontSize(11)
      .fillColor(primary)
      .text(title.toUpperCase(), MARGIN, cursor.y, { width: CONTENT_WIDTH });
    const lineY = cursor.y + 15;
    doc
      .moveTo(MARGIN, lineY)
      .lineTo(PAGE_WIDTH - MARGIN, lineY)
      .lineWidth(0.7)
      .strokeColor(primary)
      .stroke();
    cursor.y = lineY + 8;
  };

  const kvRow = (label: string, value: string, bold = false): void => {
    cursor.y = ensureRoom(doc, cursor.y, 16);
    doc
      .font(bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(bold ? 10.5 : 9.5)
      .fillColor(bold ? primary : "#444444");
    doc.text(label, MARGIN, cursor.y, { width: CONTENT_WIDTH * 0.7 });
    doc.text(value, MARGIN, cursor.y, { width: CONTENT_WIDTH, align: "right" });
    cursor.y += bold ? 17 : 14;
  };

  const emptyLine = (text: string): void => {
    cursor.y = ensureRoom(doc, cursor.y, 14);
    doc
      .font("Helvetica-Oblique")
      .fontSize(9)
      .fillColor("#666666")
      .text(text, MARGIN, cursor.y, { width: CONTENT_WIDTH });
    cursor.y = doc.y + 6;
  };

  return { cursor, section, kvRow, emptyLine };
}

// --- Brand header ------------------------------------------------------------
// pdf.ts's block with a caller-chosen right-hand title/label. Returns the y
// where the caller's cover block resumes.
export function drawBrandHeader(
  doc: PDFKit.PDFDocument,
  theme: PackTheme,
  title: string,
  rightLabel: string,
): number {
  const headerY = MARGIN;
  doc.save();
  doc.roundedRect(MARGIN, headerY, 40, 40, 6).fill(theme.primary);
  doc
    .font("Helvetica-Bold")
    .fontSize(16)
    .fillColor("#ffffff")
    .text(theme.logoInitials, MARGIN, headerY + 12, {
      width: 40,
      align: "center",
    });
  doc.restore();
  doc
    .font("Helvetica-Bold")
    .fontSize(18)
    .fillColor("#222222")
    .text(theme.brandName, MARGIN + 52, headerY + 2, { width: 280 });
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
    .fillColor(theme.primary)
    .text(title, MARGIN, headerY, {
      width: CONTENT_WIDTH,
      align: "right",
    });
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor("#222222")
    .text(rightLabel, MARGIN, headerY + 20, {
      width: CONTENT_WIDTH,
      align: "right",
    });
  doc
    .moveTo(MARGIN, headerY + 52)
    .lineTo(PAGE_WIDTH - MARGIN, headerY + 52)
    .lineWidth(1.4)
    .strokeColor(theme.primary)
    .stroke();
  return headerY + 64;
}

// --- Section drawers ---------------------------------------------------------
// Each drawer takes (doc, layout, facts-slice) and leaves the cursor where
// the next section starts — trailing spacing included, so composition is a
// plain call sequence.

export function drawRegisterSection(
  doc: PDFKit.PDFDocument,
  layout: PackLayout,
  register: CompliancePackFacts["register"],
): void {
  const { cursor, section, emptyLine } = layout;
  section("Document register");
  if (register.rows.length === 0) {
    emptyLine("No invoices or credit notes were issued in this Lagos month.");
  } else {
    cursor.y = drawRegisterHeader(doc, cursor.y);
    doc.font("Helvetica").fontSize(8.5).fillColor("#222222");
    for (const row of register.rows) {
      const rowH = Math.max(
        doc.heightOfString(row.counterparty, { width: COL.party.w }),
        doc.heightOfString(row.invoiceNumber, { width: COL.no.w }),
        10,
      );
      if (cursor.y + rowH > PAGE_BOTTOM - 20) {
        doc.addPage();
        cursor.y = drawRegisterHeader(doc, MARGIN);
        doc.font("Helvetica").fontSize(8.5).fillColor("#222222");
      }
      doc.text(row.invoiceNumber, COL.no.x, cursor.y, { width: COL.no.w });
      doc.text(KIND_LABELS[row.kind] ?? row.kind, COL.kind.x, cursor.y, {
        width: COL.kind.w,
      });
      doc.text(row.status, COL.status.x, cursor.y, { width: COL.status.w });
      doc.text(row.counterparty, COL.party.x, cursor.y, { width: COL.party.w });
      doc.text(row.currency, COL.ccy.x, cursor.y, { width: COL.ccy.w });
      doc.text(formatMoney(row.grandTotal), COL.amount.x, cursor.y, {
        width: COL.amount.w,
        align: "right",
      });
      cursor.y += rowH + 5;
    }
    if (register.truncated) {
      emptyLine(
        `Register truncated: only the first ${register.rows.length} documents of the month are listed above.`,
      );
    }
  }
  cursor.y += 8;
}

export function drawReceivablesSection(
  doc: PDFKit.PDFDocument,
  layout: PackLayout,
  receivables: CompliancePackFacts["receivables"],
): void {
  const { cursor, section, kvRow, emptyLine } = layout;
  section("Receivables");
  if (receivables.groups.length === 0) {
    emptyLine("No outstanding receivables.");
  } else {
    for (const g of receivables.groups) {
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
    emptyLine(`Aged as of ${receivables.asOf} (Lagos calendar).`);
  }
  cursor.y += 8;
}

export function drawPayablesSection(
  doc: PDFKit.PDFDocument,
  layout: PackLayout,
  payables: CompliancePackFacts["payables"],
): void {
  const { cursor, section, kvRow, emptyLine } = layout;
  section("Payables");
  if (payables.groups.length === 0) {
    emptyLine("No unpaid supplier bills captured.");
  } else {
    for (const g of payables.groups) {
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
    if (payables.topSuppliers.length > 0) {
      cursor.y = ensureRoom(doc, cursor.y, 20);
      doc
        .font("Helvetica-Bold")
        .fontSize(8)
        .fillColor("#666666")
        .text("TOP SUPPLIERS", MARGIN, cursor.y);
      cursor.y += 12;
      for (const s of payables.topSuppliers) {
        kvRow(`  ${s.supplierName} — ${s.count} bill(s)`, formatMoney(s.amount));
      }
    }
  }
  cursor.y += 8;
}

export function drawVatSection(
  doc: PDFKit.PDFDocument,
  layout: PackLayout,
  vat: CompliancePackFacts["vat"],
): void {
  const { cursor, section, kvRow } = layout;
  section(`VAT position — ${vat.monthLabel}`);
  kvRow(
    `Output VAT (${vat.outputInvoiceCount} accepted invoice(s), credits netted)`,
    `NGN ${formatMoney(vat.outputVat)}`,
  );
  kvRow(
    `Input VAT (${vat.billCount} captured bill(s))`,
    `NGN ${formatMoney(vat.inputVat)}`,
  );
  kvRow(
    "  of which stamp-verified",
    `NGN ${formatMoney(vat.inputVatVerified)}`,
  );
  kvRow("  unverified", `NGN ${formatMoney(vat.inputVatUnverified)}`);
  kvRow("Net VAT (all input)", `NGN ${formatMoney(vat.netVat)}`);
  kvRow(
    "Defensible net VAT (verified input only)",
    `NGN ${formatMoney(vat.defensibleNetVat)}`,
    true,
  );
  kvRow(
    "Documents excluded for a missing FX rate",
    String(vat.excludedForFx),
  );
  // The basis disclosure travels IN the paper (the vat-note.ts rule): the
  // caveats must survive however the PDF is handed around.
  cursor.y = ensureRoom(doc, cursor.y, 40);
  doc
    .font("Helvetica")
    .fontSize(7.5)
    .fillColor("#666666")
    .text(vat.note, MARGIN, cursor.y, { width: CONTENT_WIDTH });
  cursor.y = doc.y + 10;
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
  const packTheme = resolvePackTheme(theme);

  const doc = new PDFDocument({
    size: "A4",
    margin: MARGIN,
    info: {
      Title: `COMPLIANCE PACK ${facts.monthLabel} — ${facts.clientName}`,
      Author: packTheme.brandName,
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
  const layout = packLayout(doc, packTheme.primary);
  const { cursor, section, kvRow, emptyLine } = layout;
  cursor.y = drawBrandHeader(doc, packTheme, "COMPLIANCE PACK", facts.monthLabel);

  // --- Cover block: who, which month, and the note ---------------------------
  doc
    .font("Helvetica-Bold")
    .fontSize(13)
    .fillColor("#222222")
    .text(facts.clientName, MARGIN, cursor.y, { width: CONTENT_WIDTH });
  cursor.y = doc.y + 2;
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#666666")
    .text(
      `Monthly compliance pack for ${facts.monthLabel} · Prepared by ${facts.firmName}`,
      MARGIN,
      cursor.y,
      { width: CONTENT_WIDTH },
    );
  cursor.y = doc.y + 10;
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor("#333333")
    .text(coverNote, MARGIN, cursor.y, { width: CONTENT_WIDTH });
  cursor.y = doc.y + 14;

  // --- The shared facts sections ---------------------------------------------
  drawRegisterSection(doc, layout, facts.register);
  drawReceivablesSection(doc, layout, facts.receivables);
  drawPayablesSection(doc, layout, facts.payables);
  drawVatSection(doc, layout, facts.vat);

  // --- Open obligations (Notice Desk) ----------------------------------------
  // As-of-render, not month-bound: an authority deadline is live whichever
  // month the pack describes, so an open obligation belongs in every pack
  // until it is answered.
  section("Open obligations");
  if (facts.obligations.open === 0) {
    emptyLine("No authority notices are awaiting a response.");
  } else {
    kvRow(
      `Open authority obligations (${facts.obligations.dueSoon} due within ${OBLIGATION_DUE_SOON_DAYS} days, ${facts.obligations.overdue} overdue)`,
      String(facts.obligations.open),
      true,
    );
    if (facts.obligations.nearestDue) {
      kvRow("Nearest response due", facts.obligations.nearestDue);
    }
    for (const row of facts.obligations.rows) {
      kvRow(
        `  ${row.authority} — ${row.noticeType}${row.reference ? ` (ref ${row.reference})` : ""}`,
        row.responseDueDate,
      );
    }
    if (facts.obligations.open > facts.obligations.rows.length) {
      emptyLine(
        `Showing ${facts.obligations.rows.length} of ${facts.obligations.open} open obligations — the full list lives in the app.`,
      );
    }
  }
  cursor.y += 8;

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
    `Generated by MeridianIQ for ${packTheme.brandName} · ${facts.clientName} · ${facts.monthLabel}`,
    MARGIN,
    PAGE_HEIGHT - MARGIN - 10,
    { width: CONTENT_WIDTH, align: "center", lineBreak: false },
  );

  doc.end();
  return done;
}
