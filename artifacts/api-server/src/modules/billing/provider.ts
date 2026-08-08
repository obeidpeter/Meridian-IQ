import { randomUUID } from "node:crypto";
import { DomainError } from "../errors";
import { logger } from "../../lib/logger";

// Payment provider seam (messaging.ts's MessageTransport / push.ts's
// PushTransport idiom): every payment initialization flows through ONE
// injectable function, so tests and a future real Paystack integration swap
// the provider without touching the intent semantics.
//
// DARK BY DEFAULT: with no PAYMENT_PROVIDER_URL configured every
// initialization stays in-process on the simulator — a reference is minted,
// no checkout page exists, and the confirmation webhook (itself fail-closed
// behind PAYMENT_WEBHOOK_TOKEN) is the only way an intent ever settles.
// Setting the env var lights a generic JSON relay: the intent facts
// {firmId, monthStart, amountNgn} are POSTed to the URL (x-op-token carries
// PAYMENT_PROVIDER_TOKEN when set — the same shared-secret shape as the
// messaging relay), and the relay owns the real provider conversation
// (initialize transaction, hosted checkout) on ITS side of the wire,
// answering {providerRef, checkoutUrl?}. Env is read per call so tests and
// operators can flip it without a restart.

export interface PaymentInit {
  firmId: string;
  // YYYY-MM-01 closed Lagos billing month.
  monthStart: string;
  // 2dp naira string — computeBillingFee's total.
  amountNgn: string;
  idempotencyKey: string;
}

export interface PaymentInitResult {
  providerRef: string;
  checkoutUrl: string | null;
}

export type PaymentProvider = (
  input: PaymentInit,
  signal?: AbortSignal,
) => Promise<PaymentInitResult>;

// Simulated provider: mints a reference, offers no checkout page. The
// operator settles the intent through the confirmation webhook (or a real
// relay replaces this entirely).
const simulatorProvider: PaymentProvider = async () => ({
  providerRef: `sim_${randomUUID()}`,
  checkoutUrl: null,
});

// Hard ceiling on any relay round-trip (messaging.ts's RELAY_TIMEOUT_MS
// posture): initialization runs inside a request handler, and a relay that
// accepts the TCP connection but never answers must fail the request, not
// pin it (fetch has no default timeout).
const RELAY_TIMEOUT_MS = 5_000;

// FAIL CLOSED when a configured relay is broken. The service records a
// durable, resumable reservation before this call; a 502 leaves that row
// pending so a retry uses the same provider idempotency key instead of
// creating a second external payment.
function providerSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(RELAY_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function vettedCheckoutUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.length > 2_048) {
    throw new DomainError(
      "PAYMENT_PROVIDER",
      "Payment provider returned an invalid checkout URL",
      502,
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DomainError(
      "PAYMENT_PROVIDER",
      "Payment provider returned an invalid checkout URL",
      502,
    );
  }
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(process.env.NODE_ENV !== "production" && url.protocol === "http:"))
  ) {
    throw new DomainError(
      "PAYMENT_PROVIDER",
      "Payment provider returned an insecure checkout URL",
      502,
    );
  }
  return url.toString();
}

const defaultProvider: PaymentProvider = async (input, signal) => {
  const url = process.env.PAYMENT_PROVIDER_URL;
  if (!url) return simulatorProvider(input);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "idempotency-key": input.idempotencyKey,
  };
  const token = process.env.PAYMENT_PROVIDER_TOKEN;
  if (token) headers["x-op-token"] = token;
  const { idempotencyKey: _idempotencyKey, ...paymentFacts } = input;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "payment_init", ...paymentFacts }),
      signal: providerSignal(signal),
    });
  } catch (err) {
    logger.error({ err }, "Payment provider request failed");
    throw new DomainError(
      "PAYMENT_PROVIDER",
      "Payment provider is unreachable",
      502,
    );
  }
  if (!resp.ok) {
    throw new DomainError(
      "PAYMENT_PROVIDER",
      `Payment provider returned ${resp.status}`,
      502,
    );
  }
  const payload = (await resp.json().catch(() => null)) as {
    providerRef?: unknown;
    checkoutUrl?: unknown;
  } | null;
  const providerRef =
    typeof payload?.providerRef === "string" ? payload.providerRef.trim() : "";
  if (
    !providerRef ||
    providerRef.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(providerRef)
  ) {
    throw new DomainError(
      "PAYMENT_PROVIDER",
      "Payment provider returned no reference",
      502,
    );
  }
  return {
    providerRef,
    checkoutUrl: vettedCheckoutUrl(payload?.checkoutUrl),
  };
};

let provider: PaymentProvider = defaultProvider;

export function setPaymentProvider(p: PaymentProvider): void {
  provider = p;
}

export function resetPaymentProvider(): void {
  provider = defaultProvider;
}

// The one call site seam consumers use; keeps the module-level `let` private.
export async function initProviderPayment(
  input: PaymentInit,
  signal?: AbortSignal,
): Promise<PaymentInitResult> {
  return provider(input, signal);
}
