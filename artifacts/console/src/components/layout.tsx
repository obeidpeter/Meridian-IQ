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
  UserPlus,
  CircleUserRound,
  LockKeyhole,
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
import { StaleBuildBanner } from "@/components/stale-build-banner";

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
      {
        href: "/",
        label: "Portfolio",
        icon: Users,
        capability: "console.portfolio.read",
      },
      {
        href: "/pipeline",
        label: "Onboarding",
        icon: GitBranch,
        capability: "console.portfolio.read",
      },
      {
        href: "/clients/import",
        label: "Client import",
        icon: Upload,
        capability: "clients.import",
      },
      {
        href: "/advisory",
        label: "Advisory",
        icon: ClipboardCheck,
        capability: "engagement.write",
      },
      {
        href: "/invitations",
        label: "Team invitations",
        icon: UserPlus,
        capability: "invitation.write",
      },
      {
        href: "/integrations",
        label: "Integrations",
        icon: Plug,
        capability: "connector.read",
      },
    ],
  },
  {
    title: "Growth & revenue",
    links: [
      {
        href: "/billing",
        label: "Plans & billing",
        icon: CreditCard,
        capability: "billing.read",
      },
      // Revenue-share statements are billing surface (GET /billing/statements).
      {
        href: "/statements",
        label: "Statements",
        icon: FileText,
        capability: "billing.read",
      },
      {
        href: "/unearned-income",
        label: "Unearned income",
        icon: TrendingUp,
        capability: "console.portfolio.read",
      },
      {
        href: "/whitelabel",
        label: "White-label",
        icon: Palette,
        capability: "theme.write",
      },
      {
        href: "/certification",
        label: "Certification",
        icon: GraduationCap,
        capability: "certification.read",
      },
    ],
  },
  {
    title: "Platform",
    links: [
      {
        href: "/operator-queue",
        label: "Operator queue",
        icon: ListChecks,
        capability: "operator.queue.read",
      },
      {
        href: "/parties",
        label: "Party integrity",
        icon: GitMerge,
        capability: "party.merge",
      },
      {
        href: "/catalogue",
        label: "Error catalogue",
        icon: BookOpen,
        capability: "catalogue.write",
      },
      {
        href: "/platform-ops",
        label: "Platform ops",
        icon: Activity,
        capability: "operator.queue.read",
      },
      {
        href: "/gate-metrics",
        label: "Gate metrics",
        icon: Gauge,
        capability: "operator.queue.read",
      },
      {
        href: "/feature-flags",
        label: "Feature flags",
        icon: ToggleRight,
        capability: "flags.read",
      },
      {
        href: "/audit",
        label: "Audit & evidence",
        icon: ShieldCheck,
        capability: "audit.read",
      },
      {
        href: "/clerk/claims",
        label: "Claims register",
        icon: BookMarked,
        capability: "claims.read",
      },
      { href: "/clerk", label: "Clerk", icon: Bot, capability: "clerk.use" },
    ],
  },
];

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

const ROLE_CONTEXT: Record<
  string,
  { title: string; description: string; badge: string }
> = {
  firm_admin: {
    title: "Practice command centre",
    description: "Portfolio, revenue and firm controls",
    badge: "Firm admin",
  },
  firm_staff: {
    title: "Client delivery console",
    description: "Portfolio and compliance operations",
    badge: "Firm staff",
  },
  operator: {
    title: "Compliance Desk",
    description: "Cross-tenant exceptions and governed review",
    badge: "Operator",
  },
  auditor: {
    title: "Audit workspace",
    description: "Read-only evidence and platform controls",
    badge: "Read only",
  },
};

