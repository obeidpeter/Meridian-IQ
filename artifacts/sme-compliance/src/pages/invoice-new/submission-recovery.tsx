import { Button } from "@/components/ui/button";
import type { InvoiceSubmission } from "@/lib/invoice-submission";

/**
 * The role=status recovery strip for a draft that already carries a
 * submission record: view the created invoice, retry the original request,
 * or (blocked) read the warning. The `submission &&` guard stays in the shell.
 */
export function SubmissionRecovery({
  submission,
  submitting,
  onSubmit,
}: {
  submission: InvoiceSubmission;
  submitting: boolean;
  onSubmit: () => void;
}) {
  return (
    <section
      role="status"
      aria-label="Invoice request recovery"
      className="space-y-2 border-y py-3"
    >
      <p className="text-sm">
        {submission.status === "succeeded"
          ? "This invoice was already created."
          : submission.status === "blocked"
            ? "The original request cannot be read on this device. Check account activity before creating a replacement invoice; it could duplicate a completed invoice."
            : "We could not confirm whether this invoice was created. Your customer and amounts are kept on this device. Select Retry original invoice to check safely without creating a duplicate."}
      </p>
      {submission.status !== "blocked" && (
        <Button onClick={onSubmit} disabled={submitting}>
          {submitting
            ? "Checking invoice..."
            : submission.status === "succeeded"
              ? "View created invoice"
              : "Retry original invoice"}
        </Button>
      )}
    </section>
  );
}
