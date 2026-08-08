import { useEffect, useState } from "react";
import {
  useGetMe,
  useGetFirm,
  useUpdateFirmTheme,
  getGetFirmQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { FeatureUnavailable } from "@/components/feature-unavailable";
import { QueryError } from "@/components/query-error";
import { isFeatureDisabled } from "@/lib/errors";
import { useToast } from "@/hooks/use-toast";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  AlertTriangle,
  CheckCircle2,
  Globe,
  Palette,
  Save,
} from "lucide-react";
import { SegmentedControl, WorkspaceHeader } from "@workspace/web-ui";

// Server-side pattern on FirmThemeInput.subdomain (openapi.yaml): mirror it
// here so the form rejects bad slugs before the round-trip.
const SUBDOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

const DEFAULT_PRIMARY = "152 60% 30%";
const BRAND_PRESETS = [
  { label: "Evergreen", value: "152 60% 30%" },
  { label: "Atlantic", value: "198 74% 31%" },
  { label: "Cobalt", value: "221 70% 45%" },
  { label: "Burgundy", value: "348 62% 38%" },
  { label: "Graphite", value: "210 16% 28%" },
] as const;

type PreviewMode = "desktop" | "mobile";

function parseHsl(value: string): [number, number, number] | null {
  const match = value
    .trim()
    .match(
      /^(?:hsl\()?\s*(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%\s*\)?$/i,
    );
  if (!match) return null;
  const h = Number(match[1]);
  const s = Number(match[2]);
  const l = Number(match[3]);
  if (h > 360 || s > 100 || l > 100) return null;
  return [h, s, l];
}

function hslLightness(value: string): number | null {
  return parseHsl(value)?.[2] ?? null;
}

function whiteContrastEstimate(value: string): number | null {
  const parsed = parseHsl(value);
  if (!parsed) return null;
  const [hue, saturation, lightness] = parsed;
  const h = hue / 60;
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs((h % 2) - 1));
  const [r1, g1, b1] =
    h < 1
      ? [chroma, x, 0]
      : h < 2
        ? [x, chroma, 0]
        : h < 3
          ? [0, chroma, x]
          : h < 4
            ? [0, x, chroma]
            : h < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const m = l - chroma / 2;
  const linear = (channel: number) => {
    const value = channel + m;
    return value <= 0.04045
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  };
  const luminance =
    0.2126 * linear(r1) + 0.7152 * linear(g1) + 0.0722 * linear(b1);
  return 1.05 / (luminance + 0.05);
}

function themeString(
  theme: Record<string, unknown> | null | undefined,
  key: string,
): string {
  const value = theme?.[key];
  return typeof value === "string" ? value : "";
}

