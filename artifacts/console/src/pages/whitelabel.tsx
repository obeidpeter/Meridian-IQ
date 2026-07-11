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
import { Globe, Palette } from "lucide-react";

// Server-side pattern on FirmThemeInput.subdomain (openapi.yaml): mirror it
// here so the form rejects bad slugs before the round-trip.
const SUBDOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

const DEFAULT_PRIMARY = "152 60% 30%";

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

  useEffect(() => {
    if (!firm || hydrated) return;
    setSubdomain(firm.subdomain ?? "");
    setBrandName(themeString(firm.theme, "brandName") || firm.name);
    setPrimary(themeString(firm.theme, "primary") || DEFAULT_PRIMARY);
    setLogoInitials(themeString(firm.theme, "logoInitials"));
    setHydrated(true);
  }, [firm, hydrated]);

  const subdomainValid = subdomain === "" || SUBDOMAIN_PATTERN.test(subdomain);
  const previewColor = `hsl(${primary || DEFAULT_PRIMARY})`;
  const initials =
    logoInitials ||
    (brandName || firm?.name || "MQ")
      .split(/\s+/)
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();

  const save = () => {
    if (!firm || !subdomainValid) return;
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
        <h1 className="text-2xl md:text-3xl font-bold" data-testid="text-page-title">
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
      <div>
        <h1 className="text-2xl md:text-3xl font-bold" data-testid="text-page-title">
          White-label branding
        </h1>
        <p className="text-muted-foreground mt-1">
          One deployment, your brand. Clients see your name, colour and
          subdomain — no per-firm builds.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 items-start">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Palette className="w-4 h-4 text-primary" aria-hidden="true" /> Branding
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
                <p id="subdomain-hint" className="text-xs text-muted-foreground mt-1">
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
            <Button
              onClick={save}
              disabled={!subdomainValid || updateTheme.isPending}
              data-testid="button-save-branding"
            >
              {updateTheme.isPending ? "Saving…" : "Save branding"}
            </Button>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card data-testid="card-preview">
            <CardHeader>
              <CardTitle className="text-base">Live preview</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="rounded-lg border overflow-hidden">
                <div
                  className="flex items-center gap-3 px-4 py-3 text-white"
                  style={{ backgroundColor: previewColor }}
                  data-testid="preview-header"
                >
                  <span className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center text-sm font-bold">
                    {initials}
                  </span>
                  <span className="font-semibold">
                    {brandName || firm.name}
                  </span>
                </div>
                <div className="p-4 space-y-3 bg-background">
                  <p className="text-sm text-muted-foreground">
                    Your clients sign in to a portal carrying your brand, not
                    ours.
                  </p>
                  <button
                    type="button"
                    className="px-4 py-2 rounded-md text-sm font-medium text-white"
                    style={{ backgroundColor: previewColor }}
                    data-testid="preview-button"
                  >
                    New invoice
                  </button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card data-testid="card-public-url">
            <CardContent className="pt-6">
              <div className="flex items-start gap-3">
                <Globe className="w-5 h-5 text-primary mt-0.5 shrink-0" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="font-medium">Public URL</p>
                  <p className="text-sm font-mono mt-1 break-all" data-testid="text-public-url">
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
