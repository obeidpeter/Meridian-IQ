import { Router, type IRouter } from "express";
import { z } from "zod";
import { opTokenAllows, presentedOpToken } from "../lib/op-token";
import {
  enqueueInboundEmail,
  enqueueInboundWhatsApp,
} from "../modules/inbound/queue";

// Inbound intake rails (machine webhooks). An email provider's inbound route
// (e.g. a Mailgun route or an SES receipt rule + Lambda) or a WhatsApp BSP's
// webhook relay POSTs the parsed message here as JSON; each attachment then
// walks the ordinary Clerk capture path on behalf of the resolved client
// sender (modules/inbound/email.ts, modules/inbound/whatsapp.ts).
// Deliberately NOT in the OpenAPI contract: no human client ever calls
// these, and the generated SDKs must not grow a way to impersonate an email
// address or a phone number.
//
// Gate posture — FAIL-CLOSED, the opposite of METRICS_TOKEN's open-when-unset
// default. /api/metrics is idempotent and tenant-free, so leaving it open
// until an operator opts into a secret is safe; this endpoint CREATES
// tenant-scoped work and spends real model tokens on the word of an
// unauthenticated caller, so with no INBOUND_EMAIL_TOKEN configured the rail
// must not exist at all: every request 404s exactly like an unknown route
// (the rail is dark), rather than defaulting open. Setting the env var lights
// the rail; the shared secret then IS the credential (constant-time compare
// via lib/op-token.ts), presented only in the x-op-token header so credentials
// never enter URLs, browser history or access logs.

const MAX_ATTACHMENTS = 3;

// Local (non-generated) schema: this webhook is off-contract by design. The
// global express.json 8mb cap bounds the payload; per-attachment decoded size
// is enforced downstream by the capture module's 5MB guard.
const InboundEmailBody = z.object({
  sender: z.string().min(1),
  subject: z.string().optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string().min(1),
        contentType: z.string().min(1),
        contentBase64: z.string().min(1),
      }),
    )
    .min(1)
    .max(MAX_ATTACHMENTS),
});

const router: IRouter = Router();

router.post("/inbound/email", async (req, res): Promise<void> => {
  const expected = process.env.INBOUND_EMAIL_TOKEN;
  if (!expected) {
    // Rail is dark: indistinguishable from a route that does not exist.
    res.status(404).json({ error: "Not found" });
    return;
  }
  const presented = presentedOpToken(req);
  if (!presented || !opTokenAllows(expected, presented)) {
    res.status(401).json({ error: "Invalid or missing inbound token" });
    return;
  }
  const parsed = InboundEmailBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid inbound email payload" });
    return;
  }

  // ANTI-PROBE: once the token and shape check out, the response is IDENTICAL
  // whether or not the sender resolves to a client — a caller who has the
  // shared secret still must not be able to enumerate which email addresses
  // belong to platform users. Commit the deduplicated outbox row BEFORE the
  // 202 — true only while this route stays in NO_CONTEXT_ROUTES, where the
  // enqueue commits on the pool instead of riding a buffered request
  // transaction. A worker then performs resolution and capture; an
  // unresolvable sender is audit-logged inside processInboundEmail and
  // creates nothing.
  await enqueueInboundEmail(parsed.data);
  res.status(202).json({ received: parsed.data.attachments.length });
});

// WhatsApp intake rail: same fail-closed gate (its own INBOUND_WHATSAPP_TOKEN
// — a deployment can light one rail without the other), same anti-probe 202,
// same durable outbox processing. Media arrives as base64 attachments (WhatsApp
// media often has no filename — optional here, defaulted downstream); a
// text-only message may carry the invoice details typed out, which the
// processor routes to the text capture path when long enough to plausibly be
// one.
const InboundWhatsAppBody = z
  .object({
    sender: z.string().min(1),
    text: z.string().optional(),
    attachments: z
      .array(
        z.object({
          filename: z.string().min(1).optional(),
          contentType: z.string().min(1),
          contentBase64: z.string().min(1),
        }),
      )
      .max(MAX_ATTACHMENTS)
      .default([]),
  })
  // An empty message (no media, no text) is malformed, not anti-probe
  // territory: the shape check happens before any identity resolution.
  .refine((b) => b.attachments.length > 0 || (b.text?.trim().length ?? 0) > 0, {
    message: "attachments or text required",
  });

router.post("/inbound/whatsapp", async (req, res): Promise<void> => {
  const expected = process.env.INBOUND_WHATSAPP_TOKEN;
  if (!expected) {
    // Rail is dark: indistinguishable from a route that does not exist.
    res.status(404).json({ error: "Not found" });
    return;
  }
  const presented = presentedOpToken(req);
  if (!presented || !opTokenAllows(expected, presented)) {
    res.status(401).json({ error: "Invalid or missing inbound token" });
    return;
  }
  const parsed = InboundWhatsAppBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid inbound whatsapp payload" });
    return;
  }

  // ANTI-PROBE (same posture as the email rail): the response depends only
  // on the request shape, never on whether the phone number resolves — a
  // caller holding the shared secret still must not be able to enumerate
  // which numbers belong to platform clients. Commit the durable queue item
  // before the 202 (like the email rail, this depends on the route staying
  // in NO_CONTEXT_ROUTES); a worker performs resolution and capture
  // afterward.
  await enqueueInboundWhatsApp(parsed.data);
  res.status(202).json({
    received: parsed.data.attachments.length || 1,
  });
});

export default router;
