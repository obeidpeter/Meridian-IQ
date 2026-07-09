import { useState, type FormEvent } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
    accent: "text-teal-600",
  },
  {
    key: "console",
    name: "Accountant Console",
    tagline:
      "Multi-client portfolio, onboarding, billing, white-label branding, certification and the operator queue.",
    href: "/console/",
    icon: Building2,
    allowedRoles: ["firm_admin", "firm_staff", "operator", "auditor"],
    accent: "text-indigo-600",
  },
  {
    key: "buyer",
    name: "Buyer Rails",
    tagline:
      "Confirm supplier invoices for VAT protection, flag payments, track exposure and score suppliers.",
    href: "/buyer/",
    icon: Store,
    allowedRoles: ["buyer_user"],
    accent: "text-blue-600",
  },
  {
    key: "calc",
    name: "Penalty Calculator",
    tagline:
      "Estimate s.103 / s.104 exposure from your turnover. Free, no account needed.",
    href: "/penalty-calculator/",
    icon: Calculator,
    allowedRoles: null,
    accent: "text-amber-600",
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

// The generated client throws ApiError carrying the parsed body; the server
// answers { error: string }. Fall back to a friendly generic per failure kind.
function loginErrorMessage(err: unknown): string {
  const status = (err as { status?: number })?.status;
  const data = (err as { data?: unknown })?.data;
  const serverError =
    data && typeof data === "object" && "error" in data
      ? String((data as { error: unknown }).error)
      : null;
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

function AppCard({ app, role }: { app: AppTile; role: Role | null }) {
  const Icon = app.icon;
  const isPublic = app.allowedRoles === null;
  const canOpen = isPublic || (role !== null && app.allowedRoles!.includes(role));
  const needsOtherRole =
    !isPublic && role !== null && !app.allowedRoles!.includes(role);

  return (
    <div className="group flex flex-col rounded-xl border bg-card p-6 shadow-sm transition-shadow hover:shadow-md">
      <div className="flex items-start justify-between">
        <div className={`rounded-lg bg-muted p-3 ${app.accent}`}>
          <Icon className="h-6 w-6" />
        </div>
        {isPublic ? (
          <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-800">
            Free
          </span>
        ) : canOpen ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-teal-100 px-2.5 py-1 text-xs font-medium text-teal-800">
            <ShieldCheck className="h-3 w-3" /> Signed in
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
            <Lock className="h-3 w-3" /> {role ? "Other account" : "Sign in"}
          </span>
        )}
      </div>
      <h3 className="mt-4 text-lg font-semibold">{app.name}</h3>
      <p className="mt-1 flex-1 text-sm text-muted-foreground">{app.tagline}</p>
      <div className="mt-5">
        {canOpen ? (
          <a href={app.href} data-testid={`link-open-${app.key}`}>
            <Button className="w-full">
              Open {app.name}
              <ArrowRight className="h-4 w-4" />
            </Button>
          </a>
        ) : needsOtherRole ? (
          <Button variant="secondary" className="w-full" disabled>
            Needs a {app.allowedRoles!.map(roleLabel).join(" or ")} account
          </Button>
        ) : (
          <Button variant="secondary" className="w-full" disabled>
            Sign in to open
          </Button>
        )}
      </div>
    </div>
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
  const [redirecting, setRedirecting] = useState<string | null>(null);

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
        setRedirecting(target.label);
        window.location.assign(target.href);
        return; // keep the "opening…" state until the browser navigates
      }
      setPending(null);
    } catch (err) {
      setError(loginErrorMessage(err));
      setPending(null);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void signIn("form", { email, password });
  };

  if (redirecting) {
    return (
      <div
        className="rounded-xl border bg-card p-6 shadow-sm"
        data-testid="panel-redirecting"
      >
        <div className="flex items-center gap-2">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          <h2 className="text-lg font-semibold">Signed in</h2>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          Opening {redirecting}…
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card p-6 shadow-sm">
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
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@firm.example"
            required
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
            data-testid="input-password"
          />
        </div>
        {error && (
          <p
            className="flex items-start gap-1.5 text-sm text-destructive"
            data-testid="text-login-error"
          >
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" /> {error}
          </p>
        )}
        <Button
          type="submit"
          className="w-full"
          disabled={pending !== null}
          data-testid="button-sign-in"
        >
          {pending === "form" && <Loader2 className="h-4 w-4 animate-spin" />}
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
            <li key={a.email} className="text-xs">
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
                className="font-medium text-primary hover:underline disabled:opacity-50 inline-flex items-center gap-1"
                data-testid={`button-demo-${a.email.split("@")[0]}`}
              >
                {pending === a.email && (
                  <Loader2 className="h-3 w-3 animate-spin" />
                )}
                {a.label}
              </button>
              <span className="text-muted-foreground"> — opens {a.opens}</span>
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
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

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
      setTimeout(() => {
        setDone(false);
        setOpen(false);
      }, 2500);
    } catch (err) {
      const status = (err as { status?: number })?.status;
      setError(
        status === 401
          ? "Current password is incorrect."
          : status === 400
            ? "New password must be at least 8 characters."
            : "Could not change the password. Try again.",
      );
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        data-testid="button-show-change-password"
      >
        <KeyRound className="h-3.5 w-3.5" /> Change password
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-2 rounded-lg border p-3">
      <p className="text-xs font-medium">Change password</p>
      <Input
        type="password"
        autoComplete="current-password"
        placeholder="Current password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        required
        data-testid="input-current-password"
      />
      <Input
        type="password"
        autoComplete="new-password"
        placeholder="New password (min 8 characters)"
        value={next}
        onChange={(e) => setNext(e.target.value)}
        required
        minLength={8}
        data-testid="input-new-password"
      />
      {error && (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {error}
        </p>
      )}
      {done && (
        <p
          className="flex items-center gap-1.5 text-xs text-emerald-700"
          data-testid="text-password-changed"
        >
          <CheckCircle2 className="h-3.5 w-3.5" /> Password changed.
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
            setOpen(false);
            setError(null);
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
    <div className="rounded-xl border bg-card p-6 shadow-sm" data-testid="panel-signed-in">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-teal-600" />
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
          <a href={target.href} data-testid="link-default-workspace">
            <Button className="w-full">
              Open {target.label}
              <ArrowRight className="h-4 w-4" />
            </Button>
          </a>
        )}
        <Button
          variant="secondary"
          className="w-full"
          onClick={signOut}
          disabled={signingOut}
          data-testid="button-sign-out"
        >
          {signingOut ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <LogOut className="h-4 w-4" />
          )}
          Sign out
        </Button>
      </div>
    </div>
  );
}

