import { ReactNode, useState } from "react";
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
import { useGetMe, useLogout } from "@workspace/api-client-react";

const ROLE_LABELS: Record<string, string> = {
  firm_admin: "Firm admin",
  firm_staff: "Firm staff",
  client_user: "Client user",
};

function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

const LINKS = [
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

export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [sheetOpen, setSheetOpen] = useState(false);
  const { data: me } = useGetMe();
  const logout = useLogout();

  const signOut = async () => {
    try {
      await logout.mutateAsync();
    } catch {
      /* clearing the cookie is best-effort; redirect regardless */
    }
    window.location.href = "/";
  };

  const NavLinks = ({ onNavigate }: { onNavigate?: () => void }) => (
    <nav className="flex flex-col gap-1 p-4 h-full min-h-0 overflow-y-auto">
      <div className="mb-5 px-2">
        <BrandMark />
        <p className="text-xs text-muted-foreground truncate mt-2">
          {me ? "Compliance workspace" : "Loading…"}
        </p>
      </div>
      {LINKS.map((link) => {
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
          href="/"
          className="flex items-center gap-3 px-3 py-2 rounded-md text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          data-testid="link-all-apps"
        >
          <Grid2x2 className="w-5 h-5" aria-hidden="true" />
          All apps
        </a>
        <button
          onClick={signOut}
          disabled={logout.isPending}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-foreground hover:bg-muted transition-colors text-left disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          data-testid="button-sign-out"
        >
          <LogOut className="w-5 h-5" aria-hidden="true" />
          Sign out
        </button>
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen bg-background flex flex-col md:flex-row">
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
            <NavLinks onNavigate={() => setSheetOpen(false)} />
          </SheetContent>
        </Sheet>
      </div>

      <div className="hidden md:flex w-64 border-r bg-card min-h-screen sticky top-0 max-h-screen flex-col">
        <NavLinks />
      </div>

      <main className="flex-1 p-4 md:p-8 overflow-y-auto max-w-6xl mx-auto w-full">
        {children}
      </main>
    </div>
  );
}
