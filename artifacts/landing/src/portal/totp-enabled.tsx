import { AlertCircle, CheckCircle2, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { TotpSecurity } from "./use-totp-security";

function TotpDisableForm({ totp }: { totp: TotpSecurity }) {
  const {
    onDisable,
    disablePassword,
    setDisablePassword,
    disableCode,
    setDisableCode,
    disableError,
    disable,
    dispatch,
  } = totp;

  return (
    <form onSubmit={onDisable} className="space-y-3 rounded-lg border p-3">
      <p className="text-xs font-medium">Turn off two-step verification</p>
      <p className="text-xs text-muted-foreground">
        Enter your password and a current authenticator code or recovery code.
        This signs you out of all other browsers and mobile apps.
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
          aria-describedby={disableError ? "totp-disable-error" : undefined}
          data-testid="input-totp-disable-password"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="totp-disable-code" className="text-xs">
          Verification or recovery code
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
          aria-describedby={disableError ? "totp-disable-error" : undefined}
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
  );
}

// Two-factor is on: the status line, the recovery-code count and the
// password-and-code form that turns it off.
export function TotpEnabled({
  totp,
  info,
}: {
  totp: TotpSecurity;
  info: NonNullable<TotpSecurity["info"]>;
}) {
  const { justActivated, disableOpen, dispatch } = totp;

  return (
    <div className="mt-2 space-y-2">
      <p
        className="text-xs text-muted-foreground"
        data-testid="text-totp-enabled"
      >
        Sign-in requires your password and an authenticator or recovery code
        {info.enabledAt
          ? `. On since ${new Date(info.enabledAt).toLocaleDateString(
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
        {(info.recoveryCodesRemaining ?? 0) === 1 ? "" : "s"} remaining.
      </p>
      {justActivated && (
        <p
          role="status"
          className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400"
          data-testid="text-totp-activated"
        >
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
          Two-step verification is on. You have been signed out of all other
          browsers and mobile apps.
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
          two-step verification
        </Button>
      ) : (
        <TotpDisableForm totp={totp} />
      )}
    </div>
  );
}
