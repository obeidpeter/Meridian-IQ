import { type StatusLight } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { LIGHT_META } from "./meta";

// Deterministic status-light card: skeleton while loading, the light with its
// reasons and recommended action once it resolves, nothing on failure.
export function ComplianceStatusCard({
  statusLight,
  isLoading,
}: {
  statusLight: StatusLight | undefined;
  isLoading: boolean;
}) {
  const lightMeta = statusLight ? LIGHT_META[statusLight.light] : null;
  const LightIcon = lightMeta?.Icon;

  if (isLoading) {
    return (
      <Card data-testid="card-compliance-status">
        <CardHeader>
          <CardTitle className="text-base">Compliance status</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-72 max-w-full" />
          <Skeleton className="h-4 w-56 max-w-full" />
        </CardContent>
      </Card>
    );
  }

  if (statusLight && lightMeta && LightIcon) {
    return (
      <Card data-testid="card-compliance-status">
        <CardHeader>
          <CardTitle className="text-base">Compliance status</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <span
              className={`w-2.5 h-2.5 rounded-full ${lightMeta.dot}`}
              aria-hidden="true"
            />
            <LightIcon
              className={`w-4 h-4 ${lightMeta.text}`}
              aria-hidden="true"
            />
            <span
              className={`font-semibold ${lightMeta.text}`}
              data-testid="text-status-light"
            >
              {lightMeta.label}
            </span>
          </div>
          {statusLight.reasons.length > 0 && (
            <ul className="list-disc pl-5 space-y-0.5 text-muted-foreground">
              {statusLight.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
          <p data-testid="text-recommended-action">
            <span className="font-medium">Recommended action:</span>{" "}
            <span className="text-muted-foreground">
              {statusLight.recommendedAction}
            </span>
          </p>
        </CardContent>
      </Card>
    );
  }

  return null;
}
