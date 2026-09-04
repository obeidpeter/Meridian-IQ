import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { jsonBodyParser } from "./lib/body";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { runCorrelationContext, runRequestContext } from "@workspace/db";
import router from "./routes";
import inboundRouter from "./routes/inbound";
import { logger } from "./lib/logger";
import { resolvePrincipal, requireCsrfHeader } from "./middleware/principal";
import { rateLimit } from "./middleware/rate-limit";
import {
  principalBypassesTenantContext,
  requestSkipsTenantContext,
} from "./middleware/request-policy";
import { errorHandler } from "./middleware/error";
import { metricsMiddleware } from "./lib/metrics";
import { getReadiness } from "./lib/readiness";
import { resolveRequestId } from "./lib/request-id";

// Hard cap on how long a request may hold its transaction open. A handler that
// never responds (and whose socket never closes) would otherwise pin a pooled
// connection with an open transaction indefinitely; on timeout we force a
// rollback and fail the request instead.
const REQUEST_TX_TIMEOUT_MS = 30_000;

// Opens one transaction per request and binds the tenant RLS GUCs to the
// resolved principal (CON-01, SEC-02). All getDb() call sites downstream read
// this ambient transaction, so tenant isolation is enforced at the data layer
// and multi-statement handlers stay atomic.
//
// Crucially, NOTHING reaches the client until the transaction has settled. The
// terminal res.end records the response without flushing; res.writeHead only
// sets status/headers (no flush); res.flushHeaders and 1xx interim responses are
// neutralized. Only after COMMIT (status < 400) or ROLLBACK (status >= 400) do we
// restore the real methods and flush. This guarantees a client is never handed
// headers or a body — least of all a 2xx — for a write that has not durably
// committed. Streaming a body incrementally (res.write) is incompatible with
// committing before the first byte is flushed, so it is rejected outright rather
// than silently buffered (which would break Node backpressure); the entire API
// responds with buffered res.json/res.send, so this never fires in practice. A
// commit failure discards the success and surfaces a 500 instead. Because commit
// happens at handler completion rather than at socket-flush time, row locks are
// released before the (possibly slow) response body is written.
class RequestRollback extends Error {}