function Portal() {
  const { data: me, isLoading } = useGetMe({
    query: { queryKey: getGetMeQueryKey(), retry: false },
  });
  const role = (me?.role as Role | undefined) ?? null;

  return (
    <div className="min-h-screen bg-gradient-to-b from-muted/40 to-background">
      <header className="border-b bg-card/70 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="rounded-lg bg-primary p-1.5 text-primary-foreground">
              <FileCheck2 className="h-5 w-5" />
            </div>
            <div>
              <p className="text-base font-bold leading-none tracking-tight">
                MeridianIQ
              </p>
              <p className="text-xs text-muted-foreground">
                Compliance & verified receivables
              </p>
            </div>
          </div>
          {me && (
            <span
              className="max-w-[50%] truncate rounded-full border bg-background px-3 py-1 text-xs font-medium text-muted-foreground"
              data-testid="badge-session"
            >
              {me.fullName ?? me.email ?? roleLabel(me.role)} ·{" "}
              {roleLabel(me.role)}
            </span>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
        <section className="max-w-3xl">
          <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">
            One data spine. Four ways in.
          </h1>
          <p className="mt-3 text-base text-muted-foreground sm:text-lg">
            MeridianIQ makes Nigerian e-invoicing painless — and quietly turns
            that compliance into financeable, verified receivables. Sign in to
            open your workspace, or use the free penalty calculator right away.
          </p>
        </section>

        <div className="mt-10 grid gap-8 lg:grid-cols-[1fr_20rem]">
          <div className="grid gap-5 sm:grid-cols-2">
            {APPS.map((app) => (
              <AppCard key={app.key} app={app} role={role} />
            ))}
          </div>

          <aside className="space-y-5">
            {isLoading ? (
              <div className="flex h-40 items-center justify-center rounded-xl border bg-card">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : me ? (
              <SignedInPanel me={me} />
            ) : (
              <SignInPanel />
            )}
          </aside>
        </div>

        <footer className="mt-14 border-t pt-6 text-xs text-muted-foreground">
          MeridianIQ — Lagos, Nigeria. The Penalty Calculator is public; every
          other workspace is protected by sign-in and role.
        </footer>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Portal />
    </QueryClientProvider>
  );
}
