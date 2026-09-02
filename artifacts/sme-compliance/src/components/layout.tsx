import { ReactNode, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  Activity,
  Bell,
  BarChart3,
  Bot,
  Calendar as CalendarIcon,
  CalendarCheck2,
  ChevronDown,
  CircleHelp,
  CircleUserRound,
  Compass,
  FilePlus,
  FileText,
  Grid2x2,
  HandCoins,
  Inbox,
  Keyboard,
  Landmark,
  LayoutDashboard,
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
  Pin,
} from "lucide-react";
import type { Me } from "@workspace/api-client-react";
import { useGetMe, useLogout } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { NotificationBell } from "@/components/notification-bell";
import { StaleBuildBanner } from "@/components/stale-build-banner";
import { ClerkDock } from "@/components/clerk-dock";
import {
  CommandMenu,
  readRecentItems,
  ReleaseBadge,
  ShortcutsDialog,
  type ShortcutRow,
  usePinnedItems,
  useGlobalShortcuts,
  WorkspaceChip,
  type CommandItem,
} from "@workspace/web-ui";
import { HELP_TOPICS } from "@/pages/help";

type NavLink = {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  capability?: string;
  // Launch-profile gate (PL-02, client half): the platform feature flag this
  // surface rides. Absent from Me.features means the API answers 404, so the
  // link is hidden rather than navigating into a dead page.
  feature?: string;
};

type NavGroup = {
  title: string;
  links: NavLink[];
};

// The home entry is "Today" (architecture.md, design direction): the page is
// a prioritised work list for this business, not a dashboard of charts.
const NAV_GROUPS: NavGroup[] = [
  {
    title: "Work",
    links: [
      { href: "/", label: "Today", icon: LayoutDashboard },
      { href: "/month-end", label: "Month-end", icon: CalendarCheck2 },
      { href: "/invoices", label: "Invoices", icon: FileText },
      {
        href: "/bills",
        label: "Bills",
        icon: Receipt,
        feature: "money_analytics",
      },
      {
        href: "/collections",
        label: "Collections",
        icon: HandCoins,
        feature: "collection_accounts",
      },
      {
        href: "/recurring",
        label: "Recurring",
        icon: Repeat,
        feature: "money_analytics",
      },
      { href: "/import", label: "Import", icon: Upload },
    ],
  },
  {
    title: "Compliance",
    links: [
      { href: "/vat", label: "VAT", icon: Percent },
      {
        href: "/reconciliation",
        label: "Reconciliation",
        icon: Landmark,
        feature: "reconciliation",
      },
      {
        href: "/b2c",
        label: "B2C reports",
        icon: Store,
        feature: "b2c_reporting",
      },
      {
        href: "/obligations",
        label: "Obligations",
        icon: Scale,
        capability: "obligation.read",
        feature: "statutory_desks",
      },
      {
        href: "/filings",
        label: "Filings",
        icon: CalendarCheck2,
        capability: "filing.read",
        feature: "statutory_desks",
      },
      {
        href: "/wht",
        label: "WHT credits",
        icon: HandCoins,
        capability: "invoice.read",
        feature: "statutory_desks",
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
        feature: "clerk_ai",
      },
      {
        href: "/clerk/ask",
        label: "Ask Clerk",
        icon: Bot,
        capability: "clerk.ask",
        feature: "clerk_ai",
      },
    ],
  },
  {
    title: "Workspace",
    links: [
      { href: "/calendar", label: "Calendar", icon: CalendarIcon },
      { href: "/analytics", label: "Analytics", icon: BarChart3 },
      { href: "/notifications", label: "Notifications", icon: Inbox },
      { href: "/activity", label: "Activity", icon: Activity },
      { href: "/alerts", label: "Alert settings", icon: Bell },
      // Consent stays a first-class entry: the ledger is the CORE-03 promise
      // made visible, not a settings sub-page (architecture.md D15).
      { href: "/consent", label: "Consent", icon: ShieldCheck },
    ],
  },
];

type RoleContext = { title: string; description: string; badge: string };