function tenantContext(req: Request, res: Response, next: NextFunction): void {
  if (requestSkipsTenantContext(req.method, req.path)) {
    next();
    return;
  }
  const principal = req.principal;
  const bypass = principalBypassesTenantContext(principal);
  const firmId = bypass ? null : principal!.firmId;

  type AnyFn = (...args: unknown[]) => unknown;
  const realWrite = res.write.bind(res) as AnyFn;
  const realEnd = res.end.bind(res) as AnyFn;
  const realWriteHead = res.writeHead.bind(res) as AnyFn;
  const realFlushHeaders = res.flushHeaders?.bind(res) as AnyFn | undefined;

  const patched = res as unknown as {
    write: AnyFn;
    end: AnyFn;
    writeHead: AnyFn;
    flushHeaders?: AnyFn;
  };
  const restore = () => {
    patched.write = realWrite;
    patched.end = realEnd;
    patched.writeHead = realWriteHead;
    if (realFlushHeaders) patched.flushHeaders = realFlushHeaders;
  };

  let endArgs: unknown[] = [];
  let terminated = false;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const safeEnd = (...args: unknown[]) => {
    if (res.writableEnded) return;
    try {
      realEnd(...args);
    } catch {
      /* connection already gone */
    }
  };

  runRequestContext({ bypass, firmId, correlationId: String(req.id) }, () => {
    return new Promise<void>((resolve, reject) => {
      const settle = () => {
        if (terminated) return;
        terminated = true;
        if (res.statusCode >= 400) reject(new RequestRollback());
        else resolve();
      };

      // Defer header flushing; res.writeHead may still set status/headers.
      patched.flushHeaders = () => {};
      patched.writeHead = (statusCode: unknown, ...rest: unknown[]) => {
        if (typeof statusCode === "number") res.statusCode = statusCode;
        const headerArg = rest.find((a) => a !== null && typeof a === "object");
        if (headerArg && !Array.isArray(headerArg)) {
          for (const [key, value] of Object.entries(
            headerArg as Record<string, unknown>,
          )) {
            res.setHeader(key, value as never);
          }
        }
        return res;
      };
      // Streaming a body incrementally cannot coexist with committing before the
      // first byte is flushed, so it is rejected rather than silently buffered
      // (which would break Node backpressure). No route streams; every response
      // is a buffered res.json/res.send that funnels through res.end below.
      patched.write = () => {
        throw new Error(
          "Streaming responses are not supported within a tenant transaction",
        );
      };
      // 1xx interim responses would put bytes on the wire before commit; disable.
      const interim = res as unknown as {
        writeContinue?: AnyFn;
        writeEarlyHints?: AnyFn;
      };
      if (typeof interim.writeContinue === "function") {
        interim.writeContinue = () => {};
      }
      if (typeof interim.writeEarlyHints === "function") {
        interim.writeEarlyHints = (cb?: unknown) => {
          if (typeof cb === "function") (cb as () => void)();
        };
      }
      // Record the terminal write and settle the transaction; do not flush yet.
      patched.end = (...args: unknown[]) => {
        endArgs = args;
        settle();
        return res;
      };
      // Client hung up before the handler responded: roll back.
      res.on("close", () => {
        if (!terminated) {
          terminated = true;
          reject(new RequestRollback());
        }
      });
      timer = setTimeout(() => {
        if (!terminated) {
          terminated = true;
          timedOut = true;
          req.requestAbortController.abort(
            new Error("Request transaction timed out"),
          );
          reject(new RequestRollback());
        }
      }, REQUEST_TX_TIMEOUT_MS);
      next();
    });
  })
    .then(() => {
      // Committed: release the captured response to the client.
      restore();
      safeEnd(...endArgs);
    })
    .catch((err) => {
      restore();
      if (err instanceof RequestRollback) {
        if (timedOut && !res.headersSent) {
          res.removeHeader("Content-Length");
          res.statusCode = 503;
          res.setHeader("Content-Type", "application/json");
          req.log.error("Request transaction timed out; rolled back");
          safeEnd(JSON.stringify({ error: "Request timed out" }));
          return;
        }
        // Rolled back. Flush whatever response the handler/error boundary
        // produced (a >=400 body), or nothing if the client already left.
        safeEnd(...endArgs);
        return;
      }
      // Commit itself failed after a success response was produced: discard the
      // buffered 2xx and tell the client the write did not persist.
      if (!res.headersSent) {
        res.removeHeader("Content-Length");
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        req.log.error({ err }, "Transaction commit failed");
        safeEnd(JSON.stringify({ error: "Internal server error" }));
      } else {
        safeEnd();
      }
    })
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

const app: Express = express();

// Trust one proxy hop so req.ip reflects the real client address (from the
// platform's ingress proxy) rather than the socket peer or a client-supplied
// X-Forwarded-For. The login throttle keys on req.ip, so this closes the
// header-spoofing bypass and the unbounded-map growth it enabled (SEC-M4).
app.set("trust proxy", 1);

// Baseline security response headers (SEC-M2). No dependency; applied to every
// API response. nosniff blocks MIME-confusion on any user-influenced payload;
// Referrer-Policy avoids leaking URLs; HSTS enforces TLS on the shared origin.
// NOTE: the frontends are served by their own static layer and are INTENTIONALLY
// embedded in the preview iframe, so their anti-clickjacking control must be a
// CSP `frame-ancestors` allowlist configured at that layer — not X-Frame-Options
// here (which is safe on JSON API responses but does not cover the framed HTML).
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Strict-Transport-Security", "max-age=15552000");
  next();
});

// Request timing (OBS-01). Placed early so the histogram captures total
// in-server latency including auth, RLS setup and the handler.
app.use(metricsMiddleware);

