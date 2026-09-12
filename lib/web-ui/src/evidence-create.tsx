import { useRef, useState } from "react";
import { Send } from "lucide-react";
import { Button } from "./ui/button";
import { useUnsavedWork } from "./unsaved-work";
import {
  EvidenceClientPicker,
  EvidenceErrorMessage,
  EvidenceSheet,
} from "./evidence-controls";
import { evidenceKinds, evidenceLabel, evidenceUuid } from "./evidence-helpers";
import { useEvidenceRead, useEvidenceWrite } from "./evidence-state";
import { EvidenceRecordPicker } from "./evidence-record-picker";
import type {
  EvidenceApi,
  EvidenceCreateInput,
  EvidenceDetailView,
  EvidenceDocumentKind,
  EvidenceOption,
  EvidencePrincipal,
} from "./evidence-types";

function useEvidenceCreate({
  api,
  me,
  client,
  invoiceId,
  filingId,
  onClose,
  onCreated,
}: {
  api: EvidenceApi;
  me: EvidencePrincipal;
  client?: EvidenceOption;
  invoiceId?: string;
  filingId?: string;
  onClose: () => void;
  onCreated: (detail: EvidenceDetailView) => void;
}) {
  const [selectedClient, setClient] = useState<EvidenceOption | null>(
    client ?? null,
  );
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<EvidenceDocumentKind>("other");
  const [anchor, setAnchor] = useState<"invoiceId" | "filingId" | "period">(
    invoiceId ? "invoiceId" : filingId ? "filingId" : "period",
  );
  const [anchorValue, setAnchorValue] = useState(invoiceId ?? filingId ?? "");
  const [dueAt, setDueAt] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [validation, setValidation] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const owners = useEvidenceRead(
    (signal) => api.owners?.(signal) ?? Promise.resolve([]),
    [],
  );
  const save = useEvidenceWrite<EvidenceCreateInput, EvidenceDetailView>(
    api.create,
    onCreated,
  );
  const dirty = Boolean(
    title ||
    description ||
    dueAt ||
    ownerId ||
    (!invoiceId && !filingId && anchorValue) ||
    save.pending,
  );
  async function submit() {
    if (save.pending) return save.run();
    if (!form.current?.reportValidity()) return false;
    if (
      !selectedClient ||
      !title.trim() ||
      (anchor === "period"
        ? !/^\d{4}-(0[1-9]|1[0-2])$/.test(anchorValue)
        : !evidenceUuid(anchorValue))
    ) {
      setValidation(
        "Select a client, enter a title, and choose a reporting period or linked record.",
      );
      return false;
    }
    setValidation(null);
    return save.run({
      clientPartyId: selectedClient.id,
      title: title.trim(),
      description: description.trim() || undefined,
      documentType: kind,
      [anchor]: anchorValue,
      dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
      ownerId: ownerId || undefined,
    });
  }
  useUnsavedWork({
    dirty,
    save: submit,
    discard: () => {
      if (save.busy) return false;
      onClose();
      return true;
    },
    disabledReason: save.busy
      ? "Wait for the current request to finish."
      : null,
  });
  return {
    api,
    me,
    client,
    invoiceId,
    filingId,
    onClose,
    selectedClient,
    setClient,
    title,
    setTitle,
    description,
    setDescription,
    kind,
    setKind,
    anchor,
    setAnchor,
    anchorValue,
    setAnchorValue,
    dueAt,
    setDueAt,
    ownerId,
    setOwnerId,
    validation,
    form,
    owners,
    save,
    dirty,
    submit,
  };
}