function accountInitials(
  name: string | null | undefined,
  email: string | null | undefined,
) {
  const source = name?.trim() || email?.split("@")[0] || "MI";
  const parts = source.split(/\s+/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function BrandMark() {
  return (
    <span className="flex items-center gap-2.5">
      <span className="grid size-9 place-items-center rounded-md bg-lime-300 text-[#071a1c]">
        <FileCheck2 className="h-5 w-5" aria-hidden="true" />
      </span>
      <span>
        <span className="block text-base font-extrabold leading-none text-white">
          MeridianIQ
        </span>
        <span className="mt-1 block text-[10px] font-semibold text-white/45">
          Accountant Console
        </span>
      </span>
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
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    mainRef.current?.focus({ preventScroll: true });
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
  const roleContext = ROLE_CONTEXT[me?.role ?? ""] ?? {
    title: "Accountant Console",
    description: "Role-scoped workspace",
    badge: me ? roleLabel(me.role) : "Loading",
  };

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

  const activeLink = groups
    .flatMap((group) => group.links)
    .sort((a, b) => b.href.length - a.href.length)
    .find((link) => isLinkActive(link.href));
  const pageTitle = activeLink?.label ?? roleContext.title;

  const NavLinks = ({ onNavigate }: { onNavigate?: () => void }) => (
    <nav className="flex h-full min-h-0 flex-col bg-[#071a1c] px-3 py-5 text-white">
      <div className="mb-6 px-2">
        <BrandMark />
        <div className="mt-5 border-l-2 border-lime-300 pl-3">
          <p className="text-xs font-bold text-white">
            {me ? roleContext.title : "Loading workspace"}
          </p>
          <p className="mt-1 text-[11px] leading-4 text-white/45">
            {roleContext.description}
          </p>
        </div>
      </div>
      <div className="console-nav-scroll min-h-0 flex-1 space-y-6 overflow-y-auto pr-1">
        {groups.map((group) => (
          <div key={group.title} className="flex flex-col gap-1">
            <p className="px-3 pb-1.5 text-[10px] font-bold uppercase text-white/35">
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
                  className={`flex min-h-10 items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#071a1c] ${
                    isActive
                      ? "bg-lime-300 font-bold text-[#071a1c]"
                      : "font-medium text-white/68 hover:bg-white/8 hover:text-white"
                  }`}
                >
                  <Icon className="size-[1.1rem] shrink-0" aria-hidden="true" />
                  <span className="min-w-0 truncate">{link.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </div>

      <div className="mt-auto space-y-1 border-t border-white/10 pt-4">
        {me && (
          <div
            className="mb-3 flex items-center gap-3 px-2"
            data-testid="text-account"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-md bg-white/10 text-xs font-extrabold text-lime-200">
              {accountInitials(me.fullName, me.email)}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-white">
                {me.fullName ?? me.email ?? "Signed in"}
              </p>
              <p className="mt-0.5 truncate text-[11px] text-white/45">
                {roleContext.badge}
              </p>
            </div>
          </div>
        )}
        <a
          href="/login"
          className="flex min-h-10 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-white/65 transition-colors hover:bg-white/8 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#071a1c]"
          data-testid="link-all-apps"
        >
          <Grid2x2 className="size-[1.1rem]" aria-hidden="true" />
          All apps
        </a>
        <button
          onClick={signOut}
          disabled={logout.isPending}
          className="flex min-h-10 w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm font-medium text-white/65 transition-colors hover:bg-white/8 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#071a1c] disabled:opacity-50"
          data-testid="button-sign-out"
        >
          <LogOut className="size-[1.1rem]" aria-hidden="true" />
          {logout.isPending ? "Signing out..." : "Sign out"}
        </button>
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen bg-[#f3f6f5] md:grid md:grid-cols-[17rem_minmax(0,1fr)]">
      <a
        href="#main-content"
        className={`sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-lime-300 focus:px-4 focus:py-2 focus:text-[#071a1c] ${FOCUS_RING}`}
        data-testid="link-skip-to-content"
      >
        Skip to content
      </a>

      <div className="flex items-center justify-between bg-[#071a1c] px-4 py-3 md:hidden">
        <BrandMark />
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="text-white hover:bg-white/10 hover:text-white"
              aria-label="Open navigation"
              data-testid="button-menu"
            >
              <Menu aria-hidden="true" />
            </Button>
          </SheetTrigger>
          <SheetContent
            side="left"
            className="w-[17rem] border-r-0 bg-[#071a1c] p-0 text-white [&>button]:text-white"
          >
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <NavLinks onNavigate={() => setSheetOpen(false)} />
          </SheetContent>
        </Sheet>
      </div>
      <div className="border-b border-slate-200 bg-white px-4 py-3 md:hidden">
        <p className="text-[11px] font-bold text-teal-700">
          {roleContext.title}
        </p>
        <p className="mt-0.5 truncate text-sm font-extrabold text-slate-950">
          {pageTitle}
        </p>
      </div>

      <aside className="sticky top-0 hidden h-screen min-h-screen flex-col md:flex">
        <NavLinks />
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-20 hidden min-h-16 items-center justify-between gap-6 border-b border-slate-200 bg-white/95 px-8 backdrop-blur md:flex lg:px-10">
          <div className="min-w-0">
            <p className="text-[11px] font-bold text-teal-700">
              {roleContext.title}
            </p>
            <p className="mt-0.5 truncate text-sm font-extrabold text-slate-950">
              {pageTitle}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-4">
            <span className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[11px] font-bold text-slate-600">
              <LockKeyhole
                className="size-3.5 text-teal-700"
                aria-hidden="true"
              />
              {roleContext.badge}
            </span>
            <div className="flex items-center gap-2.5">
              <span className="grid size-8 place-items-center rounded-md bg-[#0b6463] text-[11px] font-extrabold text-white">
                {me ? (
                  accountInitials(me.fullName, me.email)
                ) : (
                  <CircleUserRound className="size-4" aria-hidden="true" />
                )}
              </span>
              <div className="hidden max-w-48 xl:block">
                <p className="truncate text-xs font-bold text-slate-900">
                  {me?.fullName ?? me?.email ?? "Signed in"}
                </p>
                <p className="mt-0.5 truncate text-[10px] text-slate-500">
                  {me?.email ?? roleLabel(me?.role)}
                </p>
              </div>
            </div>
          </div>
        </header>

        <main
          ref={mainRef}
          id="main-content"
          tabIndex={-1}
          className="mx-auto w-full max-w-[90rem] px-4 py-5 focus:outline-none sm:px-6 md:px-8 md:py-8 lg:px-10"
        >
          {/* App-wide: a stale api-server build breaks pages in confusing
              ways, so the version-skew warning sits above every page. */}
          <StaleBuildBanner />
          {children}
        </main>
      </div>
    </div>
  );
}
