import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { z } from "zod/v4";

// Canonical invoice model representing the full mandatory field set of C2
// (Peppol BIS Billing 3.0 / UBL) and serializing losslessly to UBL XML and JSON
// (CORE-01). Monetary and quantity values are carried as strings to guarantee
// lossless round-trips (no float drift).

const partySchema = z.object({
  legalName: z.string().min(1),
  tin: z.string().min(1),
  cacNumber: z.string().nullable().optional(),
  street: z.string().min(1),
  city: z.string().min(1),
  countryCode: z.string().min(2),
});

const lineSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  quantity: z.string().min(1),
  unitCode: z.string().min(1),
  unitPrice: z.string().min(1),
  vatRate: z.string().min(1),
  lineExtension: z.string().min(1),
  vatAmount: z.string().min(1),
});

export const canonicalInvoiceSchema = z.object({
  invoiceNumber: z.string().min(1),
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  invoiceTypeCode: z.string().min(1), // 380 invoice, 381 credit note
  currencyCode: z.string().min(1),
  supplier: partySchema,
  buyer: partySchema,
  lines: z.array(lineSchema).min(1),
  lineExtensionAmount: z.string().min(1),
  taxExclusiveAmount: z.string().min(1),
  taxAmount: z.string().min(1),
  taxInclusiveAmount: z.string().min(1),
  payableAmount: z.string().min(1),
});

export type CanonicalInvoice = z.infer<typeof canonicalInvoiceSchema>;

export interface FieldError {
  field: string;
  message: string;
}

// Field-level validation returning plain-language errors (CORE-01, SME-01).
export function validateCanonical(input: unknown): FieldError[] {
  const result = canonicalInvoiceSchema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message,
  }));
}

const NS = {
  "@_xmlns": "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
  "@_xmlns:cac":
    "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
  "@_xmlns:cbc":
    "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
};

function partyToUbl(p: CanonicalInvoice["supplier"]) {
  return {
    "cac:Party": {
      "cac:PartyName": { "cbc:Name": p.legalName },
      "cac:PostalAddress": {
        "cbc:StreetName": p.street,
        "cbc:CityName": p.city,
        "cac:Country": { "cbc:IdentificationCode": p.countryCode },
      },
      "cac:PartyTaxScheme": {
        "cbc:CompanyID": p.tin,
        "cac:TaxScheme": { "cbc:ID": "VAT" },
      },
      "cac:PartyLegalEntity": {
        "cbc:RegistrationName": p.legalName,
        "cbc:CompanyID": p.cacNumber ?? "",
      },
    },
  };
}

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  suppressEmptyNode: false,
});

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => name === "cac:InvoiceLine",
});

