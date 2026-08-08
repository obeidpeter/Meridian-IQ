import { ReactNode, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  Bell,
  BarChart3,
  Bot,
  Calendar as CalendarIcon,
  CalendarCheck2,
  CircleUserRound,
  FileCheck2,
  FileText,
  Grid2x2,
  HandCoins,
  Inbox,
  Landmark,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  Menu,
  Percent,
  Receipt,
  Repeat,
  Scale,
  Search,
  ShieldCheck,
  Sparkles,
  Store,
  Upload,
} from "lucide-react";
import type { Me } from "@workspace/api-client-react";
import { useGetMe, useLogout } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { NotificationBell } from "@/components/notification-bell";
import { StaleBuildBanner } from "@/components/stale-build-banner";
import { ClerkDock } from "@/components/clerk-dock";
import { CommandMenu, type CommandItem } from "@workspace/web-ui";

type NavLink = {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  capability?: string;
};

type NavGroup = {
  title: string;
  links: NavLink[];
};

const NAV_GROUPS: NavGroup[] = [
  {
    title: "Work",
    links: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard },
      { href: "/month-end", label: "Month-end", icon: CalendarCheck2 },
      { href: "/invoices", label: "Invoices", icon: FileText },
      { href: "/bills", label: "Bills", icon: Receipt },
      { href: "/collections", label: "Collections", icon: HandCoins },
      { href: "/recurring", label: "Recurring", icon: Repeat },
      { href: "/import", label: "Import", icon: Upload },
    ],
  },
  {
    title: "Compliance",
    links: [
      { href: "/vat", label: "VAT", icon: Percent },
      { href: "/reconciliation", label: "Reconciliation", icon: Landmark },
      { href: "/b2c", label: "B2C reports", icon: Store },
      {
        href: "/obligations",
        label: "Obligations",
        icon: Scale,
        capability: "obligation.read",
      },
      {
        href: "/filings",
        label: "Filings",
        icon: CalendarCheck2,
        capability: "filing.read",
      },
      {
        href: "/wht",
        label: "WHT credits",
        icon: HandCoins,
        capability: "invoice.read",
      },
    ],
  },
  {
    title: "Clerk AI",
    links: [
      {
        href: "/clerk",
        label: "Send to Clerk",
        icon: Sparkles,
        capability: "clerk.capture",
      },
      {
        href: "/clerk/ask",
        label: "Ask Clerk",
        icon: Bot,
        capability: "clerk.ask",
      },
    ],
  },
  {
    title: "Workspace",
    links: [
      { href: "/calendar", label: "Calendar", icon: CalendarIcon },
      { href: "/analytics", label: "Analytics", icon: BarChart3 },
      { href: "/notifications", label: "Notifications", icon: Inbox },
      { href: "/alerts", label: "Alert settings", icon: Bell },
      { href: "/consent", label: "Consent", icon: ShieldCheck },
    ],
  },
];

const ROLE_CONTEXT: Record<
  string,
  { title: string; description: string; badge: string }
> = {
  firm_admin: {
    title: "Client compliance workspace",
    description: "Invoicing, filings and firm-led controls",
    badge: "Firm admin",
  },
  firm_staff: {
    title: "Client delivery workspace",
    description: "Daily invoicing and compliance operations",
    badge: "Firm staff",
  },
  client_user: {
    title: "Business workspace",
    description: "Cashflow, invoices and compliance evidence",
    badge: "Business user",
  },
};

