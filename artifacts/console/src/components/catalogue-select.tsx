import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * One closed-catalogue select: a labelled dropdown whose options are a
 * contract enum rendered through a vocabulary helper. The notice decision
 * form (clerk.tsx) and the paper-notice recorder (obligations-card.tsx)
 * render the same notice-type/authority/tax-type trio through this — but
 * each caller passes its OWN generated enum as `options`, so every form
 * stays typed against its own contract input; only the rendering is shared.
 * If the spec ever forks the catalogues, the per-caller options keep both
 * forms correct.
 */
export function CatalogueSelect({
  label,
  value,
  onValueChange,
  options,
  labelFn,
  placeholder,
  testId,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: readonly string[];
  labelFn: (value: string) => string;
  placeholder: string;
  testId: string;
}) {
  const id = `${testId}-control`;
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger id={id} data-testid={testId}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o} value={o}>
              {labelFn(o)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
