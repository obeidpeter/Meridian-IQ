import { useLogin, useTotpChallenge } from "@workspace/api-client-react";
import type { Me } from "@workspace/api-client-react";
import React, { useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { AppButton, AppText, Card, TextField } from "@/components/ui";
import { ValoMark } from "@/components/valo-mark";
import { useColors } from "@/hooks/useColors";
import {
  apiErrorMessage,
  errorStatus,
  hasStatus,
  serverMessage,
} from "@/lib/api-error";
import { mfaChallengeDisposition } from "@/lib/mfa";
import { useSession } from "@/lib/session";

function errorMessage(error: unknown): string {
  return (
    (serverMessage(error)
      ? apiErrorMessage(error, "Could not sign in. Try again.")
      : null) ??
    (hasStatus(error, 401)
      ? "The email or password is incorrect. Check both and try again."
      : apiErrorMessage(error, "Could not sign in. Try again."))
  );
}

// The X-Valo-Client header tells the API this is a native client that
// cannot use HttpOnly cookies, so login AND the TOTP challenge include the
// bearer token in the body. Browser web apps never send it and stay
// cookie-only. customFetch also emits the legacy header for older servers.
const MOBILE_CLIENT_REQUEST = {
  headers: { "X-Valo-Client": "mobile" },
} as const;

export function SignIn() {
  const colors = useColors();
  const { signIn } = useSession();
  const login = useLogin({ request: MOBILE_CLIENT_REQUEST });
  const totpChallenge = useTotpChallenge({ request: MOBILE_CLIENT_REQUEST });

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  // TOTP-enrolled account: a correct password earns no session, only a
  // short-lived challenge token. Holding it (with its mint time) keeps the
  // screen on the code step until a code — or "Start over" — resolves it.
  const [mfa, setMfa] = useState<{ token: string; issuedAt: number } | null>(
    null,
  );
  const [totpCode, setTotpCode] = useState("");
  const [totpError, setTotpError] = useState<string | null>(null);

  const completeSignIn = async (me: Me) => {
    try {
      await signIn(me);
      return null;
    } catch {
      // Only a genuinely tokenless success response lands here — the
      // mfa-required login shape is intercepted before signIn is called.
      return "Your account was verified, but the app could not finish signing in. Contact Valo support.";
    }
  };

  const onSubmit = () => {
    // The keyboard "go" key and the button both call this; guard so an
    // in-flight login can't be fired twice.
    if (login.isPending) return;
    setFormError(null);
    if (!email.trim() || !password) {
      setFormError("Enter your email and password to continue.");
      return;
    }
    login.mutate(
      { data: { email: email.trim(), password } },
      {
        onSuccess: async (me) => {
          if (me.mfaRequired && me.mfaToken) {
            // Password verified, second factor pending: switch to the code
            // step. Deliberately NOT signIn — this response carries no token.
            setMfa({ token: me.mfaToken, issuedAt: Date.now() });
            setTotpCode("");
            setTotpError(null);
            return;
          }
          const failure = await completeSignIn(me);
          if (failure) setFormError(failure);
        },
        onError: (error) => setFormError(errorMessage(error)),
      },
    );
  };

  const onVerifyCode = () => {
    if (!mfa || totpChallenge.isPending) return;
    const code = totpCode.trim();
    if (code.length < 6) return;
    setTotpError(null);
    totpChallenge.mutate(
      { data: { mfaToken: mfa.token, code } },
      {
        onSuccess: async (me) => {
          const failure = await completeSignIn(me);
          if (failure) setTotpError(failure);
        },
        onError: (error) => {
          // The server 401s identically for a wrong code and an expired
          // token; the pure helper splits them on this client's own clock
          // (lib/mfa — parity copy of the landing portal's).
          const disposition = mfaChallengeDisposition({
            status: errorStatus(error),
            issuedAt: mfa.issuedAt,
            now: Date.now(),
          });
          if (disposition === "restart") {
            // The 5-minute challenge window lapsed — back to the password step.
            setMfa(null);
            setTotpCode("");
            setPassword("");
            setFormError(
              "That sign-in attempt expired. Enter your password again.",
            );
            return;
          }
          if (disposition === "invalid-code") {
            setTotpError(
              "That code did not match. Try the current code from your authenticator app, or use a recovery code.",
            );
          } else if (disposition === "server-error") {
            // Includes the 429 guess throttle: the server's own words ("Too
            // many attempts. Try again in N minute(s).") are surfaced.
            setTotpError(
              apiErrorMessage(error, "Could not verify the code. Try again."),
            );
          } else {
            setTotpError(
              "Could not reach the server. Check your connection and try again.",
            );
          }
        },
      },
    );
  };

  const restartSignIn = () => {
    setMfa(null);
    setTotpCode("");
    setTotpError(null);
    setFormError(null);
    setPassword("");
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={styles.container}
        bottomOffset={24}
      >
        <View style={styles.hero}>
          <View
            style={[
              styles.logo,
              colors.scheme === "light" ? styles.logoShadow : null,
            ]}
          >
            <ValoMark width={44} height={44} />
          </View>
          <AppText variant="display" style={{ marginTop: 18 }}>
            Valo
          </AppText>
          <AppText
            variant="body"
            color={colors.mutedForeground}
            style={{ marginTop: 6, textAlign: "center" }}
          >
            Invoices and compliance tasks for your business.
          </AppText>
        </View>

        {mfa ? (
          <Card style={{ marginTop: 32, gap: 16 }}>
            <View style={{ gap: 6 }}>
              <AppText variant="overline" color={colors.mutedForeground}>
                Two-step verification
              </AppText>
              <AppText variant="heading">Enter your code</AppText>
              <AppText variant="body" color={colors.mutedForeground}>
                <AppText
                  variant="body"
                  style={{ fontFamily: "Inter_600SemiBold" }}
                >
                  {email.trim()}
                </AppText>{" "}
                uses two-step verification. Enter the 6-digit code from your
                authenticator app, or one of your saved recovery codes.
              </AppText>
            </View>
            <TextField
              label="Verification or recovery code"
              value={totpCode}
              onChangeText={setTotpCode}
              placeholder="123456"
              // Numbers-first keyboard on iOS (with the ABC plane one tap
              // away, so alphanumeric recovery codes stay typeable); Android
              // has no such layout and falls back to its default keyboard.
              keyboardType="numbers-and-punctuation"
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              maxLength={32}
              returnKeyType="go"
              onSubmitEditing={onVerifyCode}
              error={totpError}
              hint="Your app shows a new code every 30 seconds. This sign-in step expires after five minutes."
            />
            <AppButton
              label="Sign in"
              icon="check-circle"
              onPress={onVerifyCode}
              loading={totpChallenge.isPending}
              disabled={totpCode.trim().length < 6}
            />
            <AppButton
              label="Start over"
              icon="arrow-left"
              variant="ghost"
              onPress={restartSignIn}
            />
          </Card>
        ) : (
          <Card style={{ marginTop: 32, gap: 16 }}>
            <TextField
              label="Email"
              value={email}
              onChangeText={setEmail}
              placeholder="you@business.com"
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              autoCorrect={false}
              textContentType="username"
              returnKeyType="next"
            />
            <TextField
              label="Password"
              value={password}
              onChangeText={setPassword}
              placeholder="Your password"
              secureTextEntry
              autoCapitalize="none"
              textContentType="password"
              returnKeyType="go"
              onSubmitEditing={onSubmit}
            />
            {formError ? (
              <AppText variant="label" color={colors.destructiveText}>
                {formError}
              </AppText>
            ) : null}
            <AppButton
              label="Sign in"
              icon="log-in"
              onPress={onSubmit}
              loading={login.isPending}
            />
          </Card>
        )}

        <AppText
          variant="caption"
          color={colors.mutedForeground}
          style={{ marginTop: 24, textAlign: "center" }}
        >
          Penalty figures use Valo's planning assumptions. They are not official
          penalty amounts or legal or tax advice.
        </AppText>
      </KeyboardAwareScrollViewCompat>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
    paddingVertical: 48,
    ...(Platform.OS === "web"
      ? { maxWidth: 480, alignSelf: "center", width: "100%" }
      : {}),
  },
  hero: {
    alignItems: "center",
  },
  logo: {
    width: 72,
    height: 72,
    backgroundColor: "#536149",
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  logoShadow: {
    shadowColor: "#536149",
    shadowOpacity: 0.25,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
  },
});
