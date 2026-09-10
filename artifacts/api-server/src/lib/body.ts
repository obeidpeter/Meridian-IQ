import express, { type Request } from "express";

// The JSON body parser shared by the app and the route-test harness. It
// keeps the exact bytes it parsed on `req.rawBody` so a signed machine-rail
// request (lib/op-token.ts) can be verified over what the provider actually
// sent — re-serialising `req.body` would not byte-match the signature.
// 5,000-row imports (NFR-03) and full bank-statement uploads (INT-05) arrive
// as JSON bodies well beyond the 100kb express default. Only JSON is parsed:
// urlencoded parsing is deliberately NOT enabled so a cross-site HTML <form>
// (a no-preflight "simple request") cannot deliver a parseable body (SEC-02).
const JSON_BODY_LIMIT = "8mb";

export function rawBodyOf(req: Request): Buffer {
  return (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
}

export function jsonBodyParser() {
  return express.json({
    limit: JSON_BODY_LIMIT,
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    },
  });
}
