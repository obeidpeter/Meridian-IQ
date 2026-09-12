import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  FolderOpen,
  Plus,
  RefreshCw,
} from "lucide-react";
import { Button } from "./ui/button";
import { useNavigationQuery } from "./unsaved-work";
import { EvidenceRecordPicker } from "./evidence-record-picker";
import {
  EvidenceClientPicker,
  EvidenceErrorMessage,
  EvidenceStatusMark,
} from "./evidence-controls";
import { EvidenceCreate } from "./evidence-create";
import { EvidenceDetailPanel } from "./evidence-detail";
import {
  evidenceDate,
  evidenceLabel,
  evidencePermissions,
  evidenceStatuses,
  evidenceUuid,
} from "./evidence-helpers";
import { useEvidenceRead } from "./evidence-state";
import { useEvidenceClientLabels } from "./evidence-labels";
import type {
  EvidenceApi,
  EvidenceFilters,
  EvidenceOption,
  EvidencePrincipal,
  EvidenceStatus,
} from "./evidence-types";
import "./evidence.css";

export type EvidenceHubProps = {
  api: EvidenceApi;
  me: EvidencePrincipal;
  invoiceId?: string;
  filingId?: string;
  client?: EvidenceOption;
  embedded?: boolean;
};
export type {
  EvidenceApi,
  EvidenceDetailView,
  EvidencePrincipal,
  EvidenceOption,
} from "./evidence-types";

export function EvidenceHub(props: EvidenceHubProps) {
  if (!props.me.features.includes("evidence_hub"))
    return props.embedded ? null : (
      <section>
        <h1 className="text-xl font-semibold">Evidence Hub</h1>
        <p role="status" className="py-4">
          Evidence Hub is not yet enabled for this workspace.
        </p>
      </section>
    );
  if (!evidencePermissions(props.me).read)
    return props.embedded ? null : (
      <p role="alert">This account does not have access to Evidence Hub.</p>
    );
  return (
    <EvidenceWorkspace
      key={JSON.stringify([
        props.me.userId,
        props.me.firmId,
        props.me.clientPartyId,
        props.me.role,
        props.me.capabilities,
        props.client?.id,
        props.invoiceId,
        props.filingId,
      ])}
      {...props}
    />
  );
}

function useEvidenceWorkspace({
  api: source,
  me,
  invoiceId,
  filingId,
  client: suppliedClient,
  embedded,
}: EvidenceHubProps) {
  const permissions = evidencePermissions(me);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // Ignore late reads/writes after account, permission or invoice-scope changes.
  const api = useMemo(() => {
    const guarded = {} as EvidenceApi;
    for (const [key, operation] of Object.entries(source)) {
      if (typeof operation !== "function") continue;
      Object.assign(guarded, {
        [key]: async (...args: unknown[]) => {
          if (!alive.current) throw new Error("Evidence scope changed");
          const result = await operation(...args);
          if (!alive.current) throw new Error("Evidence scope changed");
          return result;
        },
      });
    }
    return guarded;
  }, [source]);
  const pinnedClient =
    me.role === "client_user" && me.clientPartyId
      ? { id: me.clientPartyId, label: me.workspaceName ?? "Your business" }
      : suppliedClient;
  const [selectedClient, setSelectedClient] = useState<EvidenceOption | null>(
    null,
  );
  const [status, setStatus] = useState<EvidenceStatus | "">("");
  const [anchorType, setAnchorType] = useState<"invoiceId" | "filingId">(
    api.invoices ? "invoiceId" : "filingId",
  );
  const [anchorFilter, setAnchorFilter] = useState<{
    invoiceId?: string;
    filingId?: string;
  }>({});
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useEvidenceSelection(embedded);
  const [creating, setCreating] = useState(false);
  const filters = evidenceScopeFilters({
    pinnedClient,
    selectedClient,
    anchorFilter,
    invoiceId,
    filingId,
    status,
    offset,
  });
  const list = useEvidenceRead(
    (signal) => api.list(filters, signal),
    [filters],
  );
  const selectedRequest = list.data?.items.find(
    (item) => item.id === selectedId,
  );
  const currentClient = pinnedClient ?? selectedClient ?? undefined;
  const total = list.data?.total ?? 0;
  useEffect(() => {
    if (!list.loading && !list.error && offset > 0 && total <= offset)
      setOffset(Math.max(0, Math.ceil(total / 20 - 1) * 20));
  }, [list.loading, list.error, total, offset]);
  const Heading = embedded ? "h2" : "h1";
  return {
    api,
    me,
    invoiceId,
    filingId,
    embedded,
    permissions,
    pinnedClient,
    selectedClient,
    setSelectedClient,
    status,
    setStatus,
    anchorType,
    setAnchorType,
    anchorFilter,
    setAnchorFilter,
    offset,
    setOffset,
    selectedId,
    setSelectedId,
    creating,
    setCreating,
    list,
    selectedRequest,
    currentClient,
    total,
    Heading,
  };
}

