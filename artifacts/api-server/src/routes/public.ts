import { Router, type IRouter } from "express";
import {
  RecordUsabilityEventBody,
  RequestAdvisoryReviewBody,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import { sendThrottled429 } from "../lib/throttle-response";
import { recordUsabilityEvent } from "../lib/metrics";
import { DomainError } from "../modules/errors";
import { sendRawToRelay } from "../modules/messaging/messaging";
import { throttlePublicRequest } from "../modules/auth/throttle";

const router: IRouter = Router();

router.post("/public/advisory-requests", async (req, res): Promise<void> => {
  const retryAfter = await throttlePublicRequest(req, "advisory");
  if (retryAfter !== null) {
    sendThrottled429(res, retryAfter, "Too many advisory requests");
    return;
  }
  const body = parseOrThrow(RequestAdvisoryReviewBody, req.body);
  if (!body.consent) {
    throw new DomainError(
      "CONTACT_CONSENT_REQUIRED",
      "Confirm that MeridianIQ may use these details to contact you",
      400,
    );
  }
  const delivery = await sendRawToRelay("advisory_request", {
    email: body.email,
    businessName: body.businessName?.trim() || undefined,
    estimateSummary: body.estimateSummary,
  });
  if (!delivery.ok) {
    throw new DomainError(
      "ADVISORY_DELIVERY_UNAVAILABLE",
      "Online advisory requests are temporarily unavailable. Use the email option instead.",
      503,
    );
  }
  res.status(202).end();
});

router.post("/public/usability-events", async (req, res): Promise<void> => {
  const retryAfter = await throttlePublicRequest(req, "usability");
  if (retryAfter !== null) {
    sendThrottled429(res, retryAfter, "Too many events");
    return;
  }
  const body = parseOrThrow(RecordUsabilityEventBody, req.body);
  recordUsabilityEvent(body.event, body.surface);
  res.status(204).end();
});

export default router;
