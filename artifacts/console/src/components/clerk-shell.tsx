import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import {
  Activity,
  ArrowLeft,
  FileStack,
  ListChecks,
  MessageCircleQuestion,
  Sparkles,
} from "lucide-react";
import { StaleBuildBanner } from "@/components/stale-build-banner";

// The Clerk product shell: Clerk pages render full-bleed inside this dark rail
// instead of the standard console Layout, so the AI workspace reads as its own
// focused surface (matching the product design). The rail is deliberately
// dark-on-teal in BOTH color schemes; content inherits the app theme.

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400 focus-visible:ring-offset-2 focus-visible:ring-offset-teal-950";

const NAV = [
  { href: "/clerk", label: "Intake queue", icon: ListChecks },
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
          : "flex flex-row gap-1 overflow-x-auto"
      }
    >
      {NAV.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          aria-current={isActive(href) ? "page" : undefined}
          data-testid={`clerk-nav-${label.toLowerCase().replace(/\s+/g, "-")}`}
          className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors ${FOCUS_RING} ${
            isActive(href)
              ? "bg-white/10 text-white"
              : "text-teal-100/80 hover:bg-white/5 hover:text-white"
          }`}
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
    <div className="flex items-center gap-2.5 px-3">
      <Sparkles className="h-6 w-6 text-lime-300" aria-hidden="true" />
      <span className="text-xl font-bold text-white leading-none">Clerk</span>
    </div>
  );
}

export function ClerkShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background flex flex-col md:flex-row">
      <a
        href="#clerk-main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
      >
        Skip to content
      </a>

      {/* Mobile: compact top bar with horizontal nav. */}
      <div className="md:hidden bg-teal-950 px-3 py-3 space-y-3">
        <Brand />
        <NavLinks orientation="row" />
      </div>

      {/* Desktop rail. */}
      <aside className="hidden md:flex w-60 shrink-0 flex-col bg-teal-950 p-4 sticky top-0 max-h-screen min-h-screen">
        <div className="py-2">
          <Brand />
        </div>
        <div className="mt-6 flex-1 min-h-0 overflow-y-auto">
          <NavLinks orientation="column" />
        </div>
        <div className="mt-auto pt-4 border-t border-white/10 space-y-3">
          {/* The product's standing rule, stated where the operator works. */}
          <p className="px-3 text-[13px] leading-snug text-teal-100/70">
            Human review is required before a case changes a record.
          </p>
          <Link
            href="/"
            className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-teal-100/80 hover:bg-white/5 hover:text-white transition-colors ${FOCUS_RING}`}
            data-testid="clerk-back-to-console"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back to console
          </Link>
        </div>
      </aside>

      <main
        id="clerk-main"
        tabIndex={-1}
        className="flex-1 p-4 md:p-8 overflow-y-auto max-w-6xl mx-auto w-full focus:outline-none"
      >
        <StaleBuildBanner />
        {children}
      </main>
    </div>
  );
}

/**
 * The shared page header: tracked teal eyebrow over the title, with an
 * optional right-hand slot (the Guardrails pill on the intake page).
 */
export function ClerkPageHeader({
  eyebrow,
  title,
  description,
  right,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 flex-wrap">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">
          {eyebrow}
        </p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">{title}</h1>
        {description ? (
          <p className="mt-1.5 text-sm text-muted-foreground max-w-xl">
            {description}
          </p>
        ) : null}
      </div>
      {right}
    </div>
  );
}
