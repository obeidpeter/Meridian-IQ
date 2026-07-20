// The TOTP security card's lifecycle state, extracted as a pure reducer so
// the transitions can be unit tested without mounting the portal. The card
// component owns the input text (activation code, disable password/code) and
// the react-query effects (status refresh on a begin failure, setQueryData
// on success); everything that decides WHAT the card shows next lives here.

import type { TotpSetup } from "@workspace/api-client-react";

export interface TotpCardState {
  /**
   * Enrolment material (secret, otpauth URI, recovery codes) — exists only
   * while the setup panel is open; shown once, gone on cancel/activate.
   */
  material: TotpSetup | null;
  /** Inline error for the setup/activation flow. */
  setupError: string | null;
  /** "Two-factor is on…" confirmation, shown right after activation. */
  justActivated: boolean;
  /** "Two-factor turned off." confirmation, shown right after disabling. */
  justDisabled: boolean;
  /** Whether the disable confirmation form is open. */
  disableOpen: boolean;
  /** Inline error for the disable flow. */
  disableError: string | null;
}

export const TOTP_CARD_INITIAL: TotpCardState = {
  material: null,
  setupError: null,
  justActivated: false,
  justDisabled: false,
  disableOpen: false,
  disableError: null,
};

export type TotpCardEvent =
  /** Enrolment began: the server minted setup material. */
  | { type: "begin-success"; material: TotpSetup }
  /**
   * Enrolment failed — including the 409 "already enabled elsewhere" race,
   * where the CALLER also refreshes the status query so the card snaps to
   * the truth; the reducer's job is just to surface the message with the
   * setup panel closed.
   */
  | { type: "begin-error"; message: string }
  | { type: "cancel-setup" }
  /** A live code verified: two-factor is on, the material is gone for good. */
  | { type: "activate-success" }
  | { type: "activate-error"; message: string }
  | { type: "disable-open" }
  | { type: "disable-cancel" }
  | { type: "disable-success" }
  | { type: "disable-error"; message: string };

export function totpCardTransition(
  state: TotpCardState,
  event: TotpCardEvent,
): TotpCardState {
  switch (event.type) {
    case "begin-success":
      // Starting a fresh enrolment clears any stale confirmations/errors.
      return {
        ...state,
        material: event.material,
        setupError: null,
        justDisabled: false,
      };
    case "begin-error":
      return {
        ...state,
        material: null,
        setupError: event.message,
        justDisabled: false,
      };
    case "cancel-setup":
      return { ...state, material: null, setupError: null };
    case "activate-success":
      return {
        ...state,
        material: null,
        setupError: null,
        justActivated: true,
        justDisabled: false,
      };
    case "activate-error":
      return { ...state, setupError: event.message };
    case "disable-open":
      return { ...state, disableOpen: true, disableError: null };
    case "disable-cancel":
      return { ...state, disableOpen: false, disableError: null };
    case "disable-success":
      return {
        ...state,
        disableOpen: false,
        disableError: null,
        justActivated: false,
        justDisabled: true,
      };
    case "disable-error":
      return { ...state, disableError: event.message };
  }
}
