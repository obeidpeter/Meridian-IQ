import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  runRequestContext,
  firmsTable,
  usersTable,
  partiesTable,
  engagementsTable,
  consentRecordsTable,
  invoicesTable,
  featureFlagsTable,
  featureFlagOverridesTable,
  statementConnectionsTable,
  statementSyncRunsTable,
  bankStatementsTable,
  bankStatementLinesTable,
  matchProposalsTable,
  outboxTable,
} from "@workspace/db";
import statementConnectionsRouter from "../../routes/statement-connections.ts";
import type { Principal } from "../auth/rbac.ts";
import { DomainError } from "../errors.ts";
import { drain } from "../pipeline/pipeline.ts";
import { runFeedSync } from "./feed-engine.ts";
import {
  FEED_FORMAT_KEY,
  STATEMENT_FEED_CONNECTORS,
  demobankConnector,
  findFeedConnector,
  renderFeedCsv,
} from "./feed-contract.ts";
import { parseStatementText } from "./parsers.ts";
import {
  appFor,
  listen,
  closeAllServers,
  JSON_HEADERS,
} from "../../test-helpers/route-harness.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Bank-feed connector seam (Wave C): the contract round-trip (pull -> render ->
// ingestStatement -> reconcile outbox -> proposals), cursor idempotency, the
// failure postures (auth, missing CORE-03 consent), the route surface behind
// the opt-in `bank_feeds` flag with its staff-only capability gate (SEC-03),
// and behavioral RLS on the two new tables (migration 0020).

const SALT = makeRunSalt();

const firmId = randomUUID(); // bank_feeds enabled via per-firm override
const firmDark = randomUUID(); // no override: the flag stays dark here
const userId = randomUUID();
const clientParty = randomUUID(); // engaged + layer-1 consent
const noConsentParty = randomUUID(); // engaged, NO consent (CORE-03 probe)
const foreignParty = randomUUID(); // engaged by firmDark, not by firmId
const buyerParty = randomUUID();

const staff: Principal = {
  userId,
  role: "firm_staff",
  firmId,
  clientPartyId: null,
  buyerPartyId: null,
};
const staffDark: Principal = { ...staff, firmId: firmDark };
const clientUser: Principal = {
  userId,
  role: "client_user",
  firmId,
  clientPartyId: clientParty,
  buyerPartyId: null,
};

const goodConfig = { apiKey: `demo_${SALT}`, account: `acct-${SALT}` };

