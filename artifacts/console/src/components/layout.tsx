import { ValoMark } from "@workspace/web-ui";
import { Compass } from "lucide-react";
import { customFetch } from "@workspace/api-client-react";
import {
  signOutAndRedirect,
  SessionOperationRecovery,
  useOperationNavigation,
} from "@workspace/web-ui";
import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
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
  BookMarked,
  Bot,
  UserPlus,
  UserCheck,
  ChevronDown,
  CircleUserRound,
  KeyRound,
  Inbox,
  CalendarCheck2,
  CircleHelp,
  Keyboard,
  WalletCards,
  BarChart3,
  Search,
  Pin,
  Landmark,
} from "lucide-react";
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
import { Button } from "@/components/ui/button";
import type { Me } from "@workspace/api-client-react";
import { searchWorkspace, useGetMe, logout } from "@workspace/api-client-react";
import { NotificationBell } from "@/components/notification-bell";
import { roleLabel } from "@/components/capability-gate";
import { PORTAL_URL } from "@/components/require-session";
import { StaleBuildBanner } from "@/components/stale-build-banner";
import { ClerkDock } from "@/components/clerk-dock";
import {
  CommandMenu,
  NavigationSection,
  NetworkStatus,
  readRecentItems,
  ReleaseBadge,
  ShortcutsDialog,
  type ShortcutRow,
  usePinnedItems,
  useGlobalShortcuts,
  WorkspaceChip,
  type CommandItem,
  trackUsabilityEvent,
} from "@workspace/web-ui";
import { HELP_TOPICS } from "@/pages/help";

// Every console page maps to the RBAC capability its API surface requires
// (modules/auth/rbac.ts). The nav renders only what the signed-in principal
// can actually use — an operator sees the Compliance Desk tools, a firm admin
// sees the practice-management pages, firm staff a subset. Groups render only
// when they contain at least one capability-visible link.
type NavLink = {
  href: string;
  label: string;
  icon: typeof Users;
  /** RBAC capability the page's API surface requires. */
  capability?: string;
  /**
   * Exact-role requirement for the few surfaces the server gates on a role
   * rather than a capability (routes/integrations.ts firmAdminScope). A link
   * carrying `role` renders only for that role.
   */
  role?: string;
  /** Roles that must not see a role-irrelevant generic surface. */
  excludeRoles?: string[];
  /**
   * Launch-profile gate (PL-02, client half): the platform feature flag the
   * page's API surface rides (requireFlag on the route). Absent from
   * Me.features means the API answers 404, so the link is hidden rather than
   * navigating into a dead page.
   */
  feature?: string;
};

type NavGroup = { title: string; links: NavLink[] };

const NAV_GROUPS: NavGroup[] = [
  {
    title: "Bank assurance",
    links: [
      {
        href: "/data-room",
        label: "Credit Data Room",
        icon: Landmark,
        capability: "credit.data_room.read",
        feature: "bank_data_room",
      },
    ],
  },
  {
    title: "Daily work",
    links: [
      {
        href: "/today",
        label: "Today",
        icon: Compass,
        capability: "console.portfolio.read",
      },
      {
        href: "/portfolio",
        label: "Portfolio",
        icon: Users,
        capability: "console.portfolio.read",
      },
      {
        href: "/work",
        label: "Team work",
        icon: ListChecks,
        capability: "work.read",
      },
      {
        href: "/pipeline",
        label: "Onboarding",
        icon: GitBranch,
        capability: "console.portfolio.read",
      },
    ],
  },
  {
    title: "Client services and setup",
    links: [
      {
        href: "/clients/import",
        label: "Client import",
        icon: Upload,
        capability: "clients.import",
        feature: "white_label",
      },
      {
        href: "/advisory",
        label: "Advisory",
        icon: ClipboardCheck,
        capability: "engagement.write",
      },
      {
        href: "/filing-desk",
        label: "Filing desk",
        icon: CalendarCheck2,
        capability: "filing.read",
        feature: "statutory_desks",
      },
      {
        href: "/collections",
        label: "Collections",
        icon: WalletCards,
        capability: "console.portfolio.read",
        feature: "collection_accounts",
      },
      {
        href: "/analytics",
        label: "Analytics",
        icon: BarChart3,
        capability: "console.portfolio.read",
      },
      {
        href: "/invitations",
        label: "Invitations",
        icon: UserPlus,
        capability: "invitation.write",
      },
      {
        href: "/access-review",
        label: "Access review",
        icon: UserCheck,
        capability: "access.review",
      },
      {
        href: "/integrations",
        label: "Integrations",
        icon: Plug,
        capability: "connector.read",
      },
      {
        href: "/api-access",
        label: "API & webhooks",
        icon: KeyRound,
        role: "firm_admin",
      },
      {
        href: "/notifications",
        label: "Notifications",
        icon: Inbox,
        excludeRoles: ["bank_user"],
      },
      {
        href: "/activity",
        label: "Activity",
        icon: Activity,
        excludeRoles: ["bank_user"],
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
        feature: "white_label",
      },
      {
        href: "/certification",
        label: "Certification",
        icon: GraduationCap,
        capability: "certification.read",
        feature: "white_label",
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
      // The Control centre stays in the operator nav (architecture.md design
      // direction): activation evidence is operator work, not a hidden admin
      // page.
      {
        href: "/control-centre",
        label: "Control centre",
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
        feature: "clerk_ai",
      },
      {
        href: "/clerk",
        label: "Clerk",
        icon: Bot,
        capability: "clerk.use",
        feature: "clerk_ai",
      },
    ],
  },
];

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

type RoleContext = { title: string; description: string; badge: string };

const ROLE_CONTEXT: Record<string, RoleContext> = {
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
    badge: "Read-only auditor",
  },
  bank_user: {
    title: "Bank Data Room",
    description: "Anonymized credit-readiness evidence",
    badge: "Bank reviewer",
  },
};

