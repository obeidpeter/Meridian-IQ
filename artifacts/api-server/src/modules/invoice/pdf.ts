// Branded invoice PDF (round-15 idea): the client-facing paper for an invoice
// the platform already holds — firm whitelabel branding from firms.theme,
// supplier/buyer identity, the line table and totals, and (when the invoice
// cleared the rails) the stamp reference with a verify QR. Deterministic by
// construction: pdfkit's only nondeterministic input is info.CreationDate,
// which is pinned to the invoice's own updatedAt, so the same spine rows
// always yield byte-identical output (the trailer file ID is an md5 of the
// info dictionary and inherits the pin). Rendering is pure — no DB access —
// so the route owns loading and every tenancy/SEC-03 gate.
import PDFDocument from "pdfkit";
import { create as createQr } from "qrcode";
import type { Invoice, InvoiceLine, Party } from "@workspace/db";

// Structural subset of a stamp_records row (lifecycle.ts) — keeps this module
// decoupled from the drizzle row type while accepting it directly.
export interface StampForPdf {
  irn: string;
  csid: string;
  qrPayload: string;
  rail: string;
  createdAt: Date;
}

export interface InvoicePdfInput {
  invoice: Invoice;
  lines: InvoiceLine[];
  supplier: Party;
  buyer: Party;
  stamp: StampForPdf | null;
  // firms.theme jsonb — brandName / primary / logoInitials, all optional.
  theme: Record<string, unknown> | null;
}

// --- Theme resolution --------------------------------------------------------
// Same defaults as the console whitelabel page: primary is an HSL triple
// ("152 60% 30%"), initials fall back to the brand name's first letters.
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

