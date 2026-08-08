import { ReactNode, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  CircleUserRound,
  ClipboardCheck,
  FileCheck2,
  Grid2x2,
  Inbox,
  LockKeyhole,
  LogOut,
  Menu,
  Search,
  ShieldCheck,
  Trophy,
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
import { CommandMenu, type CommandItem } from "@workspace/web-ui";

const LINKS = [
  { href: "/", label: "Confirmations", icon: ClipboardCheck },
  { href: "/suppliers", label: "Suppliers", icon: ShieldCheck },
  { href: "/scoreboard", label: "Scoreboard", icon: Trophy },
  { href: "/notifications", label: "Notifications", icon: Inbox },
];

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b2030]";

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
      <span className="grid size-9 place-items-center rounded-md bg-cyan-200 text-[#0b2030]">
        <FileCheck2 className="size-5" aria-hidden="true" />
      </span>
      <span>
        <span className="block text-base font-extrabold leading-none text-white">
          MeridianIQ
        </span>
        <span className="mt-1 block text-xs font-semibold text-white/75">
          Buyer Rails
        </span>
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
    <nav className="flex h-full min-h-0 flex-col bg-[#0b2030] px-3 py-5 text-white">
      <div className="mb-7 px-2">
        <BrandMark />
        <div className="mt-5 border-l-2 border-cyan-200 pl-3">
          <p className="text-xs font-bold text-white">
            Buyer finance workspace
          </p>
          <p className="mt-1 text-xs leading-4 text-white/75">
            Supplier verification and VAT protection
          </p>
        </div>
      </div>

      <div className="workspace-nav-scroll min-h-0 flex-1 space-y-1 overflow-y-auto">
        <p className="px-3 pb-1.5 text-xs font-bold text-white/70">
          Verification
        </p>
        {LINKS.map((link) => {
          const Icon = link.icon;
          const active = isLinkActive(location, link.href);
          return (
            <Link
              key={link.href}
              href={link.href}
              onClick={onNavigate}
              data-testid={`nav-${link.label.toLowerCase().replace(/\s+/g, "-")}`}
              className={`flex min-h-10 items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${FOCUS_RING} ${
                active
                  ? "bg-cyan-200 font-bold text-[#0b2030]"
                  : "font-medium text-white/68 hover:bg-white/8 hover:text-white"
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

      <div className="mt-auto space-y-1 border-t border-white/10 pt-4">
        {me && (
          <div
            className="mb-3 flex items-center gap-3 px-2"
            data-testid="text-account"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-md bg-white/10 text-xs font-extrabold text-cyan-100">
              {accountInitials(me.fullName, me.email)}
            </span>
            <div className="min-w-0">
              <p
                className="truncate text-sm font-bold text-white"
                title={me.fullName ?? me.email ?? "Signed in"}
              >
                {me.fullName ?? me.email ?? "Signed in"}
              </p>
              <p
                className="mt-0.5 truncate text-xs text-white/75"
                title="Buyer finance"
              >
                Buyer finance
              </p>
            </div>
          </div>
        )}
        <a
          href="/login"
          className={`flex min-h-10 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-white/65 transition-colors hover:bg-white/8 hover:text-white ${FOCUS_RING}`}
          data-testid="link-all-apps"
        >
          <Grid2x2 className="size-[1.1rem]" aria-hidden="true" />
          All apps
        </a>
        <button
          onClick={onSignOut}
          disabled={signingOut}
          className={`flex min-h-10 w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm font-medium text-white/65 transition-colors hover:bg-white/8 hover:text-white disabled:opacity-50 ${FOCUS_RING}`}
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
    try {
      await logout.mutateAsync();
    } catch {
      // Cookie clearing is best effort; leave the workspace regardless.
    }
    window.location.href = "/login";
  };

  const activeLink = [...LINKS]
    .sort((a, b) => b.href.length - a.href.length)
    .find((link) => isLinkActive(location, link.href));
  const pageTitle = activeLink?.label ?? "Buyer Rails";
  const commandItems: CommandItem[] = LINKS.map((link) => {
    const Icon = link.icon;
    return {
      id: `buyer-command-${link.label.toLowerCase().replace(/\s+/g, "-")}`,
      label: link.label,
      description: `Open ${link.label.toLowerCase()} in Buyer Rails.`,
      group: "Verification",
      icon: <Icon className="size-4" aria-hidden="true" />,
      keywords: ["supplier", "invoice", "buyer", "VAT"],
      onSelect: () => navigate(link.href),
    };
  });
  const navProps = {
    location,
    me,
    onSignOut: signOut,
    signingOut: logout.isPending,
  };

  return (
    <div className="min-h-screen bg-[#f3f6f7] md:grid md:grid-cols-[17rem_minmax(0,1fr)]">
      <CommandMenu
        items={commandItems}
        open={commandOpen}
        onOpenChange={setCommandOpen}
        title="Find buyer work"
        placeholder="Search confirmations and suppliers"
      />
      <a
        href="#main-content"
        className={`sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-cyan-200 focus:px-4 focus:py-2 focus:text-sm focus:font-bold focus:text-[#0b2030] ${FOCUS_RING}`}
      >
        Skip to content
      </a>

      <div className="flex items-center justify-between bg-[#0b2030] px-4 py-3 md:hidden">
        <BrandMark />
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="text-white shadow-none hover:bg-white/10 hover:text-white"
            aria-label="Search buyer workspace"
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
              className="w-[17rem] border-r-0 bg-[#0b2030] p-0 text-white [&>button]:text-white"
            >
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <NavLinks {...navProps} onNavigate={() => setSheetOpen(false)} />
            </SheetContent>
          </Sheet>
        </div>
      </div>
      <div className="border-b border-slate-200 bg-white px-4 py-3 md:hidden">
        <p className="text-[11px] font-bold text-sky-700">
          Buyer finance workspace
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
            <p className="text-[11px] font-bold text-sky-700">
              Buyer finance workspace
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
                  Search Buyer Rails
                </span>
              </span>
              <kbd className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-bold text-slate-500">
                Ctrl K
              </kbd>
            </Button>
            <NotificationBell />
            <span className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[11px] font-bold text-slate-600">
              <LockKeyhole
                className="size-3.5 text-sky-700"
                aria-hidden="true"
              />
              Buyer finance
            </span>
            <div className="flex items-center gap-2.5">
              <span className="grid size-8 place-items-center rounded-md bg-[#17668a] text-[11px] font-extrabold text-white">
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
          {children}
        </main>
      </div>
    </div>
  );
}
