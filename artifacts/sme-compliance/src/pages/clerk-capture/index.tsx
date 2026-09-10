// The SME "Send to Clerk" capture page (R126 split the 982-line file into
// this shell, the state hook, one module per card and the two notices). The
// route (App.tsx) and the unit suite (clerk-capture.test.tsx) keep importing
// "@/pages/clerk-capture" / "./clerk-capture": this module is the page's
// surface.
import { Link } from "wouter";
import { CapabilityGate } from "@/components/capability-gate";
import { PageHeader } from "@/components/page-header";
import { ClerkDisabledBanner } from "@/components/clerk-disabled-banner";
import { usePageTitle } from "@/hooks/use-page-title";
import { UsageMeter } from "./usage-meter";
import { useCapture } from "./use-capture";
import { SubmissionCard } from "./submission-card";
import { SubmissionsCard } from "./submissions-card";

function CaptureContent() {
  const state = useCapture();
  const {
    disabledBanner,
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
    isLoading,
    isError,
    refetch,
    sortedCases,
    selectedId,
    setSelectedId,
  } = state;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Send to Clerk"
        description="Snap or upload an invoice — Clerk reads it and your accountant reviews it before anything is created."
      >
        <UsageMeter />
      </PageHeader>

      {disabledBanner && (
        <ClerkDisabledBanner>
          Please try again later, or{" "}
          <Link href="/invoices/new" className="underline">
            enter the invoice manually
          </Link>
          .
        </ClerkDisabledBanner>
      )}

      <SubmissionCard
        documentKind={documentKind}
        switchKind={switchKind}
        isNotice={isNotice}
        captureFile={captureFile}
        pickFile={pickFile}
        captureVoice={captureVoice}
        pickVoice={pickVoice}
        captureText={captureText}
        editText={editText}
        batchEligible={batchEligible}
        batchMode={batchMode}
        toggleBatch={toggleBatch}
        submitCapture={submitCapture}
        createCase={createCase}
        createBatch={createBatch}
        activeBatch={activeBatch}
        activeBatchInFlight={activeBatchInFlight}
        pendingDuplicate={pendingDuplicate}
        setPendingDuplicate={setPendingDuplicate}
        submitCase={submitCase}
      />

      <SubmissionsCard
        isLoading={isLoading}
        isError={isError}
        refetch={refetch}
        sortedCases={sortedCases}
        selectedId={selectedId}
        setSelectedId={setSelectedId}
      />
    </div>
  );
}

export function ClerkCapture() {
  usePageTitle("Send to Clerk");
  return (
    <CapabilityGate capability="clerk.capture">
      <CaptureContent />
    </CapabilityGate>
  );
}
