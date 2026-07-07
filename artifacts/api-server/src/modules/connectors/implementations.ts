import { createHash } from "node:crypto";
import type { Connector, ConnectorPullResult } from "./contract.ts";

// The first two connectors (PL-03: "chosen from R0 engagement evidence").
// Both are SIMULATED backends — no real ERP is reachable from this environment
// — but each exercises the full contract exactly as the simulated APP rails
// exercise INT-01: authentication, deterministic incremental pull with a
// cursor, native field names remapped by configuration. Note how different the
// two systems' native schemas are; the difference lives entirely in
// defaultFieldMap, never in the sync engine.

// Deterministic pseudo-data: same connection config + offset always yields the
// same rows, so cursor-resume and duplicate-skip behaviour are testable.
function det(seed: string, i: number, mod: number): number {
  const h = createHash("sha256").update(`${seed}:${i}`).digest();
  return h.readUInt32BE(0) % mod;
}

const BUYER_POOL = [
  { name: "Zenith Retail Group", tin: "30000000-0003" },
  { name: "Sahara Logistics Ltd", tin: "40000000-0004" },
  { name: "Eko Distribution Co", tin: "80000000-0008" },
  { name: "Arewa Agro Ltd", tin: "90000000-0009" },
];

function isoDateFor(seed: string, i: number): string {
  // Spread issue dates over Q1 2027.
  const day = det(seed, i * 7 + 1, 90);
  const d = new Date(Date.UTC(2027, 0, 1 + day));
  return d.toISOString().slice(0, 10);
}

function parseCursor(cursor: string | null): number {
  if (!cursor) return 0;
  const n = Number(cursor);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

// Each simulated book holds a fixed number of AR invoices; pulls page through
// it incrementally.
const BOOK_SIZE = 25;

// ---- SagePro Accounting: PascalCase document-ledger export ----
export const sageproConnector: Connector = {
  key: "sagepro",
  name: "SagePro Accounting",
  description:
    "AR document ledger pull from SagePro (simulated sandbox backend).",
  defaultFieldMap: {
    invoiceNumber: "DocNo",
    buyerName: "CustomerName",
    buyerTin: "CustomerTIN",
    issueDate: "DocDate",
    description: "Details",
    quantity: "Qty",
    unitPrice: "UnitCost",
    vatRate: "VatPct", // percentage form, e.g. "7.5"
  },
  async authenticate(config) {
    const key = String(config.apiKey ?? "");
    if (!key.startsWith("sp_")) {
      return { ok: false, error: "SagePro apiKey must start with sp_" };
    }
    return { ok: true };
  },
  async pullInvoices(config, cursor, limit): Promise<ConnectorPullResult> {
    const seed = `sagepro:${String(config.company ?? "default")}`;
    const start = parseCursor(cursor);
    const rows: Record<string, string>[] = [];
    const end = Math.min(start + limit, BOOK_SIZE);
    for (let i = start; i < end; i++) {
      const buyer = BUYER_POOL[det(seed, i, BUYER_POOL.length)];
      rows.push({
        DocNo: `SP-${5000 + i}`,
        CustomerName: buyer.name,
        CustomerTIN: buyer.tin,
        DocDate: isoDateFor(seed, i),
        Details: `Goods supplied (SagePro doc ${5000 + i})`,
        Qty: String(1 + det(seed, i * 3, 20)),
        UnitCost: String(10_000 + det(seed, i * 5, 90) * 1_000),
        VatPct: "7.5",
      });
    }
    return { rows, nextCursor: String(end), hasMore: end < BOOK_SIZE };
  },
};

// ---- QuickLite Books: snake_case REST-style export ----
export const quickliteConnector: Connector = {
  key: "quicklite",
  name: "QuickLite Books",
  description:
    "Invoice feed pull from QuickLite Books (simulated sandbox backend).",
  defaultFieldMap: {
    invoiceNumber: "ref",
    buyerName: "customer",
    buyerTin: "tin",
    issueDate: "date",
    description: "memo",
    quantity: "quantity",
    unitPrice: "price",
    vatRate: "vat_rate", // fraction form, e.g. "0.075"
  },
  async authenticate(config) {
    if (!config.token) {
      return { ok: false, error: "QuickLite token is required" };
    }
    return { ok: true };
  },
  async pullInvoices(config, cursor, limit): Promise<ConnectorPullResult> {
    const seed = `quicklite:${String(config.realm ?? "default")}`;
    const start = parseCursor(cursor);
    const rows: Record<string, string>[] = [];
    const end = Math.min(start + limit, BOOK_SIZE);
    for (let i = start; i < end; i++) {
      const buyer = BUYER_POOL[det(seed, i, BUYER_POOL.length)];
      rows.push({
        ref: `QL-${9000 + i}`,
        customer: buyer.name,
        tin: buyer.tin,
        date: isoDateFor(seed, i),
        memo: `Services rendered (QuickLite ${9000 + i})`,
        quantity: String(1 + det(seed, i * 3, 8)),
        price: String(25_000 + det(seed, i * 5, 40) * 2_500),
        vat_rate: "0.075",
      });
    }
    return { rows, nextCursor: String(end), hasMore: end < BOOK_SIZE };
  },
};

export const CONNECTORS: Record<string, Connector> = {
  [sageproConnector.key]: sageproConnector,
  [quickliteConnector.key]: quickliteConnector,
};

export function findConnector(key: string): Connector | null {
  return CONNECTORS[key] ?? null;
}
