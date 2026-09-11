import { pillClasses } from "@workspace/format";
import {
  AlertCircle,
  CheckCircle2,
  LockKeyhole,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { TotpEnabled } from "./totp-enabled";
import { TotpEnrolment } from "./totp-enrolment";
import { useTotpSecurity } from "./use-totp-security";

// Two-factor lifecycle for the signed-in account: status → enrol (secret,
// otpauth URI and recovery codes shown exactly once) → activate with a live
// code (revokes every other session; this one survives on the re-issued
// cookie) → disable, which demands the password AND a code. The lifecycle
// state itself steps through the pure reducer in lib/totp-card so the
// transitions are unit-testable; this component keeps only the input text
// and the react-query effects.
export function TotpSecurityCard() {
  const totp = useTotpSecurity();
  const {
    statusQuery,
    info,
    setup,
    material,
    setupError,
    justDisabled,
    begin,
  } = totp;

  return (
    <div className="mt-3 rounded-lg bg-muted/60 p-3" data-testid="card-totp">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <ShieldCheck
            className="h-4 w-4 text-teal-600 dark:text-teal-400"
            aria-hidden="true"
          />
          Two-step verification
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
        <TotpEnrolment totp={totp} material={material} />
      ) : info?.enabled ? (
        <TotpEnabled totp={totp} info={info} />
      ) : info ? (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-muted-foreground">
            Add a code from an authenticator app to your password when you sign
            in.
          </p>
          {justDisabled && (
            <p
              role="status"
              className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400"
              data-testid="text-totp-disabled"
            >
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />{" "}
              Two-step verification is off.
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
            {setup.isPending ? "Preparing…" : "Set up two-step verification"}
          </Button>
        </div>
      ) : statusQuery.isError ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Could not check two-step verification. Refresh the page to try again.
        </p>
      ) : null}
    </div>
  );
}
