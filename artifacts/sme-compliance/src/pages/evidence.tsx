import { useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  assistEvidenceRequest,
  createEvidenceRequest,
  customFetch,
  getDownloadEvidenceFileUrl,
  getDownloadEvidencePackUrl,
  getEvidenceRequest,
  getParty,
  getGetEvidenceRequestQueryKey,
  getListEvidenceRequestsQueryKey,
  listEvidenceRequests,
  listFirmTeam,
  listParties,
  listInvoices,
  listFilings,
  retryEvidenceScan,
  reviewEvidenceRequest,
  uploadEvidenceFile,
  updateEvidenceRequest,
  useGetMe,
} from "@workspace/api-client-react";
import {
  EvidenceHub,
  createEvidenceApi,
  type EvidenceOption,
} from "@workspace/web-ui/evidence";
import { QueryError } from "@/components/query-error";
import { usePageTitle } from "@/hooks/use-page-title";

export function EvidenceWorkspace({
  invoiceId,
  client,
  embedded = false,
}: {
  invoiceId?: string;
  client?: EvidenceOption;
  embedded?: boolean;
}) {
  const me = useGetMe();
  const cache = useQueryClient();
  const scope = JSON.stringify([
    me.data?.userId,
    me.data?.firmId,
    me.data?.clientPartyId,
    me.data?.capabilities,
    me.data?.features,
    Boolean(me.error),
  ]);
  const liveScope = useRef<string | null>(scope);
  liveScope.current = scope;
  useEffect(() => {
    liveScope.current = scope;
    return () => {
      liveScope.current = null;
    };
  }, [scope]);
  const api = useMemo(
    () =>
      createEvidenceApi(
        {
          list: (filters, signal) => listEvidenceRequests(filters, { signal }),
          detail: (id, signal) => getEvidenceRequest(id, { signal }),
          create: createEvidenceRequest,
          upload: uploadEvidenceFile,
          update: updateEvidenceRequest,
          clientName: me.data?.capabilities.includes("party.read")
            ? async (id, signal) => {
                const party = await getParty(id, { signal });
                return { id: party.id, label: party.legalName };
              }
            : undefined,
          invoices: me.data?.capabilities.includes("invoice.read")
            ? async (clientPartyId, q, offset, signal) => {
                const rows = await listInvoices(
                  { q, offset, limit: 50 },
                  { signal },
                );
                return {
                  items: rows
                    .filter(
                      (invoice) => invoice.supplierPartyId === clientPartyId,
                    )
                    .map((invoice) => ({
                      id: invoice.id,
                      label: `${invoice.invoiceNumber} | ${invoice.issueDate}`,
                    })),
                  hasMore: rows.length === 50,
                };
              }
            : undefined,
          filings:
            me.data?.capabilities.includes("filing.read") &&
            me.data.features.includes("statutory_desks")
              ? async (clientPartyId, _search, offset, signal) => {
                  const { filings } = await listFilings(
                    { clientPartyId, offset, limit: 50 },
                    { signal },
                  );
                  return {
                    items: filings
                      .filter(
                        (filing) => filing.clientPartyId === clientPartyId,
                      )
                      .map((filing) => ({
                        id: filing.id,
                        label: `${filing.taxType.toUpperCase()} | ${filing.period} | ${filing.status}`,
                      })),
                    hasMore: filings.length === 50,
                  };
                }
              : undefined,
          review: reviewEvidenceRequest,
          scan: retryEvidenceScan,
          assist: assistEvidenceRequest,
          download: (id) =>
            customFetch<Blob>(getDownloadEvidenceFileUrl(id), {
              responseType: "blob",
              redirect: "error",
              cache: "no-store",
            }),
          pack: (id) =>
            customFetch<Blob>(getDownloadEvidencePackUrl(id), {
              responseType: "blob",
              redirect: "error",
              cache: "no-store",
            }),
          clients: me.data?.capabilities.includes("party.read")
            ? async (q, offset, signal) =>
                (
                  await listParties(
                    { q, type: "client_business", limit: 50, offset },
                    { signal },
                  )
                )
                  .filter((party) => !party.mergedIntoId)
                  .map((party) => ({ id: party.id, label: party.legalName }))
            : undefined,
          owners: me.data?.capabilities.includes("console.portfolio.read")
            ? async (signal) =>
                (await listFirmTeam({ signal }))
                  .filter((member) =>
                    ["firm_admin", "firm_staff"].includes(member.role),
                  )
                  .map((member) => ({
                    id: member.userId,
                    label: member.fullName ?? member.email ?? member.userId,
                  }))
            : undefined,
        },
        (detail) => {
          if (liveScope.current !== scope) return;
          cache.setQueryData(
            getGetEvidenceRequestQueryKey(detail.request.id),
            detail,
          );
          void cache.invalidateQueries({
            queryKey: getListEvidenceRequestsQueryKey(),
          });
        },
      ),
    [cache, scope, me.data],
  );
  if (me.error)
    return (
      <QueryError
        thing="your evidence permissions"
        onRetry={() => void me.refetch()}
      />
    );
  if (!me.data) return <p role="status">Loading evidence permissions...</p>;
  return (
    <EvidenceHub
      api={api}
      me={me.data}
      client={client}
      invoiceId={invoiceId}
      embedded={embedded}
    />
  );
}

export default function EvidencePage() {
  usePageTitle("Evidence Hub");
  return <EvidenceWorkspace />;
}
