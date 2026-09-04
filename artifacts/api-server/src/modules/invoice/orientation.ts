import { DomainError } from "../errors";
import { invoiceOrientation } from "./payables";

const NOT_SUBMITTABLE_MESSAGE =
  "Only your own issued invoices can be submitted for stamping — this document's supplier is not a client of your practice.";

// Payables guard (contract 0.44.0): only a receivable-oriented invoice whose
// supplier is a client of the firm may enter the stamping lifecycle. Keeping
// this below service and approvals avoids an initialization cycle between the
// submit and maker-checker paths.
export async function assertReceivableOriented(invoice: {
  firmId: string;
  supplierPartyId: string;
  buyerPartyId: string;
}): Promise<void> {
  if ((await invoiceOrientation(invoice)) !== "receivable") {
    throw new DomainError("NOT_SUBMITTABLE", NOT_SUBMITTABLE_MESSAGE, 409);
  }
}
