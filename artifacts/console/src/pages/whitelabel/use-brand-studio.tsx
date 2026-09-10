import { useEffect, useState } from "react";
import {
  useGetMe,
  useGetFirm,
  useUpdateFirmTheme,
  getGetFirmQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { isFeatureDisabled } from "@/lib/errors";
import { useToast } from "@/hooks/use-toast";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  DEFAULT_PRIMARY,
  SUBDOMAIN_PATTERN,
  type PreviewMode,
  parseHsl,
  themeString,
  whiteContrastEstimate,
} from "./theme";

// Everything the brand studio holds and does (R126 moved it out of the page
// shell): the firm query, the form fields hydrated once from the firm, the
// derived preview values and the save. The shell calls it once and hands the
// bag to the form and preview cards, so nothing about hook order changed.
export function useBrandStudio() {
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
  const parsedPrimary = parseHsl(primary);
  const primaryValid = parsedPrimary !== null;
  const normalizedPrimary = parsedPrimary
    ? `${parsedPrimary[0]} ${parsedPrimary[1]}% ${parsedPrimary[2]}%`
    : DEFAULT_PRIMARY;
  const previewColor = `hsl(${normalizedPrimary})`;
  const contrast = whiteContrastEstimate(primary);
  const contrastPasses = contrast !== null && contrast >= 4.5;
  const previewContrast = contrast ?? whiteContrastEstimate(DEFAULT_PRIMARY)!;
  const previewWhiteText = previewContrast >= 21 / previewContrast;
  const previewStyle = {
    backgroundColor: previewColor,
    color: previewWhiteText ? "#ffffff" : "#000000",
  };
  // Highlights increase contrast instead of washing out small preview labels.
  const previewHighlight = {
    backgroundColor: previewWhiteText
      ? "rgb(0 0 0 / 15%)"
      : "rgb(255 255 255 / 20%)",
  };
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
            primary: normalizedPrimary,
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

  return {
    me,
    firm,
    isLoading,
    error,
    refetch,
    updateTheme,
    featureDark,
    subdomain,
    setSubdomain,
    brandName,
    setBrandName,
    primary,
    setPrimary,
    logoInitials,
    setLogoInitials,
    previewMode,
    setPreviewMode,
    subdomainValid,
    primaryValid,
    normalizedPrimary,
    previewColor,
    contrast,
    contrastPasses,
    previewWhiteText,
    previewStyle,
    previewHighlight,
    initials,
    save,
  };
}

export type BrandStudioState = ReturnType<typeof useBrandStudio>;