// "152 60% 30%" -> "#1e7a4c"-style hex. Anything unparseable falls back to
// the default primary so a malformed theme can never break rendering.
export function hslTripleToHex(triple: string): string {
  const HSL_RE = /^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/;
  // The default triple always matches, so the fallback can never recurse.
  const m = HSL_RE.exec(triple.trim()) ?? HSL_RE.exec(DEFAULT_PRIMARY_HSL)!;
  const h = Number(m[1]) % 360;
  const s = Math.min(100, Number(m[2])) / 100;
  const l = Math.min(100, Number(m[3])) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m0 = l - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  const hex = (v: number) =>
    Math.round((v + m0) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

// --- Formatting --------------------------------------------------------------
function formatMoney(v: string | number): string {
  const n = Number(v);
  return (Number.isFinite(n) ? n : 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatQty(v: string | number): string {
  const n = Number(v);
  return (Number.isFinite(n) ? n : 0).toLocaleString("en-US", {
    maximumFractionDigits: 4,
  });
}

/** Fraction "0.075" -> "7.5%". */
function formatVatRate(v: string | number): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  const pct = n * 100;
  return `${Number(pct.toFixed(2))}%`;
}

const KIND_LABELS: Record<string, string> = {
  invoice: "TAX INVOICE",
  credit_note: "CREDIT NOTE",
  correction: "CORRECTION",
};

const RAIL_LABELS: Record<string, string> = {
  rail_primary: "Primary rail",
  rail_secondary: "Secondary rail",
};

// --- Layout constants (A4) ---------------------------------------------------
const MARGIN = 48;
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;
const PAGE_BOTTOM = PAGE_HEIGHT - MARGIN - 20;

// Line-table columns: description | qty | unit price | VAT | amount.
const COL = {
  desc: { x: MARGIN, w: 230 },
  qty: { x: MARGIN + 236, w: 48 },
  unit: { x: MARGIN + 290, w: 88 },
  vat: { x: MARGIN + 384, w: 42 },
  amount: { x: MARGIN + 432, w: CONTENT_WIDTH - 432 },
} as const;

// Draw the QR symbol as vector rects — no raster/PNG dependency, and byte
// deterministic. `qrcode.create` is the pure encoder (no renderer involved).
function drawQr(
  doc: PDFKit.PDFDocument,
  content: string,
  x: number,
  y: number,
  size: number,
): void {
  const qr = createQr(content, { errorCorrectionLevel: "M" });
  const modules = qr.modules;
  const cell = size / modules.size;
  doc.save();
  doc.rect(x - 4, y - 4, size + 8, size + 8).fill("#ffffff");
  doc.fillColor("#000000");
  for (let row = 0; row < modules.size; row++) {
    for (let col = 0; col < modules.size; col++) {
      if (modules.data[row * modules.size + col]) {
        doc.rect(x + col * cell, y + row * cell, cell, cell);
      }
    }
  }
  doc.fill("#000000");
  doc.restore();
}

function drawTableHeader(doc: PDFKit.PDFDocument, y: number): number {
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#666666");
  doc.text("DESCRIPTION", COL.desc.x, y, { width: COL.desc.w });
  doc.text("QTY", COL.qty.x, y, { width: COL.qty.w, align: "right" });
  doc.text("UNIT PRICE", COL.unit.x, y, { width: COL.unit.w, align: "right" });
  doc.text("VAT", COL.vat.x, y, { width: COL.vat.w, align: "right" });
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
 * Render one invoice to a PDF buffer. Pure and deterministic: identical
 * inputs produce byte-identical output (CreationDate is pinned to the
 * invoice's updatedAt).
 */
export async function renderInvoicePdf(
  input: InvoicePdfInput,
): Promise<Buffer> {
  const { invoice, lines, supplier, buyer, stamp, theme } = input;
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
      Title: `${KIND_LABELS[invoice.kind] ?? "INVOICE"} ${invoice.invoiceNumber}`,
      Author: brandName,
      // Determinism pin: pdfkit defaults CreationDate to `new Date()`, which
      // would make every render unique. The invoice's updatedAt is the honest
      // "as of" instant and stable per row version.
      CreationDate: invoice.updatedAt,
    },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  // Background watermark FIRST so content paints over it. One clear line —
  // an unstamped document must never pass for fiscal paper.
  if (!stamp) {
    doc.save();
    doc.rotate(-28, { origin: [PAGE_WIDTH / 2, PAGE_HEIGHT / 2] });
    doc
      .font("Helvetica-Bold")
      .fontSize(52)
      .fillColor("#ececec")
      .text("DRAFT — UNSTAMPED", 0, PAGE_HEIGHT / 2 - 30, {
        width: PAGE_WIDTH,
        align: "center",
      });
    doc.restore();
  }

  // --- Brand header ----------------------------------------------------------
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
    .text(KIND_LABELS[invoice.kind] ?? "INVOICE", MARGIN, headerY, {
      width: CONTENT_WIDTH,
      align: "right",
    });
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor("#222222")
    .text(`No. ${invoice.invoiceNumber}`, MARGIN, headerY + 20, {
      width: CONTENT_WIDTH,
      align: "right",
    });
  doc
    .moveTo(MARGIN, headerY + 52)
    .lineTo(PAGE_WIDTH - MARGIN, headerY + 52)
    .lineWidth(1.4)
    .strokeColor(primary)
    .stroke();

  // Unstamped banner line under the header (in-flow, always extractable).
  let y = headerY + 62;
  if (!stamp) {
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor("#b3261e")
      .text(
        `${(invoice.status === "draft" || invoice.status === "validated" ? "DRAFT" : invoice.status.toUpperCase())} — UNSTAMPED: this document has not been stamped on the e-invoicing rails and is not fiscal evidence.`,
        MARGIN,
        y,
        { width: CONTENT_WIDTH },
      );
    y = doc.y + 8;
  }

  // --- Supplier / buyer blocks ----------------------------------------------
  const colW = CONTENT_WIDTH / 2 - 10;
  const blockTop = y + 4;
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#666666");
  doc.text("FROM (SUPPLIER)", MARGIN, blockTop);
  doc.text("BILL TO (BUYER)", MARGIN + colW + 20, blockTop);
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#222222");
  doc.text(supplier.legalName, MARGIN, blockTop + 12, { width: colW });
  const afterSupplierName = doc.y;
  doc.text(buyer.legalName, MARGIN + colW + 20, blockTop + 12, {
    width: colW,
  });
  const afterBuyerName = Math.max(doc.y, afterSupplierName);
  doc.font("Helvetica").fontSize(9).fillColor("#444444");
  doc.text(`TIN: ${supplier.tin ?? "—"}`, MARGIN, afterBuyerName + 2, {
    width: colW,
  });
  doc.text(`TIN: ${buyer.tin ?? "—"}`, MARGIN + colW + 20, afterBuyerName + 2, {
    width: colW,
  });
  y = doc.y + 10;

  // --- Meta row --------------------------------------------------------------
  const meta: Array<[string, string]> = [
    ["Issue date", invoice.issueDate],
    ["Due date", invoice.dueDate ?? "—"],
    ["Status", invoice.status.toUpperCase()],
    ["Currency", invoice.currency],
  ];
  const metaW = CONTENT_WIDTH / meta.length;
  meta.forEach(([label, value], i) => {
    const x = MARGIN + i * metaW;
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#666666");
    doc.text(label.toUpperCase(), x, y, { width: metaW - 8 });
    doc.font("Helvetica").fontSize(10).fillColor("#222222");
    doc.text(value, x, y + 11, { width: metaW - 8 });
  });
  y += 32;

  // --- Line table ------------------------------------------------------------
  y = drawTableHeader(doc, y);
  doc.font("Helvetica").fontSize(9).fillColor("#222222");
  for (const line of lines) {
    const rowH = Math.max(
      doc.heightOfString(line.description, { width: COL.desc.w }),
      11,
    );
    if (y + rowH > PAGE_BOTTOM - 40) {
      doc.addPage();
      y = drawTableHeader(doc, MARGIN);
      doc.font("Helvetica").fontSize(9).fillColor("#222222");
    }
    doc.text(line.description, COL.desc.x, y, { width: COL.desc.w });
    doc.text(formatQty(line.quantity), COL.qty.x, y, {
      width: COL.qty.w,
      align: "right",
    });
    doc.text(formatMoney(line.unitPrice), COL.unit.x, y, {
      width: COL.unit.w,
      align: "right",
    });
    doc.text(formatVatRate(line.vatRate), COL.vat.x, y, {
      width: COL.vat.w,
      align: "right",
    });
    doc.text(formatMoney(line.lineExtension), COL.amount.x, y, {
      width: COL.amount.w,
      align: "right",
    });
    y += rowH + 6;
  }
  doc
    .moveTo(MARGIN, y)
    .lineTo(PAGE_WIDTH - MARGIN, y)
    .lineWidth(0.7)
    .strokeColor("#999999")
    .stroke();
  y += 8;

  // --- Totals ----------------------------------------------------------------
  if (y > PAGE_BOTTOM - 90) {
    doc.addPage();
    y = MARGIN;
  }
  const totalsX = COL.unit.x;
  const totalsW = PAGE_WIDTH - MARGIN - totalsX;
  const totalRow = (label: string, value: string, bold = false) => {
    doc
      .font(bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(bold ? 11 : 9.5)
      .fillColor(bold ? primary : "#444444");
    doc.text(label, totalsX, y, { width: totalsW * 0.55 });
    doc.text(value, totalsX, y, { width: totalsW, align: "right" });
    y += bold ? 18 : 14;
  };
  totalRow("Subtotal", `${invoice.currency} ${formatMoney(invoice.subtotal)}`);
  totalRow("VAT", `${invoice.currency} ${formatMoney(invoice.vatTotal)}`);
  totalRow(
    "Grand total",
    `${invoice.currency} ${formatMoney(invoice.grandTotal)}`,
    true,
  );

  // --- Notes -----------------------------------------------------------------
  if (invoice.notes) {
    y += 6;
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#666666");
    doc.text("NOTES", MARGIN, y);
    doc.font("Helvetica").fontSize(9).fillColor("#444444");
    doc.text(invoice.notes, MARGIN, y + 11, { width: CONTENT_WIDTH });
    y = doc.y + 10;
  } else {
    y += 10;
  }

  // --- Stamp block -----------------------------------------------------------
  if (stamp) {
    const qrSize = 84;
    const boxH = qrSize + 24;
    if (y + boxH > PAGE_BOTTOM) {
      doc.addPage();
      y = MARGIN;
    }
    doc.save();
    doc
      .roundedRect(MARGIN, y, CONTENT_WIDTH, boxH, 6)
      .lineWidth(1)
      .strokeColor(primary)
      .stroke();
    doc.restore();
    const textX = MARGIN + 14;
    const textW = CONTENT_WIDTH - qrSize - 44;
    doc.font("Helvetica-Bold").fontSize(10).fillColor(primary);
    doc.text("STAMPED E-INVOICE", textX, y + 12, { width: textW });
    doc.font("Helvetica").fontSize(9).fillColor("#222222");
    doc.text(`IRN: ${stamp.irn}`, textX, y + 28, { width: textW });
    doc.text(`CSID: ${stamp.csid}`, textX, doc.y + 2, { width: textW });
    doc.text(
      `Rail: ${RAIL_LABELS[stamp.rail] ?? stamp.rail} · Stamped ${stamp.createdAt.toISOString().slice(0, 10)}`,
      textX,
      doc.y + 2,
      { width: textW },
    );
    doc.fontSize(8).fillColor("#666666");
    doc.text(
      "Verify at /verify-stamp with the IRN and CSID above, or scan the QR.",
      textX,
      doc.y + 4,
      { width: textW },
    );
    // The rail-issued QR payload is the canonical verify content; fall back
    // to an IRN/CSID verify reference if a legacy row has none.
    const qrContent =
      stamp.qrPayload ||
      JSON.stringify({ verify: "/verify-stamp", irn: stamp.irn, csid: stamp.csid });
    drawQr(
      doc,
      qrContent,
      PAGE_WIDTH - MARGIN - qrSize - 14,
      y + (boxH - qrSize) / 2,
      qrSize,
    );
    y += boxH + 10;
  }

  // --- Footer ----------------------------------------------------------------
  doc.font("Helvetica").fontSize(7.5).fillColor("#999999");
  doc.text(
    `Generated by MeridianIQ for ${brandName} · ${supplier.legalName} · ${invoice.invoiceNumber}`,
    MARGIN,
    PAGE_HEIGHT - MARGIN - 10,
    { width: CONTENT_WIDTH, align: "center", lineBreak: false },
  );

  doc.end();
  return done;
}

// Ships a PDF as a file download — the binary sibling of lib/csv.ts
// sendCsvAttachment (which is string-only by design). Structurally typed so
// this module needs no express import.
export function sendPdfAttachment(
  res: {
    setHeader(name: string, value: string): unknown;
    send(body: Buffer): unknown;
  },
  filename: string,
  pdf: Buffer,
): void {
  res.setHeader("Content-Type", "application/pdf");
  // Filenames derive from invoice numbers (free text): strip anything that
  // could break the header quoting.
  const safe = filename.replace(/[^A-Za-z0-9._-]+/g, "-");
  res.setHeader("Content-Disposition", `attachment; filename="${safe}"`);
  res.send(pdf);
}
