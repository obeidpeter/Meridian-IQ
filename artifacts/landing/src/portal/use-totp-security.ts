// The two-factor card's state and handlers (R126 lifted them out of the
// TotpSecurityCard component so the enrolment and enabled branches can be
// separate components). Hooks, state, the qrcode effect (a literal dynamic
// import: the qrcode chunk stays lazy) and handlers are declared in the same
// order the component declared them; the bag is returned as-is.

import { useEffect, useReducer, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetTotpStatus,
  useSetupTotp,
  useActivateTotp,
  useDisableTotp,
  getGetTotpStatusQueryKey,
} from "@workspace/api-client-react";
import { serverErrorFrom } from "@/lib/errors";
import { TOTP_CARD_INITIAL, totpCardTransition } from "@/lib/totp-card";

export type TotpSecurity = ReturnType<typeof useTotpSecurity>;

export function useTotpSecurity() {
  const qc = useQueryClient();
  const statusQuery = useGetTotpStatus({
    query: { queryKey: getGetTotpStatusQueryKey() },
  });
  const setup = useSetupTotp();
  const activate = useActivateTotp();
  const disable = useDisableTotp();

  // Enrolment material exists only in this component's state — shown once,
  // gone on unmount. Only hashes persist server-side.
  const [card, dispatch] = useReducer(totpCardTransition, TOTP_CARD_INITIAL);
  const {
    material,
    setupError,
    justActivated,
    justDisabled,
    disableOpen,
    disableError,
  } = card;
  const [activateCode, setActivateCode] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [recoveryAcknowledged, setRecoveryAcknowledged] = useState(false);
  const [disablePassword, setDisablePassword] = useState("");
  const [disableCode, setDisableCode] = useState("");

  useEffect(() => {
    let active = true;
    setQrDataUrl("");
    setRecoveryAcknowledged(false);
    if (!material)
      return () => {
        active = false;
      };
    void import("qrcode")
      .then(({ default: QRCode }) =>
        QRCode.toDataURL(material.otpauthUri, {
          width: 192,
          margin: 1,
          errorCorrectionLevel: "M",
          color: { dark: "#0e4c45", light: "#ffffff" },
        }),
      )
      .then((url) => {
        if (active) setQrDataUrl(url);
      })
      .catch(() => {
        if (active) setQrDataUrl("");
      });
    return () => {
      active = false;
    };
  }, [material]);

  const downloadRecoveryCodes = () => {
    if (!material) return;
    const blob = new Blob(
      [
        "Valo two-factor recovery codes\n",
        "Store these securely. Each code works once.\n\n",
        material.recoveryCodes.join("\n"),
        "\n",
      ],
      { type: "text/plain;charset=utf-8" },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "valo-recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  };

  const begin = async () => {
    try {
      const m = await setup.mutateAsync();
      dispatch({ type: "begin-success", material: m });
      setActivateCode("");
    } catch (err) {
      // A 409 means another surface already enabled it — refresh the truth.
      await qc.invalidateQueries({ queryKey: getGetTotpStatusQueryKey() });
      dispatch({
        type: "begin-error",
        message:
          serverErrorFrom(err) ?? "Could not start enrolment. Try again.",
      });
    }
  };

  const onActivate = async (e: FormEvent) => {
    e.preventDefault();
    if (!recoveryAcknowledged) return;
    try {
      const status = await activate.mutateAsync({
        data: { code: activateCode.trim() },
      });
      // The response re-issued this session's cookie under the bumped epoch —
      // every OTHER session is now signed out; this panel carries on.
      qc.setQueryData(getGetTotpStatusQueryKey(), status);
      dispatch({ type: "activate-success" });
      setActivateCode("");
    } catch (err) {
      dispatch({
        type: "activate-error",
        message:
          serverErrorFrom(err) ??
          "That code did not match. Check the authenticator app and try again.",
      });
      document.getElementById("totp-activate")?.focus();
    }
  };

  const onDisable = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const status = await disable.mutateAsync({
        data: { password: disablePassword, code: disableCode.trim() },
      });
      qc.setQueryData(getGetTotpStatusQueryKey(), status);
      dispatch({ type: "disable-success" });
      setDisablePassword("");
      setDisableCode("");
    } catch (err) {
      const status = (err as { status?: number })?.status;
      dispatch({
        type: "disable-error",
        message:
          status === 401
            ? "Invalid password or code."
            : (serverErrorFrom(err) ??
              "Could not turn off two-factor. Try again."),
      });
    }
  };

  const info = statusQuery.data;

  return {
    statusQuery,
    info,
    setup,
    activate,
    disable,
    material,
    setupError,
    justActivated,
    justDisabled,
    disableOpen,
    disableError,
    dispatch,
    activateCode,
    setActivateCode,
    qrDataUrl,
    recoveryAcknowledged,
    setRecoveryAcknowledged,
    disablePassword,
    setDisablePassword,
    disableCode,
    setDisableCode,
    downloadRecoveryCodes,
    begin,
    onActivate,
    onDisable,
  };
}
