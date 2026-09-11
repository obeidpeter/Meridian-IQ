import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import {
  Activity,
  ArrowLeft,
  FileCheck2,
  FileStack,
  ListChecks,
  MessageCircleQuestion,
  PowerOff,
  ShieldCheck,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { StaleBuildBanner } from "@/components/stale-build-banner";

// Clerk keeps its own navigation and identity within the shared platform palette.

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--mi-sidebar-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--mi-sidebar)]";

const NAV = [
  { href: "/clerk", label: "Review queue", icon: ListChecks },
  { href: "/clerk/claims", label: "Claims", icon: FileStack },
  { href: "/clerk/ask", label: "Ask Clerk", icon: MessageCircleQuestion },
  { href: "/clerk/health", label: "Health", icon: Activity },
] as const;

function NavLinks({ orientation }: { orientation: "column" | "row" }) {
  const [location] = useLocation();
  const isActive = (href: string) =>
    href === "/clerk" ? location === "/clerk" : location.startsWith(href);
  return (
    <nav
      aria-label="Clerk"
      className={
        orientation === "column"
          ? "flex flex-col gap-1"
          : "flex snap-x flex-row gap-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      }
    >
      {NAV.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          aria-current={isActive(href) ? "page" : undefined}
          data-testid={
            href === "/clerk"
              ? "clerk-nav-intake-queue"
              : `clerk-nav-${label.toLowerCase().replace(/\s+/g, "-")}`
          }
          className="mi-nav__link snap-start whitespace-nowrap"
          style={
            orientation === "row" ? { width: "auto", flexShrink: 0 } : undefined
          }
        >
          <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
          {label}
        </Link>
      ))}
    </nav>
  );
}

function Brand() {
  return (
    <div className="mi-brand">
      <span className="mi-brand__mark">
        <FileCheck2 className="size-5" aria-hidden="true" />
      </span>
      <span>
        <span className="mi-brand__name block">Clerk AI</span>
        <span className="mi-brand__caption">Suggestions for your review</span>
      </span>
    </div>
  );
}

export function ClerkShell({ children }: { children: ReactNode }) {
  return (
    <div className="mi-platform min-h-screen bg-[var(--mi-canvas)] md:grid md:grid-cols-[17rem_minmax(0,1fr)]">
      <a
        href="#clerk-main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:min-h-11 focus:rounded-md focus:bg-primary focus:px-4 focus:py-3 focus:text-primary-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--mi-teal)]"
      >
        Skip to content
      </a>

      {/* Mobile: compact top bar with horizontal nav. */}
      <header className="bg-[var(--mi-sidebar)] md:hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <Brand />
          <Link
            href="/"
            className={`grid size-11 shrink-0 place-items-center rounded-md text-[var(--mi-sidebar-ink)] hover:bg-[var(--mi-sidebar-active)] hover:text-[var(--mi-sidebar-accent)] ${FOCUS_RING}`}
            aria-label="Back to console"
            title="Back to console"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
          </Link>
        </div>
        <div className="border-t border-[var(--mi-sidebar-line)] px-3 py-2">
          <NavLinks orientation="row" />
        </div>
      </header>

      {/* Desktop rail. */}
      <aside className="sticky top-0 hidden h-screen min-h-screen flex-col bg-[var(--mi-sidebar)] px-3 py-5 md:flex">
        <div>
          <Brand />
          <div className="mt-5 border-l-2 border-[var(--mi-sidebar-accent)] pl-3">
            <p className="text-xs font-semibold text-[var(--mi-sidebar-accent)]">
              Document review
            </p>
            <p className="mt-1 text-xs leading-5 text-[var(--mi-sidebar-ink)]">
              Upload documents, check sources and review suggestions
            </p>
          </div>
        </div>
        <div className="mt-7 min-h-0 flex-1 overflow-y-auto">
          <NavLinks orientation="column" />
        </div>
        <div className="mt-auto space-y-2 border-t border-[var(--mi-sidebar-line)] pt-4">
          <div className="flex items-center gap-2 px-3 py-2 text-xs font-medium text-[var(--mi-sidebar-accent)]">
            <ShieldCheck className="size-4" aria-hidden="true" />
            Human approval required
          </div>
          <Link
            href="/"
            className="mi-nav__link"
            data-testid="clerk-back-to-console"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back to console
          </Link>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-20 hidden min-h-16 flex-wrap items-center justify-between gap-3 border-b border-[var(--mi-line)] bg-[var(--mi-paper)] px-8 py-3 md:flex lg:px-10">
          <div>
            <p className="mi-eyebrow">Clerk AI</p>
            <p className="mt-0.5 text-sm font-semibold text-[var(--mi-ink)]">
              Review and approval
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-md border border-[var(--mi-positive)] bg-[var(--mi-positive-soft)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--mi-positive)]">
            <ShieldCheck className="size-3.5" aria-hidden="true" />
            Approval required
          </span>
        </header>
        <main
          id="clerk-main"
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

/**
 * The kill-switch banner, shared by the Clerk pages: one identity (destructive
 * tone, PowerOff icon, "Clerk is switched off" title, the flag named) so the
 * off state reads the same everywhere. Each page supplies its own consequence
 * sentence as children.
 */
export function ClerkDisabledBanner({ children }: { children: ReactNode }) {
  return (
    <Alert variant="destructive" data-testid="banner-clerk-disabled">
      <PowerOff className="h-4 w-4" aria-hidden="true" />
      <AlertTitle>Clerk is switched off</AlertTitle>
      <AlertDescription>
        The <code>clerk_ai</code> feature flag is disabled. {children}
      </AlertDescription>
    </Alert>
  );
}

/**
 * Clerk's page header follows workspace typography and keeps its optional
 * right-hand slot (the Guardrails pill on the intake page).
 */
export function ClerkPageHeader({
  eyebrow,
  title,
  titleTestId,
  description,
  right,
}: {
  eyebrow: string;
  title: string;
  titleTestId?: string;
  description?: string;
  right?: ReactNode;
}) {
  return (
    <div className="mi-workspace-header flex-wrap">
      <div className="mi-workspace-header__copy">
        <p className="mi-eyebrow">{eyebrow}</p>
        <div className="mi-workspace-header__title-row">
          <h1 data-testid={titleTestId}>{title}</h1>
        </div>
        {description ? (
          <p className="mi-workspace-header__description">{description}</p>
        ) : null}
      </div>
      {right ? (
        <div className="mi-workspace-header__actions">{right}</div>
      ) : null}
    </div>
  );
}
