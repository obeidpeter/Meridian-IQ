import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { fileIsPdf } from "@/pages/clerk-shared";
import {
  MAX_RECORD_SECONDS,
  MAX_VOICE_BYTES,
} from "@/pages/use-voice-recorder";
import { AlertTriangle, Mic } from "lucide-react";
import type { ClerkWorkspaceState } from "./use-clerk-workspace";

// The capture panel (R126 moved it out of the intake column): document or
// voice-note file, pasted text, the batch toggle, the run button and the
// duplicate-source banner. Renders the workspace state it is handed.
export function CaptureForm({ state }: { state: ClerkWorkspaceState }) {
  const {
    noticeCapture,
    setCaptureFile,
    setPendingDuplicate,
    captureVoice,
    captureText,
    setCaptureText,
    captureFile,
    batchMode,
    setBatchMode,
    pendingDuplicate,
    createCase,
  } = state;
  return (
    <div className="border rounded-md p-3 space-y-2">
      <Label htmlFor="capture-file">
        {noticeCapture
          ? "Notice document (PDF or photo)"
          : "Invoice document (PDF or photo)"}
      </Label>
      <Input
        id="capture-file"
        type="file"
        accept=".pdf,image/png,image/jpeg,image/webp"
        onChange={(e) => {
          setCaptureFile(e.target.files?.[0] ?? null);
          setPendingDuplicate(null);
        }}
        disabled={captureVoice != null}
        data-testid="input-capture-file"
      />
      {!noticeCapture && <CaptureVoiceInputs state={state} />}
      <p className="text-xs text-muted-foreground">
        {noticeCapture
          ? "or paste the notice text:"
          : "or paste the invoice text:"}
      </p>
      <Textarea
        aria-label={noticeCapture ? "Notice text" : "Invoice text"}
        value={captureText}
        onChange={(e) => {
          setCaptureText(e.target.value);
          setPendingDuplicate(null);
        }}
        placeholder="INVOICE No: ..."
        rows={5}
        disabled={captureFile != null || captureVoice != null}
        data-testid="input-capture-text"
      />
      {/* Batch splitting works on PDFs and pasted text only —
                        the checkbox greys out for images and voice notes,
                        and never shows for notice captures (a notice is one
                        document, not an invoice bundle). */}
      {!noticeCapture && (
        <div className="flex items-center gap-2">
          <Checkbox
            id="batch-toggle"
            checked={batchMode}
            onCheckedChange={(v) => setBatchMode(v === true)}
            disabled={
              captureVoice != null ||
              (captureFile != null && !fileIsPdf(captureFile))
            }
            data-testid="batch-toggle"
          />
          <Label htmlFor="batch-toggle" className="text-sm font-normal">
            This upload contains multiple invoices
          </Label>
        </div>
      )}
      <CaptureSubmitButton state={state} />
      {pendingDuplicate && (
        <Alert data-testid="banner-duplicate-source">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Already read this one?</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{pendingDuplicate.message}</p>
            <div className="flex gap-2 flex-wrap">
              <Button
                size="sm"
                onClick={() =>
                  createCase.mutate({
                    data: {
                      ...pendingDuplicate.payload,
                      allowDuplicate: true,
                    },
                  })
                }
                disabled={createCase.isPending}
                data-testid="button-create-anyway"
              >
                {createCase.isPending ? "Reading…" : "Create anyway"}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setPendingDuplicate(null)}
                data-testid="button-cancel-duplicate"
              >
                Cancel
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

// The voice-note inputs: the audio file picker with its 5 MB guard and the
// in-browser recorder controls.
function CaptureVoiceInputs({ state }: { state: ClerkWorkspaceState }) {
  const {
    toast,
    setPendingDuplicate,
    setVoiceFromRecorder,
    setCaptureVoice,
    captureFile,
    captureVoice,
    isRecording,
    recordSeconds,
    recordingSupported,
    startRecording,
    stopRecording,
    createCase,
    voiceFromRecorder,
  } = state;
  return (
    <>
      <Label htmlFor="capture-voice">or a voice note (max 5 MB)</Label>
      <Input
        id="capture-voice"
        type="file"
        accept="audio/*"
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          setPendingDuplicate(null);
          setVoiceFromRecorder(false);
          if (f && f.size > MAX_VOICE_BYTES) {
            toast({
              title: "Voice note too large",
              description: `Voice notes are capped at 5 MB; this file is ${(
                f.size /
                (1024 * 1024)
              ).toFixed(1)} MB. Record a shorter note.`,
              variant: "destructive",
            });
            e.target.value = "";
            setCaptureVoice(null);
            return;
          }
          setCaptureVoice(f);
        }}
        disabled={captureFile != null || isRecording}
        data-testid="input-voice-file"
      />
      {recordingSupported && (
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            type="button"
            size="sm"
            variant={isRecording ? "destructive" : "secondary"}
            onClick={isRecording ? stopRecording : startRecording}
            disabled={
              createCase.isPending || (!isRecording && captureFile != null)
            }
            data-testid="button-record-voice"
          >
            <Mic className="w-4 h-4 mr-1" aria-hidden="true" />
            {isRecording ? "Stop recording" : "Record voice note"}
          </Button>
          <span
            className="text-xs text-muted-foreground tabular-nums"
            aria-live="polite"
            data-testid="text-record-elapsed"
          >
            {isRecording
              ? `Recording… ${recordSeconds}s (stops at ${MAX_RECORD_SECONDS}s)`
              : voiceFromRecorder && captureVoice != null
                ? "Recorded note ready — recording.webm"
                : ""}
          </span>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        English voice notes; the audio is transcribed and only the transcript is
        kept.
      </p>
    </>
  );
}

function CaptureSubmitButton({ state }: { state: ClerkWorkspaceState }) {
  const {
    submitCapture,
    createCase,
    createCaseBatch,
    captureFile,
    captureVoice,
    captureText,
  } = state;
  return (
    <Button
      className="w-full"
      onClick={submitCapture}
      disabled={
        createCase.isPending ||
        createCaseBatch.isPending ||
        (!captureFile && !captureVoice && captureText.trim().length < 10)
      }
      data-testid="button-run-capture"
    >
      {createCaseBatch.isPending
        ? "Splitting…"
        : createCase.isPending
          ? captureVoice
            ? "Transcribing…"
            : "Reading…"
          : "Read with Clerk"}
    </Button>
  );
}