function accountInitials(
  name: string | null | undefined,
  email: string | null | undefined,
) {
  const source = name?.trim() || email?.split("@")[0] || "V";
  const parts = source.split(/\s+/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function BrandMark({
  onNavigate,
  caption = "Accountant Console",
}: {
  onNavigate?: () => void;
  caption?: string;
}) {
  return (
    <Link
      href="/"
      onClick={onNavigate}
      className="mi-brand"
      aria-label="Valo — go to the console home"
    >
      <span className="mi-brand__mark">
        <ValoMark aria-hidden="true" />
      </span>
      <span>
        <span className="mi-brand__name">Valo</span>
        <span className="mi-brand__caption">{caption}</span>
      </span>
    </Link>
  );
}

function isLinkActive(location: string, href: string) {
  if (location === href) return true;
  // The Claims register (/clerk/claims) is its own entry — don't also light
  // up the Clerk entry when we're on it.
  if (href === "/clerk" && location.startsWith("/clerk/claims")) return false;
  // Prefix matches stop at a path boundary ("/clerkX" never matches "/clerk").
  if (href !== "/" && location.startsWith(`${href}/`)) return true;
  // Client detail pages live under the Portfolio entry (import is its own).
  if (
    href === "/portfolio" &&
    location.startsWith("/clients/") &&
    !location.startsWith("/clients/import")
  )
    return true;
  return false;
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
  return (
    <nav className="mi-sidebar" aria-label="Console">
      <BrandMark
        onNavigate={onNavigate}
        caption={
          me?.role === "bank_user" ? "Bank Data Room" : "Accountant Console"
        }
      />
      <div className="mi-nav">
        <div className="mi-nav__scroll">
          {groups.map((group) => (
            <NavigationSection
              key={group.title}
              title={group.title}
              primary={
                group.title === "Daily work" || group.title === "Bank assurance"
              }
              active={group.links.some((link) =>
                isLinkActive(location, link.href),
              )}
              route={location}
            >
              {group.links.map((link) => {
                const Icon = link.icon;
                const isActive = isLinkActive(location, link.href);
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    onClick={onNavigate}
                    data-testid={`nav-${link.label.toLowerCase().replace(/\s+/g, "-")}`}
                    className="mi-nav__link"
                    aria-current={isActive ? "page" : undefined}
                  >
                    <Icon aria-hidden="true" />
                    <span title={link.label}>{link.label}</span>
                  </Link>
                );
              })}
            </NavigationSection>
          ))}
        </div>
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
        <a
          href={PORTAL_URL}
          className="mi-nav__link"
          data-testid="link-all-apps"
        >
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
            <a href={PORTAL_URL} className="mi-account-menu__item">
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
  const [signingOut, setSigningOut] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const openOperation = useOperationNavigation("console", navigate);

  // Move keyboard/SR focus to the main region on every route change so a
  // single-page navigation announces the new page instead of stranding focus
  // on the link that was just activated.
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    mainRef.current?.focus({ preventScroll: true });
  }, [location]);

  const signOut = async () => {
    setSigningOut(true);
    await signOutAndRedirect((signal) => logout({ signal }));
  };

  const capabilities = new Set(me?.capabilities ?? []);
  const features = new Set(me?.features ?? []);
  // Single-key accelerators (the "?" sheet lists them; useGlobalShortcuts
  // skips typing contexts and open dialogs). The console's frequent action
  // is finding a client, and Ctrl+K + recents already owns that — so "/"
  // is a lighter alias, not a new surface.
  useGlobalShortcuts([
    { key: "/", run: () => setCommandOpen(true) },
    { key: "?", run: () => setShortcutsOpen(true) },
  ]);
  const shortcutRows: ShortcutRow[] = [
    { keys: ["Ctrl", "K"], description: "Go to a workspace, client or tool" },
    { keys: ["/"], description: "Go to a workspace, client or tool" },
    { keys: ["?"], description: "Show these shortcuts" },
    { keys: ["Esc"], description: "Close a dialog or menu" },
  ];
  const groups = NAV_GROUPS.map((g) => ({
    ...g,
    links: g.links.filter(
      (l) =>
        (l.capability === undefined || capabilities.has(l.capability)) &&
        (l.role === undefined || me?.role === l.role) &&
        (l.excludeRoles === undefined ||
          !l.excludeRoles.includes(me?.role ?? "")) &&
        (l.feature === undefined || features.has(l.feature)),
    ),
  })).filter((g) => g.links.length > 0);
  const roleContext: RoleContext = ROLE_CONTEXT[me?.role ?? ""] ?? {
    title: "Accountant Console",
    description: "Role-scoped workspace",
    badge: me ? roleLabel(me.role) : "Loading",
  };
  // The workspace chip names the firm this session belongs to; platform
  // principals (operator, auditor) have no firm, so the role title stands in.
  const workspaceName = me?.workspaceName ?? roleContext.title;
  const bankWorkspace = me?.role === "bank_user";

  const activeLink = groups
    .flatMap((group) => group.links)
    .sort((a, b) => b.href.length - a.href.length)
    .find((link) => isLinkActive(location, link.href));
  const pageTitle =
    activeLink?.label ??
    (isLinkActive(location, "/help") ? "Help" : roleContext.title);
  const pinnedClients = usePinnedItems(
    me ? `meridianiq:pinned-clients:${me.userId}` : null,
  );
  const pinnedClientCommands: CommandItem[] = pinnedClients.items.map(
    (item) => ({
      id: `console-command-pinned-${item.id}`,
      label: item.label,
      description: item.detail ?? "Open this pinned client.",
      group: "Pinned clients",
      icon: <Pin className="size-4" aria-hidden="true" />,
      keywords: ["pinned", "client"],
      onSelect: () => navigate(`/clients/${item.id}`),
    }),
  );
  // Recently opened clients lead the menu (recognition over recall): the
  // client you were just working on beats re-finding them in the book.
  const recentClients: CommandItem[] = (
    me ? readRecentItems(`meridianiq:recent-clients:${me.userId}`) : []
  ).map((item) => ({
    id: `console-command-recent-${item.id}`,
    label: item.label,
    description: item.detail ?? "Open this recent client.",
    group: "Recent clients",
    icon: <Users className="size-4" aria-hidden="true" />,
    keywords: ["recent", "client"],
    onSelect: () => navigate(`/clients/${item.id}`),
  }));
  const helpItems: CommandItem[] = HELP_TOPICS.map((topic) => ({
    id: `console-command-help-${topic.id}`,
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
    ...(capabilities.has("engagement.write")
      ? [
          {
            id: "console-action-add-client",
            label: "Add client",
            description: "Open the client intake form.",
            group: "Actions",
            icon: <Users className="size-4" aria-hidden="true" />,
            keywords: ["new", "client", "intake"],
            onSelect: () => navigate("/portfolio?action=add-client"),
          },
        ]
      : []),
    ...(capabilities.has("invitation.write")
      ? [
          {
            id: "console-action-create-access",
            label: "Create access link",
            description: "Invite a teammate or client user.",
            group: "Actions",
            icon: <UserPlus className="size-4" aria-hidden="true" />,
            keywords: ["invite", "access", "client", "team"],
            onSelect: () => navigate("/invitations"),
          },
        ]
      : []),
  ];
  const commandItems: CommandItem[] = [
    ...pinnedClientCommands,
    ...recentClients,
    ...actionItems,
    ...groups.flatMap((group) =>
      group.links.map((link) => {
        const Icon = link.icon;
        return {
          id: `console-command-${link.label.toLowerCase().replace(/\s+/g, "-")}`,
          label: link.label,
          description: `Open ${link.label.toLowerCase()} in the ${roleContext.title.toLowerCase()}.`,
          group: group.title,
          icon: <Icon className="size-4" aria-hidden="true" />,
          keywords: [group.title, roleContext.badge],
          onSelect: () => navigate(link.href),
        };
      }),
    ),
    {
      id: "console-command-help-centre",
      label: "Help",
      description: "Open the help centre.",
      group: "Help",
      icon: <CircleHelp className="size-4" aria-hidden="true" />,
      keywords: ["help", "guide", "support"],
      onSelect: () => navigate("/help"),
    },
    ...helpItems,
    {
      id: "console-command-shortcuts",
      label: "Keyboard shortcuts",
      description: "Work faster without the mouse.",
      group: "Help",
      icon: <Keyboard className="size-4" aria-hidden="true" />,
      keywords: ["keyboard", "shortcuts", "hotkeys"],
      shortcut: "?",
      onSelect: () => setShortcutsOpen(true),
    },
  ];
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
        id: `console-search-${result.id}`,
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
    groups,
    location,
    me,
    roleContext,
    onSignOut: signOut,
    signingOut: signingOut,
  };

  return (
    <div className="mi-platform min-h-screen overflow-x-clip bg-[var(--mi-canvas)] lg:grid lg:grid-cols-[17rem_minmax(0,1fr)]">
      <CommandMenu
        items={commandItems}
        open={commandOpen}
        onOpenChange={setCommandOpen}
        title="Go to a workspace"
        placeholder="Search pages and tools"
        remoteSearch={bankWorkspace ? undefined : remoteSearch}
      />
      <ShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
        shortcuts={shortcutRows}
      />
      <a
        href="#main-content"
        className={`sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:min-h-11 focus:rounded-md focus:bg-[var(--mi-sidebar-accent)] focus:px-4 focus:py-3 focus:font-bold focus:text-[#262925] ${FOCUS_RING}`}
        data-testid="link-skip-to-content"
      >
        Skip to content
      </a>

      <header className="mi-mobilebar">
        <BrandMark
          caption={bankWorkspace ? "Bank Data Room" : "Accountant Console"}
        />
        <div className="mi-mobilebar__actions">
          {!bankWorkspace && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="text-white hover:bg-white/10 hover:text-white"
                aria-label="Search workspaces"
                onClick={() => setCommandOpen(true)}
              >
                <Search aria-hidden="true" />
              </Button>
              <NotificationBell triggerClassName="text-white hover:bg-white/10 hover:text-white focus-visible:text-white focus-visible:ring-white focus-visible:ring-offset-0" />
            </>
          )}
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
        <p>{workspaceName}</p>
        <p>{pageTitle}</p>
      </section>

      <aside className="sticky top-0 hidden h-screen min-h-screen flex-col lg:flex">
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
            {!bankWorkspace && (
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
            )}
            <Link
              href="/help"
              className="mi-topbar__action"
              data-testid="link-help-header"
            >
              <CircleHelp aria-hidden="true" />
              <span>Help</span>
            </Link>
            {/* Recent-notification inbox — render-on-success, so a server
                without the feed endpoint shows no bell at all. */}
            {!bankWorkspace && (
              <NotificationBell triggerClassName="text-foreground hover:text-foreground focus-visible:text-foreground" />
            )}
            <span className="mi-topbar__divider" aria-hidden="true" />
            <SessionOperationRecovery
              me={me}
              request={customFetch}
              onOpen={openOperation}
            />
            <ReleaseBadge tag={me?.releaseTag} />
            <AccountMenu
              me={me}
              roleContext={roleContext}
              onOpenShortcuts={() => setShortcutsOpen(true)}
              onSignOut={signOut}
              signingOut={signingOut}
            />
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
          <NetworkStatus />
          {children}
        </main>
      </div>
      {capabilities.has("clerk.use") && features.has("clerk_ai") && (
        <ClerkDock />
      )}
    </div>
  );
}