app.use(
  pinoHttp({
    logger,
    genReqId(req, res) {
      const requestId = resolveRequestId(req.headers["x-request-id"]);
      res.setHeader("X-Request-Id", requestId);
      return requestId;
    },
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// Keep the request reference available to routes that intentionally manage
// their own short transactions outside tenantContext.
app.use((req, _res, next) => {
  runCorrelationContext(String(req.id), next);
});

app.use((req, res, next) => {
  const controller = new AbortController();
  req.requestAbortController = controller;
  req.abortSignal = controller.signal;
  req.once("aborted", () => controller.abort(new Error("Client disconnected")));
  res.once("close", () => {
    if (!res.writableEnded) {
      controller.abort(new Error("Response connection closed"));
    }
  });
  next();
});

// Production traffic stays behind a readiness barrier until startup has
// verified the database role, RLS policies, append-only triggers and signing
// configuration. Liveness and readiness themselves must remain reachable so
// the platform can observe and recover an unhealthy instance.
app.use((req, res, next) => {
  if (
    process.env.NODE_ENV === "production" &&
    req.path.startsWith("/api/") &&
    req.path !== "/api/healthz" &&
    req.path !== "/api/readyz"
  ) {
    const readiness = getReadiness();
    if (!readiness.ready) {
      res.status(503).json({
        error: "Service is not ready",
        reason: readiness.reason,
      });
      return;
    }
  }
  next();
});
// CORS: the mobile companion's web preview is served from the Expo dev domain,
// a different origin than this API, and the shared fetch client always sends
// credentials. A credentialed cross-origin request is rejected by browsers
// unless the exact origin is echoed back with Allow-Credentials — the default
// wildcard cors() silently blocks it after a "successful" preflight. Only
// known first-party origins are allowed so arbitrary sites cannot make
// credentialed (cookie + custom-header) calls; CSRF still additionally
// requires the x-csrf header (SEC-02).
const corsAllowedOrigins = new Set(
  [
    process.env.REPLIT_DEV_DOMAIN,
    process.env.REPLIT_EXPO_DEV_DOMAIN,
    ...(process.env.REPLIT_DOMAINS?.split(",") ?? []),
  ]
    .filter((domain): domain is string => Boolean(domain))
    .map((domain) => `https://${domain.trim()}`),
);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
app.use(
  cors({
    origin(origin, callback) {
      // Same-origin and non-browser requests (curl, server-to-server) carry
      // no Origin header and need no CORS grant.
      const allowed =
        !origin ||
        corsAllowedOrigins.has(origin) ||
        (process.env.NODE_ENV !== "production" &&
          LOCALHOST_ORIGIN_RE.test(origin));
      callback(null, allowed);
    },
    credentials: true,
  }),
);
// JSON only, 8mb, raw bytes retained for signed machine rails — see
// lib/body.ts for why (NFR-03, INT-05, SEC-02, R100).
app.use(jsonBodyParser());
// Session cookie (modules/auth/session.ts) is read by the principal middleware.
app.use(cookieParser());
// CSRF guard: every browser-facing state-changing route requires the explicit
// marker, regardless of whether authentication later resolves from a cookie,
// bearer token or the non-production development shim (SEC-02).
app.use(requireCsrfHeader);

// Verify the Clerk session (if any) from cookie/Bearer token and attach auth to
// the request. resolvePrincipal reads getAuth(req) to build the tenant-scoped
// principal in production; the dev-header shim is used only outside production.
// Mounted only when Clerk keys are provisioned: a keyless dev environment
// (local smoke, CI) authenticates through the dev-header shim alone.
if (process.env.CLERK_SECRET_KEY) {
  const authorizedParties = [
    ...(process.env.CLERK_AUTHORIZED_PARTIES?.split(",") ?? []),
    ...(process.env.REPLIT_DOMAINS?.split(",") ?? []).map(
      (domain) => `https://${domain.trim()}`,
    ),
  ]
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (process.env.NODE_ENV === "production" && authorizedParties.length === 0) {
    logger.error(
      "CLERK_SECRET_KEY is set without CLERK_AUTHORIZED_PARTIES or REPLIT_DOMAINS; Clerk authentication is disabled",
    );
  } else {
    app.use(clerkMiddleware({ authorizedParties }));
  }
}
app.use(resolvePrincipal);
// Per-principal rate limiting: AFTER resolvePrincipal (keys on the resolved
// userId) and BEFORE tenantContext (the counter bump must ride the raw pool
// outside the request transaction — a 429's own rollback would otherwise
// erase the count that produced it; see middleware/rate-limit.ts).
app.use(rateLimit);
app.use(tenantContext);
// Machine webhook rail (not in the OpenAPI contract): mounted directly here
// rather than through routes/index.ts so the contract-facing router stays
// exactly the generated surface. Shares the /api prefix so PUBLIC_PATHS and
// middleware/request-policy.ts entries match on req.path.
app.use("/api", inboundRouter);
app.use("/api", router);

app.use(errorHandler);

export default app;
