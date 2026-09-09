import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { CanonicalInvoice } from "../invoice/canonical";
import {
  FaultScript,
  RAIL_FAULT_TABLE,
  deterministicStamp,
  isRailFaultOp,
  isRailFaultOutcome,
  sanitiseRejectionCode,
  type RailFault,
  type StampFields,
} from "./faults";

// The conformance fake rail (R95): a node:http access point that speaks the
// same provisional wire profile the HTTP transport (transports/http.ts)
// consumes, with fault injection scripted per invoice number. It is what the
// transport's own tests run against in-process and what the e2e harness
// spawns (src/fake-rail-main.ts) so a whole run stamps over HTTP. It remembers
// every submission it accepted, so a re-sent idempotency key answers 409 and
// a lookup returns the stamp it holds — the REAL duplicate the in-code
// simulator cannot produce. Control endpoints under /__fake are loopback-only
// tooling and need no credentials.
//
//   POST   /v0/submissions                 → 201 stamp | scripted fault
//   GET    /v0/submissions/{idempotencyKey} → 200 stamp | 404 | scripted lookup fault
//   PUT    /__fake/script                  {invoiceNumber, outcome, code?, times?, holdsStamp?, op?, retryAfterSeconds?}
//   GET    /__fake/calls                   the protocol calls seen so far
//   DELETE /__fake                         reset scripts, store and calls
//   GET    /__fake/healthz                 200 {ok: true}
//
// Its OWN failures (an unreadable or oversized body) answer 413/500 —
// never 400/422, which the profile reserves for business rejections — so a
// fake-side limit can never fail an invoice.

export interface FakeRailOptions {
  /** 0 (default) = an ephemeral port. */
  port?: number;
  host?: string;
  /** When set, a submission or lookup without this bearer token is 401. */
  token?: string;
  /** Stamp-signing secret (the CSID/HMAC input). */
  secret?: string;
}

export interface FakeRailCall {
  method: string;
  path: string;
  rail: string | null;
  invoiceNumber: string | null;
  idempotencyKey: string | null;
  /** The idempotency-key header as sent (what a transport must put on the wire). */
  idempotencyHeader: string | null;
  outcome: string;
  httpStatus: number;
  authorized: boolean;
}

export interface FakeRail {
  url: string;
  host: string;
  port: number;
  script(invoiceNumber: string, fault: RailFault): void;
  readonly calls: FakeRailCall[];
  /** Stamps held by idempotency key (what a lookup can recover). */
  readonly held: ReadonlyMap<string, StampFields>;
  reset(): void;
  close(): Promise<void>;
}

const BODY_LIMIT = 1_048_576;
const REJECT_CLOSE_TIMEOUT_MS = 1_000;
// A scripted timeout holds the socket open until the client gives up; this
// ceiling keeps the server from leaking a response forever.
const TIMEOUT_HOLD_MS = 60_000;
const DEFAULT_SECRET = "fake-rail-signing-secret";

class BodyTooLarge extends Error {}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > BODY_LIMIT) throw new BodyTooLarge("body too large");
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return null;
  return JSON.parse(text) as unknown;
}

