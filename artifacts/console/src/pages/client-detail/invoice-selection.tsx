import { useRef } from "react";
import { useUrlParam } from "@workspace/web-ui";
import {
  useGetInvoice,
  getGetInvoiceQueryKey,
  type ClientRisk,
  type ConsoleInvoice,
  type Me,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { QueryError } from "@/components/query-error";
import { ClientInvoiceDrawer } from "./invoice-drawer";

export function useClientInvoiceSelection({
  clientPartyId,
  client,
  invoices,
  me,
}: {
  clientPartyId: string;
  client: ClientRisk;
  invoices: ConsoleInvoice[];
  me: Me | undefined;
}) {
  const [invoiceId, setInvoiceId] = useUrlParam("invoiceId");
  const selected =
    client.clientPartyId === clientPartyId
      ? invoices.find((invoice) => invoice.id === invoiceId)
      : undefined;
  const canRead = !!me?.capabilities.includes("invoice.read");
  const enabled = !!selected && canRead;
  const query = useGetInvoice(selected?.id ?? "", {
    query: {
      queryKey: [
        ...getGetInvoiceQueryKey(selected?.id ?? ""),
        "client-workspace",
        me?.firmId,
        me?.userId,
        clientPartyId,
      ],
      enabled,
      retry: false,
    },
  });
  // Both reads must agree on identity and scope. Never display cached data
  // for another client, principal or invoice while navigation is resolving.
  const record =
    enabled &&
    query.isSuccess &&
    !query.isError &&
    query.data?.invoice.id === selected?.id &&
    query.data.invoice.supplierPartyId === clientPartyId &&
    query.data.invoice.firmId === me?.firmId
      ? query.data
      : undefined;
  return { invoiceId, setInvoiceId, selected, canRead, query, record };
}

export function ClientInvoiceSelection({
  selection,
  clientPartyId,
  clientName,
}: {
  selection: ReturnType<typeof useClientInvoiceSelection>;
  clientPartyId: string;
  clientName: string;
}) {
  const fallback = useRef<HTMLButtonElement>(null);
  if (!selection.invoiceId) return null;
  const dismiss = () => selection.setInvoiceId("");
  return (
    <div className="space-y-3 px-6 pb-4 sm:px-0">
      {!selection.selected || !selection.canRead ? (
        <p role="alert" className="text-sm text-muted-foreground">
          This invoice is not available in this client workspace.
        </p>
      ) : selection.query.isError ? (
        <QueryError
          thing="the selected invoice"
          onRetry={() => void selection.query.refetch()}
        />
      ) : !selection.record ? (
        <p role="status" className="text-sm text-muted-foreground">
          {selection.query.isPending
            ? "Loading the selected invoice..."
            : "This invoice is not available in this client workspace."}
        </p>
      ) : null}
      <Button ref={fallback} variant="outline" size="sm" onClick={dismiss}>
        Close invoice
      </Button>
      {selection.record && (
        <ClientInvoiceDrawer
          key={`${clientPartyId}:${selection.record.invoice.id}`}
          detail={selection.record}
          clientName={clientName}
          onClose={dismiss}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const trigger = document.getElementById(
              `open-client-invoice-${selection.invoiceId}`,
            );
            (trigger ?? fallback.current)?.focus({ preventScroll: true });
          }}
        />
      )}
    </div>
  );
}
