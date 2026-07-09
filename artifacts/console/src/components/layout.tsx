import { ReactNode } from "react";
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
} from "lucide-react";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { useGetMe, useLogout } from "@workspace/api-client-react";
import { roleLabel } from "@/components/capability-gate";

// Every console page maps to the RBAC capability its API surface requires
// (modules/auth/rbac.ts). The nav renders only what the signed-in principal
// can actually use — an operator sees the Compliance Desk tools, a firm admin
// sees the practice-management pages, firm staff a subset.
const NAV_LINKS: {
  href: string;
  label: string;
  icon: typeof Users;
  capability: string;
}[] = [
  { href: "/", label: "Portfolio", icon: Users, capability: "console.portfolio.read" },
  { href: "/pipeline", label: "Onboarding", icon: GitBranch, capability: "console.portfolio.read" },
  { href: "/clients/import", label: "Client import", icon: Upload, capability: "clients.import" },
  { href: "/advisory", label: "Advisory", icon: ClipboardCheck, capability: "engagement.write" },
  { href: "/unearned-income", label: "Unearned income", icon: TrendingUp, capability: "console.portfolio.read" },
  { href: "/billing", label: "Plans & billing", icon: CreditCard, capability: "billing.read" },
  { href: "/integrations", label: "Integrations", icon: Plug, capability: "connector.read" },
  { href: "/whitelabel", label: "White-label", icon: Palette, capability: "theme.write" },
  { href: "/certification", label: "Certification", icon: GraduationCap, capability: "certification.read" },
  // Revenue-share statements are billing surface (GET /billing/statements).
  { href: "/statements", label: "Statements", icon: FileText, capability: "billing.read" },
  { href: "/operator-queue", label: "Operator queue", icon: ListChecks, capability: "operator.queue.read" },
  { href: "/parties", label: "Party integrity", icon: GitMerge, capability: "party.merge" },
  { href: "/catalogue", label: "Error catalogue", icon: BookOpen, capability: "catalogue.write" },
  { href: "/platform-ops", label: "Platform ops", icon: Activity, capability: "operator.queue.read" },
  { href: "/gate-metrics", label: "Gate metrics", icon: Gauge, capability: "operator.queue.read" },
  { href: "/feature-flags", label: "Feature flags", icon: ToggleRight, capability: "flags.read" },
  { href: "/audit", label: "Audit & evidence", icon: ShieldCheck, capability: "audit.read" },
];

export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { data: me } = useGetMe();
  const logout = useLogout();

  const signOut = async () => {
    try {
      await logout.mutateAsync();
    } catch {
      /* clearing the cookie is best-effort; leave regardless */
    }
    // Full navigation to the portal so every app re-resolves the (now absent)
    // session instead of trusting cached queries.
    window.location.href = "/";
  };

  const capabilities = new Set(me?.capabilities ?? []);
  const links = NAV_LINKS.filter((l) => capabilities.has(l.capability));
  const subtitle =
    me?.role === "operator"
      ? "Compliance Desk"
      : me?.role === "auditor"
        ? "Read-only audit view"
        : "Accountant console";

  const NavLinks = () => (
    <nav className="flex flex-col gap-1 p-4 h-full min-h-0">
      <div className="mb-5 px-2">
        <h2 className="text-lg font-bold text-primary">MeridianIQ</h2>
        <p className="text-xs text-muted-foreground truncate">
          {me ? subtitle : "Loading…"}
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
            data-testid={`nav-${link.label.toLowerCase().replace(/\s+/g, "-")}`}
            className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${
              isActive
                ? "bg-primary text-primary-foreground font-medium"
                : "text-foreground hover:bg-muted"
            }`}
          >
            <Icon className="w-5 h-5" />
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
          className="flex items-center gap-3 px-3 py-2 rounded-md text-foreground hover:bg-muted transition-colors"
          data-testid="link-all-apps"
        >
          <Grid2x2 className="w-5 h-5" />
          All apps
        </a>
        <button
          onClick={signOut}
          disabled={logout.isPending}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-foreground hover:bg-muted transition-colors text-left disabled:opacity-50"
          data-testid="button-sign-out"
        >
          <LogOut className="w-5 h-5" />
          Sign out
        </button>
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen bg-background flex flex-col md:flex-row">
      <div className="md:hidden flex items-center justify-between p-4 border-b bg-card">
        <h1 className="font-bold text-lg text-primary">MeridianIQ</h1>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" data-testid="button-menu">
              <Menu />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-64 p-0">
            <NavLinks />
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
