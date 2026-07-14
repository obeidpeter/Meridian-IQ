import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import {
  useGetMe,
  useLogin,
  useLogout,
  useChangePassword,
  getGetMeQueryKey,
} from "@workspace/api-client-react";
import type { Me } from "@workspace/api-client-react";
import {
  FileCheck2,
  Building2,
  Store,
  Calculator,
  ArrowRight,
  Lock,
  LogOut,
  Loader2,
  ShieldCheck,
  AlertCircle,
  KeyRound,
  CheckCircle2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import LandingPage from "@/LandingPage";
import { AcceptInvite } from "@/AcceptInvite";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err: unknown) => {
        const status = (err as { status?: number })?.status;
        if (status && status >= 400 && status < 500) return false;
        return count < 1;
      },
    },
  },
});

type Role =
  | "firm_admin"
  | "firm_staff"
  | "client_user"
  | "operator"
  | "buyer_user"
  | "auditor";

interface AppTile {
  key: string;
  name: string;
  tagline: string;
  href: string;
  icon: typeof FileCheck2;
  // null = public (no login). Otherwise the roles that can open it.
  allowedRoles: Role[] | null;
  accent: string; // tailwind text color for the icon
}

const APPS: AppTile[] = [
  {
    key: "sme",
    name: "Compliance App",
    tagline:
      "Guided invoicing, submission & vault, reconciliation, B2C clocks and deadline alerts for SMEs.",
    href: "/app/",
    icon: FileCheck2,
    allowedRoles: ["firm_admin", "firm_staff", "client_user"],
    accent: "text-teal-600 dark:text-teal-400",
  },
  {
    key: "console",
    name: "Accountant Console",
    tagline:
      "Multi-client portfolio, onboarding, billing, white-label branding, certification and the operator queue.",
    href: "/console/",
    icon: Building2,
    allowedRoles: ["firm_admin", "firm_staff", "operator", "auditor"],
    accent: "text-indigo-600 dark:text-indigo-400",
  },
  {
    key: "buyer",
    name: "Buyer Rails",
    tagline:
      "Confirm supplier invoices for VAT protection, flag payments, track exposure and score suppliers.",
    href: "/buyer/",
    icon: Store,
    allowedRoles: ["buyer_user"],
    accent: "text-blue-600 dark:text-blue-400",
  },
  {
    key: "calc",
    name: "Penalty Calculator",
    tagline:
      "See what non-compliance costs: fines for not connecting your systems to the tax authority (s.103) and for invoices issued without e-invoicing (s.104), estimated from your turnover. Free, no account needed.",
    href: "/penalty-calculator/",
    icon: Calculator,
    allowedRoles: null,
    accent: "text-amber-600 dark:text-amber-400",
  },
];

// Where each role starts after sign-in. The operator goes straight to the
// Compliance Desk work queue — that is the account's job, not the portfolio.
const DEFAULT_WORKSPACE: Partial<
  Record<Role, { href: string; label: string }>
> = {
  operator: { href: "/console/operator-queue", label: "Operator queue" },
  firm_admin: { href: "/console/", label: "Accountant Console" },
  firm_staff: { href: "/app/", label: "Compliance App" },
  client_user: { href: "/app/", label: "Compliance App" },
  buyer_user: { href: "/buyer/", label: "Buyer Rails" },
  auditor: { href: "/console/audit", label: "Audit & evidence" },
};

const DEMO_ACCOUNTS: { label: string; email: string; opens: string }[] = [
  {
    label: "SME owner (Adaeze Foods)",
    email: "owner@adaezefoods.example",
    opens: "Compliance App — owns the consent decisions",
  },
  {
    label: "SME firm staff (Adaeze Foods)",
    email: "demo.staff@meridianiq.example",
    opens: "Compliance App (with live data)",
  },
  {
    label: "Accountant (firm admin)",
    email: "demo.admin@meridianiq.example",
    opens: "Console + Compliance App",
  },
  {
    label: "Compliance Desk operator",
    email: "ops@meridianiq.example",
    opens: "Console operator queue",
  },
  {
    label: "Buyer finance (Zenith Retail)",
    email: "finance@zenithretail.example",
    opens: "Buyer Rails",
  },
  {
    label: "Read-only auditor",
    email: "audit@meridianiq.example",
    opens: "Audit & evidence (read-only console)",
  },
];
const DEMO_PASSWORD = "meridian2027";

function roleLabel(role: string): string {
  return (
    {
      firm_admin: "Firm admin",
      firm_staff: "Firm staff",
      client_user: "Client user",
      operator: "Operator",
      buyer_user: "Buyer",
      auditor: "Auditor",
    }[role] ?? role
  );
}

