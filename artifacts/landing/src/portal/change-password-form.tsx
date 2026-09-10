import { useEffect, useRef, useState, type FormEvent } from "react";
import { useChangePassword } from "@workspace/api-client-react";
import { AlertCircle, CheckCircle2, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { serverErrorFrom } from "@/lib/errors";

export function ChangePasswordForm() {
  const changePassword = useChangePassword();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<{
    message: string;
    field: "current" | "new" | null;
  } | null>(null);
  const [done, setDone] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCloseTimer = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  // Never let the auto-close timer fire after unmount (sign-out mid-toast).
  useEffect(() => clearCloseTimer, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await changePassword.mutateAsync({
        data: { currentPassword: current, newPassword: next },
      });
      setDone(true);
      setCurrent("");
      setNext("");
      clearCloseTimer();
      closeTimer.current = setTimeout(() => {
        setDone(false);
        setOpen(false);
      }, 2500);
    } catch (err) {
      const status = (err as { status?: number })?.status;
      const serverError = serverErrorFrom(err);
      if (status === 401) {
        setError({
          message: "Current password is incorrect.",
          field: "current",
        });
        document.getElementById("cp-current")?.focus();
      } else if (status === 400) {
        setError({
          message: serverError ?? "New password must be at least 8 characters.",
          field: "new",
        });
        document.getElementById("cp-new")?.focus();
      } else {
        setError({
          message: "Could not change the password. Try again.",
          field: null,
        });
      }
    }
  };

  if (!open) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => {
          clearCloseTimer();
          setDone(false);
          setOpen(true);
        }}
        className="mt-2 -ml-2 text-muted-foreground hover:text-foreground"
        data-testid="button-show-change-password"
      >
        <KeyRound className="h-3.5 w-3.5" aria-hidden="true" /> Change password
      </Button>
    );
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-3 rounded-lg border p-3">
      <p className="text-xs font-medium">Change password</p>
      <div className="space-y-1.5">
        <Label htmlFor="cp-current" className="text-xs">
          Current password
        </Label>
        <Input
          id="cp-current"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
          aria-invalid={error?.field === "current" ? true : undefined}
          aria-describedby={
            error && error.field !== "new" ? "cp-error" : undefined
          }
          data-testid="input-current-password"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="cp-new" className="text-xs">
          New password
        </Label>
        <Input
          id="cp-new"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          required
          minLength={8}
          aria-invalid={error?.field === "new" ? true : undefined}
          aria-describedby={
            error?.field === "new" ? "cp-new-help cp-error" : "cp-new-help"
          }
          data-testid="input-new-password"
        />
        <p id="cp-new-help" className="text-xs text-muted-foreground">
          At least 8 characters
        </p>
      </div>
      {error && (
        <p
          role="alert"
          id="cp-error"
          className="flex items-start gap-1.5 text-xs text-destructive"
        >
          <AlertCircle
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
          />{" "}
          {error.message}
        </p>
      )}
      {done && (
        <p
          role="status"
          className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400"
          data-testid="text-password-changed"
        >
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> Password
          changed.
        </p>
      )}
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={changePassword.isPending || !current || next.length < 8}
          data-testid="button-change-password"
        >
          {changePassword.isPending ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            clearCloseTimer();
            setOpen(false);
            setError(null);
            setDone(false);
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
