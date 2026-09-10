import { Router, type IRouter, type Request } from "express";
import { z } from "zod";
import { parseOrThrow } from "../lib/parse";
import { isPositiveMoney } from "../lib/money";
import { sendThrottled429 } from "../lib/throttle-response";
import { authenticateOpRequest, railKeyRing } from "../lib/op-token";
import { assertCan } from "../modules/auth/rbac";
import { SESSION_COOKIE } from "../modules/auth/session";
import {
  clearActionFailures,
  throttleActionAttempt,
  throttlePublicRequest,
} from "../modules/auth/throttle";
import { requireFlag } from "../modules/flags/flags";
import {
  claimInvoiceRoomAccount,
  confirmInvoiceRoomPayment,
  createInvoiceRoom,
  createInvoiceRoomPaymentLink,
  exchangeInvoiceRoomToken,
  invoiceRoomView,
  listInvoiceRooms,
  loadRoomAccess,
  renderableInvoiceRoomBundle,
  replaceInvoiceRoom,
  reportInvoiceRoomPayment,
  requestInvoiceRoomOtp,
  respondInInvoiceRoom,
  revokeInvoiceRoom,
  verifyInvoiceRoomOtp,
  resolveRoomShareId,
} from "../modules/invoice-room/service";
import {
  digestRoomSecret,
  ROOM_SESSION_TTL_MS,
} from "../modules/invoice-room/security";
import { renderInvoicePdf, sendPdfAttachment } from "../modules/invoice/pdf";
import { loadFirmBrand } from "../modules/invoice/pdf-brand";

const router: IRouter = Router();
export const INVOICE_ROOM_COOKIE = "miq_invoice_room";

// Buyer-safe still means sensitive: browsers and shared proxies must never
// persist invoice JSON/PDF, and crawlers have no reason to index this rail.
router.use("/public/invoice-room", (_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  next();
});

const IdParams = z.object({ id: z.string().uuid() }).strict();
const CreateRoomBody = z
  .object({
    clientRequestId: z.string().uuid(),
    recipientEmail: z.string().email().max(254).optional().nullable(),
    recipientPhone: z.string().min(8).max(40).optional().nullable(),
    deliveryChannel: z.enum(["email", "whatsapp", "copy"]).default("copy"),
    expiresInDays: z.number().int().min(1).max(90).default(30),
    sendNow: z.boolean().default(false),
    remindersEnabled: z.boolean().default(false),
    contactConsent: z.boolean().default(false),
  })
  .strict();
const ExchangeBody = z.object({ token: z.string().min(32).max(128) }).strict();
const OtpBody = z.object({ channel: z.enum(["email", "whatsapp"]) }).strict();
const VerifyBody = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
const RespondBody = z
  .object({
    state: z.enum(["confirmed", "queried", "rejected"]),
    note: z.string().trim().max(2_000).optional().nullable(),
    noSetOff: z.boolean().optional(),
    idempotencyKey: z.string().uuid(),
  })
  .strict();
const PaymentReportBody = z
  .object({
    amount: z.string().refine(isPositiveMoney).optional(),
    paidAt: z.string().datetime(),
    reference: z.string().trim().min(1).max(200),
    note: z.string().trim().max(2_000).optional().nullable(),
    idempotencyKey: z.string().uuid(),
  })
  .strict();
const PaymentLinkBody = z
  .object({ idempotencyKey: z.string().uuid() })
  .strict();
const ClaimBody = z
  .object({
    fullName: z.string().trim().min(2).max(160).optional().nullable(),
    password: z.string().min(12).max(256).optional().nullable(),
  })
  .strict();
const PaymentConfirmationBody = z
  .object({
    providerReference: z.string().min(1).max(256),
    amount: z.string().refine(isPositiveMoney),
    currency: z.string().regex(/^[A-Z]{3}$/),
    paidAt: z.string().datetime().optional(),
  })
  .strict();

function secureRequest(req: Request): boolean {
  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "");
  return (
    process.env.NODE_ENV === "production" ||
    req.secure ||
    forwardedProto.split(",")[0]?.trim() === "https"
  );
}

function roomCookieOptions(req: Request) {
  const secure = secureRequest(req);
  return {
    httpOnly: true,
    sameSite: (secure ? "none" : "lax") as "none" | "lax",
    path: "/api/public/invoice-room",
    secure,
    maxAge: ROOM_SESSION_TTL_MS,
  };
}

