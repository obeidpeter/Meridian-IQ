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
            : "Upload a tax authority notice or paste its text. Clerk suggests the details for you to review."
          : queueSearch
            ? "Try a source name, invoice number, status or case ID."
            : "Upload an invoice or voice note, or paste invoice text. Clerk suggests the details for you to review."
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
          {queueKind === "notice" ? "Add a notice" : "Add a document"}
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
            Upload multiple invoices
          </Button>
        )}
      </div>
    </EmptyState>
  );
}
