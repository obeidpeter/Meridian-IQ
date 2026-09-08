// Shared by load probes and browser API fixtures; CSRF is required for bearer clients too.
// The fixtures send the Valo header spelling (R112); the retained x-meridian-*
// aliases are pinned by the e2e brand-compatibility journey, not by every call.
import { randomUUID } from "node:crypto";

export const CSRF = Object.freeze({ "x-valo-csrf": "1" });
export function commandHeaders(idempotencyKey = randomUUID()) {
  return {
    ...CSRF,
    "content-type": "application/json",
    "x-idempotency-key": idempotencyKey,
  };
}
export const MOBILE_LOGIN_HEADERS = Object.freeze({
  ...CSRF,
  "content-type": "application/json",
  "x-valo-client": "mobile",
});
