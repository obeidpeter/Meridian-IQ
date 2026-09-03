import type { CanonicalInvoice } from "../modules/invoice/canonical";

// A well-formed canonical invoice for rail-level tests (the transport and the
// fakes only need a valid shape; the pipeline suites build theirs from rows).
export function sampleParty(tin: string): CanonicalInvoice["supplier"] {
  return {
    legalName: `Party ${tin}`,
    tin,
    cacNumber: null,
    street: "1 Broad Street",
    city: "Lagos",
    countryCode: "NG",
  };
}

export function sampleCanonical(invoiceNumber: string): CanonicalInvoice {
  return {
    invoiceNumber,
    issueDate: "2026-08-01",
    dueDate: "2026-08-31",
    invoiceTypeCode: "380",
    currencyCode: "NGN",
    supplier: sampleParty("1234567890"),
    buyer: sampleParty("0987654321"),
    lines: [
      {
        id: "l1",
        description: "Consulting",
        quantity: "1",
        unitCode: "EA",
        unitPrice: "100000.00",
        vatRate: "0.075",
        lineExtension: "100000.00",
        vatAmount: "7500.00",
      },
    ],
    lineExtensionAmount: "100000.00",
    taxExclusiveAmount: "100000.00",
    taxAmount: "7500.00",
    taxInclusiveAmount: "107500.00",
    payableAmount: "107500.00",
  };
}