before(async () => {
  const db = getDb();
  await db
    .insert(usersTable)
    .values({ id: userId, email: `feed-${SALT}@test.local` })
    .onConflictDoNothing();
  await db.insert(firmsTable).values([
    { id: firmId, name: `Feed Firm ${SALT}` },
    { id: firmDark, name: `Feed Dark Firm ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    { id: clientParty, type: "client_business", legalName: `Feed Client ${SALT}` },
    { id: noConsentParty, type: "client_business", legalName: `Feed NoConsent ${SALT}` },
    { id: foreignParty, type: "client_business", legalName: `Feed Foreign ${SALT}` },
    { id: buyerParty, type: "buyer", legalName: `Feed Buyer ${SALT}` },
  ]);
  await db.insert(engagementsTable).values([
    { firmId, clientPartyId: clientParty, type: "retainer", title: `feed A ${SALT}` },
    { firmId, clientPartyId: noConsentParty, type: "retainer", title: `feed B ${SALT}` },
    { firmId: firmDark, clientPartyId: foreignParty, type: "retainer", title: `feed C ${SALT}` },
  ]);
  // Layer-1 consent for clientParty only — ingestStatement's CORE-03 gate.
  await db.insert(consentRecordsTable).values({
    partyId: clientParty,
    layer: 1,
    action: "grant",
    scope: "compliance_submission",
    basis: "contract",
    channel: "test",
  });
  // The flag stays globally dark (opt-in); firmId activates via override.
  await db
    .insert(featureFlagsTable)
    .values({ key: "bank_feeds", enabled: false, releaseTag: "R2" })
    .onConflictDoNothing({ target: featureFlagsTable.key });
  await db
    .update(featureFlagsTable)
    .set({ enabled: false })
    .where(eq(featureFlagsTable.key, "bank_feeds"));
  await db
    .insert(featureFlagOverridesTable)
    .values({ flagKey: "bank_feeds", firmId, enabled: true })
    .onConflictDoNothing();
});

after(async () => {
  await closeAllServers();
});

// ---------------------------------------------------------------------------
// Contract: registry, determinism, CSV round-trip through the REAL parser
// ---------------------------------------------------------------------------

test("feed connectors satisfy the contract and register in the map", async () => {
  assert.ok(STATEMENT_FEED_CONNECTORS.demobank);
  assert.equal(findFeedConnector("demobank"), demobankConnector);
  assert.equal(findFeedConnector("nope"), null);
  assert.equal((await demobankConnector.authenticate(goodConfig)).ok, true);
  const bad = await demobankConnector.authenticate({ apiKey: "wrong" });
  assert.equal(bad.ok, false);
  assert.ok(bad.error);
});

test("pull is deterministic, cursor-resumable, and renders loss-free through generic_csv", async () => {
  const first = await demobankConnector.pullLines(goodConfig, null, 200);
  const again = await demobankConnector.pullLines(goodConfig, null, 200);
  assert.deepEqual(first.lines, again.lines, "same cursor must yield same lines");
  assert.ok(first.lines.length > 0);
  assert.equal(first.nextCursor, String(first.lines.length));
  // A drained book pulls empty with a null cursor (= keep the stored one).
  const drained = await demobankConnector.pullLines(
    goodConfig,
    first.nextCursor,
    200,
  );
  assert.equal(drained.lines.length, 0);
  assert.equal(drained.nextCursor, null);

  // The rendered CSV must round-trip through the ordinary parser exactly —
  // this is the invariant that lets the engine trust ingestStatement.
  const parsed = parseStatementText(renderFeedCsv(first.lines), FEED_FORMAT_KEY);
  assert.ok(parsed, "generic_csv must parse the rendered feed");
  assert.equal(parsed.lineCount, first.lines.length);
  assert.equal(parsed.parsedCount, first.lines.length, "every line parses");
  for (let i = 0; i < first.lines.length; i++) {
    assert.equal(parsed.lines[i].valueDate, first.lines[i].valueDate);
    assert.equal(parsed.lines[i].amount, first.lines[i].amount);
    assert.equal(parsed.lines[i].direction, first.lines[i].direction);
    assert.equal(parsed.lines[i].narration, first.lines[i].narration);
  }

  // RFC-4180 hazards in the narration survive the round-trip.
  const tricky = renderFeedCsv([
    {
      valueDate: "2027-01-05",
      amount: "100.00",
      direction: "credit",
      narration: `Transfer, "quoted" memo ${SALT}`,
      reference: null,
    },
  ]);
  const trickyParsed = parseStatementText(tricky, FEED_FORMAT_KEY);
  assert.equal(trickyParsed?.parsedCount, 1);
  assert.equal(
    trickyParsed?.lines[0].narration,
    `Transfer, "quoted" memo ${SALT}`,
  );
});

// ---------------------------------------------------------------------------
// Routes: flag gate, capability gate (SEC-03), create validation
// ---------------------------------------------------------------------------

const router = statementConnectionsRouter as express.Router;

test("bank_feeds dark: every surface 404s", async () => {
  const base = await listen(appFor(staffDark, router));
  assert.equal((await fetch(`${base}/statement-connectors`)).status, 404);
  assert.equal((await fetch(`${base}/statement-connections`)).status, 404);
  const post = await fetch(`${base}/statement-connections`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      connectorKey: "demobank",
      clientPartyId: foreignParty,
      config: goodConfig,
    }),
  });
  assert.equal(post.status, 404);
});

test("a client_user cannot manage connections (statement.write is staff-only, SEC-03)", async () => {
  const base = await listen(appFor(clientUser, router));
  assert.equal((await fetch(`${base}/statement-connectors`)).status, 403);
  assert.equal((await fetch(`${base}/statement-connections`)).status, 403);
  const post = await fetch(`${base}/statement-connections`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      connectorKey: "demobank",
      clientPartyId: clientParty,
      config: goodConfig,
    }),
  });
  assert.equal(post.status, 403);
});

test("create validates connector key, config, and party tenancy", async () => {
  const base = await listen(appFor(staff, router));
  const post = (body: Record<string, unknown>) =>
    fetch(`${base}/statement-connections`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });

  const unknown = await post({
    connectorKey: "not-a-connector",
    clientPartyId: clientParty,
    config: goodConfig,
  });
  assert.equal(unknown.status, 422, "unknown connector key is rejected");

  const badAuth = await post({
    connectorKey: "demobank",
    clientPartyId: clientParty,
    config: { apiKey: "wrong" },
  });
  assert.equal(badAuth.status, 422, "a config the connector rejects is rejected");

  const crossTenant = await post({
    connectorKey: "demobank",
    clientPartyId: foreignParty,
    config: goodConfig,
  });
  assert.equal(crossTenant.status, 403, "another firm's client party is rejected");

  const ok = await post({
    connectorKey: "demobank",
    clientPartyId: clientParty,
    config: goodConfig,
  });
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as Record<string, unknown>;
  assert.equal(body.connectorKey, "demobank");
  assert.equal(body.clientPartyId, clientParty);
  assert.equal(body.clientName, `Feed Client ${SALT}`);
  assert.equal(body.status, "active");
  // firmId is forced from the principal, never from the body.
  const [row] = await getDb()
    .select()
    .from(statementConnectionsTable)
    .where(eq(statementConnectionsTable.id, String(body.id)));
  assert.equal(row.firmId, firmId);
  // The registry list works for staff.
  const connectors = await fetch(`${base}/statement-connectors`);
  assert.equal(connectors.status, 200);
  const list = (await connectors.json()) as { key: string }[];
  assert.ok(list.some((c) => c.key === "demobank"));
});

// ---------------------------------------------------------------------------
// The round-trip: sync 202 -> outbox -> ingestStatement -> reconcile -> proposals
// ---------------------------------------------------------------------------

// Drain the outbox until the given event ids are all terminal (done/dead).
async function drainUntilSettled(eventIds: string[]): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const pending = await Promise.all(
      eventIds.map(async (id) => {
        const [row] = await getDb()
          .select({ status: outboxTable.status })
          .from(outboxTable)
          .where(eq(outboxTable.id, id));
        return row && row.status !== "done" && row.status !== "dead";
      }),
    );
    if (!pending.some(Boolean)) return;
    await drain(50);
  }
  assert.fail("outbox events did not settle within the drain budget");
}

test("feed sync round-trip: pulled lines land via ingestStatement and reconcile into proposals", async () => {
  // Know the book up front (the connector is deterministic) so a stamped
  // invoice can be planted to match the first credit line exactly.
  const book = await demobankConnector.pullLines(goodConfig, null, 200);
  const firstCredit = book.lines.find((l) => l.direction === "credit");
  assert.ok(firstCredit, "the simulated book carries credit lines");
  const invoiceId = randomUUID();
  const issueDate = new Date(
    Date.parse(firstCredit.valueDate) - 5 * 24 * 60 * 60 * 1000,
  )
    .toISOString()
    .slice(0, 10);
  await getDb().insert(invoicesTable).values({
    id: invoiceId,
    firmId,
    supplierPartyId: clientParty,
    buyerPartyId: buyerParty,
    invoiceNumber: `FEED-${SALT}-1`,
    issueDate,
    status: "stamped",
    subtotal: firstCredit.amount,
    grandTotal: firstCredit.amount,
  });

  const base = await listen(appFor(staff, router));
  const create = await fetch(`${base}/statement-connections`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      connectorKey: "demobank",
      clientPartyId: clientParty,
      config: goodConfig,
    }),
  });
  assert.equal(create.status, 200);
  const connectionId = String(
    ((await create.json()) as Record<string, unknown>).id,
  );

  // 202: the run marker and the queued job are created together.
  const sync = await fetch(
    `${base}/statement-connections/${connectionId}/sync`,
    { method: "POST", headers: JSON_HEADERS },
  );
  assert.equal(sync.status, 202);
  const run = (await sync.json()) as Record<string, unknown>;
  assert.equal(run.status, "running");
  assert.equal(run.connectionId, connectionId);
  const [job] = await getDb()
    .select()
    .from(outboxTable)
    .where(
      and(
        eq(outboxTable.type, "statement.feed_sync"),
        eq(outboxTable.aggregateId, connectionId),
      ),
    );
  assert.ok(job, "sync enqueues the outbox job in the same request");
  assert.equal(job.status, "pending");
  assert.equal(
    (job.payload as { requestRunId?: string }).requestRunId,
    run.id,
    "the queued job adopts the pre-created run",
  );

  // Worker pass: the feed sync commits a statement (which itself enqueues
  // statement.reconcile); keep draining until both settle.
  await drainUntilSettled([job.id]);
  const [statement] = await getDb()
    .select()
    .from(bankStatementsTable)
    .where(
      and(
        eq(bankStatementsTable.firmId, firmId),
        eq(bankStatementsTable.clientPartyId, clientParty),
      ),
    );
  assert.ok(statement, "the pull landed as an ordinary bank statement");
  assert.equal(statement.formatKey, FEED_FORMAT_KEY);
  assert.equal(statement.lineCount, book.lines.length);
  assert.equal(statement.parsedCount, book.lines.length);
  assert.equal(
    statement.uploadedByUserId,
    `feed:${connectionId}`,
    "the connection is the actor of record",
  );
  const [reconcileJob] = await getDb()
    .select()
    .from(outboxTable)
    .where(
      and(
        eq(outboxTable.type, "statement.reconcile"),
        eq(outboxTable.aggregateId, statement.id),
      ),
    );
  assert.ok(reconcileJob, "ingestStatement enqueued the reconcile job");
  await drainUntilSettled([reconcileJob.id]);

  const [settledStatement] = await getDb()
    .select({ status: bankStatementsTable.status })
    .from(bankStatementsTable)
    .where(eq(bankStatementsTable.id, statement.id));
  assert.equal(settledStatement.status, "reconciled");
  const lines = await getDb()
    .select()
    .from(bankStatementLinesTable)
    .where(eq(bankStatementLinesTable.statementId, statement.id));
  assert.equal(lines.length, book.lines.length);
  assert.ok(lines.every((l) => l.parseStatus === "parsed"));

  // The planted invoice drew at least one proposal from the matcher.
  const proposals = await getDb()
    .select()
    .from(matchProposalsTable)
    .where(eq(matchProposalsTable.invoiceId, invoiceId));
  assert.ok(
    proposals.length >= 1,
    "the exact-amount credit line proposed against the stamped invoice",
  );

  // Run row: succeeded with its tallies; connection advanced its cursor.
  const [doneRun] = await getDb()
    .select()
    .from(statementSyncRunsTable)
    .where(eq(statementSyncRunsTable.id, String(run.id)));
  assert.equal(doneRun.status, "succeeded");
  assert.equal(doneRun.linesPulled, book.lines.length);
  assert.equal(doneRun.statementId, statement.id);
  assert.ok(doneRun.finishedAt);
  const [afterFirst] = await getDb()
    .select()
    .from(statementConnectionsTable)
    .where(eq(statementConnectionsTable.id, connectionId));
  assert.equal(afterFirst.cursor, book.nextCursor);
  assert.ok(afterFirst.lastSyncAt);

  // Idempotent re-sync: the book is drained, so the second run succeeds with
  // an empty pull — no new statement, cursor unchanged.
  const resync = await fetch(
    `${base}/statement-connections/${connectionId}/sync`,
    { method: "POST", headers: JSON_HEADERS },
  );
  assert.equal(resync.status, 202);
  const secondRun = (await resync.json()) as Record<string, unknown>;
  const [job2] = await getDb()
    .select()
    .from(outboxTable)
    .where(
      and(
        eq(outboxTable.type, "statement.feed_sync"),
        eq(outboxTable.aggregateId, connectionId),
        eq(outboxTable.status, "pending"),
      ),
    );
  assert.ok(job2);
  await drainUntilSettled([job2.id]);
  const [emptyRun] = await getDb()
    .select()
    .from(statementSyncRunsTable)
    .where(eq(statementSyncRunsTable.id, String(secondRun.id)));
  assert.equal(emptyRun.status, "succeeded");
  assert.equal(emptyRun.linesPulled, 0);
  assert.equal(emptyRun.statementId, null);
  const statements = await getDb()
    .select({ id: bankStatementsTable.id })
    .from(bankStatementsTable)
    .where(
      and(
        eq(bankStatementsTable.firmId, firmId),
        eq(bankStatementsTable.clientPartyId, clientParty),
      ),
    );
  assert.equal(statements.length, 1, "an empty pull commits nothing");
  const [afterSecond] = await getDb()
    .select({ cursor: statementConnectionsTable.cursor })
    .from(statementConnectionsTable)
    .where(eq(statementConnectionsTable.id, connectionId));
  assert.equal(afterSecond.cursor, book.nextCursor, "cursor unchanged");

  // Runs list: newest first.
  const runsRes = await fetch(
    `${base}/statement-connections/${connectionId}/runs`,
  );
  assert.equal(runsRes.status, 200);
  const runs = (await runsRes.json()) as { id: string }[];
  assert.equal(runs.length, 2);
  assert.equal(runs[0].id, secondRun.id);
  assert.equal(runs[1].id, run.id);

  // A disabled connection refuses to sync (409).
  await getDb()
    .update(statementConnectionsTable)
    .set({ status: "disabled" })
    .where(eq(statementConnectionsTable.id, connectionId));
  const disabled = await fetch(
    `${base}/statement-connections/${connectionId}/sync`,
    { method: "POST", headers: JSON_HEADERS },
  );
  assert.equal(disabled.status, 409);
});

// ---------------------------------------------------------------------------
// Mutual exclusion: two syncs of one connection cannot both ingest a page
// ---------------------------------------------------------------------------

test("concurrent syncs of one connection are mutually exclusive (advisory xact lock)", async () => {
  const [connection] = await getDb()
    .insert(statementConnectionsTable)
    .values({
      firmId,
      clientPartyId: clientParty,
      connectorKey: "demobank",
      config: { apiKey: `demo_${SALT}`, account: `mutex-${SALT}` },
    })
    .returning();
  const statementCount = async () =>
    (
      await getDb()
        .select({ id: bankStatementsTable.id })
        .from(bankStatementsTable)
        .where(
          and(
            eq(bankStatementsTable.firmId, firmId),
            eq(bankStatementsTable.clientPartyId, clientParty),
          ),
        )
    ).length;
  const countBefore = await statementCount();

  // Hold the connection's lock in one open bypass transaction — standing in
  // deterministically for a concurrent sync mid-flight (the outbox worker
  // runs each sync inside one bypass transaction, so this is exactly the
  // state a racing instance observes).
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let acquired!: () => void;
  const lockTaken = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const holder = runInBypassContext(async () => {
    await getDb().execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${connection.id}::text))`,
    );
    acquired();
    await held;
  });
  await lockTaken;

  try {
    // The second sync fails FAST with a retryable error. Mirror the outbox
    // handler's shape exactly: the worker runs each event inside one bypass
    // transaction and handleFeedSync CATCHES the throw (returning a
    // retry/dead outcome), so the transaction commits — including the run
    // row's failure marker. A DomainError would dead-letter; contention must
    // be a plain Error so it retries with backoff instead.
    const outcome = await runInBypassContext(async () => {
      try {
        await runFeedSync(connection.id);
        return { kind: "done" as const, message: "" };
      } catch (err) {
        return {
          kind: err instanceof DomainError ? ("dead" as const) : ("retry" as const),
          message: String((err as Error).message),
        };
      }
    });
    assert.equal(
      outcome.kind,
      "retry",
      "lock contention must be retryable, never a dead-letter DomainError",
    );
    assert.match(outcome.message, /already in progress/);
  } finally {
    release();
  }
  await holder;
  assert.equal(await statementCount(), countBefore, "the blocked sync ingested nothing");
  const [blockedRun] = await getDb()
    .select()
    .from(statementSyncRunsTable)
    .where(eq(statementSyncRunsTable.connectionId, connection.id))
    .orderBy(desc(statementSyncRunsTable.startedAt))
    .limit(1);
  assert.equal(blockedRun.status, "failed");
  assert.match(blockedRun.error ?? "", /already in progress/);

  // Lock free again: the retry proceeds and the page lands exactly once.
  const result = await runInBypassContext(() => runFeedSync(connection.id));
  assert.ok(result.linesPulled > 0);
  assert.ok(result.statementId);
  assert.equal(await statementCount(), countBefore + 1, "one page ingested once");
});

