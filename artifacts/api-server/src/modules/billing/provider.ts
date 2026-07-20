import { randomUUID } from "node:crypto";
import { DomainError } from "../errors";

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
}

export interface PaymentInitResult {
  providerRef: string;
  checkoutUrl: string | null;
}

export type PaymentProvider = (
  input: PaymentInit,
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

// FAIL CLOSED when a relay is configured but broken: an intent we could not
// hand to the provider must never be stored as pending (nobody could ever
// pay it, and the one-live-intent index would then block the month until an
// operator noticed). The thrown 502 rolls the request back; the simulator
// path can never fail, so dark deployments are unaffected.
const defaultProvider: PaymentProvider = async (input) => {
  const url = process.env.PAYMENT_PROVIDER_URL;
  if (!url) return simulatorProvider(input);
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const token = process.env.PAYMENT_PROVIDER_TOKEN;
  if (token) headers["x-op-token"] = token;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "payment_init", ...input }),
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
  } catch (err) {
    throw new DomainError(
      "PAYMENT_PROVIDER",
      `Payment provider unreachable: ${err instanceof Error ? err.message : String(err)}`,
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
    typeof payload?.providerRef === "string" && payload.providerRef.length > 0
      ? payload.providerRef
      : null;
  if (!providerRef) {
    throw new DomainError(
      "PAYMENT_PROVIDER",
      "Payment provider returned no reference",
      502,
    );
  }
  return {
    providerRef,
    checkoutUrl:
      typeof payload?.checkoutUrl === "string" && payload.checkoutUrl.length > 0
        ? payload.checkoutUrl
        : null,
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
): Promise<PaymentInitResult> {
  return provider(input);
}
