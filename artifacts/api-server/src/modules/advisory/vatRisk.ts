import { parseCsv } from "../../lib/csv.ts";

// VAT-risk check engine (ADV-02). Ingests a buyer's supplier ledger (CSV or
// structured rows), verifies each invoice's stamp status via CORE-04, computes
// input-VAT at risk, and produces an exposure report plus a buyer-supplier
// graph. The stamp check is injected (a Set of valid "irn|csid" keys) so the
// computation is pure and the total exposure is deterministically recomputable.

export interface LedgerRow {
  supplierTin?: string;
  supplierName?: string;
  invoiceNumber?: string;
  irn?: string;
  csid?: string;
  invoiceAmount?: number;
  vatAmount?: number;
}

export interface RowResult {
  rowNumber: number;
  invoiceNumber: string;
  supplierTin: string;
  supplierName?: string;
  irn: string;
  csid: string;
  invoiceAmount: number;
  vatAmount: number;
  stampValid: boolean;
  status: "verified" | "at_risk" | "invalid_input";
  vatAtRisk: number;
  detail?: string;
}

export interface GraphNode {
  id: string;
  label: string;
  kind: "buyer" | "supplier";
  invoiceCount: number;
  totalAmount: number;
  totalVatAtRisk: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  invoiceCount: number;
  totalAmount: number;
  vatAtRisk: number;
}

export interface VatRiskReportShape {
  buyerName?: string;
  rowCount: number;
  verifiedCount: number;
  atRiskCount: number;
  invalidCount: number;
  totalVatAmount: number;
  totalVatAtRisk: number;
  rows: RowResult[];
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
}

function money(n: number): number {
  return Math.round(n * 100) / 100;
}

export function stampKey(irn: string, csid: string): string {
  return `${irn}|${csid}`;
}

const COLUMN_ALIASES: Record<string, keyof LedgerRow> = {
  suppliertin: "supplierTin",
  supplier: "supplierName",
  suppliername: "supplierName",
  invoicenumber: "invoiceNumber",
  invoiceno: "invoiceNumber",
  invoice: "invoiceNumber",
  irn: "irn",
  csid: "csid",
  invoiceamount: "invoiceAmount",
  amount: "invoiceAmount",
  total: "invoiceAmount",
  vatamount: "vatAmount",
  vat: "vatAmount",
};

function normalizeHeader(h: string): keyof LedgerRow | null {
  const key = h.toLowerCase().replace(/[^a-z]/g, "");
  return COLUMN_ALIASES[key] ?? null;
}

export function parseLedgerCsv(csv: string): LedgerRow[] {
  const grid = parseCsv(csv);
  if (grid.length === 0) return [];
  const header = grid[0].map(normalizeHeader);
  const out: LedgerRow[] = [];
  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r];
    const obj: LedgerRow = {};
    for (let c = 0; c < header.length; c++) {
      const field = header[c];
      if (!field) continue;
      const raw = (cells[c] ?? "").trim();
      if (field === "invoiceAmount" || field === "vatAmount") {
        const num = Number(raw.replace(/[₦,\s]/g, ""));
        obj[field] = Number.isFinite(num) ? num : undefined;
      } else {
        obj[field] = raw || undefined;
      }
    }
    out.push(obj);
  }
  return out;
}

function isValidRow(row: LedgerRow): boolean {
  return Boolean(
    row.invoiceNumber &&
      row.supplierTin &&
      row.irn &&
      row.csid &&
      typeof row.invoiceAmount === "number" &&
      Number.isFinite(row.invoiceAmount) &&
      row.invoiceAmount >= 0 &&
      typeof row.vatAmount === "number" &&
      Number.isFinite(row.vatAmount) &&
      row.vatAmount >= 0,
  );
}

