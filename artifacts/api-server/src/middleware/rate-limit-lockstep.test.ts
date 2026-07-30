import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// NO_CONTEXT <-> MODEL rate-class lockstep (refactoring round, survey item 3).
// The rule has always been prose — app.ts and rate-limit.ts each tell the
// author of a model-calling NO_CONTEXT route to mirror it into the other
// list — and it has drifted TWICE (the round-18 intent-eval gap admitted at
// rate-limit.ts, and the round-22 execute-route gap the review caught). This
// test makes the rule structural: every literal NO_CONTEXT entry must be in
// the MODEL rate class OR on one of the two explicit allowlists below, and
// every parameterized NO_CONTEXT pattern must have a MODEL twin.
//
// Deliberately source-text based (like the sibling posture tests): importing
// app.ts would drag the whole route registry and its sweep-registration side
// effects into a unit test.
//
// Known limitation, stated so nobody over-trusts it: this pins only routes
// that LEFT the request transaction. A model-calling route that stays
// in-transaction (the digest-posture single-completion routes) is invisible
// here — that class has its own deferred fix item (survey item 20).

const src = (rel: string): string =>
  readFileSync(join(import.meta.dirname, "..", rel), "utf8");

function literalEntries(source: string, marker: string): string[] {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${marker} exists`);
  const end = source.indexOf("])", start);
  return [...source.slice(start, end).matchAll(/"((?:GET|POST|PATCH|PUT|DELETE) [^"]+)"/g)].map(
    (m) => m[1],
  );
}

function patternEntries(
  source: string,
  marker: string,
): { method: string; pattern: string }[] {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${marker} exists`);
  const end = source.indexOf("];", start);
  return [
    ...source
      .slice(start, end)
      .matchAll(/method: "(\w+)", pattern: (\/\^.*?\$\/)/g),
  ].map((m) => ({ method: m[1], pattern: m[2] }));
}

// NO_CONTEXT routes that make NO model call — each escaped the request
// transaction for a documented non-model reason (audit-lock convoy or
// commit-before-kick ordering). Growing this list is an explicit decision,
// not a drive-by.
const NON_MODEL_NO_CONTEXT = new Set([
  "POST /api/clerk/cases/bulk-approve",
  "POST /api/billing/payments/confirm",
  "POST /api/collections/inbound",
  // Posture round: no model call — left the request transaction because a
  // 200-row batch would hold the global audit advisory lock batch-wide
  // (modules/invoice/bulk-submit.ts commits per stage instead).
  "POST /api/invoices/bulk-submit",
]);

// Public machine rails: exempt from the authenticated rate classes because
// PUBLIC_PATHS routes carry their own shared-secret gates and per-firm
// daily caps (rate-limit.ts header).
const PUBLIC_RAIL_NO_CONTEXT = new Set([
  "POST /api/inbound/email",
  "POST /api/inbound/whatsapp",
]);

test("every NO_CONTEXT route is rate-classed or explicitly allowlisted", () => {
  const noContext = literalEntries(src("app.ts"), "NO_CONTEXT_ROUTES = new Set(");
  const model = new Set(
    literalEntries(src("middleware/rate-limit.ts"), "MODEL_RATE_LIMITED_ROUTES"),
  );
  assert.ok(noContext.length >= 10, "the NO_CONTEXT list parsed");
  for (const route of noContext) {
    assert.ok(
      model.has(route) ||
        NON_MODEL_NO_CONTEXT.has(route) ||
        PUBLIC_RAIL_NO_CONTEXT.has(route),
      `${route} left the request transaction but is neither in MODEL_RATE_LIMITED_ROUTES nor on an explicit allowlist — if it calls a model it MUST join the MODEL class (this exact drift shipped in rounds 18 and 22); if it does not, add it to the allowlist here WITH its reason`,
    );
  }
});

test("the allowlists stay honest", () => {
  const noContext = new Set(
    literalEntries(src("app.ts"), "NO_CONTEXT_ROUTES = new Set("),
  );
  const model = new Set(
    literalEntries(src("middleware/rate-limit.ts"), "MODEL_RATE_LIMITED_ROUTES"),
  );
  for (const route of [...NON_MODEL_NO_CONTEXT, ...PUBLIC_RAIL_NO_CONTEXT]) {
    assert.ok(
      noContext.has(route),
      `${route} is allowlisted here but no longer in NO_CONTEXT_ROUTES — delete the stale entry`,
    );
    assert.ok(
      !model.has(route),
      `${route} is on a non-model allowlist AND in the MODEL class — one of the two is wrong`,
    );
  }
});

