import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { src } from "../../test-helpers/source-pins.ts";
import { RELEASE_FLAGS } from "./releases.ts";

// Launch-profile tripwires (PL-02): the trim-to-launch posture lives in the
// release manifest and in route wiring no module test reaches. Reverting any
// of it — a flag quietly flipped to launch-lit, a gate dropped from a ledger
// route — silently widens what a fresh production boot exposes while the
// suite stays green. Changing a pin here is an ACTIVATION DECISION: update
// the manifest deliberately, then this test, in the same change.

// The R0 Field Kit core — the ONLY flags a fresh production database lights.
const LAUNCH_LIT = [
  "advisory_engagements",
  "consent_ledger",
  "invoice_lifecycle",
];

// Flags deliberately NOT seeded ("dark-by-absence"): they resolve false until
// a row is inserted by hand, a stricter posture than a seeded-dark row (the
// operator flags surface is UPDATE-only and cannot create them).
const DARK_BY_ABSENCE = [
  "clerk_digest",
  "clerk_client_statements",
  "clerk_triage",
];

test("the manifest is well-formed and the launch profile lights ONLY the R0 core", () => {
  const keys = RELEASE_FLAGS.map((f) => f.key);
  assert.equal(new Set(keys).size, keys.length, "flag keys are unique");
  for (const f of RELEASE_FLAGS) {
    assert.match(
      f.releaseTag,
      /^R[0-4]$/,
      `${f.key} carries a roadmap release tag`,
    );
    assert.ok(f.description.length > 0, `${f.key} says what it gates`);
  }
  assert.deepEqual(
    RELEASE_FLAGS.filter((f) => f.launchDefault)
      .map((f) => f.key)
      .sort(),
    LAUNCH_LIT,
    "launchDefault=true is the R0 core exactly — lighting anything else at launch is an activation decision, not a default",
  );
  for (const f of RELEASE_FLAGS.filter((x) => x.launchDefault)) {
    assert.equal(
      f.releaseTag,
      "R0",
      `${f.key} is launch-lit, so it must be R0`,
    );
  }
  for (const key of DARK_BY_ABSENCE) {
    assert.ok(
      !keys.includes(key),
      `${key} must stay dark-by-absence — seeding it would relax its posture`,
    );
  }
});

test("the launch-dark opt-ins the roadmap deferred stay launch-dark, dev-lit", () => {
  // Dev/CI/demo need these lit (the e2e journeys and the live demo drive
  // them); production boots them dark until their activation gate.
  const deferred = [
    "buyer_confirmations",
    "clerk_ai",
    "clerk_ai_runtime",
    "client_reports",
    "collection_accounts",
    "money_analytics",
    "stamp_verification",
    "statutory_desks",
  ];
  for (const key of deferred) {
    const flag = RELEASE_FLAGS.find((f) => f.key === key);
    assert.ok(flag, `${key} is in the manifest`);
    assert.equal(flag.launchDefault, false, `${key} ships dark at launch`);
    assert.equal(flag.devDefault, true, `${key} stays lit in dev/CI/demo`);
  }
});

test("Clerk composes a global runtime wall with per-firm entitlement", () => {
  const flags = src("modules/flags/flags.ts");
  assert.ok(
    flags.includes('export const CLERK_ENTITLEMENT_FLAG_KEY = "clerk_ai"') &&
      flags.includes(
        'export const CLERK_RUNTIME_FLAG_KEY = "clerk_ai_runtime"',
      ),
    "the independent entitlement and runtime controls are named centrally",
  );
  assert.ok(
    flags.includes("if (!runtimeEnabled) return false") &&
      flags.includes("lit.delete(CLERK_RUNTIME_FLAG_KEY)") &&
      flags.includes("if (key === CLERK_RUNTIME_FLAG_KEY)"),
    "a dark runtime always wins and its internal key is not exposed as a client capability",
  );
  assert.ok(
    src("routes/clerk/index.ts").includes(
      'router.use("/clerk", requireFlag("clerk_ai"))',
    ),
    "every Clerk route rides the path-prefixed effective gate",
  );
  assert.ok(
    src("routes/auth.ts").includes(
      "features: await litFeatureKeys(membership.firmId)",
    ),
    "the sign-in response composes the member's firm entitlement instead of runtime alone",
  );
  for (const file of [
    "modules/clerk/ask-memory.ts",
    "modules/clerk/batch-async.ts",
    "modules/clerk/memory.ts",
    "modules/desk/draft-reply.ts",
  ]) {
    assert.ok(
      !src(file).includes("isFeatureEnabled(CLERK_FLAG_KEY,"),
      `${file} must not apply a firm override to the global runtime key`,
    );
  }
});