function send(
  res: ServerResponse,
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
): void {
  if (body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...headers,
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** Answer and drop the connection: a half-read request must not poison the keep-alive pool. */
function sendAndClose(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  // An early iterator exit or immediate destroy resets Windows TCP before the
  // response arrives. Discard the rest without buffering, but never let a
  // stalled upload/reader extend the rejected socket's lifetime indefinitely.
  const socket = req.socket;
  const deadline = setTimeout(() => socket.destroy(), REJECT_CLOSE_TIMEOUT_MS);
  deadline.unref();
  socket.once("close", () => clearTimeout(deadline));
  req.resume();
  send(res, status, body, { connection: "close" });
}

function invoiceNumberOf(body: unknown): string | null {
  const invoice = (body as { invoice?: unknown } | null)?.invoice;
  const number = (invoice as { invoiceNumber?: unknown } | null)?.invoiceNumber;
  return typeof number === "string" && number.length > 0 ? number : null;
}

export async function startFakeRail(opts: FakeRailOptions = {}): Promise<FakeRail> {
  const host = opts.host ?? "127.0.0.1";
  const secret = opts.secret ?? DEFAULT_SECRET;
  const faults = new FaultScript();
  const held = new Map<string, StampFields>();
  const calls: FakeRailCall[] = [];
  const sockets = new Set<Socket>();
  const pendingTimeouts = new Set<NodeJS.Timeout>();

  function authorized(req: IncomingMessage): boolean {
    if (!opts.token) return true;
    return req.headers.authorization === `Bearer ${opts.token}`;
  }

  function record(
    req: IncomingMessage,
    partial: Omit<FakeRailCall, "method" | "path" | "authorized" | "idempotencyHeader">,
  ): void {
    const header = req.headers["idempotency-key"];
    calls.push({
      method: req.method ?? "",
      path: req.url ?? "",
      authorized: authorized(req),
      idempotencyHeader: typeof header === "string" ? header : null,
      ...partial,
    });
  }

  /** Hold the response until the client gives up (or the ceiling passes). */
  function holdOpen(res: ServerResponse): void {
    const timer = setTimeout(() => {
      pendingTimeouts.delete(timer);
      if (!res.writableEnded) send(res, 504, { code: "RAIL_TIMEOUT" });
    }, TIMEOUT_HOLD_MS);
    pendingTimeouts.add(timer);
    res.on("close", () => {
      clearTimeout(timer);
      pendingTimeouts.delete(timer);
    });
  }

  async function handleSubmit(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await readJson(req);
    } catch (err) {
      const tooLarge = err instanceof BodyTooLarge;
      record(req, {
        rail: null,
        invoiceNumber: null,
        idempotencyKey: null,
        outcome: tooLarge ? "too_large" : "unreadable",
        httpStatus: tooLarge ? 413 : 500,
      });
      sendAndClose(req, res, tooLarge ? 413 : 500, {
        code: tooLarge ? "PAYLOAD_TOO_LARGE" : "UNREADABLE_BODY",
        message: tooLarge ? "body over the fake rail's limit" : "unreadable body",
      });
      return;
    }
    const idempotencyKey = (body as { idempotencyKey?: unknown } | null)?.idempotencyKey;
    const rail = (body as { rail?: unknown } | null)?.rail;
    const invoiceNumber = invoiceNumberOf(body);
    const invoice = (body as { invoice?: unknown } | null)?.invoice as CanonicalInvoice | undefined;
    const meta = {
      rail: typeof rail === "string" ? rail : null,
      invoiceNumber,
      idempotencyKey: typeof idempotencyKey === "string" ? idempotencyKey : null,
    };
    if (!authorized(req)) {
      record(req, { ...meta, outcome: "unauthorized", httpStatus: 401 });
      send(res, 401, { code: "RAIL_UNAUTHORIZED", message: "bad credentials" });
      return;
    }
    if (typeof idempotencyKey !== "string" || !idempotencyKey || !invoice || !invoiceNumber) {
      record(req, { ...meta, outcome: "bad_request", httpStatus: 400 });
      send(res, 400, { code: "BAD_REQUEST", message: "idempotencyKey and invoice are required" });
      return;
    }
    // A key this rail already accepted is a duplicate whatever the script
    // says: that is what a real access point does.
    if (held.has(idempotencyKey)) {
      record(req, { ...meta, outcome: "duplicate", httpStatus: 409 });
      send(res, 409, { code: "MBS_DUPLICATE", message: "already stamped" });
      return;
    }
    const fault = faults.next(invoiceNumber, "submit") ?? { outcome: "accept" as const };
    const shape = RAIL_FAULT_TABLE[fault.outcome];
    switch (fault.outcome) {
      case "accept": {
        const stamp = deterministicStamp(invoice, idempotencyKey, secret);
        held.set(idempotencyKey, stamp);
        record(req, { ...meta, outcome: "accept", httpStatus: shape.httpStatus });
        send(res, shape.httpStatus, stamp);
        return;
      }
      case "duplicate": {
        if (fault.holdsStamp) {
          held.set(idempotencyKey, deterministicStamp(invoice, idempotencyKey, secret));
        }
        record(req, { ...meta, outcome: "duplicate", httpStatus: shape.httpStatus });
        send(res, shape.httpStatus, { code: "MBS_DUPLICATE", message: "already stamped" });
        return;
      }
      case "reject": {
        const code = sanitiseRejectionCode(fault.code) ?? shape.errorCode ?? "MBS_SCHEMA_INVALID";
        record(req, { ...meta, outcome: "reject", httpStatus: shape.httpStatus });
        send(res, shape.httpStatus, { code, message: `rejected: ${code}` });
        return;
      }
      case "timeout": {
        record(req, { ...meta, outcome: "timeout", httpStatus: 0 });
        holdOpen(res);
        return;
      }
      case "malformed": {
        // The rail DID stamp when holdsStamp: the answer just never made
        // sense to the client — the case the retry-then-409 path recovers.
        if (fault.holdsStamp) {
          held.set(idempotencyKey, deterministicStamp(invoice, idempotencyKey, secret));
        }
        record(req, { ...meta, outcome: "malformed", httpStatus: shape.httpStatus });
        send(res, shape.httpStatus, { stamp: "not the shape the profile defines" });
        return;
      }
      case "rate_limit":
      case "unavailable":
      case "unauthorized": {
        record(req, { ...meta, outcome: fault.outcome, httpStatus: shape.httpStatus });
        const headers: Record<string, string> =
          fault.outcome === "rate_limit"
            ? { "retry-after": String(Math.max(0, Math.floor(fault.retryAfterSeconds ?? 1))) }
            : {};
        send(res, shape.httpStatus, { code: shape.errorCode, message: fault.outcome }, headers);
        return;
      }
    }
  }

  function handleLookup(req: IncomingMessage, res: ServerResponse, encodedKey: string): void {
    let idempotencyKey: string;
    try {
      idempotencyKey = decodeURIComponent(encodedKey);
    } catch {
      record(req, { rail: null, invoiceNumber: null, idempotencyKey: encodedKey, outcome: "bad_request", httpStatus: 400 });
      send(res, 400, { code: "BAD_REQUEST" });
      return;
    }
    const invoiceNumber = idempotencyKey.includes(":")
      ? idempotencyKey.slice(idempotencyKey.indexOf(":") + 1)
      : null;
    const meta = { rail: null, invoiceNumber, idempotencyKey };
    if (!authorized(req)) {
      record(req, { ...meta, outcome: "unauthorized", httpStatus: 401 });
      send(res, 401, { code: "RAIL_UNAUTHORIZED", message: "bad credentials" });
      return;
    }
    const fault = invoiceNumber ? faults.next(invoiceNumber, "lookup") : null;
    if (fault && fault.outcome !== "accept") {
      const shape = RAIL_FAULT_TABLE[fault.outcome];
      record(req, { ...meta, outcome: `lookup_${fault.outcome}`, httpStatus: shape.httpStatus });
      if (fault.outcome === "timeout") {
        holdOpen(res);
        return;
      }
      if (fault.outcome === "malformed") {
        send(res, 200, { stamp: "not the shape the profile defines" });
        return;
      }
      if (fault.outcome === "reject" || fault.outcome === "duplicate") {
        send(res, 404, { code: "NOT_FOUND" });
        return;
      }
      send(res, shape.httpStatus, { code: shape.errorCode, message: fault.outcome });
      return;
    }
    const stamp = held.get(idempotencyKey);
    if (!stamp) {
      record(req, { ...meta, outcome: "lookup_miss", httpStatus: 404 });
      send(res, 404, { code: "NOT_FOUND" });
      return;
    }
    record(req, { ...meta, outcome: "lookup_hit", httpStatus: 200 });
    send(res, 200, stamp);
  }

  async function handleControl(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (req.method === "GET" && path === "/__fake/healthz") {
      send(res, 200, { ok: true, held: held.size, calls: calls.length });
      return;
    }
    if (req.method === "GET" && path === "/__fake/calls") {
      send(res, 200, calls);
      return;
    }
    if (req.method === "DELETE" && path === "/__fake") {
      reset();
      send(res, 204);
      return;
    }
    if (req.method === "PUT" && path === "/__fake/script") {
      let body: unknown;
      try {
        body = await readJson(req);
      } catch {
        sendAndClose(req, res, 400, { code: "BAD_REQUEST" });
        return;
      }
      const script = body as {
        invoiceNumber?: unknown;
        outcome?: unknown;
        code?: unknown;
        times?: unknown;
        holdsStamp?: unknown;
        op?: unknown;
        retryAfterSeconds?: unknown;
      } | null;
      if (
        !script ||
        typeof script.invoiceNumber !== "string" ||
        !script.invoiceNumber ||
        !isRailFaultOutcome(script.outcome) ||
        (script.op !== undefined && !isRailFaultOp(script.op))
      ) {
        send(res, 400, { code: "BAD_REQUEST", message: "invoiceNumber and a known outcome are required" });
        return;
      }
      const fault: RailFault = { outcome: script.outcome };
      if (typeof script.code === "string" && script.code) fault.code = script.code;
      if (typeof script.times === "number" && script.times > 0) fault.times = Math.floor(script.times);
      if (script.holdsStamp === true) fault.holdsStamp = true;
      if (isRailFaultOp(script.op)) fault.op = script.op;
      if (typeof script.retryAfterSeconds === "number" && script.retryAfterSeconds >= 0) {
        fault.retryAfterSeconds = script.retryAfterSeconds;
      }
      faults.script(script.invoiceNumber, fault);
      send(res, 204);
      return;
    }
    send(res, 404, { code: "NOT_FOUND" });
  }

  function reset(): void {
    faults.reset();
    held.clear();
    calls.length = 0;
  }

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    void (async () => {
      try {
        if (path.startsWith("/__fake")) {
          await handleControl(req, res, path);
        } else if (req.method === "POST" && path === "/v0/submissions") {
          await handleSubmit(req, res);
        } else if (req.method === "GET" && path.startsWith("/v0/submissions/")) {
          handleLookup(req, res, path.slice("/v0/submissions/".length));
        } else {
          send(res, 404, { code: "NOT_FOUND" });
        }
      } catch {
        if (!res.headersSent) send(res, 500, { code: "FAKE_RAIL_ERROR" });
        else res.end();
      }
    })();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 0);

  return {
    url: `http://${host}:${port}`,
    host,
    port,
    calls,
    held,
    script(invoiceNumber, fault) {
      faults.script(invoiceNumber, fault);
    },
    reset,
    async close() {
      for (const timer of pendingTimeouts) clearTimeout(timer);
      pendingTimeouts.clear();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
