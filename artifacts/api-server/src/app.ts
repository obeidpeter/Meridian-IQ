import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { runRequestContext } from "@workspace/db";
import router from "./routes";
import { logger } from "./lib/logger";
import { resolvePrincipal } from "./middleware/principal";
import { errorHandler } from "./middleware/error";

// Cross-tenant staff (operator/auditor/bank_user), buyer-organization users
// (buyer_user — scoped to a buyer Party at the route level, not to a firm) and
// unauthenticated public endpoints (e.g. stamp verification) run with RLS
// bypassed; firm-scoped principals are pinned to their own firm_id.
const BYPASS_ROLES = new Set(["operator", "auditor", "bank_user", "buyer_user"]);

// Liveness probe must not depend on the database, so it skips the per-request
// transaction entirely.
const NO_CONTEXT_PATHS = new Set(["/api/healthz"]);

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
  if (NO_CONTEXT_PATHS.has(req.path)) {
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
app.use(cors());
// 5,000-row imports (NFR-03) and full bank-statement uploads (INT-05) arrive
// as JSON bodies well beyond the 100kb express default.
app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: true }));

// Verify the Clerk session (if any) from cookie/Bearer token and attach auth to
// the request. resolvePrincipal reads getAuth(req) to build the tenant-scoped
// principal in production; the dev-header shim is used only outside production.
// Mounted only when Clerk keys are provisioned: a keyless dev environment
// (local smoke, CI) authenticates through the dev-header shim alone.
if (process.env.CLERK_SECRET_KEY) {
  app.use(clerkMiddleware());
}
app.use(resolvePrincipal);
app.use(tenantContext);
app.use("/api", router);

app.use(errorHandler);

export default app;
