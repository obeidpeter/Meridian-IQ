import { useEffect, useRef, useState } from "react";
import { Download, Pencil, RefreshCw } from "lucide-react";
import { Button } from "./ui/button";
import {
  EvidenceErrorMessage,
  EvidenceSheet,
  EvidenceStatusMark,
} from "./evidence-controls";
import { EvidenceFileRow, EvidenceUpload } from "./evidence-files";
import { EvidenceReview } from "./evidence-review";
import { EvidenceAssignment } from "./evidence-assignment";
import {
  evidenceDate,
  evidenceError,
  evidenceFilename,
  evidenceLabel,
  readEvidenceBytes,
  saveEvidenceBlob,
} from "./evidence-helpers";
import { useEvidenceRead } from "./evidence-state";
import { useEvidenceClientLabels, useEvidencePeople } from "./evidence-labels";
import type {
  EvidenceApi,
  EvidenceDetailView,
  EvidenceOption,
} from "./evidence-types";

type DetailProps = {
  api: EvidenceApi;
  id: string;
  client?: EvidenceOption;
  permissions: { upload: boolean; review: boolean; request: boolean };
  uploadAvailable: boolean;
  scanAvailable: boolean;
  onClose: () => void;
  onChanged: () => void;
};

function useEvidenceDetail(props: DetailProps) {
  const { api, id, onChanged } = props;
  const read = useEvidenceRead((signal) => api.detail(id, signal), [id]);
  const [uploadDirty, setUploadDirty] = useState(false);
  const [reviewDirty, setReviewDirty] = useState(false);
  const [assignmentDirty, setAssignmentDirty] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [assignmentBusy, setAssignmentBusy] = useState(false);
  const [editingAssignment, setEditingAssignment] = useState(false);
  function updated(value: EvidenceDetailView) {
    if (value.request.id !== id) {
      read.refresh();
      return;
    }
    read.replace(value);
    onChanged();
  }
  return {
    props,
    read,
    updated,
    setUploadDirty,
    setReviewDirty,
    setAssignmentDirty,
    setUploadBusy,
    setReviewBusy,
    setAssignmentBusy,
    editingAssignment,
    setEditingAssignment,
    uploadBusy,
    reviewBusy,
    assignmentBusy,
    busy: uploadBusy || reviewBusy || assignmentBusy,
    dirty: uploadDirty || reviewDirty || assignmentDirty,
    disabled: read.loading || !!read.error,
  };
}
type DetailState = ReturnType<typeof useEvidenceDetail>;

function evidencePackReady(detail?: EvidenceDetailView) {
  if (detail?.request.status !== "accepted") return false;
  return detail.files.some(
    (file) =>
      file.id === detail.request.acceptedFileId && file.scanStatus === "clean",
  );
}

export function EvidenceDetailPanel(props: DetailProps) {
  const state = useEvidenceDetail(props);
  const request = state.read.data?.request;
  const names = useEvidenceClientLabels(
    props.api,
    request ? [request.clientPartyId] : [],
  );
  const clientLabel =
    props.client?.label ??
    (request ? names.data?.[request.clientPartyId] : undefined) ??
    "Client evidence";
  return (
    <EvidenceSheet
      title={request?.title ?? "Evidence request"}
      description={clientLabel}
      onClose={props.onClose}
      dirty={state.dirty}
      busy={state.busy}
    >
      <div className="evidence-toolbar">
        <Button
          variant="outline"
          disabled={state.busy || state.read.loading}
          onClick={state.read.refresh}
        >
          <RefreshCw aria-hidden="true" />
          Refresh record
        </Button>
        {request && (
          <EvidencePack
            api={props.api}
            id={props.id}
            title={request.title}
            disabled={
              state.disabled ||
              state.busy ||
              !evidencePackReady(state.read.data)
            }
          />
        )}
      </div>
      {state.read.loading && (
        <p role="status" className="evidence-muted py-4">
          Loading evidence details...
        </p>
      )}
      <EvidenceErrorMessage
        error={state.read.error}
        retry={state.read.refresh}
      />
      {state.read.data && (
        <EvidenceDetailBody
          state={state}
          detail={state.read.data}
          clientLabel={clientLabel}
        />
      )}
    </EvidenceSheet>
  );
}

