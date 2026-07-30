import { randomBytes } from "node:crypto";
import { DomainError } from "../errors";

// Collection provider seam (billing provider.ts's PaymentProvider idiom):
// every virtual-account provision flows through ONE function, and the
// COLLECTION_PROVIDER_URL relay below is the swap point — tests and a future
// real bank/PSP integration point it at their own endpoint without touching
// the account semantics.
//
// DARK BY DEFAULT: with no COLLECTION_PROVIDER_URL configured every provision
// stays in-process on the simulator — a reference is minted, no real virtual
// account exists, and the inbound webhook (itself fail-closed behind
// COLLECTION_WEBHOOK_TOKEN) is the only way a payment ever lands on it.
// Setting the env var lights a generic JSON relay: the provision facts
// {firmId, clientPartyId, label} are POSTed to the URL (x-op-token carries
// COLLECTION_PROVIDER_TOKEN when set — the same shared-secret shape as the
// messaging relay), and the relay owns the real provider conversation
// (create virtual account) on ITS side of the wire, answering
// {accountReference}. Env is read per call so tests and operators can flip it
// without a restart.

export interface CollectionProvisionInput {
  firmId: string;
  clientPartyId: string;
  label: string | null;
}

export interface CollectionProvisionResult {
  accountReference: string;
}

export type CollectionProvider = (
  input: CollectionProvisionInput,
) => Promise<CollectionProvisionResult>;

// Simulated provider: mints a reference, provisions nothing. Inbound payments
// arrive only through the webhook (or a real relay replaces this entirely).
const simulatorProvider: CollectionProvider = async () => ({
  accountReference: `CA-${randomBytes(6).toString("hex").toUpperCase()}`,
});

// Hard ceiling on any relay round-trip (messaging.ts's RELAY_TIMEOUT_MS
// posture): provisioning runs inside a request handler, and a relay that
// accepts the TCP connection but never answers must fail the request, not
// pin it (fetch has no default timeout).
const RELAY_TIMEOUT_MS = 5_000;

// FAIL CLOSED when a relay is configured but broken: an account we could not
// provision at the provider must never be stored (no payment could ever reach
// its reference, and the dead row would shadow the client's real account when
// an operator retried). The thrown 502 rolls the request back; the simulator
// path can never fail, so dark deployments are unaffected.
const defaultProvider: CollectionProvider = async (input) => {
  const url = process.env.COLLECTION_PROVIDER_URL;
  if (!url) return simulatorProvider(input);
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const token = process.env.COLLECTION_PROVIDER_TOKEN;
  if (token) headers["x-op-token"] = token;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "collection_provision", ...input }),
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
  } catch (err) {
    throw new DomainError(
      "COLLECTION_PROVIDER",
      `Collection provider unreachable: ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  }
  if (!resp.ok) {
    throw new DomainError(
      "COLLECTION_PROVIDER",
      `Collection provider returned ${resp.status}`,
      502,
    );
  }
  const payload = (await resp.json().catch(() => null)) as {
    accountReference?: unknown;
  } | null;
  const accountReference =
    typeof payload?.accountReference === "string" &&
    payload.accountReference.length > 0
      ? payload.accountReference
      : null;
  if (!accountReference) {
    throw new DomainError(
      "COLLECTION_PROVIDER",
      "Collection provider returned no reference",
      502,
    );
  }
  return { accountReference };
};

// The one call site seam consumers use.
export async function provisionAccount(
  input: CollectionProvisionInput,
): Promise<CollectionProvisionResult> {
  return defaultProvider(input);
}
