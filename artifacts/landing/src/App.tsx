import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
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
  useTotpChallenge,
  useGetTotpStatus,
  useSetupTotp,
  useActivateTotp,
  useDisableTotp,
  getGetMeQueryKey,
  getGetTotpStatusQueryKey,
} from "@workspace/api-client-react";
import type { Me } from "@workspace/api-client-react";
import { pillClasses } from "@workspace/format";
import {
  FileCheck2,
  Building2,
  Store,
  Calculator,
  ArrowLeft,
  ArrowRight,
  Lock,
  LogOut,
  Loader2,
  ShieldCheck,
  AlertCircle,
  KeyRound,
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  ShieldOff,
  Headphones,
  Landmark,
  LockKeyhole,
  ReceiptText,
  ScanLine,
  UserRound,
  UsersRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PortalHeader } from "@/components/portal-header";
import { serverErrorFrom } from "@/lib/errors";
import { mfaChallengeDisposition } from "@/lib/mfa";
import {
  TOTP_CARD_INITIAL,
  totpCardTransition,
} from "@/lib/totp-card";
import LandingPage from "@/LandingPage";
import { AcceptInvite } from "@/AcceptInvite";
import { ResetPassword } from "@/ResetPassword";

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

const DEMO_ACCOUNTS: {
  label: string;
  shortLabel: string;
  email: string;
  opens: string;
  icon: typeof FileCheck2;
  tone: string;
}[] = [
  {
    label: "SME owner (Adaeze Foods)",
    shortLabel: "SME owner",
    email: "owner@adaezefoods.example",
    opens: "Compliance App and consent decisions",
    icon: Store,
    tone: "bg-teal-100 text-teal-800",
  },
  {
    label: "SME firm staff (Adaeze Foods)",
    shortLabel: "SME staff",
    email: "demo.staff@meridianiq.example",
    opens: "Daily compliance workflow",
    icon: UserRound,
    tone: "bg-blue-100 text-blue-800",
  },
  {
    label: "Accountant (firm admin)",
    shortLabel: "Firm admin",
    email: "demo.admin@meridianiq.example",
    opens: "Portfolio and firm controls",
    icon: Building2,
    tone: "bg-indigo-100 text-indigo-800",
  },
  {
    label: "Compliance Desk operator",
    shortLabel: "Operator",
    email: "ops@meridianiq.example",
    opens: "Exceptions and Clerk review",
    icon: Headphones,
    tone: "bg-amber-100 text-amber-900",
  },
  {
    label: "Buyer finance (Zenith Retail)",
    shortLabel: "Buyer finance",
    email: "finance@zenithretail.example",
    opens: "Confirmations and exposure",
    icon: Landmark,
    tone: "bg-cyan-100 text-cyan-900",
  },
  {
    label: "Read-only auditor",
    shortLabel: "Auditor",
    email: "audit@meridianiq.example",
    opens: "Read-only audit evidence",
    icon: ShieldCheck,
    tone: "bg-slate-200 text-slate-800",
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
  const canOpen =
    isPublic || (role !== null && app.allowedRoles!.includes(role));
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
          <span className={pillClasses("slate")}>Free</span>
        ) : canOpen ? (
          <span className={pillClasses("teal")}>
            <ShieldCheck className="h-3 w-3" aria-hidden="true" /> Available to
            you
          </span>
        ) : (
          <span className={pillClasses("slate")}>
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
  const totpChallenge = useTotpChallenge();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // TOTP-enrolled account: a correct password earns no session, only a
  // short-lived challenge token. Holding it (with its mint time) keeps the
  // panel on the second step until a code — or "start over" — resolves it.
  const [mfa, setMfa] = useState<{ token: string; issuedAt: number } | null>(
    null,
  );
  const [totpCode, setTotpCode] = useState("");
  const [totpError, setTotpError] = useState<string | null>(null);
  // Which sign-in is running: "form", "totp" or a demo account's email. Drives
  // the per-button spinners without disabling the whole panel.
  const [pending, setPending] = useState<string | null>(null);
  const [redirecting, setRedirecting] = useState<{
    label: string;
    href: string;
  } | null>(null);

  // Shared success tail for both steps: the session cookie is set, so land
  // the account in the workspace it signed in for (the operator's queue, the
  // buyer's rails…). A full navigation, so the app boots against the fresh
  // session cookie.
  const completeSignIn = async (me: Me): Promise<boolean> => {
    await qc.invalidateQueries({ queryKey: getGetMeQueryKey() });
    const target = DEFAULT_WORKSPACE[me.role as Role];
    if (target) {
      setRedirecting(target);
      window.location.assign(target.href);
      return true; // keep the "opening…" state until the browser navigates
    }
    return false;
  };

  const signIn = async (
    source: string,
    creds: { email: string; password: string },
  ) => {
    setError(null);
    setPending(source);
    try {
      const me = await login.mutateAsync({ data: creds });
      if (me.mfaRequired && me.mfaToken) {
        // Password verified, second factor pending: switch to the code step.
        setMfa({ token: me.mfaToken, issuedAt: Date.now() });
        setTotpCode("");
        setTotpError(null);
        setPending(null);
        return;
      }
      if (await completeSignIn(me)) return;
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

  const onVerifyCode = async (e: FormEvent) => {
    e.preventDefault();
    if (!mfa) return;
    setTotpError(null);
    setPending("totp");
    try {
      const me = await totpChallenge.mutateAsync({
        data: { mfaToken: mfa.token, code: totpCode.trim() },
      });
      if (await completeSignIn(me)) return;
      setPending(null);
    } catch (err) {
      setPending(null);
      // The server 401s identically for a wrong code and an expired token;
      // the pure helper splits them on this client's own clock (lib/mfa).
      const disposition = mfaChallengeDisposition({
        status: (err as { status?: number })?.status,
        issuedAt: mfa.issuedAt,
        now: Date.now(),
      });
      if (disposition === "restart") {
        // The 5-minute challenge window lapsed — back to the password step.
        setMfa(null);
        setTotpCode("");
        setPassword("");
        setError(
          "That sign-in attempt expired. Enter your password again to get a new code prompt.",
        );
        return;
      }
      if (disposition === "invalid-code") {
        setTotpError(
          "That code didn't match. Check your authenticator app and try again — or use a recovery code.",
        );
      } else if (disposition === "server-error") {
        setTotpError(
          serverErrorFrom(err) ?? "Verification failed. Please try again.",
        );
      } else {
        setTotpError(
          "Could not reach the server. Check your connection and try again.",
        );
      }
      document.getElementById("totp-code")?.focus();
    }
  };

  const restartSignIn = () => {
    setMfa(null);
    setTotpCode("");
    setTotpError(null);
    setError(null);
    setPassword("");
  };

  if (redirecting) {
    return <RedirectingPanel target={redirecting} />;
  }

  if (mfa) {
    return (
      <div className="w-full" data-testid="panel-totp-challenge">
        <div className="flex items-center gap-2 text-xs font-bold uppercase text-teal-800">
          <span className="grid size-8 place-items-center rounded-md bg-teal-100">
            <ShieldCheck className="size-4" aria-hidden="true" />
          </span>
          Two-step verification
        </div>

        <h1 className="landing-display mt-6 text-4xl font-bold text-slate-950 sm:text-5xl">
          Enter your code
        </h1>
        <p className="mt-3 max-w-md text-base leading-7 text-slate-600">
          <span className="font-semibold text-slate-900">{email}</span> is
          protected by two-factor authentication. Enter the 6-digit code from
          your authenticator app — or one of your saved recovery codes.
        </p>

        <form onSubmit={onVerifyCode} className="mt-8 space-y-5">
          <div className="space-y-2">
            <Label
              htmlFor="totp-code"
              className="text-sm font-bold text-slate-800"
            >
              Authentication code
            </Label>
            <Input
              id="totp-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              placeholder="123456"
              required
              minLength={6}
              maxLength={32}
              aria-invalid={totpError ? true : undefined}
              aria-describedby={totpError ? "totp-error" : "totp-help"}
              className="h-12 border-slate-300 bg-white px-4 font-mono text-lg tracking-[0.25em] shadow-sm"
              data-testid="input-totp-code"
            />
            <p id="totp-help" className="text-xs text-slate-500">
              Codes rotate every 30 seconds. A recovery code works here too.
            </p>
          </div>
          {totpError && (
            <div
              role="alert"
              id="totp-error"
              className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800"
              data-testid="text-totp-error"
            >
              <AlertCircle
                className="mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              <span>{totpError}</span>
            </div>
          )}
          <Button
            type="submit"
            className="min-h-12 w-full bg-[#0b6463] text-base font-bold text-white shadow-sm hover:bg-[#084d4d]"
            disabled={pending !== null || totpCode.trim().length < 6}
            data-testid="button-totp-verify"
          >
            {pending === "totp" && (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            )}
            Verify and continue
            {pending !== "totp" && (
              <ArrowRight className="size-4" aria-hidden="true" />
            )}
          </Button>
        </form>

        <button
          type="button"
          onClick={restartSignIn}
          className="mt-5 inline-flex items-center gap-1.5 rounded-sm text-sm font-bold text-[#0b6463] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700"
          data-testid="button-totp-restart"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Start over with your password
        </button>
      </div>
    );
  }

  return (
    <div className="w-full" data-testid="panel-sign-in">
      <div className="flex items-center gap-2 text-xs font-bold uppercase text-teal-800">
        <span className="grid size-8 place-items-center rounded-md bg-teal-100">
          <LockKeyhole className="size-4" aria-hidden="true" />
        </span>
        Secure workspace access
      </div>

      <h1 className="landing-display mt-6 text-4xl font-bold text-slate-950 sm:text-5xl">
        Welcome back
      </h1>
      <p className="mt-3 max-w-md text-base leading-7 text-slate-600">
        Sign in once. MeridianIQ will take you directly to the workspace for
        your role.
      </p>

      <form onSubmit={onSubmit} className="mt-8 space-y-5">
        <div className="space-y-2">
          <Label htmlFor="email" className="text-sm font-bold text-slate-800">
            Work email
          </Label>
          <Input
            id="email"
            type="email"
            autoComplete="username"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@company.com"
            required
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "login-error" : undefined}
            className="h-12 border-slate-300 bg-white px-4 text-base shadow-sm"
            data-testid="input-email"
          />
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label
              htmlFor="password"
              className="text-sm font-bold text-slate-800"
            >
              Password
            </Label>
            <a
              href="/reset-password"
              className="text-xs font-bold text-[#0b6463] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700"
              data-testid="link-forgot-password"
            >
              Forgot your password?
            </a>
          </div>
          <div className="relative">
            <Input
              id="password"
              type={passwordVisible ? "text" : "password"}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              required
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "login-error" : undefined}
              className="h-12 border-slate-300 bg-white px-4 pr-12 text-base shadow-sm"
              data-testid="input-password"
            />
            <button
              type="button"
              onClick={() => setPasswordVisible((visible) => !visible)}
              aria-label={passwordVisible ? "Hide password" : "Show password"}
              className="absolute inset-y-0 right-0 grid w-12 place-items-center rounded-r-md text-slate-500 transition-colors hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-700"
              data-testid="button-toggle-password"
            >
              {passwordVisible ? (
                <EyeOff className="size-4" aria-hidden="true" />
              ) : (
                <Eye className="size-4" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
        {error && (
          <div
            role="alert"
            id="login-error"
            className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800"
            data-testid="text-login-error"
          >
            <AlertCircle
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            <span>{error}</span>
          </div>
        )}
        <Button
          type="submit"
          className="min-h-12 w-full bg-[#0b6463] text-base font-bold text-white shadow-sm hover:bg-[#084d4d]"
          disabled={pending !== null || !email.trim() || !password}
          data-testid="button-sign-in"
        >
          {pending === "form" && (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          )}
          Sign in securely
          {pending !== "form" && (
            <ArrowRight className="size-4" aria-hidden="true" />
          )}
        </Button>
      </form>

      <div className="mt-4 flex items-center gap-2 text-xs text-slate-500">
        <ShieldCheck className="size-3.5 text-teal-700" aria-hidden="true" />
        Role-scoped access and encrypted session cookies
      </div>

      <div className="mt-8 border-t border-slate-200 pt-6">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <p className="text-sm font-bold text-slate-900">
              Explore a demo role
            </p>
            <p className="mt-1 text-xs text-slate-500">
              One click opens the selected workspace.
            </p>
          </div>
          <code className="rounded bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-600">
            {DEMO_PASSWORD}
          </code>
        </div>
        <ul className="mt-4 grid gap-2 sm:grid-cols-2">
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
                aria-label={`Sign in as ${a.label}`}
                className="group grid min-h-[4.5rem] w-full grid-cols-[2.25rem_minmax(0,1fr)_1rem] items-center gap-3 rounded-md border border-slate-200 bg-white px-3 py-2.5 text-left shadow-sm transition-colors hover:border-teal-300 hover:bg-teal-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
                data-testid={`button-demo-${a.email.split("@")[0]}`}
              >
                <span
                  className={`grid size-9 place-items-center rounded-md ${a.tone}`}
                >
                  {pending === a.email ? (
                    <Loader2
                      className="size-4 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <a.icon className="size-4" aria-hidden="true" />
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-bold text-slate-900">
                    {a.shortLabel}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-slate-500">
                    {a.opens}
                  </span>
                </span>
                <ArrowRight
                  className="size-4 text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-teal-700"
                  aria-hidden="true"
                />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
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
        setError({
          message: "Current password is incorrect.",
          field: "current",
        });
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
          <AlertCircle
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
          />{" "}
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

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="h-7 px-2 text-muted-foreground hover:text-foreground"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 2000);
          },
          () => {
            /* clipboard unavailable — the value stays selectable on screen */
          },
        );
      }}
    >
      {copied ? (
        <CheckCircle2
          className="h-3.5 w-3.5 text-emerald-600"
          aria-hidden="true"
        />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

// Two-factor lifecycle for the signed-in account: status → enrol (secret,
// otpauth URI and recovery codes shown exactly once) → activate with a live
// code (revokes every other session; this one survives on the re-issued
// cookie) → disable, which demands the password AND a code. The lifecycle
// state itself steps through the pure reducer in lib/totp-card so the
// transitions are unit-testable; this component keeps only the input text
// and the react-query effects.
function TotpSecurityCard() {
  const qc = useQueryClient();
  const statusQuery = useGetTotpStatus({
    query: { queryKey: getGetTotpStatusQueryKey() },
  });
  const setup = useSetupTotp();
  const activate = useActivateTotp();
  const disable = useDisableTotp();

  // Enrolment material exists only in this component's state — shown once,
  // gone on unmount. Only hashes persist server-side.
  const [card, dispatch] = useReducer(totpCardTransition, TOTP_CARD_INITIAL);
  const { material, setupError, justActivated, justDisabled, disableOpen, disableError } =
    card;
  const [activateCode, setActivateCode] = useState("");
  const [disablePassword, setDisablePassword] = useState("");
  const [disableCode, setDisableCode] = useState("");

  const begin = async () => {
    try {
      const m = await setup.mutateAsync();
      dispatch({ type: "begin-success", material: m });
      setActivateCode("");
    } catch (err) {
      // A 409 means another surface already enabled it — refresh the truth.
      await qc.invalidateQueries({ queryKey: getGetTotpStatusQueryKey() });
      dispatch({
        type: "begin-error",
        message:
          serverErrorFrom(err) ?? "Could not start enrolment. Try again.",
      });
    }
  };

  const onActivate = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const status = await activate.mutateAsync({
        data: { code: activateCode.trim() },
      });
      // The response re-issued this session's cookie under the bumped epoch —
      // every OTHER session is now signed out; this panel carries on.
      qc.setQueryData(getGetTotpStatusQueryKey(), status);
      dispatch({ type: "activate-success" });
      setActivateCode("");
    } catch (err) {
      dispatch({
        type: "activate-error",
        message:
          serverErrorFrom(err) ??
          "That code did not match. Check the authenticator app and try again.",
      });
      document.getElementById("totp-activate")?.focus();
    }
  };

  const onDisable = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const status = await disable.mutateAsync({
        data: { password: disablePassword, code: disableCode.trim() },
      });
      qc.setQueryData(getGetTotpStatusQueryKey(), status);
      dispatch({ type: "disable-success" });
      setDisablePassword("");
      setDisableCode("");
    } catch (err) {
      const status = (err as { status?: number })?.status;
      dispatch({
        type: "disable-error",
        message:
          status === 401
            ? "Invalid password or code."
            : (serverErrorFrom(err) ??
                "Could not turn off two-factor. Try again."),
      });
    }
  };

  const info = statusQuery.data;

  return (
    <div className="mt-3 rounded-lg bg-muted/60 p-3" data-testid="card-totp">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <ShieldCheck
            className="h-4 w-4 text-teal-600 dark:text-teal-400"
            aria-hidden="true"
          />
          Two-factor authentication
        </p>
        {info &&
          (info.enabled ? (
            <span className={pillClasses("teal")}>On</span>
          ) : (
            <span className={pillClasses("slate")}>Off</span>
          ))}
      </div>

      {statusQuery.isLoading && (
        <div
          className="mt-2 h-8 animate-pulse rounded-md bg-muted"
          aria-hidden="true"
        />
      )}

      {material ? (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-muted-foreground">
            Add this secret to your authenticator app (paste the setup link or
            type the secret in), then confirm with a live code.
          </p>
          <div className="rounded-md border bg-background p-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-semibold uppercase text-muted-foreground">
                Secret
              </p>
              <CopyButton value={material.secret} label="Copy secret" />
            </div>
            <code
              className="block break-all font-mono text-xs"
              data-testid="text-totp-secret"
            >
              {material.secret}
            </code>
          </div>
          <div className="rounded-md border bg-background p-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-semibold uppercase text-muted-foreground">
                Setup link (otpauth)
              </p>
              <CopyButton
                value={material.otpauthUri}
                label="Copy otpauth URI"
              />
            </div>
            <code className="block break-all font-mono text-[11px] text-muted-foreground">
              {material.otpauthUri}
            </code>
          </div>
          <div className="rounded-md border border-amber-300 bg-amber-50 p-2.5 dark:border-amber-700 dark:bg-amber-950/40">
            <p className="flex items-start gap-1.5 text-xs font-semibold text-amber-900 dark:text-amber-200">
              <AlertCircle
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
                aria-hidden="true"
              />
              These recovery codes are shown once — right now. Store them
              somewhere safe before you continue. Each code signs you in
              exactly once if you ever lose your authenticator.
            </p>
            <ul
              className="mt-2 grid grid-cols-2 gap-1 font-mono text-xs text-amber-900 dark:text-amber-100"
              data-testid="list-recovery-codes"
            >
              {material.recoveryCodes.map((code) => (
                <li key={code}>{code}</li>
              ))}
            </ul>
            <div className="mt-1.5">
              <CopyButton
                value={material.recoveryCodes.join("\n")}
                label="Copy recovery codes"
              />
            </div>
          </div>
          <form onSubmit={onActivate} className="space-y-1.5">
            <Label htmlFor="totp-activate" className="text-xs">
              Code from your authenticator app
            </Label>
            <Input
              id="totp-activate"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={activateCode}
              onChange={(e) => setActivateCode(e.target.value)}
              required
              minLength={6}
              maxLength={8}
              placeholder="123456"
              className="font-mono"
              aria-invalid={setupError ? true : undefined}
              aria-describedby={setupError ? "totp-setup-error" : undefined}
              data-testid="input-totp-activate"
            />
            {setupError && (
              <p
                role="alert"
                id="totp-setup-error"
                className="flex items-start gap-1.5 text-xs text-destructive"
              >
                <AlertCircle
                  className="mt-0.5 h-3.5 w-3.5 shrink-0"
                  aria-hidden="true"
                />{" "}
                {setupError}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Activating signs out every other session on this account.
            </p>
            <div className="flex gap-2 pt-1">
              <Button
                type="submit"
                size="sm"
                disabled={activate.isPending || activateCode.trim().length < 6}
                data-testid="button-totp-activate"
              >
                {activate.isPending ? "Verifying…" : "Verify & turn on"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  dispatch({ type: "cancel-setup" });
                  setActivateCode("");
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        </div>
      ) : info?.enabled ? (
        <div className="mt-2 space-y-2">
          <p
            className="text-xs text-muted-foreground"
            data-testid="text-totp-enabled"
          >
            A code from your authenticator app is required at sign-in
            {info.enabledAt
              ? ` — on since ${new Date(info.enabledAt).toLocaleDateString(
                  undefined,
                  { year: "numeric", month: "short", day: "numeric" },
                )}`
              : ""}
            .
          </p>
          <p
            className="text-xs text-muted-foreground"
            data-testid="text-recovery-remaining"
          >
            {info.recoveryCodesRemaining ?? 0} recovery code
            {(info.recoveryCodesRemaining ?? 0) === 1 ? "" : "s"} left.
          </p>
          {justActivated && (
            <p
              role="status"
              className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400"
              data-testid="text-totp-activated"
            >
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              Two-factor is on. Other signed-in sessions were signed out.
            </p>
          )}
          {!disableOpen ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => dispatch({ type: "disable-open" })}
              className="-ml-2 text-muted-foreground hover:text-foreground"
              data-testid="button-totp-disable-show"
            >
              <ShieldOff className="h-3.5 w-3.5" aria-hidden="true" /> Turn off
              two-factor
            </Button>
          ) : (
            <form onSubmit={onDisable} className="space-y-3 rounded-lg border p-3">
              <p className="text-xs font-medium">Turn off two-factor</p>
              <p className="text-xs text-muted-foreground">
                Confirm with your password and a current code (or a recovery
                code). This signs out every other session.
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="totp-disable-password" className="text-xs">
                  Current password
                </Label>
                <Input
                  id="totp-disable-password"
                  type="password"
                  autoComplete="current-password"
                  value={disablePassword}
                  onChange={(e) => setDisablePassword(e.target.value)}
                  required
                  aria-invalid={disableError ? true : undefined}
                  aria-describedby={
                    disableError ? "totp-disable-error" : undefined
                  }
                  data-testid="input-totp-disable-password"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="totp-disable-code" className="text-xs">
                  Authentication code
                </Label>
                <Input
                  id="totp-disable-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={disableCode}
                  onChange={(e) => setDisableCode(e.target.value)}
                  required
                  minLength={6}
                  maxLength={32}
                  placeholder="123456"
                  className="font-mono"
                  aria-invalid={disableError ? true : undefined}
                  aria-describedby={
                    disableError ? "totp-disable-error" : undefined
                  }
                  data-testid="input-totp-disable-code"
                />
              </div>
              {disableError && (
                <p
                  role="alert"
                  id="totp-disable-error"
                  className="flex items-start gap-1.5 text-xs text-destructive"
                >
                  <AlertCircle
                    className="mt-0.5 h-3.5 w-3.5 shrink-0"
                    aria-hidden="true"
                  />{" "}
                  {disableError}
                </p>
              )}
              <div className="flex gap-2">
                <Button
                  type="submit"
                  size="sm"
                  variant="destructive"
                  disabled={
                    disable.isPending ||
                    !disablePassword ||
                    disableCode.trim().length < 6
                  }
                  data-testid="button-totp-disable"
                >
                  {disable.isPending ? "Turning off…" : "Turn off"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    dispatch({ type: "disable-cancel" });
                    setDisablePassword("");
                    setDisableCode("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </div>
      ) : info ? (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-muted-foreground">
            Require a code from an authenticator app at sign-in, on top of
            your password.
          </p>
          {justDisabled && (
            <p
              role="status"
              className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400"
              data-testid="text-totp-disabled"
            >
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />{" "}
              Two-factor turned off.
            </p>
          )}
          {setupError && (
            <p
              role="alert"
              className="flex items-start gap-1.5 text-xs text-destructive"
            >
              <AlertCircle
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
                aria-hidden="true"
              />{" "}
              {setupError}
            </p>
          )}
          <Button
            type="button"
            size="sm"
            onClick={() => void begin()}
            disabled={setup.isPending}
            data-testid="button-totp-enable"
          >
            <LockKeyhole className="h-3.5 w-3.5" aria-hidden="true" />
            {setup.isPending ? "Preparing…" : "Enable two-factor"}
          </Button>
        </div>
      ) : statusQuery.isError ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Could not load two-factor status. Refresh to retry.
        </p>
      ) : null}
    </div>
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
        <p
          className="text-xs text-muted-foreground"
          data-testid="text-account-detail"
        >
          {me.email ? `${me.email} · ` : ""}
          {roleLabel(me.role)}
        </p>
        <ChangePasswordForm />
      </div>
      <TotpSecurityCard />
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

const ACCESS_PATHS = [
  {
    title: "SME teams",
    detail: "Capture, submit and reconcile",
    icon: ReceiptText,
    tone: "bg-lime-300 text-[#071a1c]",
  },
  {
    title: "Accounting firms",
    detail: "Portfolio risk and client delivery",
    icon: UsersRound,
    tone: "bg-cyan-200 text-[#071a1c]",
  },
  {
    title: "Platform operations",
    detail: "Exceptions, evidence and Clerk review",
    icon: Headphones,
    tone: "bg-amber-200 text-[#071a1c]",
  },
];

function AccessStory() {
  return (
    <section className="relative hidden min-h-screen overflow-hidden bg-[#071a1c] text-white lg:flex lg:flex-col">
      <div
        className="absolute inset-y-0 right-0 w-px bg-lime-300/50"
        aria-hidden="true"
      />
      <div className="flex items-center justify-between px-10 py-8 xl:px-14">
        <a
          href="/"
          className="inline-flex items-center gap-3 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300 focus-visible:ring-offset-4 focus-visible:ring-offset-[#071a1c]"
          aria-label="MeridianIQ home"
        >
          <span className="grid size-10 place-items-center rounded-md bg-lime-300 text-[#071a1c]">
            <FileCheck2 className="size-5" aria-hidden="true" />
          </span>
          <span>
            <span className="block text-lg font-extrabold leading-none">
              MeridianIQ
            </span>
            <span className="mt-1 block text-[11px] font-semibold text-white/50">
              Compliance intelligence
            </span>
          </span>
        </a>
        <a
          href="/"
          className="inline-flex items-center gap-2 rounded-md border border-white/30 px-3.5 py-2 text-sm font-bold text-white/90 transition-colors hover:border-lime-300 hover:bg-white/5 hover:text-lime-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back to website
        </a>
      </div>

      <div className="flex flex-1 flex-col justify-center px-10 py-10 xl:px-14">
        <div className="max-w-xl">
          <p className="text-xs font-extrabold uppercase text-lime-300">
            Connected compliance workspace
          </p>
          <h2 className="landing-display mt-5 text-5xl font-bold leading-[1.05] xl:text-6xl">
            One account. The right operational view.
          </h2>
          <p className="mt-6 max-w-lg text-base leading-7 text-white/65">
            Every MeridianIQ role works from the same governed invoice record,
            with access narrowed to the decisions that role owns.
          </p>
        </div>

        <div className="mt-12 max-w-xl border-y border-white/10">
          {ACCESS_PATHS.map(({ title, detail, icon: Icon, tone }, index) => (
            <div
              key={title}
              className={`grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-4 py-4 ${
                index > 0 ? "border-t border-white/10" : ""
              }`}
            >
              <span
                className={`grid size-10 place-items-center rounded-md ${tone}`}
              >
                <Icon className="size-4" aria-hidden="true" />
              </span>
              <span>
                <span className="block text-sm font-extrabold">{title}</span>
                <span className="mt-0.5 block text-xs text-white/50">
                  {detail}
                </span>
              </span>
              <ArrowRight className="size-4 text-white/25" aria-hidden="true" />
            </div>
          ))}
        </div>

        <div className="mt-10 flex flex-wrap gap-x-6 gap-y-3 text-xs font-semibold text-white/55">
          <span className="inline-flex items-center gap-2">
            <ShieldCheck className="size-4 text-lime-300" aria-hidden="true" />
            Role-scoped access
          </span>
          <span className="inline-flex items-center gap-2">
            <ScanLine className="size-4 text-cyan-200" aria-hidden="true" />
            Human-reviewed AI
          </span>
          <span className="inline-flex items-center gap-2">
            <CheckCircle2
              className="size-4 text-amber-200"
              aria-hidden="true"
            />
            Verifiable evidence
          </span>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-white/10 px-10 py-5 text-[11px] text-white/35 xl:px-14">
        <span>Lagos, Nigeria</span>
        <span>Built for the Nigerian invoice lifecycle</span>
      </div>
    </section>
  );
}

function AccessPortal({
  children,
  outage,
  onRetry,
}: {
  children: ReactNode;
  outage: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="min-h-screen bg-[#f4f8f7] lg:grid lg:grid-cols-[minmax(25rem,0.85fr)_minmax(39rem,1.15fr)]">
      <a
        href="#login-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-lime-300 focus:px-4 focus:py-2 focus:text-sm focus:font-bold focus:text-[#071a1c]"
      >
        Skip to sign in
      </a>
      <AccessStory />

      <section className="flex min-h-screen flex-col">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-5 py-4 lg:hidden">
          <a
            href="/"
            className="inline-flex items-center gap-2.5"
            aria-label="MeridianIQ home"
          >
            <span className="grid size-9 place-items-center rounded-md bg-[#0b6463] text-white">
              <FileCheck2 className="size-4" aria-hidden="true" />
            </span>
            <span className="text-base font-extrabold text-slate-950">
              MeridianIQ
            </span>
          </a>
          <a
            href="/"
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-bold text-slate-700 transition-colors hover:border-slate-950 hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0b6463]"
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            Back to website
          </a>
        </header>

        <main
          id="login-content"
          tabIndex={-1}
          className="flex flex-1 items-center justify-center px-5 py-10 focus:outline-none sm:px-10 sm:py-14 xl:px-16"
        >
          <div className="w-full max-w-2xl">
            {outage && (
              <div
                role="alert"
                className="mb-6 flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5"
              >
                <span className="flex items-start gap-2 text-sm font-medium text-amber-900">
                  <AlertCircle
                    className="mt-0.5 size-4 shrink-0"
                    aria-hidden="true"
                  />
                  MeridianIQ is temporarily unreachable.
                </span>
                <Button size="sm" variant="outline" onClick={onRetry}>
                  Retry
                </Button>
              </div>
            )}
            {children}
          </div>
        </main>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-5 py-4 text-[11px] text-slate-500 sm:px-10 xl:px-16">
          <span>Protected by role-based access controls</span>
          <a
            className="font-bold hover:text-slate-900"
            href="/penalty-calculator/"
          >
            Penalty calculator
          </a>
        </footer>
      </section>
    </div>
  );
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

  if (!me) {
    return (
      <AccessPortal outage={isOutage} onRetry={() => void refetch()}>
        {isLoading ? <SessionSkeleton /> : <SignInPanel />}
      </AccessPortal>
    );
  }

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
    <div className="min-h-screen bg-[#f4f8f7]">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        Skip to content
      </a>
      <PortalHeader
        right={
          <span
            className="max-w-[55%] truncate rounded-md border border-teal-200 bg-teal-50 px-3 py-1.5 text-xs font-bold text-teal-900"
            data-testid="badge-session"
          >
            {me.fullName ?? me.email ?? roleLabel(me.role)} ·{" "}
            {roleLabel(me.role)}
          </span>
        }
      />

      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto max-w-7xl px-5 py-10 focus:outline-none sm:px-8 sm:py-14"
      >
        <section className="max-w-3xl">
          <p className="text-xs font-extrabold uppercase text-teal-700">
            Signed in as {roleLabel(me.role)}
          </p>
          <h1 className="landing-display mt-3 text-4xl font-bold text-slate-950 sm:text-5xl">
            Choose your workspace
          </h1>
          <p className="mt-3 text-base leading-7 text-slate-600 sm:text-lg">
            Your default workspace is ready. The options below reflect the
            access attached to this account.
          </p>
        </section>

        <div className="mt-10 grid gap-8 lg:grid-cols-[1fr_20rem]">
          {/* Sign-in first in DOM: on a phone it sits right under the hero,
              and the h2 "Sign in" precedes the tile h3s. */}
          <aside className="mx-auto w-full max-w-md space-y-5 lg:order-last lg:max-w-none">
            <SignedInPanel me={me} />
          </aside>

          <section
            aria-labelledby="workspaces-heading"
            className="lg:order-first"
          >
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
            MeridianIQ — Lagos, Nigeria. The Penalty Calculator is public; every
            other workspace is protected by sign-in and role.
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

  if (pathname === "/reset-password") {
    return (
      <QueryClientProvider client={queryClient}>
        <ResetPassword />
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
