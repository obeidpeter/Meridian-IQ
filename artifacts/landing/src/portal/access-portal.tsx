import type { ReactNode } from "react";
import { ValoMark } from "@workspace/web-ui";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Headphones,
  Landmark,
  ReceiptText,
  ScanLine,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

// Session-check placeholder shaped like the sign-in panel it replaces, so the
// layout barely shifts when /me resolves.
export function SessionSkeleton() {
  return (
    <Card className="auth-session-skeleton" role="status">
      <span className="sr-only">Checking your session…</span>
      <div className="animate-pulse space-y-4" aria-hidden="true">
        <div className="h-6 w-24 rounded-md bg-muted" />
        <div className="h-4 w-full rounded-md bg-muted" />
        <div className="space-y-2">
          <div className="h-4 w-16 rounded-md bg-muted" />
          <div className="h-9 w-full rounded-md bg-muted" />
        </div>
        <div className="space-y-2">
          <div className="h-4 w-20 rounded-md bg-muted" />
          <div className="h-9 w-full rounded-md bg-muted" />
        </div>
        <div className="h-9 w-full rounded-md bg-muted" />
      </div>
    </Card>
  );
}

const ACCESS_PATHS = [
  {
    title: "Business owners",
    detail: "Create invoices, submit and get paid",
    icon: ReceiptText,
  },
  {
    title: "Accounting firms",
    detail: "Manage every client's compliance",
    icon: UsersRound,
  },
  {
    title: "Valo staff",
    detail: "Support, checks and reviews",
    icon: Headphones,
  },
  {
    title: "Bank reviewers",
    detail: "Review protected portfolio cohorts",
    icon: Landmark,
  },
];

function AccessStory() {
  return (
    <aside aria-labelledby="access-story-title" className="auth-story">
      <div className="auth-story-inner">
        <div>
          <p className="auth-eyebrow">One sign-in for everything</p>
          <h2 id="access-story-title" className="auth-story-title">
            One account. The right workspace.
          </h2>
          <p className="auth-intro">
            Everyone works from the same records. Each person sees only what
            their role needs.
          </p>
        </div>

        <ul className="auth-role-list">
          {ACCESS_PATHS.map(({ title, detail, icon: Icon }) => (
            <li key={title} className="auth-role">
              <span className="auth-role-icon">
                <Icon className="size-4" aria-hidden="true" />
              </span>
              <span>
                <span className="auth-role-title">{title}</span>
                <span className="auth-role-detail">{detail}</span>
              </span>
            </li>
          ))}
        </ul>

        <div className="auth-principles">
          <span className="inline-flex items-center gap-2">
            <ShieldCheck className="size-4" aria-hidden="true" />
            Access by role
          </span>
          <span className="inline-flex items-center gap-2">
            <ScanLine className="size-4" aria-hidden="true" />
            AI checked by people
          </span>
          <span className="inline-flex items-center gap-2">
            <CheckCircle2 className="size-4" aria-hidden="true" />
            Proof you can check
          </span>
        </div>
      </div>
    </aside>
  );
}

export function AccessPortal({
  children,
  outage,
  onRetry,
}: {
  children: ReactNode;
  outage: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="valo-auth auth-portal">
      <a
        href="#login-content"
        className="auth-skip-link sr-only focus:not-sr-only"
      >
        Skip to sign in
      </a>
      <header className="auth-header">
        <a href="/" className="auth-brand" aria-label="Valo home">
          <span className="auth-brand-mark">
            <ValoMark className="size-8" aria-hidden="true" />
          </span>
          <span className="auth-brand-name">Valo</span>
        </a>
        <a href="/" className="auth-text-link auth-back-link">
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          Back to website
        </a>
      </header>

      <main
        id="login-content"
        tabIndex={-1}
        className="auth-main focus:outline-none"
      >
        <div className="auth-main-inner">
          {outage && (
            <div
              role="alert"
              className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5"
            >
              <span className="flex items-start gap-2 text-sm font-medium text-amber-900">
                <AlertCircle
                  className="mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
                We can&apos;t reach Valo right now.
              </span>
              <Button size="sm" variant="outline" onClick={onRetry}>
                Retry
              </Button>
            </div>
          )}
          {children}
        </div>
      </main>

      <AccessStory />

      <footer className="auth-footer">
        <span>Lagos, Nigeria</span>
        <span>Sign-in protected. Access by role.</span>
        <a
          className="auth-text-link auth-muted-link"
          href="/penalty-calculator/"
        >
          Penalty calculator
        </a>
      </footer>
    </div>
  );
}
