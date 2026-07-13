import { useState } from "react";
import {
  useCreateParty,
  getListPartiesQueryKey,
} from "@workspace/api-client-react";
import type { Party, PartyInput } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

// The generated client throws an ApiError whose `data` carries the server's
// `{ error }` body (e.g. the invalid-TIN 400). The package does not export the
// class itself, so duck-type the field — mirrors invoices.tsx / lib/errors.ts.
function serverErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data: unknown }).data;
    if (
      data &&
      typeof data === "object" &&
      "error" in data &&
      typeof (data as { error: unknown }).error === "string"
    ) {
      return (data as { error: string }).error;
    }
  }
  return error instanceof Error ? error.message : "Please try again.";
}

interface AddCustomerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the newly created buyer so the caller can pre-select it. */
  onCreated: (party: Party) => void;
}

/** Small "Add customer" dialog for the invoice form: creates a buyer party
 * inline so the SME never has to leave a half-finished invoice. */
export function AddCustomerDialog({
  open,
  onOpenChange,
  onCreated,
}: AddCustomerDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const create = useCreateParty();

  const [legalName, setLegalName] = useState("");
  const [tin, setTin] = useState("");
  const [street, setStreet] = useState("");
  const [city, setCity] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setLegalName("");
      setTin("");
      setStreet("");
      setCity("");
      setServerError(null);
    }
    onOpenChange(nextOpen);
  };

  const submit = async () => {
    if (!legalName.trim() || create.isPending) return;
    setServerError(null);
    // Optional fields must be OMITTED when blank — the server rejects an
    // empty-string TIN, and a null one never passes PartyInput validation.
    const data: PartyInput = { type: "buyer", legalName: legalName.trim() };
    if (tin.trim()) data.tin = tin.trim();
    if (street.trim()) data.street = street.trim();
    if (city.trim()) data.city = city.trim();
    try {
      const party = await create.mutateAsync({ data });
      // Not awaited: a background refetch rejection must not surface as a
      // false "could not add customer" error after the save already
      // succeeded. The no-args key prefix-matches every param variant.
      queryClient.invalidateQueries({ queryKey: getListPartiesQueryKey() });
      toast({
        title: "Customer added",
        description: `${party.legalName} is ready to pick on your invoices.`,
      });
      onCreated(party);
      handleOpenChange(false);
    } catch (e) {
      // A 400 (e.g. bad TIN format) stays inline so the fields keep focus.
      setServerError(serverErrorMessage(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add customer</DialogTitle>
          <DialogDescription>
            New customers appear in your list straight away, ready to pick on
            this invoice.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="add-customer-name">Legal name</Label>
            <Input
              id="add-customer-name"
              value={legalName}
              onChange={(e) => setLegalName(e.target.value)}
              placeholder="Acme Trading Ltd"
              data-testid="input-add-customer-name"
            />
          </div>
          <div>
            <Label htmlFor="add-customer-tin">TIN (optional)</Label>
            <Input
              id="add-customer-tin"
              value={tin}
              onChange={(e) => setTin(e.target.value)}
              placeholder="12345678-0001"
              aria-describedby="add-customer-tin-hint"
              data-testid="input-add-customer-tin"
            />
            <p
              id="add-customer-tin-hint"
              className="text-xs text-muted-foreground mt-1"
            >
              8 digits + -0001 suffix, e.g. 12345678-0001
            </p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="add-customer-street">Street (optional)</Label>
              <Input
                id="add-customer-street"
                value={street}
                onChange={(e) => setStreet(e.target.value)}
                data-testid="input-add-customer-street"
              />
            </div>
            <div>
              <Label htmlFor="add-customer-city">City (optional)</Label>
              <Input
                id="add-customer-city"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                data-testid="input-add-customer-city"
              />
            </div>
          </div>
          {serverError && (
            <p
              className="text-sm text-destructive"
              role="alert"
              data-testid="text-add-customer-error"
            >
              {serverError}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => handleOpenChange(false)}
            disabled={create.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={!legalName.trim() || create.isPending}
            data-testid="button-save-customer"
          >
            {create.isPending ? "Adding…" : "Add customer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
