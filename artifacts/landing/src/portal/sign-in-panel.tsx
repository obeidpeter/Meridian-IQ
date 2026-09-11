import { useEffect, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Eye,
  EyeOff,
  Loader2,
  LockKeyhole,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { mfaExpiryHint } from "@/lib/mfa";
import { useSignIn, type SignInFlow } from "./use-sign-in";

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
    <Card
      className="auth-redirecting p-6 shadow-sm"
      data-testid="panel-redirecting"
    >
      <div className="flex items-center gap-2">
        <Loader2
          className="h-5 w-5 animate-spin text-primary"
          aria-hidden="true"
        />
        <h2 className="text-lg font-semibold">Opening {target.label}…</h2>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        You are signed in. Your workspace is opening.
      </p>
      {slow && (
        <p className="mt-3 text-sm text-muted-foreground" role="status">
          This is taking longer than expected. You can{" "}
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

function TotpChallengeStep({
  flow,
  mfa,
}: {
  flow: SignInFlow;
  mfa: NonNullable<SignInFlow["mfa"]>;
}) {
  const {
    email,
    onVerifyCode,
    totpCode,
    setTotpCode,
    totpError,
    now,
    pending,
    restartSignIn,
  } = flow;

  return (
    <div className="auth-panel" data-testid="panel-totp-challenge">
      <div className="auth-eyebrow">
        <span className="auth-step-icon">
          <ShieldCheck className="size-4" aria-hidden="true" />
        </span>
        Two-step verification
      </div>

      <h1 className="auth-title">Enter your code</h1>
      <p className="auth-intro">
        Enter the 6-digit code from your authenticator app for{" "}
        <span className="auth-account-email">{email}</span>, or use a saved
        recovery code.
      </p>

      <form onSubmit={onVerifyCode} className="auth-form">
        <div className="space-y-2">
          <Label htmlFor="totp-code" className="auth-label">
            Verification or recovery code
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
            className="auth-input auth-code-input"
            data-testid="input-totp-code"
          />
          <p id="totp-help" className="auth-help">
            Your app shows a new code every 30 seconds. This sign-in step
            expires five minutes after you entered your password (
            <span data-testid="text-totp-expiry">
              {mfaExpiryHint(mfa.issuedAt, now)}
            </span>
            ). Start over if you need more time.
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
          className="auth-submit"
          disabled={pending !== null || totpCode.trim().length < 6}
          data-testid="button-totp-verify"
        >
          {pending === "totp" && (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          )}
          Sign in
          {pending !== "totp" && (
            <ArrowRight className="size-4" aria-hidden="true" />
          )}
        </Button>
      </form>

      <button
        type="button"
        onClick={restartSignIn}
        className="auth-text-link auth-restart"
        data-testid="button-totp-restart"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Start over
      </button>
    </div>
  );
}

function PasswordStep({ flow }: { flow: SignInFlow }) {
  const {
    arrival,
    onSubmit,
    email,
    setEmail,
    error,
    password,
    setPassword,
    passwordVisible,
    setPasswordVisible,
    pending,
  } = flow;

  return (
    <div className="auth-panel" data-testid="panel-sign-in">
      <div className="auth-eyebrow">
        <span className="auth-step-icon">
          <LockKeyhole className="size-4" aria-hidden="true" />
        </span>
        Secure sign-in
      </div>

      <h1 className="auth-title">Sign in to Valo</h1>
      <p className="auth-intro">
        Use the email address and password for your Valo account.
      </p>

      {arrival.expired && arrival.returnTo && (
        <div
          role="status"
          className="mt-6 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900"
          data-testid="text-session-expired"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            Your session expired. Sign in to continue where you left off.
          </span>
        </div>
      )}

      <form onSubmit={onSubmit} className="auth-form">
        <div className="space-y-2">
          <Label htmlFor="email" className="auth-label">
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
            className="auth-input"
            data-testid="input-email"
          />
        </div>
        <div className="space-y-2">
          <div className="auth-label-row">
            <Label htmlFor="password" className="auth-label">
              Password
            </Label>
            <a
              href="/reset-password"
              className="auth-text-link auth-forgot-link"
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
              className="auth-input auth-password-input"
              data-testid="input-password"
            />
            <button
              type="button"
              onClick={() => setPasswordVisible((visible) => !visible)}
              aria-label={passwordVisible ? "Hide password" : "Show password"}
              title={passwordVisible ? "Hide password" : "Show password"}
              className="auth-password-toggle"
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
          className="auth-submit"
          disabled={pending !== null || !email.trim() || !password}
          data-testid="button-sign-in"
        >
          {pending === "form" && (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          )}
          Sign in
          {pending !== "form" && (
            <ArrowRight className="size-4" aria-hidden="true" />
          )}
        </Button>
      </form>

      <div className="auth-account-note">
        <ShieldCheck className="size-4 shrink-0" aria-hidden="true" />
        <span>
          You can only open workspaces and records your account has access to.
        </span>
      </div>
      <div className="auth-support-links">
        <a
          href="/#request-access"
          className="auth-text-link"
          data-testid="link-request-access"
        >
          Need an invitation?
        </a>
        <a href="/#trust" className="auth-text-link auth-muted-link">
          Security and service status
        </a>
      </div>
    </div>
  );
}

export function SignInPanel() {
  const flow = useSignIn();

  if (flow.redirecting) {
    return <RedirectingPanel target={flow.redirecting} />;
  }

  if (flow.mfa) {
    return <TotpChallengeStep flow={flow} mfa={flow.mfa} />;
  }

  return <PasswordStep flow={flow} />;
}
