import type { ReactNode } from "react";
import { Link } from "wouter";
import { useGetMe } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Lock } from "lucide-react";

/**
 * Capability gate for pages that not every SME-app role can use (e.g. Ask
 * Clerk is firm-only). The nav already hides links the principal lacks; this
 * covers direct URL hits so a wrong-role visitor gets an explanation instead
 * of a page full of 403s. RequireSession has resolved `me` before any page
 * mounts, so the null guard only covers refetch flickers.
 */
export function CapabilityGate({
  capability,
  children,
}: {
  capability: string;
  children: ReactNode;
}) {
  const { data: me } = useGetMe();
  if (!me) return null;
  if (!me.capabilities.includes(capability)) {
    return (
      <div className="max-w-lg mx-auto mt-16">
        <Card data-testid="card-access-denied">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <Lock
                className="w-5 h-5 text-muted-foreground mt-0.5 shrink-0"
                aria-hidden="true"
              />
              <div className="space-y-3">
                <div>
                  <p className="font-medium">Not available for your account</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    This page needs the{" "}
                    <code className="text-xs">{capability}</code> permission,
                    which your account doesn't have.
                  </p>
                </div>
                <Button size="sm" asChild data-testid="button-back-home">
                  <Link href="/">Back to dashboard</Link>
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }
  return <>{children}</>;
}
