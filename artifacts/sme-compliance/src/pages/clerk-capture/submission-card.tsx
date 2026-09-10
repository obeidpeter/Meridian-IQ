import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PillToggle } from "@/components/pill-toggle";
import { Sparkles } from "lucide-react";
import { BatchProgressAlert, DuplicateSourcePanel } from "./submission-notices";
import type { CaptureState } from "./use-capture";

/**
 * The kind toggle and the three source inputs (document, voice, pasted
 * text). Returns a fragment (no wrapper element) so the four stay direct
 * children of the card's space-y-3 content, exactly as before the split.
 * The file input keeps its "capture-file" id: the submissions card's
 * empty-state CTA clicks it by id.
 */
function CaptureSourceFields({
  documentKind,
  switchKind,
  isNotice,
  captureFile,
  pickFile,
  captureVoice,
  pickVoice,
  captureText,
  editText,
}: Pick<
  CaptureState,
  | "documentKind"
  | "switchKind"
  | "isNotice"
  | "captureFile"
  | "pickFile"
  | "captureVoice"
  | "pickVoice"
  | "captureText"
  | "editText"
>) {
  return (
    <>
      <div
        className="flex flex-wrap items-center gap-2"
        role="radiogroup"
        aria-label="What are you sending?"
      >
        {(
          [
            { kind: "invoice", label: "Invoice" },
            { kind: "notice", label: "Tax notice" },
          ] as const
        ).map(({ kind, label }) => (
          <PillToggle
            key={kind}
            role="radio"
            active={documentKind === kind}
            onClick={() => switchKind(kind)}
            data-testid={`toggle-kind-${kind}`}
          >
            {label}
          </PillToggle>
        ))}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="capture-file">
          {isNotice
            ? "Notice document (PDF or photo)"
            : "Invoice document (PDF or photo)"}
        </Label>
        <Input
          id="capture-file"
          type="file"
          accept=".pdf,image/png,image/jpeg,image/webp"
          onChange={pickFile}
          disabled={captureVoice != null}
          data-testid="input-capture-file"
        />
      </div>
      {isNotice ? (
        // The server rejects voice notices, so notice mode swaps the
        // voice option for a short explanation instead of a dead control.
        <p
          className="text-xs text-muted-foreground"
          data-testid="text-notice-no-voice"
        >
          Photograph or upload the notice — voice notes aren&apos;t accepted for
          notices.
        </p>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="capture-voice">or a voice note (max 5 MB)</Label>
          <Input
            id="capture-voice"
            type="file"
            accept="audio/*"
            onChange={pickVoice}
            disabled={captureFile != null}
            data-testid="input-voice-file"
          />
          <p className="text-xs text-muted-foreground">
            English voice notes; the audio is transcribed and only the
            transcript is kept.
          </p>
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="capture-text">
          {isNotice ? "or paste the notice text" : "or paste the invoice text"}
        </Label>
        <Textarea
          id="capture-text"
          value={captureText}
          onChange={editText}
          placeholder={
            isNotice ? "NOTICE OF ASSESSMENT ..." : "INVOICE No: ..."
          }
          rows={5}
          disabled={captureFile != null || captureVoice != null}
          data-testid="input-capture-text"
        />
      </div>
    </>
  );
}

/** The "New submission" card: source inputs, batch toggle, Send, notices. */
export function SubmissionCard({
  documentKind,
  switchKind,
  isNotice,
  captureFile,
  pickFile,
  captureVoice,
  pickVoice,
  captureText,
  editText,
  batchEligible,
  batchMode,
  toggleBatch,
  submitCapture,
  createCase,
  createBatch,
  activeBatch,
  activeBatchInFlight,
  pendingDuplicate,
  setPendingDuplicate,
  submitCase,
}: Pick<
  CaptureState,
  | "documentKind"
  | "switchKind"
  | "isNotice"
  | "captureFile"
  | "pickFile"
  | "captureVoice"
  | "pickVoice"
  | "captureText"
  | "editText"
  | "batchEligible"
  | "batchMode"
  | "toggleBatch"
  | "submitCapture"
  | "createCase"
  | "createBatch"
  | "activeBatch"
  | "activeBatchInFlight"
  | "pendingDuplicate"
  | "setPendingDuplicate"
  | "submitCase"
>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary" aria-hidden="true" />
          New submission
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <CaptureSourceFields
          documentKind={documentKind}
          switchKind={switchKind}
          isNotice={isNotice}
          captureFile={captureFile}
          pickFile={pickFile}
          captureVoice={captureVoice}
          pickVoice={pickVoice}
          captureText={captureText}
          editText={editText}
        />
        {batchEligible && (
          <div className="flex items-center gap-2">
            <input
              id="batch-toggle"
              type="checkbox"
              className="h-4 w-4 rounded border-input accent-primary"
              checked={batchMode}
              onChange={toggleBatch}
              data-testid="batch-toggle"
            />
            <Label htmlFor="batch-toggle" className="font-normal">
              This contains multiple invoices{" "}
              <span className="text-muted-foreground">
                (scanned bundles up to 24 pages supported)
              </span>
            </Label>
          </div>
        )}
        <Button
          className="w-full sm:w-auto"
          onClick={submitCapture}
          disabled={
            createCase.isPending ||
            createBatch.isPending ||
            (batchMode && activeBatchInFlight) ||
            (!captureFile && !captureVoice && captureText.trim().length < 10)
          }
          data-testid="button-send-to-clerk"
        >
          {createCase.isPending || createBatch.isPending
            ? captureVoice
              ? "Transcribing…"
              : "Reading…"
            : "Send to Clerk"}
        </Button>
        {batchMode && activeBatchInFlight && (
          <p className="text-xs text-muted-foreground" role="status">
            Finish the current bundle before starting another. You can keep
            using single-invoice capture after switching batch mode off.
          </p>
        )}
        {activeBatch && <BatchProgressAlert activeBatch={activeBatch} />}
        {pendingDuplicate && (
          <DuplicateSourcePanel
            pendingDuplicate={pendingDuplicate}
            submitCase={submitCase}
            setPendingDuplicate={setPendingDuplicate}
            createCase={createCase}
          />
        )}
      </CardContent>
    </Card>
  );
}
