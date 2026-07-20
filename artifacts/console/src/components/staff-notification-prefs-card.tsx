import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMe,
  useGetStaffNotificationPreferences,
  useUpdateStaffNotificationPreferences,
  useRequestStaffEmailVerification,
  useConfirmStaffEmail,
  getGetStaffNotificationPreferencesQueryKey,
} from "@workspace/api-client-react";
import type {
  StaffNotificationPreferences,
  UpdateStaffNotificationPreferencesInput,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { QueryError } from "@/components/query-error";
import { errorStatus, serverErrorMessage } from "@/lib/errors";
import { pillClasses } from "@/lib/format";

// Staff notification preferences — how (and whether) the weekly Clerk digest
// reaches this firm member. Self-service and strictly personal: the server
// keys the row on the signed-in user, and everything defaults OFF — a member
// who never opts in receives nothing. The endpoint 403s every non-firm role
// (operators, auditors, client/bank/buyer principals), so the card mirrors
// that rule client-side and renders only for firm members instead of showing
// a card that can only error.

export function isFirmMemberRole(role: string | null | undefined): boolean {
  return role === "firm_admin" || role === "firm_staff";
}

// What the card renders. The distinction that matters: "hidden" is reserved
// for callers the server would 403 (not a firm member — including the server
// saying so itself while /me lags a role change); a TRANSIENT load failure
// for a legitimate firm member is "error", never "hidden" — silently removing
// a settings form because one fetch 500'd would read as the feature not
// existing.
export type PrefsCardState = "hidden" | "loading" | "error" | "form";

export function prefsCardState(args: {
  firmMember: boolean;
  isError: boolean;
  /** HTTP status of the load failure; undefined for a network-level error. */
  errorStatus: number | undefined;
  isSuccess: boolean;
}): PrefsCardState {
  if (!args.firmMember) return "hidden";
  if (args.isError) {
    // 403 is the server's own final answer that this user is not a firm
    // member; anything else (500, network) is a failure worth retrying.
    return args.errorStatus === 403 ? "hidden" : "error";
  }
  return args.isSuccess ? "form" : "loading";
}

export interface StaffPrefsForm {
  digestEnabled: boolean;
  emailEnabled: boolean;
  pushEnabled: boolean;
  email: string;
}

// Server row -> editable form: the nullable email renders as an empty field.
export function prefsFormFromServer(
  prefs: StaffNotificationPreferences,
): StaffPrefsForm {
  return {
    digestEnabled: prefs.digestEnabled,
    emailEnabled: prefs.emailEnabled,
    pushEnabled: prefs.pushEnabled,
    email: prefs.email ?? "",
  };
}

// Form -> wire payload. Every switch is sent explicitly (the PUT merges
// partial input, so omitting one would silently keep a stale value); a blank
// or whitespace-only email is an explicit null (clear), never "".
export function prefsUpdatePayload(
  form: StaffPrefsForm,
): UpdateStaffNotificationPreferencesInput {
  const email = form.email.trim();
  return {
    digestEnabled: form.digestEnabled,
    emailEnabled: form.emailEnabled,
    pushEnabled: form.pushEnabled,
    email: email === "" ? null : email,
  };
}

// ---- Email verification -----------------------------------------------------
// The server stamps emailVerifiedAt for the SAVED address only, so the badge
// derives from what is on screen versus what is saved: editing the email
// field visibly drops back to "unverified" the moment it stops matching the
// verified saved address — the stamp belongs to the old address, not the new
// text.

export type EmailVerification = "none" | "verified" | "unverified";

export function emailVerificationState(args: {
  formEmail: string;
  savedEmail: string | null;
  emailVerifiedAt: string | null;
}): EmailVerification {
  const email = args.formEmail.trim();
  if (email === "") return "none";
  return args.savedEmail !== null &&
    email === args.savedEmail &&
    args.emailVerifiedAt !== null
    ? "verified"
    : "unverified";
}

// The verification code goes to the SAVED address, so requesting one only
// makes sense once the on-screen email IS the saved email — an edited,
// unsaved address must be saved first or the code would land in the old
// inbox.
export function canRequestVerification(args: {
  formEmail: string;
  savedEmail: string | null;
}): boolean {
  const email = args.formEmail.trim();
  return email !== "" && args.savedEmail !== null && email === args.savedEmail;
}

// The wire contract bounds the code at 6–8 characters; enforce the same
// bounds client-side so the confirm button never sends a request the server
// would 400.
export function verificationCodeValid(code: string): boolean {
  const c = code.trim();
  return c.length >= 6 && c.length <= 8;
}

export function StaffNotificationPrefsCard() {
  const { data: me } = useGetMe();
  const firmMember = isFirmMemberRole(me?.role);
  // No automatic retry: a 403 (role changed underneath us) is a final
  // answer. Other failures render the error card below, whose "Try again"
  // is the manual retry.
  const prefs = useGetStaffNotificationPreferences({
    query: {
      queryKey: getGetStaffNotificationPreferencesQueryKey(),
      enabled: firmMember,
      retry: false,
    },
  });
  const state = prefsCardState({
    firmMember,
    isError: prefs.isError,
    errorStatus: errorStatus(prefs.error),
    isSuccess: prefs.isSuccess,
  });
  if (state === "hidden" || state === "loading") return null;
  if (state === "error") {
    // A transient load failure must not silently remove a settings form —
    // same failed-fetch treatment as the card's portfolio neighbours, with
    // the card shell kept so the section does not vanish.
    return (
      <Card data-testid="card-staff-notification-prefs">
        <CardHeader>
          <CardTitle className="text-base">Your notifications</CardTitle>
        </CardHeader>
        <CardContent>
          <QueryError
            thing="your notification preferences"
            onRetry={() => void prefs.refetch()}
          />
        </CardContent>
      </Card>
    );
  }
  if (!prefs.isSuccess) return null; // narrows prefs.data; unreachable at "form"
  // The form body mounts only once the saved row has loaded, so its local
  // state can initialise from real values instead of racing the fetch.
  return <PrefsCardBody initial={prefs.data} />;
}

function PrefsCardBody({ initial }: { initial: StaffNotificationPreferences }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<StaffPrefsForm>(() =>
    prefsFormFromServer(initial),
  );
  // The last row the server confirmed — the anchor for the verification
  // badge (saved email + its verified stamp), updated by both the PUT and a
  // successful code confirmation.
  const [serverPrefs, setServerPrefs] =
    useState<StaffNotificationPreferences>(initial);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = useUpdateStaffNotificationPreferences({
    mutation: {
      onSuccess: (next) => {
        queryClient.setQueryData(
          getGetStaffNotificationPreferencesQueryKey(),
          next,
        );
        setServerPrefs(next);
        setForm(prefsFormFromServer(next));
        setSaved(true);
        setError(null);
      },
      onError: (e) => {
        setSaved(false);
        setError(serverErrorMessage(e) ?? "Could not save your preferences.");
      },
    },
  });

  // Verification flow: request sends a code to the SAVED address (202 —
  // delivery rides the platform's outbound email relay), confirm exchanges
  // the code for a verified stamp on the row.
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const requestVerification = useRequestStaffEmailVerification({
    mutation: {
      onSuccess: () => {
        setCodeSent(true);
        setVerifyError(null);
      },
      onError: (e) =>
        setVerifyError(
          serverErrorMessage(e) ?? "Could not send the verification code.",
        ),
    },
  });
  const confirmEmail = useConfirmStaffEmail({
    mutation: {
      onSuccess: (next) => {
        queryClient.setQueryData(
          getGetStaffNotificationPreferencesQueryKey(),
          next,
        );
        setServerPrefs(next);
        setForm(prefsFormFromServer(next));
        setCodeSent(false);
        setCode("");
        setVerifyError(null);
      },
      onError: (e) =>
        setVerifyError(
          serverErrorMessage(e) ??
            "That code didn't match — check the newest email and try again.",
        ),
    },
  });

  const verification = emailVerificationState({
    formEmail: form.email,
    savedEmail: serverPrefs.email,
    emailVerifiedAt: serverPrefs.emailVerifiedAt,
  });
  const canRequest = canRequestVerification({
    formEmail: form.email,
    savedEmail: serverPrefs.email,
  });

  // Any edit clears the feedback line — "Saved" must only ever describe the
  // values currently on screen.
  const edit = (patch: Partial<StaffPrefsForm>) => {
    setSaved(false);
    setError(null);
    setForm((f) => ({ ...f, ...patch }));
  };

  return (
    <Card data-testid="card-staff-notification-prefs">
      <CardHeader>
        <CardTitle className="text-base">Your notifications</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Delivery of the weekly Clerk digest to you personally. Everything is
          opt-in and off by default — you receive nothing unless you switch it
          on here, and your choices affect nobody else.
        </p>
        <div className="flex items-center justify-between gap-3">
          <div>
            <Label htmlFor="pref-digest">Weekly digest</Label>
            <p className="text-xs text-muted-foreground">
              Get notified when your firm&apos;s weekly digest is ready.
            </p>
          </div>
          <Switch
            id="pref-digest"
            checked={form.digestEnabled}
            onCheckedChange={(v) => edit({ digestEnabled: v === true })}
            data-testid="switch-pref-digest"
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <div>
            <Label htmlFor="pref-email-channel">Email</Label>
            <p className="text-xs text-muted-foreground">
              Deliver by email when the digest is on.
            </p>
          </div>
          <Switch
            id="pref-email-channel"
            checked={form.emailEnabled}
            onCheckedChange={(v) => edit({ emailEnabled: v === true })}
            data-testid="switch-pref-email"
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <div>
            <Label htmlFor="pref-push-channel">Push</Label>
            <p className="text-xs text-muted-foreground">
              Deliver by push notification when the digest is on.
            </p>
          </div>
          <Switch
            id="pref-push-channel"
            checked={form.pushEnabled}
            onCheckedChange={(v) => edit({ pushEnabled: v === true })}
            data-testid="switch-pref-push"
          />
        </div>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Label htmlFor="pref-email">Delivery email (optional)</Label>
            {verification === "verified" ? (
              <span
                className={pillClasses("emerald")}
                data-testid="badge-email-verified"
              >
                Verified
              </span>
            ) : verification === "unverified" ? (
              <span
                className={pillClasses("amber")}
                data-testid="badge-email-unverified"
              >
                Unverified
              </span>
            ) : null}
          </div>
          <Input
            id="pref-email"
            type="email"
            value={form.email}
            placeholder="you@yourfirm.com"
            onChange={(e) => edit({ email: e.target.value })}
            data-testid="input-pref-email"
          />
          <p className="text-xs text-muted-foreground">
            Leave blank to clear it.
          </p>
        </div>
        {verification === "unverified" && (
          <div className="space-y-2" data-testid="section-email-verification">
            {canRequest ? (
              <>
                <div className="flex items-center gap-3 flex-wrap">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => requestVerification.mutate()}
                    disabled={requestVerification.isPending}
                    data-testid="button-send-verification"
                  >
                    {requestVerification.isPending
                      ? "Sending…"
                      : "Send verification code"}
                  </Button>
                  {codeSent && (
                    <p
                      className="text-xs text-muted-foreground"
                      data-testid="text-verification-sent"
                    >
                      Check your inbox — a code is on its way. Delivery needs
                      the platform&apos;s outbound email relay; if nothing
                      arrives, ask your operator whether it is configured.
                    </p>
                  )}
                </div>
                {codeSent && (
                  <div className="flex items-center gap-2">
                    <Input
                      value={code}
                      onChange={(e) => {
                        setCode(e.target.value);
                        setVerifyError(null);
                      }}
                      placeholder="6-digit code"
                      maxLength={8}
                      className="w-36"
                      aria-label="Verification code"
                      data-testid="input-verification-code"
                    />
                    <Button
                      size="sm"
                      onClick={() =>
                        confirmEmail.mutate({ data: { code: code.trim() } })
                      }
                      disabled={
                        !verificationCodeValid(code) || confirmEmail.isPending
                      }
                      data-testid="button-confirm-verification"
                    >
                      {confirmEmail.isPending ? "Confirming…" : "Confirm"}
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <p
                className="text-xs text-muted-foreground"
                data-testid="text-verification-save-first"
              >
                Save your preferences first — the verification code goes to
                the saved address.
              </p>
            )}
            {verifyError && (
              <p
                className="text-sm text-destructive"
                data-testid="text-verification-error"
              >
                {verifyError}
              </p>
            )}
          </div>
        )}
        <div className="flex items-center gap-3 flex-wrap">
          <Button
            size="sm"
            onClick={() => update.mutate({ data: prefsUpdatePayload(form) })}
            disabled={update.isPending}
            data-testid="button-save-prefs"
          >
            {update.isPending ? "Saving…" : "Save preferences"}
          </Button>
          {saved && (
            <p
              className="text-sm text-emerald-700 dark:text-emerald-400"
              data-testid="text-prefs-saved"
            >
              Saved
            </p>
          )}
          {error && (
            <p className="text-sm text-destructive" data-testid="text-prefs-error">
              {error}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