const ROLE_CONTEXT: Record<string, RoleContext> = {
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
    badge: "Business owner",
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

function BrandMark({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link
      href="/"
      onClick={onNavigate}
      className="mi-brand"
      aria-label="MeridianIQ — go to Today"
    >
      <span className="mi-brand__mark">
        <Compass aria-hidden="true" />
      </span>
      <span>
        <span className="mi-brand__name">MeridianIQ</span>
        <span className="mi-brand__caption">Compliance Workspace</span>
      </span>
    </Link>
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
  roleContext: RoleContext;
  onNavigate?: () => void;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  const navScrollRef = useRef<HTMLDivElement>(null);
  const [hasMoreTools, setHasMoreTools] = useState(false);

  useEffect(() => {
    const element = navScrollRef.current;
    if (!element) return;
    const update = () =>
      setHasMoreTools(
        element.scrollTop + element.clientHeight < element.scrollHeight - 4,
      );
    update();
    window.addEventListener("resize", update);
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(element);
    return () => {
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [groups]);

  return (
    <nav className="mi-sidebar" aria-label="Workspace">
      <BrandMark onNavigate={onNavigate} />

      <div className="mi-nav">
        <div
          ref={navScrollRef}
          onScroll={() => {
            const element = navScrollRef.current;
            if (element) {
              setHasMoreTools(
                element.scrollTop + element.clientHeight <
                  element.scrollHeight - 4,
              );
            }
          }}
          className="mi-nav__scroll"
        >
          {groups.map((group) => (
            <div key={group.title} className="mi-nav__group">
              <p className="mi-nav__title">{group.title}</p>
              {group.links.map((link) => {
                const Icon = link.icon;
                const active = isLinkActive(location, link.href);
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    onClick={onNavigate}
                    data-testid={`nav-${link.label.toLowerCase().replace(/\s+/g, "-")}`}
                    className="mi-nav__link"
                    aria-current={active ? "page" : undefined}
                  >
                    <Icon aria-hidden="true" />
                    <span title={link.label}>{link.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </div>
        {hasMoreTools && (
          <button
            type="button"
            className="mi-nav__more"
            onClick={() =>
              navScrollRef.current?.scrollBy({ top: 180, behavior: "smooth" })
            }
            data-testid="button-more-workspace-tools"
          >
            More tools
            <ChevronDown aria-hidden="true" />
          </button>
        )}
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
              <p className="mi-nav__account-role" title={roleContext.badge}>
                {roleContext.badge}
              </p>
            </div>
          </div>
        )}
        <Link
          href="/help"
          onClick={onNavigate}
          className="mi-nav__link"
          aria-current={isLinkActive(location, "/help") ? "page" : undefined}
          data-testid="nav-help"
        >
          <CircleHelp aria-hidden="true" />
          <span>Help</span>
        </Link>
        <a href="/login" className="mi-nav__link" data-testid="link-all-apps">
          <Grid2x2 aria-hidden="true" />
          <span>All apps</span>
        </a>
        <button
          type="button"
          onClick={onSignOut}
          disabled={signingOut}
          className="mi-nav__link"
          data-testid="button-sign-out"
        >
          <LogOut aria-hidden="true" />
          <span>{signingOut ? "Signing out..." : "Sign out"}</span>
        </button>
      </div>
    </nav>
  );
}

function AccountMenu({
  me,
  roleContext,
  onOpenShortcuts,
  onSignOut,
  signingOut,
}: {
  me: Me | undefined;
  roleContext: RoleContext;
  onOpenShortcuts: () => void;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  const [open, setOpen] = useState(false);
  const name = me?.fullName ?? me?.email ?? "Signed in";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="mi-avatar-button"
          aria-label={`Account menu for ${name}`}
          data-testid="button-account-menu"
        >
          <span className="mi-avatar">
            {me ? (
              accountInitials(me.fullName, me.email)
            ) : (
              <CircleUserRound aria-hidden="true" />
            )}
          </span>
          <ChevronDown aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="mi-account-menu p-3">
        <div className="mi-account-menu__identity">
          <span className="mi-avatar">
            {me ? (
              accountInitials(me.fullName, me.email)
            ) : (
              <CircleUserRound aria-hidden="true" />
            )}
          </span>
          <div className="min-w-0">
            <p className="mi-account-menu__name" title={name}>
              {name}
            </p>
            <p className="mi-account-menu__meta">
              {me?.email && me.fullName ? `${me.email} · ` : ""}
              {roleContext.badge}
            </p>
          </div>
        </div>
        <ul className="mi-account-menu__list">
          <li>
            <Link
              href="/help"
              onClick={() => setOpen(false)}
              className="mi-account-menu__item"
            >
              <CircleHelp aria-hidden="true" />
              Help centre
            </Link>
          </li>
          <li>
            <button
              type="button"
              className="mi-account-menu__item"
              onClick={() => {
                setOpen(false);
                onOpenShortcuts();
              }}
            >
              <Keyboard aria-hidden="true" />
              Keyboard shortcuts
            </button>
          </li>
          <li>
            <a href="/login" className="mi-account-menu__item">
              <Grid2x2 aria-hidden="true" />
              All apps
            </a>
          </li>
          <li>
            <button
              type="button"
              className="mi-account-menu__item"
              onClick={onSignOut}
              disabled={signingOut}
              data-testid="button-sign-out-menu"
            >
              <LogOut aria-hidden="true" />
              {signingOut ? "Signing out..." : "Sign out"}
            </button>
          </li>
        </ul>
      </PopoverContent>
    </Popover>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const [location, navigate] = useLocation();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
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
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (let index = storage.length - 1; index >= 0; index--) {
        const key = storage.key(index);
        if (
          key?.startsWith("meridianiq:invoice-draft") ||
          key?.startsWith("meridianiq:recent-") ||
          key?.startsWith("meridianiq:pinned-") ||
          key?.startsWith("meridianiq:saved-view-") ||
          key?.startsWith("meridianiq:operations:")
        ) {
          storage.removeItem(key);
        }
      }
    }
    window.location.href = "/login";
  };

  const capabilities = new Set(me?.capabilities ?? []);
  const features = new Set(me?.features ?? []);
  // Single-key accelerators for the daily grind (the "?" sheet lists them;
  // useGlobalShortcuts skips typing contexts and open dialogs). "n" only
  // registers for identities that can actually create paper (rbac.ts calls
  // that invoice.write — there is no invoice.create).
  const canCreateInvoice = capabilities.has("invoice.write");
  useGlobalShortcuts([
    ...(canCreateInvoice
      ? [{ key: "n", run: () => navigate("/invoices/new") }]
      : []),
    { key: "/", run: () => setCommandOpen(true) },
    { key: "?", run: () => setShortcutsOpen(true) },
  ]);
  const shortcutRows: ShortcutRow[] = [
    { keys: ["Ctrl", "K"], description: "Find work — pages, invoices, help" },
    { keys: ["/"], description: "Find work — pages, invoices, help" },
    ...(canCreateInvoice
      ? [{ keys: ["N"], description: "Start a new invoice" }]
      : []),
    { keys: ["?"], description: "Show these shortcuts" },
    { keys: ["Esc"], description: "Close a dialog or menu" },
  ];
  const groups = NAV_GROUPS.map((group) => ({
    ...group,
    links: group.links.filter(
      (link) =>
        (!link.capability || capabilities.has(link.capability)) &&
        (!link.feature || features.has(link.feature)),
    ),
  })).filter((group) => group.links.length > 0);
  const roleContext: RoleContext = ROLE_CONTEXT[me?.role ?? ""] ?? {
    title: "Compliance workspace",
    description: "Role-scoped invoicing and compliance",
    badge: me?.role ?? "Loading",
  };
  // The workspace chip names the business this session is scoped to; the
  // role title is the fallback while /me loads or for a firm principal
  // without a client scope.
  const workspaceName = me?.workspaceName ?? roleContext.title;
  const activeLink = groups
    .flatMap((group) => group.links)
    .sort((a, b) => b.href.length - a.href.length)
    .find((link) => isLinkActive(location, link.href));
  const pageTitle =
    activeLink?.label ??
    (isLinkActive(location, "/help") ? "Help" : roleContext.title);
  const pinnedInvoices = usePinnedItems(
    me ? `meridianiq:pinned-invoices:${me.userId}` : null,
  );
  const pinnedInvoiceCommands: CommandItem[] = pinnedInvoices.items.map(
    (item) => ({
      id: `sme-command-pinned-${item.id}`,
      label: item.label,
      description: item.detail ?? "Open this pinned invoice.",
      group: "Pinned invoices",
      icon: <Pin className="size-4" aria-hidden="true" />,
      keywords: ["pinned", "invoice"],
      onSelect: () => navigate(`/invoices/${item.id}`),
    }),
  );
  // Recently opened invoices lead the menu (recognition over recall): the
  // record you were just working on beats re-finding it through the vault.
  const recentInvoices: CommandItem[] = (
    me ? readRecentItems(`meridianiq:recent-invoices:${me.userId}`) : []
  ).map((item) => ({
    id: `sme-command-recent-${item.id}`,
    label: item.label,
    description: item.detail ?? "Open this recent invoice.",
    group: "Recent invoices",
    icon: <FileText className="size-4" aria-hidden="true" />,
    keywords: ["recent", "invoice"],
    onSelect: () => navigate(`/invoices/${item.id}`),
  }));
  const helpItems: CommandItem[] = HELP_TOPICS.map((topic) => ({
    id: `sme-command-help-${topic.id}`,
    label: topic.title,
    description: topic.summary,
    group: "Help",
    icon: <CircleHelp className="size-4" aria-hidden="true" />,
    keywords: ["help", "how", "guide"],
    onSelect: () => {
      navigate("/help");
      // wouter drops the hash; set it after the route lands so the page's
      // mount effect scrolls to the topic.
      window.location.hash = topic.id;
    },
  }));
  const actionItems: CommandItem[] = [
    ...(canCreateInvoice
      ? [
          {
            id: "sme-action-create-invoice",
            label: "Create invoice",
            description: "Start a new invoice draft.",
            group: "Actions",
            icon: <FilePlus className="size-4" aria-hidden="true" />,
            keywords: ["new", "invoice", "draft"],
            shortcut: "N",
            onSelect: () => navigate("/invoices/new"),
          },
        ]
      : []),
    ...(capabilities.has("clerk.capture") && features.has("clerk_ai")
      ? [
          {
            id: "sme-action-send-clerk",
            label: "Send document to Clerk",
            description: "Start a Clerk invoice or notice submission.",
            group: "Actions",
            icon: <Sparkles className="size-4" aria-hidden="true" />,
            keywords: ["capture", "upload", "invoice", "notice"],
            onSelect: () => navigate("/clerk"),
          },
        ]
      : []),
  ];
  const commandItems: CommandItem[] = [
    ...pinnedInvoiceCommands,
    ...recentInvoices,
    ...actionItems,
    ...groups.flatMap((group) =>
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
    ),
    ...helpItems,
    {
      id: "sme-command-shortcuts",
      label: "Keyboard shortcuts",
      description: "Work faster without the mouse.",
      group: "Help",
      icon: <Keyboard className="size-4" aria-hidden="true" />,
      keywords: ["keyboard", "shortcuts", "hotkeys"],
      shortcut: "?",
      onSelect: () => setShortcutsOpen(true),
    },
  ];
  const navProps = {
    groups,
    location,
    me,
    roleContext,
    onSignOut: signOut,
    signingOut: logout.isPending,
  };

  return (
    <div className="min-h-screen bg-[var(--mi-canvas)] md:grid md:grid-cols-[17rem_minmax(0,1fr)]">
      <CommandMenu
        items={commandItems}
        open={commandOpen}
        onOpenChange={setCommandOpen}
        title="Find work"
        placeholder="Search invoices, compliance and Clerk tools"
      />
      <ShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
        shortcuts={shortcutRows}
      />
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-[var(--mi-gold-bright)] focus:px-4 focus:py-2 focus:text-sm focus:font-bold focus:text-[var(--mi-ink)]"
      >
        Skip to content
      </a>

      <div className="mi-mobilebar">
        <BrandMark />
        <div className="mi-mobilebar__actions">
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
              className="w-[17rem] border-r-0 bg-[var(--mi-sidebar)] p-0 text-white [&>button]:text-white"
            >
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <NavLinks {...navProps} onNavigate={() => setSheetOpen(false)} />
            </SheetContent>
          </Sheet>
        </div>
      </div>
      <div className="mi-mobilebar__context">
        <p>{workspaceName}</p>
        <p>{pageTitle}</p>
      </div>

      <aside className="sticky top-0 hidden h-screen min-h-screen flex-col md:flex">
        <NavLinks {...navProps} />
      </aside>

      <div className="min-w-0">
        <header className="mi-topbar">
          <div className="mi-topbar__lead">
            <WorkspaceChip name={workspaceName} />
            <span className="mi-topbar__role" data-testid="text-role-context">
              {roleContext.badge}
            </span>
          </div>
          <div className="mi-topbar__actions">
            <button
              type="button"
              className="mi-topbar__action"
              onClick={() => setCommandOpen(true)}
              data-testid="button-command-menu"
            >
              <Search aria-hidden="true" />
              <span>Search</span>
              <kbd>Ctrl K</kbd>
            </button>
            <Link
              href="/help"
              className="mi-topbar__action"
              data-testid="link-help-header"
            >
              <CircleHelp aria-hidden="true" />
              <span>Help</span>
            </Link>
            <NotificationBell />
            <span className="mi-topbar__divider" aria-hidden="true" />
            <ReleaseBadge tag={me?.releaseTag} />
            <AccountMenu
              me={me}
              roleContext={roleContext}
              onOpenShortcuts={() => setShortcutsOpen(true)}
              onSignOut={signOut}
              signingOut={logout.isPending}
            />
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
      {capabilities.has("clerk.ask") && features.has("clerk_ai") && (
        <ClerkDock />
      )}
    </div>
  );
}
