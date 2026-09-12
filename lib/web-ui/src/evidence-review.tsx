import { useEffect, useRef, useState } from "react";
import { CheckCheck, Sparkles } from "lucide-react";
import { Button } from "./ui/button";
import { useUnsavedWork } from "./unsaved-work";
import { EvidenceErrorMessage, EvidenceStatusMark } from "./evidence-controls";
import { evidenceError } from "./evidence-helpers";
import { useEvidenceWrite } from "./evidence-state";
import type {
  EvidenceAdvice,
  EvidenceApi,
  EvidenceDetailView,
  EvidenceReviewInput,
} from "./evidence-types";

export function EvidenceReview({
  api,
  detail,
  disabled,
  onChanged,
  refresh,
  onDirty,
  onBusy,
}: {
  api: EvidenceApi;
  detail: EvidenceDetailView;
  disabled: boolean;
  onChanged: (value: EvidenceDetailView) => void;
  refresh: () => void;
  onDirty: (value: boolean) => void;
  onBusy: (value: boolean) => void;
}) {
  const [fileId, setFileId] = useState(detail.request.latestFileId ?? "");
  const [decision, setDecision] =
    useState<EvidenceReviewInput["decision"]>("needs_changes");
  const [comment, setComment] = useState("");
  const [touched, setTouched] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);
  const [advice, setAdvice] = useState<{
    fileId: string;
    value: EvidenceAdvice;
  } | null>(null);
  const [assistBusy, setAssistBusy] = useState(false);
  const [assistError, setAssistError] = useState<string | null>(null);
  const live = useRef(true);
  const assistLock = useRef(false);
  const review = useEvidenceWrite<EvidenceReviewInput, EvidenceDetailView>(
    (input) => api.review(detail.request.id, input),
    (value) => {
      setComment("");
      setTouched(false);
      onChanged(value);
    },
    refresh,
  );
  const selectedFile = detail.files.find((file) => file.id === fileId);
  const dirty = touched || !!comment || !!review.pending;
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  useEffect(() => {
    onBusy(review.busy);
    return () => onBusy(false);
  }, [review.busy, onBusy]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  async function submit() {
    if (disabled) return false;
    if (review.pending) return review.run();
    if (
      decision === "accepted" &&
      (selectedFile?.scanStatus !== "clean" ||
        fileId !== detail.request.latestFileId)
    ) {
      setValidation(
        "Select the latest clean document before accepting evidence.",
      );
      return false;
    }
    if (decision !== "accepted" && !comment.trim()) {
      setValidation("Add a comment explaining this decision.");
      return false;
    }
    setValidation(null);
    return review.run({
      decision,
      expectedVersion: detail.request.version,
      fileId: decision === "cancelled" ? undefined : selectedFile?.id,
      comment: comment.trim() || undefined,
    });
  }
  useUnsavedWork({
    dirty,
    save: submit,
    discard: () => {
      if (review.busy) return false;
      setComment("");
      setTouched(false);
      return true;
    },
    disabledReason: disabled
      ? "Refresh evidence before reviewing."
      : review.busy
        ? "Wait for the review to finish."
        : null,
  });
  async function assist() {
    if (assistLock.current || disabled || selectedFile?.scanStatus !== "clean")
      return;
    assistLock.current = true;
    setAssistBusy(true);
    setAssistError(null);
    setAdvice(null);
    try {
      const value = await api.assist(detail.request.id, { fileId });
      if (live.current) setAdvice({ fileId, value });
    } catch (error) {
      if (live.current) setAssistError(evidenceError(error));
    } finally {
      assistLock.current = false;
      if (live.current) setAssistBusy(false);
    }
  }
  return (
    <section className="evidence-section" aria-label="Staff review">
      <h2>Staff review</h2>
      <form
        aria-label="Review evidence"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="grid gap-3"
      >
        <fieldset
          className="evidence-fields"
          disabled={disabled || review.locked}
        >
          <label className="evidence-field evidence-wide">
            <span>Review file</span>
            <select
              value={fileId}
              onChange={(event) => {
                setFileId(event.target.value);
                setTouched(true);
                setAdvice(null);
              }}
            >
              <option value="">No file selected</option>
              {detail.files.map((file) => (
                <option key={file.id} value={file.id}>
                  {file.filename} ({file.scanStatus})
                  {file.id === detail.request.latestFileId ? " - latest" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="evidence-field evidence-wide">
            <span>Decision</span>
            <select
              value={decision}
              onChange={(event) => {
                setDecision(event.target.value as typeof decision);
                setTouched(true);
              }}
            >
              <option value="needs_changes">Needs changes</option>
              <option
                value="accepted"
                disabled={
                  selectedFile?.scanStatus !== "clean" ||
                  fileId !== detail.request.latestFileId
                }
              >
                Accept evidence
              </option>
              <option value="cancelled">Cancel request</option>
            </select>
          </label>
          <label className="evidence-field evidence-wide">
            <span>
              Review comment{decision === "accepted" ? " (optional)" : ""}
            </span>
            <textarea
              value={comment}
              maxLength={2000}
              required={decision !== "accepted"}
              onChange={(event) => setComment(event.target.value)}
            />
          </label>
        </fieldset>
        <EvidenceErrorMessage error={validation ?? review.error} />
        <Button type="submit" disabled={disabled || review.busy}>
          <CheckCheck aria-hidden="true" />
          {review.busy
            ? "Saving review..."
            : review.pending
              ? "Retry review"
              : "Record decision"}
        </Button>
      </form>
      <p className="evidence-muted">
        Acceptance records a staff decision. It is not proof of payment, an
        official tax acknowledgement, or automatic verification.
      </p>
      <Button
        variant="outline"
        disabled={
          disabled || assistBusy || selectedFile?.scanStatus !== "clean"
        }
        onClick={() => void assist()}
      >
        <Sparkles aria-hidden="true" />
        {assistBusy ? "Preparing assistance..." : "Ask Clerk to assist"}
      </Button>
      <EvidenceErrorMessage error={assistError} />
      <EvidenceAdviceView advice={advice} fileId={fileId} />
    </section>
  );
}

function EvidenceAdviceView({
  advice,
  fileId,
}: {
  advice: { fileId: string; value: EvidenceAdvice } | null;
  fileId: string;
}) {
  if (!advice || advice.fileId !== fileId) return null;
  return (
    <section className="evidence-section" aria-label="Evidence assistance">
      <h2>Clerk assistance</h2>
      <p className="evidence-muted">
        Advisory only. Review the original document before recording a decision.
      </p>
      <p className="text-sm whitespace-pre-wrap">{advice.value.summary}</p>
      {advice.value.suggestedDocumentType && (
        <p className="text-sm">
          Suggested type: {advice.value.suggestedDocumentType}
        </p>
      )}
      <ul className="grid gap-3">
        {advice.value.checks.map((check, index) => (
          <li key={index} className="text-sm">
            <div className="evidence-toolbar">
              <strong>{check.label}</strong>
              <EvidenceStatusMark status={check.status} />
            </div>
            <p>Source: {check.sourceValue ?? "Unknown"}</p>
            <p>Expected: {check.expectedValue ?? "Unknown"}</p>
          </li>
        ))}
      </ul>
      {advice.value.extractedText && (
        <details>
          <summary className="text-sm">Extracted source text</summary>
          <p className="text-sm whitespace-pre-wrap mt-2">
            {advice.value.extractedText}
          </p>
        </details>
      )}
    </section>
  );
}
