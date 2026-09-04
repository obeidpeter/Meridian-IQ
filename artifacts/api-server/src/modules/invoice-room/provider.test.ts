import { after, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { DomainError } from "../errors.ts";
import { closeAllServers, listen } from "../../test-helpers/route-harness.ts";
import { initializeInvoicePayment } from "./provider.ts";

const ORIGINAL = {
  nodeEnv: process.env.NODE_ENV,
  url: process.env.INVOICE_PAYMENT_PROVIDER_URL,
  token: process.env.INVOICE_PAYMENT_PROVIDER_TOKEN,
};

function restoreEnv() {
  if (ORIGINAL.nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL.nodeEnv;
  if (ORIGINAL.url === undefined)
    delete process.env.INVOICE_PAYMENT_PROVIDER_URL;
  else process.env.INVOICE_PAYMENT_PROVIDER_URL = ORIGINAL.url;
  if (ORIGINAL.token === undefined)
    delete process.env.INVOICE_PAYMENT_PROVIDER_TOKEN;
  else process.env.INVOICE_PAYMENT_PROVIDER_TOKEN = ORIGINAL.token;
}

after(async () => {
  restoreEnv();
  await closeAllServers();
});

const INPUT = {
  invoiceId: "f780971f-e5c8-4d35-8114-726318660268",
  invoiceNumber: "INV-ROOM-001",
  amount: "125000.00",
  currency: "NGN",
  idempotencyKey: "invoice-room:test-key",
};

test("hosted payment stays dark when no provider relay is configured", async () => {
  delete process.env.INVOICE_PAYMENT_PROVIDER_URL;
  await assert.rejects(
    initializeInvoicePayment(INPUT),
    (error: unknown) =>
      error instanceof DomainError &&
      error.code === "INVOICE_PAYMENT_UNAVAILABLE" &&
      error.status === 503,
  );
});

test("provider calls are bounded, authenticated, idempotent, and server-priced", async () => {
  const seen: Array<{ token?: string; idempotency?: string; body: unknown }> =
    [];
  const relay = express();
  relay.use(express.json());
  relay.post("/init", (req, res) => {
    seen.push({
      token: req.get("x-op-token"),
      idempotency: req.get("idempotency-key"),
      body: req.body,
    });
    res.json({
      provider: "test-pay",
      providerReference: "provider-reference-1",
      checkoutUrl: "https://pay.example/checkout/provider-reference-1",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
  });
  const base = await listen(relay);
  process.env.NODE_ENV = "test";
  process.env.INVOICE_PAYMENT_PROVIDER_URL = `${base}/init`;
  process.env.INVOICE_PAYMENT_PROVIDER_TOKEN = "provider-secret";
  try {
    const result = await initializeInvoicePayment(INPUT);
    assert.equal(result.providerReference, "provider-reference-1");
    assert.equal(
      result.checkoutUrl,
      "https://pay.example/checkout/provider-reference-1",
    );
    assert.deepEqual(seen, [
      {
        token: "provider-secret",
        idempotency: INPUT.idempotencyKey,
        body: {
          kind: "invoice_payment_init",
          invoiceId: INPUT.invoiceId,
          invoiceNumber: INPUT.invoiceNumber,
          amount: INPUT.amount,
          currency: INPUT.currency,
        },
      },
    ]);
  } finally {
    restoreEnv();
  }
});

test("production rejects insecure or credential-bearing checkout URLs", async () => {
  const relay = express();
  relay.use(express.json());
  let checkoutUrl = "http://pay.example/checkout/1";
  relay.post("/init", (_req, res) => {
    res.json({
      provider: "test-pay",
      providerReference: "provider-reference-2",
      checkoutUrl,
    });
  });
  const base = await listen(relay);
  process.env.NODE_ENV = "production";
  process.env.INVOICE_PAYMENT_PROVIDER_URL = `${base}/init`;
  try {
    await assert.rejects(
      initializeInvoicePayment(INPUT),
      (error: unknown) =>
        error instanceof DomainError &&
        error.code === "INVOICE_PAYMENT_PROVIDER",
    );
    checkoutUrl = "https://user:password@pay.example/checkout/1";
    await assert.rejects(
      initializeInvoicePayment({ ...INPUT, idempotencyKey: "second-key" }),
      (error: unknown) =>
        error instanceof DomainError &&
        error.code === "INVOICE_PAYMENT_PROVIDER",
    );
  } finally {
    restoreEnv();
  }
});
