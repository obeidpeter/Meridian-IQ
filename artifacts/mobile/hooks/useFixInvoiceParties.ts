import { getGetPartyQueryKey, useGetParty } from "@workspace/api-client-react";
import type { Invoice, Me } from "@workspace/api-client-react";
import { useEffect, useState } from "react";

import { errorStatus } from "@/lib/api-error";
import { partyDraftDirty, partyToDraft } from "@/lib/fix-invoice";
import type { PartyDraft } from "@/lib/fix-invoice";

/**
 * The invoice's two parties on the fix screen: each loaded, seeded into an
 * editable draft once, and locked or surfaced as a transient failure by the
 * rules below — the buyer's and the supplier's deliberately differ.
 */
export function useFixInvoiceParties({
  invoice,
  me,
}: {
  invoice: Invoice | undefined;
  me: Me | null;
}) {
  const supplierId = invoice?.supplierPartyId ?? "";
  const buyerId = invoice?.buyerPartyId ?? "";
  const supplierQuery = useGetParty(supplierId, {
    query: { enabled: !!supplierId, queryKey: getGetPartyQueryKey(supplierId) },
  });
  const buyerQuery = useGetParty(buyerId, {
    query: {
      enabled: !!buyerId,
      queryKey: getGetPartyQueryKey(buyerId),
      retry: false,
    },
  });

  const [supplierDraft, setSupplierDraft] = useState<PartyDraft | null>(null);
  const [buyerDraft, setBuyerDraft] = useState<PartyDraft | null>(null);

  useEffect(() => {
    if (supplierQuery.data && !supplierDraft) {
      setSupplierDraft(partyToDraft(supplierQuery.data));
    }
  }, [supplierQuery.data, supplierDraft]);
  useEffect(() => {
    if (buyerQuery.data && !buyerDraft) {
      setBuyerDraft(partyToDraft(buyerQuery.data));
    }
  }, [buyerQuery.data, buyerDraft]);

  // The server is also the authority on WHO may edit the buyer: client_users
  // are confined to their own party (403 on the buyer fetch), while firm staff
  // can load and fix buyers on the firm's invoices. Only an explicit 403 means
  // "managed by your firm" — any other load failure is transient, so show a
  // retryable error instead of the misleading lock message.
  const buyerErrorStatus = buyerQuery.isError
    ? errorStatus(buyerQuery.error)
    : undefined;
  const buyerLocked =
    buyerErrorStatus === 403 ||
    !me?.capabilities.includes("party.write") ||
    me.role === "client_user";
  const buyerLoadFailed = buyerQuery.isError && !buyerLocked;

  // The supplier is the user's own party, so a 403 would still mean "managed by
  // your firm"; any other error is transient. Either way, don't leave the
  // supplier section stuck on an eternal skeleton — surface it.
  const supplierErrorStatus = supplierQuery.isError
    ? errorStatus(supplierQuery.error)
    : undefined;
  const supplierLocked = supplierErrorStatus === 403;
  const supplierLoadFailed = supplierQuery.isError && !supplierLocked;

  // Dirty check: an editable party draft that differs from the server's copy.
  const partyDirty =
    partyDraftDirty(supplierLocked, supplierDraft, supplierQuery.data) ||
    partyDraftDirty(buyerLocked, buyerDraft, buyerQuery.data);

  return {
    supplierId,
    buyerId,
    supplierQuery,
    buyerQuery,
    supplierDraft,
    setSupplierDraft,
    buyerDraft,
    setBuyerDraft,
    supplierLocked,
    supplierLoadFailed,
    buyerLocked,
    buyerLoadFailed,
    partyDirty,
  };
}
