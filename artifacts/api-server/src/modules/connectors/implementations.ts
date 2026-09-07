import { createHash } from "node:crypto";
import type { Connector, ConnectorPullResult } from "./contract.ts";
import { logger } from "../../lib/logger";
import { readBoundedJsonObject } from "./relay-response.ts";

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
  mode: "sandbox",
  isConfigured: () => true,
  configurationFields: [
    {
      key: "apiKey",
      label: "Sandbox API key",
      required: true,
      secret: true,
      placeholder: "sp_demo_…",
      help: "Use an sp_ prefixed key for the deterministic SagePro sandbox.",
    },
    {
      key: "company",
      label: "Sandbox company",
      required: false,
      secret: false,
      placeholder: "demo-company",
      help: "Separates one deterministic sandbox book from another.",
    },
  ],
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
  mode: "sandbox",
  isConfigured: () => true,
  configurationFields: [
    {
      key: "token",
      label: "Sandbox token",
      required: true,
      secret: true,
      placeholder: "Enter any non-empty sandbox token",
      help: "Used only by the deterministic QuickLite sandbox adapter.",
    },
    {
      key: "realm",
      label: "Sandbox realm",
      required: false,
      secret: false,
      placeholder: "demo-realm",
      help: "Separates one deterministic sandbox book from another.",
    },
  ],
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

// Production adapter protocol. Valo talks only to a deployment-owned
// relay URL, never a URL supplied by a tenant, which keeps this connector from
// becoming an SSRF primitive. The relay owns vendor OAuth/token rotation and
// responds in the canonical field names below; ERP_CONNECTOR_TOKEN authenticates
// Valo to that boundary and is never persisted in a connection row.
const RELAY_TIMEOUT_MS = 8_000;
const MAX_RELAY_BODY_BYTES = 2 * 1024 * 1024;

function liveRelayConfigured(): boolean {
  return Boolean(liveRelayUrl() && process.env.ERP_CONNECTOR_TOKEN?.trim());
}

function liveRelayUrl(): URL | null {
  const raw = process.env.ERP_CONNECTOR_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (
      url.username ||
      url.password ||
      (url.protocol !== "https:" &&
        !(process.env.NODE_ENV !== "production" && url.protocol === "http:"))
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

async function relayRequest(
  kind: "erp_authenticate" | "erp_pull_invoices",
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url = liveRelayUrl();
  const token = process.env.ERP_CONNECTOR_TOKEN?.trim();
  if (!url || !token) throw new Error("Live ERP relay is not configured");
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-op-token": token,
      },
      body: JSON.stringify({ kind, ...payload }),
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      redirect: "error",
    });
  } catch (error) {
    logger.error(
      { kind, reason: error instanceof Error ? error.name : "unknown" },
      "ERP connector relay request failed",
    );
    throw new Error("Live ERP relay is unreachable");
  }
  if (!response.ok) {
    logger.warn(
      { kind, status: response.status },
      "ERP connector relay rejected request",
    );
    throw new Error("Live ERP relay rejected the request");
  }
  return readBoundedJsonObject(response, MAX_RELAY_BODY_BYTES, "Live ERP relay");
}

export const liveErpRelayConnector: Connector = {
  key: "meridian-relay",
  name: "Production ERP relay",
  description:
    "Live accounting feed through the deployment-owned Valo adapter protocol.",
  mode: "live",
  isConfigured: liveRelayConfigured,
  configurationFields: [
    {
      key: "accountRef",
      label: "Provider account reference",
      required: true,
      secret: false,
      placeholder: "customer-or-tenant-reference",
      help: "The non-secret account reference configured in your provider relay.",
    },
  ],
  defaultFieldMap: {
    invoiceNumber: "invoiceNumber",
    buyerName: "buyerName",
    buyerTin: "buyerTin",
    issueDate: "issueDate",
    description: "description",
    quantity: "quantity",
    unitPrice: "unitPrice",
    vatRate: "vatRate",
  },
  async authenticate(config) {
    if (!liveRelayConfigured()) {
      return { ok: false, error: "Live ERP relay is not configured" };
    }
    if (!String(config.accountRef ?? "").trim()) {
      return { ok: false, error: "Provider account reference is required" };
    }
    try {
      const response = await relayRequest("erp_authenticate", { config });
      return response.ok === true
        ? { ok: true }
        : {
            ok: false,
            error: "Provider rejected the account reference",
          };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Provider test failed",
      };
    }
  },
  async pullInvoices(config, cursor, limit): Promise<ConnectorPullResult> {
    const response = await relayRequest("erp_pull_invoices", {
      config,
      cursor,
      limit,
    });
    if (!Array.isArray(response.rows) || response.rows.length > limit) {
      throw new Error("Live ERP relay returned an invalid invoice batch");
    }
    const rows = response.rows.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Live ERP relay returned an invalid invoice row");
      }
      const row: Record<string, string> = {};
      for (const [key, field] of Object.entries(value)) {
        if (typeof field !== "string") {
          throw new Error("Live ERP relay invoice fields must be strings");
        }
        row[key] = field;
      }
      return row;
    });
    const nextCursor = response.nextCursor;
    const hasMore = response.hasMore;
    if (
      typeof nextCursor !== "string" ||
      nextCursor.length > 512 ||
      typeof hasMore !== "boolean"
    ) {
      throw new Error("Live ERP relay returned an invalid cursor");
    }
    return { rows, nextCursor, hasMore };
  },
};

export const CONNECTORS: Record<string, Connector> = {
  [sageproConnector.key]: sageproConnector,
  [quickliteConnector.key]: quickliteConnector,
  [liveErpRelayConnector.key]: liveErpRelayConnector,
};

export function findConnector(key: string): Connector | null {
  return CONNECTORS[key] ?? null;
}
