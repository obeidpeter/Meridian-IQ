import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { Button } from "./ui/button";
import { useUnsavedWork } from "./unsaved-work";
import { EvidenceErrorMessage } from "./evidence-controls";
import { useEvidenceRead, useEvidenceWrite } from "./evidence-state";
import type {
  EvidenceApi,
  EvidenceDetailView,
  EvidenceUpdateInput,
} from "./evidence-types";

function localDateTime(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

export function EvidenceAssignment({
  api,
  detail,
  disabled,
  onChanged,
  onDirty,
  onBusy,
  refresh,
}: {
  api: EvidenceApi;
  detail: EvidenceDetailView;
  disabled: boolean;
  onChanged: (value: EvidenceDetailView) => void;
  onDirty: (value: boolean) => void;
  onBusy: (value: boolean) => void;
  refresh: () => void;
}) {
  const [ownerId, setOwnerId] = useState(detail.request.ownerId);
  const [dueAt, setDueAt] = useState(localDateTime(detail.request.dueAt));
  const [original] = useState({
    ownerId: detail.request.ownerId,
    dueAt: localDateTime(detail.request.dueAt),
  });
  const [validation, setValidation] = useState<string | null>(null);
  const owners = useEvidenceRead(
    (signal) => api.owners?.(signal) ?? Promise.resolve([]),
    [],
  );
  const save = useEvidenceWrite<EvidenceUpdateInput, EvidenceDetailView>(
    (input) => api.update(detail.request.id, input),
    onChanged,
    refresh,
  );
  const ownerChanged = ownerId !== original.ownerId;
  const dueChanged = dueAt !== original.dueAt;
  const dirty = ownerChanged || dueChanged || !!save.pending;
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  useEffect(() => {
    onBusy(save.busy);
    return () => onBusy(false);
  }, [save.busy, onBusy]);
  async function submit() {
    if (disabled || !dirty) return false;
    if (save.pending) return save.run();
    if (ownerChanged && !owners.data?.some((owner) => owner.id === ownerId)) {
      setValidation("Choose an active staff member from this firm.");
      return false;
    }
    if (dueAt && !Number.isFinite(new Date(dueAt).getTime())) {
      setValidation("Enter a valid deadline.");
      return false;
    }
    setValidation(null);
    return save.run({
      expectedVersion: detail.request.version,
      ...(ownerChanged ? { ownerId } : {}),
      ...(dueChanged
        ? { dueAt: dueAt ? new Date(dueAt).toISOString() : null }
        : {}),
    });
  }
  useUnsavedWork({
    dirty,
    save: submit,
    discard: () => {
      if (save.busy) return false;
      setOwnerId(detail.request.ownerId);
      setDueAt(localDateTime(detail.request.dueAt));
      return true;
    },
    disabledReason: disabled
      ? "Refresh this request before saving assignment changes."
      : save.busy
        ? "Wait for the update to finish."
        : null,
  });
  return (
    <form
      aria-label="Edit assignment and deadline"
      className="evidence-section"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h2>Assignment and deadline</h2>
      <fieldset disabled={disabled || save.locked} className="evidence-fields">
        <label className="evidence-field">
          <span>Request owner</span>
          <select
            value={ownerId}
            disabled={owners.loading || !!owners.error}
            onChange={(event) => setOwnerId(event.target.value)}
          >
            {!owners.data?.some(
              (owner) => owner.id === detail.request.ownerId,
            ) && (
              <option value={detail.request.ownerId}>
                Current owner (not in active staff list)
              </option>
            )}
            {owners.data?.map((owner) => (
              <option key={owner.id} value={owner.id}>
                {owner.label}
              </option>
            ))}
          </select>
        </label>
        <label className="evidence-field">
          <span>Request deadline (optional)</span>
          <input
            type="datetime-local"
            value={dueAt}
            onChange={(event) => setDueAt(event.target.value)}
          />
        </label>
      </fieldset>
      {owners.loading && (
        <p role="status" className="evidence-muted">
          Loading staff...
        </p>
      )}
      <EvidenceErrorMessage error={owners.error} retry={owners.refresh} />
      <EvidenceErrorMessage error={validation ?? save.error} />
      <Button type="submit" disabled={disabled || save.busy || !dirty}>
        <Save aria-hidden="true" />
        {save.busy
          ? "Saving assignment..."
          : save.pending
            ? "Retry assignment"
            : "Save assignment"}
      </Button>
    </form>
  );
}