function accountCookieOptions(req: Request) {
  const secure = secureRequest(req);
  return {
    httpOnly: true,
    sameSite: (secure ? "none" : "lax") as "none" | "lax",
    path: "/",
    secure,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

function roomSession(req: Request): string | null {
  return (
    (req as Request & { cookies?: Record<string, string> }).cookies?.[
      INVOICE_ROOM_COOKIE
    ] ?? null
  );
}

async function publicThrottle(
  req: Request,
  res: Parameters<typeof sendThrottled429>[0],
  namespace: "invoice-room-exchange" | "invoice-room-action",
): Promise<boolean> {
  const retryAfter = await throttlePublicRequest(req, namespace);
  if (retryAfter === null) return false;
  sendThrottled429(res, retryAfter, "Too many Invoice Room requests");
  return true;
}

// Supplier control centre. Firm RLS plus client-party narrowing in the service
// keeps a client user on its own receivables while firm staff see the portfolio.
router.get(
  "/invoice-rooms",
  requireFlag("invoice_room"),
  async (req, res): Promise<void> => {
    assertCan(req.principal, "invoice.read");
    res.json({ rooms: await listInvoiceRooms(req.principal) });
  },
);

router.get(
  "/invoices/:id/invoice-rooms",
  requireFlag("invoice_room"),
  async (req, res): Promise<void> => {
    assertCan(req.principal, "invoice.read");
    const params = parseOrThrow(IdParams, req.params);
    res.json({ rooms: await listInvoiceRooms(req.principal, params.id) });
  },
);

router.post(
  "/invoices/:id/invoice-rooms",
  requireFlag("invoice_room"),
  async (req, res): Promise<void> => {
    assertCan(req.principal, "invoice.write");
    const params = parseOrThrow(IdParams, req.params);
    const body = parseOrThrow(CreateRoomBody, req.body);
    res
      .status(201)
      .json(await createInvoiceRoom(req.principal, params.id, body));
  },
);

router.post(
  "/invoice-rooms/:id/revoke",
  requireFlag("invoice_room"),
  async (req, res): Promise<void> => {
    assertCan(req.principal, "invoice.write");
    const params = parseOrThrow(IdParams, req.params);
    res.json({ room: await revokeInvoiceRoom(req.principal, params.id) });
  },
);

router.post(
  "/invoice-rooms/:id/replace",
  requireFlag("invoice_room"),
  async (req, res): Promise<void> => {
    assertCan(req.principal, "invoice.write");
    const params = parseOrThrow(IdParams, req.params);
    const body = parseOrThrow(CreateRoomBody, req.body);
    res
      .status(201)
      .json(await replaceInvoiceRoom(req.principal, params.id, body));
  },
);

router.post(
  "/public/invoice-room/exchange",
  async (req, res): Promise<void> => {
    if (await publicThrottle(req, res, "invoice-room-exchange")) return;
    const body = parseOrThrow(ExchangeBody, req.body);
    const exchanged = await exchangeInvoiceRoomToken(body.token);
    res.cookie(
      INVOICE_ROOM_COOKIE,
      exchanged.sessionToken,
      roomCookieOptions(req),
    );
    res.json(exchanged.view);
  },
);

router.get("/public/invoice-room", async (req, res): Promise<void> => {
  if (await publicThrottle(req, res, "invoice-room-action")) return;
  const session = roomSession(req);
  const access = await loadRoomAccess(session);
  res.json(await invoiceRoomView(access));
});

router.post("/public/invoice-room/otp", async (req, res): Promise<void> => {
  if (await publicThrottle(req, res, "invoice-room-action")) return;
  const body = parseOrThrow(OtpBody, req.body);
  const session = roomSession(req);
  if (!session) {
    res.status(401).json({ error: "Open the secure invoice link again" });
    return;
  }
  // Two budgets (R105 review): per session, and per ROOM across every session
  // — a link holder can re-exchange the link for a fresh session at will, so a
  // session-only cap would reset on each exchange and scale with source IPs.
  const shareId = await resolveRoomShareId(session);
  for (const key of [
    `invoice-room-otp-send:${digestRoomSecret(session).slice(0, 32)}`,
    `invoice-room-otp-send-share:${shareId}`,
  ]) {
    const retryAfter = await throttleActionAttempt(key);
    if (retryAfter !== null) {
      sendThrottled429(
        res,
        retryAfter,
        "Too many verification codes requested",
      );
      return;
    }
  }
  res.status(202).json(await requestInvoiceRoomOtp(session, body.channel));
});

router.post("/public/invoice-room/verify", async (req, res): Promise<void> => {
  if (await publicThrottle(req, res, "invoice-room-action")) return;
  const body = parseOrThrow(VerifyBody, req.body);
  const session = roomSession(req);
  if (!session) {
    res.status(401).json({ error: "Open the secure invoice link again" });
    return;
  }
  const shareId = await resolveRoomShareId(session);
  const throttleKeys = [
    `invoice-room-otp:${digestRoomSecret(session).slice(0, 32)}`,
    `invoice-room-otp-share:${shareId}`, // per room, across sessions (R105)
  ];
  for (const key of throttleKeys) {
    const retryAfter = await throttleActionAttempt(key);
    if (retryAfter !== null) {
      sendThrottled429(res, retryAfter, "Too many verification attempts");
      return;
    }
  }
  const view = await verifyInvoiceRoomOtp(session, body.code);
  for (const key of throttleKeys) await clearActionFailures(key);
  res.json(view);
});

router.post("/public/invoice-room/respond", async (req, res): Promise<void> => {
  if (await publicThrottle(req, res, "invoice-room-action")) return;
  const body = parseOrThrow(RespondBody, req.body);
  res.json(await respondInInvoiceRoom(roomSession(req) ?? "", body));
});

router.post(
  "/public/invoice-room/payment-reports",
  async (req, res): Promise<void> => {
    if (await publicThrottle(req, res, "invoice-room-action")) return;
    const body = parseOrThrow(PaymentReportBody, req.body);
    res.json(await reportInvoiceRoomPayment(roomSession(req) ?? "", body));
  },
);

router.post(
  "/public/invoice-room/payment-link",
  async (req, res): Promise<void> => {
    if (await publicThrottle(req, res, "invoice-room-action")) return;
    const body = parseOrThrow(PaymentLinkBody, req.body);
    const session = roomSession(req);
    if (!session) {
      res.status(401).json({ error: "Open the secure invoice link again" });
      return;
    }
    const retryAfter = await throttleActionAttempt(
      `invoice-room-payment-link:${digestRoomSecret(session).slice(0, 32)}`,
    );
    if (retryAfter !== null) {
      sendThrottled429(res, retryAfter, "Too many payment link requests");
      return;
    }
    res
      .status(201)
      .json(
        await createInvoiceRoomPaymentLink(
          session,
          body.idempotencyKey,
          req.abortSignal,
        ),
      );
  },
);

router.post("/public/invoice-room/claim", async (req, res): Promise<void> => {
  if (await publicThrottle(req, res, "invoice-room-action")) return;
  const body = parseOrThrow(ClaimBody, req.body);
  const session = roomSession(req);
  if (!session) {
    res.status(401).json({ error: "Open the secure invoice link again" });
    return;
  }
  const retryAfter = await throttleActionAttempt(
    `invoice-room-claim:${digestRoomSecret(session).slice(0, 32)}`,
  );
  if (retryAfter !== null) {
    sendThrottled429(res, retryAfter, "Too many account claim attempts");
    return;
  }
  const result = await claimInvoiceRoomAccount(session, body);
  if (result.sessionToken) {
    res.cookie(SESSION_COOKIE, result.sessionToken, accountCookieOptions(req));
  }
  const { sessionToken: _sessionToken, ...publicResult } = result;
  res.status(result.created ? 201 : 200).json(publicResult);
});

router.get("/public/invoice-room/pdf", async (req, res): Promise<void> => {
  if (await publicThrottle(req, res, "invoice-room-action")) return;
  const bundle = await renderableInvoiceRoomBundle(roomSession(req) ?? "");
  const brand = await loadFirmBrand(bundle.access.invoice.firmId);
  const pdf = await renderInvoicePdf({
    invoice: bundle.access.invoice,
    lines: bundle.lines,
    supplier: bundle.supplier,
    buyer: bundle.buyer,
    stamp: bundle.stamp,
    theme: brand.theme,
  });
  sendPdfAttachment(
    res,
    `invoice-${bundle.access.invoice.invoiceNumber}.pdf`,
    pdf,
  );
});

// Trusted payment-provider callback. It is intentionally off the generated
// browser contract and indistinguishable for unknown references or replays.
router.post(
  "/invoice-room/payments/confirm",
  async (req, res): Promise<void> => {
    const ring = railKeyRing("INVOICE_PAYMENT_WEBHOOK_TOKEN");
    if (ring.length === 0) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!authenticateOpRequest(req, ring).ok) {
      res
        .status(401)
        .json({ error: "Invalid or missing payment webhook token" });
      return;
    }
    const body = PaymentConfirmationBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Invalid payment confirmation payload" });
      return;
    }
    await confirmInvoiceRoomPayment(body.data);
    res.status(202).json({ received: true });
  },
);

export default router;
