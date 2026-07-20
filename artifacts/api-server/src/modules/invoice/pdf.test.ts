import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import {
  getDb,
  firmsTable,
  partiesTable,
  invoicesTable,
  invoiceLinesTable,
  stampRecordsTable,
} from "@workspace/db";
import { renderInvoicePdf, hslTripleToHex } from "./pdf.ts";
import invoicesRouter from "../../routes/invoices.ts";
import type { Principal } from "../auth/rbac.ts";
import {
  appFor,
  listen,
  closeAllServers,
} from "../../test-helpers/route-harness.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Branded invoice PDF. Pinned invariants:
//  - deterministic: identical spine rows render byte-identical buffers
//    (CreationDate pinned to invoice.updatedAt);
//  - the page text carries the brand name, invoice number, parties + TINs,
//    line descriptions and the grand total;
//  - stamped invoices carry IRN/CSID/rail and no draft banner; unstamped
//    invoices carry a clear UNSTAMPED watermark line and no IRN;
//  - route: same load/scope gate as GET /invoices/:id — 404 unknown, 403 for
//    a sibling client_user and a cross-firm principal (SEC-03), and the
//    response ships as an application/pdf attachment.

const SALT = makeRunSalt();

const firmA = randomUUID();
const firmB = randomUUID();
const supplier1 = randomUUID();
const supplier2 = randomUUID();
const buyerX = randomUUID();
const stampedId = randomUUID();
const draftId = randomUUID();
const invBId = randomUUID();

const BRAND = `Adeyemi & Co ${SALT}`;
const IRN = `IRN-PDF-${SALT.toUpperCase()}`;
const CSID = `csid-${SALT}`;

const firmAdmin: Principal = {
  userId: randomUUID(),
  role: "firm_admin",
  firmId: firmA,
  clientPartyId: null,
  buyerPartyId: null,
};
const clientS1: Principal = {
  userId: randomUUID(),
  role: "client_user",
  firmId: firmA,
  clientPartyId: supplier1,
  buyerPartyId: null,
};
const clientS2: Principal = {
  ...clientS1,
  userId: randomUUID(),
  clientPartyId: supplier2,
};
const adminB: Principal = { ...firmAdmin, userId: randomUUID(), firmId: firmB };

async function loadBundle(id: string) {
  const db = getDb();
  const [invoice] = await db
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.id, id));
  const lines = await db
    .select()
    .from(invoiceLinesTable)
    .where(eq(invoiceLinesTable.invoiceId, id))
    .orderBy(asc(invoiceLinesTable.lineNo));
  const parties = await db
    .select()
    .from(partiesTable)
    .where(
      inArray(partiesTable.id, [
        invoice.supplierPartyId,
        invoice.buyerPartyId,
      ]),
    );
  const supplier = parties.find((p) => p.id === invoice.supplierPartyId)!;
  const buyer = parties.find((p) => p.id === invoice.buyerPartyId)!;
  const stamps = await db
    .select()
    .from(stampRecordsTable)
    .where(eq(stampRecordsTable.invoiceId, id));
  return { invoice, lines, supplier, buyer, stamp: stamps[0] ?? null };
}

