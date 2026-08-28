import { Card, CardContent } from "@/components/ui/card";
import { Lock } from "lucide-react";

export function FeatureUnavailable({ feature }: { feature: string }) {
  return (
    <Card data-testid="card-feature-unavailable">
      <CardContent className="pt-6">
        <div className="flex items-start gap-3">
          <Lock
            className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div>
            <p className="font-medium">{feature} is not yet enabled</p>
            <p className="text-sm text-muted-foreground mt-1">
              This feature appears when the MeridianIQ rollout and your
              supplier&apos;s account both enable it. Contact the
              supplier&apos;s finance team if you expected access.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
