import { ReactNode, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  FileText,
  Calendar as CalendarIcon,
  Bell,
  Upload,
  Landmark,
  Store,
  Menu,
  LogOut,
  Grid2x2,
  ShieldCheck,
  FileCheck2,
} from "lucide-react";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { StaleBuildBanner } from "@/components/stale-build-banner";
import { useGetMe, useLogout } from "@workspace/api-client-react";
import type { Me } from "@workspace/api-client-react";

const ROLE_LABELS: Record<string, string> = {
  firm_admin: "Firm admin",
  firm_staff: "Firm staff",
  client_user: "Client user",
};

function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

type NavLink = { href: string; label: string; icon: typeof LayoutDashboard };

const LINKS: NavLink[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/invoices", label: "Invoices", icon: FileText },
  { href: "/import", label: "Import", icon: Upload },
  { href: "/reconciliation", label: "Reconciliation", icon: Landmark },
  { href: "/b2c", label: "B2C reports", icon: Store },
  { href: "/calendar", label: "Calendar", icon: CalendarIcon },
  { href: "/alerts", label: "Alert settings", icon: Bell },
  { href: "/consent", label: "Consent", icon: ShieldCheck },
];

function BrandMark() {
  return (
    <span className="flex items-center gap-2.5">
      <span className="rounded-lg bg-primary p-1.5 text-primary-foreground">
        <FileCheck2 className="h-5 w-5" aria-hidden="true" />
      </span>
      <span className="text-base font-bold leading-none">MeridianIQ</span>
    </span>
  );
}

// Hoisted to module scope so it is a stable component type: rendering it no
// longer remounts the whole nav (and drops focus / resets scroll) on every
// navigation the way a component defined inside Layout would.
function NavLinks({
  links,
  location,
  me,
  onNavigate,
  onSignOut,
  signingOut,
}: {
  links: NavLink[];
  location: string;
  me: Me | undefined;
  onNavigate?: () => void;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  return (
    <nav className="flex flex-col gap-1 p-4 h-full min-h-0 overflow-y-auto">
      <div className="mb-5 px-2">
        <BrandMark />
        <p className="text-xs text-muted-foreground truncate mt-2">
          {me ? "Compliance workspace" : "Loading…"}
        </p>
      </div>
      {links.map((link) => {
        const Icon = link.icon;
        const isActive =
          location === link.href ||
          (link.href !== "/" && location.startsWith(link.href));
        return (
          <Link
            key={link.href}
            href={link.href}
            onClick={onNavigate}
            data-testid={`nav-${link.label.toLowerCase().replace(/\s+/g, "-")}`}
            className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
              isActive
                ? "bg-primary text-primary-foreground font-medium"
                : "text-foreground hover:bg-muted"
            }`}
          >
            <Icon className="w-5 h-5" aria-hidden="true" />
            {link.label}
          </Link>
        );
      })}
      <div className="mt-auto pt-4 border-t space-y-1">
        {me && (
          <div className="px-3 pb-2" data-testid="text-account">
            <p className="text-sm font-medium truncate">
              {me.fullName ?? me.email ?? "Signed in"}
            </p>
            <p className="text-xs text-muted-foreground truncate">
              {me.email ? `${me.email} · ` : ""}
              {roleLabel(me.role)}
            </p>
          </div>
        )}
        <a
          href="/login"
          className="flex items-center gap-3 px-3 py-2 rounded-md text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          data-testid="link-all-apps"
        >
          <Grid2x2 className="w-5 h-5" aria-hidden="true" />
          All apps
        </a>
        <button
          onClick={onSignOut}
          disabled={signingOut}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-foreground hover:bg-muted transition-colors text-left disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          data-testid="button-sign-out"
        >
          <LogOut className="w-5 h-5" aria-hidden="true" />
          Sign out
        </button>
      </div>
    </nav>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [sheetOpen, setSheetOpen] = useState(false);
  const { data: me } = useGetMe();
  const logout = useLogout();
  const mainRef = useRef<HTMLElement>(null);
  const didMount = useRef(false);

  // Move focus to the main region on route change so screen-reader and
  // keyboard users land on the new page's content instead of being stranded
  // where the old page's focus was. Skip the very first mount so we don't
  // steal focus (and scroll) on initial load.
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      return;
    }
    mainRef.current?.focus();
  }, [location]);

  const signOut = async () => {
    try {
      await logout.mutateAsync();
    } catch {
      /* clearing the cookie is best-effort; redirect regardless */
    }
    window.location.href = "/login";
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground focus:shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        Skip to content
      </a>

      <StaleBuildBanner />

      <div className="flex-1 flex flex-col md:flex-row">
        <div className="md:hidden flex items-center justify-between p-4 border-b bg-card">
          <BrandMark />
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Open menu"
                data-testid="button-menu"
              >
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 p-0">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <NavLinks
                links={LINKS}
                location={location}
                me={me}
                onNavigate={() => setSheetOpen(false)}
                onSignOut={signOut}
                signingOut={logout.isPending}
              />
            </SheetContent>
          </Sheet>
        </div>

        <div className="hidden md:flex w-64 border-r bg-card min-h-screen sticky top-0 max-h-screen flex-col">
          <NavLinks
            links={LINKS}
            location={location}
            me={me}
            onSignOut={signOut}
            signingOut={logout.isPending}
          />
        </div>

        <main
          id="main-content"
          ref={mainRef}
          tabIndex={-1}
          className="flex-1 p-4 md:p-8 overflow-y-auto max-w-6xl mx-auto w-full focus-visible:outline-none"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