export function WhiteLabel() {
  usePageTitle("White-label");
  const { data: me } = useGetMe();
  const firmId = me?.firmId ?? "";
  const {
    data: firm,
    isLoading,
    error,
    refetch,
  } = useGetFirm(firmId, {
    query: { enabled: !!firmId, queryKey: getGetFirmQueryKey(firmId) },
  });
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const updateTheme = useUpdateFirmTheme();

  const [featureDark, setFeatureDark] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [subdomain, setSubdomain] = useState("");
  const [brandName, setBrandName] = useState("");
  const [primary, setPrimary] = useState(DEFAULT_PRIMARY);
  const [logoInitials, setLogoInitials] = useState("");
  const [previewMode, setPreviewMode] = useState<PreviewMode>("desktop");

  useEffect(() => {
    if (!firm || hydrated) return;
    setSubdomain(firm.subdomain ?? "");
    setBrandName(themeString(firm.theme, "brandName") || firm.name);
    setPrimary(themeString(firm.theme, "primary") || DEFAULT_PRIMARY);
    setLogoInitials(themeString(firm.theme, "logoInitials"));
    setHydrated(true);
  }, [firm, hydrated]);

  const subdomainValid = subdomain === "" || SUBDOMAIN_PATTERN.test(subdomain);
  const primaryValid = hslLightness(primary) !== null;
  const previewColor = `hsl(${primaryValid ? primary : DEFAULT_PRIMARY})`;
  const contrast = whiteContrastEstimate(primary);
  const contrastPasses = contrast !== null && contrast >= 4.5;
  const initials =
    logoInitials ||
    (brandName || firm?.name || "MQ")
      .split(/\s+/)
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();

  const save = () => {
    if (!firm || !subdomainValid || !primaryValid) return;
    updateTheme.mutate(
      {
        id: firm.id,
        data: {
          // The subdomain pattern requires 3–63 chars, so "" is not a valid
          // value and the server ignores a falsy one — a subdomain can't be
          // cleared through this endpoint, only replaced. Send it only when set.
          ...(subdomain ? { subdomain } : {}),
          // Replace-not-patch on the server: carry unknown theme keys forward,
          // but send logoInitials explicitly (even empty) so clearing the field
          // actually removes it rather than leaving the previous value behind.
          theme: {
            ...(firm.theme ?? {}),
            brandName,
            primary,
            logoInitials,
          },
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Branding saved" });
          queryClient.invalidateQueries({
            queryKey: getGetFirmQueryKey(firm.id),
          });
        },
        onError: (err) => {
          if (isFeatureDisabled(err)) {
            setFeatureDark(true);
          } else {
            toast({ title: "Could not save branding", variant: "destructive" });
          }
        },
      },
    );
  };

  if (isLoading || !me) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-64" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      </div>
    );
  }

  if (featureDark || isFeatureDisabled(error)) {
    return (
      <div className="space-y-6">
        <h1
          className="text-2xl md:text-3xl font-bold"
          data-testid="text-page-title"
        >
          White-label branding
        </h1>
        <FeatureUnavailable feature="White-label branding" />
      </div>
    );
  }

  if (error || !firm) {
    return (
      <div className="space-y-6">
        <h1
          className="text-2xl md:text-3xl font-bold"
          data-testid="text-page-title"
        >
          White-label branding
        </h1>
        <QueryError thing="firm branding" onRetry={() => refetch()} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <WorkspaceHeader
        eyebrow="Firm experience"
        title="Brand studio"
        description="Shape the client-facing identity, verify legibility and preview the workspace before publishing."
        actions={
          <Button
            onClick={save}
            disabled={!subdomainValid || !primaryValid || updateTheme.isPending}
            data-testid="button-save-branding"
          >
            <Save className="mr-2 size-4" aria-hidden="true" />
            {updateTheme.isPending ? "Publishing…" : "Publish branding"}
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2 items-start">
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
                  Use only lowercase letters, digits and hyphens (3–63
                  characters, no leading or trailing hyphen).
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

        <div className="space-y-4">
          <Card data-testid="card-preview">
            <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
              <CardTitle className="text-base">
                Client workspace preview
              </CardTitle>
              <SegmentedControl<PreviewMode>
                items={[
                  { value: "desktop", label: "Desktop" },
                  { value: "mobile", label: "Mobile" },
                ]}
                value={previewMode}
                onChange={setPreviewMode}
                label="Preview viewport"
              />
            </CardHeader>
            <CardContent>
              <div className="grid min-h-[34rem] place-items-center overflow-hidden rounded-md border bg-slate-100 p-4">
                <div
                  className={`overflow-hidden border border-slate-200 bg-white shadow-sm transition-[width] ${
                    previewMode === "mobile"
                      ? "h-[31rem] w-[18rem] rounded-[1.25rem]"
                      : "h-[31rem] w-full rounded-md"
                  }`}
                >
                  {previewMode === "mobile" ? (
                    <div
                      className="flex h-14 items-center justify-between px-3 text-white"
                      style={{ backgroundColor: previewColor }}
                      data-testid="preview-header"
                    >
                      <span className="flex items-center gap-2">
                        <span className="grid size-8 place-items-center rounded-md bg-white/20 text-xs font-extrabold">
                          {initials}
                        </span>
                        <span className="max-w-36 truncate text-sm font-bold">
                          {brandName || firm.name}
                        </span>
                      </span>
                      <span className="text-lg" aria-hidden="true">
                        •••
                      </span>
                    </div>
                  ) : null}
                  <div
                    className={
                      previewMode === "desktop"
                        ? "grid h-full grid-cols-[7rem_minmax(0,1fr)]"
                        : "h-[calc(100%-3.5rem)]"
                    }
                  >
                    {previewMode === "desktop" && (
                      <div
                        className="flex flex-col p-3 text-white"
                        style={{ backgroundColor: previewColor }}
                        data-testid="preview-header"
                      >
                        <span className="grid size-9 place-items-center rounded-md bg-white/20 text-xs font-extrabold">
                          {initials}
                        </span>
                        <span className="mt-2 truncate text-xs font-bold">
                          {brandName || firm.name}
                        </span>
                        <div className="mt-8 space-y-2 text-[10px] font-semibold">
                          <p className="rounded bg-white/20 px-2 py-1.5">
                            Dashboard
                          </p>
                          <p className="px-2 py-1.5 opacity-70">Invoices</p>
                          <p className="px-2 py-1.5 opacity-70">Filings</p>
                          <p className="px-2 py-1.5 opacity-70">Collections</p>
                        </div>
                      </div>
                    )}
                    <div className="min-w-0 bg-[#f7f9f8] p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-[10px] font-bold uppercase text-slate-500">
                            Today
                          </p>
                          <p className="mt-1 text-sm font-extrabold text-slate-950">
                            Business overview
                          </p>
                        </div>
                        <button
                          type="button"
                          className="rounded-md px-2.5 py-1.5 text-[10px] font-bold text-white"
                          style={{ backgroundColor: previewColor }}
                          data-testid="preview-button"
                        >
                          New invoice
                        </button>
                      </div>
                      <div className="mt-5 grid grid-cols-2 border-y border-slate-200 bg-white">
                        {[
                          ["Submitted", "24"],
                          ["Outstanding", "₦2.4m"],
                          ["Due soon", "3"],
                          ["Risk", "Low"],
                        ].map(([label, value]) => (
                          <div
                            key={label}
                            className="border-b border-r border-slate-100 p-3"
                          >
                            <p className="text-[9px] font-semibold text-slate-500">
                              {label}
                            </p>
                            <p className="mt-1 text-sm font-extrabold text-slate-950">
                              {value}
                            </p>
                          </div>
                        ))}
                      </div>
                      <div className="mt-5">
                        <p className="text-xs font-bold text-slate-900">
                          Priority work
                        </p>
                        <div className="mt-2 divide-y divide-slate-200 border-y border-slate-200 bg-white">
                          {[
                            "Review two draft invoices",
                            "Prepare the VAT return",
                            "Chase one overdue balance",
                          ].map((item, index) => (
                            <div
                              key={item}
                              className="flex items-center gap-2 px-3 py-3"
                            >
                              <span
                                className="size-1.5 rounded-full"
                                style={{ backgroundColor: previewColor }}
                              />
                              <span className="text-[10px] font-medium text-slate-700">
                                {item}
                              </span>
                              <span className="ml-auto text-[9px] text-slate-400">
                                {index + 1}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card data-testid="card-public-url">
            <CardContent className="pt-6">
              <div className="flex items-start gap-3">
                <Globe
                  className="w-5 h-5 text-primary mt-0.5 shrink-0"
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <p className="font-medium">Public URL</p>
                  <p
                    className="text-sm font-mono mt-1 break-all"
                    data-testid="text-public-url"
                  >
                    https://{subdomain || "your-firm"}.meridianiq.example
                  </p>
                  <p className="text-xs text-muted-foreground mt-2">
                    The public shell resolves your branding before login via{" "}
                    <span className="font-mono">
                      /api/public/theme?subdomain={subdomain || "your-firm"}
                    </span>
                    .
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
