import { test } from "node:test";
import assert from "node:assert/strict";
import { ROLE_CAPABILITIES } from "../modules/auth/rbac.ts";
import { routeBlock, setBlock, src } from "../test-helpers/source-pins.ts";

// Route-posture tripwires. These invariants live in route wiring that no
// module test can reach (there is no HTTP-level harness; the e2e journeys
// exercise happy paths only), yet reverting any of them breaks a shipped
// flow while the whole suite stays green:
//
//  - the SME "Fix with Clerk" card depends on /clerk/explain-failure being
//    reachable with clerk.capture (the capture capability names the client
//    fix-and-retry surface; clerk.ask is the Q&A surface);
//  - /clerk/draft-invoice must check the firm budget BEFORE the module runs,
//    or an exhausted firm still pays for a transcription and only then 429s;
//  - the voice path makes two sequential provider calls, so the route must
//    run OUTSIDE the per-request transaction (app.ts NO_CONTEXT_ROUTES) or a
//    long voice note hits the 30s transaction cap and pins a pooled
//    connection for its whole duration.
//
// Source-text assertions are deliberately narrow: each targets one route
// block, so they fail loudly on the specific revert they guard against.
//
// The Clerk surface lives in routes/clerk/ (split by concern; see the
// barrel's map in routes/clerk/index.ts) — each tripwire reads the group
// file that carries its route.

test("explain-failure stays reachable for the client who owns the failed invoice", () => {
  const block = routeBlock(
    src("routes/clerk/ask.ts"),
    "/clerk/explain-failure",
  );
  assert.ok(
    block.includes('assertCan(req.principal, "clerk.capture")'),
    "explain-failure must gate on clerk.capture — clerk.ask would lock out client_users and break the SME fix-and-retry card",
  );
  assert.ok(
    block.includes("gatewayOrNull()"),
    "explain-failure is a digest-posture surface: a provider that cannot even load must yield the catalogue fallback (module accepts null), never a 500 from a bare getClerkGateway()",
  );
});

test("draft-invoice checks the firm budget before any provider spend", () => {
  const block = routeBlock(
    src("routes/clerk/drafts.ts"),
    "/clerk/draft-invoice",
  );
  const budgetAt = block.indexOf("assertFirmClerkBudget");
  const moduleAt = block.indexOf("draftInvoiceWithClerk(");
  assert.ok(budgetAt >= 0, "the route checks the budget");
  assert.ok(moduleAt >= 0, "the route calls the module");
  assert.ok(
    budgetAt < moduleAt,
    "budget gate must run before the module — the voice path pays for a transcription before the gateway backstop can refuse",
  );
});

test("draft-invoice runs outside the per-request transaction", () => {
  assert.ok(
    setBlock(src("app.ts"), "NO_CONTEXT_ROUTES = new Set(").includes(
      '"POST /api/clerk/draft-invoice"',
    ),
    "two sequential provider calls (transcription + inference) must not hold a pooled connection under the 30s request-transaction cap",
  );
});

// ---- Client-facing Ask (SEC-03) ---------------------------------------------
// clerk.ask was widened to client_user for the Ask surface ONLY. The wall
// keeping firm-wide facts from a client is now split across three places
// that no single module test sees together: the capability grant, the ask
// route passing the client posture into the module, and the digest route's
// explicit client refusal. Each gets a tripwire.

test("client_user holds clerk.ask (Ask) but never clerk.use (review)", () => {
  assert.ok(
    ROLE_CAPABILITIES.client_user.includes("clerk.ask"),
    "the client Ask surface needs the capability",
  );
  assert.ok(
    !ROLE_CAPABILITIES.client_user.includes("clerk.use"),
    "review/decide must stay operator-only",
  );
});

test("the ask route passes the principal-derived client posture into the module", () => {
  const block = routeBlock(src("routes/clerk/ask.ts"), "/clerk/ask");
  assert.ok(
    block.includes('clientScoped: req.principal.role === "client_user"'),
    "askClerk must learn it is serving a client from the PRINCIPAL",
  );
  assert.ok(
    block.includes("clientPartyId: clientPartyScope(req.principal)"),
    "the forced party scope must come from the principal, never the body",
  );
  const budgetAt = block.indexOf("assertFirmClerkBudget");
  const moduleAt = block.indexOf("askClerk(");
  assert.ok(
    budgetAt >= 0 && moduleAt >= 0 && budgetAt < moduleAt,
    "a client's Ask spends the firm budget exactly like staff Ask — the pre-check must run before the module",
  );
});