test("every parameterized NO_CONTEXT pattern has a MODEL twin", () => {
  const noContextPatterns = patternEntries(
    src("app.ts"),
    "NO_CONTEXT_ROUTE_PATTERNS",
  );
  const modelPatterns = patternEntries(
    src("middleware/rate-limit.ts"),
    "MODEL_RATE_LIMITED_ROUTE_PATTERNS",
  );
  assert.ok(noContextPatterns.length >= 1, "the pattern list parsed");
  for (const { method, pattern } of noContextPatterns) {
    assert.ok(
      modelPatterns.some((m) => m.method === method && m.pattern === pattern),
      `${method} ${pattern} is NO_CONTEXT (a provider-calling shape by construction — the literal list holds the non-model exemptions) but has no identical MODEL pattern twin`,
    );
  }
});

test("the public machine rails really are public-path gated", () => {
  const principalSrc = src("middleware/principal.ts");
  const start = principalSrc.indexOf("PUBLIC_PATHS = new Set(");
  assert.ok(start >= 0);
  const block = principalSrc.slice(start, principalSrc.indexOf("])", start));
  for (const route of PUBLIC_RAIL_NO_CONTEXT) {
    const path = route.split(" ")[1];
    assert.ok(
      block.includes(`"${path}"`),
      `${path} is exempted from the MODEL class as a public rail but is not in PUBLIC_PATHS — it would ride the authenticated GENERAL class with no shared-secret story`,
    );
  }
});

// ---------------------------------------------------------------------------
// The gateway-scan pin (fix round, survey item 20): the lockstep tests above
// only see routes that LEFT the request transaction — a model-calling route
// that stays in-transaction (the digest-posture single completions) was
// invisible, and exactly that class drifted three times (rounds 18, 22, and
// compliance-pack). This scan closes it: every route registration whose
// HANDLER BLOCK touches the gateway (gatewayOrNull / getClerkGateway /
// assertFirmClerkBudget) must be in the MODEL rate class.
// Known limitation: a handler that calls a model-invoking MODULE function
// without touching the gateway in the route block itself is still invisible
// — keep gateway acquisition in the route (the codebase's convention). The
// verified inventory of such cases today (review of commit 11b0939), each
// covered by a SIBLING pin: POST /api/clerk/action-proposals/execute
// (gateway acquired inside modules/clerk/actions.ts — the NO_CONTEXT
// lockstep test above holds it in the MODEL class) and the two public
// inbound rails (gateway inside modules/inbound — the PUBLIC_PATHS test).
// ---------------------------------------------------------------------------

import { readdirSync as readdir, statSync } from "node:fs";

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdir(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const GATEWAY_MARKS = ["gatewayOrNull(", "getClerkGateway(", "assertFirmClerkBudget("];

test("every gateway-touching route handler is in the MODEL rate class", () => {
  const model = new Set(
    literalEntries(src("middleware/rate-limit.ts"), "MODEL_RATE_LIMITED_ROUTES"),
  );
  const modelPatterns = patternEntries(
    src("middleware/rate-limit.ts"),
    "MODEL_RATE_LIMITED_ROUTE_PATTERNS",
  ).map((p) => ({
    method: p.method,
    // The captured text is the literal /^...$/ source — evaluate it.
    regex: new RegExp(p.pattern.slice(1, -1)),
  }));

  const registration = /router\.(get|post|patch|put|delete)\(\s*\n?\s*"([^"]+)"/g;
  let scanned = 0;
  for (const file of routeFiles(join(import.meta.dirname, "..", "routes"))) {
    const source = readFileSync(file, "utf8");
    if (!GATEWAY_MARKS.some((m) => source.includes(m))) continue;
    const matches = [...source.matchAll(registration)];
    for (let i = 0; i < matches.length; i++) {
      const block = source.slice(
        matches[i].index,
        i + 1 < matches.length ? matches[i + 1].index : undefined,
      );
      if (!GATEWAY_MARKS.some((m) => block.includes(m))) continue;
      scanned++;
      const method = matches[i][1].toUpperCase();
      const path = `/api${matches[i][2]}`;
      const literal = `${method} ${path}`;
      // Parameterized paths probe the pattern list with :segments filled in.
      const probe = path.replace(/:[^/]+/g, "probe");
      assert.ok(
        model.has(literal) ||
          modelPatterns.some((p) => p.method === method && p.regex.test(probe)),
        `${literal} (${file.split("/src/")[1]}) touches the Clerk gateway in its handler but is not in the MODEL rate class — the round-18/22/compliance-pack drift, recurring`,
      );
    }
  }
  assert.ok(
    scanned >= 20,
    `the gateway scan found only ${scanned} gateway-touching handlers (24 at the time of writing) — the registration parser has likely drifted from the route style`,
  );
});

