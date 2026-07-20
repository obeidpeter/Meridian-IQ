// Load smoke — an ADVISORY latency probe against an already-running api
// server. Deliberately NOT wired into CI: run it by hand (or from a scratch
// session) when you want a quick p50/p95 read on the hot read paths.
//
// Usage:
//   1. Boot a server the way scripts/src/e2e/run.mjs does, e.g.:
//        pnpm --filter @workspace/api-server run build
//        DATABASE_URL=postgresql://.../meridian_ci SEED_DEMO=true \
//          NODE_ENV=development PORT=5100 \
//          node --enable-source-maps artifacts/api-server/dist/index.mjs
//      (any running dev server with the demo seed works — the script signs in
//      through the ordinary demo login, no mock headers).
//   2. API_URL=http://127.0.0.1:5100 pnpm --filter @workspace/scripts run load-smoke
//
// Env:
//   API_URL                        target server (default http://127.0.0.1:5100)
//   LOAD_SMOKE_P95_MS              per-route p95 gate in ms (default 1000 — generous
//                                  on purpose; this is a smoke, not a benchmark)
//   LOAD_SMOKE_REQUESTS_PER_ROUTE  timed requests per route (default 40 → ~200 total)
//   LOAD_SMOKE_CONCURRENCY         in-flight request cap (default 4)
//
// What it hits: 5 hot GET routes only — invoices list, dashboard summary,
// receivables aging, cash-flow outlook, clerk case list. NO model-calling
// route is ever touched (those spend real Clerk token budget and sit behind
// the tighter model rate-limit class).
//
// Rate-limit budget: the general limiter allows 600 requests/min PER
// PRINCIPAL (middleware/rate-limit.ts). The run is split across two demo
// principals (firm staff and firm admin: 2 routes ≈ 80 requests vs 3 routes
// ≈ 120 requests at the defaults), so either side stays far below the ceiling
// even if the whole run completes inside one minute. Logins are PUBLIC_PATHS
// and exempt. Keep LOAD_SMOKE_REQUESTS_PER_ROUTE under ~150 to preserve that
// headroom.
//
// Exit codes: 0 = all p95s under the gate; 1 = a route's p95 exceeded it;
// 2 = operational failure (login refused, request errored or non-2xx) — the
// numbers would be meaningless, so the threshold verdict is never reported.

import { performance } from "node:perf_hooks";

const API_URL = (process.env.API_URL ?? "http://127.0.0.1:5100").replace(/\/$/, "");
const P95_GATE_MS = Number(process.env.LOAD_SMOKE_P95_MS ?? 1000);
const PER_ROUTE = Number(process.env.LOAD_SMOKE_REQUESTS_PER_ROUTE ?? 40);
const CONCURRENCY = Math.max(1, Number(process.env.LOAD_SMOKE_CONCURRENCY ?? 4));

// Demo identities and fixed demo ids (bootstrap/seed.ts: DEMO, DEMO_PASSWORD).
const DEMO_PASSWORD = "meridian2027";
const STAFF_EMAIL = "demo.staff@meridianiq.example";
const ADMIN_EMAIL = "demo.admin@meridianiq.example";
const CLIENT_PARTY_ID = "22222222-2222-4222-8222-222222222222";

function fail(msg) {
  console.error(`load-smoke: ${msg}`);
  process.exit(2);
}

// The mobile-client login variant returns the session token in the body
// (browser logins are cookie-only); the ordinary demo password signs in.
async function login(email) {
  let res;
  try {
    res = await fetch(`${API_URL}/api/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-meridian-client": "mobile",
      },
      body: JSON.stringify({ email, password: DEMO_PASSWORD }),
    });
  } catch (err) {
    fail(`cannot reach ${API_URL} (${err.message}) — is the server running?`);
  }
  if (!res.ok) {
    fail(`login for ${email} returned ${res.status} — is SEED_DEMO enabled on the target?`);
  }
  const body = await res.json();
  if (!body.token) fail(`login for ${email} returned no bearer token`);
  return body.token;
}

const staffToken = await login(STAFF_EMAIL);
const adminToken = await login(ADMIN_EMAIL);

// Hot GET routes only; two principals split the rate-limit budget.
const ROUTES = [
  { name: "GET /api/invoices", path: "/api/invoices", token: staffToken },
  {
    name: "GET /api/dashboard/summary",
    path: `/api/dashboard/summary?clientPartyId=${CLIENT_PARTY_ID}`,
    token: staffToken,
  },
  {
    name: "GET /api/dashboard/receivables",
    path: `/api/dashboard/receivables?clientPartyId=${CLIENT_PARTY_ID}`,
    token: adminToken,
  },
  {
    name: "GET /api/dashboard/cashflow",
    path: `/api/dashboard/cashflow?clientPartyId=${CLIENT_PARTY_ID}`,
    token: adminToken,
  },
  { name: "GET /api/clerk/cases", path: "/api/clerk/cases", token: adminToken },
];

async function timedRequest(route) {
  const start = performance.now();
  const res = await fetch(`${API_URL}${route.path}`, {
    headers: { authorization: `Bearer ${route.token}` },
  });
  const ms = performance.now() - start;
  // Drain the body so keep-alive sockets are reusable and timing is honest.
  await res.arrayBuffer();
  if (!res.ok) {
    throw new Error(`${route.name} returned ${res.status}`);
  }
  return ms;
}

// One untimed warm-up call per route (connection setup, code paths, caches).
for (const route of ROUTES) {
  await timedRequest(route).catch((err) => fail(`warm-up failed: ${err.message}`));
}

// Round-robin task list (routes interleaved, like real traffic) drained by a
// small worker pool — sequential per worker, CONCURRENCY in flight overall.
const tasks = [];
for (let i = 0; i < PER_ROUTE; i++) {
  for (const route of ROUTES) tasks.push(route);
}
const latencies = new Map(ROUTES.map((r) => [r.name, []]));
const failures = [];
let cursor = 0;

async function worker() {
  while (cursor < tasks.length) {
    const route = tasks[cursor++];
    try {
      latencies.get(route.name).push(await timedRequest(route));
    } catch (err) {
      failures.push(err.message);
    }
  }
}

const runStart = performance.now();
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
const runMs = performance.now() - runStart;

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

console.log(
  `load-smoke: ${tasks.length} requests against ${API_URL} in ${(runMs / 1000).toFixed(1)}s ` +
    `(concurrency ${CONCURRENCY}, p95 gate ${P95_GATE_MS}ms)\n`,
);
console.log(
  "route".padEnd(36) + "count".padStart(6) + "p50 ms".padStart(9) + "p95 ms".padStart(9) + "max ms".padStart(9),
);

let gateBreached = false;
for (const route of ROUTES) {
  const sorted = [...latencies.get(route.name)].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const max = sorted[sorted.length - 1];
  const over = p95 > P95_GATE_MS;
  if (over) gateBreached = true;
  console.log(
    route.name.padEnd(36) +
      String(sorted.length).padStart(6) +
      p50.toFixed(1).padStart(9) +
      p95.toFixed(1).padStart(9) +
      max.toFixed(1).padStart(9) +
      (over ? "  << p95 over gate" : ""),
  );
}

if (failures.length > 0) {
  console.error(`\nload-smoke: ${failures.length} request(s) failed; first: ${failures[0]}`);
  process.exit(2);
}
if (gateBreached) {
  console.error(`\nload-smoke: a route's p95 exceeded ${P95_GATE_MS}ms (LOAD_SMOKE_P95_MS)`);
  process.exit(1);
}
console.log(`\nload-smoke: OK — every route p95 under ${P95_GATE_MS}ms`);
