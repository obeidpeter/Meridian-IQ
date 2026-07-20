import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { runRequestContext } from "@workspace/db";
import router from "./routes";
import inboundRouter from "./routes/inbound";
import { logger } from "./lib/logger";
import { resolvePrincipal, requireCsrfHeader } from "./middleware/principal";
import { rateLimit } from "./middleware/rate-limit";
import { errorHandler } from "./middleware/error";
import { metricsMiddleware } from "./lib/metrics";

// Cross-tenant staff (operator/auditor/bank_user), buyer-organization users
// (buyer_user — scoped to a buyer Party at the route level, not to a firm) and
// unauthenticated public endpoints (e.g. stamp verification) run with RLS
// bypassed; firm-scoped principals are pinned to their own firm_id.
const BYPASS_ROLES = new Set(["operator", "auditor", "bank_user", "buyer_user"]);

// Liveness probe must not depend on the database, so it skips the per-request
// transaction entirely. The external sweep trigger also skips it: each
// pipeline pass opens its own bypass transactions, which must not nest inside
// the per-request tenant transaction (nor inherit its 30-second cap).
const NO_CONTEXT_PATHS = new Set([
  "/api/healthz",
  "/api/readyz",
  "/api/metrics",
  "/api/internal/sweep",
]);

// Method-scoped variant for the Clerk routes that call the model provider
// in-request. NOTE: these model-calling exemptions are mirrored by the MODEL
// rate-limit class in middleware/rate-limit.ts (MODEL_RATE_LIMITED_ROUTES /
// _PATTERNS, which also covers the digest-posture single-completion routes
// that stay inside the transaction) — when a route joins or leaves this list
// because of a provider call, update that list too.
// A multi-second completion (up to eleven for a full batch
// intake) must not pin a pooled connection inside an open transaction or run
// into the 30s request-transaction cap — a full batch at realistic provider
// latencies EXCEEDS the cap and would roll back every created case after the
// tokens were already spent. These handlers instead commit each DB stage in a
// short firm-scoped transaction of their own (modules/clerk/scope.ts) with
// the same RLS posture this middleware would have given them; only the
// method+path pairs listed here are exempt, so the GET list/read routes that
// share the paths keep the ordinary tenant transaction.
const NO_CONTEXT_ROUTES = new Set([
  "POST /api/clerk/cases",
  "POST /api/clerk/cases/batch",
  "POST /api/clerk/ask",
  "POST /api/clerk/eval/run",
  "POST /api/clerk/catalogue-draft",
  // Queues only (no model call), but the batch row must be COMMITTED before
  // the fire-and-forget processor kick can claim it on another connection.
  "POST /api/clerk/batches",
  "POST /api/clerk/format-draft",
  // Two sequential provider calls on the voice path (transcription + draft
  // inference) — far too slow to hold a pooled connection or fit the 30s cap.
  "POST /api/clerk/draft-invoice",
  "POST /api/clerk/client-import-draft",
  // A canary is 2× a corpus pass of model calls — far past the 30s cap.
  "POST /api/clerk/eval/canary",
  "POST /api/clerk/eval/model-canary",
  // Inbound email webhook (routes/inbound.ts): the handler responds 202 and
  // then runs sender resolution + extraction in a detached promise whose DB
  // stages commit in their own short transactions (clerk scope.ts) — nothing
  // should buffer in tenantContext, and the detached model calls must not
  // inherit (or outlive) a per-request transaction.
  "POST /api/inbound/email",
  // No model call, but up to 50 decideCase items each append audit rows —
  // and appendAudit serializes on a GLOBAL advisory xact lock. Inside one
  // request transaction the first item's audit lock would be held until the
  // whole batch commits (a platform-wide appendAudit convoy, plus a deadlock
  // window against the row-lock→audit-lock order of reject/claim). Instead
  // each item commits in its own short bypass transaction (bulk-approve.ts),
  // holding the audit lock per item only.
  "POST /api/clerk/cases/bulk-approve",
]);

// Parameterized-path variant of NO_CONTEXT_ROUTES: the Set above can only
// match literal paths, so routes with an :id segment that must skip the
// request transaction are listed here as method + pattern instead. Keep this
// list short — every entry gives up the ambient-transaction atomicity and
// must manage its own commits (clerk scope.ts / raw-pool audit).
const NO_CONTEXT_ROUTE_PATTERNS: ReadonlyArray<{
  method: string;
  pattern: RegExp;
}> = [
  // Case retry re-runs a FULL extraction on the stored source — up to a
  // 4-page vision call — exactly the multi-second provider work the capture
  // routes above are exempted for; its writes commit via inClerkScope and
  // the audit row lands on the raw pool.
  { method: "POST", pattern: /^\/api\/clerk\/cases\/[^/]+\/retry$/ },
];

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
  if (
    NO_CONTEXT_PATHS.has(req.path) ||
    NO_CONTEXT_ROUTES.has(`${req.method} ${req.path}`) ||
    NO_CONTEXT_ROUTE_PATTERNS.some(
      (r) => r.method === req.method && r.pattern.test(req.path),
    )
  ) {
    next();
    return;
  }
  const principal = req.principal;
  const bypass =
    !principal || BYPASS_ROLES.has(principal.role) || !principal.firmId;
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

  runRequestContext({ bypass, firmId }, () => {
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
        const headerArg = rest.find(
          (a) => a !== null && typeof a === "object",
        );
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
// 5,000-row imports (NFR-03) and full bank-statement uploads (INT-05) arrive
// as JSON bodies well beyond the 100kb express default. Only JSON is parsed:
// urlencoded parsing is deliberately NOT enabled so a cross-site HTML <form>
// (a no-preflight "simple request") cannot deliver a parseable body (SEC-02).
app.use(express.json({ limit: "8mb" }));
// Session cookie (modules/auth/session.ts) is read by the principal middleware.
app.use(cookieParser());
// CSRF guard: require a custom header on cookie-authenticated state-changing
// requests. Runs after cookie-parser so it can see the session cookie, and
// before principal resolution (SEC-02).
app.use(requireCsrfHeader);

// Verify the Clerk session (if any) from cookie/Bearer token and attach auth to
// the request. resolvePrincipal reads getAuth(req) to build the tenant-scoped
// principal in production; the dev-header shim is used only outside production.
// Mounted only when Clerk keys are provisioned: a keyless dev environment
// (local smoke, CI) authenticates through the dev-header shim alone.
if (process.env.CLERK_SECRET_KEY) {
  app.use(clerkMiddleware());
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
// exactly the generated surface. Shares the /api prefix so the PUBLIC_PATHS /
// NO_CONTEXT_ROUTES entries above match on req.path.
app.use("/api", inboundRouter);
app.use("/api", router);

app.use(errorHandler);

export default app;
