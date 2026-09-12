import { useEffect, useRef, useState } from "react";
import { Download, Eye, RotateCcw, Upload, X } from "lucide-react";
import { Button } from "./ui/button";
import { useUnsavedWork } from "./unsaved-work";
import { EvidenceErrorMessage, EvidenceStatusMark } from "./evidence-controls";
import {
  checkedEvidenceBlob,
  evidenceDate,
  evidenceError,
  evidenceFilename,
  evidenceUploadContent,
  saveEvidenceBlob,
} from "./evidence-helpers";
import { useEvidenceWrite } from "./evidence-state";
import type {
  EvidenceApi,
  EvidenceDetailView,
  EvidenceUploadInput,
  EvidenceVersion,
} from "./evidence-types";

export function EvidenceUpload({
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
  const [file, setFile] = useState<File | null>(null);
  const [reading, setReading] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const readingRef = useRef(false);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const upload = useEvidenceWrite<EvidenceUploadInput, EvidenceDetailView>(
    (payload) => api.upload(detail.request.id, payload),
    (value) => {
      setFile(null);
      if (input.current) input.current.value = "";
      onChanged(value);
    },
    refresh,
  );
  const busy = reading || upload.busy;
  const dirty = !!file || !!upload.pending;
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);
  async function submit() {
    if (disabledRef.current || readingRef.current) return false;
    if (upload.pending) return upload.run();
    if (!file) {
      setValidation("Select a document to upload.");
      input.current?.focus();
      return false;
    }
    readingRef.current = true;
    setReading(true);
    setValidation(null);
    try {
      const content = await evidenceUploadContent(file);
      if (!alive.current || disabledRef.current) return false;
      return await upload.run({
        ...content,
        expectedVersion: detail.request.version,
      });
    } catch (error) {
      if (alive.current)
        setValidation(
          error instanceof Error
            ? error.message
            : "The document could not be read.",
        );
      return false;
    } finally {
      readingRef.current = false;
      if (alive.current) setReading(false);
    }
  }
  useUnsavedWork({
    dirty,
    save: submit,
    discard: () => {
      if (busy) return false;
      setFile(null);
      if (input.current) input.current.value = "";
      return true;
    },
    disabledReason: disabled
      ? "Refresh evidence before uploading."
      : busy
        ? "Wait for the upload to finish."
        : null,
  });
  return (
    <form
      aria-label="Upload evidence"
      className="evidence-section"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h2>Upload document</h2>
      <label className="evidence-field">
        <span>PDF or photo (up to 5 MB)</span>
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,application/pdf"
          disabled={disabled || busy || !!upload.pending}
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setValidation(null);
          }}
        />
      </label>
      {file && (
        <p className="evidence-muted">
          {file.name} ({(file.size / 1024).toFixed(1)} KB)
        </p>
      )}
      <EvidenceErrorMessage error={validation ?? upload.error} />
      <Button type="submit" disabled={disabled || busy}>
        <Upload aria-hidden="true" />
        {busy
          ? "Uploading..."
          : upload.pending
            ? "Retry upload"
            : "Upload document"}
      </Button>
    </form>
  );
}

