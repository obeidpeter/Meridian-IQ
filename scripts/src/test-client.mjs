// Shared by load probes and browser API fixtures; CSRF is required for bearer clients too.
import { randomUUID } from "node:crypto";

export const CSRF = Object.freeze({ "x-meridian-csrf": "1" });
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
  "x-meridian-client": "mobile",
});
