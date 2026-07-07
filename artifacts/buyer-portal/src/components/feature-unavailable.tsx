import { Card, CardContent } from "@/components/ui/card";
import { Lock } from "lucide-react";

export function FeatureUnavailable({ feature }: { feature: string }) {
  return (
    <Card data-testid="card-feature-unavailable">
      <CardContent className="pt-6">
        <div className="flex items-start gap-3">
          <Lock className="w-5 h-5 text-muted-foreground mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">{feature} is not yet enabled</p>
            <p className="text-sm text-muted-foreground mt-1">
              This feature has not been switched on for your organization yet.
              Ask your operator to enable it.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
