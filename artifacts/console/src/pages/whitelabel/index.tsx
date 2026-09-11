// The brand studio (R126 split the single file into this shell, the state
// hook, the form card, the preview cards and the pure theme math). The route
// (App.tsx) and the accessibility suite keep importing "@/pages/whitelabel" /
// "./whitelabel": this module is the page's surface.

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FeatureUnavailable } from "@/components/feature-unavailable";
import { QueryError } from "@/components/query-error";
import { isFeatureDisabled } from "@/lib/errors";
import { Save } from "lucide-react";
import { WorkspaceHeader } from "@workspace/web-ui";
import { useBrandStudio } from "./use-brand-studio";
import { BrandingFormCard } from "./branding-form-card";
import { PublicUrlCard, WorkspacePreviewCard } from "./preview-cards";

export function WhiteLabel() {
  const state = useBrandStudio();
  const {
    me,
    firm,
    isLoading,
    error,
    refetch,
    updateTheme,
    featureDark,
    subdomain,
    subdomainValid,
    primaryValid,
    save,
  } = state;

  if (isLoading || !me) {
    return (
      <div className="space-y-4">
        <WorkspaceHeader eyebrow="Firm settings" title="Branding" />
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
        eyebrow="Firm settings"
        title="Branding"
        description="Set the name, colours and logo clients see. Preview your changes before publishing."
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
        <BrandingFormCard state={state} firm={firm} />

        <div className="space-y-4">
          <WorkspacePreviewCard state={state} firm={firm} />

          <PublicUrlCard subdomain={subdomain} />
        </div>
      </div>
    </div>
  );
}
