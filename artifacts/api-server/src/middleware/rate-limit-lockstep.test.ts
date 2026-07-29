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