test("the digest route refuses client_user despite the shared capability", () => {
  const block = routeBlock(src("routes/clerk/reports.ts"), "/clerk/digest");
  assert.ok(
    block.includes('assertCan(req.principal, "clerk.ask")'),
    "the digest keeps its clerk.ask gate for firm principals",
  );
  const guardAt = block.indexOf('req.principal.role === "client_user"');
  const readAt = block.indexOf("latestDigestForFirm(");
  assert.ok(
    guardAt >= 0,
    "the digest is firm-internal: client_user must be refused explicitly — the capability was widened for Ask, not for this",
  );
  assert.ok(
    readAt >= 0 && guardAt < readAt,
    "the client refusal must run before the digest is read",
  );
  assert.ok(
    block.slice(guardAt, readAt).includes("403"),
    "the refusal must be a 403, not a silent empty answer",
  );
});

test("bulk approval is operator-gated and runs OUTSIDE the request transaction", () => {
  const block = routeBlock(
    src("routes/clerk/cases.ts"),
    "/clerk/cases/bulk-approve",
  );
  assert.ok(
    block.includes('assertCan(req.principal, "clerk.use")'),
    "bulk approval is a review decision — operator-only like the single endpoint",
  );
  // Deliberate posture: no model call, but each of up to 50 decideCase items
  // appends audit rows, and appendAudit serializes on a GLOBAL advisory xact
  // lock. Inside one request transaction the first item's lock would be held
  // until the whole batch committed — a platform-wide appendAudit convoy, a
  // 30s-cap risk, and a deadlock window against the row-lock→audit-lock
  // ordering of reject/claim. The module instead commits each item in its
  // own short bypass transaction (bulk-approve.ts), so the route must skip
  // the ambient transaction.
  assert.ok(
    setBlock(src("app.ts"), "NO_CONTEXT_ROUTES = new Set(").includes(
      '"POST /api/clerk/cases/bulk-approve"',
    ),
    "bulk-approve must run outside the request transaction: per-item commits keep the global audit lock per-item and a decided item durable (bulk-submit semantics)",
  );
  assert.ok(
    src("modules/clerk/bulk-approve.ts").includes(
      "runRequestContext({ bypass: true, firmId: null }",
    ),
    "each bulk-approve item must open its own short bypass transaction — the RLS posture the operator's request transaction carried",
  );
});

test("BOTH inbound rails run outside the request transaction", () => {
  // Each rail commits a durable outbox row before returning 202. The request
  // must be NO_CONTEXT so queue insertion and later worker processing own
  // independent transactions and cannot inherit a tenant request connection.
  const set = setBlock(src("app.ts"), "NO_CONTEXT_ROUTES = new Set(");
  assert.ok(
    set.includes('"POST /api/inbound/email"'),
    "the inbound email webhook must skip the request transaction",
  );
  assert.ok(
    set.includes('"POST /api/inbound/whatsapp"'),
    "the inbound WhatsApp webhook must skip the request transaction so worker-owned processing cannot inherit request state",
  );
});

test("statement import runs outside the request transaction, in the MODEL class, with its own atomic ingest", () => {
  // The PDF branch is one bounded model call: NO_CONTEXT so it never pins a
  // pooled connection under the 30s cap, MODEL rate-limited like every other
  // token-spending route (the CSV branch shares the class — the
  // /clerk/batches precedent), and the route re-establishes write atomicity
  // itself by running ingestStatement inside its own bypass transaction.
  const set = setBlock(src("app.ts"), "NO_CONTEXT_ROUTES = new Set(");
  assert.ok(
    set.includes('"POST /api/statements"'),
    "POST /api/statements must skip the request transaction (bounded model call)",
  );
  const rlSet = setBlock(
    src("middleware/rate-limit.ts"),
    "MODEL_RATE_LIMITED_ROUTES",
  );
  assert.ok(
    rlSet.includes('"POST /api/statements"'),
    "POST /api/statements must be in the MODEL rate-limit class",
  );
  const block = routeBlock(src("routes/statements.ts"), "/statements");
  const wrapAt = block.indexOf(
    "runRequestContext({ bypass: true, firmId: null }",
  );
  const ingestAt = block.indexOf("ingestStatement(");
  assert.ok(
    wrapAt >= 0 && ingestAt > wrapAt,
    "with the route NO_CONTEXT, ingestStatement must run inside its own bypass transaction or statement+lines+outbox lose their all-or-nothing commit",
  );
});