type CreateState = ReturnType<typeof useEvidenceCreate>;
export function EvidenceCreate(props: Parameters<typeof useEvidenceCreate>[0]) {
  const state = useEvidenceCreate(props);
  const {
    api,
    me,
    client,
    invoiceId,
    filingId,
    onClose,
    selectedClient,
    setClient,
    title,
    setTitle,
    description,
    setDescription,
    kind,
    setKind,
    setAnchorValue,
    dueAt,
    setDueAt,
    ownerId,
    setOwnerId,
    validation,
    form,
    owners,
    save,
    dirty,
    submit,
  } = state;
  return (
    <EvidenceSheet
      title="Request evidence"
      description={client?.label ?? "New evidence request"}
      onClose={onClose}
      dirty={dirty}
      busy={save.busy}
    >
      <form
        aria-label="Request evidence"
        ref={form}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="grid gap-4"
      >
        <fieldset disabled={save.locked} className="evidence-fields">
          {client ? (
            <p className="evidence-wide text-sm">Client: {client.label}</p>
          ) : (
            <div className="evidence-wide">
              <EvidenceClientPicker
                api={api}
                value={selectedClient}
                onChange={(value) => {
                  setClient(value);
                  if (!invoiceId && !filingId) setAnchorValue("");
                }}
                required
              />
            </div>
          )}
          <label className="evidence-field evidence-wide">
            <span>Title</span>
            <input
              required
              maxLength={160}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              autoComplete="off"
            />
          </label>
          <label className="evidence-field evidence-wide">
            <span>Description (optional)</span>
            <textarea
              maxLength={2000}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <label className="evidence-field">
            <span>Document type</span>
            <select
              value={kind}
              onChange={(event) =>
                setKind(event.target.value as EvidenceDocumentKind)
              }
            >
              {evidenceKinds.map((kind) => (
                <option value={kind} key={kind}>
                  {evidenceLabel(kind)}
                </option>
              ))}
            </select>
          </label>
          <label className="evidence-field">
            <span>Due date (optional)</span>
            <input
              type="datetime-local"
              value={dueAt}
              onChange={(event) => setDueAt(event.target.value)}
            />
          </label>
          <EvidenceCreateAnchor state={state} />
          <label className="evidence-field evidence-wide">
            <span>Owner</span>
            <select
              value={ownerId}
              onChange={(event) => setOwnerId(event.target.value)}
            >
              <option value="">{me.fullName ?? "Me"}</option>
              {owners.data
                ?.filter((owner) => owner.id !== me.userId)
                .map((owner) => (
                  <option key={owner.id} value={owner.id}>
                    {owner.label}
                  </option>
                ))}
            </select>
          </label>
        </fieldset>
        <EvidenceErrorMessage error={owners.error} retry={owners.refresh} />
        <EvidenceErrorMessage error={validation ?? save.error} />
        <Button type="submit" disabled={save.busy}>
          <Send aria-hidden="true" />
          {save.busy
            ? "Sending request..."
            : save.pending
              ? "Retry request"
              : "Send request"}
        </Button>
      </form>
    </EvidenceSheet>
  );
}

function EvidenceCreateAnchor({ state }: { state: CreateState }) {
  const {
    api,
    invoiceId,
    filingId,
    anchor,
    setAnchor,
    anchorValue,
    setAnchorValue,
    selectedClient,
  } = state;
  return (
    <>
      {" "}
      <label className="evidence-field">
        <span>Linked to</span>
        <select
          value={anchor}
          disabled={!!invoiceId || !!filingId}
          onChange={(event) => {
            setAnchor(event.target.value as typeof anchor);
            setAnchorValue("");
          }}
        >
          <option value="period">Period</option>
          {(api.invoices || invoiceId) && (
            <option value="invoiceId">Invoice</option>
          )}
          {(api.filings || filingId) && (
            <option value="filingId">Filing</option>
          )}
        </select>
      </label>
      {anchor === "period" ? (
        <label className="evidence-field">
          <span>Period</span>
          <input
            type="month"
            required
            value={anchorValue}
            onChange={(event) => setAnchorValue(event.target.value)}
          />
        </label>
      ) : invoiceId || filingId ? (
        <p className="text-sm">
          Linked {invoiceId ? "invoice" : "filing"}: {invoiceId ?? filingId}
        </p>
      ) : selectedClient ? (
        <EvidenceRecordPicker
          key={`${selectedClient.id}:${anchor}`}
          api={api}
          kind={anchor}
          clientPartyId={selectedClient.id}
          value={anchorValue}
          onChange={setAnchorValue}
          required
        />
      ) : (
        <p className="evidence-muted">
          Choose a client to select a linked record.
        </p>
      )}
    </>
  );
}
