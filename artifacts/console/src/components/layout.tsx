import { ReactNode, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  Users,
  GitBranch,
  TrendingUp,
  CreditCard,
  ListChecks,
  FileText,
  Palette,
  Upload,
  GraduationCap,
  Menu,
  Grid2x2,
  LogOut,
  Activity,
  ToggleRight,
  ClipboardCheck,
  Plug,
  BookOpen,
  Gauge,
  ShieldCheck,
  GitMerge,
  FileCheck2,
  BookMarked,
  Bot,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { useGetMe, useLogout } from "@workspace/api-client-react";
import { roleLabel } from "@/components/capability-gate";

// Every console page maps to the RBAC capability its API surface requires
// (modules/auth/rbac.ts). The nav renders only what the signed-in principal
// can actually use — an operator sees the Compliance Desk tools, a firm admin
// sees the practice-management pages, firm staff a subset. Groups render only
// when they contain at least one capability-visible link.
type NavLink = {
  href: string;
  label: string;
  icon: typeof Users;
  capability: string;
};

const NAV_GROUPS: { title: string; links: NavLink[] }[] = [
  {
    title: "Practice",
    links: [
      { href: "/", label: "Portfolio", icon: Users, capability: "console.portfolio.read" },
      { href: "/pipeline", label: "Onboarding", icon: GitBranch, capability: "console.portfolio.read" },
      { href: "/clients/import", label: "Client import", icon: Upload, capability: "clients.import" },
      { href: "/advisory", label: "Advisory", icon: ClipboardCheck, capability: "engagement.write" },
      { href: "/integrations", label: "Integrations", icon: Plug, capability: "connector.read" },
    ],
  },
  {
    title: "Growth & revenue",
    links: [
      { href: "/billing", label: "Plans & billing", icon: CreditCard, capability: "billing.read" },
      // Revenue-share statements are billing surface (GET /billing/statements).
      { href: "/statements", label: "Statements", icon: FileText, capability: "billing.read" },
      { href: "/unearned-income", label: "Unearned income", icon: TrendingUp, capability: "console.portfolio.read" },
      { href: "/whitelabel", label: "White-label", icon: Palette, capability: "theme.write" },
      { href: "/certification", label: "Certification", icon: GraduationCap, capability: "certification.read" },
    ],
  },
  {
    title: "Platform",
    links: [
      { href: "/operator-queue", label: "Operator queue", icon: ListChecks, capability: "operator.queue.read" },
      { href: "/parties", label: "Party integrity", icon: GitMerge, capability: "party.merge" },
      { href: "/catalogue", label: "Error catalogue", icon: BookOpen, capability: "catalogue.write" },
      { href: "/platform-ops", label: "Platform ops", icon: Activity, capability: "operator.queue.read" },
      { href: "/gate-metrics", label: "Gate metrics", icon: Gauge, capability: "operator.queue.read" },
      { href: "/feature-flags", label: "Feature flags", icon: ToggleRight, capability: "flags.read" },
      { href: "/audit", label: "Audit & evidence", icon: ShieldCheck, capability: "audit.read" },
      { href: "/clerk/claims", label: "Claims register", icon: BookMarked, capability: "claims.read" },
      { href: "/clerk", label: "Clerk", icon: Bot, capability: "clerk.use" },
    ],
  },
];

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

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
  const mainRef = useRef<HTMLElement>(null);

  // Move keyboard/SR focus to the main region on every route change so a
  // single-page navigation announces the new page instead of stranding focus
  // on the link that was just activated.
  useEffect(() => {
    mainRef.current?.focus();
  }, [location]);

  const signOut = async () => {
    try {
      await logout.mutateAsync();
    } catch {
      /* clearing the cookie is best-effort; leave regardless */
    }
    // Full navigation to the portal so every app re-resolves the (now absent)
    // session instead of trusting cached queries.
    window.location.href = "/login";
  };

  const capabilities = new Set(me?.capabilities ?? []);
  const groups = NAV_GROUPS.map((g) => ({
    ...g,
    links: g.links.filter((l) => capabilities.has(l.capability)),
  })).filter((g) => g.links.length > 0);
  const subtitle =
    me?.role === "operator"
      ? "Compliance Desk"
      : me?.role === "auditor"
        ? "Read-only audit view"
        : "Accountant console";

  const isLinkActive = (href: string) => {
    if (location === href) return true;
    // The Claims register (/clerk/claims) is its own entry — don't also light
    // up the Clerk entry when we're on it.
    if (href === "/clerk" && location.startsWith("/clerk/claims")) return false;
    // Prefix matches stop at a path boundary ("/clerkX" never matches "/clerk").
    if (href !== "/" && location.startsWith(`${href}/`)) return true;
    // Client detail pages live under the Portfolio entry (import is its own).
    if (
      href === "/" &&
      location.startsWith("/clients/") &&
      !location.startsWith("/clients/import")
    )
      return true;
    return false;
  };

  const NavLinks = ({ onNavigate }: { onNavigate?: () => void }) => (
    <nav className="flex flex-col p-4 h-full min-h-0">
      <div className="mb-5 px-2">
        <BrandMark />
        <p className="text-xs text-muted-foreground truncate mt-1">
          {me ? subtitle : "Loading…"}
        </p>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto space-y-5">
        {groups.map((group) => (
          <div key={group.title} className="flex flex-col gap-1">
            <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {group.title}
            </p>
            {group.links.map((link) => {
              const Icon = link.icon;
              const isActive = isLinkActive(link.href);
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
          </div>
        ))}
      </div>

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
        className={`sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground ${FOCUS_RING}`}
        data-testid="link-skip-to-content"
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
        ref={mainRef}
        id="main-content"
        tabIndex={-1}
        className="flex-1 p-4 md:p-8 overflow-y-auto max-w-6xl mx-auto w-full focus:outline-none"
      >
        {children}
      </main>
    </div>
  );
}
