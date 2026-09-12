import { type ReactNode } from "react";
import { type Firm, type Party } from "@workspace/api-client-react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function FirmSelect({
  firms,
  value,
  onChange,
  testId,
}: {
  firms: Firm[] | undefined;
  value: string;
  onChange: (firmId: string) => void;
  testId: string;
}) {
  const id = `${testId}-control`;
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>Firm</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} data-testid={testId}>
          <SelectValue placeholder="Choose firm" />
        </SelectTrigger>
        <SelectContent className="max-w-[calc(100vw-2rem)]">
          {(firms ?? []).map((f) => (
            <SelectItem
              key={f.id}
              value={f.id}
              className="whitespace-normal [overflow-wrap:anywhere]"
            >
              {f.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function PartySelect({
  label,
  placeholder,
  parties,
  value,
  onChange,
  testId,
  children,
}: {
  label: string;
  placeholder: string;
  parties: Party[] | undefined;
  value: string;
  onChange: (partyId: string) => void;
  testId: string;
  // The invoice slots render PartySuggestionChips under the select; the
  // notice form's client slot renders none.
  children?: ReactNode;
}) {
  const id = `${testId}-control`;
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} data-testid={testId}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent className="max-w-[calc(100vw-2rem)]">
          {(parties ?? []).map((p) => (
            <SelectItem
              key={p.id}
              value={p.id}
              className="whitespace-normal [overflow-wrap:anywhere]"
            >
              {p.legalName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {children}
    </div>
  );
}

// ---- The invoice decision form ----------------------------------------------
// Review-and-approve for an extraction case: creates a DRAFT invoice only.
// Pure presentation — all state stays in ClerkWorkspace and the payload
// builders stay in clerk-shared (approveDecisionFromForm is the ONE builder
// the fast-lane bulk items share). Deliberately a separate component from
// NoticeDecisionForm: the two forms are mutually exclusive and their reason
// semantics differ (required to reject/escalate here, optional there).
