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

// The Clerk product shell: Clerk pages render full-bleed inside this dark rail
// instead of the standard console Layout, so the AI workspace reads as its own
// focused surface (matching the product design). The rail is deliberately
// dark-on-teal in BOTH color schemes; content inherits the app theme.

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#071a1c]";

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
          : "flex snap-x flex-row gap-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      }
    >
      {NAV.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          aria-current={isActive(href) ? "page" : undefined}
          data-testid={`clerk-nav-${label.toLowerCase().replace(/\s+/g, "-")}`}
          className={`flex min-h-10 snap-start items-center gap-3 whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors ${FOCUS_RING} ${
            isActive(href)
              ? "bg-lime-300 font-bold text-[#071a1c]"
              : "font-medium text-white/68 hover:bg-white/8 hover:text-white"
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
    <div className="flex items-center gap-2.5 px-2">
      <span className="grid size-9 place-items-center rounded-md bg-lime-300 text-[#071a1c]">
        <FileCheck2 className="size-5" aria-hidden="true" />
      </span>
      <span>
        <span className="block text-base font-extrabold leading-none text-white">
          Clerk AI
        </span>
        <span className="mt-1 block text-xs font-semibold text-white/75">
          Governed operations
        </span>
      </span>
    </div>
  );
}

export function ClerkShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[#f3f6f5] md:grid md:grid-cols-[17rem_minmax(0,1fr)]">
      <a
        href="#clerk-main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
      >
        Skip to content
      </a>

      {/* Mobile: compact top bar with horizontal nav. */}
      <div className="bg-[#071a1c] md:hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <Brand />
          <Link
            href="/"
            className={`grid size-9 place-items-center rounded-md border border-white/15 text-white/75 hover:bg-white/8 hover:text-white ${FOCUS_RING}`}
            aria-label="Back to console"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
          </Link>
        </div>
        <div className="border-t border-white/10 px-3 py-2">
          <NavLinks orientation="row" />
        </div>
      </div>

      {/* Desktop rail. */}
      <aside className="sticky top-0 hidden h-screen min-h-screen flex-col bg-[#071a1c] px-3 py-5 md:flex">
        <div>
          <Brand />
          <div className="mt-5 border-l-2 border-lime-300 pl-3">
            <p className="text-xs font-bold text-white">
              AI operations workspace
            </p>
            <p className="mt-1 text-xs leading-4 text-white/75">
              Intake, evidence and governed review
            </p>
          </div>
        </div>
        <div className="mt-7 min-h-0 flex-1 overflow-y-auto">
          <NavLinks orientation="column" />
        </div>
        <div className="mt-auto space-y-2 border-t border-white/10 pt-4">
          <div className="flex items-center gap-2 px-3 py-2 text-xs font-semibold text-lime-200">
            <ShieldCheck className="size-4" aria-hidden="true" />
            Human review on
          </div>
          <Link
            href="/"
            className={`flex min-h-10 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-white/65 transition-colors hover:bg-white/8 hover:text-white ${FOCUS_RING}`}
            data-testid="clerk-back-to-console"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back to console
          </Link>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-20 hidden min-h-16 items-center justify-between border-b border-slate-200 bg-white/95 px-8 backdrop-blur md:flex lg:px-10">
          <div>
            <p className="text-[11px] font-bold text-teal-700">Clerk AI</p>
            <p className="mt-0.5 text-sm font-extrabold text-slate-950">
              Governed operations
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-[11px] font-bold text-emerald-800">
            <ShieldCheck className="size-3.5" aria-hidden="true" />
            Human reviewed
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
 * The shared page header: tracked teal eyebrow over the title, with an
 * optional right-hand slot (the Guardrails pill on the intake page).
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
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <p className="text-xs font-bold text-primary">{eyebrow}</p>
        <h1
          className="mt-1 text-2xl font-extrabold md:text-3xl"
          data-testid={titleTestId}
        >
          {title}
        </h1>
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