export function serializeToUbl(inv: CanonicalInvoice): string {
  const doc = {
    Invoice: {
      ...NS,
      "cbc:ID": inv.invoiceNumber,
      "cbc:IssueDate": inv.issueDate,
      "cbc:DueDate": inv.dueDate,
      "cbc:InvoiceTypeCode": inv.invoiceTypeCode,
      "cbc:DocumentCurrencyCode": inv.currencyCode,
      "cac:AccountingSupplierParty": partyToUbl(inv.supplier),
      "cac:AccountingCustomerParty": partyToUbl(inv.buyer),
      "cac:TaxTotal": { "cbc:TaxAmount": inv.taxAmount },
      "cac:LegalMonetaryTotal": {
        "cbc:LineExtensionAmount": inv.lineExtensionAmount,
        "cbc:TaxExclusiveAmount": inv.taxExclusiveAmount,
        "cbc:TaxInclusiveAmount": inv.taxInclusiveAmount,
        "cbc:PayableAmount": inv.payableAmount,
      },
      "cac:InvoiceLine": inv.lines.map((l) => ({
        "cbc:ID": l.id,
        // UBL carries the unit of measure as the unitCode attribute on the
        // quantity element (UBL 2.1, CORE-01), not as a sibling element.
        "cbc:InvoicedQuantity": { "#text": l.quantity, "@_unitCode": l.unitCode },
        "cbc:LineExtensionAmount": l.lineExtension,
        "cac:Item": { "cbc:Description": l.description },
        "cac:Price": { "cbc:PriceAmount": l.unitPrice },
        "cac:TaxTotal": {
          "cbc:TaxAmount": l.vatAmount,
          "cac:TaxSubtotal": {
            "cac:TaxCategory": { "cbc:Percent": l.vatRate },
          },
        },
      })),
    },
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build(doc)}`;
}

function ublToParty(node: Record<string, unknown>): CanonicalInvoice["supplier"] {
  const party = node["cac:Party"] as Record<string, unknown>;
  const addr = party["cac:PostalAddress"] as Record<string, unknown>;
  const country = addr["cac:Country"] as Record<string, unknown>;
  const taxScheme = party["cac:PartyTaxScheme"] as Record<string, unknown>;
  const legal = party["cac:PartyLegalEntity"] as Record<string, unknown>;
  const cac = String(legal["cbc:CompanyID"] ?? "");
  return {
    legalName: String(
      (party["cac:PartyName"] as Record<string, unknown>)["cbc:Name"],
    ),
    tin: String(taxScheme["cbc:CompanyID"]),
    cacNumber: cac === "" ? null : cac,
    street: String(addr["cbc:StreetName"]),
    city: String(addr["cbc:CityName"]),
    countryCode: String(country["cbc:IdentificationCode"]),
  };
}

export function parseFromUbl(xml: string): CanonicalInvoice {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const inv = doc.Invoice as Record<string, unknown>;
  const monetary = inv["cac:LegalMonetaryTotal"] as Record<string, unknown>;
  const taxTotal = inv["cac:TaxTotal"] as Record<string, unknown>;
  const lines = (inv["cac:InvoiceLine"] as Record<string, unknown>[]).map(
    (l) => {
      const item = l["cac:Item"] as Record<string, unknown>;
      const price = l["cac:Price"] as Record<string, unknown>;
      const lineTax = l["cac:TaxTotal"] as Record<string, unknown>;
      const subtotal = lineTax["cac:TaxSubtotal"] as Record<string, unknown>;
      const category = subtotal["cac:TaxCategory"] as Record<string, unknown>;
      const qty = l["cbc:InvoicedQuantity"] as Record<string, unknown>;
      return {
        id: String(l["cbc:ID"]),
        description: String(item["cbc:Description"]),
        quantity: String(qty["#text"]),
        unitCode: String(qty["@_unitCode"]),
        unitPrice: String(price["cbc:PriceAmount"]),
        vatRate: String(category["cbc:Percent"]),
        lineExtension: String(l["cbc:LineExtensionAmount"]),
        vatAmount: String(lineTax["cbc:TaxAmount"]),
      };
    },
  );
  return {
    invoiceNumber: String(inv["cbc:ID"]),
    issueDate: String(inv["cbc:IssueDate"]),
    dueDate: String(inv["cbc:DueDate"]),
    invoiceTypeCode: String(inv["cbc:InvoiceTypeCode"]),
    currencyCode: String(inv["cbc:DocumentCurrencyCode"]),
    supplier: ublToParty(
      inv["cac:AccountingSupplierParty"] as Record<string, unknown>,
    ),
    buyer: ublToParty(
      inv["cac:AccountingCustomerParty"] as Record<string, unknown>,
    ),
    lines,
    lineExtensionAmount: String(monetary["cbc:LineExtensionAmount"]),
    taxExclusiveAmount: String(monetary["cbc:TaxExclusiveAmount"]),
    taxAmount: String(taxTotal["cbc:TaxAmount"]),
    taxInclusiveAmount: String(monetary["cbc:TaxInclusiveAmount"]),
    payableAmount: String(monetary["cbc:PayableAmount"]),
  };
}

export function serializeToJson(inv: CanonicalInvoice): string {
  return JSON.stringify(inv);
}

export function parseFromJson(json: string): CanonicalInvoice {
  return canonicalInvoiceSchema.parse(JSON.parse(json));
}
