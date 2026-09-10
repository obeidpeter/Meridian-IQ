import { pillClasses } from "@workspace/format";
import { ArrowRight, Lock, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { roleListLabel, type AppTile, type Role } from "./tiles";

export function AppCard({
  app,
  role,
  isLoading,
  onRequestSignIn,
}: {
  app: AppTile;
  role: Role | null;
  isLoading: boolean;
  onRequestSignIn: () => void;
}) {
  const Icon = app.icon;
  const isPublic = app.allowedRoles === null;
  const canOpen =
    isPublic || (role !== null && app.allowedRoles!.includes(role));
  const needsOtherRole =
    !isPublic && role !== null && !app.allowedRoles!.includes(role);

  return (
    <Card
      className={`group flex flex-col p-6 shadow-sm transition-shadow hover:shadow-md ${
        role !== null && canOpen
          ? "ring-2 ring-primary/30 border-primary/40"
          : needsOtherRole
            ? "bg-muted/40"
            : ""
      }`}
    >
      <div className="flex items-start justify-between">
        <div className={`rounded-lg bg-muted p-3 ${app.accent}`}>
          <Icon className="h-6 w-6" aria-hidden="true" />
        </div>
        {isLoading ? (
          <span
            className="h-6 w-24 animate-pulse rounded-full bg-muted"
            aria-hidden="true"
          />
        ) : isPublic ? (
          <span className={pillClasses("slate")}>Free</span>
        ) : canOpen ? (
          <span className={pillClasses("teal")}>
            <ShieldCheck className="h-3 w-3" aria-hidden="true" /> Available to
            you
          </span>
        ) : (
          <span className={pillClasses("slate")}>
            <Lock className="h-3 w-3" aria-hidden="true" />{" "}
            {role ? "Not for this account" : "Sign in first"}
          </span>
        )}
      </div>
      <h3 className="mt-4 text-lg font-semibold">{app.name}</h3>
      <p className="mt-1 flex-1 text-sm text-muted-foreground">{app.tagline}</p>
      <div className="mt-5">
        {isLoading ? (
          <div
            className="h-9 w-full animate-pulse rounded-md bg-muted"
            aria-hidden="true"
          />
        ) : canOpen ? (
          <Button asChild className="w-full">
            <a href={app.href} data-testid={`link-open-${app.key}`}>
              Open {app.name}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </a>
          </Button>
        ) : needsOtherRole ? (
          <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
            <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            For {roleListLabel(app.allowedRoles!)} accounts
          </p>
        ) : (
          <Button
            variant="outline"
            className="w-full"
            onClick={onRequestSignIn}
          >
            Sign in to open
          </Button>
        )}
      </div>
    </Card>
  );
}
