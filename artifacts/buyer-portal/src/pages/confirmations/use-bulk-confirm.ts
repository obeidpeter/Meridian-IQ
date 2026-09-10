import { useEffect, useState } from "react";
import {
  useBulkRespondConfirmations,
  getListBuyerInvoicesQueryKey,
} from "@workspace/api-client-react";
import type {
  BuyerInvoice,
  BulkConfirmationsResult,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { errorDescription } from "@/lib/respond";
import { BULK_LIMIT } from "./constants";

// The bulk-confirm slice of the queue page's state: the selection, its
// derivations, the method/no-set-off pair and the last run's report.
export function useBulkConfirm({
  invoices,
  filtered,
}: {
  invoices: BuyerInvoice[];
  filtered: BuyerInvoice[];
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Bulk confirmation: the picked awaiting rows, the method/no-set-off pair
  // (same semantics as the single-response form), and the per-invoice report
  // from the last run.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkMethod, setBulkMethod] = useState("portal");
  const [bulkNoSetOff, setBulkNoSetOff] = useState(false);
  const [bulkResults, setBulkResults] =
    useState<BulkConfirmationsResult | null>(null);
  const bulk = useBulkRespondConfirmations();

  // A refetch can flip a selected row out of the awaiting state (someone
  // else responded, or our own bulk run landed) — drop it from the selection
  // instead of resubmitting a guaranteed skip.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const awaitingIds = new Set(
        invoices
          .filter((i) => i.confirmationState === "requested")
          .map((i) => i.id),
      );
      const next = new Set([...prev].filter((id) => awaitingIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [invoices]);

  // Bulk selection derivations: the awaiting rows in the CURRENT filtered
  // view are what "Select all" covers, capped at the endpoint's batch size.
  const awaitingFiltered = filtered.filter(
    (i) => i.confirmationState === "requested",
  );
  const showSelectionColumn = awaitingFiltered.length > 0;
  const selectAllTargets = awaitingFiltered.slice(0, BULK_LIMIT);
  const allSelected =
    selectAllTargets.length > 0 &&
    selectAllTargets.every((i) => selected.has(i.id));
  const overLimit = selected.size > BULK_LIMIT;
  const selectAllCapped =
    allSelected && awaitingFiltered.length > BULK_LIMIT && !overLimit;
  const numbersById = new Map(invoices.map((i) => [i.id, i.invoiceNumber]));
  const selectedInvoices = invoices.filter((invoice) =>
    selected.has(invoice.id),
  );
  const selectedTotal = selectedInvoices.reduce(
    (sum, invoice) => sum + (Number(invoice.grandTotal) || 0),
    0,
  );
  const selectedSupplierCount = new Set(
    selectedInvoices.map((invoice) => invoice.supplierPartyId),
  ).size;
  const bulkMethodLabel =
    bulkMethod === "email"
      ? "Email"
      : bulkMethod === "phone"
        ? "Phone"
        : "Portal";

  const toggleRow = (id: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const runBulk = () => {
    if (selected.size === 0 || overLimit || bulk.isPending) return;
    bulk.mutate(
      {
        data: {
          invoiceIds: [...selected],
          method: bulkMethod,
          noSetOff: bulkNoSetOff,
        },
      },
      {
        onSuccess: (res) => {
          setBulkResults(res);
          setSelected(new Set());
          setBulkNoSetOff(false);
          void queryClient.invalidateQueries({
            queryKey: getListBuyerInvoicesQueryKey(),
          });
          toast({
            title: `${res.confirmed} ${
              res.confirmed === 1 ? "invoice" : "invoices"
            } confirmed`,
            description:
              res.skipped > 0
                ? `${res.skipped} skipped — the results below say why.`
                : "The suppliers have been notified of your response.",
          });
        },
        onError: (err) =>
          toast({
            title: "Could not confirm the selected invoices",
            description: errorDescription(err),
            variant: "destructive",
          }),
      },
    );
  };

  const skippedItems = (bulkResults?.items ?? []).filter(
    (i) => i.status === "skipped",
  );

  return {
    selected,
    setSelected,
    bulkMethod,
    setBulkMethod,
    bulkNoSetOff,
    setBulkNoSetOff,
    bulkResults,
    setBulkResults,
    bulk,
    awaitingFiltered,
    showSelectionColumn,
    selectAllTargets,
    allSelected,
    overLimit,
    selectAllCapped,
    numbersById,
    selectedInvoices,
    selectedTotal,
    selectedSupplierCount,
    bulkMethodLabel,
    toggleRow,
    runBulk,
    skippedItems,
  };
}