test("case retry runs outside the request transaction via the pattern list", () => {
  // NO_CONTEXT_ROUTES is a literal-path Set; parameterized paths live in
  // NO_CONTEXT_ROUTE_PATTERNS. Retry re-runs a full extraction (up to a
  // 4-page vision call) and must not pin a pooled connection under the 30s
  // request-transaction cap.
  const appSrc = src("app.ts");
  const listStart = appSrc.indexOf("NO_CONTEXT_ROUTE_PATTERNS");
  assert.ok(listStart >= 0, "the parameterized NO_CONTEXT list exists");
  const listEnd = appSrc.indexOf("];", listStart);
  const list = appSrc.slice(listStart, listEnd);
  assert.ok(
    list.includes("clerk\\/cases\\/[^/]+\\/retry") ||
      list.includes("clerk/cases/[^/]+/retry"),
    "POST /api/clerk/cases/:id/retry must be exempted from the request transaction",
  );
  assert.ok(
    appSrc.includes("NO_CONTEXT_ROUTE_PATTERNS.some"),
    "tenantContext must actually consult the pattern list",
  );
});

// ---- Proposed-action execution (rounds 21-23) -------------------------------
// The execute route is BOTH batch shapes at once: up to ten provider calls
// (draft_chasers) and per-invoice audit appends (submit kinds). Inside one
// request transaction that is the 30s-cap violation plus the global
// audit-lock convoy — and the round-22 M3 split additionally requires the
// chaser MODEL call to run outside any transaction at all.
test("action execution runs outside the request transaction, model call outside any transaction", () => {
  assert.ok(
    setBlock(src("app.ts"), "NO_CONTEXT_ROUTES = new Set(").includes(
      '"POST /api/clerk/action-proposals/execute"',
    ),
    "the execute route must be exempted from the request transaction",
  );
  const moduleSrc = src("modules/clerk/actions.ts");
  assert.ok(
    moduleSrc.includes("runRequestContext({ bypass: false, firmId }"),
    "executeAction opens per-stage FIRM-BOUND contexts (never bypass — callers are firm principals)",
  );
  // The M3 split: the chaser's DB half commits inside ctx(); the phrasing
  // half runs transaction-free so no pooled connection spans model latency.
  assert.ok(
    /await ctx\(\(\) =>\s*stagePaymentChaser\(/.test(moduleSrc),
    "the chaser's staged (DB) half runs inside its own short context",
  );
  assert.ok(
    /const draft = await phrasePaymentChaser\(staged, gateway\)/.test(
      moduleSrc,
    ),
    "the chaser's phrasing half is called on the staged value",
  );
  assert.ok(
    !/ctx\(\(\) =>\s*phrasePaymentChaser/.test(moduleSrc) &&
      !/ctx\(\(\) =>\s*draftPaymentChaser/.test(moduleSrc),
    "no context wrapper may span the chaser model call (round-22 review M3)",
  );
  // Evasion guard (review NIT-1): the negative regexes above only match the
  // plain arrow form — pinning phrasePaymentChaser to exactly ONE call site
  // (the asserted transaction-free one) closes the async/braced variants.
  assert.equal(
    moduleSrc.match(/phrasePaymentChaser\(/g)?.length,
    1,
    "phrasePaymentChaser must be called exactly once, at the pinned transaction-free site",
  );
});

// ---- Standing approvals (round 28) ------------------------------------------
// The policy routes are ordinary in-transaction wiring, but their authz
// stack spans the route file AND the module: no module test drives the HTTP
// layer, so each gate gets a source pin (round-28 review M4).
test("standing-approval routes: read gate, grant walls, firm-scoped lifecycle", () => {
  const source = src("routes/clerk/actions.ts");

  // GET lists grants under the same read capability as proposals/decisions.
  const getBlock = routeBlock(source, "/clerk/action-policies");
  assert.ok(
    getBlock.includes('assertCan(req.principal, "invoice.read")'),
    "listing grants is a read surface",
  );

  // Round 29: the effectiveness read shares the surface's read gate and the
  // SEC-03 scope resolver — pure ledger SQL, nothing to execute.
  const effBlock = routeBlock(source, "/clerk/action-effectiveness");
  assert.ok(
    effBlock.includes('assertCan(req.principal, "invoice.read")'),
    "the effectiveness report is a read surface",
  );
  assert.ok(
    effBlock.includes("resolveClientAnalyticsScope"),
    "the report resolves its client through the SEC-03 scope resolver",
  );
  // The per-client evidence backtest (round 37) is the same read class —
  // one client's ledger history for its OWN grant dialogs — and must hold
  // the same resolver, never the firm-wide portfolio wall.
  const clientEvidenceBlock = routeBlock(
    source,
    "/clerk/client-automation-evidence",
  );
  assert.ok(
    clientEvidenceBlock.includes('assertCan(req.principal, "invoice.read")'),
    "the client evidence read gates on invoice.read — the effectiveness posture",
  );
  assert.ok(
    clientEvidenceBlock.includes("resolveClientAnalyticsScope"),
    "the client evidence read walls a client_user to its own party (SEC-03)",
  );

  // Granting IS a standing submission authorization: invoice.submit plus
  // the execute route's IDOR wall (assertPartyAccess), re-walked here.
  const grantStart = source.indexOf('router.post("/clerk/action-policies"');
  assert.ok(grantStart >= 0, "the grant route exists");
  const grantEnd = source.indexOf("router.", source.indexOf("=>", grantStart));
  const grantBlock = source.slice(
    grantStart,
    grantEnd === -1 ? undefined : grantEnd,
  );
  assert.ok(
    grantBlock.includes('assertCan(req.principal, "invoice.submit")'),
    "granting carries the submit capability — a standing approval authorizes submissions",
  );
  assert.ok(
    grantBlock.includes(
      "await assertPartyAccess(req.principal, clientPartyId)",
    ),
    "the grant re-walks the party IDOR wall exactly like execute",
  );

  // The lifecycle mutations resolve the firm from the PRINCIPAL (an
  // operator/auditor has no tenant to mutate under) and the module applies
  // the SEC-03 wall from the loaded row.
  for (const path of [
    "/clerk/action-policies/:id/pause",
    "/clerk/action-policies/:id/resume",
    "/clerk/action-policies/:id/revoke",
  ]) {
    const block = routeBlock(source, path);
    assert.ok(
      block.includes('assertCan(req.principal, "invoice.submit")'),
      `${path} carries the submit capability`,
    );
    assert.ok(
      block.includes("requireFirmScope(req.principal)"),
      `${path} resolves the firm from the principal, never the body`,
    );
  }
  assert.ok(
    src("modules/clerk/action-policies.ts").includes(
      "assertClientPartyScope(principal, policy.clientPartyId)",
    ),
    "the module walls a client_user to its own party's grants (SEC-03)",
  );
});

// ---- Recurring plan policies (round 33) -------------------------------------
// The Phase-3 routes mirror the standing-approval stack one level up; the
// same round-28 M4 rationale applies — no module test drives the HTTP
// layer, so each gate gets a source pin.
test("plan-policy routes: read gate, grant walls, firm-scoped lifecycle, rollup", () => {
  const source = src("routes/clerk/plan-policies.ts");

  const getBlock = routeBlock(source, "/clerk/plan-policies");
  assert.ok(
    getBlock.includes('assertCan(req.principal, "invoice.read")'),
    "listing plan grants is a read surface",
  );
  assert.ok(
    getBlock.includes("resolveClientAnalyticsScope"),
    "the list resolves its client through the SEC-03 scope resolver",
  );

  // Granting a recurring plan IS a standing submission authorization —
  // every template step is a submit kind — so it carries invoice.submit
  // plus the execute route's IDOR wall.
  const grantStart = source.indexOf('router.post("/clerk/plan-policies"');
  assert.ok(grantStart >= 0, "the grant route exists");
  const grantEnd = source.indexOf("router.", source.indexOf("=>", grantStart));
  const grantBlock = source.slice(
    grantStart,
    grantEnd === -1 ? undefined : grantEnd,
  );
  assert.ok(
    grantBlock.includes('assertCan(req.principal, "invoice.submit")'),
    "granting carries the submit capability",
  );
  assert.ok(
    grantBlock.includes(
      "await assertPartyAccess(req.principal, clientPartyId)",
    ),
    "the grant re-walks the party IDOR wall exactly like execute",
  );

  for (const path of [
    "/clerk/plan-policies/:id/pause",
    "/clerk/plan-policies/:id/resume",
    "/clerk/plan-policies/:id/revoke",
  ]) {
    const block = routeBlock(source, path);
    assert.ok(
      block.includes('assertCan(req.principal, "invoice.submit")'),
      `${path} carries the submit capability`,
    );
    assert.ok(
      block.includes("requireFirmScope(req.principal)"),
      `${path} resolves the firm from the principal, never the body`,
    );
  }

  // The rollup is a FIRM-INTERNAL aggregate (sibling pause reasons, fleet
  // failure counts): invoice.read would admit client_users (the digest
  // refusal class), so it carries the portfolio capability its consuming
  // surface (the firm-staff portfolio page) already requires.
  const rollupBlock = routeBlock(source, "/clerk/automation-rollup");
  assert.ok(
    rollupBlock.includes('assertCan(req.principal, "console.portfolio.read")'),
    "the firm rollup must gate on console.portfolio.read — invoice.read would leak the firm's cross-client automation posture to client_users",
  );
  assert.ok(
    rollupBlock.includes("requireFirmScope(req.principal)"),
    "the rollup resolves the firm from the principal — no client param to widen",
  );

  // The evidence backtest (round 36) is the same aggregate class — per-kind
  // agreement rates and act-now counts across every client — and must hold
  // the same wall.
  const evidenceBlock = routeBlock(source, "/clerk/automation-evidence");
  assert.ok(
    evidenceBlock.includes(
      'assertCan(req.principal, "console.portfolio.read")',
    ),
    "the evidence backtest must gate on console.portfolio.read — invoice.read would leak cross-client agreement history to client_users",
  );
  assert.ok(
    evidenceBlock.includes("requireFirmScope(req.principal)"),
    "the evidence backtest resolves the firm from the principal — no client param to widen",
  );

  assert.ok(
    src("modules/clerk/plan-policies.ts").includes(
      "assertClientPartyScope(principal, policy.clientPartyId)",
    ),
    "the module walls a client_user to its own party's grants (SEC-03)",
  );
});

test("bulk submit runs outside the request transaction with per-item caller-posture commits", () => {
  // The LAST batch surface converted (posture round): inside one request
  // transaction the first row's appendAudit held the GLOBAL audit advisory
  // lock for the whole 200-row batch — the convoy/deadlock class the
  // bulk-approve and execute-route blocks above document.
  assert.ok(
    setBlock(src("app.ts"), "NO_CONTEXT_ROUTES = new Set(").includes(
      '"POST /api/invoices/bulk-submit"',
    ),
    "bulk-submit must be exempted from the request transaction",
  );
  // The route's own party-access gate needs a context too — the raw pool
  // carries no GUCs, so an unwrapped engagement read would false-deny under
  // RLS for firm principals.
  const block = routeBlock(
    src("routes/invoices/lifecycle.ts"),
    "/invoices/bulk-submit",
  );
  // One spanning regex, not two includes: an unwrapped assertPartyAccess
  // beside a vestigial runRequestContext(noop) must not pass.
  assert.ok(
    /runRequestContext\([\s\S]*?assertPartyAccess\(req\.principal, body\.clientPartyId\)/.test(
      block,
    ),
    "the route's assertPartyAccess must run inside a caller-posture context",
  );
  // The module re-binds the CALLER's posture per stage: firm principals get
  // their firm GUC, cross-tenant staff (firmId null) get bypass — both arms
  // must exist, unlike bulk-approve's operator-only bypass.
  const moduleSrc = src("modules/invoice/bulk-submit.ts");
  assert.ok(
    moduleSrc.includes("runRequestContext({ bypass: false, firmId }") &&
      moduleSrc.includes("runRequestContext({ bypass: true, firmId: null }"),
    "bulkSubmit's ctx helper must carry the caller's posture (firm-bound OR bypass)",
  );
  // Validate and submit each commit in their OWN context — one shared
  // transaction would roll the validated state back when submit fails,
  // changing today's observable validated-stays-validated behavior.
  assert.ok(
    /await ctx\(\(\) => validateInvoice\(inv\.id, actorId\)\)/.test(moduleSrc),
    "per-item validate runs in its own short context",
  );
  assert.ok(
    /await ctx\(\(\) => submitInvoice\(inv\.id, actorId\)\)/.test(moduleSrc),
    "per-item submit runs in its own short context, separate from validate",
  );
  assert.equal(
    moduleSrc.match(/submitInvoice\(/g)?.length,
    1,
    "submitInvoice must be CALLED exactly once, at the pinned per-item ctx site",
  );
  assert.ok(
    /await ctx\(\(\) =>\s*appendAudit\(/.test(moduleSrc),
    "the batch summary audit commits in its own final context",
  );
});
