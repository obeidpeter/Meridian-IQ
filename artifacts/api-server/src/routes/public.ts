import { Router, type IRouter } from "express";
import {
  RecordUsabilityEventBody,
  RequestAdvisoryReviewBody,
  RequestPlatformAccessBody,
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
  const body = parseOrThrow(RecordUsabilityEventBody.strict(), req.body);
  recordUsabilityEvent(body.event, body.surface);
  res.status(204).end();
});

router.post("/public/access-requests", async (req, res): Promise<void> => {
  const retryAfter = await throttlePublicRequest(req, "access");
  if (retryAfter !== null) {
    sendThrottled429(res, retryAfter, "Too many access requests");
    return;
  }
  const body = parseOrThrow(RequestPlatformAccessBody.strict(), req.body);
  // A filled honeypot is treated as accepted so automated senders cannot tune
  // around the control. No personal data is relayed or logged.
  if (body.website?.trim()) {
    res.status(202).end();
    return;
  }
  if (!body.consent) {
    throw new DomainError(
      "CONTACT_CONSENT_REQUIRED",
      "Confirm that MeridianIQ may use these details to contact you",
      400,
    );
  }
  const delivery = await sendRawToRelay("platform_access_request", {
    name: body.name.trim(),
    email: body.email.trim().toLowerCase(),
    businessName: body.businessName.trim(),
    interest: body.interest,
    teamSize: body.teamSize,
    message: body.message?.trim() || undefined,
  });
  if (!delivery.ok) {
    recordUsabilityEvent("access_request_failed", "access_request");
    throw new DomainError(
      "ACCESS_REQUEST_DELIVERY_UNAVAILABLE",
      "Online access requests are temporarily unavailable. Use the email option instead.",
      503,
    );
  }
  recordUsabilityEvent("access_request_submitted", "access_request");
  res.status(202).end();
});

export default router;