// "Firm admin and Firm staff" / "Firm admin, Firm staff and Operator"
function roleListLabel(roles: Role[]): string {
  const names = roles.map(roleLabel);
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// Standard status-pill recipe (design language §8): base + tone.
const PILL_BASE =
  "inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full border";
const PILL_TEAL =
  "bg-teal-100 text-teal-800 border-teal-200 dark:bg-teal-950 dark:text-teal-300 dark:border-teal-900";
const PILL_SLATE =
  "bg-slate-100 text-slate-800 border-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:border-slate-800";

// The generated client throws ApiError carrying the parsed body; the server
// answers { error: string }.
function serverErrorFrom(err: unknown): string | null {
  const data = (err as { data?: unknown })?.data;
  return data && typeof data === "object" && "error" in data
    ? String((data as { error: unknown }).error)
    : null;
}

// Fall back to a friendly generic per failure kind.
function loginErrorMessage(err: unknown): string {
  const status = (err as { status?: number })?.status;
  const serverError = serverErrorFrom(err);
  if (status === 401) {
    return serverError === "Account has no active membership"
      ? "This account exists but has no workspace membership yet. Ask your administrator to add one."
      : "Invalid email or password.";
  }
  if (status !== undefined) {
    return serverError ?? "Sign-in failed. Please try again.";
  }
  return "Could not reach the server. Check your connection and try again.";
}

function AppCard({
  app,
  role,
  isLoading,
  onRequestSignIn,
}: {
  app: AppTile;
  role: Role | null;
  isLoading: boolean;
  onRequestSignIn: () => void;
}) {
  const Icon = app.icon;
  const isPublic = app.allowedRoles === null;
  const canOpen = isPublic || (role !== null && app.allowedRoles!.includes(role));
  const needsOtherRole =
    !isPublic && role !== null && !app.allowedRoles!.includes(role);

  return (
    <Card
      className={`group flex flex-col p-6 shadow-sm transition-shadow hover:shadow-md ${
        role !== null && canOpen
          ? "ring-2 ring-primary/30 border-primary/40"
          : needsOtherRole
            ? "bg-muted/40"
            : ""
      }`}
    >
      <div className="flex items-start justify-between">
        <div className={`rounded-lg bg-muted p-3 ${app.accent}`}>
          <Icon className="h-6 w-6" aria-hidden="true" />
        </div>
        {isLoading ? (
          <span
            className="h-6 w-24 animate-pulse rounded-full bg-muted"
            aria-hidden="true"
          />
        ) : isPublic ? (
          <span className={`${PILL_BASE} ${PILL_SLATE}`}>Free</span>
        ) : canOpen ? (
          <span className={`${PILL_BASE} ${PILL_TEAL}`}>
            <ShieldCheck className="h-3 w-3" aria-hidden="true" /> Available to
            you
          </span>
        ) : (
          <span className={`${PILL_BASE} ${PILL_SLATE}`}>
            <Lock className="h-3 w-3" aria-hidden="true" />{" "}
            {role ? "Not for your role" : "Requires sign-in"}
          </span>
        )}
      </div>
      <h3 className="mt-4 text-lg font-semibold">{app.name}</h3>
      <p className="mt-1 flex-1 text-sm text-muted-foreground">{app.tagline}</p>
      <div className="mt-5">
        {isLoading ? (
          <div
            className="h-9 w-full animate-pulse rounded-md bg-muted"
            aria-hidden="true"
          />
        ) : canOpen ? (
          <Button asChild className="w-full">
            <a href={app.href} data-testid={`link-open-${app.key}`}>
              Open {app.name}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </a>
          </Button>
        ) : needsOtherRole ? (
          <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
            <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            Available to {roleListLabel(app.allowedRoles!)} accounts
          </p>
        ) : (
          <Button
            variant="outline"
            className="w-full"
            onClick={onRequestSignIn}
          >
            Sign in to open
          </Button>
        )}
      </div>
    </Card>
  );
}

function RedirectingPanel({
  target,
}: {
  target: { label: string; href: string };
}) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <Card className="p-6 shadow-sm" data-testid="panel-redirecting">
      <div className="flex items-center gap-2">
        <Loader2
          className="h-5 w-5 animate-spin text-primary"
          aria-hidden="true"
        />
        <h2 className="text-lg font-semibold">Opening {target.label}…</h2>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        You're signed in — taking you to your workspace.
      </p>
      {slow && (
        <p className="mt-3 text-sm text-muted-foreground" role="status">
          Taking longer than expected —{" "}
          <a
            href={target.href}
            className="font-medium text-primary underline underline-offset-4"
          >
            open {target.label} directly
          </a>
          .
        </p>
      )}
    </Card>
  );
}

