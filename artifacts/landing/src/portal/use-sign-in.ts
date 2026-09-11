// The sign-in flow's state and handlers (R126 lifted them out of the
// SignInPanel component so the password step and the two-step challenge can
// be separate components). Hooks, state and handlers are declared in the
// same order the component declared them; the bag is returned as-is so the
// steps read the same identifiers.

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useLogin,
  useTotpChallenge,
  getGetMeQueryKey,
} from "@workspace/api-client-react";
import type { Me } from "@workspace/api-client-react";
import { trackUsabilityEvent, webSession } from "@workspace/web-ui";
import { serverErrorFrom, userErrorMessage } from "@/lib/errors";
import { mfaChallengeDisposition } from "@/lib/mfa";
import {
  defaultWorkspaceFor,
  resolveReturnTo,
  sanitizeReturnTo,
} from "@/lib/return-to";
import { APPS } from "./tiles";

// Fall back to a friendly generic per failure kind.
function loginErrorMessage(err: unknown): string {
  const status = (err as { status?: number })?.status;
  const serverError = serverErrorFrom(err);
  if (status === 401) {
    return serverError === "Account has no active membership"
      ? "This account isn't linked to a workspace yet. Ask your administrator to add you."
      : "The email or password is incorrect. Check both and try again.";
  }
  if (status !== undefined) {
    return userErrorMessage(err) ?? "Could not sign in. Try again.";
  }
  return "We can't reach Valo right now. Check your internet connection and try again.";
}

export type SignInFlow = ReturnType<typeof useSignIn>;

export function useSignIn() {
  const qc = useQueryClient();
  const authGeneration = useRef(webSession.getGeneration());
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
  // Which sign-in step is running. Drives the per-button spinner without
  // allowing a duplicate submission.
  const [pending, setPending] = useState<string | null>(null);
  const [redirecting, setRedirecting] = useState<{
    label: string;
    href: string;
  } | null>(null);

  // Captured once on mount: the app session guards send ?returnTo=<the page
  // the session expired on>&reason=expired, and the marketing page's
  // workspace cards send ?returnTo=<the workspace the visitor picked>.
  const [arrival] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return {
      returnTo: sanitizeReturnTo(params.get("returnTo")),
      expired: params.get("reason") === "expired",
    };
  });

  // Shared success tail for both steps: the session cookie is set, so land
  // the account where it was headed — the page a guard bounced it from or
  // the workspace card it clicked (a validated, role-allowed returnTo), else
  // the default workspace for the membership. A full navigation, so the app
  // boots against the fresh session cookie.
  const completeSignIn = async (me: Me): Promise<boolean> => {
    if (authGeneration.current !== webSession.getGeneration()) return true;
    if (!(await webSession.startSession())) return true;
    authGeneration.current = webSession.getGeneration();
    trackUsabilityEvent("login_success", "login");
    await qc.invalidateQueries({ queryKey: getGetMeQueryKey() });
    if (authGeneration.current !== webSession.getGeneration()) return true;
    const target =
      resolveReturnTo(arrival.returnTo, me.role, APPS) ??
      defaultWorkspaceFor(me);
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
    trackUsabilityEvent("login_attempt", "login");
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
      trackUsabilityEvent("login_failure", "login");
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
      trackUsabilityEvent("login_failure", "login");
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
          "This sign-in attempt expired. Enter your password again, then use the current code from your authenticator app.",
        );
        return;
      }
      if (disposition === "invalid-code") {
        setTotpError(
          "That code did not match. Try the current code from your authenticator app, or use a recovery code.",
        );
      } else if (disposition === "server-error") {
        setTotpError(
          userErrorMessage(err) ?? "Could not verify the code. Try again.",
        );
      } else {
        setTotpError(
          "Could not reach the server. Check your connection and try again.",
        );
      }
      document.getElementById("totp-code")?.focus();
    }
  };

  // The pending token lives MFA_TOKEN_TTL_MS; the help text says how much
  // of that is left, refreshed on a coarse 30 s tick while the step is up.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!mfa) return;
    setNow(Date.now());
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(tick);
  }, [mfa]);

  const restartSignIn = () => {
    setMfa(null);
    setTotpCode("");
    setTotpError(null);
    setError(null);
    setPassword("");
  };

  return {
    arrival,
    email,
    setEmail,
    password,
    setPassword,
    passwordVisible,
    setPasswordVisible,
    error,
    mfa,
    totpCode,
    setTotpCode,
    totpError,
    pending,
    redirecting,
    now,
    onSubmit,
    onVerifyCode,
    restartSignIn,
  };
}
