import { ValoMark } from "@workspace/web-ui";
import { customFetch } from "@workspace/api-client-react";
import {
  signOutAndRedirect,
  SessionOperationRecovery,
  useOperationNavigation,
} from "@workspace/web-ui";
import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  CircleUserRound,
  ClipboardCheck,
  Grid2x2,
  Inbox,
  LockKeyhole,
  LogOut,
  Menu,
  Search,
  ShieldCheck,
  Trophy,
  ListChecks,
} from "lucide-react";
import type { Me } from "@workspace/api-client-react";
import { searchWorkspace, useGetMe, logout } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { NotificationBell } from "@/components/notification-bell";
import { StaleBuildBanner } from "@/components/stale-build-banner";
import {
  CommandMenu,
  NetworkStatus,
  trackUsabilityEvent,
  type CommandItem,
} from "@workspace/web-ui";

const LINKS = [
  { href: "/", label: "Today", icon: ListChecks },
  { href: "/confirmations", label: "Confirmations", icon: ClipboardCheck },
  { href: "/suppliers", label: "Suppliers", icon: ShieldCheck },
  { href: "/scoreboard", label: "Scoreboard", icon: Trophy },
  { href: "/notifications", label: "Notifications", icon: Inbox },
];

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--mi-sidebar-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--mi-sidebar)]";

