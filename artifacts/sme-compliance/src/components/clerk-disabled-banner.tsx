import type { ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle } from "lucide-react";

/**
 * Kill-switch banner (503 CLERK_DISABLED), phrased for clients. The variant,
 * icon, testid and title are pinned here once; each page supplies its own
 * consequence sentence as children.
 */
export function ClerkDisabledBanner({ children }: { children: ReactNode }) {
  return (
    <Alert variant="destructive" data-testid="banner-clerk-disabled">
      <AlertTriangle className="h-4 w-4" aria-hidden="true" />
      <AlertTitle>Clerk is unavailable right now</AlertTitle>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
