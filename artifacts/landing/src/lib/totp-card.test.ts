import { describe, expect, test } from "vitest";
import type { TotpSetup } from "@workspace/api-client-react";
import {
  TOTP_CARD_INITIAL,
  totpCardTransition,
  type TotpCardState,
} from "./totp-card";

const material: TotpSetup = {
  secret: "JBSWY3DPEHPK3PXP",
  otpauthUri: "otpauth://totp/MeridianIQ:user?secret=JBSWY3DPEHPK3PXP",
  recoveryCodes: ["aaaa-bbbb", "cccc-dddd"],
};

const step = (state: TotpCardState, ...events: Parameters<typeof totpCardTransition>[1][]) =>
  events.reduce(totpCardTransition, state);

describe("totpCardTransition", () => {
  test("begin-success opens the setup panel with the minted material", () => {
    const s = step(TOTP_CARD_INITIAL, {
      type: "begin-success",
      material,
    });
    expect(s.material).toBe(material);
    expect(s.setupError).toBeNull();
  });

  test("the 409 refresh path: begin-error keeps enrolment closed and surfaces the message", () => {
    // Another surface enabled two-factor already — the component refreshes
    // the status query; the card must NOT show setup material.
    const s = step(TOTP_CARD_INITIAL, {
      type: "begin-error",
      message: "Two-factor is already enabled on this account.",
    });
    expect(s.material).toBeNull();
    expect(s.setupError).toContain("already enabled");
  });

  test("activate → justActivated: material is gone for good, error cleared", () => {
    const s = step(
      TOTP_CARD_INITIAL,
      { type: "begin-success", material },
      { type: "activate-error", message: "That code did not match." },
      { type: "activate-success" },
    );
    expect(s.material).toBeNull();
    expect(s.setupError).toBeNull();
    expect(s.justActivated).toBe(true);
    expect(s.justDisabled).toBe(false);
  });

  test("activate-error keeps the setup panel open for another attempt", () => {
    const s = step(
      TOTP_CARD_INITIAL,
      { type: "begin-success", material },
      { type: "activate-error", message: "That code did not match." },
    );
    expect(s.material).toBe(material);
    expect(s.setupError).toBe("That code did not match.");
    expect(s.justActivated).toBe(false);
  });

  test("cancel-setup discards the material and any error", () => {
    const s = step(
      TOTP_CARD_INITIAL,
      { type: "begin-success", material },
      { type: "activate-error", message: "nope" },
      { type: "cancel-setup" },
    );
    expect(s.material).toBeNull();
    expect(s.setupError).toBeNull();
  });

  test("the disable flow: open → error → success flips the confirmations", () => {
    const enabled = step(
      TOTP_CARD_INITIAL,
      { type: "begin-success", material },
      { type: "activate-success" },
    );
    const opened = step(enabled, { type: "disable-open" });
    expect(opened.disableOpen).toBe(true);
    expect(opened.disableError).toBeNull();

    const failed = step(opened, {
      type: "disable-error",
      message: "Invalid password or code.",
    });
    expect(failed.disableOpen).toBe(true);
    expect(failed.disableError).toBe("Invalid password or code.");

    const done = step(failed, { type: "disable-success" });
    expect(done.disableOpen).toBe(false);
    expect(done.disableError).toBeNull();
    expect(done.justActivated).toBe(false);
    expect(done.justDisabled).toBe(true);
  });

  test("disable-cancel closes the form without touching the confirmations", () => {
    const s = step(
      TOTP_CARD_INITIAL,
      { type: "disable-open" },
      { type: "disable-error", message: "nope" },
      { type: "disable-cancel" },
    );
    expect(s.disableOpen).toBe(false);
    expect(s.disableError).toBeNull();
  });

  test("a fresh enrolment clears the just-disabled note", () => {
    const s = step(
      TOTP_CARD_INITIAL,
      { type: "disable-open" },
      { type: "disable-success" },
      { type: "begin-success", material },
    );
    expect(s.justDisabled).toBe(false);
    expect(s.material).toBe(material);
  });
});
