import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import {
  engagementsTable,
  getDb,
  invoiceLifecycleEventsTable,
  invoicesTable,
  partiesTable,
} from "@workspace/db";
import {
  clientPartyScope,
  requireFirmScope,
  type Principal,
} from "../auth/rbac";
import { partySphereCondition } from "../party/party";

export type SetupStep = {
  id: string;
  label: string;
  description: string;
  complete: boolean;
  href: string;
};

export function businessDetailsComplete(
  party:
    | {
        legalName: string;
        tin: string | null;
        street: string | null;
        city: string | null;
        countryCode: string;
      }
    | undefined,
): boolean {
  return Boolean(
    party &&
    [party.legalName, party.tin, party.street, party.city].every((value) =>
      value?.trim(),
    ) &&
    party.countryCode.trim().length >= 2,
  );
}

export function invoiceValidationComplete(status: string | undefined): boolean {
  // Failed content remains editable without a status reset. Historical events
  // are not revision-bound, so they cannot prove its current content valid.
  if (!status) return false;
  return [
    "validated",
    "submitted",
    "stamped",
    "confirmed",
    "settled",
    "credited",
  ].includes(status);
}

export async function firstInvoiceSetup(
  principal: Principal,
): Promise<SetupStep[]> {
  const firmId = requireFirmScope(principal);
  const clientId = clientPartyScope(principal);
  // A single deterministic supplier/invoice anchors the journey. Different
  // clients' records must never combine into one apparently completed setup,
  // and both roles anchor only to a client this firm still engages: an
  // archived client cannot supply setup proof for a firm user or for its own
  // client user (R114 aligned the client branch with the firm branch).
  const liveEngagement = sql`exists (
        select 1 from ${engagementsTable}
        where ${engagementsTable.firmId} = ${firmId}
          and ${engagementsTable.clientPartyId} = ${partiesTable.id}
          and ${engagementsTable.status} <> 'archived'
      )`;
  const [supplier] = await getDb()
    .select({
      id: partiesTable.id,
      legalName: partiesTable.legalName,
      tin: partiesTable.tin,
      street: partiesTable.street,
      city: partiesTable.city,
      countryCode: partiesTable.countryCode,
    })
    .from(partiesTable)
    .where(
      and(
        isNull(partiesTable.mergedIntoId),
        eq(partiesTable.type, "client_business"),
        clientId
          ? and(eq(partiesTable.id, clientId), liveEngagement)
          : liveEngagement,
      ),
    )
    .orderBy(asc(partiesTable.createdAt), asc(partiesTable.id))
    .limit(1);

  const [invoice] = supplier
    ? await getDb()
        .select({
          id: invoicesTable.id,
          status: invoicesTable.status,
          buyerPartyId: invoicesTable.buyerPartyId,
        })
        .from(invoicesTable)
        .where(
          and(
            eq(invoicesTable.firmId, firmId),
            eq(invoicesTable.supplierPartyId, supplier.id),
            eq(invoicesTable.kind, "invoice"),
            ne(invoicesTable.status, "cancelled"),
          ),
        )
        .orderBy(asc(invoicesTable.createdAt), asc(invoicesTable.id))
        .limit(1)
    : [];

  const [history] = invoice
    ? await getDb()
        .select({ id: invoiceLifecycleEventsTable.id })
        .from(invoiceLifecycleEventsTable)
        .where(
          and(
            eq(invoiceLifecycleEventsTable.invoiceId, invoice.id),
            eq(invoiceLifecycleEventsTable.firmId, firmId),
          ),
        )
        .limit(1)
    : [];

  const [customer] = supplier
    ? await getDb()
        .select({ id: partiesTable.id })
        .from(partiesTable)
        .where(
          and(
            isNull(partiesTable.mergedIntoId),
            partySphereCondition(principal) ?? undefined,
            invoice
              ? eq(partiesTable.id, invoice.buyerPartyId)
              : and(
                  eq(partiesTable.type, "buyer"),
                  eq(partiesTable.createdByFirmId, firmId),
                  eq(partiesTable.createdByUserId, principal.userId),
                ),
          ),
        )
        .limit(1)
    : [];

  const invoiceHref = clientId
    ? invoice
      ? `/invoices/${invoice.id}`
      : "/invoices/new"
    : supplier
      ? `/clients/${supplier.id}?view=invoices`
      : "/portfolio?action=add-client";
  const createHref = clientId ? "/invoices/new" : "/work?action=new";
  const businessHref = clientId
    ? "/business"
    : supplier
      ? `/clients/${supplier.id}/business`
      : "/portfolio?action=add-client";
  const supplierDescription = supplier
    ? `For ${supplier.legalName}. `
    : "For the first engaged client. ";

  return [
    ...(!clientId
      ? [
          {
            id: "first_client",
            label: "Add the first client",
            description: "Create a client record and establish its engagement.",
            complete: Boolean(supplier),
            href: "/portfolio?action=add-client",
          },
        ]
      : []),
    {
      id: "business_identity",
      label: "Complete the business details",
      description: `${supplierDescription}Record the legal name, TIN and postal address. This is not a live TIN verification.`,
      complete: businessDetailsComplete(supplier),
      href: businessHref,
    },
    {
      id: "first_customer",
      label: clientId
        ? "Choose the first customer"
        : "Coordinate the first customer record",
      description: invoice
        ? "The invoice's customer record is available and has not been merged away."
        : "Capture the customer details for the first invoice.",
      complete: Boolean(customer),
      href: invoice ? invoiceHref : createHref,
    },
    {
      id: "first_invoice",
      label: clientId
        ? "Create the first invoice"
        : "Coordinate the first invoice",
      description: `${supplierDescription}Save an invoice record; a saved draft is not yet validated.`,
      complete: Boolean(invoice),
      href: invoice ? invoiceHref : createHref,
    },
    {
      id: "invoice_validation",
      label: "Validate the invoice details",
      description:
        "Resolve the invoice's validation errors. Editing a validated draft requires validation again.",
      complete: invoiceValidationComplete(invoice?.status),
      href: invoiceHref,
    },
    {
      id: "invoice_evidence",
      label: "Keep the invoice history connected",
      description:
        "Recorded lifecycle history is available for this invoice. This does not imply a fiscal stamp or evidence download.",
      complete: Boolean(history),
      href: invoiceHref,
    },
  ];
}