type WorkspaceState = ReturnType<typeof useEvidenceWorkspace>;

function EvidenceWorkspace(props: EvidenceHubProps) {
  const state = useEvidenceWorkspace(props);
  const {
    api,
    me,
    invoiceId,
    filingId,
    embedded,
    permissions,
    currentClient,
    selectedRequest,
    creating,
    setCreating,
    selectedId,
    setSelectedId,
    list,
  } = state;
  return (
    <section
      className="evidence-hub"
      aria-label={embedded ? "Invoice evidence" : "Evidence Hub"}
    >
      <EvidenceHeading state={state} />
      <EvidenceFiltersView state={state} />
      <EvidenceListView state={state} />
      <EvidencePagination state={state} />
      {creating && (
        <EvidenceCreate
          api={api}
          me={me}
          client={currentClient}
          invoiceId={invoiceId}
          filingId={filingId}
          onClose={() => setCreating(false)}
          onCreated={(value) => {
            setCreating(false);
            setSelectedId(value.request.id);
            list.refresh();
          }}
        />
      )}
      {selectedId && (
        <EvidenceDetailPanel
          key={selectedId}
          api={api}
          id={selectedId}
          client={
            currentClient?.id === selectedRequest?.clientPartyId
              ? currentClient
              : undefined
          }
          permissions={permissions}
          uploadAvailable={Boolean(list.data?.uploadAvailable) && !list.error}
          scanAvailable={Boolean(list.data?.scanAvailable) && !list.error}
          onClose={() => setSelectedId(null)}
          onChanged={list.refresh}
        />
      )}
    </section>
  );
}