// ---------------------------------------------------------------------------
// The bare-infer scan (fix round, TOCTOU class): every PHRASING surface must
// reach the model through inferPhrasing (gateway.ts) — the wrapper that
// re-checks the clerk_ai flag and folds every gateway failure to null, so a
// kill-switch flip between a surface's own flag check and the call can never
// throw CLERK_DISABLED out of a "template always answers" surface. That
// drift shipped FOUR times (draft-reply in #93; narrative, digest and
// client-statement in this round), so the rule is now structural: a module
// file may contain a bare `<gateway>.infer` call ONLY if it is gateway.ts
// itself (inferPhrasing's internals) or on the allowlist below, each entry
// carrying the reason a naked call is correct there. A NEW phrasing surface
// (template fallback + "clerk"/"template" source tag) must use inferPhrasing
// — a params mismatch means fixing the params, or justifying a new allowlist
// entry with a documented local try/catch.
// Known limitation: the scan keys on the `.infer` member name with a
// non-`z` receiver (the codebase convention names the binding `gateway`);
// laundering the call through an alias of the METHOD itself would evade it
// — that is a review-visible contortion, not a drift.
// ---------------------------------------------------------------------------

// modules/-relative path -> why a bare gateway.infer is correct there.
const BARE_INFER_ALLOWED = new Map<string, string>([
  // Classification/extraction/segmentation surfaces: a typed failure REFUSES
  // or marks the work item failed — there is no template to fall back to,
  // and a mid-request kill-switch throw is their documented 503 posture.
  ["clerk/ask.ts", "intent classification — failure refuses and escalates"],
  ["clerk/batch.ts", "segmentation — failure fails the batch (typed 502)"],
  ["clerk/cases.ts", "extraction — failure marks the case failed"],
  ["clerk/scan-batch.ts", "vision segmentation — coverage-validated, fails the scan"],
  ["statements/scan-intake.ts", "statement extraction — typed operator-facing failure"],
  ["desk/triage.ts", "closed-enum triage — failure marks the item failed, sweep moves on"],
  // Drafting proposals: a failed draft is a typed refusal the user sees and
  // retries; silently substituting template text would misrepresent it.
  ["clerk/draft-catalogue.ts", "drafting proposal — typed refusal on failure"],
  ["clerk/draft-claim.ts", "drafting proposal — typed refusal on failure"],
  ["clerk/draft-client-import.ts", "drafting proposal — typed refusal on failure"],
  ["clerk/draft-format.ts", "drafting proposal — typed refusal on failure"],
  ["clerk/draft-invoice.ts", "drafting proposal — typed refusal on failure"],
  // Eval/canary machinery: a kill-switch throw must ABORT the run — folding
  // it to null would silently score zeros and corrupt the cohorts.
  ["clerk/eval.ts", "eval machinery — a throw aborts the run"],
  ["clerk/intent-eval.ts", "eval machinery — a throw aborts the run"],
  ["clerk/phrasing-eval.ts", "eval machinery — a throw aborts the run"],
  ["clerk/prompt-canary.ts", "canary machinery — a throw aborts the run"],
  ["clerk/red-team.ts", "adversarial eval generation — a throw aborts the run"],
]);

function moduleFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdir(dir)) {
    const full = join(dir, name);
    const relPath = rel ? `${rel}/${name}` : name;
    if (statSync(full).isDirectory()) out.push(...moduleFiles(full, relPath));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts"))
      out.push(relPath);
  }
  return out;
}

// A member CALL `<receiver>.infer<...>(...)` / `<receiver>.infer(...)` whose
// receiver is not the zod namespace (`z.infer<...>` is the ubiquitous
// TYPE-level usage and never a model call). Comments are stripped first —
// several surfaces' history comments NAME gateway.infer in prose.
const BARE_INFER_RE = /\b([A-Za-z_$][\w$]*)\.infer\s*[<(]/g;

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

test("no module calls gateway.infer outside gateway.ts and the allowlist", () => {
  const modulesDir = join(import.meta.dirname, "..", "modules");
  const found = new Set<string>();
  for (const rel of moduleFiles(modulesDir)) {
    if (rel === "clerk/gateway.ts") continue; // inferPhrasing's own internals
    const source = stripComments(readFileSync(join(modulesDir, rel), "utf8"));
    for (const m of source.matchAll(BARE_INFER_RE)) {
      if (m[1] === "z") continue;
      found.add(rel);
      assert.ok(
        BARE_INFER_ALLOWED.has(rel),
        `${rel} calls ${m[1]}.infer directly — a phrasing surface here is the kill-switch TOCTOU that shipped four times. Route it through inferPhrasing (gateway.ts); if a bare call is genuinely correct (no template fallback, or a documented local try/catch), add the file to BARE_INFER_ALLOWED with its reason`,
      );
    }
  }
  // The allowlist stays honest: an entry whose file no longer contains a
  // bare call is stale and must be deleted, or it will mask a future one.
  for (const rel of BARE_INFER_ALLOWED.keys()) {
    assert.ok(
      found.has(rel),
      `${rel} is in BARE_INFER_ALLOWED but no longer contains a bare .infer call — delete the stale entry`,
    );
  }
  assert.ok(found.size >= 10, "the bare-infer scan parsed the module tree");
});
