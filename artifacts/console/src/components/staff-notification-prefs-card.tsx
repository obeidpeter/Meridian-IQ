import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMe,
  useGetStaffNotificationPreferences,
  useUpdateStaffNotificationPreferences,
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
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = useUpdateStaffNotificationPreferences({
    mutation: {
      onSuccess: (next) => {
        queryClient.setQueryData(
          getGetStaffNotificationPreferencesQueryKey(),
          next,
        );
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
          <Label htmlFor="pref-email">Delivery email (optional)</Label>
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
