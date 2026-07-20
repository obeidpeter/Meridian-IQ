import { Router, type IRouter } from "express";
import { z } from "zod";
import {
  CreatePaymentIntentBody,
  CreatePaymentIntentResponse,
  ListPaymentIntentsResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import { opTokenAllows } from "../lib/op-token";
import { assertCan, requireFirmScope } from "../modules/auth/rbac";
import {
  confirmPaymentIntent,
  createPaymentIntent,
  listPaymentIntents,
} from "../modules/billing/payments";

// Payment collection routes. The two contract routes carry the SAME gates as
// the billing statement they collect on (console.portfolio.read + firm
// scope — the firm principals who can see the bill are the ones who pay it;
// a client_user never sees the firm's platform bill). The confirmation
// webhook below is a machine rail deliberately OFF the OpenAPI contract, the
// inbound-rail posture exactly.

const router: IRouter = Router();

// Start a payment for a closed billing month. The amount is computed
// server-side from the billing-statement fee core — the body names only the
// month. 400 for an open/unknown or zero-fee month; 409 when a live
// (pending or confirmed) intent already holds the month.
router.post("/billing/payments", async (req, res): Promise<void> => {
  assertCan(req.principal, "console.portfolio.read");
  const firmId = requireFirmScope(req.principal);
  const body = parseOrThrow(CreatePaymentIntentBody, req.body);
  const intent = await createPaymentIntent(
    firmId,
    body.monthStart,
    req.principal,
  );
  res.status(201).json(CreatePaymentIntentResponse.parse(intent));
});

// The firm's payment intents, newest first — settled and dead attempts
// included, so the console can show the collection history.
router.get("/billing/payments", async (req, res): Promise<void> => {
  assertCan(req.principal, "console.portfolio.read");
  const firmId = requireFirmScope(req.principal);
  const intents = await listPaymentIntents(firmId);
  res.json(ListPaymentIntentsResponse.parse(intents));
});

// Payment confirmation webhook (machine rail). The provider (or its relay)
// POSTs the outcome of a payment here. Deliberately NOT in the OpenAPI
// contract: no human client ever calls this, and the generated SDKs must not
// grow a way to mark bills paid.
//
// Gate posture — FAIL-CLOSED, the inbound-rail stance (routes/inbound.ts),
// the opposite of METRICS_TOKEN's open-when-unset default: this endpoint
// SETTLES money state on the word of an unauthenticated caller, so with no
// PAYMENT_WEBHOOK_TOKEN configured the rail must not exist at all — every
// request 404s exactly like an unknown route. Setting the env var lights the
// rail; the shared secret then IS the credential (constant-time compare via
// lib/op-token.ts), presented as x-op-token or ?token= — the same shapes the
// operational endpoints accept.
//
// Local (non-generated) schema: this webhook is off-contract by design.
const ConfirmPaymentBody = z.object({
  providerRef: z.string().min(1),
  outcome: z.enum(["confirmed", "failed"]),
});

router.post("/billing/payments/confirm", async (req, res): Promise<void> => {
  const expected = process.env.PAYMENT_WEBHOOK_TOKEN;
  if (!expected) {
    // Rail is dark: indistinguishable from a route that does not exist.
    res.status(404).json({ error: "Not found" });
    return;
  }
  const presented =
    req.get("x-op-token") ??
    (typeof req.query.token === "string" ? req.query.token : undefined);
  if (!presented || !opTokenAllows(expected, presented)) {
    res.status(401).json({ error: "Invalid or missing payment webhook token" });
    return;
  }
  const parsed = ConfirmPaymentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payment confirmation payload" });
    return;
  }

  // CAS settle, then 202 EITHER WAY: zero matched rows means an
  // already-settled replay (providers redeliver) — or a reference that never
  // existed, which must look identical so a caller holding the shared secret
  // still cannot probe which references are live. The write is durable
  // before the 202 goes out (the module commits its own bypass transaction —
  // this route skips the buffered request transaction, see app.ts).
  await confirmPaymentIntent(parsed.data.providerRef, parsed.data.outcome);
  res.status(202).json({ received: true });
});

export default router;
