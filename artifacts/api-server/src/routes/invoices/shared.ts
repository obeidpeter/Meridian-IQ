import { getInvoiceWithLines } from "../../modules/invoice/service";
import {
  assertSameTenant,
  assertClientPartyScope,
  type Principal,
} from "../../modules/auth/rbac";
import { DomainError } from "../../modules/errors";

// The SEC-03 invoice tenancy loader, shared by every /invoices/:id group in
// this directory and with the SME escalation routes (routes/sme.ts): one
// definition of "this principal may reach this invoice".
export async function loadForTenant(
  req: { principal: Principal },
  id: string,
) {
  const bundle = await getInvoiceWithLines(id);
  if (!bundle) throw new DomainError("NOT_FOUND", "Invoice not found", 404);
  assertSameTenant(req.principal, bundle.invoice.firmId);
  // A client_user may only reach invoices where it is the supplier — not a
  // sibling client's invoice within the same firm (SEC-03). No-op for firm
  // staff/admin and cross-tenant roles.
  assertClientPartyScope(req.principal, bundle.invoice.supplierPartyId);
  return bundle;
}