// ---------------------------------------------------------------------------
// Failure postures
// ---------------------------------------------------------------------------

test("authentication failure marks the run failed and syncs nothing", async () => {
  const [connection] = await getDb()
    .insert(statementConnectionsTable)
    .values({
      firmId,
      clientPartyId: clientParty,
      connectorKey: "demobank",
      config: { apiKey: "expired" }, // fails authenticate at sync time
    })
    .returning();
  await assert.rejects(
    runFeedSync(connection.id),
    (err: unknown) => /apiKey/.test(String((err as Error).message)),
  );
  const [run] = await getDb()
    .select()
    .from(statementSyncRunsTable)
    .where(eq(statementSyncRunsTable.connectionId, connection.id))
    .orderBy(desc(statementSyncRunsTable.startedAt))
    .limit(1);
  assert.equal(run.status, "failed");
  assert.match(run.error ?? "", /apiKey/);
  assert.ok(run.finishedAt);
  const [after1] = await getDb()
    .select()
    .from(statementConnectionsTable)
    .where(eq(statementConnectionsTable.id, connection.id));
  assert.equal(after1.lastSyncAt, null, "a failed sync never advances the clock");
  assert.equal(after1.cursor, null, "a failed sync never advances the cursor");
});

test("missing layer-1 consent fails the run cleanly (gate lives inside ingestStatement)", async () => {
  const [connection] = await getDb()
    .insert(statementConnectionsTable)
    .values({
      firmId,
      clientPartyId: noConsentParty,
      connectorKey: "demobank",
      config: goodConfig,
    })
    .returning();
  await assert.rejects(
    runFeedSync(connection.id),
    (err: unknown) => /consent/i.test(String((err as Error).message)),
  );
  const [run] = await getDb()
    .select()
    .from(statementSyncRunsTable)
    .where(eq(statementSyncRunsTable.connectionId, connection.id))
    .orderBy(desc(statementSyncRunsTable.startedAt))
    .limit(1);
  assert.equal(run.status, "failed");
  assert.match(run.error ?? "", /consent/i);
  const statements = await getDb()
    .select({ id: bankStatementsTable.id })
    .from(bankStatementsTable)
    .where(eq(bankStatementsTable.clientPartyId, noConsentParty));
  assert.equal(statements.length, 0, "nothing lands without CORE-03 consent");

  // Queued through the outbox, the same failure dead-letters the event —
  // terminal until the connection (or consent) is fixed, never a hot retry.
  const [queued] = await getDb()
    .insert(outboxTable)
    .values({
      aggregateType: "statement_connection",
      aggregateId: connection.id,
      type: "statement.feed_sync",
      payload: { connectionId: connection.id },
    })
    .returning();
  await drainUntilSettled([queued.id]);
  const [settled] = await getDb()
    .select({ status: outboxTable.status, lastError: outboxTable.lastError })
    .from(outboxTable)
    .where(eq(outboxTable.id, queued.id));
  assert.equal(settled.status, "dead");
  assert.match(settled.lastError ?? "", /consent/i);
});

