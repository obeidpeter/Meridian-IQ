import type { Response } from "express";

// Shared 429 shape for the raw-pool credential throttles (login, TOTP
// challenge/disable, change-password, staff email verification): Retry-After
// carries seconds, the message speaks minutes. The throttle checks themselves
// (bump-first vs check-first) stay at the call sites — only the refusal is
// shared.
export function sendThrottled429(
  res: Response,
  retryAfterSeconds: number,
  subject: string,
): void {
  res.setHeader("Retry-After", String(retryAfterSeconds));
  res.status(429).json({
    error: `${subject}. Try again in ${Math.ceil(retryAfterSeconds / 60)} minute(s).`,
  });
}