// Analyze the ledger against the set of valid stamp keys. Input-VAT at risk is
// the VAT on any invoice that is not backed by a verified stamp: those input
// claims are disallowable, so the buyer's exposure is their sum.
export function analyzeLedger(
  rows: LedgerRow[],
  validStamps: Set<string>,
  buyerName?: string,
): VatRiskReportShape {
  const results: RowResult[] = [];
  const buyerId = "buyer";
  const buyerLabel = buyerName ?? "Buyer";
  const supplierNodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();

  let verifiedCount = 0;
  let atRiskCount = 0;
  let invalidCount = 0;
  let totalVatAmount = 0;
  let totalVatAtRisk = 0;

  rows.forEach((row, i) => {
    const rowNumber = i + 1;
    if (!isValidRow(row)) {
      invalidCount++;
      results.push({
        rowNumber,
        invoiceNumber: row.invoiceNumber ?? "",
        supplierTin: row.supplierTin ?? "",
        supplierName: row.supplierName,
        irn: row.irn ?? "",
        csid: row.csid ?? "",
        invoiceAmount: row.invoiceAmount ?? 0,
        vatAmount: row.vatAmount ?? 0,
        stampValid: false,
        status: "invalid_input",
        vatAtRisk: 0,
        detail: "Missing or malformed required fields; row not assessed.",
      });
      return;
    }

    const irn = row.irn!;
    const csid = row.csid!;
    const supplierTin = row.supplierTin!;
    const invoiceAmount = row.invoiceAmount!;
    const vatAmount = row.vatAmount!;
    const valid = validStamps.has(stampKey(irn, csid));
    const vatAtRisk = valid ? 0 : vatAmount;

    if (valid) verifiedCount++;
    else atRiskCount++;
    totalVatAmount = money(totalVatAmount + vatAmount);
    totalVatAtRisk = money(totalVatAtRisk + vatAtRisk);

    results.push({
      rowNumber,
      invoiceNumber: row.invoiceNumber!,
      supplierTin,
      supplierName: row.supplierName,
      irn,
      csid,
      invoiceAmount,
      vatAmount,
      stampValid: valid,
      status: valid ? "verified" : "at_risk",
      vatAtRisk,
      detail: valid
        ? undefined
        : "No verified stamp for this invoice; input VAT is at risk of disallowance.",
    });

    const supplierId = `supplier:${supplierTin}`;
    const node =
      supplierNodes.get(supplierId) ??
      ({
        id: supplierId,
        label: row.supplierName ?? supplierTin,
        kind: "supplier",
        invoiceCount: 0,
        totalAmount: 0,
        totalVatAtRisk: 0,
      } satisfies GraphNode);
    node.invoiceCount++;
    node.totalAmount = money(node.totalAmount + invoiceAmount);
    node.totalVatAtRisk = money(node.totalVatAtRisk + vatAtRisk);
    supplierNodes.set(supplierId, node);

    const edge =
      edges.get(supplierId) ??
      ({
        source: buyerId,
        target: supplierId,
        invoiceCount: 0,
        totalAmount: 0,
        vatAtRisk: 0,
      } satisfies GraphEdge);
    edge.invoiceCount++;
    edge.totalAmount = money(edge.totalAmount + invoiceAmount);
    edge.vatAtRisk = money(edge.vatAtRisk + vatAtRisk);
    edges.set(supplierId, edge);
  });

  const suppliers = [...supplierNodes.values()];
  const buyerNode: GraphNode = {
    id: buyerId,
    label: buyerLabel,
    kind: "buyer",
    invoiceCount: suppliers.reduce((s, n) => s + n.invoiceCount, 0),
    totalAmount: money(suppliers.reduce((s, n) => s + n.totalAmount, 0)),
    totalVatAtRisk: money(suppliers.reduce((s, n) => s + n.totalVatAtRisk, 0)),
  };

  return {
    buyerName,
    rowCount: rows.length,
    verifiedCount,
    atRiskCount,
    invalidCount,
    totalVatAmount,
    totalVatAtRisk,
    rows: results,
    graph: { nodes: [buyerNode, ...suppliers], edges: [...edges.values()] },
  };
}