test("the seed maps the manifest through the NODE_ENV branch", () => {
  const seed = src("bootstrap/seed.ts");
  assert.ok(
    seed.includes('import { RELEASE_FLAGS } from "../modules/flags/releases"'),
    "the seed's flag rows come from the manifest, not a local list",
  );
  assert.ok(
    seed.includes('process.env.NODE_ENV === "production"') &&
      seed.includes("IS_PRODUCTION ? f.launchDefault : f.devDefault"),
    "a fresh production boot takes launchDefault; everything else devDefault",
  );
  const insertAt = seed.indexOf("for (const flag of FLAGS)");
  assert.ok(insertAt >= 0, "the flag insert loop exists");
  assert.ok(
    seed
      .slice(insertAt, insertAt + 400)
      .includes("onConflictDoNothing({ target: featureFlagsTable.key })"),
    "flag seeding stays insert-if-absent — an existing database keeps its operator-set state",
  );
});

// The grouped ledger gates (R62): per-route flags on the surfaces the
// roadmap deferred. A dropped requireFlag here reopens a route on a
// launch-profile database with no failing test anywhere else. Per-route is
// load-bearing, not style: routers mount prefix-less in routes/index.ts, so
// a router.use() gate intercepts every request that merely flows PAST the
// router — 404ing the rest of the API when the flag is dark, and 500ing the
// principal-less machine rails always (requireFlag reads req.principal).
test("every route in the deferred ledger files rides its grouped flag", () => {
  const gates: [string, string][] = [
    ["routes/filings.ts", "statutory_desks"],
    ["routes/filing-matrix.ts", "statutory_desks"],
    ["routes/wht.ts", "statutory_desks"],
    ["routes/obligations.ts", "statutory_desks"],
    ["routes/bills.ts", "money_analytics"],
    ["routes/recurring.ts", "money_analytics"],
    ["routes/compliance-pack.ts", "client_reports"],
  ];
  for (const [file, flag] of gates) {
    const source = src(file);
    const routes = source.match(/router\.(get|post|patch|put|delete)\(/g) ?? [];
    const gated = source.split(`requireFlag("${flag}")`).length - 1;
    assert.ok(routes.length > 0, `${file} registers routes`);
    assert.equal(
      gated,
      routes.length,
      `${file}: every one of its ${routes.length} routes carries requireFlag("${flag}")`,
    );
  }
});

test("no route file gates a whole router (the prefix-less mounting trap)", () => {
  const routesDir = join(import.meta.dirname, "../../routes");
  for (const file of readdirSync(routesDir, { recursive: true })) {
    const name = String(file);
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    assert.ok(
      !src(join("routes", name)).includes("router.use(requireFlag"),
      `routes/${name}: router.use(requireFlag(...)) would gate every request that flows past this router — gate per route instead`,
    );
  }
});

test("collections: the firm routes ride the flag; the machine rail does not", () => {
  const routesSrc = src("routes/collections.ts");
  const gated =
    routesSrc.split('requireFlag("collection_accounts")').length - 1;
  assert.equal(
    gated,
    4,
    "all four firm-facing collection-account routes carry the flag (list, unmatched, create, deactivate)",
  );
  // The inbound webhook is a provider machine rail governed solely by its
  // fail-closed shared token (collections-posture.test.ts pins that): a flag
  // here would let a platform toggle silently drop provider settles.
  const inboundStart = routesSrc.indexOf('"/collections/inbound"');
  assert.ok(inboundStart >= 0, "the inbound rail exists");
  const inboundBlock = routesSrc.slice(
    inboundStart,
    routesSrc.indexOf("router.", routesSrc.indexOf("=>", inboundStart)),
  );
  assert.ok(
    !inboundBlock.includes("requireFlag"),
    "the inbound rail must NOT be flag-gated — its token is the only governor",
  );
});

// The client half of PL-02: the apps hide dark surfaces by Me.features
// instead of navigating into a flag-gated 404.
test("Me.features is wired end to end", () => {
  assert.ok(
    src("modules/flags/flags.ts").includes(
      "export async function litFeatureKeys",
    ),
    "the lit-keys resolver exists",
  );
  assert.ok(
    src("routes/identity.ts").includes("features: await litFeatureKeys("),
    "/me answers with the lit feature keys",
  );
  assert.ok(
    src("routes/auth.ts").includes("features: await litFeatureKeys("),
    "the sign-in payload answers with the lit feature keys",
  );
});
