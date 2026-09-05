import { useState } from "react";
import { Copy, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { InvoiceDraftController } from "@/lib/use-invoice-drafts";
import { serverErrorMessage } from "@/lib/errors";
import { useDirectoryCustomer } from "./customer-directory-picker";
import { draftAmount, draftOptionLabel, draftTime } from "@/lib/draft-summary";

export function InvoiceDraftControls({
  controller,
  onDiscard,
  disabled,
}: {
  controller: InvoiceDraftController;
  onDiscard: () => void;
  disabled?: boolean;
}) {
  const { state, session, catalogue, recoveries, select, id } = controller;
  const [error, setError] = useState("");
  const remote = catalogue.data?.pages.flatMap((page) => page.items) ?? [];
  const customer = useDirectoryCustomer(state.draft.buyerPartyId);
  const accountCopy = remote.find((draft) => draft.id === id);
  const deviceCopy = recoveries.find(
    (copy) => copy.id === id && copy.writerId === session.writerId,
  );
  const status =
    state.status === "saved"
      ? "Saved to your account for 7 days"
      : state.status === "saving"
        ? "Saving to your account..."
        : state.status === "loading"
          ? "Loading draft..."
          : state.status === "conflict"
            ? "Draft changed elsewhere. Your edits have not overwritten it."
            : state.status === "empty"
              ? "New draft"
              : state.localSaved
                ? "Saved on this device only; account sync pending"
                : "Not saved. Keep this tab open and retry.";
  const action = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(serverErrorMessage(e));
    }
  };
  return (
    <section aria-label="Invoice drafts" className="space-y-3 border-y py-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 basis-64">
          <Label htmlFor="invoice-draft-slot">Draft</Label>
          <select
            id="invoice-draft-slot"
            className="h-9 w-full min-w-0 rounded-md border bg-background px-2 text-sm"
            disabled={disabled}
            value={`server:${id}`}
            onChange={(event) => select(event.target.value)}
          >
            <option value={`server:${id}`}>
              {draftOptionLabel(state.draft)} (current)
            </option>
            {remote
              .filter((draft) => draft.id !== id)
              .map((draft) => (
                <option key={draft.id} value={`server:${draft.id}`}>
                  {draftOptionLabel(draft.draft, draft.updatedAt)} - account
                </option>
              ))}
            {recoveries
              .filter(
                (copy) =>
                  copy.writerId !== session.writerId &&
                  !remote.some(
                    (row) =>
                      row.id === copy.id &&
                      JSON.stringify(row.draft) === JSON.stringify(copy.draft),
                  ),
              )
              .map((copy) => (
                <option
                  key={`${copy.id}:${copy.writerId}`}
                  value={`local:${copy.id}:${copy.writerId}`}
                >
                  {draftOptionLabel(copy.draft, copy.savedAt)} - device recovery
                </option>
              ))}
          </select>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => controller.newDraft()}
        >
          <Plus className="mr-1 size-4" aria-hidden="true" />
          New draft
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={disabled || state.status === "loading"}
          onClick={onDiscard}
          data-testid="button-discard-draft"
        >
          <Trash2 className="mr-1 size-4" aria-hidden="true" />
          Discard
        </Button>
      </div>
      <p
        role="status"
        aria-live="polite"
        className="text-sm text-muted-foreground"
        data-testid="text-draft-saved"
      >
        {status}
      </p>
      <dl
        className="grid min-w-0 gap-x-6 gap-y-2 text-sm sm:grid-cols-2"
        aria-label="Selected draft details"
      >
        <div className="min-w-0">
          <dt className="text-muted-foreground">Customer</dt>
          <dd className="break-words font-medium">
            {!state.draft.buyerPartyId
              ? "Not selected"
              : customer.isError
                ? "Customer unavailable"
                : (customer.data?.legalName ?? "Loading customer...")}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Draft total</dt>
          <dd>{draftAmount(state.draft)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            Last account save (Lagos time)
          </dt>
          <dd>{draftTime(accountCopy?.updatedAt)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            Account draft expires (Lagos time)
          </dt>
          <dd>{draftTime(accountCopy?.expiresAt)}</dd>
        </div>
        {state.localSaved && state.status !== "saved" && deviceCopy && (
          <div>
            <dt className="text-muted-foreground">
              Device recovery saved (Lagos time)
            </dt>
            <dd>{draftTime(deviceCopy.savedAt)}</dd>
          </div>
        )}
      </dl>
      {controller.legacy?.restored && (
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => controller.newDraft(controller.legacy?.draft)}
        >
          Recover earlier device draft
        </Button>
      )}
      {state.status === "conflict" && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => void action(() => session.reload())}
          >
            <RefreshCw className="mr-1 size-4" aria-hidden="true" />
            Reload account version
          </Button>
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => controller.newDraft(state.draft)}
          >
            <Copy className="mr-1 size-4" aria-hidden="true" />
            Save my edits as a new draft
          </Button>
        </div>
      )}
      {(state.status === "error" || (state.dirty && !state.localSaved)) && (
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() =>
            void action(() => (state.dirty ? session.save() : session.load()))
          }
        >
          Retry saving
        </Button>
      )}
      {catalogue.isError && (
        <p className="text-sm text-destructive">
          Account drafts could not be listed.{" "}
          <Button variant="link" onClick={() => void catalogue.refetch()}>
            Retry list
          </Button>
        </p>
      )}
      {catalogue.hasNextPage && (
        <Button
          variant="ghost"
          disabled={catalogue.isFetchingNextPage}
          onClick={() => void catalogue.fetchNextPage()}
        >
          Load more drafts
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
