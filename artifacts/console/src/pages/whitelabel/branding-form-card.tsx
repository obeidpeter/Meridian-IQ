import type { Firm } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertTriangle, CheckCircle2, Palette } from "lucide-react";
import { BRAND_PRESETS, DEFAULT_PRIMARY } from "./theme";
import type { BrandStudioState } from "./use-brand-studio";

// The branding form: name, subdomain, primary colour with presets, logo
// initials and the contrast verdict. `firm` is the shell's loaded firm.
export function BrandingFormCard({
  state,
  firm,
}: {
  state: BrandStudioState;
  firm: Firm;
}) {
  const {
    brandName,
    setBrandName,
    subdomain,
    setSubdomain,
    subdomainValid,
    primary,
    setPrimary,
    primaryValid,
    previewColor,
    logoInitials,
    setLogoInitials,
    initials,
    contrast,
    contrastPasses,
  } = state;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Palette className="w-4 h-4 text-primary" aria-hidden="true" />{" "}
          Branding
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Label htmlFor="brand-name">Brand name</Label>
          <Input
            id="brand-name"
            value={brandName}
            onChange={(e) => setBrandName(e.target.value)}
            placeholder={firm.name}
            data-testid="input-brand-name"
          />
        </div>
        <div>
          <Label htmlFor="subdomain">Subdomain</Label>
          <Input
            id="subdomain"
            value={subdomain}
            onChange={(e) => setSubdomain(e.target.value.toLowerCase())}
            placeholder="your-firm"
            className={subdomainValid ? "" : "border-destructive"}
            aria-invalid={!subdomainValid}
            aria-describedby={
              subdomainValid ? "subdomain-hint" : "subdomain-error"
            }
            data-testid="input-subdomain"
          />
          {subdomainValid ? (
            <p
              id="subdomain-hint"
              className="text-xs text-muted-foreground mt-1"
            >
              Lowercase letters, digits and hyphens; 3–63 characters.
            </p>
          ) : (
            <p
              id="subdomain-error"
              role="alert"
              className="text-xs text-destructive mt-1"
              data-testid="text-subdomain-error"
            >
              Use only lowercase letters, digits and hyphens (3–63 characters,
              no leading or trailing hyphen).
            </p>
          )}
        </div>
        <div>
          <Label htmlFor="primary-color">Primary colour (HSL)</Label>
          <div className="flex items-center gap-2">
            <Input
              id="primary-color"
              value={primary}
              onChange={(e) => setPrimary(e.target.value)}
              placeholder={DEFAULT_PRIMARY}
              className="font-mono"
              aria-invalid={!primaryValid}
              data-testid="input-primary-color"
            />
            <span
              className="w-9 h-9 rounded-md border shrink-0"
              style={{ backgroundColor: previewColor }}
              data-testid="swatch-primary"
              aria-hidden
            />
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Hue, saturation and lightness — e.g. “152 60% 30%”.
          </p>
          {!primaryValid && (
            <p className="mt-1 text-xs text-destructive" role="alert">
              Enter HSL as three values, for example 152 60% 30%.
            </p>
          )}
          <div
            className="mt-3 flex flex-wrap gap-2"
            aria-label="Brand colour presets"
          >
            {BRAND_PRESETS.map((preset) => (
              <button
                key={preset.value}
                type="button"
                className="grid size-8 place-items-center rounded-md border border-slate-200 transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                style={{ backgroundColor: `hsl(${preset.value})` }}
                onClick={() => setPrimary(preset.value)}
                aria-label={preset.label}
                title={preset.label}
              >
                {primary === preset.value && (
                  <CheckCircle2
                    className="size-4 text-white drop-shadow"
                    aria-hidden="true"
                  />
                )}
              </button>
            ))}
          </div>
        </div>
        <div>
          <Label htmlFor="logo-initials">Logo initials (optional)</Label>
          <Input
            id="logo-initials"
            value={logoInitials}
            onChange={(e) =>
              setLogoInitials(e.target.value.toUpperCase().slice(0, 3))
            }
            placeholder={initials}
            className="w-24"
            data-testid="input-logo-initials"
          />
        </div>
        <div
          className={`flex items-start gap-2 rounded-md border p-3 text-sm ${
            contrastPasses
              ? "border-emerald-200 bg-emerald-50 text-emerald-900"
              : "border-amber-200 bg-amber-50 text-amber-900"
          }`}
        >
          {contrastPasses ? (
            <CheckCircle2
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
          ) : (
            <AlertTriangle
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
          )}
          <div>
            <p className="font-semibold">
              {contrastPasses
                ? "White text is legible"
                : "Increase colour contrast"}
            </p>
            <p className="mt-0.5 text-xs leading-5 opacity-80">
              {contrast === null
                ? "Enter a valid HSL colour to check the preview."
                : `Estimated contrast ${contrast.toFixed(1)}:1 against white.`}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