function SignInPanel() {
  const qc = useQueryClient();
  const login = useLogin();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Which sign-in is running: "form" or a demo account's email. Drives the
  // per-button spinners without disabling the whole panel.
  const [pending, setPending] = useState<string | null>(null);
  const [redirecting, setRedirecting] = useState<{
    label: string;
    href: string;
  } | null>(null);

  const signIn = async (source: string, creds: { email: string; password: string }) => {
    setError(null);
    setPending(source);
    try {
      const me = await login.mutateAsync({ data: creds });
      await qc.invalidateQueries({ queryKey: getGetMeQueryKey() });
      const target = DEFAULT_WORKSPACE[me.role as Role];
      if (target) {
        // Land the account in the workspace it signed in for (the operator's
        // queue, the buyer's rails…). A full navigation, so the app boots
        // against the fresh session cookie.
        setRedirecting(target);
        window.location.assign(target.href);
        return; // keep the "opening…" state until the browser navigates
      }
      setPending(null);
    } catch (err) {
      setError(loginErrorMessage(err));
      setPending(null);
      document.getElementById("email")?.focus();
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void signIn("form", { email, password });
  };

  if (redirecting) {
    return <RedirectingPanel target={redirecting} />;
  }

  return (
    <Card className="p-6 shadow-sm">
      <h2 className="text-lg font-semibold">Sign in</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        One sign-in opens every workspace you have access to.
      </p>
      <form onSubmit={onSubmit} className="mt-4 space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="username"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@firm.example"
            required
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "login-error" : undefined}
            data-testid="input-email"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            required
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "login-error" : undefined}
            data-testid="input-password"
          />
        </div>
        {error && (
          <p
            role="alert"
            id="login-error"
            className="flex items-start gap-1.5 text-sm text-destructive"
            data-testid="text-login-error"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{" "}
            {error}
          </p>
        )}
        <Button
          type="submit"
          className="w-full"
          disabled={pending !== null}
          data-testid="button-sign-in"
        >
          {pending === "form" && (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          )}
          Sign in
        </Button>
      </form>

      <div className="mt-5 rounded-lg bg-muted/60 p-3">
        <p className="text-xs font-medium text-muted-foreground">
          Demo accounts — one click signs you in (password{" "}
          <code className="rounded bg-background px-1 py-0.5">{DEMO_PASSWORD}</code>
          )
        </p>
        <ul className="mt-2 space-y-2">
          {DEMO_ACCOUNTS.map((a) => (
            <li key={a.email}>
              <button
                type="button"
                disabled={pending !== null}
                onClick={() => {
                  setEmail(a.email);
                  setPassword(DEMO_PASSWORD);
                  void signIn(a.email, {
                    email: a.email,
                    password: DEMO_PASSWORD,
                  });
                }}
                className="flex min-h-11 w-full flex-col items-start justify-center gap-0.5 rounded-md border bg-card px-3 py-2 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
                data-testid={`button-demo-${a.email.split("@")[0]}`}
              >
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  {pending === a.email && (
                    <Loader2
                      className="h-3.5 w-3.5 animate-spin text-primary"
                      aria-hidden="true"
                    />
                  )}
                  {a.label}
                </span>
                <span className="text-xs text-muted-foreground">
                  Opens {a.opens}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

function ChangePasswordForm() {
  const changePassword = useChangePassword();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<{
    message: string;
    field: "current" | "new" | null;
  } | null>(null);
  const [done, setDone] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCloseTimer = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  // Never let the auto-close timer fire after unmount (sign-out mid-toast).
  useEffect(() => clearCloseTimer, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await changePassword.mutateAsync({
        data: { currentPassword: current, newPassword: next },
      });
      setDone(true);
      setCurrent("");
      setNext("");
      clearCloseTimer();
      closeTimer.current = setTimeout(() => {
        setDone(false);
        setOpen(false);
      }, 2500);
    } catch (err) {
      const status = (err as { status?: number })?.status;
      const serverError = serverErrorFrom(err);
      if (status === 401) {
        setError({ message: "Current password is incorrect.", field: "current" });
        document.getElementById("cp-current")?.focus();
      } else if (status === 400) {
        setError({
          message: serverError ?? "New password must be at least 8 characters.",
          field: "new",
        });
        document.getElementById("cp-new")?.focus();
      } else {
        setError({
          message: "Could not change the password. Try again.",
          field: null,
        });
      }
    }
  };

  if (!open) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => {
          clearCloseTimer();
          setDone(false);
          setOpen(true);
        }}
        className="mt-2 -ml-2 text-muted-foreground hover:text-foreground"
        data-testid="button-show-change-password"
      >
        <KeyRound className="h-3.5 w-3.5" aria-hidden="true" /> Change password
      </Button>
    );
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-3 rounded-lg border p-3">
      <p className="text-xs font-medium">Change password</p>
      <div className="space-y-1.5">
        <Label htmlFor="cp-current" className="text-xs">
          Current password
        </Label>
        <Input
          id="cp-current"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
          aria-invalid={error?.field === "current" ? true : undefined}
          aria-describedby={
            error && error.field !== "new" ? "cp-error" : undefined
          }
          data-testid="input-current-password"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="cp-new" className="text-xs">
          New password
        </Label>
        <Input
          id="cp-new"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          required
          minLength={8}
          aria-invalid={error?.field === "new" ? true : undefined}
          aria-describedby={
            error?.field === "new" ? "cp-new-help cp-error" : "cp-new-help"
          }
          data-testid="input-new-password"
        />
        <p id="cp-new-help" className="text-xs text-muted-foreground">
          At least 8 characters
        </p>
      </div>
      {error && (
        <p
          role="alert"
          id="cp-error"
          className="flex items-start gap-1.5 text-xs text-destructive"
        >
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{" "}
          {error.message}
        </p>
      )}
      {done && (
        <p
          role="status"
          className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400"
          data-testid="text-password-changed"
        >
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> Password
          changed.
        </p>
      )}
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={changePassword.isPending || !current || next.length < 8}
          data-testid="button-change-password"
        >
          {changePassword.isPending ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            clearCloseTimer();
            setOpen(false);
            setError(null);
            setDone(false);
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function SignedInPanel({ me }: { me: Me }) {
  const qc = useQueryClient();
  const logout = useLogout();
  const [signingOut, setSigningOut] = useState(false);
  const role = me.role as Role;
  const target = DEFAULT_WORKSPACE[role];

  const signOut = async () => {
    setSigningOut(true);
    try {
      await logout.mutateAsync();
    } catch {
      /* best effort — the cookie may already be gone */
    }
    // Reset (not just invalidate) every cached query: data from the previous
    // account is dropped immediately and active queries — /me here — refetch,
    // flipping the panel back to the sign-in form.
    await qc.resetQueries();
    setSigningOut(false);
  };

  return (
    <Card className="p-6 shadow-sm" data-testid="panel-signed-in">
      <div className="flex items-center gap-2">
        <ShieldCheck
          className="h-5 w-5 text-teal-600 dark:text-teal-400"
          aria-hidden="true"
        />
        <h2 className="text-lg font-semibold">Signed in</h2>
      </div>
      <div className="mt-3 rounded-lg bg-muted/60 p-3">
        <p className="text-sm font-medium" data-testid="text-account-name">
          {me.fullName ?? me.email ?? "Your account"}
        </p>
        <p className="text-xs text-muted-foreground" data-testid="text-account-detail">
          {me.email ? `${me.email} · ` : ""}
          {roleLabel(me.role)}
        </p>
        <ChangePasswordForm />
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        Open a workspace highlighted below, or switch accounts.
      </p>
      <div className="mt-4 space-y-2">
        {target && (
          <Button asChild className="w-full">
            <a href={target.href} data-testid="link-default-workspace">
              Open {target.label}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </a>
          </Button>
        )}
        <Button
          variant="secondary"
          className="w-full"
          onClick={signOut}
          disabled={signingOut}
          data-testid="button-sign-out"
        >
          {signingOut ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <LogOut className="h-4 w-4" aria-hidden="true" />
          )}
          Sign out
        </Button>
      </div>
    </Card>
  );
}

// Session-check placeholder shaped like the sign-in panel it replaces, so the
// layout barely shifts when /me resolves.
function SessionSkeleton() {
  return (
    <Card className="min-h-[34rem] p-6 shadow-sm" role="status">
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
        <div className="h-56 w-full rounded-lg bg-muted/60" />
      </div>
    </Card>
  );
}

function focusEmailField() {
  const el = document.getElementById("email");
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.focus({ preventScroll: true });
}

function Portal() {
  const {
    data: me,
    isLoading,
    isError,
    error,
    refetch,
  } = useGetMe({
    query: { queryKey: getGetMeQueryKey(), retry: false },
  });
  const role = (me?.role as Role | undefined) ?? null;
  // A 401 just means "not signed in"; anything else is an outage worth surfacing.
  const meStatus = (error as { status?: number } | null)?.status;
  const isOutage = isError && meStatus !== 401;

  // Signed in: float the tiles this account can open to the front.
  const tiles =
    role === null
      ? APPS
      : [...APPS].sort((a, b) => {
          const opens = (t: AppTile) =>
            t.allowedRoles === null || t.allowedRoles.includes(role) ? 0 : 1;
          return opens(a) - opens(b);
        });

  return (
    <div className="min-h-screen bg-gradient-to-b from-muted/40 to-background">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        Skip to content
      </a>
      <header className="border-b bg-card/70 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <a
            href="/"
            className="flex items-center gap-2.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            aria-label="MeridianIQ home"
          >
            <div className="rounded-lg bg-primary p-1.5 text-primary-foreground">
              <FileCheck2 className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <p className="text-base font-bold leading-none">MeridianIQ</p>
              <p className="text-xs text-muted-foreground">
                Compliance & verified receivables
              </p>
            </div>
          </a>
          {me ? (
            <span
              className="max-w-[50%] truncate rounded-full border bg-background px-3 py-1 text-xs font-medium text-muted-foreground"
              data-testid="badge-session"
            >
              {me.fullName ?? me.email ?? roleLabel(me.role)} ·{" "}
              {roleLabel(me.role)}
            </span>
          ) : (
            <a
              href="/"
              className="text-sm font-medium text-muted-foreground hover:text-foreground"
              data-testid="link-back-to-website"
            >
              Back to website
            </a>
          )}
        </div>
      </header>

      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto max-w-6xl px-4 py-10 focus:outline-none sm:px-6 sm:py-14"
      >
        <section className="max-w-3xl">
          <h1 className="text-3xl font-extrabold sm:text-4xl">
            Nigerian e-invoicing, handled.
          </h1>
          <p className="mt-3 text-base text-muted-foreground sm:text-lg">
            MeridianIQ keeps your invoices stamped, filed and audit-ready — and
            quietly turns that compliance into verified receivables you can
            finance. Sign in to open your workspace, or check your penalty
            exposure for free.
          </p>
        </section>

        <div className="mt-10 grid gap-8 lg:grid-cols-[1fr_20rem]">
          {/* Sign-in first in DOM: on a phone it sits right under the hero,
              and the h2 "Sign in" precedes the tile h3s. */}
          <aside className="mx-auto w-full max-w-md space-y-5 lg:order-last lg:max-w-none">
            {isOutage && (
              <div
                role="alert"
                className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-900 dark:bg-amber-950/40"
              >
                <span className="flex items-start gap-1.5 text-sm text-amber-900 dark:text-amber-200">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  Can't reach MeridianIQ.
                </span>
                <Button size="sm" variant="outline" onClick={() => void refetch()}>
                  Retry
                </Button>
              </div>
            )}
            {isLoading ? (
              <SessionSkeleton />
            ) : me ? (
              <SignedInPanel me={me} />
            ) : (
              <SignInPanel />
            )}
          </aside>

          <section aria-labelledby="workspaces-heading" className="lg:order-first">
            <h2 id="workspaces-heading" className="sr-only">
              Workspaces
            </h2>
            <div className="grid gap-5 sm:grid-cols-2">
              {tiles.map((app) => (
                <AppCard
                  key={app.key}
                  app={app}
                  role={role}
                  isLoading={isLoading}
                  onRequestSignIn={focusEmailField}
                />
              ))}
            </div>
          </section>
        </div>

        <footer className="mt-14 flex flex-wrap items-center justify-between gap-4 border-t pt-6 text-xs text-muted-foreground">
          <p>
            MeridianIQ — Lagos, Nigeria. The Penalty Calculator is public;
            every other workspace is protected by sign-in and role.
          </p>
          <nav className="flex items-center gap-4" aria-label="Footer">
            <a
              href="/penalty-calculator/"
              className="font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
              data-testid="link-footer-calculator"
            >
              Penalty calculator
            </a>
            <button
              type="button"
              onClick={focusEmailField}
              className="font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
              data-testid="button-footer-sign-in"
            >
              Sign in
            </button>
          </nav>
        </footer>
      </main>
    </div>
  );
}

export default function App() {
  const pathname = window.location.pathname.replace(/\/+$/, "") || "/";

  if (pathname === "/accept-invite") {
    return (
      <QueryClientProvider client={queryClient}>
        <AcceptInvite />
      </QueryClientProvider>
    );
  }

  if (pathname !== "/login") {
    return <LandingPage />;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <Portal />
    </QueryClientProvider>
  );
}