function EvidenceHeading({ state }: { state: WorkspaceState }) {
  const { embedded, list, permissions, setCreating } = state;
  const Heading = embedded ? "h2" : "h1";
  return (
    <header className="evidence-toolbar">
      <Heading className="flex items-center gap-2">
        <FolderOpen className="size-5 shrink-0" aria-hidden="true" />
        {embedded ? "Supporting evidence" : "Evidence Hub"}
      </Heading>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="icon"
          title="Refresh evidence"
          aria-label="Refresh evidence"
          disabled={list.loading}
          onClick={list.refresh}
        >
          <RefreshCw aria-hidden="true" />
        </Button>
        {permissions.request && (
          <Button onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" />
            Request evidence
          </Button>
        )}
      </div>
    </header>
  );
}
function EvidenceFiltersView({ state }: { state: WorkspaceState }) {
  const {
    pinnedClient,
    api,
    selectedClient,
    setSelectedClient,
    setOffset,
    status,
    setStatus,
    invoiceId,
    filingId,
    anchorType,
    setAnchorType,
    setAnchorFilter,
    currentClient,
    anchorFilter,
  } = state;
  return (
    <div className="evidence-filters">
      {!pinnedClient && api.clients && (
        <EvidenceClientPicker
          api={api}
          value={selectedClient}
          onChange={(value) => {
            setSelectedClient(value);
            setAnchorFilter({});
            setOffset(0);
          }}
        />
      )}
      <label className="evidence-field">
        <span>Status</span>
        <select
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as EvidenceStatus | "");
            setOffset(0);
          }}
        >
          <option value="">All statuses</option>
          {evidenceStatuses.map((status) => (
            <option key={status} value={status}>
              {evidenceLabel(status)}
            </option>
          ))}
        </select>
      </label>
      {!invoiceId && !filingId && (api.invoices || api.filings) && (
        <div className="grid gap-2 min-w-0">
          <label className="evidence-field">
            <span>Linked record</span>
            <select
              value={anchorType}
              onChange={(event) => {
                setAnchorType(event.target.value as typeof anchorType);
                setAnchorFilter({});
                setOffset(0);
              }}
            >
              {api.invoices && <option value="invoiceId">Invoice</option>}
              {api.filings && <option value="filingId">Filing</option>}
            </select>
          </label>
          {currentClient ? (
            <EvidenceRecordPicker
              key={`${currentClient.id}:${anchorType}`}
              api={api}
              kind={anchorType}
              clientPartyId={currentClient.id}
              value={anchorFilter[anchorType] ?? ""}
              onChange={(value) => {
                setAnchorFilter(value ? { [anchorType]: value } : {});
                setOffset(0);
              }}
            />
          ) : (
            <p className="evidence-muted">
              Choose a client to filter linked records.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
function EvidenceListView({ state }: { state: WorkspaceState }) {
  const {
    list,
    status,
    anchorFilter,
    selectedClient,
    currentClient,
    setSelectedId,
  } = state;
  const labels = useEvidenceClientLabels(
    state.api,
    list.data?.items.map((request) => request.clientPartyId) ?? [],
  );
  return (
    <>
      {" "}
      {list.data?.notice && (
        <p className="evidence-notice" role="status">
          {list.data.notice}
        </p>
      )}
      {list.data && !list.data.scanAvailable && !list.data.notice && (
        <p className="evidence-muted">
          Scanning is unavailable. Unscanned files remain quarantined.
        </p>
      )}
      <EvidenceErrorMessage error={list.error} retry={list.refresh} />
      {list.loading && (
        <p role="status" className="evidence-muted">
          Loading evidence requests...
        </p>
      )}
      {!list.loading && !list.error && list.data?.items.length === 0 && (
        <div className="py-8 border-y">
          <h2>No evidence requests</h2>
          <p className="evidence-muted mt-2">
            {status ||
            anchorFilter.invoiceId ||
            anchorFilter.filingId ||
            selectedClient
              ? "No requests match these filters."
              : "There are no evidence requests for this workspace yet."}
          </p>
        </div>
      )}
      {!!list.data?.items.length && (
        <div
          className="evidence-list"
          aria-label="Evidence requests"
          aria-busy={list.loading}
        >
          {list.data.items.map((request) => (
            <button
              key={request.id}
              className="evidence-row"
              disabled={list.loading || !!list.error}
              onClick={() => setSelectedId(request.id)}
            >
              <span>
                <strong>{request.title}</strong>
                <small>
                  {currentClient?.id === request.clientPartyId
                    ? currentClient.label
                    : (labels.data?.[request.clientPartyId] ??
                      "Client evidence")}{" "}
                  | {evidenceLabel(request.documentType)}
                </small>
              </span>
              <EvidenceStatusMark status={request.status} />
              <span className="text-sm">
                Due {evidenceDate(request.dueAt)}
                <small>
                  {request.period ??
                    (request.invoiceId ? "Invoice linked" : "Filing linked")}
                </small>
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
function EvidencePagination({ state }: { state: WorkspaceState }) {
  const { list, total, offset, setOffset } = state;
  return (
    <nav className="evidence-toolbar" aria-label="Evidence pagination">
      <p className="evidence-muted" role="status">
        {list.data
          ? `${total ? offset + 1 : 0}-${Math.min(offset + list.data.items.length, total)} of ${total}`
          : ""}
      </p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          title="Previous page"
          aria-label="Previous page"
          size="icon"
          disabled={list.loading || !!list.error || offset === 0}
          onClick={() => setOffset(Math.max(0, offset - 20))}
        >
          <ArrowLeft aria-hidden="true" />
        </Button>
        <Button
          variant="outline"
          title="Next page"
          aria-label="Next page"
          size="icon"
          disabled={list.loading || !!list.error || offset + 20 >= total}
          onClick={() => setOffset(offset + 20)}
        >
          <ArrowRight aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}

function useEvidenceSelection(embedded = false) {
  const [search] = useNavigationQuery();
  const requestedId =
    new URLSearchParams(search).get("requestId") ??
    new URLSearchParams(search).get("request");
  const [selectedId, setSelectedId] = useState<string | null>(
    !embedded && requestedId && evidenceUuid(requestedId) ? requestedId : null,
  );
  useEffect(() => {
    if (!embedded)
      setSelectedId(
        requestedId && evidenceUuid(requestedId) ? requestedId : null,
      );
  }, [requestedId, embedded]);
  return [selectedId, setSelectedId] as const;
}

function evidenceScopeFilters({
  pinnedClient,
  selectedClient,
  anchorFilter,
  invoiceId,
  filingId,
  status,
  offset,
}: {
  pinnedClient?: EvidenceOption;
  selectedClient: EvidenceOption | null;
  anchorFilter: Pick<EvidenceFilters, "invoiceId" | "filingId">;
  invoiceId?: string;
  filingId?: string;
  status: EvidenceStatus | "";
  offset: number;
}): EvidenceFilters {
  const filters: EvidenceFilters = {
    clientPartyId: pinnedClient?.id ?? selectedClient?.id,
    ...anchorFilter,
    ...(invoiceId ? { invoiceId } : {}),
    ...(filingId ? { filingId } : {}),
    status: status || undefined,
    offset,
    limit: 20,
  };
  return filters;
}
