import { Feather } from "@expo/vector-icons";
import { useLogin } from "@workspace/api-client-react";
import React, { useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { AppButton, AppText, Card, TextField } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { useSession } from "@/lib/session";

function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const data = (error as { data?: unknown }).data;
    if (data && typeof data === "object" && "message" in data) {
      const msg = (data as { message?: unknown }).message;
      if (typeof msg === "string") return msg;
    }
    const status = (error as { status?: unknown }).status;
    if (status === 401) return "Incorrect email or password.";
  }
  return "We couldn't sign you in. Please try again.";
}

export function SignIn() {
  const colors = useColors();
  const { signIn } = useSession();
  // The X-Meridian-Client header tells the API this is a native client that
  // cannot use HttpOnly cookies, so the login response includes the bearer
  // token. Browser web apps never send it and stay cookie-only.
  const login = useLogin({
    request: { headers: { "X-Meridian-Client": "mobile" } },
  });

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

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
          try {
            await signIn(me);
          } catch {
            setFormError(
              "Signed in, but no session token was returned. Contact support.",
            );
          }
        },
        onError: (error) => setFormError(errorMessage(error)),
      },
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={styles.container}
        bottomOffset={24}
      >
        <View style={styles.hero}>
          <View
            style={[styles.logo, { backgroundColor: colors.accent }]}
          >
            <Feather name="shield" size={30} color={colors.primary} />
          </View>
          <AppText variant="display" style={{ marginTop: 20 }}>
            MeridianIQ
          </AppText>
          <AppText
            variant="body"
            color={colors.mutedForeground}
            style={{ marginTop: 6, textAlign: "center" }}
          >
            Stay ahead of e-invoicing deadlines and penalties.
          </AppText>
        </View>

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

        <AppText
          variant="caption"
          color={colors.mutedForeground}
          style={{ marginTop: 24, textAlign: "center" }}
        >
          Penalty figures shown in this app are estimates, not tax advice.
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
    ...(Platform.OS === "web" ? { maxWidth: 480, alignSelf: "center", width: "100%" } : {}),
  },
  hero: {
    alignItems: "center",
  },
  logo: {
    width: 72,
    height: 72,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
});