function accountInitials(
  name: string | null | undefined,
  email: string | null | undefined,
) {
  const source = name?.trim() || email?.split("@")[0] || "V";
  return source
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function BrandMark() {
  return (
    <span className="mi-brand">
      <span className="mi-brand__mark">
        <ValoMark className="size-5" aria-hidden="true" />
      </span>
      <span>
        <span className="mi-brand__name">Valo</span>
        <span className="mi-brand__caption">Buyer workspace</span>
      </span>
    </span>
  );
}

function isLinkActive(location: string, href: string) {
  if (location === href) return true;
  if (href === "/suppliers" && location.startsWith("/suppliers/")) return true;
  return href !== "/" && location.startsWith(`${href}/`);
}

function NavLinks({
  location,
  me,
  onNavigate,
  onSignOut,
  signingOut,
}: {
  location: string;
  me: Me | undefined;
  onNavigate?: () => void;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  return (
    <nav className="mi-sidebar">
      <div className="mb-6">
        <BrandMark />
        <div className="mx-2 mt-5 border-t border-[var(--mi-sidebar-line)] pt-4">
          <p className="text-xs font-bold text-white">Buyer workspace</p>
          <p className="mt-1 text-xs leading-4 text-[var(--mi-sidebar-ink)]">
            Review supplier records and confirm invoices
          </p>
        </div>
      </div>

      <div className="workspace-nav-scroll min-h-0 flex-1 space-y-1 overflow-y-auto">
        <p className="mi-nav__title">Verification</p>
        {LINKS.map((link) => {
          const Icon = link.icon;
          const active = isLinkActive(location, link.href);
          return (
            <Link
              key={link.href}
              href={link.href}
              onClick={onNavigate}
              data-testid={`nav-${link.label.toLowerCase().replace(/\s+/g, "-")}`}
              className={`mi-nav__link ${FOCUS_RING} ${
                active ? "mi-nav__link--active" : ""
              }`}
            >
              <Icon className="size-[1.1rem] shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate" title={link.label}>
                {link.label}
              </span>
            </Link>
          );
        })}
      </div>

      <div className="mi-nav__footer">
        {me && (
          <div className="mi-nav__account" data-testid="text-account">
            <span className="mi-avatar mi-avatar--inverse">
              {accountInitials(me.fullName, me.email)}
            </span>
            <div className="min-w-0">
              <p
                className="mi-nav__account-name"
                title={me.fullName ?? me.email ?? "Signed in"}
              >
                {me.fullName ?? me.email ?? "Signed in"}
              </p>
              <p className="mi-nav__account-role" title="Buyer">
                Buyer
              </p>
            </div>
          </div>
        )}
        <a
          href="/login"
          className={`mi-nav__link ${FOCUS_RING}`}
          data-testid="link-all-apps"
        >
          <Grid2x2 className="size-[1.1rem]" aria-hidden="true" />
          All apps
        </a>
        <button
          onClick={onSignOut}
          disabled={signingOut}
          className={`mi-nav__link ${FOCUS_RING}`}
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
  const openOperation = useOperationNavigation("buyer", navigate);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const { data: me } = useGetMe();
  const [signingOut, setSigningOut] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const isFirstRender = useRef(true);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
  }, [location]);

  const signOut = async () => {
    setSigningOut(true);
    await signOutAndRedirect((signal) => logout({ signal }));
  };

  const activeLink = [...LINKS]
    .sort((a, b) => b.href.length - a.href.length)
    .find((link) => isLinkActive(location, link.href));
  const pageTitle = activeLink?.label ?? "Buyer workspace";
  const commandItems: CommandItem[] = LINKS.map((link) => {
    const Icon = link.icon;
    return {
      id: `buyer-command-${link.label.toLowerCase().replace(/\s+/g, "-")}`,
      label: link.label,
      description: `Open ${link.label.toLowerCase()} in the buyer workspace.`,
      group: "Verification",
      icon: <Icon className="size-4" aria-hidden="true" />,
      keywords: ["supplier", "invoice", "buyer", "VAT"],
      onSelect: () => navigate(link.href),
    };
  });
  const remoteSearch = useCallback(
    async (query: string, signal: AbortSignal): Promise<CommandItem[]> => {
      trackUsabilityEvent("global_search_started", "global_search");
      const results = await searchWorkspace(
        { q: query, limit: 14 },
        { signal },
      );
      if (results.length === 0) {
        trackUsabilityEvent("zero_result_search", "global_search");
      }
      return results.map((result) => ({
        id: `buyer-search-${result.id}`,
        label: result.label,
        description: result.description,
        group: result.group,
        icon: <Search className="size-4" aria-hidden="true" />,
        onSelect: () => {
          trackUsabilityEvent("global_search_result_opened", "global_search");
          navigate(result.href);
        },
      }));
    },
    [navigate],
  );
  const navProps = {
    location,
    me,
    onSignOut: signOut,
    signingOut: signingOut,
  };

  return (
    <div className="mi-platform min-h-screen bg-[var(--mi-canvas)] lg:grid lg:grid-cols-[17rem_minmax(0,1fr)]">
      <CommandMenu
        items={commandItems}
        open={commandOpen}
        onOpenChange={setCommandOpen}
        title="Find buyer work"
        placeholder="Search confirmations and suppliers"
        remoteSearch={remoteSearch}
      />
      <a
        href="#main-content"
        className={`sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:min-h-11 focus:rounded-md focus:bg-[var(--mi-sidebar-accent)] focus:px-4 focus:py-3 focus:text-sm focus:font-bold focus:text-[#262925] ${FOCUS_RING}`}
      >
        Skip to content
      </a>

      <header className="mi-mobilebar">
        <BrandMark />
        <div className="mi-mobilebar__actions">
          <Button
            variant="ghost"
            size="icon"
            className="text-white shadow-none hover:bg-white/10 hover:text-white"
            aria-label="Search buyer workspace"
            onClick={() => setCommandOpen(true)}
          >
            <Search aria-hidden="true" />
          </Button>
          <NotificationBell triggerClassName="text-white hover:bg-white/10 hover:text-white focus-visible:text-white focus-visible:ring-white focus-visible:ring-offset-0" />
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
              aria-describedby={undefined}
              className="w-[17rem] border-r-0 bg-[var(--mi-sidebar)] p-0 text-white [&>button]:text-white"
            >
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <NavLinks {...navProps} onNavigate={() => setSheetOpen(false)} />
            </SheetContent>
          </Sheet>
        </div>
      </header>
      <section className="mi-mobilebar__context" aria-label="Current workspace">
        <p className="text-xs font-semibold text-primary">Buyer workspace</p>
        <p className="mt-0.5 truncate text-sm font-semibold text-foreground">
          {pageTitle}
        </p>
      </section>

      <aside className="sticky top-0 hidden h-screen min-h-screen flex-col lg:flex">
        <NavLinks {...navProps} />
      </aside>

      <div className="min-w-0">
        <header className="mi-topbar">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-primary">
              Buyer workspace
            </p>
            <p className="mt-0.5 truncate text-sm font-semibold text-foreground">
              {pageTitle}
            </p>
          </div>
          <div className="mi-topbar__actions">
            <Button
              variant="outline"
              className="mi-topbar__action"
              onClick={() => setCommandOpen(true)}
              data-testid="button-command-menu"
            >
              <span className="flex min-w-0 items-center gap-2">
                <Search className="size-4" aria-hidden="true" />
                <span className="truncate text-xs font-semibold">
                  Search buyer workspace
                </span>
              </span>
              <kbd>Ctrl K</kbd>
            </Button>
            <SessionOperationRecovery
              me={me}
              request={customFetch}
              onOpen={openOperation}
            />
            <NotificationBell triggerClassName="text-foreground hover:text-foreground focus-visible:text-foreground" />
            <span className="mi-topbar__role inline-flex items-center gap-1.5">
              <LockKeyhole
                className="size-3.5 text-primary"
                aria-hidden="true"
              />
              Buyer
            </span>
            <div className="flex items-center gap-2.5">
              <span className="mi-avatar">
                {me ? (
                  accountInitials(me.fullName, me.email)
                ) : (
                  <CircleUserRound className="size-4" aria-hidden="true" />
                )}
              </span>
              <div className="hidden max-w-48 xl:block">
                <p className="truncate text-xs font-semibold text-foreground">
                  {me?.fullName ?? me?.email ?? "Signed in"}
                </p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {me?.email ?? "Buyer account"}
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
          <NetworkStatus />
          {children}
        </main>
      </div>
    </div>
  );
}
