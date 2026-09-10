import { AlertCircle, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CopyButton } from "./copy-button";
import type { TotpSecurity } from "./use-totp-security";

// Enrolment material shown exactly once: QR code, secret, otpauth link, the
// recovery codes and the live-code activation form.
export function TotpEnrolment({
  totp,
  material,
}: {
  totp: TotpSecurity;
  material: NonNullable<TotpSecurity["material"]>;
}) {
  const {
    qrDataUrl,
    recoveryAcknowledged,
    setRecoveryAcknowledged,
    downloadRecoveryCodes,
    onActivate,
    activateCode,
    setActivateCode,
    setupError,
    activate,
    dispatch,
  } = totp;

  return (
    <div className="mt-3 space-y-3">
      <p className="text-xs text-muted-foreground">
        Scan the QR code with your authenticator app. If scanning is not
        available, use the secret or setup link, then confirm with a live code.
      </p>
      {qrDataUrl && (
        <div className="flex justify-center rounded-md border bg-white p-3">
          <img
            src={qrDataUrl}
            width={192}
            height={192}
            alt="QR code for adding Valo to an authenticator app"
            data-testid="image-totp-qr"
          />
        </div>
      )}
      <div className="rounded-md border bg-background p-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-semibold uppercase text-muted-foreground">
            Secret
          </p>
          <CopyButton value={material.secret} label="Copy secret" />
        </div>
        <code
          className="block break-all font-mono text-xs"
          data-testid="text-totp-secret"
        >
          {material.secret}
        </code>
      </div>
      <div className="rounded-md border bg-background p-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-semibold uppercase text-muted-foreground">
            Setup link (otpauth)
          </p>
          <CopyButton value={material.otpauthUri} label="Copy otpauth URI" />
        </div>
        <code className="block break-all font-mono text-[11px] text-muted-foreground">
          {material.otpauthUri}
        </code>
      </div>
      <div className="rounded-md border border-amber-300 bg-amber-50 p-2.5 dark:border-amber-700 dark:bg-amber-950/40">
        <p className="flex items-start gap-1.5 text-xs font-semibold text-amber-900 dark:text-amber-200">
          <AlertCircle
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
          />
          These recovery codes are shown once — right now. Store them somewhere
          safe before you continue. Each code signs you in exactly once if you
          ever lose your authenticator.
        </p>
        <ul
          className="mt-2 grid grid-cols-2 gap-1 font-mono text-xs text-amber-900 dark:text-amber-100"
          data-testid="list-recovery-codes"
        >
          {material.recoveryCodes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
        <div className="mt-2 flex flex-wrap gap-2">
          <CopyButton
            value={material.recoveryCodes.join("\n")}
            label="Copy recovery codes"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={downloadRecoveryCodes}
            data-testid="button-download-recovery-codes"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            Download
          </Button>
        </div>
        <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs font-medium text-amber-950 dark:text-amber-100">
          <input
            type="checkbox"
            checked={recoveryAcknowledged}
            onChange={(event) => setRecoveryAcknowledged(event.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-primary"
            data-testid="checkbox-recovery-saved"
          />
          I saved these recovery codes somewhere secure.
        </label>
      </div>
      <form onSubmit={onActivate} className="space-y-1.5">
        <Label htmlFor="totp-activate" className="text-xs">
          Code from your authenticator app
        </Label>
        <Input
          id="totp-activate"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={activateCode}
          onChange={(e) => setActivateCode(e.target.value)}
          required
          minLength={6}
          maxLength={8}
          placeholder="123456"
          className="font-mono"
          aria-invalid={setupError ? true : undefined}
          aria-describedby={setupError ? "totp-setup-error" : undefined}
          data-testid="input-totp-activate"
        />
        {setupError && (
          <p
            role="alert"
            id="totp-setup-error"
            className="flex items-start gap-1.5 text-xs text-destructive"
          >
            <AlertCircle
              className="mt-0.5 h-3.5 w-3.5 shrink-0"
              aria-hidden="true"
            />{" "}
            {setupError}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Activating signs out every other session on this account.
        </p>
        <div className="flex gap-2 pt-1">
          <Button
            type="submit"
            size="sm"
            disabled={
              activate.isPending ||
              activateCode.trim().length < 6 ||
              !recoveryAcknowledged
            }
            data-testid="button-totp-activate"
          >
            {activate.isPending ? "Verifying…" : "Verify & turn on"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              dispatch({ type: "cancel-setup" });
              setActivateCode("");
            }}
          >
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