async function pdfText(buf: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const result = await parser.getText();
    return result.text ?? "";
  } finally {
    await parser.destroy().catch(() => {});
  }
}

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values([
    {
      id: firmA,
      name: `PDF Firm A ${SALT}`,
      theme: {
        brandName: BRAND,
        primary: "220 80% 40%",
        logoInitials: "AC",
      },
    },
    { id: firmB, name: `PDF Firm B ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    {
      id: supplier1,
      type: "client_business",
      legalName: `Lagos Widgets ${SALT}`,
      tin: `1234-${SALT}`,
    },
    {
      id: supplier2,
      type: "client_business",
      legalName: `Sibling Client ${SALT}`,
    },
    {
      id: buyerX,
      type: "buyer",
      legalName: `Abuja Retail ${SALT}`,
      tin: `5678-${SALT}`,
    },
  ]);
  const updatedAt = new Date("2026-06-06T09:00:00Z");
  await db.insert(invoicesTable).values([
    {
      id: stampedId,
      firmId: firmA,
      supplierPartyId: supplier1,
      buyerPartyId: buyerX,
      invoiceNumber: `INV-PDF-1-${SALT}`,
      issueDate: "2026-06-05",
      dueDate: "2026-07-05",
      status: "stamped" as never,
      subtotal: "450000.00",
      vatTotal: "33750.00",
      grandTotal: "483750.00",
      notes: `Payment within 30 days ${SALT}`,
      updatedAt,
    },
    {
      id: draftId,
      firmId: firmA,
      supplierPartyId: supplier1,
      buyerPartyId: buyerX,
      invoiceNumber: `INV-PDF-2-${SALT}`,
      issueDate: "2026-06-10",
      status: "draft" as never,
      subtotal: "10000.00",
      vatTotal: "750.00",
      grandTotal: "10750.00",
      updatedAt,
    },
    {
      id: invBId,
      firmId: firmB,
      supplierPartyId: supplier2,
      buyerPartyId: buyerX,
      invoiceNumber: `INV-PDF-B-${SALT}`,
      issueDate: "2026-06-10",
      status: "draft" as never,
      updatedAt,
    },
  ]);
  await db.insert(invoiceLinesTable).values([
    {
      invoiceId: stampedId,
      lineNo: 1,
      description: `Consulting retainer ${SALT}`,
      quantity: "1.0000",
      unitPrice: "300000.00",
      vatRate: "0.0750",
      lineExtension: "300000.00",
      vatAmount: "22500.00",
    },
    {
      invoiceId: stampedId,
      lineNo: 2,
      description: `On-site support hours ${SALT}`,
      quantity: "10.0000",
      unitPrice: "15000.00",
      vatRate: "0.0750",
      lineExtension: "150000.00",
      vatAmount: "11250.00",
    },
    {
      invoiceId: draftId,
      lineNo: 1,
      description: `Draft line ${SALT}`,
      quantity: "1.0000",
      unitPrice: "10000.00",
      vatRate: "0.0750",
      lineExtension: "10000.00",
      vatAmount: "750.00",
    },
    {
      invoiceId: invBId,
      lineNo: 1,
      description: `Firm B line ${SALT}`,
      quantity: "1.0000",
      unitPrice: "100.00",
      vatRate: "0",
      lineExtension: "100.00",
      vatAmount: "0.00",
    },
  ]);
  await db.insert(stampRecordsTable).values({
    invoiceId: stampedId,
    irn: IRN,
    csid: CSID,
    qrPayload: Buffer.from(JSON.stringify({ irn: IRN, csid: CSID })).toString(
      "base64",
    ),
    signedArtifactRef: `sig-${SALT}`,
    rail: "rail_primary",
    createdAt: new Date("2026-06-06T09:05:00Z"),
  });
});

after(async () => {
  await closeAllServers();
});

test("stamped invoice: brand, parties, lines, totals and stamp reference", async () => {
  const bundle = await loadBundle(stampedId);
  const pdf = await renderInvoicePdf({
    ...bundle,
    theme: { brandName: BRAND, primary: "220 80% 40%", logoInitials: "AC" },
  });
  assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.ok(pdf.length > 2_000 && pdf.length < 200_000, `size ${pdf.length}`);

  const text = await pdfText(pdf);
  assert.ok(text.includes(BRAND), "brand name from theme");
  assert.ok(text.includes(`INV-PDF-1-${SALT}`), "invoice number");
  assert.ok(text.includes(`Lagos Widgets ${SALT}`), "supplier name");
  assert.ok(text.includes(`Abuja Retail ${SALT}`), "buyer name");
  assert.ok(text.includes(`1234-${SALT}`), "supplier TIN");
  assert.ok(text.includes(`5678-${SALT}`), "buyer TIN");
  assert.ok(text.includes(`Consulting retainer ${SALT}`), "line description");
  assert.ok(text.includes("483,750.00"), "grand total");
  assert.ok(text.includes(`Payment within 30 days ${SALT}`), "notes");
  // Stamp block: IRN, CSID, rail — and no draft banner.
  assert.ok(text.includes(IRN), "IRN");
  assert.ok(text.includes(CSID), "CSID");
  assert.ok(text.includes("Primary rail"), "rail label");
  assert.ok(!text.includes("UNSTAMPED"), "no watermark on stamped paper");
});

test("unstamped invoice: clear watermark line, no stamp reference", async () => {
  const bundle = await loadBundle(draftId);
  const pdf = await renderInvoicePdf({ ...bundle, theme: null });
  const text = await pdfText(pdf);
  assert.ok(text.includes("UNSTAMPED"), "watermark line present");
  assert.ok(text.includes("DRAFT"), "draft wording present");
  assert.ok(!text.includes(IRN), "no IRN on unstamped paper");
  // Theme absent: sensible defaults still render.
  assert.ok(text.includes("MeridianIQ"), "default brand");
});

test("deterministic: identical inputs render byte-identical buffers", async () => {
  const bundle = await loadBundle(stampedId);
  const theme = { brandName: BRAND, primary: "220 80% 40%" };
  const a = await renderInvoicePdf({ ...bundle, theme });
  const b = await renderInvoicePdf({ ...bundle, theme });
  assert.ok(a.equals(b), "two renders of the same rows are identical");
});

test("hslTripleToHex: parses theme triples, falls back on garbage", () => {
  assert.equal(hslTripleToHex("0 0% 0%"), "#000000");
  assert.equal(hslTripleToHex("0 0% 100%"), "#ffffff");
  assert.equal(hslTripleToHex("0 100% 50%"), "#ff0000");
  // Garbage falls back to the default primary, never throws.
  assert.equal(hslTripleToHex("not-a-colour"), hslTripleToHex("152 60% 30%"));
});

test("route: application/pdf attachment behind the invoice-detail gate (SEC-03)", async () => {
  const asAdmin = await listen(appFor(firmAdmin, invoicesRouter));
  const asOwner = await listen(appFor(clientS1, invoicesRouter));
  const asSibling = await listen(appFor(clientS2, invoicesRouter));
  const asOtherFirm = await listen(appFor(adminB, invoicesRouter));

  const ok = await fetch(`${asAdmin}/invoices/${stampedId}/pdf`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "application/pdf");
  assert.ok(
    ok.headers
      .get("content-disposition")
      ?.startsWith(`attachment; filename="invoice-INV-PDF-1-`),
    `disposition: ${ok.headers.get("content-disposition")}`,
  );
  const body = Buffer.from(await ok.arrayBuffer());
  assert.equal(body.subarray(0, 5).toString("latin1"), "%PDF-");
  const text = await pdfText(body);
  assert.ok(text.includes(IRN), "route serves the stamped render");
  assert.ok(text.includes(BRAND), "route resolves the firm theme");

  // The supplier client_user downloads its own invoice...
  assert.equal(
    (await fetch(`${asOwner}/invoices/${stampedId}/pdf`)).status,
    200,
  );
  // ...a sibling client of the same firm does not (403, like GET /invoices/:id).
  assert.equal(
    (await fetch(`${asSibling}/invoices/${stampedId}/pdf`)).status,
    403,
  );
  // Cross-tenant principals are rejected too.
  assert.equal(
    (await fetch(`${asOtherFirm}/invoices/${stampedId}/pdf`)).status,
    403,
  );
  // Unknown invoice: 404.
  assert.equal(
    (await fetch(`${asAdmin}/invoices/${randomUUID()}/pdf`)).status,
    404,
  );
});