export function EvidenceFileRow({
  file,
  latest,
  accepted,
  api,
  canReview,
  scanAvailable,
  disabled,
  onChanged,
  uploadedByLabel = "Workspace member",
}: {
  file: EvidenceVersion;
  latest: boolean;
  accepted: boolean;
  api: EvidenceApi;
  canReview: boolean;
  scanAvailable: boolean;
  disabled: boolean;
  onChanged: (value: EvidenceDetailView) => void;
  uploadedByLabel?: string;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(true);
  const inFlight = useRef(false);
  const activeUrl = useRef<string | null>(null);
  const scan = useEvidenceWrite<
    { clientRequestId: string },
    EvidenceDetailView
  >((input) => api.scan(file.id, input), onChanged);
  useEffect(() => {
    current.current = true;
    return () => {
      current.current = false;
      if (activeUrl.current) URL.revokeObjectURL(activeUrl.current);
      activeUrl.current = null;
    };
  }, [file.id, file.scanStatus]);
  function closePreview() {
    if (activeUrl.current) URL.revokeObjectURL(activeUrl.current);
    activeUrl.current = null;
    setPreview(null);
  }
  async function download(previewImage: boolean) {
    if (
      inFlight.current ||
      disabled ||
      file.scanStatus !== "clean" ||
      (previewImage && file.contentType === "application/pdf")
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const blob = await checkedEvidenceBlob(await api.download(file.id), file);
      if (!current.current) return;
      if (previewImage) {
        closePreview();
        activeUrl.current = URL.createObjectURL(blob);
        setPreview(activeUrl.current);
      } else
        saveEvidenceBlob(
          blob,
          evidenceFilename(file.filename, file.contentType),
        );
    } catch (error) {
      if (current.current) setError(evidenceError(error));
    } finally {
      inFlight.current = false;
      if (current.current) setBusy(false);
    }
  }
  return (
    <li className="evidence-version">
      <EvidenceFileMetadata
        file={file}
        latest={latest}
        accepted={accepted}
        uploadedByLabel={uploadedByLabel}
      />
      <div className="flex flex-wrap gap-2 mt-3">
        {file.scanStatus === "clean" && (
          <Button
            variant="outline"
            className="aria-disabled:opacity-50 aria-busy:cursor-wait"
            disabled={disabled}
            aria-disabled={disabled || busy}
            aria-busy={busy}
            onClick={() => void download(false)}
          >
            <Download aria-hidden="true" />
            Download
          </Button>
        )}
        {file.scanStatus === "clean" &&
          file.contentType !== "application/pdf" && (
            <Button
              variant="outline"
              className="aria-disabled:opacity-50 aria-busy:cursor-wait"
              disabled={disabled}
              aria-disabled={disabled || busy}
              aria-busy={busy}
              onClick={() => {
                if (disabled || inFlight.current) return;
                if (preview) closePreview();
                else void download(true);
              }}
            >
              {preview ? <X aria-hidden="true" /> : <Eye aria-hidden="true" />}
              {preview ? "Close preview" : "Preview image"}
            </Button>
          )}
        {canReview && file.scanStatus === "quarantined" && file.scanError && (
          <Button
            variant="outline"
            disabled={disabled || !scanAvailable || scan.busy}
            onClick={() => void scan.run({})}
          >
            <RotateCcw aria-hidden="true" />
            {scan.busy ? "Queueing scan..." : "Retry scan"}
          </Button>
        )}
      </div>
      {busy && (
        <p role="status" className="evidence-muted">
          Preparing document...
        </p>
      )}
      <EvidenceErrorMessage error={error ?? scan.error} />
      {preview && file.scanStatus === "clean" && (
        <img
          className="evidence-preview mt-3"
          src={preview}
          alt={`Evidence: ${file.filename}`}
          onError={() => {
            closePreview();
            setError(
              "The image could not be displayed. Download the original document instead.",
            );
          }}
        />
      )}
    </li>
  );
}

function EvidenceFileMetadata({
  file,
  latest,
  accepted,
  uploadedByLabel,
}: {
  file: EvidenceVersion;
  latest: boolean;
  accepted: boolean;
  uploadedByLabel: string;
}) {
  return (
    <>
      {" "}
      <div className="evidence-toolbar">
        <p className="font-medium text-sm">{file.filename}</p>
        <EvidenceStatusMark status={file.scanStatus} />
      </div>
      <p className="evidence-muted">
        {latest ? "Latest version. " : "Previous version. "}
        {accepted ? "Accepted file. " : ""}
        {(file.byteSize / 1024).toFixed(1)} KB
      </p>
      <p className="evidence-muted">
        Uploaded {evidenceDate(file.createdAt)} by {uploadedByLabel}
      </p>
      {file.scannedAt && (
        <p className="evidence-muted">Scanned {evidenceDate(file.scannedAt)}</p>
      )}
      <details className="text-xs my-2">
        <summary>File checksum</summary>
        <p className="break-all">SHA-256: {file.sha256}</p>
      </details>
      {file.scanStatus !== "clean" && (
        <p className="evidence-muted" role="status">
          {file.scanStatus === "rejected"
            ? "This file was rejected. Upload a replacement."
            : file.scanError
              ? "The scan failed. This file remains quarantined."
              : "Waiting for a clean scan. Download and preview are unavailable."}
        </p>
      )}
    </>
  );
}
