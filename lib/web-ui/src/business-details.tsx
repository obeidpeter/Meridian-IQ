import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { RotateCcw, Save } from "lucide-react";

export interface BusinessDetailsRecord {
  id: string;
  legalName: string;
  tin?: string | null;
  cacNumber?: string | null;
  street?: string | null;
  city?: string | null;
  countryCode: string;
  /** The server's updatedAt; when present it rides every save as the
   *  optimistic-concurrency stamp (R113). */
  updatedAt?: string;
}

export type BusinessDetailsPatch = Partial<
  Omit<BusinessDetailsRecord, "id" | "updatedAt">
> & {
  /** The stamp of the record the user edited, so a newer save by someone
   *  else answers 409 instead of being overwritten. */
  expectedUpdatedAt?: string;
};

const fields = [
  {
    key: "legalName",
    label: "Legal business name",
    autoComplete: "organization",
  },
  { key: "tin", label: "Tax identification number (TIN)", autoComplete: "off" },
  { key: "cacNumber", label: "CAC number", autoComplete: "off" },
  { key: "street", label: "Street address", autoComplete: "street-address" },
  { key: "city", label: "City", autoComplete: "address-level2" },
  { key: "countryCode", label: "Country code", autoComplete: "country" },
] as const;
type Field = (typeof fields)[number]["key"];
type Values = Record<Field, string>;
type Errors = Partial<Record<Field, string>>;

function valuesFor(party: BusinessDetailsRecord): Values {
  return {
    legalName: party.legalName,
    tin: party.tin ?? "",
    cacNumber: party.cacNumber ?? "",
    street: party.street ?? "",
    city: party.city ?? "",
    countryCode: party.countryCode,
  };
}

function sameValues(a: Values, b: Values) {
  return fields.every(({ key }) => a[key] === b[key]);
}

function normalize(key: Field, value: string): string {
  if (key === "tin") return value.trim().replace(/\s+/g, "");
  if (key === "cacNumber")
    return value.trim().toUpperCase().replace(/\s+/g, "");
  if (key === "countryCode") return value.trim().toUpperCase();
  return value.trim();
}

function changedFields(baseline: Values, values: Values): BusinessDetailsPatch {
  const patch: BusinessDetailsPatch = {};
  for (const { key } of fields) {
    const value = normalize(key, values[key]);
    if (value === normalize(key, baseline[key])) continue;
    if (key === "legalName" || key === "countryCode") patch[key] = value;
    else patch[key] = value || null;
  }
  return patch;
}

function validate(patch: BusinessDetailsPatch): Errors {
  const errors: Errors = {};
  if (patch.legalName !== undefined && !patch.legalName) {
    errors.legalName = "Enter the legal business name.";
  }
  // Match the server's structural checks; these do not establish registry verification.
  if (patch.tin && !/^\d{8,10}(-\d{4})?$/.test(patch.tin)) {
    errors.tin =
      "Enter 8 to 10 digits, optionally followed by a hyphen and 4 digits.";
  }
  if (patch.cacNumber && !/^(RC|BN)\d{2,8}$/.test(patch.cacNumber)) {
    errors.cacNumber = "Enter RC or BN followed by 2 to 8 digits.";
  }
  if (
    patch.countryCode !== undefined &&
    !/^[A-Z]{2}$/.test(patch.countryCode)
  ) {
    errors.countryCode = "Enter a two-letter country code, such as NG.";
  }
  return errors;
}