// ---------------------------------------------------------------------------
// Behavioral RLS (migration 0020) — same posture as rls-isolation.test.ts
// ---------------------------------------------------------------------------

function isRlsViolation(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as { code?: string; message?: string; cause?: unknown };
    if (e.code === "42501") return true;
    if (e.message?.includes("row-level security")) return true;
    cur = e.cause;
  }
  return false;
}

test("RLS: statement_connections and statement_sync_runs are firm-walled", async () => {
  const asFirm = <T>(id: string, fn: () => Promise<T>) =>
    runRequestContext({ bypass: false, firmId: id }, fn);

  await asFirm(firmDark, async () => {
    const connections = await getDb()
      .select()
      .from(statementConnectionsTable)
      .where(eq(statementConnectionsTable.firmId, firmId));
    assert.equal(connections.length, 0, "another firm's connections invisible");
    const runs = await getDb()
      .select()
      .from(statementSyncRunsTable)
      .where(eq(statementSyncRunsTable.firmId, firmId));
    assert.equal(runs.length, 0, "another firm's runs invisible");
  });
  // The owning firm sees its own rows through the same policy.
  await asFirm(firmId, async () => {
    const connections = await getDb()
      .select()
      .from(statementConnectionsTable)
      .where(eq(statementConnectionsTable.firmId, firmId));
    assert.ok(connections.length > 0, "own connections visible");
  });
  // WITH CHECK: a firm context cannot plant rows in another firm.
  await assert.rejects(
    asFirm(firmDark, () =>
      getDb().insert(statementConnectionsTable).values({
        firmId,
        clientPartyId: clientParty,
        connectorKey: "demobank",
        config: goodConfig,
      }),
    ),
    (err: unknown) => {
      assert.ok(isRlsViolation(err), `expected RLS violation, got ${String(err)}`);
      return true;
    },
  );
});
