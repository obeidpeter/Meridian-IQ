// ERP connector contract (PL-03, INT-06). One interface over N accounting
// systems, exactly as the APP rails hide behind the adapter seam (INT-01):
// authentication, incremental pull of AR invoices with an opaque cursor, and a
// declarative field map. A connector is configuration plus mapping — the sync
// engine and the canonical invoice path never branch on a connector key.

// The canonical AR row every connector must map into. One row = one invoice
// with a single summary line (detailed line pulls are a later connector
// capability; the canonical model already supports them).
export interface CanonicalErpRow {
  invoiceNumber: string;
  buyerName: string;
  buyerTin: string | null;
  issueDate: string; // ISO yyyy-mm-dd
  description: string;
  quantity: string;
  unitPrice: string;
  vatRate: string; // fraction, e.g. "0.075"
}

export interface ConnectorPullResult {
  // Rows in the connector's NATIVE field names; the engine applies the map.
  rows: Record<string, string>[];
  nextCursor: string;
  hasMore: boolean;
}

export interface Connector {
  key: string;
  name: string;
  description: string;
  // Validate the connection's auth configuration.
  authenticate(
    config: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string }>;
  // Incremental pull from an opaque cursor (null = from the beginning).
  pullInvoices(
    config: Record<string, unknown>,
    cursor: string | null,
    limit: number,
  ): Promise<ConnectorPullResult>;
  // canonical field -> native field name.
  defaultFieldMap: Record<keyof CanonicalErpRow, string>;
}

export interface MappedRow {
  row: CanonicalErpRow | null;
  errors: { field: string; message: string }[];
}

// Apply a field map (connector default overlaid with per-connection overrides)
// to one native row. Pure, so per-connector golden fixtures can prove the
// mapping without a database.
export function mapRow(
  native: Record<string, string>,
  fieldMap: Record<string, string>,
): MappedRow {
  const errors: { field: string; message: string }[] = [];
  const pick = (canonical: keyof CanonicalErpRow): string => {
    const nativeField = fieldMap[canonical];
    const value = nativeField ? (native[nativeField] ?? "").trim() : "";
    return value;
  };
  const invoiceNumber = pick("invoiceNumber");
  if (!invoiceNumber) {
    errors.push({ field: "invoiceNumber", message: "Missing invoice number" });
  }
  const buyerName = pick("buyerName");
  if (!buyerName) {
    errors.push({ field: "buyerName", message: "Missing buyer name" });
  }
  const issueDate = pick("issueDate");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) {
    errors.push({
      field: "issueDate",
      message: `Expected ISO date, got "${issueDate}"`,
    });
  }
  const quantity = pick("quantity") || "1";
  const unitPrice = pick("unitPrice");
  if (!/^\d+(\.\d+)?$/.test(unitPrice)) {
    errors.push({
      field: "unitPrice",
      message: `Expected a numeric unit price, got "${unitPrice}"`,
    });
  }
  const vatRateRaw = pick("vatRate");
  // Accept either a fraction ("0.075") or a percentage ("7.5").
  let vatRate = vatRateRaw || "0";
  const vatNum = Number(vatRate);
  if (Number.isNaN(vatNum) || vatNum < 0) {
    errors.push({ field: "vatRate", message: `Bad VAT rate "${vatRateRaw}"` });
  } else if (vatNum > 1) {
    vatRate = String(vatNum / 100);
  }
  if (errors.length > 0) return { row: null, errors };
  return {
    row: {
      invoiceNumber,
      buyerName,
      buyerTin: pick("buyerTin") || null,
      issueDate,
      description: pick("description") || `AR invoice ${invoiceNumber}`,
      quantity,
      unitPrice,
      vatRate,
    },
    errors: [],
  };
}
