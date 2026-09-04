import { DomainError } from "../errors";
import { logger } from "../../lib/logger";

export interface InvoicePaymentInit {
  invoiceId: string;
  invoiceNumber: string;
  amount: string;
  currency: string;
  idempotencyKey: string;
}

export interface InvoicePaymentInitResult {
  provider: string;
  providerReference: string;
  checkoutUrl: string;
  expiresAt: Date | null;
}

function validCheckoutUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new DomainError(
      "INVOICE_PAYMENT_PROVIDER",
      "Payment provider returned an invalid checkout URL",
      502,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new DomainError(
      "INVOICE_PAYMENT_PROVIDER",
      "Payment provider returned an invalid checkout URL",
      502,
    );
  }
  const localHttp =
    process.env.NODE_ENV !== "production" && parsed.protocol === "http:";
  if (
    parsed.username ||
    parsed.password ||
    (parsed.protocol !== "https:" && !localHttp)
  ) {
    throw new DomainError(
      "INVOICE_PAYMENT_PROVIDER",
      "Payment provider returned an insecure checkout URL",
      502,
    );
  }
  return parsed.toString();
}

export async function initializeInvoicePayment(
  input: InvoicePaymentInit,
  signal?: AbortSignal,
): Promise<InvoicePaymentInitResult> {
  const url = process.env.INVOICE_PAYMENT_PROVIDER_URL?.trim();
  if (!url) {
    throw new DomainError(
      "INVOICE_PAYMENT_UNAVAILABLE",
      "Hosted payment is not configured. Use the payment instructions in this room.",
      503,
    );
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "idempotency-key": input.idempotencyKey,
  };
  const token = process.env.INVOICE_PAYMENT_PROVIDER_TOKEN;
  if (token) headers["x-op-token"] = token;
  const timeout = AbortSignal.timeout(5_000);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        kind: "invoice_payment_init",
        invoiceId: input.invoiceId,
        invoiceNumber: input.invoiceNumber,
        amount: input.amount,
        currency: input.currency,
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    logger.error({ error }, "Invoice payment provider request failed");
    throw new DomainError(
      "INVOICE_PAYMENT_PROVIDER",
      "Payment provider is temporarily unreachable",
      502,
    );
  }
  if (!response.ok) {
    throw new DomainError(
      "INVOICE_PAYMENT_PROVIDER",
      `Payment provider returned ${response.status}`,
      502,
    );
  }
  const body = (await response.json().catch(() => null)) as {
    provider?: unknown;
    providerReference?: unknown;
    checkoutUrl?: unknown;
    expiresAt?: unknown;
  } | null;
  const reference =
    typeof body?.providerReference === "string"
      ? body.providerReference.trim()
      : "";
  const provider =
    typeof body?.provider === "string" ? body.provider.trim() : "relay";
  if (
    !reference ||
    reference.length > 256 ||
    !provider ||
    provider.length > 80 ||
    /[\u0000-\u001f\u007f]/.test(`${provider}${reference}`)
  ) {
    throw new DomainError(
      "INVOICE_PAYMENT_PROVIDER",
      "Payment provider returned no valid reference",
      502,
    );
  }
  const expiresAt =
    typeof body?.expiresAt === "string" &&
    Number.isFinite(Date.parse(body.expiresAt))
      ? new Date(body.expiresAt)
      : null;
  return {
    provider,
    providerReference: reference,
    checkoutUrl: validCheckoutUrl(body?.checkoutUrl),
    expiresAt,
  };
}