function accountInitials(
  name: string | null | undefined,
  email: string | null | undefined,
) {
  const source = name?.trim() || email?.split("@")[0] || "MI";
  return source
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function BrandMark() {
  return (
    <span className="flex items-center gap-2.5">
      <span className="grid size-9 place-items-center rounded-md bg-lime-300 text-[#071a1c]">
        <FileCheck2 className="size-5" aria-hidden="true" />
      </span>
      <span>
        <span className="block text-base font-extrabold leading-none text-white">
          MeridianIQ
        </span>
        <span className="mt-1 block text-[10px] font-semibold text-white/45">
          Compliance Workspace
        </span>
      </span>
    </span>
  );
}

function isLinkActive(location: string, href: string) {
  if (location === href) return true;
  if (href === "/clerk" && location.startsWith("/clerk/ask")) return false;
  return href !== "/" && location.startsWith(`${href}/`);
}

function NavLinks({
  groups,
  location,
  me,
  roleContext,
  onNavigate,
  onSignOut,
  signingOut,
}: {
  groups: NavGroup[];
  location: string;
  me: Me | undefined;
  roleContext: { title: string; description: string; badge: string };
  onNavigate?: () => void;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  return (
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

      <div className="workspace-nav-scroll min-h-0 flex-1 space-y-6 overflow-y-auto pr-1">
        {groups.map((group) => (
          <div key={group.title} className="flex flex-col gap-1">
            <p className="px-3 pb-1.5 text-[10px] font-bold text-white/35">
              {group.title}
            </p>
            {group.links.map((link) => {
              const Icon = link.icon;
              const active = isLinkActive(location, link.href);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={onNavigate}
                  data-testid={`nav-${link.label.toLowerCase().replace(/\s+/g, "-")}`}
                  className={`flex min-h-10 items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#071a1c] ${
                    active
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
          onClick={onSignOut}
          disabled={signingOut}
          className="flex min-h-10 w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm font-medium text-white/65 transition-colors hover:bg-white/8 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#071a1c] disabled:opacity-50"
          data-testid="button-sign-out"
        >
          <LogOut className="size-[1.1rem]" aria-hidden="true" />
          {signingOut ? "Signing out..." : "Sign out"}
        </button>
      </div>
    </nav>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const [location, navigate] = useLocation();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const { data: me } = useGetMe();
  const logout = useLogout();
  const mainRef = useRef<HTMLElement>(null);
  const didMount = useRef(false);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    if (!didMount.current) {
      didMount.current = true;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
  }, [location]);

  const signOut = async () => {
    try {
      await logout.mutateAsync();
    } catch {
      // Cookie clearing is best effort; leave the workspace regardless.
    }
    window.location.href = "/login";
  };

  const capabilities = new Set(me?.capabilities ?? []);
  const groups = NAV_GROUPS.map((group) => ({
    ...group,
    links: group.links.filter(
      (link) => !link.capability || capabilities.has(link.capability),
    ),
  })).filter((group) => group.links.length > 0);
  const roleContext = ROLE_CONTEXT[me?.role ?? ""] ?? {
    title: "Compliance workspace",
    description: "Role-scoped invoicing and compliance",
    badge: me?.role ?? "Loading",
  };
  const activeLink = groups
    .flatMap((group) => group.links)
    .sort((a, b) => b.href.length - a.href.length)
    .find((link) => isLinkActive(location, link.href));
  const pageTitle = activeLink?.label ?? roleContext.title;
  const commandItems: CommandItem[] = groups.flatMap((group) =>
    group.links.map((link) => {
      const Icon = link.icon;
      return {
        id: `sme-command-${link.label.toLowerCase().replace(/\s+/g, "-")}`,
        label: link.label,
        description: `Open ${link.label.toLowerCase()} for this business.`,
        group: group.title,
        icon: <Icon className="size-4" aria-hidden="true" />,
        keywords: [group.title, "business", "compliance"],
        onSelect: () => navigate(link.href),
      };
    }),
  );
  const navProps = {
    groups,
    location,
    me,
    roleContext,
    onSignOut: signOut,
    signingOut: logout.isPending,
  };

  return (
    <div className="min-h-screen bg-[#f3f6f5] md:grid md:grid-cols-[17rem_minmax(0,1fr)]">
      <CommandMenu
        items={commandItems}
        open={commandOpen}
        onOpenChange={setCommandOpen}
        title="Find work"
        placeholder="Search invoices, compliance and Clerk tools"
      />
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-lime-300 focus:px-4 focus:py-2 focus:text-sm focus:font-bold focus:text-[#071a1c]"
      >
        Skip to content
      </a>

      <div className="flex items-center justify-between bg-[#071a1c] px-4 py-3 md:hidden">
        <BrandMark />
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="text-white shadow-none hover:bg-white/10 hover:text-white"
            aria-label="Search workspace"
            onClick={() => setCommandOpen(true)}
          >
            <Search aria-hidden="true" />
          </Button>
          <NotificationBell />
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="text-white shadow-none hover:bg-white/10 hover:text-white"
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
              <NavLinks {...navProps} onNavigate={() => setSheetOpen(false)} />
            </SheetContent>
          </Sheet>
        </div>
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
        <NavLinks {...navProps} />
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
            <Button
              variant="outline"
              className="h-9 w-56 justify-between border-slate-200 bg-slate-50 px-3 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
              onClick={() => setCommandOpen(true)}
              data-testid="button-command-menu"
            >
              <span className="flex min-w-0 items-center gap-2">
                <Search className="size-4" aria-hidden="true" />
                <span className="truncate text-xs font-semibold">
                  Search workspace
                </span>
              </span>
              <kbd className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-bold text-slate-500">
                Ctrl K
              </kbd>
            </Button>
            <NotificationBell />
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
                  {me?.email ?? roleContext.badge}
                </p>
              </div>
            </div>
          </div>
        </header>

        <main
          id="main-content"
          ref={mainRef}
          tabIndex={-1}
          className="mx-auto w-full max-w-[90rem] px-4 py-5 focus:outline-none sm:px-6 md:px-8 md:py-8 lg:px-10"
        >
          <StaleBuildBanner />
          {children}
        </main>
      </div>
      {capabilities.has("clerk.ask") && <ClerkDock />}
    </div>
  );
}
