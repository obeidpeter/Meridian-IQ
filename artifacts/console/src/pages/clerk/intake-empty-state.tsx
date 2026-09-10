import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { Inbox, Plus } from "lucide-react";
import type { ClerkWorkspaceState } from "./use-clerk-workspace";

// First-run empty state: show the ways in — a single capture, or (invoices
// only) a multi-invoice bundle (same form, batch pre-ticked). Both only OPEN
// the form; reading still takes the operator's click.
export function IntakeEmptyState({ state }: { state: ClerkWorkspaceState }) {
  const { queueKind, queueSearch, setCaptureOpen, setBatchMode } = state;
  return (
    <EmptyState
      icon={Inbox}
      title={
        queueKind === "notice"
          ? queueSearch
            ? "No matching notices"
            : "No notices read yet"
          : queueSearch
            ? "No matching documents"
            : "No documents read yet"
      }
      description={
        queueKind === "notice"
          ? queueSearch
            ? "Try a source name, reference, status or case ID."
            : "Capture a tax-authority notice — a photo, scan or pasted text — Clerk reads it and queues it here for your review."
          : queueSearch
            ? "Try a source name, invoice number, status or case ID."
            : "Capture an invoice document, voice note or pasted text — Clerk reads it and queues it here for your review."
      }
      className="py-8 px-2"
    >
      <div className="flex flex-wrap justify-center gap-2 mt-1">
        <Button
          size="sm"
          onClick={() => setCaptureOpen(true)}
          data-testid="button-empty-capture"
        >
          <Plus className="w-4 h-4 mr-1" aria-hidden="true" />
          {queueKind === "notice"
            ? "Capture your first notice"
            : "Capture your first document"}
        </Button>
        {queueKind === "extraction" && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setCaptureOpen(true);
              setBatchMode(true);
            }}
            data-testid="button-empty-import-batch"
          >
            Import a multi-invoice bundle
          </Button>
        )}
      </div>
    </EmptyState>
  );
}
