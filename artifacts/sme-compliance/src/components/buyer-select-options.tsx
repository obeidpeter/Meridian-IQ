import { SelectItem } from "@/components/ui/select";
import type { Party } from "@workspace/api-client-react";

/**
 * The customer option list shared by the invoice form and the recurring
 * dialog: legal name with the TIN suffix (or the "(no TIN)" nudge) pinned
 * once so both selects read identically. The surrounding Select/trigger and
 * the empty states stay per-page — they intentionally diverge (inline
 * add-customer vs a link to the invoice form).
 */
export function BuyerSelectOptions({ buyers }: { buyers: Party[] }) {
  return (
    <>
      {buyers.map((b) => (
        <SelectItem key={b.id} value={b.id}>
          {b.legalName}
          {b.tin ? ` — ${b.tin}` : " (no TIN)"}
        </SelectItem>
      ))}
    </>
  );
}
