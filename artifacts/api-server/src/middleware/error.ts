import type { Request, Response, NextFunction } from "express";
import { DomainError } from "../modules/errors";

// Central error boundary. Domain services throw DomainError with a catalogue
// code + HTTP status; everything else is a 500. Express 5 auto-forwards async
// rejections here, so route handlers can stay thin and throw freely.
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof DomainError) {
    if (err.status >= 500) {
      req.log.error({ code: err.code, err }, "Domain error");
    } else {
      req.log.warn({ code: err.code }, err.message);
    }
    res.status(err.status).json({ error: err.message });
    return;
  }
  req.log.error({ err }, "Unhandled error");
  res.status(500).json({ error: "Internal server error" });
}
