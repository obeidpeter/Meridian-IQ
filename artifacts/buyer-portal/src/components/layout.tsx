import { ReactNode, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  ClipboardCheck,
  ShieldCheck,
  Trophy,
  Menu,
  Grid2x2,
  LogOut,
  FileCheck2,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useGetMe, useLogout } from "@workspace/api-client-react";

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

function roleLabel(role: string): string {
  return role === "buyer_user" ? "Buyer" : role;
}

function BrandMark() {
  return (
    <span className="flex items-center gap-2">
      <span className="rounded-lg bg-primary p-1.5 text-primary-foreground">
        <FileCheck2 className="w-4 h-4" aria-hidden="true" />
      </span>
      <span className="text-lg font-bold text-primary">MeridianIQ</span>
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
      /* clearing the cookie is best-effort; leave regardless */
    }
    // Full navigation to the portal so every app re-resolves the session.
    window.location.href = "/";
  };

  const links = [
    { href: "/", label: "Confirmations", icon: ClipboardCheck },
    { href: "/suppliers", label: "Suppliers", icon: ShieldCheck },
    { href: "/scoreboard", label: "Scoreboard", icon: Trophy },
  ];

  const NavLinks = ({ onNavigate }: { onNavigate?: () => void }) => (
    <nav className="flex flex-col gap-1 p-4 h-full min-h-0 overflow-y-auto">
      <div className="mb-5 px-2">
        <BrandMark />
        {me ? (
          <p className="text-xs text-muted-foreground truncate mt-1">
            Buyer Rails
          </p>
        ) : (
          <Skeleton className="h-4 w-20 mt-1" />
        )}
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
            className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${FOCUS_RING} ${
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
          className={`flex items-center gap-3 px-3 py-2 rounded-md text-foreground hover:bg-muted transition-colors ${FOCUS_RING}`}
          data-testid="link-all-apps"
        >
          <Grid2x2 className="w-5 h-5" aria-hidden="true" />
          All apps
        </a>
        <button
          onClick={signOut}
          disabled={logout.isPending}
          className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-foreground hover:bg-muted transition-colors text-left disabled:opacity-50 ${FOCUS_RING}`}
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
      <a
        href="#main-content"
        className={`sr-only focus:not-sr-only focus:absolute focus:z-50 focus:top-2 focus:left-2 focus:bg-primary focus:text-primary-foreground focus:px-3 focus:py-2 focus:rounded-md ${FOCUS_RING}`}
      >
        Skip to content
      </a>
      <div className="md:hidden flex items-center justify-between p-4 border-b bg-card">
        <BrandMark />
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Open navigation"
              data-testid="button-menu"
            >
              <Menu aria-hidden="true" />
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

      <main
        id="main-content"
        className="flex-1 p-4 md:p-8 overflow-y-auto max-w-6xl mx-auto w-full"
      >
        {children}
      </main>
    </div>
  );
}
