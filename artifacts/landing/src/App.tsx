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
  getGetMeQueryKey,
} from "@workspace/api-client-react";
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
    allowedRoles: ["firm_admin", "operator"],
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

const DEMO_ACCOUNTS: { label: string; email: string; opens: string }[] = [
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

function AppCard({
  app,
  role,
}: {
  app: AppTile;
  role: Role | null;
}) {
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
          <a href={app.href}>
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

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await login.mutateAsync({ data: { email, password } });
      await qc.invalidateQueries({ queryKey: getGetMeQueryKey() });
    } catch {
      setError("Invalid email or password.");
    }
  };

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
          />
        </div>
        {error && (
          <p className="flex items-center gap-1.5 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" /> {error}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={login.isPending}>
          {login.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          Sign in
        </Button>
      </form>

      <div className="mt-5 rounded-lg bg-muted/60 p-3">
        <p className="text-xs font-medium text-muted-foreground">
          Demo accounts — password{" "}
          <code className="rounded bg-background px-1 py-0.5">{DEMO_PASSWORD}</code>
        </p>
        <ul className="mt-2 space-y-2">
          {DEMO_ACCOUNTS.map((a) => (
            <li key={a.email} className="text-xs">
              <button
                type="button"
                onClick={() => {
                  setEmail(a.email);
                  setPassword(DEMO_PASSWORD);
                }}
                className="font-medium text-primary hover:underline"
              >
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

function SignedInPanel({ role }: { role: Role }) {
  const qc = useQueryClient();
  const logout = useLogout();
  const signOut = async () => {
    try {
      await logout.mutateAsync();
    } catch {
      /* best effort */
    }
    await qc.invalidateQueries({ queryKey: getGetMeQueryKey() });
  };
  return (
    <div className="rounded-xl border bg-card p-6 shadow-sm">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-teal-600" />
        <h2 className="text-lg font-semibold">Signed in</h2>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        You're signed in as a{" "}
        <span className="font-medium text-foreground">{roleLabel(role)}</span>.
        Open the workspaces highlighted below, or switch accounts.
      </p>
      <Button variant="secondary" className="mt-4 w-full" onClick={signOut}>
        <LogOut className="h-4 w-4" />
        Sign out
      </Button>
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
          {role && (
            <span className="rounded-full border bg-background px-3 py-1 text-xs font-medium text-muted-foreground">
              {roleLabel(role)}
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
            ) : role ? (
              <SignedInPanel role={role} />
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