function EvidencePack({
  api,
  id,
  title,
  disabled,
}: {
  api: EvidenceApi;
  id: string;
  title: string;
  disabled: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  async function download() {
    if (disabled || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const blob = await api.pack(id);
      const signature = new Uint8Array(
        await readEvidenceBytes(blob.slice(0, 4)),
      );
      if (
        signature[0] !== 80 ||
        signature[1] !== 75 ||
        ![3, 5, 7].includes(signature[2])
      )
        throw new Error("Invalid evidence pack");
      if (live.current)
        saveEvidenceBlob(
          new Blob([blob], { type: "application/zip" }),
          evidenceFilename(title + ".zip", "application/zip"),
        );
    } catch (error) {
      if (live.current) setError(evidenceError(error));
    } finally {
      lock.current = false;
      if (live.current) setBusy(false);
    }
  }
  return (
    <div>
      <Button
        variant="outline"
        className="aria-disabled:opacity-50 aria-busy:cursor-wait"
        disabled={disabled}
        aria-disabled={disabled || busy}
        aria-busy={busy}
        onClick={() => void download()}
      >
        <Download aria-hidden="true" />
        {busy ? "Preparing pack..." : "Download pack"}
      </Button>
      <EvidenceErrorMessage error={error} />
    </div>
  );
}

function EvidenceDetailBody({
  state,
  detail,
  clientLabel,
}: {
  state: DetailState;
  detail: EvidenceDetailView;
  clientLabel: string;
}) {
  const { props, disabled, updated } = state;
  const people = useEvidencePeople(props.api);
  const names = people.data ?? {};
  return (
    <>
      <EvidenceRequestSummary
        request={detail.request}
        clientLabel={clientLabel}
        people={names}
      />
      <EvidenceAssignmentControl state={state} detail={detail} />
      <EvidenceUploadControl state={state} detail={detail} />
      <EvidenceVersions
        detail={detail}
        api={props.api}
        canReview={props.permissions.review}
        scanAvailable={props.scanAvailable}
        disabled={disabled || state.busy}
        onChanged={updated}
        people={names}
      />
      {props.permissions.review && detail.request.status !== "cancelled" && (
        <EvidenceReview
          api={props.api}
          detail={detail}
          disabled={disabled || state.uploadBusy || state.assignmentBusy}
          onChanged={updated}
          refresh={state.read.refresh}
          onDirty={state.setReviewDirty}
          onBusy={state.setReviewBusy}
        />
      )}
      <EvidenceHistory detail={detail} people={names} />
    </>
  );
}

function EvidenceAssignmentControl({
  state,
  detail,
}: {
  state: DetailState;
  detail: EvidenceDetailView;
}) {
  if (
    !state.props.permissions.request ||
    ["accepted", "cancelled"].includes(detail.request.status)
  )
    return null;
  if (!state.editingAssignment)
    return (
      <Button
        variant="outline"
        disabled={state.disabled || state.busy}
        onClick={() => state.setEditingAssignment(true)}
      >
        <Pencil aria-hidden="true" />
        Edit assignment and deadline
      </Button>
    );
  return (
    <EvidenceAssignment
      api={state.props.api}
      detail={detail}
      disabled={state.disabled || state.uploadBusy || state.reviewBusy}
      onChanged={(value) => {
        state.updated(value);
        state.setEditingAssignment(false);
      }}
      onDirty={state.setAssignmentDirty}
      onBusy={state.setAssignmentBusy}
      refresh={state.read.refresh}
    />
  );
}

function EvidenceUploadControl({
  state,
  detail,
}: {
  state: DetailState;
  detail: EvidenceDetailView;
}) {
  if (
    !state.props.permissions.upload ||
    ["accepted", "cancelled"].includes(detail.request.status)
  )
    return null;
  return (
    <>
      {!state.props.uploadAvailable && (
        <p role="status" className="evidence-notice">
          Uploads are currently unavailable. Existing records remain available.
        </p>
      )}
      <EvidenceUpload
        api={state.props.api}
        detail={detail}
        disabled={
          state.disabled ||
          !state.props.uploadAvailable ||
          state.reviewBusy ||
          state.assignmentBusy
        }
        onChanged={state.updated}
        refresh={state.read.refresh}
        onDirty={state.setUploadDirty}
        onBusy={state.setUploadBusy}
      />
    </>
  );
}

function EvidenceRequestSummary({
  request,
  clientLabel,
  people,
}: {
  request: EvidenceDetailView["request"];
  clientLabel: string;
  people: Record<string, string>;
}) {
  const anchor = request.invoiceId
    ? "Invoice"
    : request.filingId
      ? "Filing"
      : "Period";
  const metadata = [
    ["Client", clientLabel],
    ["Document type", evidenceLabel(request.documentType)],
    ["Due", evidenceDate(request.dueAt)],
    ["Owner", people[request.ownerId] ?? "Assigned workspace member"],
    ["Created by", people[request.createdBy] ?? "Workspace member"],
    ["Created", evidenceDate(request.createdAt)],
    ["Updated", evidenceDate(request.updatedAt)],
    [anchor, request.period ?? `Linked ${anchor.toLowerCase()}`],
  ];
  return (
    <section className="evidence-section mt-4" aria-label="Request details">
      <div className="evidence-toolbar">
        <EvidenceStatusMark status={request.status} />
        <span className="evidence-muted">
          Request version {request.version}
        </span>
      </div>
      {request.description && (
        <p className="text-sm whitespace-pre-wrap">{request.description}</p>
      )}
      <dl className="evidence-meta">
        {metadata.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <details className="text-xs">
        <summary>Record identifiers</summary>
        <p>Request: {request.id}</p>
        <p>Client: {request.clientPartyId}</p>
        <p>Owner: {request.ownerId}</p>
        <p>
          {anchor}: {request.invoiceId ?? request.filingId ?? request.period}
        </p>
      </details>
    </section>
  );
}

function EvidenceVersions({
  detail,
  api,
  canReview,
  scanAvailable,
  disabled,
  onChanged,
  people,
}: {
  detail: EvidenceDetailView;
  api: EvidenceApi;
  canReview: boolean;
  scanAvailable: boolean;
  disabled: boolean;
  onChanged: (value: EvidenceDetailView) => void;
  people: Record<string, string>;
}) {
  return (
    <section className="evidence-section" aria-label="File versions">
      <h2>File versions ({detail.files.length})</h2>
      {!detail.files.length ? (
        <p className="evidence-muted">No documents uploaded yet.</p>
      ) : (
        <ul>
          {[...detail.files]
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map((file) => (
              <EvidenceFileRow
                key={file.id + ":" + file.scanStatus}
                file={file}
                latest={detail.request.latestFileId === file.id}
                accepted={detail.request.acceptedFileId === file.id}
                api={api}
                canReview={canReview}
                scanAvailable={scanAvailable}
                disabled={disabled}
                onChanged={onChanged}
                uploadedByLabel={people[file.uploadedBy] ?? "Workspace member"}
              />
            ))}
        </ul>
      )}
    </section>
  );
}

function EvidenceHistory({
  detail,
  people,
}: {
  detail: EvidenceDetailView;
  people: Record<string, string>;
}) {
  return (
    <section className="evidence-section" aria-label="Review history">
      <h2>Review history</h2>
      {!detail.events.length ? (
        <p className="evidence-muted">No activity recorded.</p>
      ) : (
        <ol className="evidence-history">
          {[...detail.events]
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map((event) => (
              <li key={event.id}>
                <p className="font-medium">{evidenceLabel(event.action)}</p>
                <p className="evidence-muted">
                  {evidenceDate(event.createdAt)} |{" "}
                  {event.actorId
                    ? (people[event.actorId] ?? "Workspace member")
                    : "System"}
                </p>
                {event.fileId && (
                  <p className="evidence-muted">
                    File:{" "}
                    {detail.files.find((file) => file.id === event.fileId)
                      ?.filename ?? event.fileId}
                  </p>
                )}
                {event.comment && (
                  <p className="whitespace-pre-wrap mt-1">{event.comment}</p>
                )}
              </li>
            ))}
        </ol>
      )}
    </section>
  );
}