export function BusinessDetailsForm(props: {
  party: BusinessDetailsRecord;
  onSave: (patch: BusinessDetailsPatch) => Promise<BusinessDetailsRecord>;
  disabledReason?: string | null;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  return <BusinessDetailsEditor key={props.party.id} {...props} />;
}

function BusinessDetailsEditor({
  party,
  onSave,
  disabledReason,
  onDirtyChange,
}: {
  party: BusinessDetailsRecord;
  onSave: (patch: BusinessDetailsPatch) => Promise<BusinessDetailsRecord>;
  disabledReason?: string | null;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const id = useId();
  const [observedParty, setObservedParty] = useState(party);
  const [latestSaved, setLatestSaved] = useState(() => valuesFor(party));
  const [baseline, setBaseline] = useState(() => valuesFor(party));
  // The stamp travels with the baseline, never with the latest refetch: a
  // newer record that arrived while the user was typing is exactly the case
  // the server must refuse.
  const [baselineStamp, setBaselineStamp] = useState(party.updatedAt);
  const [values, setValues] = useState(() => valuesFor(party));
  const [errors, setErrors] = useState<Errors>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const inputs = useRef<Partial<Record<Field, HTMLInputElement | null>>>({});
  const dirty = !sameValues(baseline, values);
  const patch = changedFields(baseline, values);
  const newerDetails = dirty && !sameValues(latestSaved, baseline);

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  // Adopt new records only when pristine. Tracking the observed object also
  // prevents a stale prop from undoing the just-returned PATCH response.
  if (observedParty !== party) {
    setObservedParty(party);
    setLatestSaved(valuesFor(party));
    if (!dirty && !savingRef.current) {
      setBaseline(valuesFor(party));
      setValues(valuesFor(party));
      setBaselineStamp(party.updatedAt);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingRef.current || disabledReason || !Object.keys(patch).length)
      return;
    const nextErrors = validate(patch);
    setErrors(nextErrors);
    const invalid = fields.find(({ key }) => nextErrors[key]);
    if (invalid) {
      inputs.current[invalid.key]?.focus();
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const updated = await onSave(
        baselineStamp ? { ...patch, expectedUpdatedAt: baselineStamp } : patch,
      );
      if (updated.id !== party.id)
        throw new Error(
          "The saved business record did not match this business.",
        );
      setBaseline(valuesFor(updated));
      setValues(valuesFor(updated));
      setLatestSaved(valuesFor(updated));
      setBaselineStamp(updated.updatedAt);
      setSaved(true);
    } catch (error) {
      setSaveError(
        error instanceof Error
          ? error.message
          : "Business details could not be saved. Please try again.",
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <form
      aria-label="Business details"
      className="grid max-w-2xl gap-5"
      onSubmit={submit}
      noValidate
      aria-busy={saving}
    >
      {disabledReason ? (
        <p role="alert" className="text-sm text-destructive">
          {disabledReason}
        </p>
      ) : null}
      {newerDetails ? (
        <div className="space-y-2 text-sm">
          <p role="status" className="text-muted-foreground">
            Newer saved details are available. Your unsaved changes have not
            been replaced.
          </p>
          <details>
            <summary className="min-h-11 cursor-pointer py-2 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Review newer saved details
            </summary>
            <dl className="space-y-3">
              {fields
                .filter(({ key }) => latestSaved[key] !== baseline[key])
                .map(({ key, label }) => (
                  <div key={key} className="min-w-0 space-y-1 break-words">
                    <dt className="font-medium">{label}</dt>
                    <dd className="m-0">
                      Latest saved: {latestSaved[key] || "Not provided"}
                    </dd>
                    <dd className="m-0">
                      Your value: {values[key] || "Not provided"}
                    </dd>
                  </div>
                ))}
            </dl>
          </details>
        </div>
      ) : null}
      {saveError ? (
        <p role="alert" className="text-sm text-destructive">
          {saveError}
        </p>
      ) : null}
      {Object.values(errors).some(Boolean) ? (
        <p role="alert" className="text-sm text-destructive">
          Correct the highlighted business details.
        </p>
      ) : null}
      <fieldset
        disabled={saving || Boolean(disabledReason)}
        className="m-0 min-w-0 space-y-4 border-0 p-0"
      >
        <legend className="mi-sr-only">Business identity and address</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          {fields.map(({ key, label, autoComplete }) => (
            <div
              key={key}
              className={
                key === "legalName" || key === "street"
                  ? "min-w-0 space-y-2 sm:col-span-2"
                  : "min-w-0 space-y-2"
              }
            >
              <label
                htmlFor={`${id}-${key}`}
                className="block text-sm font-medium"
              >
                {label}
              </label>
              <input
                id={`${id}-${key}`}
                name={key}
                type="text"
                autoComplete={autoComplete}
                required={key === "legalName" || key === "countryCode"}
                value={values[key]}
                ref={(element) => {
                  inputs.current[key] = element;
                }}
                aria-invalid={errors[key] ? true : undefined}
                aria-describedby={
                  errors[key] ? `${id}-${key}-error` : undefined
                }
                className="flex min-h-11 w-full min-w-0 rounded-md border border-input bg-card px-3 py-2 text-base shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 md:text-sm"
                onChange={(event) => {
                  if (savingRef.current || disabledReason) return;
                  setValues((current) => ({
                    ...current,
                    [key]: event.target.value,
                  }));
                  setErrors((current) => ({ ...current, [key]: undefined }));
                  setSaved(false);
                }}
              />
              {errors[key] ? (
                <p
                  id={`${id}-${key}-error`}
                  className="text-sm text-destructive"
                >
                  {errors[key]}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={
            saving || Boolean(disabledReason) || !Object.keys(patch).length
          }
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-primary bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
        >
          <Save className="size-4 shrink-0" aria-hidden="true" />
          {saving ? "Saving business details..." : "Save business details"}
        </button>
        <button
          type="button"
          disabled={!dirty || saving}
          className="mi-today__text-action"
          onClick={() => {
            setBaseline(latestSaved);
            setValues(latestSaved);
            setBaselineStamp(party.updatedAt);
            setErrors({});
            setSaveError(null);
            setSaved(false);
          }}
        >
          <RotateCcw aria-hidden="true" />
          Discard changes
        </button>
        <p role="status" className="text-sm text-muted-foreground">
          {saving
            ? "Saving..."
            : saved
              ? "Business details saved."
              : dirty
                ? "Unsaved changes"
                : ""}
        </p>
      </div>
    </form>
  );
}
