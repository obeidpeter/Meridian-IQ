import { useState } from "react";
import {
  useCreateClient,
  getGetPortfolioQueryKey,
} from "@workspace/api-client-react";
import type { CreateClientInput, CreatedClient } from "@workspace/api-client-react";
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
import { errorStatus, serverErrorMessage } from "@/lib/errors";

// Single-client intake for the portfolio (the SME add-customer-dialog idiom):
// one dialog creates the party + engagement so a firm's first client never
// requires a CSV. Bulk stays on /clients/import.

/** The success toast title — step 2 of the checklist is the next move. */
export const CLIENT_ADDED_TOAST = "Client added — invite their owner next.";

/**
 * Trim everything; optional fields must be OMITTED when blank — the server
 * rejects an empty-string TIN, and a null one never passes validation.
 */
export function buildCreateClientInput(fields: {
  legalName: string;
  tin: string;
  cacNumber: string;
  street: string;
  city: string;
}): CreateClientInput {
  const data: CreateClientInput = { legalName: fields.legalName.trim() };
  if (fields.tin.trim()) data.tin = fields.tin.trim();
  if (fields.cacNumber.trim()) data.cacNumber = fields.cacNumber.trim();
  if (fields.street.trim()) data.street = fields.street.trim();
  if (fields.city.trim()) data.city = fields.city.trim();
  return data;
}

/**
 * Inline note for a failed create. A 409 is the duplicate guard; anything
 * else relays the server's words (e.g. a 400 for a malformed TIN) with a
 * plain fallback.
 */
export function createClientErrorNote(err: unknown): string {
  if (errorStatus(err) === 409) {
    return "You already have a client with this TIN/name.";
  }
  return serverErrorMessage(err) ?? "Could not add the client. Try again.";
}

interface AddClientDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional: called with the created client (e.g. to jump to its detail). */
  onCreated?: (client: CreatedClient) => void;
}

export function AddClientDialog({
  open,
  onOpenChange,
  onCreated,
}: AddClientDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const create = useCreateClient();

  const [legalName, setLegalName] = useState("");
  const [tin, setTin] = useState("");
  const [cacNumber, setCacNumber] = useState("");
  const [street, setStreet] = useState("");
  const [city, setCity] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setLegalName("");
      setTin("");
      setCacNumber("");
      setStreet("");
      setCity("");
      setServerError(null);
    }
    onOpenChange(nextOpen);
  };

  const submit = async () => {
    if (!legalName.trim() || create.isPending) return;
    setServerError(null);
    const data = buildCreateClientInput({
      legalName,
      tin,
      cacNumber,
      street,
      city,
    });
    try {
      const created = await create.mutateAsync({ data });
      // Not awaited: a background refetch rejection must not surface as a
      // false "could not add" error after the save already succeeded.
      void queryClient.invalidateQueries({
        queryKey: getGetPortfolioQueryKey(),
      });
      toast({
        title: CLIENT_ADDED_TOAST,
        description: `${created.legalName} is in your client book.`,
      });
      onCreated?.(created);
      handleOpenChange(false);
    } catch (e) {
      // 409 duplicate / 400 bad TIN stay inline so the fields keep focus.
      setServerError(createClientErrorNote(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add client</DialogTitle>
          <DialogDescription>
            Creates the client in your book with an active engagement — invite
            their owner afterwards so they can sign in and grant consent.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="add-client-name">Legal name</Label>
            <Input
              id="add-client-name"
              value={legalName}
              maxLength={200}
              onChange={(e) => setLegalName(e.target.value)}
              placeholder="Acme Trading Ltd"
              data-testid="input-add-client-name"
            />
          </div>
          <div>
            <Label htmlFor="add-client-tin">TIN (optional)</Label>
            <Input
              id="add-client-tin"
              value={tin}
              onChange={(e) => setTin(e.target.value)}
              placeholder="12345678-0001"
              aria-describedby="add-client-tin-hint"
              data-testid="input-add-client-tin"
            />
            <p
              id="add-client-tin-hint"
              className="text-xs text-muted-foreground mt-1"
            >
              8 digits + -0001 suffix, e.g. 12345678-0001
            </p>
          </div>
          <div>
            <Label htmlFor="add-client-cac">CAC number (optional)</Label>
            <Input
              id="add-client-cac"
              value={cacNumber}
              onChange={(e) => setCacNumber(e.target.value)}
              placeholder="RC123456"
              data-testid="input-add-client-cac"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="add-client-street">Street (optional)</Label>
              <Input
                id="add-client-street"
                value={street}
                onChange={(e) => setStreet(e.target.value)}
                data-testid="input-add-client-street"
              />
            </div>
            <div>
              <Label htmlFor="add-client-city">City (optional)</Label>
              <Input
                id="add-client-city"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                data-testid="input-add-client-city"
              />
            </div>
          </div>
          {serverError && (
            <p
              className="text-sm text-destructive"
              role="alert"
              data-testid="text-add-client-error"
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
            data-testid="button-save-client"
          >
            {create.isPending ? "Adding…" : "Add client"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
